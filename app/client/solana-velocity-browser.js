/**
 * Velocity Exchange (formerly Drift) for the browser: the few instructions a
 * follower signs to set up copying, and the account fields the Following page
 * reads. Built with @solana/web3.js only, not the Velocity SDK.
 *
 * Why not the SDK: an esbuild browser bundle of @velocity-exchange/sdk@0.26.0
 * comes to 2.9 MB minified and needs shims for node's events, fs and crypto;
 * its builders also need a subscribed VelocityClient, which loads every market
 * and oracle over RPC first. Six instructions and four account layouts don't
 * justify that.
 *
 * Every layout below is taken from the program's IDL as shipped in the SDK,
 *   copier/node_modules/@velocity-exchange/sdk/lib/browser/idl/velocity.json
 * (Anchor IDL spec 0.1.0, program version 2.169.0), and the account lists and
 * remaining accounts mirror the SDK's own builders in
 *   copier/node_modules/@velocity-exchange/sdk/lib/node/velocityClient.js
 *   (getInitializeUserStatsIx, getInitializeUserInstructions,
 *    getUpdateUserDelegateIx, getDepositInstruction)
 *   lib/node/addresses/pda.js (PDA seeds), lib/node/userName.js (encodeName).
 * test/solana-follow-browser.test.js checks the discriminators, account lists
 * and offsets against that IDL, and the instruction bytes against the SDK's
 * Anchor coder, whenever copier/node_modules is installed.
 */
import { Buffer } from "buffer";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";

/** The same id on devnet and mainnet (SDK config.js; docs/solana/DRIFT-CHECK.md). */
export const VELOCITY_PROGRAM_ID = new PublicKey("vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Devnet quote: spot market 0, dUSDT (SDK constants/spotMarkets.js DevnetSpotMarkets[0]). */
export const DEVNET_QUOTE = Object.freeze({ marketIndex: 0, symbol: "dUSDT", mint: "GqmEqYsy8EyvofDpmtFxK8zhYrgWgNokAtYoduQdL7v6", decimals: 6 });
/** Devnet perp markets (SDK constants/perpMarkets.js DevnetPerpMarkets). */
export const DEVNET_PERP_MARKETS = Object.freeze({ 0: "SOL", 1: "BTC", 2: "ETH" });
/** Precisions (SDK constants/numericConstants.js): base 1e9, quote 1e6, price 1e6. */
export const BASE_PRECISION = 1e9;
export const QUOTE_PRECISION = 1e6;

/** Instruction discriminators, from velocity.json `instructions[].discriminator`. */
export const VELOCITY_IX = Object.freeze({
  initialize_user_stats: [254, 243, 72, 98, 251, 130, 168, 213],
  initialize_user: [111, 17, 185, 250, 60, 122, 38, 254],
  update_user_delegate: [139, 205, 141, 141, 113, 36, 94, 187],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
});
/** Account discriminators, from velocity.json `accounts[].discriminator`. */
export const VELOCITY_ACCOUNT = Object.freeze({
  State: [216, 146, 107, 94, 104, 75, 182, 177],
  User: [159, 117, 95, 227, 239, 151, 58, 236],
  UserStats: [176, 223, 136, 27, 122, 79, 32, 227],
  SpotMarket: [100, 177, 8, 107, 168, 65, 65, 39],
});

/**
 * Byte offsets (discriminator included) of the fields we read. All four types
 * are bytemuck repr(C) with no implicit padding, so an offset is the sum of the
 * sizes before it in velocity.json `types` (the test recomputes them).
 */
export const OFFSETS = Object.freeze({
  State: { whitelist_mint: 424 },
  UserStats: { authority: 8, number_of_sub_accounts: 160, number_of_sub_accounts_created: 162 },
  User: {
    authority: 8, delegate: 40, name: 72, spot_positions: 104, perp_positions: 424, orders: 1064,
    total_deposits: 4392, total_withdraws: 4400, settled_perp_pnl: 4416, cumulative_perp_funding: 4432,
    sub_account_id: 4466, status: 4468, open_orders: 4471, size: 4496,
  },
  SpotPosition: { scaled_balance: 0, market_index: 32, balance_type: 34, open_orders: 35, size: 40 },
  PerpPosition: { base_asset_amount: 8, quote_asset_amount: 16, quote_break_even_amount: 24, quote_entry_amount: 32, settled_pnl: 56, market_index: 76, open_orders: 78, size: 80 },
  SpotMarket: { pubkey: 8, oracle: 40, mint: 72, vault: 104 },
});

const pk = (k) => (k instanceof PublicKey ? k : new PublicKey(k));
const utf8 = (s) => Buffer.from(s, "utf8");
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(Number(n)); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey: pk(pubkey), isSigner, isWritable });

