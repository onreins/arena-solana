/**
 * The Solana Arena relayer: it pays the fee (and the rent of the accounts an
 * instruction creates) so nobody needs SOL to keep a record. The Solana twin
 * of app/verify/callbook-relay.js, with the same limits and store.
 *
 * The flow:
 *   GET  -> { feePayer, blockhash, lastValidBlockHeight, programId }
 *   the client builds a legacy Transaction with feePayer = the relayer and that
 *   blockhash, holding ONE Arena instruction built by solana/arena.js with the
 *   relayer as `payer`; the user's keypair partially signs it
 *   POST { tx: base64 } -> { signature, kind, owner, lamports }
 *
 * What it will co-sign, and nothing else:
 *   lock         lockIx({ owner: user, payer: relayer, callId, callHash, horizon })
 *   reveal       revealIx({ revealer: user, owner, callId, coin, side, salt }) for
 *                an existing, unrevealed call whose hash the preimage matches
 *   set_profile  setProfileIx({ owner: user, payer: relayer, name, bio, link }),
 *                text already in the form the name rules clean it to (arena-names.js),
 *                and only for an account that has a book (as the Callbook relay)
 * write_score is never relayed.
 *
 * Checks before the relayer signs anything (cheapest first):
 *   - at most 1232 bytes; a legacy message (no v0, so no address lookup tables),
 *     canonical (re-serializes to the same bytes, nothing trailing)
 *   - exactly two required signatures: [0] the relayer as fee payer, its slot
 *     blank; [1] the user, whose signature is present and valid over the message
 *   - exactly one instruction, to the Arena program, a known discriminator other
 *     than write_score; its data decodes exactly; its account metas equal what
 *     solana/arena.js builds from the decoded arguments (keys, signer and writable
 *     flags, in order), so the relayer appears only as `payer` and the user only
 *     as `owner` (or `revealer`); the message names no account beyond those
 *   - ComputeBudget instructions are refused outright: the fee is then exactly
 *     5000 lamports per signature, with no priority fee to bound
 *   - the blockhash is still valid (connection.isBlockhashValid)
 *   - never seen before (the user's signature is the dedupe key)
 *   - the transaction simulates cleanly, simulated with the relayer's slot
 *     still blank and sigVerify off, so nothing the relayer signed leaves
 *     before the send
 * Only then does it take slots of the limits and reserve the cost against the
 * daily budget, claim the user's signature atomically in the store (a second
 * claim loses: 409 with the signature), sign, and send once with maxRetries 0.
 * A send that fails is never retried: resubmitting is 409, and the user signs
 * afresh with a new blockhash.
 *
 * Limits (defaults in SOLANA_RELAY_LIMITS), mirroring the Callbook relay:
 *   - 30 locks an hour per account, 60 reveals an hour per account,
 *     5 profile changes a day per account
 *   - 600 relayed transactions an hour in total
 *   - 120 requests an hour per client IP (IPv6 by /64), 60 refused ones;
 *     60 refused ones per account (counted only once its signature checked out)
 *   - 30 sends an hour per IP, 10 new books a day per IP
 *   - a daily budget in lamports (ARENA_SOLANA_RELAYER_DAILY_SOL, default
 *     0.25 SOL), charged fee + rent for each account the instruction creates
 *     (Call always, Book on a first lock, Profile on a first set_profile)
 *   - at most 20 requests in flight; past that, 503
 *
 * The store FAILS CLOSED: if it throws, times out, or answers nonsense, the
 * answer is 503 and nothing is signed. The relayer key is held as a private
 * KeyObject inside this closure, and is never logged or returned.
 */
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import bs58 from "bs58";
import { Keypair, Message, PublicKey, VersionedTransaction } from "@solana/web3.js";

import {
  ARENA_PROGRAM_ID, INSTRUCTIONS, MAX_COIN_BYTES, MAX_NAME_BYTES, MAX_BIO_BYTES, MAX_LINK_BYTES, MIN_HORIZON, MAX_HORIZON, TIME_UNIT,
  lockIx, revealIx, setProfileIx, bookAddress, profileAddress, decodeAccount, callHash,
} from "./arena.js";
import { ipBucket, brief } from "../app/verify/callbook-util.js";
import { checkProfile } from "../app/verify/arena-names.js";

