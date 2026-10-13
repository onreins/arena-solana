// The Solana gasless relay (solana/relay.js): it co-signs as fee payer only
// Arena lock / reveal / set_profile transactions signed by one plain user
// key, sends each at most once, and refuses when its limits or its store
// can't vouch for the spend. Real keypairs and real serialization; a mock
// connection stands in for the RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicKey, verify as edVerify } from "node:crypto";
import bs58 from "bs58";
import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram,
  VersionedTransaction, TransactionMessage,
} from "@solana/web3.js";

import {
  ARENA_PROGRAM_ID, lockIx, revealIx, setProfileIx, writeScoreIx, bookAddress, callAddress, profileAddress,
  callHash, accountDiscriminator,
} from "../arena.js";
import {
  createSolanaRelay, SolanaRelayError, SOLANA_RELAY_LIMITS, ACCOUNT_SIZES, LAMPORTS_PER_SIGNATURE,
  relayerKeyFromEnv, relayLimitsFromEnv,
} from "../relay.js";
import { memoryRelayStore, restRelayStore, relayStoreFromEnv } from "../relay-store.js";

const BLOCKHASH = bs58.encode(Buffer.alloc(32, 7));
const rent = (size) => (size + 128) * 6960;
const T0 = 1_800_000_000;

// ------------------------------------------------------------------ helpers

function mockConnection({ accounts = new Map(), valid = true, simulateErr = null, sendErr = null } = {}) {
  const c = {
    accounts, valid, simulateErr, sendErr, sent: [], simulated: 0, calls: { getAccountInfo: 0 },
    async getLatestBlockhash() { return { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 }; },
    async isBlockhashValid(h) { return { context: { slot: 1 }, value: c.valid && h === BLOCKHASH }; },
    async getAccountInfo(key) { c.calls.getAccountInfo++; return c.accounts.get(new PublicKey(key).toBase58()) ?? null; },
    async getMinimumBalanceForRentExemption(size) { return rent(size); },
    async simulateTransaction(vtx, opts) {
      c.simulated++;
      assert.ok(vtx instanceof VersionedTransaction, "simulated as a VersionedTransaction");
      assert.equal(opts?.sigVerify, false);
      // The relayer's signature slot is blank in a simulation: nothing signed by it leaves before the send.
      assert.ok(vtx.signatures[0].every((b) => b === 0), "relayer slot is blank when simulating");
      return { context: { slot: 1 }, value: { err: c.simulateErr, logs: [] } };
    },
    async sendRawTransaction(wire, opts) {
      assert.deepEqual({ skipPreflight: opts.skipPreflight, maxRetries: opts.maxRetries }, { skipPreflight: false, maxRetries: 0 });
      if (c.sendErr) throw c.sendErr;
      c.sent.push(Buffer.from(wire));
      const tx = Transaction.from(wire);
      return bs58.encode(tx.signatures[0].signature);
    },
  };
  return c;
}

const encBook = (owner, lockCount = 1) => {
  const b = Buffer.alloc(8 + 50);
  accountDiscriminator("Book").copy(b, 0);
  b[8] = 1; b[9] = 255; new PublicKey(owner).toBuffer().copy(b, 10);
  b.writeBigUInt64LE(BigInt(lockCount), 42); b.writeBigInt64LE(BigInt(T0), 50);
  return { data: b, owner: ARENA_PROGRAM_ID, lamports: rent(58), executable: false };
};
const encCall = (book, callId, hash, { revealed = false, horizon = 600 } = {}) => {
  const b = Buffer.alloc(8 + 120);
  let o = 0;
  accountDiscriminator("Call").copy(b, o); o += 8;
  b[o++] = 254;
  new PublicKey(book).toBuffer().copy(b, o); o += 32;
  b.writeBigUInt64LE(BigInt(callId), o); o += 8;
  Buffer.from(hash).copy(b, o); o += 32;
  b.writeBigInt64LE(BigInt(T0 - 3600), o); o += 8;
  b.writeBigInt64LE(BigInt(T0 - 3540), o); o += 8;
  b.writeUInt32LE(horizon, o); o += 4;
  b[o++] = revealed ? 1 : 0;
  b[o++] = 0; b[o++] = 0; o += 16;
  b.writeBigInt64LE(0n, o);
  return { data: b, owner: ARENA_PROGRAM_ID, lamports: rent(128), executable: false };
};

/** A legacy tx, fee payer = `feePayer`, partially signed by `signers`, as base64. */
function txB64(ixs, { feePayer, signers = [], blockhash = BLOCKHASH } = {}) {
  const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight: 1000 });
  for (const i of [].concat(ixs)) tx.add(i);
  if (signers.length) tx.partialSign(...signers);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

