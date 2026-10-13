/**
 * The Arena program on Solana, from JavaScript: addresses, the call hash,
 * instructions, and decoders for its accounts and events. Shared by the SDK,
 * the relay, the chain reader and the tests, so they all encode alike.
 *
 * Encoding is Anchor's: an instruction is sha256("global:<name>")[..8] then
 * its borsh arguments; an account starts with sha256("account:<Name>")[..8];
 * an event is logged as "Program data: <base64>" starting with
 * sha256("event:<Name>")[..8]. See programs/arena/src/lib.rs.
 */
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const ARENA_PROGRAM_ID = new PublicKey("BderjFgzJGQ6NsqNfbVmtHDhzjHP6B3ijPMGCrmNffqw");

export const SEAL_LEAD = 60;
export const GRACE = 7 * 86_400;
export const TIME_UNIT = 60;
export const MIN_HORIZON = 5 * 60;
export const MAX_HORIZON = 30 * 86_400;
export const MAX_COIN_BYTES = 16;
export const MAX_NAME_BYTES = 32;
export const MAX_BIO_BYTES = 160;
export const MAX_LINK_BYTES = 100;
export const SCORING_VERSION = "arena-v1";

/** "arena.call.v1", zero padded to 16 bytes: the first field of every call hash. */
export const CALL_TAG = Buffer.concat([Buffer.from("arena.call.v1"), Buffer.alloc(3)]);

const sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const disc = (kind, name) => sha256(`${kind}:${name}`).subarray(0, 8);

// ------------------------------------------------------------------ addresses

const pk = (k) => (k instanceof PublicKey ? k : new PublicKey(k));
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export function bookAddress(owner, programId = ARENA_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("book"), pk(owner).toBuffer()], programId)[0];
}
export function callAddress(book, callId, programId = ARENA_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("call"), pk(book).toBuffer(), u64le(callId)], programId)[0];
}
export function profileAddress(owner, programId = ARENA_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("profile"), pk(owner).toBuffer()], programId)[0];
}
export function scoreAddress(validator, book, programId = ARENA_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("score"), pk(validator).toBuffer(), pk(book).toBuffer()], programId)[0];
}

// ------------------------------------------------------------------ the call hash

/** A 32-byte salt from hex (0x optional) or bytes. */
export function saltBytes(salt) {
  const b = typeof salt === "string" ? Buffer.from(salt.replace(/^0x/, ""), "hex") : Buffer.from(salt);
  if (b.length !== 32) throw new Error("A salt is 32 bytes.");
  return b;
}

export function coinBytes(coin) {
  const b = Buffer.from(String(coin), "utf8");
  if (b.length < 1 || b.length > MAX_COIN_BYTES) throw new Error(`A coin is 1 to ${MAX_COIN_BYTES} bytes.`);
  return b;
}

/**
 * arena::call_hash: sha256 over a fixed 142-byte layout (tag, program, book,
 * call id u64 LE, horizon u32 LE, coin length, coin padded to 16, side i8, salt).
 * Returns a Buffer.
 */
export function callHash({ programId = ARENA_PROGRAM_ID, book, callId, horizon, coin, side, salt }) {
  if (side !== 1 && side !== -1) throw new Error("A side is 1 (long) or -1 (short).");
  const c = coinBytes(coin);
  const padded = Buffer.alloc(MAX_COIN_BYTES);
  c.copy(padded);
  const h = Buffer.alloc(4);
  h.writeUInt32LE(Number(horizon));
  return sha256(
    CALL_TAG, pk(programId).toBuffer(), pk(book).toBuffer(), u64le(callId), h,
    Buffer.from([c.length]), padded, Buffer.from([side & 0xff]), saltBytes(salt),
  );
}

// ------------------------------------------------------------------ borsh

class Writer {
  constructor() { this.parts = []; }
  u8(n) { this.parts.push(Buffer.from([n & 0xff])); return this; }
  i8(n) { const b = Buffer.alloc(1); b.writeInt8(n); this.parts.push(b); return this; }
  u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n)); this.parts.push(b); return this; }
  u64(n) { this.parts.push(u64le(n)); return this; }
  bytes(b) { this.parts.push(Buffer.from(b)); return this; }
  string(s) { const b = Buffer.from(String(s), "utf8"); this.u32(b.length); this.parts.push(b); return this; }
  done() { return Buffer.concat(this.parts); }
}

