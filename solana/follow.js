/**
 * The follow program (subscriptions to agents, programs/follow) from
 * JavaScript: addresses, instructions, and account decoders. Shared by the
 * copier and the app, like solana/arena.js for the Arena program.
 */
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const FOLLOW_PROGRAM_ID = new PublicKey("A5Zpb539Yazb3kypH7tvZBVWuGCdCwXU6sdVU8RkgJHC");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** Circle's devnet USDC. */
export const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

export const MONTH = 30 * 86_400;
export const MAX_MONTHS = 12;
export const MAX_OPEN_COPIED = 10;
export const SIZE_FIXED = 0;
export const SIZE_PERCENT = 1;

const disc = (kind, name) => createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);
const pk = (k) => (k instanceof PublicKey ? k : new PublicKey(k));

// ------------------------------------------------------------------ addresses

export const configAddress = (admin, programId = FOLLOW_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("config"), pk(admin).toBuffer()], programId)[0];
export const planAddress = (config, agent, programId = FOLLOW_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("plan"), pk(config).toBuffer(), pk(agent).toBuffer()], programId)[0];
export const followAddress = (plan, follower, programId = FOLLOW_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([Buffer.from("follow"), pk(plan).toBuffer(), pk(follower).toBuffer()], programId)[0];

// ------------------------------------------------------------------ borsh

const u8 = (n) => Buffer.from([n & 0xff]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

class Reader {
  constructor(buf, at = 0) { this.b = Buffer.from(buf); this.at = at; }
  u8() { return this.b.readUInt8(this.at++); }
  bool() { return this.u8() !== 0; }
  u16() { const v = this.b.readUInt16LE(this.at); this.at += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.at); this.at += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.at); this.at += 8; return v; }
  i64() { const v = this.b.readBigInt64LE(this.at); this.at += 8; return v; }
  key() { const v = new PublicKey(this.b.subarray(this.at, this.at + 32)); this.at += 32; return v; }
}

/** Settings as the program stores them. Amounts are BigInt-able integers in the quote's smallest unit. */
export function encodeSettings({ sizeMode, sizeValue, maxTrade, maxOpen, dailyLossCap, subAccountId }) {
  return Buffer.concat([u8(sizeMode), u64(sizeValue), u64(maxTrade), u8(maxOpen), u64(dailyLossCap), u16(subAccountId)]);
}
const readSettings = (r) => ({ sizeMode: r.u8(), sizeValue: r.u64(), maxTrade: r.u64(), maxOpen: r.u8(), dailyLossCap: r.u64(), subAccountId: r.u16() });

// ------------------------------------------------------------------ token accounts

/** The associated token account of `owner` for `mint`. */
export const associatedTokenAddress = (owner, mint) =>
  PublicKey.findProgramAddressSync([pk(owner).toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), pk(mint).toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];

/** Create it if missing (CreateIdempotent): safe to include every time. */
export function createAssociatedTokenAccountIx({ payer, owner, mint }) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: pk(payer), isSigner: true, isWritable: true }, { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: pk(owner), isSigner: false, isWritable: false }, { pubkey: pk(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** SPL Token Approve: let `delegate` (a Follow account) take up to `amount` from `account` for performance fees. */
export function approveIx({ account, delegate, owner, amount }) {
  const data = Buffer.alloc(9);
  data.writeUInt8(4, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: pk(account), isSigner: false, isWritable: true }, { pubkey: pk(delegate), isSigner: false, isWritable: false }, { pubkey: pk(owner), isSigner: true, isWritable: false }],
    data,
  });
}

// ------------------------------------------------------------------ instructions

const ix = (name, keys, data, programId) => new TransactionInstruction({ programId, keys, data: Buffer.concat([disc("global", name), data]) });
const signer = (k, w = false) => ({ pubkey: pk(k), isSigner: true, isWritable: w });
const acct = (k, w = false) => ({ pubkey: pk(k), isSigner: false, isWritable: w });

export function initConfigIx({ admin, mint, treasury, reinsBps, perfReinsBps, programId = FOLLOW_PROGRAM_ID }) {
  return ix("init_config", [signer(admin, true), acct(mint), acct(treasury), acct(configAddress(admin, programId), true), acct(SystemProgram.programId)],
    Buffer.concat([u16(reinsBps), u16(perfReinsBps)]), programId);
}

