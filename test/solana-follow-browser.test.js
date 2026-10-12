// The browser codecs behind the Copy flow and the Following page:
//  - app/client/solana-follow-browser.js must build byte-for-byte the same
//    instructions as solana/follow.js (which the copier and the program tests use)
//    and decode the same accounts, without node:crypto;
//  - app/client/solana-velocity-browser.js must match Velocity's IDL and, when
//    copier/node_modules is installed, the SDK's own instruction builders and
//    account decoder.
// No network: every RPC-shaped thing here is local.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";

import * as node from "../solana/follow.js";
import * as web from "../app/client/solana-follow-browser.js";
import * as vel from "../app/client/solana-velocity-browser.js";

const key = (seed) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i) & 0xff)).publicKey;
const follower = key(1), agent = key(2), admin = key(3), payout = key(4), treasury = key(5), copier = key(6);
const config = node.configAddress(admin);
const settings = { sizeMode: 1, sizeValue: 2_500n, maxTrade: 150_000_000n, maxOpen: 4, dailyLossCap: 40_000_000n, subAccountId: 2 };

const sameIx = (a, b) => {
  assert.equal(a.programId.toBase58(), b.programId.toBase58());
  assert.deepEqual(a.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), b.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
  assert.equal(Buffer.from(a.data).toString("hex"), Buffer.from(b.data).toString("hex"));
};

