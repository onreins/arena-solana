// Posting scores to Score accounts: the scorer's numbers go into write_score
// exactly, only for allowed owners, within the daily budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction } from "@solana/web3.js";

import { publishSolanaScores, scoreArgsOf, SCORE_RENT_LAMPORTS } from "../publish-scores.js";
import { INSTRUCTIONS, scoreAddress, bookAddress } from "../arena.js";

const chain = { address: "P", chainId: "solana-devnet", books: new Map(), validation: { requests: new Map(), responses: new Map() } };
const hash = `0x${"ab".repeat(32)}`;
const evFor = (owner, value = 72) => ({
  book: { id: 1, owner, locks: new Map([[0, {}], [1, {}], [2, {}], [3, {}]]) },
  scored: { metrics: { revealed: 2, withheld: 1, unscorable: 1 }, score: { value } },
  report: { hash },
});

function mockConnection({ existing = new Set() } = {}) {
  const c = { sent: [] };
  c.getAccountInfo = async (k) => (existing.has(k.toBase58()) ? { data: Buffer.alloc(0) } : null);
  c.getLatestBlockhash = async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 });
  c.sendRawTransaction = async (raw) => (c.sent.push(Transaction.from(raw)), `sig${c.sent.length}`);
  c.getSignatureStatuses = async (sigs) => ({ value: sigs.map(() => ({ confirmationStatus: "confirmed", err: null })) });
  return c;
}

test("the scorer's numbers become write_score's arguments", () => {
  const a = scoreArgsOf(evFor("X"));
  assert.deepEqual({ ...a, reportHash: a.reportHash.toString("hex") }, {
    score: 72, calls: 4, revealed: 2, withheld: 2, throughCall: 4, reportHash: "ab".repeat(32), scoring: "arena-v1",
  });
  assert.equal(scoreArgsOf(evFor("X", 101)), null);
  assert.equal(scoreArgsOf({ ...evFor("X"), scored: { metrics: {}, score: { value: null } } }), null);
});

test("an allowed book's score is written by the validator; others are skipped", async () => {
  const validator = Keypair.generate();
  const agent = Keypair.generate().publicKey.toBase58();
  const stranger = Keypair.generate().publicKey.toBase58();
  const connection = mockConnection();
  const rows = await publishSolanaScores({ chain, evaluated: [evFor(agent), evFor(stranger)], connection, validator, now: 1_800_000_000, allow: new Set([agent]) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tx, "sig1");
  const [tx] = connection.sent;
  assert.ok(tx.feePayer.equals(validator.publicKey));
  assert.ok(tx.verifySignatures());
  const [ix] = tx.instructions;
  assert.equal(INSTRUCTIONS[ix.data.subarray(0, 8).toString("hex")], "write_score");
  assert.ok(ix.keys[3].pubkey.equals(scoreAddress(validator.publicKey, bookAddress(agent))));
  assert.equal(ix.data[8], 72); // score
  assert.equal(ix.data.readUInt32LE(9), 4); // calls
});

test("the daily budget stops writes, counting rent only for a new account", async () => {
  const validator = Keypair.generate();
  const a = Keypair.generate().publicKey.toBase58(), b = Keypair.generate().publicKey.toBase58();
  const connection = mockConnection();
  const rows = await publishSolanaScores({
    chain, evaluated: [evFor(a), { ...evFor(b), book: { ...evFor(b).book, id: 2 } }], connection, validator, now: 1_800_000_000,
    allow: new Set([a, b]), budgetLamports: SCORE_RENT_LAMPORTS + 5_000,
  });
  assert.equal(connection.sent.length, 1);
  assert.equal(rows[1].why, "daily budget used up");
});

test("a dry run decides without sending", async () => {
  const validator = Keypair.generate();
  const a = Keypair.generate().publicKey.toBase58();
  const connection = mockConnection();
  const rows = await publishSolanaScores({ chain, evaluated: [evFor(a)], connection, validator, now: 1, allow: new Set([a]), dryRun: true });
  assert.equal(rows[0].due, true);
  assert.equal(connection.sent.length, 0);
});