function setup({ limits = {}, store, conn, now } = {}) {
  const relayer = Keypair.generate();
  const user = Keypair.generate();
  const clock = { t: T0 };
  const connection = conn ?? mockConnection();
  const relay = createSolanaRelay({ connection, relayer, store: store ?? memoryRelayStore({ now: now ?? (() => clock.t) }), limits, now: now ?? (() => clock.t) });
  const lock = (u = user, callId = 0, extra = {}) =>
    txB64(lockIx({ owner: u.publicKey, payer: relayer.publicKey, callId, callHash: Buffer.alloc(32, 9), horizon: 600 }), { feePayer: relayer.publicKey, signers: [u], ...extra });
  return { relayer, user, relay, connection, clock, lock };
}

const rejects = async (p, status, re) => {
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof SolanaRelayError, `a SolanaRelayError, got ${err}`);
    assert.equal(err.status, status, `status ${err.status} (${err.message})`);
    if (re) assert.match(err.message, re);
    return true;
  });
};

const edOk = (pub, msg, sig) =>
  edVerify(null, msg, createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.toBuffer()]), format: "der", type: "spki" }), sig);

// ------------------------------------------------------------------ the happy paths

test("info hands out the fee payer and a recent blockhash, never the key", async () => {
  const { relay, relayer } = setup();
  const info = await relay.info({ ip: "1.2.3.4" });
  assert.equal(info.feePayer, relayer.publicKey.toBase58());
  assert.equal(info.blockhash, BLOCKHASH);
  assert.equal(info.lastValidBlockHeight, 1000);
  assert.equal(info.programId, ARENA_PROGRAM_ID.toBase58());
  const text = JSON.stringify(info) + JSON.stringify(relay);
  assert.ok(!text.includes(bs58.encode(relayer.secretKey)));
  assert.ok(!text.includes(JSON.stringify(Array.from(relayer.secretKey)).slice(1, 40)));
  assert.equal(relay.relayer, undefined, "the keypair isn't exposed");
});

test("a valid first lock is co-signed, sent once, and charged fee + Call and Book rent", async () => {
  const { relay, relayer, user, connection, lock } = setup();
  const out = await relay.submit({ tx: lock(), ip: "1.2.3.4" });
  assert.equal(connection.sent.length, 1);
  const sent = Transaction.from(connection.sent[0]);
  assert.equal(out.signature, bs58.encode(sent.signatures[0].signature));
  assert.equal(out.kind, "lock");
  assert.equal(out.owner, user.publicKey.toBase58());
  assert.ok(sent.verifySignatures(), "both signatures verify");
  assert.ok(edOk(relayer.publicKey, sent.serializeMessage(), sent.signatures[0].signature));
  const cost = 2 * LAMPORTS_PER_SIGNATURE + rent(ACCOUNT_SIZES.Call) + rent(ACCOUNT_SIZES.Book);
  assert.equal(out.lamports, cost);
  assert.equal(await relay.spentToday(), cost);
});

test("a lock into an existing book pays no Book rent", async () => {
  const { relay, user, connection, lock } = setup();
  connection.accounts.set(bookAddress(user.publicKey).toBase58(), encBook(user.publicKey, 1));
  const out = await relay.submit({ tx: lock(user, 1), ip: "1.2.3.4" });
  assert.equal(out.lamports, 2 * LAMPORTS_PER_SIGNATURE + rent(ACCOUNT_SIZES.Call));
});

test("a valid reveal (the user signs as revealer) is co-signed and costs only the fee", async () => {
  const { relay, relayer, user, connection } = setup();
  const owner = Keypair.generate().publicKey; // reveals are permissionless: any book
  const book = bookAddress(owner);
  const salt = Buffer.alloc(32, 3);
  const hash = callHash({ book, callId: 4, horizon: 600, coin: "SOL", side: 1, salt });
  connection.accounts.set(book.toBase58(), encBook(owner, 5));
  connection.accounts.set(callAddress(book, 4).toBase58(), encCall(book, 4, hash));
  const tx = txB64(revealIx({ revealer: user.publicKey, owner, callId: 4, coin: "SOL", side: 1, salt }), { feePayer: relayer.publicKey, signers: [user] });
  const out = await relay.submit({ tx, ip: "1.2.3.4" });
  assert.equal(out.kind, "reveal");
  assert.equal(out.lamports, 2 * LAMPORTS_PER_SIGNATURE);
  assert.equal(connection.sent.length, 1);
});

