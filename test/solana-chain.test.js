// The Solana chain reader (app/verify/solana-chain.js) builds the same `chain`
// as readCallbook, from a mocked Connection whose transactions carry real
// "Program data:" log lines. Nothing here touches the network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import express from "express";
import { Keypair, PublicKey } from "@solana/web3.js";

import { ARENA_PROGRAM_ID, bookAddress, scoreAddress, callHash, decodeEvent, scoringBytes } from "../solana/arena.js";
import {
  readSolanaArena, solanaSnapshotText, solanaStateFromSnapshot, SIGNATURE_PAGE,
} from "../app/verify/solana-chain.js";
import { solanaNetwork, explorerTx, explorerAddress, explorerBase } from "../app/verify/solana-network.js";
import { profileKey, requestForBook, latestResponse, SCORING_VERSION } from "../app/verify/callbook-chain.js";
import { buildCallbook, evaluateAny } from "../app/verify/callbook.js";
import { deriveLocks, evaluateCaller } from "../app/verify/callbook-callers.js";
import { profileFor } from "../app/verify/callbook-agents.js";
import { withExits, EXITS_SINCE } from "../app/verify/callbook-exits.js";
import { mountCallbook } from "../app/callbook-routes.js";

const HOUR = 3600, DAY = 86400;
const T0 = 1_792_000_000 - (1_792_000_000 % DAY); // after EXITS_SINCE: salts carry exits
const PROGRAM = ARENA_PROGRAM_ID.toBase58();
const NAMES = ["BTC", "ETH", "SOL", "kPEPE", "HYPE"];

// ------------------------------------------------------------------ an event encoder (Anchor: sha256("event:<Name>")[..8] + borsh)

const disc = (name) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const u8 = (n) => Buffer.from([n & 0xff]);
const i8 = (n) => { const b = Buffer.alloc(1); b.writeInt8(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const str = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([u32(b.length), b]); };
const key = (k) => new PublicKey(k).toBuffer();
const event = (name, ...parts) => Buffer.concat([disc(name), ...parts]).toString("base64");

const ev = {
  bookOpened: ({ book, owner, openedAt }) => event("BookOpened", key(book), key(owner), i64(openedAt)),
  locked: ({ book, owner, callId, callHash: h, lockedAt, entryAt, horizon }) => event("Locked", key(book), key(owner), u64(callId), Buffer.from(h), i64(lockedAt), i64(entryAt), u32(horizon)),
  revealed: ({ book, owner, callId, coin, side, horizon, salt, revealedAt }) => event("Revealed", key(book), key(owner), u64(callId), str(coin), i8(side), u32(horizon), Buffer.from(salt), i64(revealedAt)),
  profileSet: ({ owner, name, bio, link, updatedAt }) => event("ProfileSet", key(owner), str(name), str(bio), str(link), i64(updatedAt)),
  scoreWritten: ({ validator, book, owner, score, calls, revealed, withheld, throughCall, scoredAt, reportHash, scoring = SCORING_VERSION }) =>
    event("ScoreWritten", key(validator), key(book), key(owner), u8(score), u32(calls), u32(revealed), u32(withheld), u64(throughCall), i64(scoredAt), Buffer.from(reportHash), scoringBytes(scoring)),
};

/** Log lines as the runtime writes them: data logged inside the Arena program's own invocation. */
const arenaLogs = (...data) => [
  `Program ${PROGRAM} invoke [1]`, "Program log: Instruction: Lock", ...data.map((d) => `Program data: ${d}`),
  `Program ${PROGRAM} consumed 12000 of 200000 compute units`, `Program ${PROGRAM} success`,
];
const otherLogs = (program, ...data) => [`Program ${program} invoke [1]`, ...data.map((d) => `Program data: ${d}`), `Program ${program} success`];

// ------------------------------------------------------------------ a mock Connection

let sigCounter = 0;
const sigOf = () => {
  // A signature-looking base58 string, unique per call.
  const b = Buffer.alloc(64);
  b.writeUInt32BE(++sigCounter, 60);
  b.write("arena-test", 0);
  return new PublicKey(b.subarray(0, 32)).toBase58() + new PublicKey(b.subarray(32)).toBase58();
};

/**
 * txs: [{ slot, blockTime, logs, err?, failedInList? }] in chain order. getSignaturesForAddress
 * answers newest first, paged with before/until like the real RPC.
 */
function mockConnection(txs = [], { page = SIGNATURE_PAGE } = {}) {
  const calls = { signatures: 0, transactions: [] };
  const list = [];
  const conn = {
    calls,
    add(tx) {
      const signature = tx.signature ?? sigOf();
      list.push({ ...tx, signature });
      return signature;
    },
    async getSignaturesForAddress(address, { before, until, limit = 1000 } = {}) {
      calls.signatures++;
      assert.equal(new PublicKey(address).toBase58(), PROGRAM);
      let newest = [...list].reverse();
      if (before) newest = newest.slice(newest.findIndex((t) => t.signature === before) + 1);
      if (until) newest = newest.slice(0, newest.findIndex((t) => t.signature === until) < 0 ? newest.length : newest.findIndex((t) => t.signature === until));
      return newest.slice(0, Math.min(limit, page)).map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: t.err ? { InstructionError: [0, "Custom"] } : null }));
    },
    async getTransaction(signature, opts) {
      assert.equal(opts.maxSupportedTransactionVersion, 0);
      assert.equal(opts.commitment, "confirmed");
      calls.transactions.push(signature);
      const t = list.find((x) => x.signature === signature);
      if (!t || t.lagging) return null;
      return { slot: t.slot, blockTime: t.blockTime, meta: { err: t.metaErr ? { InstructionError: [0, "Custom"] } : null, logMessages: t.logs } };
    },
  };
  for (const t of txs) conn.add(t);
  return conn;
}