const HOUR = 3_600;
const DAY = 86_400;
/** The largest transaction Solana takes (PACKET_DATA_SIZE). */
export const MAX_TX_BYTES = 1232;
/** The base fee, per signature. With no ComputeBudget instruction there is no priority fee. */
export const LAMPORTS_PER_SIGNATURE = 5_000;

/**
 * Bytes of each Arena account, `8 + INIT_SPACE` from programs/arena/src/lib.rs
 * (the test reads the structs and checks these):
 *   Book    8 + 1 + 1 + 32 + 8 + 8                                   =  58
 *   Call    8 + 1 + 32 + 8 + 32 + 8 + 8 + 4 + 1 + 1 + 1 + 16 + 8     = 128
 *   Profile 8 + 1 + 1 + 32 + (4+32) + (4+160) + (4+100) + 8           = 354
 *   Score   8 + 175 (its layout table ends at byte 183)                = 183
 */
export const ACCOUNT_SIZES = Object.freeze({ Book: 58, Call: 128, Profile: 354, Score: 183 });

export const SOLANA_RELAY_LIMITS = Object.freeze({
  locksPerAccountHour: 30,
  revealsPerAccountHour: 60,
  profilesPerAccountDay: 5,
  txPerHour: 600,
  requestsPerIpHour: 120,
  infoPerIpHour: 600,
  failuresPerIpHour: 60,
  failuresPerAccountHour: 60,
  sendsPerIpHour: 30,
  newBooksPerIpDay: 10,
  dailyBudgetLamports: 250_000_000, // 0.25 SOL
  maxInFlight: 20,
  dedupeTtlSec: DAY, // far past any blockhash's life (~150 blocks, about a minute)
  confirmTimeoutMs: 0, // 0: answer once sent; > 0: wait that long for "confirmed"
});

/** A relay error with an HTTP status and a sentence for the person. */
export class SolanaRelayError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const refuse = (m) => new SolanaRelayError(400, m);

const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const pubKeyObject = (pk) => createPublicKey({ key: Buffer.concat([SPKI, pk.toBuffer()]), format: "der", type: "spki" });
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DISC_BY_NAME = Object.fromEntries(Object.entries(INSTRUCTIONS).map(([hex, n]) => [n, hex]));

/**
 * The relayer's Keypair from ARENA_SOLANA_RELAYER_KEY (a JSON array of 64
 * bytes, or the same 64 bytes in base58), or null when unset. Errors never
 * contain the value.
 */
export function relayerKeyFromEnv(env = process.env) {
  const raw = env.ARENA_SOLANA_RELAYER_KEY?.trim();
  if (!raw) return null;
  let bytes;
  try {
    if (raw.startsWith("[")) {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error();
      bytes = Uint8Array.from(arr);
    } else {
      bytes = bs58.decode(raw);
    }
  } catch {
    throw new Error("ARENA_SOLANA_RELAYER_KEY is neither a JSON byte array nor base58");
  }
  if (bytes.length !== 64) throw new Error("ARENA_SOLANA_RELAYER_KEY must be a 64-byte secret key");
  try {
    return Keypair.fromSecretKey(bytes); // checks the public half against the seed
  } catch {
    throw new Error("ARENA_SOLANA_RELAYER_KEY's public half doesn't match its secret half");
  }
}

/** Limits from the environment: ARENA_SOLANA_RELAYER_DAILY_SOL sets the daily budget. */
export function relayLimitsFromEnv(env = process.env) {
  const sol = env.ARENA_SOLANA_RELAYER_DAILY_SOL?.trim();
  if (!sol) return {};
  const v = Number(sol);
  if (!Number.isFinite(v) || v < 0) throw new Error("ARENA_SOLANA_RELAYER_DAILY_SOL must be a number of SOL");
  return { dailyBudgetLamports: Math.round(v * 1e9) };
}