test("a reveal with the wrong preimage or of a revealed call is refused before signing", async () => {
  const { relay, relayer, user, connection } = setup();
  const owner = Keypair.generate().publicKey;
  const book = bookAddress(owner);
  const salt = Buffer.alloc(32, 3);
  const hash = callHash({ book, callId: 0, horizon: 600, coin: "SOL", side: 1, salt });
  connection.accounts.set(book.toBase58(), encBook(owner, 1));
  connection.accounts.set(callAddress(book, 0).toBase58(), encCall(book, 0, hash));
  const wrong = txB64(revealIx({ revealer: user.publicKey, owner, callId: 0, coin: "SOL", side: -1, salt }), { feePayer: relayer.publicKey, signers: [user] });
  await rejects(relay.submit({ tx: wrong, ip: "1.2.3.4" }), 400, /preimage/);
  connection.accounts.set(callAddress(book, 0).toBase58(), encCall(book, 0, hash, { revealed: true }));
  const right = txB64(revealIx({ revealer: user.publicKey, owner, callId: 0, coin: "SOL", side: 1, salt }), { feePayer: relayer.publicKey, signers: [user] });
  await rejects(relay.submit({ tx: right, ip: "1.2.3.4" }), 400, /already revealed/);
  assert.equal(connection.sent.length, 0);
});

test("a valid set_profile is co-signed, charged Profile rent the first time", async () => {
  const { relay, relayer, user, connection } = setup();
  connection.accounts.set(bookAddress(user.publicKey).toBase58(), encBook(user.publicKey, 1));
  const tx = txB64(setProfileIx({ owner: user.publicKey, payer: relayer.publicKey, name: "Quant Fox", bio: "momentum", link: "https://example.com" }), { feePayer: relayer.publicKey, signers: [user] });
  const out = await relay.submit({ tx, ip: "1.2.3.4" });
  assert.equal(out.kind, "set_profile");
  assert.equal(out.lamports, 2 * LAMPORTS_PER_SIGNATURE + rent(ACCOUNT_SIZES.Profile));
  connection.accounts.set(profileAddress(user.publicKey).toBase58(), { data: Buffer.alloc(8 + 346), owner: ARENA_PROGRAM_ID, lamports: 1 });
  const tx2 = txB64(setProfileIx({ owner: user.publicKey, payer: relayer.publicKey, name: "Quant Fox II" }), { feePayer: relayer.publicKey, signers: [user] });
  assert.equal((await relay.submit({ tx: tx2, ip: "1.2.3.4" })).lamports, 2 * LAMPORTS_PER_SIGNATURE);
});

test("set_profile is refused without a book, or with a name the site would hide", async () => {
  const { relay, relayer, user, connection } = setup();
  const mk = (name) => txB64(setProfileIx({ owner: user.publicKey, payer: relayer.publicKey, name }), { feePayer: relayer.publicKey, signers: [user] });
  await rejects(relay.submit({ tx: mk("Quant Fox"), ip: "1.2.3.4" }), 400, /first call/);
  connection.accounts.set(bookAddress(user.publicKey).toBase58(), encBook(user.publicKey, 1));
  await rejects(relay.submit({ tx: mk("  Quant   Fox "), ip: "1.2.3.4" }), 400, /clean/);
  assert.equal(connection.sent.length, 0);
});

// ------------------------------------------------------------------ what it must never sign

test("a system transfer from the relayer is refused, alone or beside a lock", async () => {
  const { relay, relayer, user, connection } = setup();
  const transfer = SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: user.publicKey, lamports: 1e9 });
  await rejects(relay.submit({ tx: txB64(transfer, { feePayer: relayer.publicKey }), ip: "1.2.3.4" }), 400);
  const both = txB64([lockIx({ owner: user.publicKey, payer: relayer.publicKey, callId: 0, callHash: Buffer.alloc(32, 9), horizon: 600 }), transfer], { feePayer: relayer.publicKey, signers: [user] });
  await rejects(relay.submit({ tx: both, ip: "1.2.3.4" }), 400, /one instruction/);
  // A transfer the user signs (user pays) beside nothing else is still not Arena.
  const userTransfer = SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: relayer.publicKey, lamports: 1 });
  await rejects(relay.submit({ tx: txB64(userTransfer, { feePayer: relayer.publicKey, signers: [user] }), ip: "1.2.3.4" }), 400, /Arena/);
  assert.equal(connection.sent.length, 0);
});

test("an extra instruction (even a second lock or a memo) is refused", async () => {
  const { relay, relayer, user, connection } = setup();
  const l = (id) => lockIx({ owner: user.publicKey, payer: relayer.publicKey, callId: id, callHash: Buffer.alloc(32, 9), horizon: 600 });
  await rejects(relay.submit({ tx: txB64([l(0), l(1)], { feePayer: relayer.publicKey, signers: [user] }), ip: "1.2.3.4" }), 400, /one instruction/);
  const memo = new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from("hi") });
  await rejects(relay.submit({ tx: txB64([l(0), memo], { feePayer: relayer.publicKey, signers: [user] }), ip: "1.2.3.4" }), 400, /one instruction/);
  assert.equal(connection.sent.length, 0);
});