// ------------------------------------------------------------------ a small world

const alice = Keypair.generate().publicKey, bob = Keypair.generate().publicKey, validator = Keypair.generate().publicKey;
const aliceBook = bookAddress(alice), bobBook = bookAddress(bob);
const saltOf = (n) => Buffer.alloc(32, n);

function lockFor({ owner, book, callId, coin, side, horizon, salt, lockedAt }) {
  const h = callHash({ book, callId, horizon, coin, side, salt });
  const entryAt = Math.ceil((lockedAt + 60) / 60) * 60;
  return { lock: ev.locked({ book, owner, callId, callHash: h, lockedAt, entryAt, horizon }), reveal: (at) => ev.revealed({ book, owner, callId, coin, side, horizon, salt, revealedAt: at }), entryAt, hash: h };
}

/** Alice opens and locks two calls (one with exits), reveals one; Bob opens later; a profile; a score. */
function world() {
  const exitSalt = Buffer.from(withExits(`0x${"ab".repeat(32)}`, { stop: 120, target: 90 }).slice(2), "hex");
  const a0 = lockFor({ owner: alice, book: aliceBook, callId: 0, coin: "BTC", side: 1, horizon: HOUR, salt: saltOf(7), lockedAt: T0 });
  const a1 = lockFor({ owner: alice, book: aliceBook, callId: 1, coin: "ETH", side: -1, horizon: 4 * HOUR, salt: exitSalt, lockedAt: T0 + 600 });
  const b0 = lockFor({ owner: bob, book: bobBook, callId: 0, coin: "SOL", side: 1, horizon: HOUR, salt: saltOf(9), lockedAt: T0 + 1200 });
  const txs = [
    { slot: 100, blockTime: T0, logs: arenaLogs(ev.bookOpened({ book: aliceBook, owner: alice, openedAt: T0 }), a0.lock) },
    { slot: 101, blockTime: T0 + 600, logs: arenaLogs(a1.lock) },
    { slot: 102, blockTime: T0 + 1200, logs: arenaLogs(ev.bookOpened({ book: bobBook, owner: bob, openedAt: T0 + 1200 }), b0.lock) },
    { slot: 103, blockTime: T0 + 1300, logs: arenaLogs(ev.profileSet({ owner: alice, name: "Alice Calls", bio: "BTC mostly", link: "https://alice.example", updatedAt: T0 + 1300 })) },
    { slot: 110, blockTime: T0 + 2 * HOUR, logs: arenaLogs(a0.reveal(T0 + 2 * HOUR)) },
    { slot: 111, blockTime: T0 + 6 * HOUR, logs: arenaLogs(a1.reveal(T0 + 6 * HOUR)) },
    { slot: 120, blockTime: T0 + DAY, logs: arenaLogs(ev.scoreWritten({ validator, book: aliceBook, owner: alice, score: 61, calls: 2, revealed: 2, withheld: 0, throughCall: 2, scoredAt: T0 + DAY, reportHash: Buffer.alloc(32, 5) })) },
  ];
  return { txs, a0, a1, b0, exitSalt };
}