export function setPlanIx({ agent, payer = agent, config, payout, price, perfFeeBps, open = true, programId = FOLLOW_PROGRAM_ID }) {
  return ix("set_plan", [signer(agent), signer(payer, true), acct(config), acct(payout), acct(planAddress(config, agent, programId), true), acct(SystemProgram.programId)],
    Buffer.concat([u64(price), u16(perfFeeBps), u8(open ? 1 : 0)]), programId);
}

/** `treasury` and `payout` come from the Config and Plan accounts. */
export function subscribeIx({ follower, config, agent, followerToken, payout, treasury, months, settings, programId = FOLLOW_PROGRAM_ID }) {
  const plan = planAddress(config, agent, programId);
  return ix("subscribe", [
    signer(follower, true), acct(config), acct(plan), acct(followAddress(plan, follower, programId), true), acct(followerToken, true),
    acct(payout, true), acct(treasury, true), acct(TOKEN_PROGRAM_ID), acct(SystemProgram.programId),
  ], Buffer.concat([u8(months), encodeSettings(settings)]), programId);
}

export function updateSettingsIx({ follower, plan, settings, programId = FOLLOW_PROGRAM_ID }) {
  return ix("update_settings", [signer(follower), acct(followAddress(plan, follower, programId), true)], encodeSettings(settings), programId);
}

export function stopIx({ follower, plan, programId = FOLLOW_PROGRAM_ID }) {
  return ix("stop", [signer(follower), acct(followAddress(plan, follower, programId), true)], Buffer.alloc(0), programId);
}

export function settlePerformanceIx({ admin, config, plan, follower, followerToken, payout, treasury, pnl, reportHash, programId = FOLLOW_PROGRAM_ID }) {
  return ix("settle_performance", [
    signer(admin), acct(config), acct(plan), acct(followAddress(plan, follower, programId), true), acct(followerToken, true),
    acct(payout, true), acct(treasury, true), acct(TOKEN_PROGRAM_ID),
  ], Buffer.concat([i64(pnl), Buffer.from(reportHash)]), programId);
}

// ------------------------------------------------------------------ accounts

const ACCOUNTS = {
  Config: (r) => ({ version: r.u8(), bump: r.u8(), admin: r.key(), mint: r.key(), treasury: r.key(), reinsBps: r.u16(), perfReinsBps: r.u16() }),
  Plan: (r) => ({ version: r.u8(), bump: r.u8(), config: r.key(), agent: r.key(), payout: r.key(), price: r.u64(), perfFeeBps: r.u16(), open: r.bool(), createdAt: Number(r.i64()) }),
  Follow: (r) => ({
    version: r.u8(), bump: r.u8(), plan: r.key(), follower: r.key(), paidUntil: Number(r.i64()), active: r.bool(), settings: readSettings(r),
    hwmSet: r.bool(), hwm: r.i64(), totalPaid: r.u64(), perfFeesPaid: r.u64(), settlements: r.u32(), lastSettledAt: Number(r.i64()), createdAt: Number(r.i64()),
  }),
};
const BY_DISC = Object.fromEntries(Object.keys(ACCOUNTS).map((n) => [disc("account", n).toString("hex"), n]));
export const accountDiscriminator = (name) => disc("account", name);

export function decodeFollowAccount(data) {
  const b = Buffer.from(data);
  const type = BY_DISC[b.subarray(0, 8).toString("hex")];
  return type ? { type, ...ACCOUNTS[type](new Reader(b, 8)) } : null;
}

/** The copier's rule: it trades only for a follow that is active and paid up. */
export const isCopyable = (follow, nowSec) => Boolean(follow?.active) && follow.paidUntil > nowSec;

/** Byte offset of `plan` in a Follow account: discriminator, version, bump. */
export const FOLLOW_PLAN_OFFSET = 10;

/** Every Follow account under a plan, decoded: one getProgramAccounts call filtered on chain. */
export async function followsOfPlan(connection, plan, programId = FOLLOW_PROGRAM_ID) {
  const bs58 = (await import("bs58")).default;
  const rows = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("Follow")) } },
      { memcmp: { offset: FOLLOW_PLAN_OFFSET, bytes: pk(plan).toBase58() } },
    ],
  });
  return rows.map(({ pubkey, account }) => ({ address: pubkey, ...decodeFollowAccount(account.data) }));
}