class Reader {
  constructor(buf, at = 0) { this.b = Buffer.from(buf); this.at = at; }
  u8() { return this.b.readUInt8(this.at++); }
  i8() { return this.b.readInt8(this.at++); }
  bool() { return this.u8() !== 0; }
  u32() { const v = this.b.readUInt32LE(this.at); this.at += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.at); this.at += 8; return v; }
  i64() { const v = this.b.readBigInt64LE(this.at); this.at += 8; return v; }
  bytes(n) { const v = this.b.subarray(this.at, this.at + n); this.at += n; return Buffer.from(v); }
  key() { return new PublicKey(this.bytes(32)); }
  string() { const n = this.u32(); return this.bytes(n).toString("utf8"); }
}

const num = (big) => Number(big); // unix seconds and call ids fit in a double

// ------------------------------------------------------------------ instructions

const ix = (name, keys, data, programId) =>
  new TransactionInstruction({ programId, keys, data: Buffer.concat([disc("global", name), data]) });
const signer = (pubkey, writable = false) => ({ pubkey: pk(pubkey), isSigner: true, isWritable: writable });
const acct = (pubkey, writable = false) => ({ pubkey: pk(pubkey), isSigner: false, isWritable: writable });

/** Lock a call. `payer` pays fee and rent (the owner, or a relayer). */
export function lockIx({ owner, payer = owner, callId, callHash: hash, horizon, programId = ARENA_PROGRAM_ID }) {
  const book = bookAddress(owner, programId);
  return ix("lock", [
    signer(owner), signer(payer, true), acct(book, true), acct(callAddress(book, callId, programId), true),
    acct(SystemProgram.programId),
  ], new Writer().u64(callId).bytes(hash).u32(horizon).done(), programId);
}

/** Reveal a call in `owner`'s book. Anyone may sign as revealer. */
export function revealIx({ revealer, owner, callId, coin, side, salt, programId = ARENA_PROGRAM_ID }) {
  const book = bookAddress(owner, programId);
  return ix("reveal", [signer(revealer), acct(book), acct(callAddress(book, callId, programId), true)],
    new Writer().string(coin).i8(side).bytes(saltBytes(salt)).done(), programId);
}

export function setProfileIx({ owner, payer = owner, name = "", bio = "", link = "", programId = ARENA_PROGRAM_ID }) {
  return ix("set_profile", [signer(owner), signer(payer, true), acct(profileAddress(owner, programId), true), acct(SystemProgram.programId)],
    new Writer().string(name).string(bio).string(link).done(), programId);
}

/** The scoring version as 16 zero-padded bytes. */
export const scoringBytes = (v = SCORING_VERSION) => {
  const b = Buffer.alloc(16);
  Buffer.from(v).copy(b);
  return b;
};

export function writeScoreIx({ validator, payer = validator, owner, score, calls, revealed, withheld, throughCall, reportHash, scoring = SCORING_VERSION, programId = ARENA_PROGRAM_ID }) {
  const book = bookAddress(owner, programId);
  return ix("write_score", [
    signer(validator), signer(payer, true), acct(book), acct(scoreAddress(validator, book, programId), true), acct(SystemProgram.programId),
  ], new Writer().u8(score).u32(calls).u32(revealed).u32(withheld).u64(throughCall).bytes(reportHash).bytes(scoringBytes(scoring)).done(), programId);
}

/** The instruction names this program has, by discriminator (hex): the relay allows only these. */
export const INSTRUCTIONS = Object.fromEntries(["lock", "reveal", "set_profile", "write_score"].map((n) => [disc("global", n).toString("hex"), n]));

// ------------------------------------------------------------------ accounts

const ACCOUNTS = {
  Book: (r) => ({ version: r.u8(), bump: r.u8(), owner: r.key(), lockCount: num(r.u64()), openedAt: num(r.i64()) }),
  Call: (r) => {
    const c = {
      bump: r.u8(), book: r.key(), callId: num(r.u64()), callHash: r.bytes(32), lockedAt: num(r.i64()), entryAt: num(r.i64()),
      horizon: r.u32(), revealed: r.bool(), side: r.i8(),
    };
    const len = r.u8();
    c.coin = c.revealed ? r.bytes(MAX_COIN_BYTES).subarray(0, len).toString("utf8") : (r.bytes(MAX_COIN_BYTES), null);
    c.revealedAt = num(r.i64());
    return c;
  },
  Profile: (r) => ({ version: r.u8(), bump: r.u8(), owner: r.key(), name: r.string(), bio: r.string(), link: r.string(), updatedAt: num(r.i64()) }),
  Score: (r) => ({
    version: r.u8(), bump: r.u8(), validator: r.key(), book: r.key(), owner: r.key(), score: r.u8(), calls: r.u32(), revealed: r.u32(),
    withheld: r.u32(), throughCall: num(r.u64()), scoredAt: num(r.i64()), reportHash: r.bytes(32), scoring: r.bytes(16).toString("utf8").replace(/\0+$/, ""),
  }),
};
const ACCOUNT_BY_DISC = Object.fromEntries(Object.keys(ACCOUNTS).map((n) => [disc("account", n).toString("hex"), n]));

