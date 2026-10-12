// Performance-fee settlement: the fee the settler expects is the program's
// rule, and a pass settles every follow under the config's plans with a
// report hash committing to what was measured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

import { expectedFee, settlementReport, settleAll } from "../src/settle.js";
import { accountDiscriminator, decodeFollowAccount } from "../../solana/follow.js";

const fixture = new URL("../../target/fixtures/follow-account.bin", import.meta.url).pathname;

test("the expected fee follows the program's high-water-mark rule", () => {
  // the same cases as programs/follow's unit test
  assert.equal(expectedFee({ hwmSet: false, hwm: 0n, pnl: 5_000n, perfFeeBps: 2000 }), 0n);
  assert.equal(expectedFee({ hwmSet: true, hwm: 5_000n, pnl: 4_000n, perfFeeBps: 2000 }), 0n);
  assert.equal(expectedFee({ hwmSet: true, hwm: 5_000n, pnl: 5_000n, perfFeeBps: 2000 }), 0n);
  assert.equal(expectedFee({ hwmSet: true, hwm: 5_000n, pnl: 6_000n, perfFeeBps: 2000 }), 200n);
  assert.equal(expectedFee({ hwmSet: true, hwm: -3_000n, pnl: -1_000n, perfFeeBps: 2000 }), 400n);
});

test("a settlement report is deterministic and names its source", () => {
  const a = settlementReport({ follow: "F", follower: "W", subAccountId: 1, pnl: 7n, at: 9 });
  assert.deepEqual(a, settlementReport({ follow: "F", follower: "W", subAccountId: 1, pnl: 7n, at: 9 }));
  assert.match(a.text, /getTotalAllTimePnl/);
  assert.equal(a.hash.length, 32);
});

test("a pass settles each follow under the config's plans", { skip: !existsSync(fixture) && "fixtures missing: cargo test -p arena-tests" }, async () => {
  const followData = readFileSync(fixture);
  const follow = decodeFollowAccount(followData);
  const config = Keypair.generate().publicKey, payout = Keypair.generate().publicKey;
  const plan = Buffer.alloc(8 + 1 + 1 + 32 * 3 + 8 + 2 + 1 + 8);
  accountDiscriminator("Plan").copy(plan, 0);
  config.toBuffer().copy(plan, 10);
  Keypair.generate().publicKey.toBuffer().copy(plan, 42);
  payout.toBuffer().copy(plan, 74);
  plan.writeUInt16LE(2000, 8 + 2 + 96 + 8);
  const planKey = follow.plan; // the fixture follow belongs to this plan
  const sent = [];
  const connection = {
    getProgramAccounts: async (_id, { filters }) => {
      const disc = filters[0].memcmp.bytes;
      if (disc === bs58.encode(accountDiscriminator("Plan"))) return [{ pubkey: planKey, account: { data: plan } }];
      return [{ pubkey: Keypair.generate().publicKey, account: { data: followData } }];
    },
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }),
    sendRawTransaction: async (raw) => (sent.push(Transaction.from(raw)), "sig"),
    getSignatureStatuses: async (sigs) => ({ value: sigs.map(() => ({ confirmationStatus: "confirmed", err: null })) }),
  };
  const admin = Keypair.generate();
  const rows = await settleAll({
    connection, admin, config, configAccount: { mint: Keypair.generate().publicKey, treasury: Keypair.generate().publicKey },
    pnlOf: async () => 12_000_000n, log: () => {},
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].first, true, "the fixture follow has no mark yet: this sets it");
  assert.equal(rows[0].fee, "0");
  assert.equal(rows[0].error, undefined, "settled and confirmed");
  assert.equal(rows[0].tx, "sig");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].instructions[0].data.readBigInt64LE(8), 12_000_000n);
  assert.ok(sent[0].instructions[0].keys[5].pubkey.equals(payout));
});
