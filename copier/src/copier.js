/**
 * The copier: when a followed agent locks a call, place the same trade on
 * every paying follower's own exchange account, within seconds, with the
 * call's take-profit and stop-loss attached.
 *
 * It trades only on what was actually committed: the preimage the agent's SDK
 * sends (sealed to the copier) must hash to the call's on-chain lock before a
 * single order goes out. Followers' money never moves: the copier is only
 * the delegate of each follower's dedicated copy subaccount, which can place
 * and cancel orders but never withdraw.
 *
 * The exchange is an adapter (copier/src/velocity.js for Velocity, formerly
 * Drift), so these rules are testable on their own:
 *   market(coin)                     -> { marketIndex, minSize, stepSize, price } | null
 *   account(follow)                  -> { netValue, openCopied, dayPnl }
 *   sign(follow, market, orders, o)  -> { signature, raw, lastValidBlockHeight }
 *   send(raw)                        -> void (re-sending the same bytes is safe)
 *   confirm(signature, lastValidBlockHeight) -> "confirmed" | "failed" | "expired"
 *   status(signature, lastValidBlockHeight)  -> "confirmed" | "failed" | "pending" | "expired"
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

import { ARENA_PROGRAM_ID, bookAddress, callAddress, callHash, decodeAccount } from "../../solana/arena.js";
import { isCopyable } from "../../solana/follow.js";
import { jobKey } from "./journal.js";
import { sizeOrder, ordersFor } from "./orders.js";

/** A call is copied only this soon after its entry; later, the move it called may be gone. */
export const MAX_LATE_SEC = 120;
/** An order that hasn't landed by this many seconds after signing never fills (the exchange's maxTs). */
export const ORDER_TTL_SEC = 30;

/** 1..255, stable per (call, follow): the exchange's userOrderId, so a copied order can be traced. */
export function userOrderId(book, callId, follow) {
  const h = createHash("sha256").update(`${book}:${callId}:${follow}`).digest();
  return (h[0] % 255) + 1;
}