// ------------------------------------------------------------------ the encoder agrees with the program

test("the test's encoder writes the program's own Revealed bytes (a real log from solana/test)", () => {
  const REAL = "tAfHWJoTtZr+CifPl8RdY8iTaE6ivQvcFJqj2sHFMoUA9FPiIBNIILjgyX1cClPyWL25Xft/51HtviNXv9TWsvTBkJ49mrrpAAAAAAAAAAADAAAAU09MARAOAACTPZdQVD5pSn6uXfb0BaOs9QkmddsYjDXB9yA8T1yG0IfgSWsAAAAA";
  const e = decodeEvent(Buffer.from(REAL, "base64"));
  assert.equal(ev.revealed(e), REAL);
});

// ------------------------------------------------------------------ the shape

describe("the chain shape", () => {
  test("books, locks, reveals, profiles and scores land where readCallbook puts them", async () => {
    const { txs, a0, a1, b0, exitSalt } = world();
    const conn = mockConnection(txs);
    const chain = await readSolanaArena({ connection: conn, validator: validator.toBase58() });

    assert.equal(chain.address, PROGRAM);
    assert.equal(chain.chainId, "solana-devnet");
    assert.equal(chain.toSlot, 120);
    assert.deepEqual([...chain.books.keys()], [1, 2]);
    assert.equal(chain.links.size, 0);

    const a = chain.books.get(1);
    assert.equal(a.kind, "free");
    assert.equal(a.anyCoin, true);
    assert.deepEqual(a.coins, []);
    assert.equal(a.minHorizon, 300);
    assert.equal(a.maxHorizon, 2_592_000);
    assert.equal(a.owner, alice.toBase58(), "base58, never lowercased");
    assert.equal(a.caller, alice.toBase58());
    assert.equal(a.address, aliceBook.toBase58());
    assert.equal(a.agentId, null);
    assert.equal(a.openedAt, T0);
    assert.equal(a.openTx, conn.calls.transactions[0]);
    assert.equal(a.closedAt, null);
    assert.equal(chain.books.get(2).owner, bob.toBase58());

    const l0 = a.locks.get(0);
    assert.deepEqual(Object.keys(l0).sort(), ["callId", "entryAt", "hash", "horizon", "lockTx", "lockedAt", "nonce", "reveal"]);
    assert.equal(l0.hash, `0x${a0.hash.toString("hex")}`);
    assert.equal(l0.lockedAt, T0);
    assert.equal(l0.entryAt, a0.entryAt);
    assert.equal(l0.horizon, HOUR);
    assert.equal(l0.nonce, 0);
    assert.match(l0.lockTx, /^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
    assert.deepEqual(l0.reveal, { coinIndex: null, symbol: "BTC", side: 1, horizon: HOUR, at: T0 + 2 * HOUR, tx: l0.reveal.tx, salt: `0x${"07".repeat(32)}` });
    assert.equal(a.locks.get(1).reveal.salt, `0x${exitSalt.toString("hex")}`, "the salt comes straight from the event");
    assert.equal(a.locks.get(1).reveal.side, -1);
    const bl = chain.books.get(2).locks.get(0);
    assert.equal(bl.hash, `0x${b0.hash.toString("hex")}`);
    assert.equal(bl.reveal, null);
    assert.ok(a1);

    const p = chain.profiles.get(profileKey(alice.toBase58(), 0));
    assert.equal(p.account, alice.toBase58());
    assert.equal(p.name, "Alice Calls");
    assert.equal(p.bio, "BTC mostly");
    assert.equal(p.link, "https://alice.example");
    assert.equal(p.at, T0 + 1300);
    // The pages' lookups lowercase both sides alike, so a base58 owner still finds its profile.
    assert.equal(profileFor({ chain, book: a }).name, "Alice Calls");

    // Scores: an implied request per book for the configured validator, keyed by the Score account.
    const req = requestForBook(chain, 1, validator.toBase58());
    assert.equal(req.requestHash, scoreAddress(validator, aliceBook).toBase58());
    assert.equal(req.validator, validator.toBase58());
    const last = latestResponse(chain, req.requestHash);
    assert.equal(last.score, 61);
    assert.equal(last.tag, "arena-v1");
    assert.equal(last.at, T0 + DAY);
    assert.equal(last.responseHash, `0x${"05".repeat(32)}`);
    assert.equal(last.calls, 2);
    assert.ok(requestForBook(chain, 2, validator.toBase58()), "Bob's book has its request, no response yet");
    assert.equal(latestResponse(chain, requestForBook(chain, 2).requestHash), null);
    assert.equal(requestForBook(chain, 1, Keypair.generate().publicKey.toBase58()), null, "another validator's request isn't ours");
  });

  test("scores by another validator, or with no validator configured, are ignored", async () => {
    const mallory = Keypair.generate().publicKey;
    const txs = [
      { slot: 1, blockTime: T0, logs: arenaLogs(ev.bookOpened({ book: aliceBook, owner: alice, openedAt: T0 })) },
      { slot: 2, blockTime: T0 + 10, logs: arenaLogs(ev.scoreWritten({ validator: mallory, book: aliceBook, owner: alice, score: 100, calls: 0, revealed: 0, withheld: 0, throughCall: 0, scoredAt: T0 + 10, reportHash: Buffer.alloc(32) })) },
    ];
    const ours = await readSolanaArena({ connection: mockConnection(txs), validator: validator.toBase58() });
    assert.equal([...ours.validation.responses.values()].flat().length, 0);
    const none = await readSolanaArena({ connection: mockConnection(txs) });
    assert.equal(none.validation.requests.size, 0);
    assert.equal(none.validation.responses.size, 0);
  });

  test("failed transactions are skipped, whether the list or the transaction says so", async () => {
    const x = lockFor({ owner: alice, book: aliceBook, callId: 0, coin: "BTC", side: 1, horizon: HOUR, salt: saltOf(1), lockedAt: T0 });
    const conn = mockConnection([
      { slot: 1, blockTime: T0, logs: arenaLogs(ev.bookOpened({ book: aliceBook, owner: alice, openedAt: T0 }), x.lock), err: true },
      { slot: 2, blockTime: T0, logs: arenaLogs(ev.bookOpened({ book: bobBook, owner: bob, openedAt: T0 })), metaErr: true },
    ]);
    const chain = await readSolanaArena({ connection: conn });
    assert.equal(chain.books.size, 0);
    assert.equal(conn.calls.transactions.length, 1, "a transaction listed as failed isn't even fetched");
    assert.equal(chain.toSlot, 2);
  });

  test("events logged by another program are forgeries and ignored; Arena's own by CPI count", async () => {
    const other = Keypair.generate().publicKey.toBase58();
    const forged = ev.bookOpened({ book: aliceBook, owner: alice, openedAt: T0 });
    const conn = mockConnection([
      { slot: 1, blockTime: T0, logs: otherLogs(other, forged) },
      { slot: 2, blockTime: T0, logs: [`Program ${other} invoke [1]`, `Program ${PROGRAM} invoke [2]`, `Program data: ${ev.bookOpened({ book: bobBook, owner: bob, openedAt: T0 })}`, `Program ${PROGRAM} success`, `Program data: ${forged}`, `Program ${other} success`] },
    ]);
    const chain = await readSolanaArena({ connection: conn });
    assert.deepEqual([...chain.books.values()].map((b) => b.owner), [bob.toBase58()]);
  });

  test("a BookOpened whose book isn't the owner's PDA is not a book", async () => {
    const chain = await readSolanaArena({ connection: mockConnection([{ slot: 1, blockTime: T0, logs: arenaLogs(ev.bookOpened({ book: bobBook, owner: alice, openedAt: T0 })) }]) });
    assert.equal(chain.books.size, 0);
  });

  test("a reveal whose preimage doesn't hash to the lock keeps no salt (unscorable), and a second reveal is ignored", async () => {
    const x = lockFor({ owner: alice, book: aliceBook, callId: 0, coin: "BTC", side: 1, horizon: HOUR, salt: saltOf(1), lockedAt: T0 });
    const wrong = ev.revealed({ book: aliceBook, owner: alice, callId: 0, coin: "ETH", side: 1, horizon: HOUR, salt: saltOf(1), revealedAt: T0 + 2 * HOUR });
    const chain = await readSolanaArena({ connection: mockConnection([
      { slot: 1, blockTime: T0, logs: arenaLogs(ev.bookOpened({ book: aliceBook, owner: alice, openedAt: T0 }), x.lock) },
      { slot: 2, blockTime: T0 + 2 * HOUR, logs: arenaLogs(wrong) },
      { slot: 3, blockTime: T0 + 3 * HOUR, logs: arenaLogs(x.reveal(T0 + 3 * HOUR)) },
    ]) });
    const l = chain.books.get(1).locks.get(0);
    assert.equal(l.reveal.symbol, "ETH");
    assert.equal(l.reveal.salt, null);
    assert.equal(deriveLocks(chain.books.get(1), T0 + 4 * HOUR, NAMES)[0].status, "unscorable");
  });
});

// ------------------------------------------------------------------ incremental reads and ids

describe("incremental reads", () => {
  test("a state passed back reads only what's new, and ends where one full read does", async () => {
    const { txs } = world();
    const conn = mockConnection(txs.slice(0, 3));
    const first = await readSolanaArena({ connection: conn, validator: validator.toBase58() });
    assert.equal(first.books.size, 2);
    assert.equal(conn.calls.transactions.length, 3);
    const again = await readSolanaArena({ connection: conn, validator: validator.toBase58(), state: first });
    assert.equal(conn.calls.transactions.length, 3, "nothing new: nothing fetched");
    for (const t of txs.slice(3)) conn.add(t);
    const next = await readSolanaArena({ connection: conn, validator: validator.toBase58(), state: again });
    assert.equal(conn.calls.transactions.length, txs.length);
    assert.equal(new Set(conn.calls.transactions).size, txs.length, "each transaction is fetched once");

    const whole = await readSolanaArena({ connection: mockConnection(txs.map((t, i) => ({ ...t, signature: conn.calls.transactions[i] }))), validator: validator.toBase58() });
    assert.equal(solanaSnapshotText({ ...next, savedAt: 0 }).replace(/"savedAt":"[^"]*"/, ""), solanaSnapshotText({ ...whole, savedAt: 0 }).replace(/"savedAt":"[^"]*"/, ""));
  });

  test("signatures are paged with before/until (full pages of SIGNATURE_PAGE)", async () => {
    const many = mockConnection([]);
    many.add({ slot: 1, blockTime: T0, logs: arenaLogs(ev.bookOpened({ book: aliceBook, owner: alice, openedAt: T0 })) });
    for (let i = 0; i < 1500; i++) many.add({ slot: 2 + i, blockTime: T0 + i, logs: ["Program log: unrelated"] });
    many.add({ slot: 5000, blockTime: T0 + DAY, logs: arenaLogs(ev.bookOpened({ book: bobBook, owner: bob, openedAt: T0 + DAY })) });
    const chain = await readSolanaArena({ connection: many, maxTransactions: 10_000 });
    assert.equal(many.calls.signatures, 2, "1502 signatures: a full page, then the rest");
    assert.deepEqual([...chain.books.values()].map((b) => [b.id, b.owner]), [[1, alice.toBase58()], [2, bob.toBase58()]]);
    assert.equal(chain.toSlot, 5000);
  });

  test("a long history is read maxTransactions at a time, oldest first", async () => {
    const { txs } = world();
    const conn = mockConnection(txs);
    let s = await readSolanaArena({ connection: conn, maxTransactions: 2 });
    assert.equal(s.books.size, 1);
    assert.equal(s.books.get(1).locks.size, 2);
    s = await readSolanaArena({ connection: conn, maxTransactions: 2, state: s });
    assert.equal(s.books.size, 2);
    assert.equal(s.profiles.size, 1);
  });

  test("book ids follow BookOpened order (slot, then transaction, then log) and survive incremental reads", async () => {
    const carol = Keypair.generate().publicKey;
    const opened = (owner, at) => ev.bookOpened({ book: bookAddress(owner), owner, openedAt: at });
    const txs = [
      { slot: 5, blockTime: T0, logs: arenaLogs(opened(bob, T0)) },
      { slot: 5, blockTime: T0, logs: arenaLogs(opened(carol, T0), opened(alice, T0)) },
      { slot: 9, blockTime: T0 + 1, logs: arenaLogs(opened(bob, T0 + 1)) }, // the same book again: not a new one
    ];
    const once = await readSolanaArena({ connection: mockConnection(txs) });
    assert.deepEqual([...once.books.values()].map((b) => [b.id, b.owner]), [[1, bob.toBase58()], [2, carol.toBase58()], [3, alice.toBase58()]]);
    const conn = mockConnection([txs[0]]);
    let s = await readSolanaArena({ connection: conn });
    conn.add(txs[1]);
    s = await readSolanaArena({ connection: conn, state: s });
    conn.add(txs[2]);
    s = await readSolanaArena({ connection: conn, state: s });
    assert.deepEqual([...s.books.values()].map((b) => [b.id, b.owner]), [[1, bob.toBase58()], [2, carol.toBase58()], [3, alice.toBase58()]]);
    assert.equal(s.nextBookId, 4);
  });

  test("a transaction the RPC doesn't serve yet stops the read there; the next read carries on in order", async () => {
    const { txs } = world();
    const conn2 = mockConnection([]);
    const sigs = txs.map((t, i) => conn2.add({ ...t, lagging: i === 2 }));
    let s = await readSolanaArena({ connection: conn2 });
    assert.equal(s.books.size, 1, "stopped before Bob's book");
    assert.equal(s.newestSignature, sigs[1]);
    const fixed = mockConnection(txs.map((t, i) => ({ ...t, signature: sigs[i] })));
    s = await readSolanaArena({ connection: fixed, state: s });
    assert.equal(s.books.size, 2);
    assert.equal(fixed.calls.transactions[0], sigs[2]);
  });

  test("a rate-limited RPC is waited out (1s, 2s, ...), not hammered", async () => {
    const { txs } = world();
    const conn = mockConnection(txs.slice(0, 1));
    const real = conn.getSignaturesForAddress.bind(conn), realTx = conn.getTransaction.bind(conn);
    let sigFails = 2, txFails = 1;
    conn.getSignaturesForAddress = async (...a) => { if (sigFails-- > 0) throw new Error("429 Too Many Requests: rate limited"); return real(...a); };
    conn.getTransaction = async (...a) => { if (txFails-- > 0) throw Object.assign(new Error("server busy"), { status: 429 }); return realTx(...a); };
    const waits = [];
    const chain = await readSolanaArena({ connection: conn, wait: async (ms) => { waits.push(ms); } });
    assert.deepEqual(waits, [1000, 2000, 1000]);
    assert.equal(chain.books.size, 1);
    // Any other error stands.
    const broken = mockConnection([]);
    broken.getSignaturesForAddress = async () => { throw new Error("boom"); };
    await assert.rejects(readSolanaArena({ connection: broken, wait: async () => {} }), /boom/);
  });
});

// ------------------------------------------------------------------ snapshots

test("a snapshot round-trips, and one read from another program, cluster or validator isn't used", async () => {
  const { txs } = world();
  const v = validator.toBase58();
  const chain = await readSolanaArena({ connection: mockConnection(txs), validator: v });
  const text = solanaSnapshotText(chain);
  const back = solanaStateFromSnapshot(text, { validator: v });
  assert.ok(back);
  assert.equal(back.books.get(1).locks.get(0).reveal.symbol, "BTC");
  assert.equal(back.books.get(1).owner, alice.toBase58());
  assert.equal(back.bookIds.get(aliceBook.toBase58()), 1);
  assert.equal(latestResponse(back, requestForBook(back, 1, v).requestHash).score, 61);
  assert.equal(solanaStateFromSnapshot(text, { validator: null }), null);
  assert.equal(solanaStateFromSnapshot(text, { validator: v, chainId: "solana-mainnet" }), null);
  assert.equal(solanaStateFromSnapshot(text, { validator: v, programId: Keypair.generate().publicKey }), null);
  assert.equal(solanaStateFromSnapshot("not json", { validator: v }), null);
  // Continuing from a snapshot reads nothing old again.
  const conn = mockConnection([]);
  // Same signatures as the snapshot's read: rebuild them by reading with a mock that records them.
  const rec = mockConnection(txs);
  const s1 = await readSolanaArena({ connection: rec, validator: v });
  const restored = solanaStateFromSnapshot(solanaSnapshotText(s1), { validator: v });
  const sigs = rec.calls.transactions;
  for (const [i, t] of txs.entries()) conn.add({ ...t, signature: sigs[i] });
  await readSolanaArena({ connection: conn, validator: v, state: restored });
  assert.equal(conn.calls.transactions.length, 0);
});

// ------------------------------------------------------------------ config

test("ARENA_NETWORK=solana-devnet picks Solana; anything else leaves Arc alone", () => {
  assert.equal(solanaNetwork({}), null);
  assert.equal(solanaNetwork({ ARENA_NETWORK: "testnet" }), null);
  const net = solanaNetwork({ ARENA_NETWORK: "solana-devnet", ARENA_SOLANA_VALIDATOR: validator.toBase58() });
  assert.equal(net.kind, "solana");
  assert.equal(net.rpc, "https://api.devnet.solana.com");
  assert.equal(net.address, PROGRAM);
  assert.equal(net.validator, validator.toBase58());
  assert.equal(net.validationOff, null);
  assert.equal(net.chainId, "solana-devnet");
  assert.match(net.stateFile, /callbook-state-solana-devnet\.json$/);
  const other = Keypair.generate().publicKey.toBase58();
  const custom = solanaNetwork({ ARENA_NETWORK: "solana-devnet", SOLANA_RPC_URL: "http://127.0.0.1:8899", ARENA_SOLANA_PROGRAM_ID: other, ARENA_SOLANA_VALIDATOR: "0xnot" });
  assert.equal(custom.rpc, "http://127.0.0.1:8899");
  assert.equal(custom.address, other);
  assert.equal(custom.validator, null);
  assert.match(custom.validationOff, /ARENA_SOLANA_VALIDATOR/);
  assert.throws(() => solanaNetwork({ ARENA_NETWORK: "solana-devnet", ARENA_SOLANA_PROGRAM_ID: "nope!" }), /PROGRAM_ID/);
  assert.equal(explorerTx("5sig"), "https://explorer.solana.com/tx/5sig?cluster=devnet");
  assert.equal(explorerAddress(PROGRAM), `https://explorer.solana.com/address/${PROGRAM}?cluster=devnet`);
  assert.equal(explorerBase(), "https://explorer.solana.com?cluster=devnet");
});

// ------------------------------------------------------------------ the scorer, unchanged

function synthetic(coins, t0, t1, price, step = HOUR) {
  const candles = {}, funding = {};
  for (const c of coins) {
    candles[c] = [];
    funding[c] = [];
    for (let t = Math.floor(t0 / HOUR) * HOUR; t <= t1; t += step) {
      const o = price(c, t), cl = price(c, t + step);
      candles[c].push({ t, o, h: Math.max(o, cl), l: Math.min(o, cl), c: cl, v: 1000 });
      if (t % HOUR === 0) funding[c].push([t, 0]);
    }
  }
  return { interval: step === HOUR ? "1h" : "5m", candles, funding, fundingOk: true };
}
// BTC climbs 1% an hour; everything else is flat.
const rising = (c, t) => (c === "BTC" ? 100 * (1 + 0.01 * (t - T0) / HOUR) : 100);
const source = { perpNames: async () => NAMES, load: async (coins, from, to, interval = "1h") => synthetic(coins, from, to, rising, interval === "5m" ? 300 : HOUR) };

describe("the existing scorer over a Solana-built chain", () => {
  test("evaluateCaller scores the locks: a revealed long, a call with exits, a pending and a withheld one", async () => {
    const { txs } = world();
    const chain = await readSolanaArena({ connection: mockConnection(txs), validator: validator.toBase58() });
    assert.ok(T0 > EXITS_SINCE);
    const asOf = T0 + 9 * DAY; // Bob's unrevealed call is past its horizon + GRACE: withheld
    const alice1 = await evaluateCaller({ chain, book: chain.books.get(1), source, asOf, reportUri: () => "u" });
    const byId = new Map(alice1.scored.periods.map((c) => [c.callId, c]));
    assert.equal(byId.get(0).status, "revealed");
    assert.equal(byId.get(0).coin, "BTC");
    assert.ok(byId.get(0).ret > 0, "a long on a rising coin made money");
    assert.equal(byId.get(1).status, "revealed");
    assert.equal(byId.get(1).exits?.stop?.text, "120", "exits parsed from the salt the event carried");
    assert.equal(alice1.scored.metrics.revealed, 2);
    const bob1 = await evaluateAny({ chain, book: chain.books.get(2), source, asOf });
    assert.equal(bob1.scored.periods[0].status, "withheld");
    const early = await evaluateCaller({ chain, book: chain.books.get(2), source, asOf: T0 + 3 * HOUR, reportUri: () => "u" });
    assert.equal(early.scored.periods[0].status, "pending");
  });

  test("buildCallbook builds the index, callers and their validation from it", async () => {
    const { txs } = world();
    const v = validator.toBase58();
    const chain = await readSolanaArena({ connection: mockConnection(txs), validator: v });
    const asOf = T0 + 2 * DAY;
    const built = await buildCallbook({ chain, source, asOf, meta: { network: "Solana devnet", chainId: chain.chainId, explorer: explorerBase(), contract: chain.address }, validator: v });
    const callers = built.index.callers;
    assert.deepEqual(callers.map((c) => c.id), ["1", "2"]);
    const a = callers[0];
    assert.equal(a.owner, alice.toBase58());
    assert.equal(a.name, "Alice Calls");
    assert.equal(a.validation.score, 61);
    assert.equal(a.validation.tag, "arena-v1");
    assert.equal(a.validation.at, T0 + DAY);
    assert.match(a.validation.txHash, /^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
    assert.equal(callers[1].name, `${bob.toBase58().slice(0, 6)}…${bob.toBase58().slice(-4)}`);
    assert.ok(built.index.people[alice.toBase58()], "the person's profile is keyed by their base58 address");
    assert.equal(built.index.stats.validations, 1);
    const feed = built.index.feed;
    assert.ok(feed.some((f) => f.kind === "validated" && f.score === 61));
    assert.ok(feed.some((f) => f.kind === "revealed" && f.coin === "BTC"));
    const detail = built.callerDetails.get("1");
    assert.equal(detail.calls.length, 2);
    assert.match(detail.report.uri, new RegExp(`^callbook-report:solana-devnet/${PROGRAM}/1\\?asOf=${asOf}$`));
  });
});

// ------------------------------------------------------------------ the API, over Solana

test("the API serves a Solana chain with ARENA_NETWORK=solana-devnet", async () => {
  const { txs } = world();
  const v = validator.toBase58();
  const conn = mockConnection(txs);
  const app = express();
  const clock = { t: T0 + 2 * DAY };
  mountCallbook(app, { env: { ARENA_NETWORK: "solana-devnet", ARENA_SOLANA_VALIDATOR: v, ARENA_STATE_FILE: "/nonexistent/state.json" }, source, now: () => clock.t, solanaConnection: conn });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const index = await (await fetch(`${url}/api/callbook`)).json();
    assert.equal(index.chainId, "solana-devnet");
    assert.equal(index.contract, PROGRAM, "the program id keeps its case");
    assert.equal(index.explorer, "https://explorer.solana.com?cluster=devnet");
    assert.equal(index.network, "Solana devnet");
    assert.equal(index.callers.length, 2);
    assert.equal(index.callers[0].owner, alice.toBase58());
    assert.equal(index.callers[0].validation.score, 61);
    const caller = await (await fetch(`${url}/api/callbook/caller/1`)).json();
    assert.equal(caller.calls.length, 2);
    const rep = await fetch(`${url}/api/callbook/report/1?asOf=${T0 + DAY}`);
    assert.equal(rep.status, 200);
    assert.match(rep.headers.get("x-report-hash"), /^0x[0-9a-f]{64}$/);
    assert.equal((await fetch(`${url}/api/callbook/link/${alice.toBase58()}`)).status, 404);
    assert.equal((await fetch(`${url}/api/callbook/relay/lock`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 503);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
