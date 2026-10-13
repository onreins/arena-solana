/**
 * Arena SDK on Solana: the same calls as the Arc client (callbook/sdk.js), on
 * the Arena program (programs/arena, codec solana/arena.js).
 *
 *   const cb = new CallbookClient({ network: "solana-devnet" });   // or new SolanaCallbookClient({...})
 *   await cb.lock({ coin: "ETH", side: "long", horizon: "4h" });  // first lock opens your book
 *   await cb.revealDue();
 *   await cb.status();
 *
 * One book per key, opened by its first lock. lock(call_id = book.lockCount,
 * call_hash, horizon); reveal(coin, side, salt) once the horizon has passed
 * and within GRACE. Only open calls: strategy books and coin-list books are
 * Arc-only for now, and so is wallet linking.
 *
 * The key: a Solana keypair file with 0600 permissions (callbook/solana-keyfile.js),
 * or a Keypair passed in. It's held in a private field and never printed,
 * logged, returned or sent: only the public key is.
 *
 * Salts are derived, never stored: HMAC-SHA256(secret, "solana:<program>:<book>:lock:<callId>"),
 * the secret being HMAC-SHA256(hex secret key, "arena solana salt secret v1")
 * unless a saltSecret is given. A stop and a target ride in the salt exactly as
 * on Arc (app/verify/callbook-exits.js withExits), so only this machine's
 * journal can reveal a call that has them. Without the journal a call is
 * recovered by trying every coin and side against its hash (the horizon is public).
 *
 * Sending: gasless by default through the relayer (callbook/solana-relay.js);
 * with selfPay the key pays and sends directly. Every lock's confirmation time
 * is measured (latencyMs) and every transaction comes with an Explorer link.
 *
 * Copy-trading: with a copier ({ url, publicKey }), each lock's preimage is
 * sealed to the copier's X25519 key (solana/preimage-box.js) and posted to
 * {url}/preimage, best-effort: a failure never fails the lock.
 */
import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import { homedir } from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

import {
  ARENA_PROGRAM_ID, GRACE, confirmByPolling, bookAddress, callAddress, profileAddress, scoreAddress, callHash, lockIx, revealIx, setProfileIx,
  decodeAccount, eventsFromLogs,
} from "../solana/arena.js";
import { seal as sealPreimage } from "../solana/preimage-box.js";
import { CallbookError, fail } from "./errors.js";
import { createMarkets, MIN_VOLUME_USD } from "./markets.js";
import { Journal } from "./journal.js";
import { SIDES } from "./proof.js";
import { callHorizon, formatDuration, countdown, utc } from "./durations.js";
import { withExits, exitsProblem, sealedPrice } from "../app/verify/callbook-exits.js";
import { checkProfile, profileForDisplay } from "../app/verify/arena-names.js";
import { loadOrCreateSolanaKeypair } from "./solana-keyfile.js";
import { relayContext, relaySubmit, solanaError } from "./solana-relay.js";

export const SOLANA_NETWORKS = Object.freeze({
  "solana-devnet": { label: "Solana devnet", rpc: "https://api.devnet.solana.com", cluster: "devnet" },
});
export const isSolanaNetwork = (n) => /^solana(-|$)/i.test(String(n ?? "").trim());

const APP_URL = "https://app.reins.one";
const SECRET_LABEL = "arena solana salt secret v1";
const SALT_SECRET = /^(0x)?[0-9a-fA-F]{64}$/;
const COPIER_TIMEOUT_MS = 5_000;
const BATCH = 100;
const LOCK_QUEUES = new Map();
const SIDE_WORD = { 1: "long", "-1": "short" };

export const explorerTx = (sig, cluster = "devnet") => `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
export const explorerAddress = (a, cluster = "devnet") => `https://explorer.solana.com/address/${a}?cluster=${cluster}`;

function sideOf(side) {
  const word = String(side ?? "").trim().toLowerCase();
  const alias = { up: "long", buy: "long", down: "short", sell: "short" }[word] ?? word;
  if (alias === "flat") fail("An open call is a position: long or short.", "BadSide");
  if (alias !== "long" && alias !== "short") fail(`"${side}" isn't a side. Use long or short.`, "BadSide");
  return SIDES[alias];
}

const wrap = (fn) => {
  try {
    return fn();
  } catch (err) {
    throw err instanceof CallbookError ? err : new CallbookError(err.message, "BadInput");
  }
};