/** Read a shortvec (compact-u16) at `at`: [value, bytes used]. */
function shortvec(buf, at) {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    if (at + i >= buf.length) throw refuse("the transaction is truncated");
    const b = buf[at + i];
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return [value, i + 1];
  }
  throw refuse("the transaction's signature count is malformed");
}

const sameKeys = (a, b) =>
  a.length === b.length && a.every((k, i) => k.pubkey.equals(b[i].pubkey) && k.isSigner === b[i].isSigner && k.isWritable === b[i].isWritable);

/**
 * p: { connection (@solana/web3.js Connection, or the same methods), relayer (Keypair),
 *      store (see relay-store.js; required), limits?, now? () => unix seconds, log?, programId? }
 * -> { info({ ip }), submit({ tx, ip }), handler(req, res), feePayer, limits, spentToday(), inFlight() }
 */
export function createSolanaRelay({ connection, relayer, store, limits = {}, now = () => Math.floor(Date.now() / 1000), log, programId = ARENA_PROGRAM_ID }) {
  if (!connection) throw new Error("createSolanaRelay needs a connection");
  if (!relayer?.publicKey || !relayer?.secretKey) throw new Error("createSolanaRelay needs the relayer's Keypair");
  if (!store) throw new Error("createSolanaRelay needs a rate-limit store (relay-store.js): it never runs without one");
  const L = { ...SOLANA_RELAY_LIMITS, ...limits };
  const program = new PublicKey(programId);
  const feePayer = new PublicKey(relayer.publicKey.toBytes());
  // Only a private KeyObject is kept: it prints and serializes as nothing.
  const signingKey = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(relayer.secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
  let inFlight = 0;
  const rentCache = new Map();

  // ---------------------------------------------------------------- the store, failing closed

  const storeDown = (err) => {
    log?.(`rate-limit store unavailable, refusing: ${brief(err)}`);
    return new SolanaRelayError(503, "the relayer's rate-limit store is unavailable, so it is refusing to sign; try again shortly");
  };
  const S = {
    async hit(key, windowSec, by = 1) {
      let n;
      try { n = await store.hit(key, windowSec, by); } catch (err) { throw storeDown(err); }
      if (typeof n !== "number" || !Number.isSafeInteger(n) || (by > 0 && n < by)) throw storeDown(new Error("non-count from hit"));
      return n;
    },
    async peek(key, windowSec) {
      let n;
      try { n = await store.peek(key, windowSec); } catch (err) { throw storeDown(err); }
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw storeDown(new Error("non-count from peek"));
      return n;
    },
    async claim(key, ttl) {
      let r;
      try { r = await store.claim(key, ttl); } catch (err) { throw storeDown(err); }
      if (typeof r !== "boolean") throw storeDown(new Error("non-boolean from claim"));
      return r;
    },
    async has(key) {
      let r;
      try { r = await store.has(key); } catch (err) { throw storeDown(err); }
      if (typeof r !== "boolean") throw storeDown(new Error("non-boolean from has"));
      return r;
    },
  };

  const dayKey = () => `lamports:${Math.floor(now() / DAY)}`;
  const spentToday = () => S.peek(dayKey(), DAY);

  async function limit(key, max, message, windowSec = HOUR) {
    if ((await S.hit(key, windowSec)) > max) throw new SolanaRelayError(429, message);
  }

  /** Requests per IP, refused-request lockouts, and failure counting, as callbook-relay.js's guarded(). */
  async function guarded(ip, fn) {
    const bucket = ip ? ipBucket(ip) : null;
    if (bucket) {
      await limit(`ip:${bucket}`, L.requestsPerIpHour, "too many requests from this address; try again later");
      if ((await S.peek(`fail:ip:${bucket}`, HOUR)) >= L.failuresPerIpHour) throw new SolanaRelayError(429, "too many refused requests from this address; try again later");
    }
    let account = null;
    try {
      return await fn({ bucket, verified: async (who) => {
        account = who;
        if ((await S.peek(`fail:acct:${who}`, HOUR)) >= L.failuresPerAccountHour) throw new SolanaRelayError(429, "too many refused requests for this account; try again later");
      } });
    } catch (err) {
      if (err instanceof SolanaRelayError && err.status !== 202 && err.status !== 503) {
        try {
          if (bucket) await store.hit(`fail:ip:${bucket}`, HOUR);
          if (account) await store.hit(`fail:acct:${account}`, HOUR);
        } catch { /* the refusal stands either way */ }
      }
      throw err;
    }
  }

  async function rentFor(size) {
    if (!rentCache.has(size)) {
      const v = await connection.getMinimumBalanceForRentExemption(size);
      if (!Number.isSafeInteger(v) || v < 0) throw new SolanaRelayError(502, "the RPC answered an odd rent figure");
      rentCache.set(size, v);
    }
    return rentCache.get(size);
  }
  async function exists(key) {
    return (await connection.getAccountInfo(key, "confirmed")) !== null;
  }
  async function arenaAccount(key, type) {
    const info = await connection.getAccountInfo(key, "confirmed");
    if (!info || !new PublicKey(info.owner).equals(program)) return null;
    const a = decodeAccount(info.data);
    return a?.type === type ? a : null;
  }

  // ---------------------------------------------------------------- parsing (local, no RPC)

  /** The wire bytes, checked: { raw, message, messageBytes, userSig, user, ix: { name, data, keys } }. */
  function parse(tx) {
    if (typeof tx !== "string" || !tx || tx.length > Math.ceil(MAX_TX_BYTES / 3) * 4 + 4 || !BASE64.test(tx)) {
      if (typeof tx === "string" && BASE64.test(tx)) throw refuse(`a transaction is at most ${MAX_TX_BYTES} bytes`);
      throw refuse("tx must be the serialized transaction in base64");
    }
    const raw = Buffer.from(tx, "base64");
    if (raw.length > MAX_TX_BYTES) throw refuse(`a transaction is at most ${MAX_TX_BYTES} bytes`);
    const [nSigs, used] = shortvec(raw, 0);
    const msgAt = used + 64 * nSigs;
    if (msgAt >= raw.length) throw refuse("the transaction is truncated");
    const messageBytes = raw.subarray(msgAt);
    if (messageBytes[0] & 0x80) throw refuse("only legacy transactions are relayed (no versioned messages or lookup tables)");
    let message;
    try {
      message = Message.from(messageBytes);
    } catch {
      throw refuse("the transaction's message doesn't decode");
    }
    if (!Buffer.from(message.serialize()).equals(messageBytes)) throw refuse("the transaction isn't in canonical form");

    const { header, accountKeys } = message;
    if (header.numRequiredSignatures !== 2 || nSigs !== 2) throw refuse("exactly two signers: the relayer as fee payer, and you");
    if (!accountKeys[0].equals(feePayer)) throw refuse(`the fee payer must be the relayer (${feePayer.toBase58()})`);
    const user = accountKeys[1];
    if (user.equals(feePayer)) throw refuse("the relayer can't sign for you");
    if (new Set(accountKeys.map((k) => k.toBase58())).size !== accountKeys.length) throw refuse("the message lists an account twice");

    const relayerSig = raw.subarray(used, used + 64);
    if (!relayerSig.every((b) => b === 0)) throw refuse("leave the fee payer's signature slot empty: the relayer signs last");
    const userSig = Buffer.from(raw.subarray(used + 64, used + 128));
    if (userSig.every((b) => b === 0)) throw new SolanaRelayError(401, "the transaction is missing your signature");
    if (!edVerify(null, messageBytes, pubKeyObject(user), userSig)) throw new SolanaRelayError(401, "your signature doesn't verify over this transaction");

    const ixs = message.compiledInstructions;
    if (ixs.length !== 1) throw refuse("one instruction per transaction, and only an Arena one");
    const [cix] = ixs;
    const programKey = accountKeys[cix.programIdIndex];
    if (!programKey.equals(program)) throw refuse("only Arena program instructions are relayed");
    if (message.isAccountWritable(cix.programIdIndex) || cix.programIdIndex < header.numRequiredSignatures) throw refuse("the program account is misflagged");
    const data = Buffer.from(cix.data);
    const name = data.length >= 8 ? INSTRUCTIONS[data.subarray(0, 8).toString("hex")] : undefined;
    if (!name || name === "write_score" || !DISC_BY_NAME[name]) throw refuse("only lock, reveal or set_profile is relayed");
    const keys = cix.accountKeyIndexes.map((i) => {
      if (i >= accountKeys.length) throw refuse("an instruction names an account the message lacks");
      return { pubkey: accountKeys[i], isSigner: message.isAccountSigner(i), isWritable: message.isAccountWritable(i) };
    });
    // Nothing in the message beyond the fee payer, the program and the instruction's accounts.
    const named = new Set([feePayer.toBase58(), program.toBase58(), ...keys.map((k) => k.pubkey.toBase58())]);
    if (named.size !== accountKeys.length || accountKeys.some((k) => !named.has(k.toBase58()))) throw refuse("the message lists accounts the instruction doesn't use");
    return { raw, message, messageBytes, sigAt: used, userSig, user, ix: { name, data, keys } };
  }

  /** The instruction's arguments decoded and the instruction rebuilt by the codec: it must match exactly. */
  function expect(rebuilt, ix) {
    if (!rebuilt.programId.equals(program)) throw refuse("wrong program");
    if (!Buffer.from(rebuilt.data).equals(ix.data)) throw refuse("the instruction's data isn't in the form solana/arena.js builds");
    if (!sameKeys(rebuilt.keys, ix.keys)) throw refuse("the instruction's accounts aren't the ones solana/arena.js builds with you as owner and the relayer as payer");
  }

  function decodeStrings(data, at, caps) {
    const out = [];
    for (const cap of caps) {
      if (at + 4 > data.length) throw refuse("the instruction's data is truncated");
      const n = data.readUInt32LE(at);
      at += 4;
      if (n > cap || at + n > data.length) throw refuse("a text field is too long");
      out.push(data.subarray(at, at + n).toString("utf8"));
      at += n;
    }
    return [out, at];
  }

  // ---------------------------------------------------------------- per instruction (reads the chain)

  /** -> { kind, account (the user), lamports (rent), limits: [[key, max, message, window]] , extra } */
  async function plan({ ix, user }, bucket) {
    const d = ix.data;
    if (ix.name === "lock") {
      if (d.length !== 8 + 8 + 32 + 4) throw refuse("a lock's data is 52 bytes");
      const callId = d.readBigUInt64LE(8);
      const hash = Buffer.from(d.subarray(16, 48));
      const horizon = d.readUInt32LE(48);
      if (hash.every((b) => b === 0)) throw refuse("the call hash is empty");
      if (horizon < MIN_HORIZON || horizon > MAX_HORIZON || horizon % TIME_UNIT !== 0) throw refuse("horizon must be whole minutes, 5 minutes to 30 days");
      expect(lockIx({ owner: user, payer: feePayer, callId, callHash: hash, horizon, programId: program }), ix);
      const opensBook = !(await exists(bookAddress(user, program)));
      const lamports = (await rentFor(ACCOUNT_SIZES.Call)) + (opensBook ? await rentFor(ACCOUNT_SIZES.Book) : 0);
      const lim = [[`lock:${user.toBase58()}`, L.locksPerAccountHour, `this account has locked ${L.locksPerAccountHour} calls in the last hour; try again later`, HOUR]];
      if (opensBook && bucket) lim.push([`newbook:ip:${bucket}`, L.newBooksPerIpDay, `this address has opened ${L.newBooksPerIpDay} new books today; try again tomorrow`, DAY]);
      return { kind: "lock", lamports, lim, extra: { callId: callId.toString(), opensBook } };
    }
    if (ix.name === "reveal") {
      const [[coin], at] = decodeStrings(d, 8, [MAX_COIN_BYTES]);
      if (at + 1 + 32 !== d.length) throw refuse("a reveal's data is coin, side and a 32-byte salt");
      const side = d.readInt8(at);
      const salt = Buffer.from(d.subarray(at + 1, at + 33));
      if (!coin || (side !== 1 && side !== -1)) throw refuse("a reveal names a coin, and a side of 1 or -1");
      if (ix.keys.length !== 3) throw refuse("a reveal has three accounts");
      const call = await arenaAccount(ix.keys[2].pubkey, "Call");
      if (!call) throw refuse("no such call");
      const book = await arenaAccount(call.book, "Book");
      if (!book) throw refuse("no such book");
      expect(revealIx({ revealer: user, owner: book.owner, callId: call.callId, coin, side, salt, programId: program }), ix);
      if (call.revealed) throw refuse("that call is already revealed");
      const expected = callHash({ programId: program, book: call.book, callId: call.callId, horizon: call.horizon, coin, side, salt });
      if (!expected.equals(call.callHash)) throw refuse("the preimage doesn't match the locked call hash");
      return {
        kind: "reveal", lamports: 0,
        lim: [[`reveal:${user.toBase58()}`, L.revealsPerAccountHour, `this account has revealed ${L.revealsPerAccountHour} calls in the last hour; try again later`, HOUR]],
        extra: { book: call.book.toBase58(), callId: String(call.callId) },
      };
    }
    // set_profile
    const [[name, bio, link], at] = decodeStrings(d, 8, [MAX_NAME_BYTES, MAX_BIO_BYTES, MAX_LINK_BYTES]);
    if (at !== d.length) throw refuse("a profile's data is name, bio and link");
    expect(setProfileIx({ owner: user, payer: feePayer, name, bio, link, programId: program }), ix);
    const checked = checkProfile({ name, bio, link });
    if (!checked.ok) throw refuse(checked.error);
    const p = checked.profile;
    if (p.name !== name || p.bio !== bio || p.link !== link) throw refuse("send the profile as the name rules clean it (arena-names.js checkProfile), and sign that");
    // A name shows only beside a record, so we don't pay to name an account that has none.
    if (!(await exists(bookAddress(user, program)))) throw refuse("lock your first call before picking a name: a name shows beside your records");
    const first = !(await exists(profileAddress(user, program)));
    return {
      kind: "set_profile", lamports: first ? await rentFor(ACCOUNT_SIZES.Profile) : 0,
      lim: [[`profile:${user.toBase58()}`, L.profilesPerAccountDay, `this account has changed its profile ${L.profilesPerAccountDay} times today; try again tomorrow`, DAY]],
      extra: {},
    };
  }

  // ---------------------------------------------------------------- the API

  /** GET: the fee payer and a recent blockhash to build against. */
  async function info({ ip } = {}) {
    const bucket = ip ? ipBucket(ip) : null;
    if (bucket) await limit(`info:ip:${bucket}`, L.infoPerIpHour, "too many requests from this address; try again later");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    return { feePayer: feePayer.toBase58(), blockhash, lastValidBlockHeight, programId: program.toBase58(), lamportsPerSignature: LAMPORTS_PER_SIGNATURE };
  }

  /** POST: { tx: base64, ip } -> { signature, kind, owner, lamports, ... } */
  async function submit({ tx, ip } = {}) {
    if (inFlight >= L.maxInFlight) throw new SolanaRelayError(503, "the relayer is busy; try again in a minute");
    inFlight++;
    try {
      return await guarded(ip, async (ctx) => {
        const parsed = parse(tx);
        const owner = parsed.user.toBase58();
        await ctx.verified(owner); // the user's signature checked out: failures may count against it now
        const dedupe = `sent:${bs58.encode(parsed.userSig)}`;
        const ourSig = () => edSign(null, parsed.messageBytes, signingKey);
        const already = () => new SolanaRelayError(409, "this transaction was already submitted; it is sent at most once", { signature: bs58.encode(ourSig()) });
        if (await S.has(dedupe)) throw already();

        const bh = await connection.isBlockhashValid(parsed.message.recentBlockhash, { commitment: "processed" });
        if (bh?.value !== true) throw refuse("the blockhash is stale: fetch a fresh one from the relay and sign again");

        const p = await plan(parsed, ctx.bucket);
        const fee = LAMPORTS_PER_SIGNATURE * parsed.message.header.numRequiredSignatures;
        const cost = fee + p.lamports;

        // Simulate with the relayer's slot still blank: nothing it signed leaves before the send.
        let sim;
        try {
          sim = await connection.simulateTransaction(VersionedTransaction.deserialize(parsed.raw), { sigVerify: false, commitment: "processed" });
        } catch (err) {
          throw new SolanaRelayError(502, `the simulation couldn't run: ${brief(err)}`);
        }
        if (sim?.value?.err) throw new SolanaRelayError(422, `refused by the program in simulation: ${brief(JSON.stringify(sim.value.err))}`, { simulated: false });

        for (const [key, max, msg, win] of p.lim) await limit(key, max, msg, win);
        if (ctx.bucket) await limit(`send:ip:${ctx.bucket}`, L.sendsPerIpHour, `this address has had ${L.sendsPerIpHour} transactions relayed in the last hour; try again later`);
        await limit("global", L.txPerHour, "the relayer is busy; try again in a few minutes");

        // Reserve the cost atomically; give it back if this request goes no further.
        const day = dayKey();
        let reserved = false;
        const refund = async () => { if (reserved) { reserved = false; try { await store.hit(day, DAY, -cost); } catch { /* over-counting is the safe side */ } } };
        try {
          const total = await S.hit(day, DAY, cost);
          reserved = true;
          if (total > L.dailyBudgetLamports) throw new SolanaRelayError(503, "the relayer's budget for today is used up; try again tomorrow (UTC)");
          if (!(await S.claim(dedupe, L.dedupeTtlSec))) throw already();
        } catch (err) {
          await refund();
          throw err;
        }

        // Claimed: from here on this transaction is never sent again, whatever happens.
        const sig = ourSig();
        const wire = Buffer.from(parsed.raw);
        sig.copy(wire, parsed.sigAt);
        const signature = bs58.encode(sig);
        try {
          await connection.sendRawTransaction(wire, { skipPreflight: false, maxRetries: 0, preflightCommitment: "processed" });
        } catch (err) {
          throw new SolanaRelayError(502, `the RPC refused the transaction: ${brief(err)}`, { signature, sent: false });
        }
        log?.(`${p.kind} ${signature} for ${owner} (${cost} lamports)`);
        const out = { signature, kind: p.kind, owner, lamports: cost, ...p.extra };
        if (L.confirmTimeoutMs > 0) {
          let timer;
          const result = await Promise.race([
            connection.confirmTransaction(signature, "confirmed").then((r) => r, () => null),
            new Promise((r) => { timer = setTimeout(() => r(null), L.confirmTimeoutMs); }),
          ]).finally(() => clearTimeout(timer));
          if (!result) throw new SolanaRelayError(202, "sent; the confirmation isn't in yet, so read the outcome from the chain", { ...out, pending: true });
          if (result.value?.err) throw new SolanaRelayError(502, `the transaction failed on chain (${signature})`, { signature });
          out.confirmed = true;
        }
        return out;
      });
    } finally {
      inFlight--;
    }
  }

  /** Express-style: GET -> info, POST { tx } -> submit. Errors are { error, ...extra } with their status. */
  async function handler(req, res) {
    res.set?.("cache-control", "no-store");
    try {
      if (req.method === "GET") return res.json(await info({ ip: req.ip }));
      if (req.method === "POST") return res.json(await submit({ tx: req.body?.tx, ip: req.ip }));
      return res.status(405).json({ error: "GET for the fee payer and a blockhash; POST { tx } to relay" });
    } catch (err) {
      if (err instanceof SolanaRelayError) return res.status(err.status).json({ error: err.message, ...err.extra });
      log?.(`relay error: ${brief(err)}`);
      return res.status(502).json({ error: `the relayer couldn't complete that: ${brief(err)}` });
    }
  }

  return { info, submit, handler, feePayer: feePayer.toBase58(), limits: L, spentToday, inFlight: () => inFlight };
}