// ------------------------------------------------------------------ addresses (SDK addresses/pda.js)

export const stateAddress = (programId = VELOCITY_PROGRAM_ID) => PublicKey.findProgramAddressSync([utf8("velocity_state")], programId)[0];
export const userAddress = (authority, subAccountId = 0, programId = VELOCITY_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([utf8("user"), pk(authority).toBuffer(), u16(subAccountId)], programId)[0];
export const userStatsAddress = (authority, programId = VELOCITY_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([utf8("user_stats"), pk(authority).toBuffer()], programId)[0];
export const spotMarketAddress = (marketIndex, programId = VELOCITY_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([utf8("spot_market"), u16(marketIndex)], programId)[0];
export const spotMarketVaultAddress = (marketIndex, programId = VELOCITY_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([utf8("spot_market_vault"), u16(marketIndex)], programId)[0];
const ataOf = (owner, mint, tokenProgram = TOKEN_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([pk(owner).toBuffer(), pk(tokenProgram).toBuffer(), pk(mint).toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];

/** A subaccount name as the program stores it: 32 bytes, space-padded (SDK userName.js encodeName). */
export function encodeName(name) {
  const s = String(name);
  if (s.length > 32 || /[^\x20-\x7e]/.test(s)) throw new Error("a Velocity account name is at most 32 plain characters");
  const b = Buffer.alloc(32, 0x20);
  b.write(s, 0, "ascii");
  return b;
}
export const decodeName = (bytes) => Buffer.from(bytes).toString("utf8").trim();

// ------------------------------------------------------------------ instructions

const ix = (name, keys, data, programId) =>
  new TransactionInstruction({ programId, keys, data: Buffer.concat([Buffer.from(VELOCITY_IX[name]), data]) });

/** The authority's UserStats, needed once before its first subaccount. IDL accounts: user_stats, state, authority, payer, rent, system_program. */
export function initializeUserStatsIx({ authority, payer = authority, programId = VELOCITY_PROGRAM_ID }) {
  return ix("initialize_user_stats", [
    meta(userStatsAddress(authority, programId), true), meta(stateAddress(programId), true), meta(authority),
    meta(payer, true, true), meta(SYSVAR_RENT_PUBKEY), meta(SystemProgram.programId),
  ], Buffer.alloc(0), programId);
}

/**
 * A new subaccount. Ids are handed out in order: `subAccountId` must equal the
 * UserStats' number_of_sub_accounts_created. IDL accounts: user, user_stats,
 * state, authority, payer, rent, system_program; args (sub_account_id: u16,
 * name: [u8; 32]). When the State has a whitelist mint, the SDK appends the
 * payer's associated token account for it; pass it as `whitelistMint`.
 */
export function initializeUserIx({ authority, payer = authority, subAccountId, name, whitelistMint = null, programId = VELOCITY_PROGRAM_ID }) {
  const keys = [
    meta(userAddress(authority, subAccountId, programId), true), meta(userStatsAddress(authority, programId), true), meta(stateAddress(programId), true),
    meta(authority), meta(payer, true, true), meta(SYSVAR_RENT_PUBKEY), meta(SystemProgram.programId),
  ];
  if (whitelistMint && !pk(whitelistMint).equals(PublicKey.default)) keys.push(meta(ataOf(payer, whitelistMint)));
  return ix("initialize_user", keys, Buffer.concat([u16(subAccountId), encodeName(name)]), programId);
}

/**
 * Set (or, with PublicKey.default, remove) the subaccount's delegate: it may
 * place and cancel orders, never withdraw. IDL accounts: user, authority (signer);
 * args (_sub_account_id: u16, delegate: pubkey).
 */
export function updateUserDelegateIx({ authority, subAccountId, delegate, programId = VELOCITY_PROGRAM_ID }) {
  return ix("update_user_delegate", [meta(userAddress(authority, subAccountId, programId), true), meta(authority, false, true)],
    Buffer.concat([u16(subAccountId), pk(delegate).toBuffer()]), programId);
}

/**
 * Deposit from the authority's own token account into a subaccount. IDL accounts:
 * state, user, user_stats, authority, spot_market_vault, user_token_account,
 * token_program; args (market_index: u16, amount: u64, reduce_only: bool).
 * Remaining accounts as the SDK builds them for a subaccount with no positions
 * (core/remainingAccounts.js: oracles, then spot markets): the spot market's
 * oracle (read-only, when not default) and the spot market (writable). Read
 * `oracle` and `vault` from the SpotMarket account (decodeSpotMarket).
 * Classic SPL token mints only: a Token-2022 mint needs more accounts.
 */
export function depositIx({ authority, subAccountId, marketIndex = 0, amount, userTokenAccount, oracle, vault = null, tokenProgram = TOKEN_PROGRAM_ID, programId = VELOCITY_PROGRAM_ID }) {
  if (!pk(tokenProgram).equals(TOKEN_PROGRAM_ID)) throw new Error("only classic SPL token deposits are built here; deposit a Token-2022 mint on Velocity");
  const keys = [
    meta(stateAddress(programId)), meta(userAddress(authority, subAccountId, programId), true), meta(userStatsAddress(authority, programId), true),
    meta(authority, false, true), meta(vault ?? spotMarketVaultAddress(marketIndex, programId), true), meta(userTokenAccount, true), meta(tokenProgram),
  ];
  if (oracle && !pk(oracle).equals(PublicKey.default)) keys.push(meta(oracle));
  keys.push(meta(spotMarketAddress(marketIndex, programId), true));
  return ix("deposit", keys, Buffer.concat([u16(marketIndex), u64(amount), Buffer.from([0])]), programId);
}

/** The authority's associated token account for the quote mint (where a deposit comes from). */
export const quoteTokenAccount = (authority, mint = DEVNET_QUOTE.mint) => ataOf(authority, mint);

// ------------------------------------------------------------------ accounts

const hasDisc = (b, name) => b.length >= 8 && Buffer.from(VELOCITY_ACCOUNT[name]).equals(b.subarray(0, 8));
const key = (b, at) => new PublicKey(b.subarray(at, at + 32));

export function decodeState(data) {
  const b = Buffer.from(data);
  if (!hasDisc(b, "State")) return null;
  return { whitelistMint: key(b, OFFSETS.State.whitelist_mint) };
}

export function decodeUserStats(data) {
  const b = Buffer.from(data), o = OFFSETS.UserStats;
  if (!hasDisc(b, "UserStats")) return null;
  return { authority: key(b, o.authority), numberOfSubAccounts: b.readUInt16LE(o.number_of_sub_accounts), numberOfSubAccountsCreated: b.readUInt16LE(o.number_of_sub_accounts_created) };
}

export function decodeSpotMarket(data) {
  const b = Buffer.from(data), o = OFFSETS.SpotMarket;
  if (!hasDisc(b, "SpotMarket")) return null;
  return { pubkey: key(b, o.pubkey), oracle: key(b, o.oracle), mint: key(b, o.mint), vault: key(b, o.vault) };
}

/** A subaccount: who owns it, its delegate, and its open perp positions (amounts as BigInt in program units). */
export function decodeUser(data) {
  const b = Buffer.from(data), o = OFFSETS.User, P = OFFSETS.PerpPosition, S = OFFSETS.SpotPosition;
  if (!hasDisc(b, "User") || b.length < o.size) return null;
  const perpPositions = [];
  for (let i = 0; i < 8; i++) {
    const at = o.perp_positions + i * P.size;
    const base = b.readBigInt64LE(at + P.base_asset_amount), openOrders = b.readUInt8(at + P.open_orders);
    const quote = b.readBigInt64LE(at + P.quote_asset_amount);
    if (base === 0n && openOrders === 0 && quote === 0n) continue;
    perpPositions.push({
      marketIndex: b.readUInt16LE(at + P.market_index), baseAssetAmount: base, quoteAssetAmount: quote,
      quoteBreakEvenAmount: b.readBigInt64LE(at + P.quote_break_even_amount), quoteEntryAmount: b.readBigInt64LE(at + P.quote_entry_amount),
      settledPnl: b.readBigInt64LE(at + P.settled_pnl), openOrders,
    });
  }
  let spotPositions = 0;
  for (let i = 0; i < 8; i++) {
    const at = o.spot_positions + i * S.size;
    if (b.readBigUInt64LE(at + S.scaled_balance) !== 0n || b.readUInt8(at + S.open_orders) !== 0) spotPositions++;
  }
  return {
    authority: key(b, o.authority), delegate: key(b, o.delegate), name: decodeName(b.subarray(o.name, o.name + 32)),
    subAccountId: b.readUInt16LE(o.sub_account_id), status: b.readUInt8(o.status), openOrders: b.readUInt8(o.open_orders),
    totalDeposits: b.readBigUInt64LE(o.total_deposits), totalWithdraws: b.readBigUInt64LE(o.total_withdraws),
    settledPerpPnl: b.readBigInt64LE(o.settled_perp_pnl), cumulativePerpFunding: b.readBigInt64LE(o.cumulative_perp_funding),
    perpPositions, spotPositions,
  };
}

/**
 * A position's entry price and, given a mark price, its unrealized PnL in quote
 * units, the way Drift/Velocity compute it before funding (math/position.js):
 * quote_asset_amount + base × price. Base is 1e9, quote and price 1e6.
 */
export function positionView(p, markPrice = null) {
  const base = Number(p.baseAssetAmount) / BASE_PRECISION;
  const entry = base !== 0 ? Math.abs(Number(p.quoteEntryAmount) / QUOTE_PRECISION / base) : null;
  const pnl = markPrice != null && Number.isFinite(markPrice) ? Number(p.quoteAssetAmount) / QUOTE_PRECISION + base * markPrice : null;
  return { coin: DEVNET_PERP_MARKETS[p.marketIndex] ?? `market ${p.marketIndex}`, side: base > 0 ? "long" : base < 0 ? "short" : "flat", size: Math.abs(base), entry, pnl };
}

/**
 * Plan the Velocity side of copying for a wallet, from what's on chain:
 *   stats   decodeUserStats(...) or null when the wallet has never used Velocity
 *   users   decoded subaccounts [0, created) (null where closed)
 *   copier  the copier's delegate key
 * Reuses a subaccount (not 0) already delegated to the copier; otherwise the
 * next id, creating UserStats and the main subaccount 0 first when missing
 * (ids are sequential, and the follow program refuses subaccount 0).
 */
export function planCopyAccount({ stats, users = [], copier }) {
  const c = pk(copier);
  const existing = users.find((u) => u && u.subAccountId !== 0 && u.delegate.equals(c));
  if (existing) return { subAccountId: existing.subAccountId, createStats: false, createMain: false, createCopy: false, setDelegate: false };
  if (!stats) return { subAccountId: 1, createStats: true, createMain: true, createCopy: true, setDelegate: true };
  const next = stats.numberOfSubAccountsCreated;
  if (next === 0) return { subAccountId: 1, createStats: false, createMain: true, createCopy: true, setDelegate: true };
  return { subAccountId: next, createStats: false, createMain: false, createCopy: true, setDelegate: true };
}