describe("follow program: browser codec = solana/follow.js", () => {
  test("program ids, mint and addresses", () => {
    assert.equal(web.FOLLOW_PROGRAM_ID.toBase58(), node.FOLLOW_PROGRAM_ID.toBase58());
    assert.equal(web.TOKEN_PROGRAM_ID.toBase58(), node.TOKEN_PROGRAM_ID.toBase58());
    assert.equal(web.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), node.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    assert.equal(web.DEVNET_USDC.toBase58(), node.DEVNET_USDC.toBase58());
    assert.equal(web.configAddress(admin).toBase58(), config.toBase58());
    const plan = node.planAddress(config, agent);
    assert.equal(web.planAddress(config, agent).toBase58(), plan.toBase58());
    assert.equal(web.followAddress(plan, follower).toBase58(), node.followAddress(plan, follower).toBase58());
    assert.equal(web.associatedTokenAddress(follower, node.DEVNET_USDC).toBase58(), node.associatedTokenAddress(follower, node.DEVNET_USDC).toBase58());
  });

  test("the precomputed discriminators are Anchor's", () => {
    const sha = (s) => [...createHash("sha256").update(s).digest().subarray(0, 8)];
    for (const [name, d] of Object.entries(web.IX_DISCRIMINATORS)) assert.deepEqual(d, sha(`global:${name}`), name);
    for (const [name, d] of Object.entries(web.ACCOUNT_DISCRIMINATORS)) {
      assert.deepEqual(d, sha(`account:${name}`), name);
      assert.deepEqual([...web.accountDiscriminator(name)], [...node.accountDiscriminator(name)]);
    }
    assert.equal(web.FOLLOW_DISCRIMINATOR_B58, bs58.encode(node.accountDiscriminator("Follow")));
  });

  test("subscribe, with the plan terms the follower saw", () => {
    const args = { follower, config, agent, followerToken: node.associatedTokenAddress(follower, node.DEVNET_USDC), payout, treasury, months: 3, settings, maxPrice: 9_990_000n, maxPerfFeeBps: 1500 };
    sameIx(web.subscribeIx(args), node.subscribeIx(args));
    sameIx(web.subscribeIx({ ...args, settings: { ...settings, sizeMode: 0, sizeValue: 25_000_000n }, months: 12, maxPrice: 0, maxPerfFeeBps: 0 }),
      node.subscribeIx({ ...args, settings: { ...settings, sizeMode: 0, sizeValue: 25_000_000n }, months: 12, maxPrice: 0, maxPerfFeeBps: 0 }));
  });

  test("stop and update_settings", () => {
    const plan = node.planAddress(config, agent);
    sameIx(web.stopIx({ follower, plan }), node.stopIx({ follower, plan }));
    sameIx(web.updateSettingsIx({ follower, plan, settings }), node.updateSettingsIx({ follower, plan, settings }));
  });

  test("SPL approve and create-ATA-idempotent", () => {
    const account = node.associatedTokenAddress(follower, node.DEVNET_USDC);
    const delegate = node.followAddress(node.planAddress(config, agent), follower);
    sameIx(web.approveIx({ account, delegate, owner: follower, amount: 123_456_789n }), node.approveIx({ account, delegate, owner: follower, amount: 123_456_789n }));
    sameIx(web.createAssociatedTokenAccountIx({ payer: follower, owner: follower, mint: node.DEVNET_USDC }), node.createAssociatedTokenAccountIx({ payer: follower, owner: follower, mint: node.DEVNET_USDC }));
  });

  test("accounts decode the same, and the follower sits at byte 42", () => {
    const u8 = (n) => Buffer.from([n]);
    const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
    const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
    const plan = node.planAddress(config, agent);
    const followData = Buffer.concat([node.accountDiscriminator("Follow"), u8(1), u8(254), plan.toBuffer(), follower.toBuffer(), i64(1_800_000_000), u8(1),
      node.encodeSettings(settings), u16(1500), u8(1), i64(-12_345), u64(29_970_000), u64(1_000_000), u32(2), i64(1_799_000_000), i64(1_790_000_000)]);
    const planData = Buffer.concat([node.accountDiscriminator("Plan"), u8(1), u8(250), config.toBuffer(), agent.toBuffer(), payout.toBuffer(), u64(9_990_000), u16(1500), u8(1), i64(1_700_000_000)]);
    const configData = Buffer.concat([node.accountDiscriminator("Config"), u8(1), u8(251), admin.toBuffer(), node.DEVNET_USDC.toBuffer(), treasury.toBuffer(), u16(2000), u16(2500)]);
    for (const data of [followData, planData, configData]) {
      const a = web.decodeFollowAccount(data), b = node.decodeFollowAccount(data);
      assert.ok(a && b);
      assert.equal(JSON.stringify(a, (_, v) => (typeof v === "bigint" ? `${v}n` : v)), JSON.stringify(b, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));
    }
    assert.equal(new PublicKey(followData.subarray(web.FOLLOW_FOLLOWER_OFFSET, web.FOLLOW_FOLLOWER_OFFSET + 32)).toBase58(), follower.toBase58());
    assert.equal(web.FOLLOW_PLAN_OFFSET, node.FOLLOW_PLAN_OFFSET);
    const filters = web.followsOfFollowerFilters(follower);
    assert.deepEqual(filters[1], { memcmp: { offset: 42, bytes: follower.toBase58() } });
    assert.equal(web.decodeFollowAccount(Buffer.alloc(40)), null);
    assert.equal(web.isCopyable(web.decodeFollowAccount(followData), 1_799_999_999), true);
    assert.equal(web.isCopyable(web.decodeFollowAccount(followData), 1_800_000_000), false);
  });

  test("followsOfFollower asks for Follow accounts with this follower", async () => {
    const plan = node.planAddress(config, agent);
    let asked = null;
    const data = Buffer.concat([node.accountDiscriminator("Follow"), Buffer.from([1, 1]), plan.toBuffer(), follower.toBuffer(), Buffer.alloc(8), Buffer.from([1]),
      node.encodeSettings(settings), Buffer.alloc(2), Buffer.alloc(1 + 8 + 8 + 8 + 4 + 8 + 8)]);
    const connection = { getProgramAccounts: async (pid, opts) => { asked = { pid, opts }; return [{ pubkey: key(9), account: { data } }]; } };
    const rows = await web.followsOfFollower(connection, follower);
    assert.equal(asked.pid.toBase58(), node.FOLLOW_PROGRAM_ID.toBase58());
    assert.deepEqual(asked.opts.filters.map((f) => f.memcmp.offset), [0, 42]);
    assert.equal(rows[0].follower.toBase58(), follower.toBase58());
    assert.equal(rows[0].settings.subAccountId, 2);
  });
});

