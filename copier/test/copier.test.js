// The copier's promises, with a mock exchange and a mock chain: it trades only
// on a preimage that matches the lock, only for active and paid follows,
// within each follower's limits, with TP/SL attached, and never twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";

import { ARENA_PROGRAM_ID, bookAddress, callAddress, callHash, accountDiscriminator } from "../../solana/arena.js";
import { withExits } from "../../app/verify/callbook-exits.js";
import { createCopier, MAX_LATE_SEC, userOrderId } from "../src/copier.js";
import { openJournal } from "../src/journal.js";
import { sizeOrder, ordersFor, priceUnits, SIZE_FIXED, SIZE_PERCENT } from "../src/orders.js";

const USD = 1_000_000n;
const T = 1_800_000_000; // lock time, seconds

/** A Call account's bytes, laid out as programs/arena writes it. */
function callAccount({ book, callId, hash, lockedAt = T, entryAt = T + 60, horizon = 3600 }) {
  const b = Buffer.alloc(8 + 128 - 8);
  let o = 0;
  accountDiscriminator("Call").copy(b, o); o += 8;
  b.writeUInt8(255, o); o += 1;
  book.toBuffer().copy(b, o); o += 32;
  b.writeBigUInt64LE(BigInt(callId), o); o += 8;
  hash.copy(b, o); o += 32;
  b.writeBigInt64LE(BigInt(lockedAt), o); o += 8;
  b.writeBigInt64LE(BigInt(entryAt), o); o += 8;
  b.writeUInt32LE(horizon, o); o += 4;
  o += 3 + 16; // revealed, side, coin_len, coin
  b.writeBigInt64LE(0n, o);
  return b;
}

/** An agent with one locked call on a mock chain, and the preimage its SDK would send. */
function lockedCall({ coin = "SOL", side = 1, horizon = 3600, salt = `0x${randomBytes(32).toString("hex")}` } = {}) {
  const agent = Keypair.generate().publicKey;
  const book = bookAddress(agent);
  const hash = callHash({ book, callId: 0, horizon, coin, side, salt });
  const accounts = new Map([[callAddress(book, 0).toBase58(), { owner: ARENA_PROGRAM_ID, data: callAccount({ book, callId: 0, hash, horizon }) }]]);
  const connection = { getAccountInfo: async (k) => accounts.get(k.toBase58()) ?? null };
  const preimage = { program: ARENA_PROGRAM_ID.toBase58(), owner: agent.toBase58(), book: book.toBase58(), callId: 0, coin, side, horizon, salt };
  return { agent, book, connection, preimage };
}

const settings = (o = {}) => ({ sizeMode: SIZE_FIXED, sizeValue: 100n * USD, maxTrade: 250n * USD, maxOpen: 3, dailyLossCap: 50n * USD, subAccountId: 1, ...o });

function follow(o = {}) {
  return { address: Keypair.generate().publicKey, follower: Keypair.generate().publicKey, active: true, paidUntil: T + 30 * 86_400, settings: settings(o.settings), ...o, ...(o.settings ? { settings: settings(o.settings) } : {}) };
}

/** A mock exchange that records what it was asked to do. */
function mockExchange({ accounts = new Map(), market = { marketIndex: 0, minSize: 10_000_000n, stepSize: 10_000_000n, price: 150n * USD }, sendFails = 0, confirm = "confirmed", status = "pending" } = {}) {
  const ex = {
    signed: [], sent: [], failSends: sendFails,
    market: async (coin) => (["SOL", "BTC", "ETH"].includes(coin) ? market : null),
    account: async (f) => accounts.get(f.address.toString()) ?? { netValue: 1_000n * USD, openCopied: 0, dayPnl: 0n },
    sign: async (f, m, orders, o) => {
      const signature = `sig-${ex.signed.length}`;
      ex.signed.push({ follow: f.address.toString(), orders, ...o });
      return { signature, raw: Buffer.from(signature).toString("base64"), lastValidBlockHeight: 100 };
    },
    send: async (raw) => {
      if (ex.failSends-- > 0) throw new Error("rpc hiccup");
      ex.sent.push(raw);
    },
    confirm: async () => confirm,
    status: async () => status,
  };
  return ex;
}

function copier({ connection, exchange, follows, journal = openJournal(), at = (T + 2) * 1000 }) {
  return createCopier({ connection, exchange, journal, followsForAgent: async () => follows, now: () => at });
}

// ------------------------------------------------------------------ verification

test("a preimage that matches the lock is copied to every paid follower, with latency logged", async () => {
  const { connection, preimage } = lockedCall();
  const ex = mockExchange();
  const fs = [follow(), follow()];
  const out = await copier({ connection, exchange: ex, follows: fs }).handlePreimage(preimage);
  assert.equal(out.results.length, 2);
  for (const r of out.results) {
    assert.equal(r.status, "confirmed");
    assert.equal(r.latencyMs, 2_000); // confirmed 2 s after the on-chain lock time
  }
  assert.equal(ex.signed.length, 2);
  assert.equal(ex.sent.length, 2);
});