export function createCopier({
  connection, exchange, journal, followsForAgent, programId = ARENA_PROGRAM_ID,
  now = () => Date.now(), log = () => {}, maxLateSec = MAX_LATE_SEC,
}) {
  /** The call's lock, checked against the preimage. Throws with a reason when they don't match. */
  async function verify(p) {
    if (p.program && p.program !== programId.toBase58()) throw refusal("wrong-program");
    const owner = new PublicKey(p.owner);
    const book = bookAddress(owner, programId);
    if (p.book && p.book !== book.toBase58()) throw refusal("wrong-book");
    const info = await connection.getAccountInfo(callAddress(book, p.callId, programId), "confirmed");
    if (!info || !info.owner.equals(programId)) throw refusal("no-such-lock");
    const call = decodeAccount(info.data);
    if (call?.type !== "Call" || !call.book.equals(book) || call.callId !== Number(p.callId)) throw refusal("no-such-lock");
    let hash;
    try {
      hash = callHash({ programId, book, callId: p.callId, horizon: call.horizon, coin: p.coin, side: p.side, salt: p.salt });
    } catch {
      throw refusal("malformed-preimage");
    }
    if (!hash.equals(call.callHash)) throw refusal("preimage-mismatch");
    if (now() / 1000 > call.entryAt + maxLateSec) throw refusal("too-late");
    return { owner, book, call };
  }

  /**
   * Copy one call to every eligible follower. Returns { call, results } where
   * each result is { follow, status, reason?, signature?, latencyMs? }.
   */
  async function handlePreimage(preimage, { receivedAt = now() } = {}) {
    const { owner, book, call } = await verify(preimage);
    const market = await exchange.market(preimage.coin);
    if (!market) {
      log(`call ${book.toBase58()}#${call.callId}: ${preimage.coin} isn't listed on the exchange: not copied`);
      return { call: { book: book.toBase58(), callId: call.callId }, results: [], skipped: "market-not-listed" };
    }
    const nowSec = Math.floor(now() / 1000);
    const follows = (await followsForAgent(owner.toBase58())).filter((f) => isCopyable(f, nowSec));
    const results = await Promise.all(follows.map((f) => copyOne({ f, book, call, preimage, market, receivedAt })));
    return { call: { book: book.toBase58(), callId: call.callId }, results };
  }

  async function copyOne({ f, book, call, preimage, market, receivedAt }) {
    const follow = f.address.toString();
    const key = jobKey({ book: book.toBase58(), callId: call.callId, follow });
    if (!journal.claim(key, { book: book.toBase58(), callId: call.callId, follow, follower: f.follower.toString(), coin: preimage.coin })) {
      return { follow, status: "duplicate" };
    }
    try {
      const account = await exchange.account(f);
      const size = sizeOrder({ settings: f.settings, account, market });
      if (!size.ok) {
        journal.update(key, { status: "skipped", reason: size.reason });
        return { follow, status: "skipped", reason: size.reason };
      }
      const orders = ordersFor({ side: preimage.side, base: size.base, salt: preimage.salt });
      const maxTs = Math.floor(now() / 1000) + ORDER_TTL_SEC;
      const signed = await exchange.sign(f, market, orders, { userOrderId: userOrderId(book.toBase58(), call.callId, follow), maxTs });
      // On disk before it leaves: a restart re-sends these bytes or nothing.
      journal.update(key, { status: "signed", signature: signed.signature, raw: signed.raw, lastValidBlockHeight: signed.lastValidBlockHeight, orders: orders.map((o) => o.kind), base: String(size.base) });
      await exchange.send(signed.raw);
      journal.update(key, { status: "sent" });
      const outcome = await exchange.confirm(signed.signature, signed.lastValidBlockHeight);
      const doneAt = now();
      const latency = { fromLockMs: doneAt - call.lockedAt * 1000, fromReceiptMs: doneAt - receivedAt };
      journal.update(key, { status: outcome, ...latency });
      log(`copied ${preimage.coin} ${preimage.side > 0 ? "long" : "short"} to ${follow}: ${outcome} in ${latency.fromLockMs} ms from the lock (${signed.signature})`);
      return { follow, status: outcome, signature: signed.signature, latencyMs: latency.fromLockMs, orders: orders.map((o) => o.kind) };
    } catch (err) {
      const row = journal.get(key);
      // Not yet signed: nothing can be on chain. Signed: recover() settles it, never a second order.
      if (row.status === "claimed") journal.update(key, { status: "failed", reason: String(err?.message ?? err).slice(0, 200) });
      return { follow, status: row.status === "claimed" ? "failed" : row.status, reason: String(err?.message ?? err).slice(0, 200) };
    }
  }

  /**
   * After a restart: settle every row left mid-way. A row never signed is
   * abandoned (nothing went out, and the call is stale by now). A signed row
   * is confirmed or failed if it landed, re-sent byte for byte while its
   * blockhash is valid, and expired once it can no longer land.
   */
  async function recover() {
    const out = [];
    for (const row of journal.unsettled()) {
      if (row.status === "claimed") {
        journal.update(row.key, { status: "abandoned" });
        out.push({ key: row.key, status: "abandoned" });
        continue;
      }
      const s = await exchange.status(row.signature, row.lastValidBlockHeight);
      if (s === "pending") {
        await exchange.send(row.raw);
        journal.update(row.key, { status: "sent" });
        out.push({ key: row.key, status: "resent" });
      } else {
        journal.update(row.key, { status: s });
        out.push({ key: row.key, status: s });
      }
    }
    return out;
  }

  return { verify, handlePreimage, recover };
}

function refusal(reason) {
  const e = new Error(`refused: ${reason}`);
  e.reason = reason;
  e.status = reason === "too-late" ? 410 : 422;
  return e;
}