test("compute budget instructions are refused (fees stay exactly 5000 per signature)", async () => {
  const { relay, relayer, user } = setup();
  const l = lockIx({ owner: user.publicKey, payer: relayer.publicKey, callId: 0, callHash: Buffer.alloc(32, 9), horizon: 600 });
  const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 });
  await rejects(relay.submit({ tx: txB64([price, l], { feePayer: relayer.publicKey, signers: [user] }), ip: "1.2.3.4" }), 400);
});

test("the relayer as owner, or anywhere but payer, is refused", async () => {
  const { relay, relayer, user, connection } = setup();
  const asOwner = lockIx({ owner: relayer.publicKey, payer: relayer.publicKey, callId: 0, callHash: Buffer.alloc(32, 9), horizon: 600 });
  await rejects(relay.submit({ tx: txB64(asOwner, { feePayer: relayer.publicKey }), ip: "1.2.3.4" }), 400, /signers/);
  const swapped = lockIx({ owner: relayer.publicKey, payer: user.publicKey, callId: 0, callHash: Buffer.alloc(32, 9), horizon: 600 });
  await rejects(relay.submit({ tx: txB64(swapped, { feePayer: relayer.publicKey, signers: [user] }), ip: "1.2.3.4" }), 400, /accounts/);
  const relayerReveals = revealIx({ revealer: relayer.publicKey, owner: user.publicKey, callId: 0, coin: "SOL", side: 1, salt: Buffer.alloc(32) });
  await rejects(relay.submit({ tx: txB64(relayerReveals, { feePayer: relayer.publicKey }), ip: "1.2.3.4" }), 400, /signers/);
  // The user as payer (relayer only fee payer) doesn't match the codec either.
  const userPays = lockIx({ owner: user.publicKey, payer: user.publicKey, callId: 0, callHash: Buffer.alloc(32, 9), horizon: 600 });
  await rejects(relay.submit({ tx: txB64(userPays, { feePayer: relayer.publicKey, signers: [user] }), ip: "1.2.3.4" }), 400, /accounts/);
  assert.equal(connection.sent.length, 0);
});

test("a lock with a substituted account (wrong book PDA) is refused", async () => {
  const { relay, relayer, user } = setup();
  const l = lockIx({ owner: user.publicKey, payer: relayer.publicKey, callId: 0, callHash: Buffer.alloc(32, 9), horizon: 600 });
  l.keys[2] = { ...l.keys[2], pubkey: relayer.publicKey };
  await rejects(relay.submit({ tx: txB64(l, { feePayer: relayer.publicKey, signers: [user] }), ip: "1.2.3.4" }), 400);
});

test("write_score is never relayed", async () => {
  const { relay, relayer, user, connection } = setup();
  const ws = writeScoreIx({ validator: user.publicKey, payer: relayer.publicKey, owner: user.publicKey, score: 50, calls: 1, revealed: 1, withheld: 0, throughCall: 1, reportHash: Buffer.alloc(32, 1) });
  await rejects(relay.submit({ tx: txB64(ws, { feePayer: relayer.publicKey, signers: [user] }), ip: "1.2.3.4" }), 400, /write_score|lock, reveal or set_profile/);
  assert.equal(connection.sent.length, 0);
});

test("a fee payer other than the relayer is refused", async () => {
  const { relay, relayer, user } = setup();
  const l = lockIx({ owner: user.publicKey, payer: relayer.publicKey, callId: 0, callHash: Buffer.alloc(32, 9), horizon: 600 });
  await rejects(relay.submit({ tx: txB64(l, { feePayer: user.publicKey, signers: [user] }), ip: "1.2.3.4" }), 400, /fee payer/);
});