test("a preimage that doesn't match the lock is refused before any order", async () => {
  const { connection, preimage } = lockedCall({ coin: "SOL", side: 1 });
  const ex = mockExchange();
  const c = copier({ connection, exchange: ex, follows: [follow()] });
  for (const bad of [{ coin: "BTC" }, { side: -1 }, { salt: `0x${"00".repeat(32)}` }, { callId: 1 }, { owner: Keypair.generate().publicKey.toBase58(), book: undefined }]) {
    await assert.rejects(c.handlePreimage({ ...preimage, ...bad }), (e) => ["preimage-mismatch", "no-such-lock"].includes(e.reason));
  }
  await assert.rejects(c.handlePreimage({ ...preimage, coin: "" }), (e) => e.reason === "malformed-preimage");
  await assert.rejects(c.handlePreimage({ ...preimage, program: Keypair.generate().publicKey.toBase58() }), (e) => e.reason === "wrong-program");
  assert.equal(ex.signed.length, 0);
});

test("a call is not copied long after its entry", async () => {
  const { connection, preimage } = lockedCall();
  const ex = mockExchange();
  const late = copier({ connection, exchange: ex, follows: [follow()], at: (T + 60 + MAX_LATE_SEC + 1) * 1000 });
  await assert.rejects(late.handlePreimage(preimage), (e) => e.reason === "too-late");
  assert.equal(ex.signed.length, 0);
});

test("only active, paid follows are copied", async () => {
  const { connection, preimage } = lockedCall();
  const ex = mockExchange();
  const paid = follow();
  const lapsed = follow({ paidUntil: T });
  const stopped = follow({ active: false });
  const out = await copier({ connection, exchange: ex, follows: [paid, lapsed, stopped] }).handlePreimage(preimage);
  assert.deepEqual(out.results.map((r) => r.follow), [paid.address.toString()]);
  assert.deepEqual(ex.signed.map((s) => s.follow), [paid.address.toString()]);
});

test("a coin the exchange doesn't list is skipped, not guessed", async () => {
  const { connection, preimage } = lockedCall({ coin: "WIF" });
  const ex = mockExchange();
  const out = await copier({ connection, exchange: ex, follows: [follow()] }).handlePreimage(preimage);
  assert.equal(out.skipped, "market-not-listed");
  assert.equal(ex.signed.length, 0);
});

// ------------------------------------------------------------------ limits

test("follower limits hold: open positions, the daily loss cap, trade size", async () => {
  const { connection, preimage } = lockedCall();
  const full = follow(), losing = follow(), big = follow({ settings: { sizeValue: 900n * USD } }), tiny = follow({ settings: { sizeValue: 1n * USD } });
  const accounts = new Map([
    [full.address.toString(), { netValue: 1_000n * USD, openCopied: 3, dayPnl: 0n }],
    [losing.address.toString(), { netValue: 1_000n * USD, openCopied: 0, dayPnl: -50n * USD }],
  ]);
  const ex = mockExchange({ accounts });
  const out = await copier({ connection, exchange: ex, follows: [full, losing, big, tiny] }).handlePreimage(preimage);
  const by = Object.fromEntries(out.results.map((r) => [r.follow, r]));
  assert.equal(by[full.address.toString()].reason, "max-open");
  assert.equal(by[losing.address.toString()].reason, "daily-loss-cap");
  assert.equal(by[tiny.address.toString()].reason, "below-min-size");
  assert.equal(by[big.address.toString()].status, "confirmed");
  // 900 asked, 250 allowed: 250 USD at 150 = 1.666 SOL, rounded down to the 0.01 step
  assert.equal(ex.signed.length, 1);
  assert.equal(ex.signed[0].orders[0].base, 1_660_000_000n);
});

test("sizing: fixed or a share of the account, clamped and rounded down", () => {
  const market = { minSize: 10_000_000n, stepSize: 10_000_000n, price: 150n * USD };
  const account = { netValue: 2_000n * USD, openCopied: 0, dayPnl: 0n };
  const pct = sizeOrder({ settings: settings({ sizeMode: SIZE_PERCENT, sizeValue: 500n }), account, market }); // 5% of 2000 = 100
  assert.equal(pct.quote, 100n * USD);
  assert.equal(pct.base, 660_000_000n); // 0.666.. SOL down to 0.66
  const clamped = sizeOrder({ settings: settings({ sizeValue: 10_000n * USD }), account, market });
  assert.equal(clamped.quote, 250n * USD);
  assert.ok(clamped.clamped);
  assert.equal(sizeOrder({ settings: settings(), account: { ...account, dayPnl: -49_999_999n }, market }).ok, true); // just under the cap
});

// ------------------------------------------------------------------ TP / SL