describe("settings, as programs/follow Settings::check", () => {
  const ok = { sizeMode: 0, sizeValue: 1n, maxTrade: 1n, maxOpen: 1, dailyLossCap: 1n, subAccountId: 1 };
  test("valid settings pass", () => {
    assert.deepEqual(web.settingsProblems(ok), []);
    assert.deepEqual(web.settingsProblems({ ...ok, sizeMode: 1, sizeValue: 10_000n, maxOpen: 10 }), []);
  });
  test("each rule is enforced", () => {
    const bad = (over) => web.settingsProblems({ ...ok, ...over });
    assert.equal(bad({ sizeMode: 2 }).length, 1, "size mode is 0 or 1");
    assert.equal(bad({ sizeValue: 0n }).length, 1, "a fixed size above 0");
    assert.equal(bad({ sizeMode: 1, sizeValue: 10_001n }).length, 1, "a percentage at most 10000 bps");
    assert.equal(bad({ sizeMode: 1, sizeValue: 0n }).length, 1);
    assert.equal(bad({ maxOpen: 0 }).length, 1, "max open 1..10");
    assert.equal(bad({ maxOpen: 11 }).length, 1);
    assert.equal(bad({ subAccountId: 0 }).length, 1, "never the main subaccount");
    assert.equal(bad({ maxTrade: 0n }).length, 1, "max trade above 0");
    assert.equal(bad({ dailyLossCap: 0n }).length, 1, "daily loss cap above 0");
  });
  test("the form's dollars and percent become program units", () => {
    assert.equal(web.toUnits("12.5"), 12_500_000n);
    assert.equal(web.toUnits("0.0000019"), 1n, "extra decimals are cut, not rounded");
    assert.equal(web.toUnits("-1"), null);
    assert.equal(web.toUnits("1e3"), null);
    assert.equal(web.fromUnits(12_500_000n), "12.5");
    assert.equal(web.fromUnits(-1_000_000n), "-1");
    const s = web.settingsFromForm({ sizeMode: "percent", sizePercent: "5.25", maxTradeUsd: "100", maxOpen: "3", dailyLossUsd: "50", subAccountId: 2 });
    assert.deepEqual(s, { sizeMode: 1, sizeValue: 525n, maxTrade: 100_000_000n, maxOpen: 3, dailyLossCap: 50_000_000n, subAccountId: 2 });
    assert.deepEqual(web.settingsProblems(s), []);
    const f = web.settingsFromForm({ sizeMode: "fixed", sizeUsd: "25", maxTradeUsd: "x", maxOpen: "3", dailyLossUsd: "50", subAccountId: 2 });
    assert.equal(f.sizeValue, 25_000_000n);
    assert.equal(web.settingsProblems(f).length, 1, "an unreadable max trade is caught");
  });
});

// ------------------------------------------------------------------ Velocity

const SDK_DIR = fileURLToPath(new URL("../copier/node_modules/@velocity-exchange/sdk/", import.meta.url));
const IDL_PATH = `${SDK_DIR}lib/browser/idl/velocity.json`;
const haveSdk = existsSync(IDL_PATH);