const notOnSolana = (what) => fail(`${what} isn't available on Solana yet: there, each key has one open-call book. Use arena_lock.`, "NotOnSolana");

export class SolanaCallbookClient {
  #keypair;
  #secret;

  /**
   * @param {object} o
   * @param {string} [o.network="solana-devnet"]
   * @param {Keypair} [o.keypair]          the agent's key; default: the key file
   * @param {string} [o.keyFile]           keypair file (default ~/.arena/solana-keypair.json, made 0600 if missing)
   * @param {string} [o.rpc]               RPC URL (default: the cluster's public RPC)
   * @param {Connection} [o.connection]    an existing Connection (tests pass a mock)
   * @param {string} [o.programId]         the Arena program (default ARENA_PROGRAM_ID)
   * @param {string} [o.relayUrl]          Reins app URL whose /api/solana/relay pays the fees
   * @param {boolean} [o.selfPay=false]    pay and send directly instead of through the relayer
   * @param {string} [o.apiUrl]            Reins app URL for profile links
   * @param {string} [o.saltSecret]        64 hex digits; default derived from the key
   * @param {string|false} [o.journal]     journal file, or false for memory only (default ~/.arena/solana-<pubkey>.json)
   * @param {string} [o.validator]         Reins' validator public key: status and verify read its Score account
   * @param {{url: string, publicKey: string}} [o.copier]  where locks' sealed preimages go
   * @param {Function} [o.now]             unix seconds (default: the chain's block time)
   * @param {Function} [o.log]             where warnings and latencies go (default stderr)
   * @param {object} [o.markets]           a markets source
   * @param {Function} [o.fetch]
   */
  constructor(o = {}) {
    this.network = o.network ?? "solana-devnet";
    const net = SOLANA_NETWORKS[this.network];
    if (!net) fail(`"${this.network}" isn't a Solana network: use ${Object.keys(SOLANA_NETWORKS).join(" or ")}.`, "BadNetwork");
    this.solana = true;
    this.chainLabel = "Solana";
    this.label = net.label;
    this.cluster = net.cluster;
    let kp = o.keypair;
    if (!kp) {
      const loaded = loadOrCreateSolanaKeypair(o.keyFile || undefined);
      kp = loaded.keypair;
      this.keyFile = loaded.file;
    }
    if (!(kp instanceof Keypair)) fail("The Solana key must be a Keypair.", "BadKey");
    this.#keypair = kp;
    this.publicKey = kp.publicKey;
    this.address = kp.publicKey.toBase58();
    this.me = this.address;
    try {
      this.programId = new PublicKey(o.programId ?? ARENA_PROGRAM_ID);
    } catch {
      fail(`"${o.programId}" isn't a program id.`, "BadAddress");
    }
    this.book = bookAddress(this.publicKey, this.programId);
    const secret = o.saltSecret ?? createHmac("sha256", Buffer.from(kp.secretKey).toString("hex")).update(SECRET_LABEL).digest("hex");
    if (!SALT_SECRET.test(String(secret)) || /^(0x)?(.)\2{63}$/i.test(String(secret))) {
      fail("saltSecret must be 32 random bytes written as 64 hex digits (for example: openssl rand -hex 32).", "BadSecret");
    }
    this.#secret = String(secret).replace(/^0x/, "").toLowerCase();
    this.opts = { ...o };
    delete this.opts.keypair;
    delete this.opts.saltSecret;
    this.connection = o.connection ?? new Connection(o.rpc ?? net.rpc, "confirmed");
    this.relayUrl = o.relayUrl ?? null;
    this.selfPay = Boolean(o.selfPay);
    this.fetch = o.fetch ?? globalThis.fetch;
    this.marketsSource = o.markets ?? createMarkets({ fetch: this.fetch });
    this.journal = new Journal(o.journal === false ? null : o.journal ?? path.join(homedir(), ".arena", `solana-${this.address}.json`));
    this.copier = o.copier?.url && o.copier?.publicKey ? { url: String(o.copier.url).replace(/\/$/, ""), publicKey: o.copier.publicKey } : null;
    this.log = o.log ?? ((m) => console.error(m));
    this.validator = o.validator ? new PublicKey(o.validator) : null;
  }

  /** Never the key: a client printed or serialised shows only public things. */
  toJSON() {
    return { network: this.network, address: this.address, programId: this.programId.toBase58(), book: this.book.toBase58() };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `SolanaCallbookClient ${JSON.stringify(this.toJSON())}`;
  }