test("the call's stop and target go in as reduce-only trigger orders", async () => {
  const salt = withExits(`0x${randomBytes(32).toString("hex")}`, { stop: "140", target: "175.5" });
  const { connection, preimage } = lockedCall({ side: 1, salt });
  const ex = mockExchange();
  await copier({ connection, exchange: ex, follows: [follow()] }).handlePreimage(preimage);
  const [entry, tp, sl] = ex.signed[0].orders;
  assert.deepEqual([entry.kind, entry.direction, entry.reduceOnly], ["entry", "long", false]);
  assert.deepEqual([tp.kind, tp.direction, tp.reduceOnly, tp.triggerCondition, tp.triggerPrice], ["take-profit", "short", true, "above", 175_500_000n]);
  assert.deepEqual([sl.kind, sl.direction, sl.reduceOnly, sl.triggerCondition, sl.triggerPrice], ["stop-loss", "short", true, "below", 140_000_000n]);
  assert.equal(tp.base, entry.base);
});

test("a short's exits trigger the other way; a call without exits is just the entry", () => {
  const salt = withExits(`0x${"11".repeat(32)}`, { stop: "160", target: "120" });
  const [, tp, sl] = ordersFor({ side: -1, base: 1n, salt });
  assert.deepEqual([tp.direction, tp.triggerCondition, sl.triggerCondition], ["long", "below", "above"]);
  assert.equal(ordersFor({ side: 1, base: 1n, salt: `0x${"11".repeat(32)}` }).length, 1);
  assert.equal(priceUnits("0.000123"), 123n);
});

// ------------------------------------------------------------------ exactly once

test("an order is never placed twice: not on a repeated preimage, not after a restart", async () => {
  const { connection, preimage } = lockedCall();
  const path = join(mkdtempSync(join(tmpdir(), "copier-")), "journal.jsonl");
  const f = follow();
  const ex = mockExchange();
  const first = await copier({ connection, exchange: ex, follows: [f], journal: openJournal(path) }).handlePreimage(preimage);
  assert.equal(first.results[0].status, "confirmed");
  const again = await copier({ connection, exchange: ex, follows: [f], journal: openJournal(path) }).handlePreimage(preimage); // a fresh process
  assert.equal(again.results[0].status, "duplicate");
  const concurrent = copier({ connection, exchange: ex, follows: [f], journal: openJournal(null) });
  const [a, b] = await Promise.all([concurrent.handlePreimage(preimage), concurrent.handlePreimage(preimage)]);
  assert.deepEqual([a.results[0].status, b.results[0].status].sort(), ["confirmed", "duplicate"]);
  assert.equal(ex.signed.length, 2, "one for the file journal, one for the in-memory one");
});

test("after a crash between signing and sending, recovery re-sends the same bytes or nothing", async () => {
  const { connection, preimage } = lockedCall();
  const path = join(mkdtempSync(join(tmpdir(), "copier-")), "journal.jsonl");
  const f = follow();
  const ex = mockExchange({ sendFails: 1 });
  const out = await copier({ connection, exchange: ex, follows: [f], journal: openJournal(path) }).handlePreimage(preimage);
  assert.equal(out.results[0].status, "signed");
  assert.equal(ex.sent.length, 0);

  // restart while the blockhash is still valid: the very same transaction goes out
  const live = mockExchange({ status: "pending" });
  const r1 = await copier({ connection, exchange: live, follows: [f], journal: openJournal(path) }).recover();
  assert.deepEqual(r1.map((r) => r.status), ["resent"]);
  assert.equal(live.sent[0], Buffer.from("sig-0").toString("base64"));
  assert.equal(live.signed.length, 0, "never re-signed");

  // restart again after it expired: it is settled as expired, still never re-signed
  const dead = mockExchange({ status: "expired" });
  const r2 = await copier({ connection, exchange: dead, follows: [f], journal: openJournal(path) }).recover();
  assert.deepEqual(r2.map((r) => r.status), ["expired"]);
  assert.equal(dead.signed.length + dead.sent.length, 0);
  const r3 = await copier({ connection, exchange: dead, follows: [f], journal: openJournal(path) }).recover();
  assert.equal(r3.length, 0, "nothing left to settle");
});

test("order ids are stable per call and follow, and in 1..255", () => {
  const a = userOrderId("B", 1, "F");
  assert.equal(a, userOrderId("B", 1, "F"));
  for (let i = 0; i < 500; i++) {
    const id = userOrderId("B", i, "F");
    assert.ok(id >= 1 && id <= 255);
  }
});

test("the copier's journal tolerates a torn last line", async () => {
  const { writeFileSync, appendFileSync } = await import("node:fs");
  const path = join(mkdtempSync(join(tmpdir(), "copier-")), "journal.jsonl");
  writeFileSync(path, `${JSON.stringify({ key: "k", status: "confirmed" })}\n`);
  appendFileSync(path, '{"key":"k","status":"sig');
  const j = openJournal(path);
  assert.equal(j.get("k").status, "confirmed");
  assert.equal(j.claim("k"), false);
});

test("PublicKey interop: a book given as text matches the derived one", () => {
  const { book, agent } = lockedCall();
  assert.ok(new PublicKey(book.toBase58()).equals(bookAddress(agent)));
});
