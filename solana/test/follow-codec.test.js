// solana/follow.js agrees with the follow program: instruction bytes and a
// Follow account written by the program itself (fixtures from
// crates/arena-tests/tests/follow.rs; run cargo test -p arena-tests first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

import { decodeFollowAccount, subscribeIx, isCopyable, followAddress, SIZE_FIXED, MONTH } from "../follow.js";

const dir = new URL("../../target/fixtures/", import.meta.url).pathname;
const have = existsSync(`${dir}follow-account.bin`);
const USDC = 1_000_000n;
const settings = { sizeMode: SIZE_FIXED, sizeValue: 100n * USDC, maxTrade: 250n * USDC, maxOpen: 3, dailyLossCap: 50n * USDC, subAccountId: 1 };

test("subscribe's data matches Anchor's encoding", { skip: !have && "fixtures missing: cargo test -p arena-tests" }, () => {
  const k = () => Keypair.generate().publicKey;
  const ix = subscribeIx({ follower: k(), config: k(), agent: k(), followerToken: k(), payout: k(), treasury: k(), months: 3, settings });
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
  assert.ok(isCopyable(f, keys.paidUntil - 1));
  assert.ok(!isCopyable(f, keys.paidUntil), "lapsed the second it's due");
  assert.ok(!isCopyable({ ...f, active: false }, 0), "stopped");
  assert.equal(followAddress(f.plan, f.follower).toBase58().length > 30, true);
  assert.equal(MONTH, 2_592_000);
});