test("a missing or invalid user signature is refused", async () => {
  const { relay, relayer, user, connection, lock } = setup();
  const unsigned = txB64(lockIx({ owner: user.publicKey, payer: relayer.publicKey, callId: 0, callHash: Buffer.alloc(32, 9), horizon: 600 }), { feePayer: relayer.publicKey });
  await rejects(relay.submit({ tx: unsigned, ip: "1.2.3.4" }), 401, /signature/);
  const raw = Buffer.from(lock(), "base64");
  raw[1 + 64 + 5] ^= 1; // flip a bit in the user's signature
  await rejects(relay.submit({ tx: raw.toString("base64"), ip: "1.2.3.4" }), 401, /signature/);
  // Signed by someone else over the same message.
  const other = Keypair.generate();
  const t = Transaction.from(Buffer.from(lock(), "base64"));
  const forged = Buffer.from(lock(), "base64");
  const { sign } = await import("node:crypto");
  const { createPrivateKey } = await import("node:crypto");
  const k = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(other.secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
  sign(null, t.serializeMessage(), k).copy(forged, 1 + 64);
  await rejects(relay.submit({ tx: forged.toString("base64"), ip: "1.2.3.4" }), 401);
  assert.equal(connection.sent.length, 0);
});

test("a relayer signature slot already filled by the client is refused", async () => {
  const { relay, lock } = setup();
  const raw = Buffer.from(lock(), "base64");
  raw.fill(1, 1, 65);
  await rejects(relay.submit({ tx: raw.toString("base64"), ip: "1.2.3.4" }), 400, /fee payer's signature/);
});

test("an extra signer is refused", async () => {
  const { relay, relayer, user, connection } = setup();
  const other = Keypair.generate();
  const p = setProfileIx({ owner: user.publicKey, payer: relayer.publicKey, name: "Quant Fox" });
  p.keys.push({ pubkey: other.publicKey, isSigner: true, isWritable: false });
  await rejects(relay.submit({ tx: txB64(p, { feePayer: relayer.publicKey, signers: [user, other] }), ip: "1.2.3.4" }), 400, /signers/);
  assert.equal(connection.sent.length, 0);
});

test("a stale blockhash is refused", async () => {
  const { relay, connection, lock } = setup();
  connection.valid = false;
  await rejects(relay.submit({ tx: lock(), ip: "1.2.3.4" }), 400, /blockhash/);
  assert.equal(connection.sent.length, 0);
});

test("versioned (v0) transactions, garbage, trailing bytes and oversize input are refused", async () => {
  const { relay, relayer, user } = setup();
  const l = lockIx({ owner: user.publicKey, payer: relayer.publicKey, callId: 0, callHash: Buffer.alloc(32, 9), horizon: 600 });
  const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: relayer.publicKey, recentBlockhash: BLOCKHASH, instructions: [l] }).compileToV0Message());
  v0.sign([user]);
  await rejects(relay.submit({ tx: Buffer.from(v0.serialize()).toString("base64"), ip: "1.2.3.4" }), 400, /legacy/);
  await rejects(relay.submit({ tx: "not base64!!", ip: "1.2.3.4" }), 400);
  await rejects(relay.submit({ tx: 42, ip: "1.2.3.4" }), 400);
  const trailing = Buffer.concat([Buffer.from(txB64(l, { feePayer: relayer.publicKey, signers: [user] }), "base64"), Buffer.from([0])]);
  await rejects(relay.submit({ tx: trailing.toString("base64"), ip: "1.2.3.4" }), 400);
  await rejects(relay.submit({ tx: Buffer.alloc(1300, 1).toString("base64"), ip: "1.2.3.4" }), 400, /bytes/);
});

// ------------------------------------------------------------------ at most once

test("a replayed transaction is sent once; the replay gets 409 with the same signature", async () => {
  const { relay, connection, lock } = setup();
  const tx = lock();
  const first = await relay.submit({ tx, ip: "1.2.3.4" });
  await rejects(relay.submit({ tx, ip: "5.6.7.8" }), 409);
  try { await relay.submit({ tx, ip: "5.6.7.8" }); } catch (err) { assert.equal(err.extra.signature, first.signature); }
  assert.equal(connection.sent.length, 1);
});

test("concurrent submissions of one transaction send it once", async () => {
  const { relay, connection, lock } = setup();
  const tx = lock();
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => relay.submit({ tx, ip: "1.2.3.4" })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.status === 409));
  assert.equal(connection.sent.length, 1);
});

test("a send that throws is never retried: a resubmission is 409", async () => {
  const { relay, connection, lock } = setup();
  connection.sendErr = new Error("node unhealthy https://rpc.example/?api-key=SECRET");
  const tx = lock();
  await rejects(relay.submit({ tx, ip: "1.2.3.4" }), 502);
  connection.sendErr = null;
  await rejects(relay.submit({ tx, ip: "1.2.3.4" }), 409);
  assert.equal(connection.sent.length, 0);
});

test("a failing simulation is refused (422) and takes no budget or send slot", async () => {
  const { relay, connection, lock } = setup({ limits: { txPerHour: 1 } });
  connection.simulateErr = { InstructionError: [0, { Custom: 6002 }] };
  await rejects(relay.submit({ tx: lock(), ip: "1.2.3.4" }), 422);
  assert.equal(await relay.spentToday(), 0);
  connection.simulateErr = null;
  await relay.submit({ tx: lock(), ip: "1.2.3.4" });
  assert.equal(connection.sent.length, 1);
});

// ------------------------------------------------------------------ fails closed

