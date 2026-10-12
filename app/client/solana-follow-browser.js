/**
 * The follow program (programs/follow) for the browser: the same addresses,
 * instructions and account layouts as solana/follow.js, without node:crypto.
 * The Anchor discriminators (sha256("global:<ix>") and sha256("account:<Name>"),
 * first 8 bytes) are precomputed here; test/solana-follow-browser.test.js checks
 * every instruction's bytes against solana/follow.js for the same inputs.
 *
 * Bundled into app/public/vendor/solana-copy.js (npm run build:solana-copy).
 */
import { Buffer } from "buffer";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const FOLLOW_PROGRAM_ID = new PublicKey("A5Zpb539Yazb3kypH7tvZBVWuGCdCwXU6sdVU8RkgJHC");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** Circle's devnet USDC. */
export const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

export const MAX_MONTHS = 12;
export const MAX_OPEN_COPIED = 10;
export const SIZE_FIXED = 0;
export const SIZE_PERCENT = 1;
export const BPS = 10_000;

/** sha256("global:<name>")[0..8] */
export const IX_DISCRIMINATORS = Object.freeze({
  subscribe: [254, 28, 191, 138, 156, 179, 183, 53],
  update_settings: [81, 166, 51, 213, 158, 84, 157, 108],
  stop: [42, 133, 32, 60, 171, 253, 184, 155],
});
/** sha256("account:<Name>")[0..8] */
export const ACCOUNT_DISCRIMINATORS = Object.freeze({
  Config: [155, 12, 170, 224, 30, 250, 204, 130],
  Plan: [161, 231, 251, 119, 2, 12, 162, 2],
  Follow: [222, 247, 253, 60, 70, 4, 164, 51],
});

const pk = (k) => (k instanceof PublicKey ? k : new PublicKey(k));
const utf8 = (s) => Buffer.from(s, "utf8");

// ------------------------------------------------------------------ addresses

