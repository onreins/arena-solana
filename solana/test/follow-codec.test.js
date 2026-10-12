// solana/follow.js agrees with the follow program: instruction bytes and a
// Follow account written by the program itself (fixtures from
// crates/arena-tests/tests/follow.rs; run cargo test -p arena-tests first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

import { decodeFollowAccount, subscribeIx, initConfigIx, setPlanIx, settlePerformanceIx, approveIx, associatedTokenAddress, DEVNET_USDC, isCopyable, followAddress, SIZE_FIXED, MONTH } from "../follow.js";

const dir = new URL("../../target/fixtures/", import.meta.url).pathname;
const have = existsSync(`${dir}follow-account.bin`);
const USDC = 1_000_000n;
const settings = { sizeMode: SIZE_FIXED, sizeValue: 100n * USDC, maxTrade: 250n * USDC, maxOpen: 3, dailyLossCap: 50n * USDC, subAccountId: 1 };

test("subscribe's data matches Anchor's encoding", { skip: !have && "fixtures missing: cargo test -p arena-tests" }, () => {
  const k = () => Keypair.generate().publicKey;
  const ix = subscribeIx({ follower: k(), config: k(), agent: k(), followerToken: k(), payout: k(), treasury: k(), months: 3, settings, maxPrice: 9_990_001n, maxPerfFeeBps: 2000 });
  assert.deepEqual(ix.data, readFileSync(`${dir}subscribe-data.bin`));
  assert.equal(ix.keys.length, 9);
});

test("a Follow account written by the program decodes", { skip: !have && "fixtures missing" }, () => {
  const keys = JSON.parse(readFileSync(`${dir}follow-keys.json`, "utf8"));
  const f = decodeFollowAccount(readFileSync(`${dir}follow-account.bin`));
  assert.equal(f.type, "Follow");
  assert.equal(f.plan.toBase58(), keys.plan);
  assert.equal(f.follower.toBase58(), keys.follower);
  assert.equal(f.paidUntil, keys.paidUntil);
  assert.equal(f.totalPaid, BigInt(keys.totalPaid));
  assert.equal(f.active, true);
  assert.deepEqual(f.settings, settings);
  assert.equal(f.hwmSet, false);
  assert.equal(f.perfFeeBps, 2000, "the rate agreed at subscribe time");
  assert.ok(isCopyable(f, keys.paidUntil - 1));
  assert.ok(!isCopyable(f, keys.paidUntil), "lapsed the second it's due");
  assert.ok(!isCopyable({ ...f, active: false }, 0), "stopped");
  assert.equal(followAddress(f.plan, f.follower).toBase58().length > 30, true);
  assert.equal(MONTH, 2_592_000);
});

test("init_config, set_plan and settle_performance match Anchor's encoding", { skip: !have && "fixtures missing" }, () => {
  const k = () => Keypair.generate().publicKey;
  assert.deepEqual(initConfigIx({ admin: k(), mint: k(), treasury: k(), reinsBps: 2000, perfReinsBps: 3000 }).data, readFileSync(`${dir}init-config-data.bin`));
  assert.deepEqual(setPlanIx({ agent: k(), config: k(), payout: k(), price: 9_990_001n, perfFeeBps: 2000, open: true }).data, readFileSync(`${dir}set-plan-data.bin`));
  const settle = settlePerformanceIx({ admin: k(), config: k(), plan: k(), follower: k(), followerToken: k(), payout: k(), treasury: k(), pnl: -5n, reportHash: Buffer.alloc(32, 4) });
  assert.deepEqual(settle.data, readFileSync(`${dir}settle-data.bin`));
});

test("token helpers: Approve's layout and the associated account address", () => {
  const owner = Keypair.generate().publicKey;
  const a = approveIx({ account: owner, delegate: owner, owner, amount: 5n });
  assert.deepEqual([...a.data], [4, 5, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(associatedTokenAddress(owner, DEVNET_USDC).equals(associatedTokenAddress(owner, DEVNET_USDC)));
});