/** { type, ...fields } for an Arena account's data, or null if it isn't one. */
export function decodeAccount(data) {
  const b = Buffer.from(data);
  const type = ACCOUNT_BY_DISC[b.subarray(0, 8).toString("hex")];
  if (!type) return null;
  return { type, ...ACCOUNTS[type](new Reader(b, 8)) };
}
export const accountDiscriminator = (name) => disc("account", name);

// ------------------------------------------------------------------ events

const EVENTS = {
  BookOpened: (r) => ({ book: r.key(), owner: r.key(), openedAt: num(r.i64()) }),
  Locked: (r) => ({ book: r.key(), owner: r.key(), callId: num(r.u64()), callHash: r.bytes(32), lockedAt: num(r.i64()), entryAt: num(r.i64()), horizon: r.u32() }),
  Revealed: (r) => ({ book: r.key(), owner: r.key(), callId: num(r.u64()), coin: r.string(), side: r.i8(), horizon: r.u32(), salt: r.bytes(32), revealedAt: num(r.i64()) }),
  ProfileSet: (r) => ({ owner: r.key(), profileName: r.string(), bio: r.string(), link: r.string(), updatedAt: num(r.i64()) }),
  ScoreWritten: (r) => ({
    validator: r.key(), book: r.key(), owner: r.key(), score: r.u8(), calls: r.u32(), revealed: r.u32(), withheld: r.u32(),
    throughCall: num(r.u64()), scoredAt: num(r.i64()), reportHash: r.bytes(32), scoring: r.bytes(16).toString("utf8").replace(/\0+$/, ""),
  }),
};
const EVENT_BY_DISC = Object.fromEntries(Object.keys(EVENTS).map((n) => [disc("event", n).toString("hex"), n]));

/**
 * { name, ...fields } for one event's bytes, or null if it isn't an Arena event.
 * `name` is the event's type; ProfileSet's profile name is `profileName`.
 */
export function decodeEvent(data) {
  const b = Buffer.from(data);
  const name = EVENT_BY_DISC[b.subarray(0, 8).toString("hex")];
  if (!name) return null;
  try {
    return { name, ...EVENTS[name](new Reader(b, 8)) };
  } catch {
    return null; // truncated or not ours after all
  }
}

/**
 * Arena events from a transaction's log lines. Only "Program data:" lines
 * logged while the Arena program itself is executing count, so another
 * program can't forge one by logging the same bytes.
 */
export function eventsFromLogs(logs, programId = ARENA_PROGRAM_ID) {
  const id = pk(programId).toBase58();
  const stack = [];
  const out = [];
  for (const line of logs ?? []) {
    let m;
    if ((m = /^Program (\w+) invoke \[\d+\]$/.exec(line))) stack.push(m[1]);
    else if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
    else if ((m = /^Program data: (.+)$/.exec(line)) && stack[stack.length - 1] === id) {
      const e = decodeEvent(Buffer.from(m[1], "base64"));
      if (e) out.push(e);
    }
  }
  return out;
}

// ------------------------------------------------------------------ confirming without websockets

/**
 * Wait for a transaction by polling getSignatureStatuses over HTTP, until it
 * is confirmed (resolves) or fails or its blockhash expires (throws).
 * web3.js's confirmTransaction listens on a websocket, which a proxied
 * network (and some RPC providers) can't open: polling works everywhere.
 */
export async function confirmByPolling(connection, signature, lastValidBlockHeight, { everyMs = 500, commitment = "confirmed" } = {}) {
  const done = commitment === "finalized" ? ["finalized"] : ["confirmed", "finalized"];
  for (let i = 0; ; i++) {
    const { value: [s] } = await connection.getSignatureStatuses([signature]);
    if (s?.err) throw Object.assign(new Error(`transaction ${signature} failed: ${JSON.stringify(s.err)}`), { signature, err: s.err });
    if (s && done.includes(s.confirmationStatus)) return s;
    if (lastValidBlockHeight != null && i % 4 === 3 && (await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      const { value: [late] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      if (late && !late.err && done.includes(late.confirmationStatus)) return late;
      throw Object.assign(new Error(`transaction ${signature} expired before it was confirmed`), { signature, expired: true });
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Sign (if signers are given), send and confirm a legacy transaction, by polling. Returns the signature. */
export async function sendAndConfirmByPolling(connection, tx, signers = []) {
  if (!tx.recentBlockhash) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
  }
  if (signers.length) {
    tx.feePayer ??= signers[0].publicKey;
    tx.sign(...signers);
  }
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await confirmByPolling(connection, signature, tx.lastValidBlockHeight);
  return signature;
}