test("the store failing anywhere means 503 and nothing signed or sent", async () => {
  for (const broken of ["hit", "peek", "claim", "has"]) {
    const good = memoryRelayStore();
    const store = { ...good, [broken]: async () => { throw new Error("ECONNREFUSED"); } };
    const { relay, connection, lock } = setup({ store });
    await rejects(relay.submit({ tx: lock(), ip: "1.2.3.4" }), 503, /rate-limit store/);
    assert.equal(connection.sent.length, 0, `nothing sent when ${broken} fails`);
  }
  // Nonsense answers count as failures too.
  const store = { ...memoryRelayStore(), hit: async () => NaN };
  const { relay, connection, lock } = setup({ store });
  await rejects(relay.submit({ tx: lock(), ip: "1.2.3.4" }), 503);
  assert.equal(connection.sent.length, 0);
});

test("the store failing on info is 503 too", async () => {
  const store = { ...memoryRelayStore(), hit: async () => { throw new Error("down"); } };
  const { relay } = setup({ store });
  await rejects(relay.info({ ip: "1.2.3.4" }), 503);
});

test("createSolanaRelay refuses to start without a store", () => {
  assert.throws(() => createSolanaRelay({ connection: mockConnection(), relayer: Keypair.generate() }), /store/);
});

test("the REST store throws (never falls back) on errors, bad shapes and per-command errors", async () => {
  const answer = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
  const mk = (f) => restRelayStore({ url: "https://kv.example", token: "t", fetch: f, now: () => T0 });
  await assert.rejects(mk(answer([], false)).hit("k", 60));
  await assert.rejects(mk(answer([{ error: "WRONGTYPE" }, { result: 1 }])).hit("k", 60));
  await assert.rejects(mk(answer([{ result: 0 }, { result: 1 }])).hit("k", 60), /below/);
  await assert.rejects(mk(answer({ nope: 1 })).peek("k", 60));
  await assert.rejects(mk(async () => { throw new Error("timeout"); }).claim("k", 60));
  await assert.rejects(mk(answer([{ result: "WEIRD" }])).claim("k", 60));
  assert.equal(await mk(answer([{ result: 3 }, { result: 1 }])).hit("k", 60), 3);
  assert.equal(await mk(answer([{ result: "OK" }])).claim("k", 60), true);
  assert.equal(await mk(answer([{ result: null }])).claim("k", 60), false);
  assert.equal(await mk(answer([{ result: null }])).peek("k", 60), 0);
  // The commands sent.
  let sent;
  await restRelayStore({ url: "https://kv.example/", token: "t", now: () => T0, fetch: async (_u, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => [{ result: "OK" }] }; } }).claim("sent:abc", 900);
  assert.deepEqual(sent, [["SET", "arena-sol:sent:abc", "1", "NX", "EX", "900"]]);
});

test("relayStoreFromEnv: shared with KV vars, off on Vercel without, memory otherwise", () => {
  assert.equal(relayStoreFromEnv({ KV_REST_API_URL: "https://kv", KV_REST_API_TOKEN: "t" }).store.kind, "rest");
  const off = relayStoreFromEnv({ VERCEL: "1" });
  assert.equal(off.store, null);
  assert.match(off.off, /shared rate-limit store/);
  assert.equal(relayStoreFromEnv({}).store.kind, "memory");
});

// ------------------------------------------------------------------ limits

test("locks per account per hour", async () => {
  const { relay, user, connection, lock, clock } = setup({ limits: { locksPerAccountHour: 2 } });
  connection.accounts.set(bookAddress(user.publicKey).toBase58(), encBook(user.publicKey, 1));
  await relay.submit({ tx: lock(user, 1), ip: "1.1.1.1" });
  await relay.submit({ tx: lock(user, 2), ip: "2.2.2.2" });
  await rejects(relay.submit({ tx: lock(user, 3), ip: "3.3.3.3" }), 429, /account/);
  clock.t += 3600;
  await relay.submit({ tx: lock(user, 3), ip: "3.3.3.3" });
  assert.equal(connection.sent.length, 3);
});

test("profiles per account per day", async () => {
  const { relay, relayer, user, connection } = setup({ limits: { profilesPerAccountDay: 1 } });
  connection.accounts.set(bookAddress(user.publicKey).toBase58(), encBook(user.publicKey, 1));
  const mk = (name) => txB64(setProfileIx({ owner: user.publicKey, payer: relayer.publicKey, name }), { feePayer: relayer.publicKey, signers: [user] });
  await relay.submit({ tx: mk("Quant Fox"), ip: "1.1.1.1" });
  await rejects(relay.submit({ tx: mk("Quant Owl"), ip: "1.1.1.1" }), 429, /profile/);
});