  // ------------------------------------------------------------------ plumbing

  async now() {
    if (this.opts.now) return Math.floor(await this.opts.now());
    try {
      const t = await this.connection.getBlockTime(await this.connection.getSlot("confirmed"));
      if (Number.isFinite(t)) return t;
    } catch { /* the clock below is close enough */ }
    return Math.floor(Date.now() / 1000);
  }

  explorer(sig) {
    return explorerTx(sig, this.cluster);
  }

  /** A lock's base salt (before exits): bound to the program, the book and the call id. */
  lockSalt(callId) {
    return `0x${createHmac("sha256", this.#secret).update(`solana:${this.programId.toBase58()}:${this.book.toBase58()}:lock:${callId}`).digest("hex")}`;
  }

  slot(callId) {
    return { chainId: this.network, callbook: this.programId.toBase58(), bookId: this.book.toBase58(), callId };
  }

  async account(address) {
    let info;
    try {
      info = await this.connection.getAccountInfo(address, "confirmed");
    } catch (err) {
      throw solanaError(err, "read");
    }
    if (!info?.data) return null;
    if (info.owner && !new PublicKey(info.owner).equals(this.programId)) return null;
    return decodeAccount(info.data);
  }

  async readBook(book = this.book) {
    const a = await this.account(book);
    return a?.type === "Book" ? a : null;
  }