export const configAddress = (admin, programId = FOLLOW_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([utf8("config"), pk(admin).toBuffer()], programId)[0];
export const planAddress = (config, agent, programId = FOLLOW_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([utf8("plan"), pk(config).toBuffer(), pk(agent).toBuffer()], programId)[0];
export const followAddress = (plan, follower, programId = FOLLOW_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([utf8("follow"), pk(plan).toBuffer(), pk(follower).toBuffer()], programId)[0];

// ------------------------------------------------------------------ borsh

const u8 = (n) => Buffer.from([Number(n) & 0xff]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(Number(n)); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

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

/** Settings as the program stores them (programs/follow Settings). Amounts are integers in the quote's smallest unit. */
export function encodeSettings({ sizeMode, sizeValue, maxTrade, maxOpen, dailyLossCap, subAccountId }) {
  return Buffer.concat([u8(sizeMode), u64(sizeValue), u64(maxTrade), u8(maxOpen), u64(dailyLossCap), u16(subAccountId)]);
}
const readSettings = (r) => ({ sizeMode: r.u8(), sizeValue: r.u64(), maxTrade: r.u64(), maxOpen: r.u8(), dailyLossCap: r.u64(), subAccountId: r.u16() });

/**
 * The program's own check (programs/follow/src/lib.rs, Settings::check), so the
 * page can say what's wrong before the wallet opens. Returns a list of problems.
 */
export function settingsProblems(s) {
  const out = [];
  const big = (v) => { try { return BigInt(v); } catch { return null; } };
  const size = big(s?.sizeValue), maxTrade = big(s?.maxTrade), cap = big(s?.dailyLossCap);
  const mode = Number(s?.sizeMode), maxOpen = Number(s?.maxOpen), sub = Number(s?.subAccountId);
  if (mode === SIZE_FIXED) { if (!(size > 0n)) out.push("a fixed size must be more than 0"); }
  else if (mode === SIZE_PERCENT) { if (!(size > 0n && size <= BigInt(BPS))) out.push("a percentage must be more than 0% and at most 100%"); }
  else out.push("size is either a fixed amount or a percentage of the account");
  if (!(maxTrade > 0n)) out.push("the maximum size per trade must be more than 0");
  if (!(cap > 0n)) out.push("the daily loss cap must be more than 0");
  if (!(Number.isInteger(maxOpen) && maxOpen >= 1 && maxOpen <= MAX_OPEN_COPIED)) out.push(`open copied positions: 1 to ${MAX_OPEN_COPIED}`);
  if (!(Number.isInteger(sub) && sub > 0 && sub <= 0xffff)) out.push("copying needs its own subaccount, not the main one (0)");
  return out;
}

/** Decimal text ("12.5") to an integer amount in units of 10^-decimals, or null. */
export function toUnits(text, decimals = 6) {
  const m = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(String(text ?? ""));
  if (!m) return null;
  const frac = (m[2] || "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}
/** An integer amount in units of 10^-decimals as decimal text, trailing zeros trimmed. */
export function fromUnits(units, decimals = 6) {
  const v = BigInt(units), neg = v < 0n, a = neg ? -v : v, d = 10n ** BigInt(decimals);
  const frac = (a % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + (a / d).toString() + (frac ? "." + frac : "");
}

/**
 * The Copy form's values (decimal text, as typed) to Settings. sizeMode "fixed"
 * reads sizeUsd; "percent" reads sizePercent (0-100, two decimals) as bps.
 */
export function settingsFromForm({ sizeMode, sizeUsd, sizePercent, maxTradeUsd, maxOpen, dailyLossUsd, subAccountId }, decimals = 6) {
  const percent = sizeMode === "percent";
  return {
    sizeMode: percent ? SIZE_PERCENT : SIZE_FIXED,
    sizeValue: (percent ? toUnits(sizePercent, 2) : toUnits(sizeUsd, decimals)) ?? 0n,
    maxTrade: toUnits(maxTradeUsd, decimals) ?? 0n,
    maxOpen: Number(maxOpen),
    dailyLossCap: toUnits(dailyLossUsd, decimals) ?? 0n,
    subAccountId: Number(subAccountId),
  };
}

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
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: pk(account), isSigner: false, isWritable: true }, { pubkey: pk(delegate), isSigner: false, isWritable: false }, { pubkey: pk(owner), isSigner: true, isWritable: false }],
    data: Buffer.concat([u8(4), u64(amount)]),
  });
}

// ------------------------------------------------------------------ instructions

const ix = (name, keys, data, programId) => new TransactionInstruction({ programId, keys, data: Buffer.concat([Buffer.from(IX_DISCRIMINATORS[name]), data]) });
const signer = (k, w = false) => ({ pubkey: pk(k), isSigner: true, isWritable: w });
const acct = (k, w = false) => ({ pubkey: pk(k), isSigner: false, isWritable: w });

/**
 * `treasury` and `payout` come from the Config and Plan accounts. `maxPrice`
 * and `maxPerfFeeBps` are the plan terms the follower saw: the program refuses
 * the subscription if the plan has since risen above them.
 */
export function subscribeIx({ follower, config, agent, followerToken, payout, treasury, months, settings, maxPrice, maxPerfFeeBps, programId = FOLLOW_PROGRAM_ID }) {
  const plan = planAddress(config, agent, programId);
  return ix("subscribe", [
    signer(follower, true), acct(config), acct(plan), acct(followAddress(plan, follower, programId), true), acct(followerToken, true),
    acct(payout, true), acct(treasury, true), acct(TOKEN_PROGRAM_ID), acct(SystemProgram.programId),
  ], Buffer.concat([u8(months), encodeSettings(settings), u64(maxPrice), u16(maxPerfFeeBps)]), programId);
}

export function updateSettingsIx({ follower, plan, settings, programId = FOLLOW_PROGRAM_ID }) {
  return ix("update_settings", [signer(follower), acct(followAddress(plan, follower, programId), true)], encodeSettings(settings), programId);
}

export function stopIx({ follower, plan, programId = FOLLOW_PROGRAM_ID }) {
  return ix("stop", [signer(follower), acct(followAddress(plan, follower, programId), true)], Buffer.alloc(0), programId);
}

// ------------------------------------------------------------------ accounts

const ACCOUNTS = {
  Config: (r) => ({ version: r.u8(), bump: r.u8(), admin: r.key(), mint: r.key(), treasury: r.key(), reinsBps: r.u16(), perfReinsBps: r.u16() }),
  Plan: (r) => ({ version: r.u8(), bump: r.u8(), config: r.key(), agent: r.key(), payout: r.key(), price: r.u64(), perfFeeBps: r.u16(), open: r.bool(), createdAt: Number(r.i64()) }),
  Follow: (r) => ({
    version: r.u8(), bump: r.u8(), plan: r.key(), follower: r.key(), paidUntil: Number(r.i64()), active: r.bool(), settings: readSettings(r), perfFeeBps: r.u16(),
    hwmSet: r.bool(), hwm: r.i64(), totalPaid: r.u64(), perfFeesPaid: r.u64(), settlements: r.u32(), lastSettledAt: Number(r.i64()), createdAt: Number(r.i64()),
  }),
};
const BY_DISC = Object.fromEntries(Object.entries(ACCOUNT_DISCRIMINATORS).map(([n, d]) => [Buffer.from(d).toString("hex"), n]));
export const accountDiscriminator = (name) => Buffer.from(ACCOUNT_DISCRIMINATORS[name]);

export function decodeFollowAccount(data) {
  const b = Buffer.from(data);
  const type = BY_DISC[b.subarray(0, 8).toString("hex")];
  return type ? { type, ...ACCOUNTS[type](new Reader(b, 8)) } : null;
}

/** The copier's rule: it trades only for a follow that is active and paid up. */
export const isCopyable = (follow, nowSec) => Boolean(follow?.active) && follow.paidUntil > nowSec;

/** Byte offsets in a Follow account: discriminator(8), version, bump, then plan(32), then follower. */
export const FOLLOW_PLAN_OFFSET = 10;
export const FOLLOW_FOLLOWER_OFFSET = 42;
/** base58 of the Follow discriminator, for a getProgramAccounts memcmp. */
export const FOLLOW_DISCRIMINATOR_B58 = "eJ5PtCerHZU";

/** getProgramAccounts filters: every Follow account whose follower is `follower`. */
export const followsOfFollowerFilters = (follower) => [
  { memcmp: { offset: 0, bytes: FOLLOW_DISCRIMINATOR_B58 } },
  { memcmp: { offset: FOLLOW_FOLLOWER_OFFSET, bytes: pk(follower).toBase58() } },
];

/** Every Follow account of a follower, decoded. */
export async function followsOfFollower(connection, follower, programId = FOLLOW_PROGRAM_ID) {
  const rows = await connection.getProgramAccounts(programId, { commitment: "confirmed", filters: followsOfFollowerFilters(follower) });
  return rows.map(({ pubkey, account }) => ({ address: pubkey, ...decodeFollowAccount(account.data) }));
}