test("requests per IP per hour (IPv6 by /64)", async () => {
  const { relay, lock } = setup({ limits: { requestsPerIpHour: 2 } });
  await relay.submit({ tx: lock(Keypair.generate()), ip: "2001:db8::1" });
  await relay.submit({ tx: lock(Keypair.generate()), ip: "2001:db8::2" });
  await rejects(relay.submit({ tx: lock(Keypair.generate()), ip: "2001:db8::3" }), 429, /address/);
  await relay.submit({ tx: lock(Keypair.generate()), ip: "2001:db9::1" });
});

test("sends per IP per hour and new books per IP per day", async () => {
  {
    const { relay, lock } = setup({ limits: { sendsPerIpHour: 1 } });
    await relay.submit({ tx: lock(Keypair.generate()), ip: "9.9.9.9" });
    await rejects(relay.submit({ tx: lock(Keypair.generate()), ip: "9.9.9.9" }), 429, /relayed/);
  }
  {
    const { relay, lock } = setup({ limits: { newBooksPerIpDay: 1 } });
    await relay.submit({ tx: lock(Keypair.generate()), ip: "9.9.9.9" });
    await rejects(relay.submit({ tx: lock(Keypair.generate()), ip: "9.9.9.9" }), 429, /new books/);
  }
});

test("the global hourly cap", async () => {
  const { relay, lock, clock } = setup({ limits: { txPerHour: 2 } });
  await relay.submit({ tx: lock(Keypair.generate()), ip: "1.1.1.1" });
  await relay.submit({ tx: lock(Keypair.generate()), ip: "2.2.2.2" });
  await rejects(relay.submit({ tx: lock(Keypair.generate()), ip: "3.3.3.3" }), 429, /busy/);
  clock.t += 3600;
  await relay.submit({ tx: lock(Keypair.generate()), ip: "3.3.3.3" });
});

test("too many refused requests lock out an IP", async () => {
  const { relay, relayer, user, lock } = setup({ limits: { failuresPerIpHour: 2 } });
  const bad = txB64(SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: user.publicKey, lamports: 1 }), { feePayer: relayer.publicKey });
  await rejects(relay.submit({ tx: bad, ip: "6.6.6.6" }), 400);
  await rejects(relay.submit({ tx: bad, ip: "6.6.6.6" }), 400);
  await rejects(relay.submit({ tx: lock(), ip: "6.6.6.6" }), 429, /refused/);
  await relay.submit({ tx: lock(), ip: "7.7.7.7" });
});

test("the daily lamport budget: refused once spent, back the next UTC day", async () => {
  const first = 2 * LAMPORTS_PER_SIGNATURE + rent(ACCOUNT_SIZES.Call) + rent(ACCOUNT_SIZES.Book);
  const { relay, connection, lock, clock } = setup({ limits: { dailyBudgetLamports: first * 2 + 1 } });
  await relay.submit({ tx: lock(Keypair.generate()), ip: "1.1.1.1" });
  await relay.submit({ tx: lock(Keypair.generate()), ip: "1.1.1.2" });
  await rejects(relay.submit({ tx: lock(Keypair.generate()), ip: "1.1.1.3" }), 503, /budget/);
  assert.equal(connection.sent.length, 2);
  clock.t += 86_400;
  await relay.submit({ tx: lock(Keypair.generate()), ip: "1.1.1.3" });
  assert.equal(connection.sent.length, 3);
});

test("defaults", () => {
  assert.equal(SOLANA_RELAY_LIMITS.locksPerAccountHour, 30);
  assert.equal(SOLANA_RELAY_LIMITS.profilesPerAccountDay, 5);
  assert.equal(SOLANA_RELAY_LIMITS.txPerHour, 600);
  assert.equal(SOLANA_RELAY_LIMITS.requestsPerIpHour, 120);
  assert.equal(SOLANA_RELAY_LIMITS.failuresPerIpHour, 60);
  assert.equal(SOLANA_RELAY_LIMITS.sendsPerIpHour, 30);
  assert.equal(SOLANA_RELAY_LIMITS.newBooksPerIpDay, 10);
  assert.ok(Object.isFrozen(SOLANA_RELAY_LIMITS));
  assert.deepEqual(relayLimitsFromEnv({ ARENA_SOLANA_RELAYER_DAILY_SOL: "0.5" }), { dailyBudgetLamports: 500_000_000 });
  assert.deepEqual(relayLimitsFromEnv({}), {});
  assert.throws(() => relayLimitsFromEnv({ ARENA_SOLANA_RELAYER_DAILY_SOL: "lots" }));
});

// ------------------------------------------------------------------ account sizes vs lib.rs