describe("Velocity: browser codec = IDL and SDK", { skip: haveSdk ? false : "copier/node_modules isn't installed" }, () => {
  const idl = haveSdk ? JSON.parse(readFileSync(IDL_PATH, "utf8")) : null;
  const type = (n) => idl.types.find((t) => t.name === n);
  const P = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };
  const size = (t) => {
    if (typeof t === "string") return P[t];
    if (t.array) return size(t.array[0]) * t.array[1];
    const d = type(t.defined.name);
    return d.type.kind === "enum" ? 1 : d.type.fields.reduce((s, f) => s + size(f.type), 0);
  };
  const offsets = (name, start) => {
    let at = start; const out = {};
    for (const f of type(name).type.fields) { out[f.name] = at; at += size(f.type); }
    out.size = at;
    return out;
  };

  test("program id, discriminators and account flags are the IDL's", () => {
    assert.equal(vel.VELOCITY_PROGRAM_ID.toBase58(), idl.address);
    for (const [name, d] of Object.entries(vel.VELOCITY_IX)) assert.deepEqual(d, idl.instructions.find((i) => i.name === name).discriminator, name);
    for (const [name, d] of Object.entries(vel.VELOCITY_ACCOUNT)) assert.deepEqual(d, idl.accounts.find((a) => a.name === name).discriminator, name);
    const a = key(11);
    const built = {
      initialize_user_stats: vel.initializeUserStatsIx({ authority: a }),
      initialize_user: vel.initializeUserIx({ authority: a, subAccountId: 1, name: "Reins copy" }),
      update_user_delegate: vel.updateUserDelegateIx({ authority: a, subAccountId: 1, delegate: copier }),
      deposit: vel.depositIx({ authority: a, subAccountId: 1, amount: 1n, userTokenAccount: key(12), oracle: key(13) }),
    };
    for (const [name, ix] of Object.entries(built)) {
      const spec = idl.instructions.find((i) => i.name === name).accounts;
      spec.forEach((s, i) => {
        assert.equal(ix.keys[i].isWritable, Boolean(s.writable), `${name}.${s.name} writable`);
        assert.equal(ix.keys[i].isSigner, Boolean(s.signer), `${name}.${s.name} signer`);
        if (s.address) assert.equal(ix.keys[i].pubkey.toBase58(), s.address, `${name}.${s.name}`);
      });
      assert.ok(ix.keys.length >= spec.length);
    }
  });

  test("account offsets are the IDL's", () => {
    const u = offsets("User", 8), us = offsets("UserStats", 8), pp = offsets("PerpPosition", 0), sp = offsets("SpotPosition", 0), sm = offsets("SpotMarket", 8), st = offsets("State", 8);
    for (const [k, v] of Object.entries(vel.OFFSETS.User)) assert.equal(v, u[k], `User.${k}`);
    for (const [k, v] of Object.entries(vel.OFFSETS.UserStats)) assert.equal(v, us[k], `UserStats.${k}`);
    for (const [k, v] of Object.entries(vel.OFFSETS.PerpPosition)) assert.equal(v, pp[k], `PerpPosition.${k}`);
    for (const [k, v] of Object.entries(vel.OFFSETS.SpotPosition)) assert.equal(v, sp[k], `SpotPosition.${k}`);
    for (const [k, v] of Object.entries(vel.OFFSETS.SpotMarket)) assert.equal(v, sm[k], `SpotMarket.${k}`);
    assert.equal(vel.OFFSETS.State.whitelist_mint, st.whitelist_mint);
  });

  test("instruction bytes equal the SDK's builders", async () => {
    const require = createRequire(`${SDK_DIR}package.json`);
    const sdk = require("@velocity-exchange/sdk");
    const kp = Keypair.fromSeed(new Uint8Array(32).fill(7)), authority = kp.publicKey;
    const client = new sdk.VelocityClient({ connection: { rpcEndpoint: "http://127.0.0.1:9", commitment: "confirmed" }, wallet: new sdk.Wallet(kp), env: "devnet" });
    const pid = client.program.programId;
    assert.equal(pid.toBase58(), vel.VELOCITY_PROGRAM_ID.toBase58());

    sameIx(vel.initializeUserStatsIx({ authority }), await client.getInitializeUserStatsIx());
    client.getStateAccount = () => ({ whitelistMint: PublicKey.default });
    sameIx(vel.initializeUserIx({ authority, subAccountId: 3, name: "Reins copy" }), (await client.getInitializeUserInstructions(3, "Reins copy"))[1]);
    sameIx(vel.initializeUserIx({ authority, subAccountId: 0, name: "Main Account" }), (await client.getInitializeUserInstructions(0))[1]);
    const wl = key(20);
    client.getStateAccount = () => ({ whitelistMint: wl });
    sameIx(vel.initializeUserIx({ authority, subAccountId: 1, name: "Reins copy", whitelistMint: wl }), (await client.getInitializeUserInstructions(1, "Reins copy"))[1]);

    for (const delegate of [copier, PublicKey.default]) {
      sameIx(vel.updateUserDelegateIx({ authority, subAccountId: 5, delegate }),
        await client.getUpdateUserDelegateIx(delegate, { subAccountId: 5, userAccountPublicKey: sdk.getUserAccountPublicKeySync(pid, authority, 5) }));
    }

    // Deposit into a subaccount with no positions: remaining accounts are the quote market's oracle and the market itself.
    const oracle = key(21), vault = sdk.getSpotMarketVaultPublicKeySync ? sdk.getSpotMarketVaultPublicKeySync(pid, 0) : vel.spotMarketVaultAddress(0);
    const ata = vel.quoteTokenAccount(authority);
    const ref = await sdk.VelocityCore.buildDepositInstruction({
      program: client.program, marketIndex: 0, amount: new sdk.BN(25_000_000), reduceOnly: false,
      state: await client.getStatePublicKey(), spotMarket: sdk.getSpotMarketPublicKeySync(pid, 0), spotMarketVault: vault,
      user: sdk.getUserAccountPublicKeySync(pid, authority, 2), userStats: sdk.getUserStatsAccountPublicKey(pid, authority), userTokenAccount: ata, authority,
      tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      remainingAccounts: [{ pubkey: oracle, isSigner: false, isWritable: false }, { pubkey: sdk.getSpotMarketPublicKeySync(pid, 0), isSigner: false, isWritable: true }],
    });
    sameIx(vel.depositIx({ authority, subAccountId: 2, amount: 25_000_000n, userTokenAccount: ata, oracle, vault }), ref);
    assert.throws(() => vel.depositIx({ authority, subAccountId: 2, amount: 1n, userTokenAccount: ata, oracle, tokenProgram: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") }), /Token-2022/);
    assert.equal(vel.spotMarketVaultAddress(0).toBase58(), vault.toBase58());
    assert.equal(vel.DEVNET_QUOTE.mint, sdk.DevnetSpotMarkets[0].mint.toBase58());
    assert.deepEqual(Object.values(vel.DEVNET_PERP_MARKETS), sdk.DevnetPerpMarkets.map((m) => m.baseAssetSymbol));
  });

  test("a User account decodes like the SDK's decodeUser", () => {
    const require = createRequire(`${SDK_DIR}package.json`);
    const sdk = require("@velocity-exchange/sdk");
    const O = vel.OFFSETS, b = Buffer.alloc(O.User.size);
    Buffer.from(vel.VELOCITY_ACCOUNT.User).copy(b, 0);
    key(30).toBuffer().copy(b, O.User.authority);
    copier.toBuffer().copy(b, O.User.delegate);
    vel.encodeName("Reins copy").copy(b, O.User.name);
    const pp = O.User.perp_positions + 2 * O.PerpPosition.size; // the third slot
    b.writeBigInt64LE(-2_500_000_000n, pp + O.PerpPosition.base_asset_amount);
    b.writeBigInt64LE(250_000_000n, pp + O.PerpPosition.quote_asset_amount);
    b.writeBigInt64LE(249_000_000n, pp + O.PerpPosition.quote_break_even_amount);
    b.writeBigInt64LE(250_000_000n, pp + O.PerpPosition.quote_entry_amount);
    b.writeUInt16LE(1, pp + O.PerpPosition.market_index);
    b.writeBigUInt64LE(500_000_000n, O.User.total_deposits);
    b.writeBigUInt64LE(100_000_000n, O.User.total_withdraws);
    b.writeBigInt64LE(-7_000_000n, O.User.settled_perp_pnl);
    b.writeUInt16LE(4, O.User.sub_account_id);
    b.writeUInt8(2, O.User.open_orders);

    const mine = vel.decodeUser(b), theirs = sdk.decodeUser(b);
    assert.equal(mine.authority.toBase58(), theirs.authority.toBase58());
    assert.equal(mine.delegate.toBase58(), theirs.delegate.toBase58());
    assert.equal(mine.name, sdk.decodeName(theirs.name));
    assert.equal(mine.subAccountId, theirs.subAccountId);
    assert.equal(mine.openOrders, theirs.openOrders);
    assert.equal(String(mine.totalDeposits), theirs.totalDeposits.toString());
    assert.equal(String(mine.totalWithdraws), theirs.totalWithdraws.toString());
    assert.equal(String(mine.settledPerpPnl), theirs.settledPerpPnl.toString());
    const tp = theirs.perpPositions.find((p) => !p.baseAssetAmount.isZero());
    assert.equal(mine.perpPositions.length, 1);
    const [p] = mine.perpPositions;
    assert.equal(p.marketIndex, tp.marketIndex);
    assert.equal(String(p.baseAssetAmount), tp.baseAssetAmount.toString());
    assert.equal(String(p.quoteAssetAmount), tp.quoteAssetAmount.toString());
    assert.equal(String(p.quoteEntryAmount), tp.quoteEntryAmount.toString());
    assert.equal(String(p.quoteBreakEvenAmount), tp.quoteBreakEvenAmount.toString());
    // A 2.5 BTC short entered at $100, marked at $90: +$25 before funding.
    const v = vel.positionView(p, 90);
    assert.equal(v.coin, "BTC"); assert.equal(v.side, "short"); assert.equal(v.size, 2.5); assert.equal(v.entry, 100);
    assert.ok(Math.abs(v.pnl - 25) < 1e-9);
  });

  test("PDAs match the SDK's", () => {
    const require = createRequire(`${SDK_DIR}package.json`);
    const sdk = require("@velocity-exchange/sdk");
    const a = key(40), pid = vel.VELOCITY_PROGRAM_ID;
    assert.equal(vel.userAddress(a, 7).toBase58(), sdk.getUserAccountPublicKeySync(pid, a, 7).toBase58());
    assert.equal(vel.userStatsAddress(a).toBase58(), sdk.getUserStatsAccountPublicKey(pid, a).toBase58());
    assert.equal(vel.spotMarketAddress(0).toBase58(), sdk.getSpotMarketPublicKeySync(pid, 0).toBase58());
    assert.deepEqual([...vel.encodeName("Reins copy")], sdk.encodeName("Reins copy"));
  });
});

describe("Velocity: which copy subaccount to use", () => {
  const stats = (n) => ({ numberOfSubAccountsCreated: n, numberOfSubAccounts: n });
  const user = (id, delegate) => ({ subAccountId: id, delegate });
  test("a wallet new to Velocity gets stats, main #0 and copy #1", () => {
    assert.deepEqual(vel.planCopyAccount({ stats: null, copier }), { subAccountId: 1, createStats: true, createMain: true, createCopy: true, setDelegate: true });
  });
  test("an existing account gets the next id", () => {
    assert.deepEqual(vel.planCopyAccount({ stats: stats(3), users: [user(0, PublicKey.default), user(1, key(50)), user(2, PublicKey.default)], copier }),
      { subAccountId: 3, createStats: false, createMain: false, createCopy: true, setDelegate: true });
  });
  test("a subaccount already delegated to the copier is reused, never #0", () => {
    assert.equal(vel.planCopyAccount({ stats: stats(3), users: [user(0, copier), user(1, PublicKey.default), user(2, copier)], copier }).subAccountId, 2);
    assert.equal(vel.planCopyAccount({ stats: stats(1), users: [user(0, copier)], copier }).subAccountId, 1);
  });
  test("names are 32 plain characters", () => {
    assert.equal(vel.encodeName("Reins copy").length, 32);
    assert.throws(() => vel.encodeName("x".repeat(33)));
    assert.equal(vel.decodeName(vel.encodeName("Reins copy")), "Reins copy");
  });
});
