// solana/arena.js agrees with the program: the call hash, addresses,
// instruction layouts, and events decoded from real program logs (captured
// from the litesvm runs in crates/arena-tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Keypair } from "@solana/web3.js";

import {
  ARENA_PROGRAM_ID, callHash, bookAddress, callAddress, lockIx, revealIx, setProfileIx, writeScoreIx,
  decodeAccount, decodeEvent, eventsFromLogs, INSTRUCTIONS, accountDiscriminator,
} from "../arena.js";

test("the call hash matches the program's (crates/arena-tests: call_hash_matches_the_js_vector)", () => {
  const h = callHash({ book: new PublicKey(Buffer.alloc(32, 1)), callId: 7, horizon: 3600, coin: "BTC", side: -1, salt: Buffer.alloc(32, 2) });
  assert.equal(h.toString("hex"), "742431a25e1d7f60dfd582b99bcb68f79a0be89329e61d2a80f504a39cc5a683");
});

test("the hash refuses what the program would", () => {
  const base = { book: new PublicKey(Buffer.alloc(32, 1)), callId: 0, horizon: 300, coin: "SOL", side: 1, salt: Buffer.alloc(32) };
  assert.throws(() => callHash({ ...base, side: 0 }), /side/);
  assert.throws(() => callHash({ ...base, coin: "" }), /coin/);
  assert.throws(() => callHash({ ...base, coin: "X".repeat(17) }), /coin/);
  assert.throws(() => callHash({ ...base, salt: Buffer.alloc(31) }), /salt/);
  assert.notDeepEqual(callHash(base), callHash({ ...base, coin: "SOL\0" }), "the coin's length is bound");
});

test("instructions carry Anchor discriminators and the account order the program expects", () => {
  const owner = Keypair.generate().publicKey, payer = Keypair.generate().publicKey;
  const l = lockIx({ owner, payer, callId: 3, callHash: Buffer.alloc(32, 1), horizon: 600 });
  assert.equal(l.data.length, 52);
  assert.equal(INSTRUCTIONS[l.data.subarray(0, 8).toString("hex")], "lock");
  const book = bookAddress(owner);
  assert.deepEqual(l.keys.map((k) => k.pubkey.toBase58()), [owner, payer, book, callAddress(book, 3), new PublicKey("11111111111111111111111111111111")].map((k) => k.toBase58()));
  assert.deepEqual(l.keys.map((k) => [k.isSigner, k.isWritable]), [[true, false], [true, true], [false, true], [false, true], [false, false]]);
  assert.equal(l.data.readBigUInt64LE(8), 3n);
  assert.equal(l.data.readUInt32LE(48), 600);
  for (const [i, name] of [[revealIx({ revealer: payer, owner, callId: 0, coin: "SOL", side: 1, salt: Buffer.alloc(32) }), "reveal"],
    [setProfileIx({ owner }), "set_profile"],
    [writeScoreIx({ validator: payer, owner, score: 1, calls: 0, revealed: 0, withheld: 0, throughCall: 0, reportHash: Buffer.alloc(32) }), "write_score"]]) {
    assert.equal(INSTRUCTIONS[i.data.subarray(0, 8).toString("hex")], name);
    assert.ok(i.programId.equals(ARENA_PROGRAM_ID));
  }
});

// A real Revealed event logged by the program (coin SOL, side 1, horizon 3600).
const REVEALED = "tAfHWJoTtZr+CifPl8RdY8iTaE6ivQvcFJqj2sHFMoUA9FPiIBNIILjgyX1cClPyWL25Xft/51HtviNXv9TWsvTBkJ49mrrpAAAAAAAAAAADAAAAU09MARAOAACTPZdQVD5pSn6uXfb0BaOs9QkmddsYjDXB9yA8T1yG0IfgSWsAAAAA";

test("events decode from real program logs, with the salt", () => {
  const e = decodeEvent(Buffer.from(REVEALED, "base64"));
  assert.equal(e.name, "Revealed");
  assert.equal(e.coin, "SOL");
  assert.equal(e.side, 1);
  assert.equal(e.horizon, 3600);
  assert.equal(e.callId, 0);
  assert.equal(e.salt.length, 32);
});

test("only events logged by the Arena program itself count", () => {
  const id = ARENA_PROGRAM_ID.toBase58();
  const other = Keypair.generate().publicKey.toBase58();
  const logs = [
    `Program ${id} invoke [1]`, "Program log: Instruction: Reveal", `Program data: ${REVEALED}`, `Program ${id} success`,
    `Program ${other} invoke [1]`, `Program data: ${REVEALED}`, `Program ${other} success`, // a forgery by another program
    `Program ${other} invoke [1]`, `Program ${id} invoke [2]`, `Program data: ${REVEALED}`, `Program ${id} success`, `Program ${other} success`, // Arena by CPI: real
  ];
  assert.equal(eventsFromLogs(logs).length, 2);
});

test("accounts decode by discriminator; anything else is null", () => {
  const data = Buffer.concat([accountDiscriminator("Book"), Buffer.from([1, 254]), Buffer.alloc(32, 3), Buffer.from([5, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([9, 0, 0, 0, 0, 0, 0, 0])]);
  const b = decodeAccount(data);
  assert.equal(b.type, "Book");
  assert.equal(b.lockCount, 5);
  assert.equal(b.openedAt, 9);
  assert.equal(decodeAccount(Buffer.alloc(60)), null);
});

test("confirming by polling: confirmed, failed, and expired", async () => {
  const { confirmByPolling } = await import("../arena.js");
  const conn = (status, height = 0) => ({ getSignatureStatuses: async () => ({ value: [status] }), getBlockHeight: async () => height });
  assert.equal((await confirmByPolling(conn({ confirmationStatus: "confirmed", err: null }), "s", 10, { everyMs: 1 })).confirmationStatus, "confirmed");
  await assert.rejects(confirmByPolling(conn({ confirmationStatus: "confirmed", err: { InstructionError: [0, "x"] } }), "s", 10, { everyMs: 1 }), /failed/);
  await assert.rejects(confirmByPolling(conn(null, 11), "s", 10, { everyMs: 1 }), (e) => e.expired === true);
});