test("account sizes match the Rust structs (8 + INIT_SPACE) and the Score layout comment", () => {
  const src = readFileSync(new URL("../../programs/arena/src/lib.rs", import.meta.url), "utf8");
  const consts = { MAX_COIN_BYTES: 16, MAX_NAME_BYTES: 32, MAX_BIO_BYTES: 160, MAX_LINK_BYTES: 100 };
  for (const [k, v] of Object.entries(consts)) assert.match(src, new RegExp(`pub const ${k}: usize = ${v};`));
  const prim = { u8: 1, i8: 1, bool: 1, u32: 4, u64: 8, i64: 8, Pubkey: 32 };
  const space = (name) => {
    const body = new RegExp(`#\\[account\\]\\s*#\\[derive\\(InitSpace\\)\\]\\s*pub struct ${name} \\{([^}]*)\\}`).exec(src)[1];
    let total = 0, maxLen = null;
    for (const line of body.split("\n").map((l) => l.trim())) {
      const m = /^#\[max_len\((\w+)\)\]$/.exec(line);
      if (m) { maxLen = consts[m[1]]; continue; }
      const f = /^pub \w+: (.+),$/.exec(line);
      if (!f) continue;
      const ty = f[1];
      const arr = /^\[u8; (\w+)\]$/.exec(ty);
      if (ty === "String") { assert.ok(maxLen !== null); total += 4 + maxLen; maxLen = null; }
      else if (arr) total += /^\d+$/.test(arr[1]) ? Number(arr[1]) : consts[arr[1]];
      else { assert.ok(prim[ty], `known type ${ty}`); total += prim[ty]; }
    }
    return 8 + total;
  };
  for (const name of ["Book", "Call", "Profile", "Score"]) assert.equal(ACCOUNT_SIZES[name], space(name), name);
  assert.deepEqual(ACCOUNT_SIZES, { Book: 58, Call: 128, Profile: 354, Score: 183 });
  // The Score layout table ends at 183.
  assert.match(src, /167\.\.183\s+scoring/);
  // Every account the relay can create is created with `space = 8 + X::INIT_SPACE`.
  for (const name of ["Book", "Call", "Profile"]) assert.match(src, new RegExp(`space = 8 \\+ ${name}::INIT_SPACE`));
});

// ------------------------------------------------------------------ the key and the handler

test("relayerKeyFromEnv reads a JSON array or base58, and never echoes the secret", () => {
  const kp = Keypair.generate();
  assert.equal(relayerKeyFromEnv({ ARENA_SOLANA_RELAYER_KEY: JSON.stringify(Array.from(kp.secretKey)) }).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(relayerKeyFromEnv({ ARENA_SOLANA_RELAYER_KEY: ` ${bs58.encode(kp.secretKey)}\n` }).publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(relayerKeyFromEnv({}), null);
  const secret = bs58.encode(kp.secretKey).slice(0, 60);
  try { relayerKeyFromEnv({ ARENA_SOLANA_RELAYER_KEY: secret }); assert.fail("should throw"); } catch (err) {
    assert.ok(!String(err.message).includes(secret.slice(0, 20)));
  }
  // A 64-byte array whose public half doesn't match its seed is refused.
  const bad = Array.from(kp.secretKey); bad[40] ^= 1;
  assert.throws(() => relayerKeyFromEnv({ ARENA_SOLANA_RELAYER_KEY: JSON.stringify(bad) }));
});

test("the express-style handler: GET info, POST submit, errors as JSON with their status", async () => {
  const { relay, lock, connection } = setup();
  const call = async (req) => {
    const res = { code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; } };
    await relay.handler(req, res);
    return res;
  };
  const g = await call({ method: "GET", ip: "1.2.3.4" });
  assert.equal(g.code, 200);
  assert.equal(g.body.blockhash, BLOCKHASH);
  assert.equal(g.headers["cache-control"], "no-store");
  const tx = lock();
  const p = await call({ method: "POST", ip: "1.2.3.4", body: { tx } });
  assert.equal(p.code, 200);
  assert.equal(typeof p.body.signature, "string");
  const again = await call({ method: "POST", ip: "1.2.3.4", body: { tx } });
  assert.equal(again.code, 409);
  assert.equal(again.body.signature, p.body.signature);
  assert.equal(typeof again.body.error, "string");
  connection.sendErr = new Error("boom https://rpc.example/?api-key=SECRET");
  const failed = await call({ method: "POST", ip: "1.2.3.4", body: { tx: lock(Keypair.generate()) } });
  assert.equal(failed.code, 502);
  assert.ok(!JSON.stringify(failed.body).includes("SECRET"), "RPC URLs are scrubbed");
  const other = await call({ method: "PUT", ip: "1.2.3.4" });
  assert.equal(other.code, 405);
});