  /** Call accounts by id: [{ ...call }|null] in order. */
  async readCalls(ids, book = this.book) {
    const out = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      let infos;
      try {
        infos = await this.connection.getMultipleAccountsInfo(chunk.map((id) => callAddress(book, id, this.programId)), "confirmed");
      } catch (err) {
        throw solanaError(err, "read");
      }
      for (const info of infos) {
        const a = info?.data && (!info.owner || new PublicKey(info.owner).equals(this.programId)) ? decodeAccount(info.data) : null;
        out.push(a?.type === "Call" ? a : null);
      }
    }
    return out;
  }

  /** Whether transactions go through the relayer. */
  gasless() {
    if (this.selfPay) return false;
    if (!this.relayUrl) fail("No relayer is set, so nothing can be sent gasless. Set ARENA_RELAY_URL, or ARENA_SOLANA_SELF_PAY=1 and fund the key with SOL.", "NoRelay");
    return true;
  }

  /**
   * Build (with the fee payer), sign, send and confirm one instruction.
   * Returns { signature, gasless, latencyMs }.
   */
  async send(build, what) {
    const gasless = this.gasless();
    const t0 = performance.now();
    let signature, blockhash, lastValidBlockHeight;
    try {
      if (gasless) {
        const ctx = await relayContext({ relayUrl: this.relayUrl, fetch: this.fetch });
        ({ blockhash, lastValidBlockHeight } = ctx);
        const tx = new Transaction({ feePayer: ctx.feePayer, blockhash, lastValidBlockHeight }).add(build(ctx.feePayer));
        tx.partialSign(this.#keypair);
        signature = await relaySubmit({ relayUrl: this.relayUrl, fetch: this.fetch }, tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"));
      } else {
        ({ blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed"));
        const tx = new Transaction({ feePayer: this.publicKey, blockhash, lastValidBlockHeight }).add(build(this.publicKey));
        tx.sign(this.#keypair);
        signature = await this.connection.sendRawTransaction(tx.serialize());
      }
      // polled over HTTP: a websocket confirmation fails on proxied networks
      await confirmByPolling(this.connection, signature, lastValidBlockHeight).catch((e) => { throw e.err ? solanaError(e.err, what) : e; });
    } catch (err) {
      throw solanaError(err, what);
    }
    return { signature, gasless, latencyMs: Math.round(performance.now() - t0) };
  }

  /** Run fn with no other lock from this key in flight (in this process). */
  async exclusive(fn) {
    const prev = LOCK_QUEUES.get(this.me) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    LOCK_QUEUES.set(this.me, tail);
    try {
      return await run;
    } finally {
      if (LOCK_QUEUES.get(this.me) === tail) LOCK_QUEUES.delete(this.me);
    }
  }

  async resolveCoin(symbol) {
    const raw = String(symbol ?? "").trim();
    if (!raw) fail("Name a coin, for example ETH.", "BadCoin");
    const found = await this.marketsSource.resolve(raw);
    if (!found) fail(`Hyperliquid has no perp called "${raw}". Ask arena_markets for the list.`, "UnknownCoin");
    if (Buffer.byteLength(found) > 16) fail(`"${found}" is longer than 16 bytes, which a call can't hold.`, "BadCoin");
    return found;
  }

  checkBook(book) {
    if (book == null || book === "") return;
    const b = String(book).trim();
    if (b !== this.book.toBase58() && b !== this.address) {
      fail(`On Solana this key has one book, ${this.book.toBase58()}, opened by its first lock; it can't act in ${b}.`, "NotCaller");
    }
  }

  profileUrl() {
    return `${(this.opts.apiUrl ?? APP_URL).replace(/\/$/, "")}/arena/p/${this.address}`;
  }

  // ------------------------------------------------------------------ reading

  async markets({ limit = 50, minVolumeUsd = MIN_VOLUME_USD } = {}) {
    const list = await this.marketsSource.list({ limit, minVolumeUsd });
    return list.map((p) => ({ coin: p.coin, volumeUsd: Math.round(p.volumeUsd), price: p.price, funding: p.funding }));
  }

  async myBooks() {
    const book = await this.readBook();
    if (!book) return { address: this.address, network: this.label, books: [] };
    const now = await this.now();
    const calls = (await this.readCalls([...Array(book.lockCount).keys()])).filter(Boolean);
    const open = calls.filter((c) => !c.revealed);
    const due = open.filter((c) => now >= c.entryAt + c.horizon && now <= c.entryAt + c.horizon + GRACE).length;
    return {
      address: this.address, network: this.label,
      books: [{ book: this.book.toBase58(), kind: "calls", anyCoin: true, calls: book.lockCount, open: open.length, dueToReveal: due, openedAt: book.openedAt, explorer: explorerAddress(this.book.toBase58(), this.cluster) }],
    };
  }

  // ------------------------------------------------------------------ books

  async openCallBook({ coins } = {}) {
    if (coins != null && (Array.isArray(coins) ? coins.length : String(coins).trim())) notOnSolana("A call book with a coin list");
    const book = await this.readBook();
    return book
      ? { book: this.book.toBase58(), kind: "calls", anyCoin: true, existing: true, summary: `Your open-call book is ${this.book.toBase58()}. Lock a call on any Hyperliquid perp any time.` }
      : { book: this.book.toBase58(), kind: "calls", anyCoin: true, opensOnFirstLock: true, summary: "Your open-call book opens with your first lock, and Reins pays the fee. Lock a call to start." };
  }

  async openStrategyBook() { notOnSolana("A strategy book"); }
  async seal() { notOnSolana("Sealing a strategy round"); }
  async linkRequest() { notOnSolana("Linking a wallet"); }
  async unlinkWallet() { notOnSolana("Unlinking a wallet"); }

  // ------------------------------------------------------------------ locking

  async checkExits(coin, side, horizon, exits) {
    if (exits.stop == null && exits.target == null) return;
    let price = null;
    try {
      price = (await this.marketsSource.perps()).find((p) => p.coin === coin)?.price ?? null;
    } catch { /* checked without it */ }
    const problem = exitsProblem({ side, ...exits, price, horizon, coin });
    if (problem) fail(problem, "BadExits");
  }

  /**
   * Lock an open call in this key's book (its first lock opens it). `stop` and
   * `target` (prices, optional) ride in the salt, as on Arc, and are kept in the journal.
   */
  async lock({ coin, side, horizon = "4h", book, stop = null, target = null } = {}) {
    this.checkBook(book);
    const s = sideOf(side);
    const exits = wrap(() => ({ stop: stop == null || stop === "" ? null : sealedPrice(stop), target: target == null || target === "" ? null : sealedPrice(target) }));
    const c = await this.resolveCoin(coin);
    const h = wrap(() => callHorizon(horizon));
    await this.checkExits(c, s, h, exits);
    // Serialised here; another process with this key can still take the id first,
    // and then the program refuses ours with StaleId: read the count again and retry once.
    const attempt = () => this.exclusive(() => this.lockOnce(c, s, h, exits));
    try {
      return await attempt();
    } catch (err) {
      if (err?.code !== "StaleId") throw err;
      return attempt();
    }
  }

  async lockOnce(coin, side, horizon, exits) {
    const before = await this.readBook();
    const callId = before?.lockCount ?? 0;
    const salt = withExits(this.lockSalt(callId), exits);
    const hash = callHash({ programId: this.programId, book: this.book, callId, horizon, coin, side, salt });
    const sent = await this.send((payer) => lockIx({ owner: this.publicKey, payer, callId, callHash: hash, horizon, programId: this.programId }), "lock");
    // The chain, not the relayer, says what was locked.
    const call = (await this.readCalls([callId]))[0];
    if (!call || !Buffer.from(call.callHash).equals(hash)) {
      fail(`Transaction ${sent.signature} confirmed, but call ${callId} on chain isn't this call, so it wasn't recorded. Check ARENA_RELAY_URL.`, "BadRelay");
    }
    const has = exits.stop != null || exits.target != null;
    this.journal.put({
      ...this.slot(callId), program: this.programId.toBase58(), owner: this.address, coin, side, horizon,
      entryAt: call.entryAt, signature: sent.signature, ...(has ? { exits } : {}),
    });
    this.log(`arena: lock ${callId} confirmed in ${sent.latencyMs} ms (${sent.gasless ? "gasless" : "self-paid"}) ${this.explorer(sent.signature)}`);

    let copier;
    if (this.copier) {
      copier = await this.shareWithCopier({
        program: this.programId.toBase58(), book: this.book.toBase58(), owner: this.address, callId, coin, side, horizon, salt, ...(has ? { exits } : {}),
      }, sent.signature);
    }
    const revealAt = call.entryAt + horizon;
    const levels = [exits.stop != null ? `stop ${exits.stop}` : null, exits.target != null ? `target ${exits.target}` : null].filter(Boolean).join(", ");
    return {
      network: this.label, book: this.book.toBase58(), callId, coin, side: SIDE_WORD[side], horizon: formatDuration(horizon),
      entryAt: call.entryAt, revealAt, openedBook: !before, gasless: sent.gasless, ...(has ? { stop: exits.stop, target: exits.target } : {}),
      signature: sent.signature, tx: sent.signature, explorer: this.explorer(sent.signature), latencyMs: sent.latencyMs,
      ...(copier ? { copier } : {}),
      summary: `Locked ${SIDE_WORD[side]} ${coin} ${has ? `with ${levels}, held at most ${formatDuration(horizon)}` : `for ${formatDuration(horizon)}`} ` +
        `(call ${callId}${before ? "" : ", your new open-call book"}) on ${this.label}, confirmed in ${sent.latencyMs} ms. ` +
        `Entry ${utc(call.entryAt)}; reveal from ${utc(revealAt)}. ${this.explorer(sent.signature)}` +
        (has ? " The stop and target are kept in this machine's journal: it's needed to reveal this call." : ""),
    };
  }

  /** Best-effort: seal the preimage to the copier and post it. Never throws; logs no secrets. */
  async shareWithCopier(preimage, signature) {
    try {
      const box = sealPreimage(preimage, this.copier.publicKey);
      const res = await this.fetch(`${this.copier.url}/preimage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature, owner: preimage.owner, book: preimage.book, callId: preimage.callId, box }),
        signal: AbortSignal.timeout(COPIER_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return "sent";
    } catch (err) {
      this.log(`arena: warning: couldn't send call ${preimage.callId} to the copier at ${this.copier.url} (${String(err?.message ?? err).slice(0, 120)}); the lock stands.`);
      return "failed";
    }
  }

  // ------------------------------------------------------------------ revealing

  /** The journal's plaintext for a call, if it matches the hash. */
  noted(call) {
    const n = this.journal.get(this.slot(call.callId));
    if (!n) return null;
    const salt = withExits(this.lockSalt(call.callId), n.exits ?? {});
    try {
      const h = callHash({ programId: this.programId, book: this.book, callId: call.callId, horizon: call.horizon, coin: n.coin, side: n.side, salt });
      return h.equals(Buffer.from(call.callHash)) ? { coin: n.coin, side: n.side, salt, exits: n.exits ?? null } : null;
    } catch {
      return null;
    }
  }

  /** The plaintext behind a call: the journal, else a search over every coin and side (no exits). */
  async plain(call) {
    const n = this.noted(call);
    if (n) return n;
    const salt = this.lockSalt(call.callId);
    const want = Buffer.from(call.callHash);
    let coins;
    try {
      coins = await this.marketsSource.names();
    } catch {
      return null;
    }
    for (const coin of coins) {
      if (Buffer.byteLength(coin) > 16) continue;
      for (const side of [1, -1]) {
        if (callHash({ programId: this.programId, book: this.book, callId: call.callId, horizon: call.horizon, coin, side, salt }).equals(want)) {
          this.journal.put({ ...this.slot(call.callId), program: this.programId.toBase58(), owner: this.address, coin, side, horizon: call.horizon, entryAt: call.entryAt, recovered: true });
          return { coin, side, salt, exits: null };
        }
      }
    }
    return null;
  }

  /** Reveal every due (entry + horizon <= now <= + GRACE), unrevealed call of this key. */
  async revealDue() {
    const out = { revealed: [], waiting: [], expired: [], failed: [] };
    const book = await this.readBook();
    if (!book) return { ...out, summary: "This key has no book yet, so there's nothing to reveal. Lock a call to start." };
    const now = await this.now();
    const calls = await this.readCalls([...Array(book.lockCount).keys()]);
    for (const call of calls) {
      if (!call || call.revealed) continue;
      const exit = call.entryAt + call.horizon;
      const item = { callId: call.callId, horizon: formatDuration(call.horizon), revealAt: exit };
      if (now < exit) {
        const n = this.noted(call);
        out.waiting.push({ ...item, ...(n ? { coin: n.coin, side: SIDE_WORD[n.side] } : {}), revealIn: countdown(exit - now) });
        continue;
      }
      if (now > exit + GRACE) {
        out.expired.push({ ...item, note: "the 7-day reveal window closed; it scores as its worst outcome" });
        continue;
      }
      const p = await this.plain(call);
      if (!p) {
        out.failed.push({ ...item, reason: "Neither the journal nor a search over every coin and side matches this call: it was locked with another salt secret, or with a stop or target on a machine whose journal this isn't." });
        continue;
      }
      const described = { ...item, coin: p.coin, side: SIDE_WORD[p.side] };
      try {
        const sent = await this.send(() => revealIx({ revealer: this.publicKey, owner: this.publicKey, callId: call.callId, coin: p.coin, side: p.side, salt: p.salt, programId: this.programId }), "reveal");
        out.revealed.push({ ...described, signature: sent.signature, explorer: this.explorer(sent.signature), latencyMs: sent.latencyMs });
        this.journal.forget([this.slot(call.callId)]);
      } catch (err) {
        out.failed.push({ ...described, reason: solanaError(err, "reveal").message });
      }
    }
    const next = out.waiting.length ? Math.min(...out.waiting.map((w) => w.revealAt)) : null;
    out.summary = `Revealed ${out.revealed.length} call${out.revealed.length === 1 ? "" : "s"}` +
      (out.revealed.length ? ` (${out.revealed.map((r) => r.explorer).join(" ")})` : "") +
      (out.waiting.length ? `; ${out.waiting.length} still maturing (next ${utc(next)}, ${countdown(next - now)})` : "") +
      (out.expired.length ? `; ${out.expired.length} past the reveal window` : "") +
      (out.failed.length ? `; ${out.failed.length} couldn't be revealed (see failed)` : "") + ".";
    return out;
  }

  // ------------------------------------------------------------------ status, verify, profile

  async score(book = this.book) {
    if (!this.validator) return null;
    const a = await this.account(scoreAddress(this.validator, book, this.programId)).catch(() => null);
    if (a?.type !== "Score") return null;
    return { score: a.score, calls: a.calls, revealed: a.revealed, withheld: a.withheld, throughCall: a.throughCall, scoredAt: a.scoredAt, scoring: a.scoring, reportHash: `0x${Buffer.from(a.reportHash).toString("hex")}` };
  }

  /** Record, pending calls with countdowns, and the next deadline. */
  async status({ book } = {}) {
    this.checkBook(book);
    const b = await this.readBook();
    const url = this.profileUrl();
    if (!b) return { address: this.address, network: this.label, books: [], url, summary: "This key has no book yet. Lock a call (any coin, any time) to start a record." };
    const now = await this.now();
    const calls = (await this.readCalls([...Array(b.lockCount).keys()])).filter(Boolean);
    const revealed = calls.filter((c) => c.revealed);
    const pending = [], due = [], withheld = [];
    for (const c of calls.filter((x) => !x.revealed)) {
      const exit = c.entryAt + c.horizon;
      const n = this.noted(c);
      const item = { callId: c.callId, horizon: formatDuration(c.horizon), entryAt: c.entryAt, revealAt: exit, ...(n ? { coin: n.coin, side: SIDE_WORD[n.side] } : {}) };
      if (now < exit) pending.push({ ...item, revealIn: countdown(exit - now) });
      else if (now <= exit + GRACE) due.push({ ...item, revealBy: exit + GRACE, closesIn: countdown(exit + GRACE - now) });
      else withheld.push(item);
    }
    const score = await this.score();
    const nextAt = [...pending.map((p) => p.revealAt), ...due.map((d) => d.revealBy)].sort((x, y) => x - y)[0] ?? null;
    const summary = `Book ${this.book.toBase58()} on ${this.label}: ${b.lockCount} call${b.lockCount === 1 ? "" : "s"}, ${revealed.length} revealed, ` +
      `${pending.length} maturing, ${due.length} due to reveal${withheld.length ? `, ${withheld.length} kept hidden past the window (scored as worst)` : ""}.` +
      (score ? ` Score ${score.score}/100 (${score.scoring}, through call ${score.throughCall}).` : "") +
      (due.length ? " Run arena_reveal_due now." : nextAt ? ` Next: ${utc(nextAt)} (${countdown(nextAt - now)}).` : "") + ` Your profile: ${url}`;
    return {
      address: this.address, network: this.label, book: this.book.toBase58(), calls: b.lockCount, revealed: revealed.length,
      pending, due, withheld, score, nextDeadline: nextAt, url,
      books: [{ book: this.book.toBase58(), calls: b.lockCount, revealed: revealed.length, pending: pending.length, dueToReveal: due.length, withheld: withheld.length }],
      summary,
    };
  }

  /** The Revealed event for a call, from its transaction history (the salt is in it). */
  async revealedEvent(book, callId) {
    const addr = callAddress(book, callId, this.programId);
    const sigs = await this.connection.getSignaturesForAddress(addr, { limit: 25 }, "confirmed");
    for (const s of sigs ?? []) {
      if (s.err) continue;
      const tx = await this.connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      const ev = eventsFromLogs(tx?.meta?.logMessages ?? [], this.programId).find((e) => e.name === "Revealed" && e.callId === callId && e.book.equals(book));
      if (ev) return { ...ev, signature: s.signature };
    }
    return null;
  }

  /**
   * Check a book from the chain alone: every revealed call's Revealed event
   * (coin, side, salt) against its locked hash, the reveal-window accounting,
   * and the validator's Score account when one is configured.
   * `book`: a book address or its owner's (default: this key's).
   */
  async verify({ book } = {}) {
    let target = this.book, owner = this.publicKey;
    if (book != null && book !== "") {
      let pk;
      try {
        pk = new PublicKey(String(book).trim());
      } catch {
        fail(`"${book}" isn't a Solana address (a book or its owner).`, "BadBook");
      }
      const direct = await this.readBook(pk);
      if (direct) { target = pk; owner = direct.owner; } else { owner = pk; target = bookAddress(pk, this.programId); }
    }
    const b = await this.readBook(target);
    if (!b) fail(`There's no Arena book at ${target.toBase58()} on ${this.label}.`, "UnknownBook");
    const now = await this.now();
    const calls = (await this.readCalls([...Array(b.lockCount).keys()], target)).filter(Boolean);
    const checked = [], mismatched = [], missing = [];
    for (const c of calls.filter((x) => x.revealed)) {
      let ev;
      try {
        ev = await this.revealedEvent(target, c.callId);
      } catch (err) {
        throw solanaError(err, "read");
      }
      if (!ev) { missing.push(c.callId); continue; }
      const h = callHash({ programId: this.programId, book: target, callId: c.callId, horizon: ev.horizon, coin: ev.coin, side: ev.side, salt: ev.salt });
      const ok = h.equals(Buffer.from(c.callHash)) && ev.coin === c.coin && ev.side === c.side && ev.horizon === c.horizon;
      (ok ? checked : mismatched).push({ callId: c.callId, coin: ev.coin, side: SIDE_WORD[ev.side], signature: ev.signature });
    }
    const hidden = calls.filter((c) => !c.revealed && now > c.entryAt + c.horizon + GRACE).map((c) => c.callId);
    const score = await this.score(target);
    const scoreOk = score ? score.calls <= b.lockCount && score.withheld >= 0 : null;
    const summary = `Book ${target.toBase58()} (owner ${owner.toBase58()}) on ${this.label}: ${b.lockCount} calls; ` +
      `${checked.length} revealed call${checked.length === 1 ? "" : "s"} match${checked.length === 1 ? "es" : ""} ${checked.length === 1 ? "its" : "their"} locked hash${checked.length === 1 ? "" : "es"} (salts from the Revealed events)` +
      (mismatched.length ? `; MISMATCH on ${mismatched.length}: ${mismatched.map((m) => m.callId).join(", ")}` : "") +
      (missing.length ? `; ${missing.length} revealed without a Revealed event in reach` : "") +
      (hidden.length ? `; ${hidden.length} kept hidden past the window (scored as worst)` : "") + "." +
      (score ? ` Posted score ${score.score}/100 (${score.scoring}) through call ${score.throughCall}.` : this.validator ? " No score posted yet." : "");
    return {
      book: target.toBase58(), owner: owner.toBase58(), network: this.label, calls: b.lockCount,
      checked, mismatched, missing, hidden, posted: score, postedConsistent: scoreOk, match: mismatched.length === 0, summary,
    };
  }

  async readProfile() {
    const a = await this.account(profileAddress(this.publicKey, this.programId));
    return a?.type === "Profile" ? a : null;
  }

  async profile() {
    const url = this.profileUrl();
    const p = await this.readProfile();
    const own = p ? profileForDisplay({ name: p.name, bio: p.bio, link: p.link }) : null;
    return {
      address: this.address, network: this.label, profile: own, book: this.book.toBase58(), url,
      summary: own?.name
        ? `You're "${own.name}" in Arena${own.bio ? ` (${own.bio})` : ""}. Your profile: ${url}`
        : `You have no Arena name yet, so your records show your address. Set one with arena_profile. Your profile: ${url}`,
    };
  }

  async setProfile({ name, bio, link, book } = {}) {
    if (book != null && book !== "" && Number(book) !== 0) notOnSolana("Naming a single book");
    const cur = (await this.readProfile()) ?? {};
    const want = { name: name ?? cur.name ?? "", bio: bio ?? cur.bio ?? "", link: link ?? cur.link ?? "" };
    if (!want.name.trim() && name === undefined && (bio || link)) fail("Pick a name first: a bio and link show under a name.", "BadProfile");
    const checked = checkProfile(want);
    if (!checked.ok) fail(checked.error, "BadProfile");
    const p = checked.profile;
    const sent = await this.send((payer) => setProfileIx({ owner: this.publicKey, payer, ...p, programId: this.programId }), "profile");
    const url = this.profileUrl();
    return {
      ...p, gasless: sent.gasless, signature: sent.signature, tx: sent.signature, explorer: this.explorer(sent.signature), url,
      summary: p.name
        ? `Your Arena name is now "${p.name}". Names are public and stay in the chain's history. ${this.explorer(sent.signature)} Your profile: ${url}`
        : `Your Arena name is cleared; your records show your address again. Your profile: ${url}`,
    };
  }
}

/**
 * The Solana client from the environment (after arenaEnv: ARENA_X is CALLBOOK_X).
 * `own`: the loaded key file ({ keypair, file }); loaded here when not given.
 */
export function solanaClientFromEnv(env, own = null, extra = {}) {
  const app = (v) => (v === "" || v === "off" || v === "none" ? undefined : v ?? APP_URL);
  const kf = own?.keypair ? own : loadOrCreateSolanaKeypair(env.CALLBOOK_SOLANA_KEYPAIR || undefined);
  const copier = env.CALLBOOK_COPIER_URL && env.CALLBOOK_COPIER_PUBKEY ? { url: env.CALLBOOK_COPIER_URL, publicKey: env.CALLBOOK_COPIER_PUBKEY } : undefined;
  const client = new SolanaCallbookClient({
    network: env.CALLBOOK_NETWORK,
    keypair: kf.keypair,
    rpc: env.CALLBOOK_SOLANA_RPC || undefined,
    programId: env.CALLBOOK_SOLANA_PROGRAM_ID || undefined,
    relayUrl: app(env.CALLBOOK_RELAY_URL),
    apiUrl: app(env.CALLBOOK_API_URL),
    selfPay: /^(1|true|yes|on)$/i.test(env.CALLBOOK_SOLANA_SELF_PAY ?? ""),
    saltSecret: env.CALLBOOK_SALT_SECRET || undefined,
    journal: env.CALLBOOK_JOURNAL === "off" ? false : env.CALLBOOK_JOURNAL || undefined,
    validator: env.CALLBOOK_SOLANA_VALIDATOR || undefined,
    copier,
    ...extra,
  });
  client.keyFile = kf.file ?? null;
  return client;
}
