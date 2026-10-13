/**
 * Copy-trading in the browser (Solana mode): the bundle behind the Copy flow on
 * an agent's page and the Following page. Built to
 * app/public/vendor/solana-copy.js as the global ReinsSolanaCopy
 * (npm run build:solana-copy).
 *
 * Reads go to the cluster's RPC from the browser; every write is a transaction
 * the follower's own wallet signs. Nothing here holds or moves funds for anyone:
 *   - Velocity: the follower creates a copy subaccount in their own account and
 *     makes Reins' copier its delegate (it can trade, never withdraw);
 *   - follow program: the follower pays the subscription from their own USDC
 *     and, optionally, approves a capped performance-fee allowance.
 */
import { Connection, PublicKey } from "@solana/web3.js";

import * as follow from "./solana-follow-browser.js";
import * as velocity from "./solana-velocity-browser.js";
import * as wallet from "./solana-wallet.js";

const pk = (k) => (k instanceof PublicKey ? k : new PublicKey(k));

/** The page's config (GET /api/callbook/solana-config) to live objects. */
export function init(cfg) {
  const connection = new Connection(cfg.rpc, { commitment: "confirmed" });
  return {
    cfg, connection,
    followProgram: pk(cfg.followProgram || follow.FOLLOW_PROGRAM_ID),
    velocityProgram: pk(cfg.velocityProgram || velocity.VELOCITY_PROGRAM_ID),
    followConfig: cfg.followConfig ? pk(cfg.followConfig) : null,
    copier: cfg.copier ? pk(cfg.copier) : null,
  };
}

const EXPLORER = "https://explorer.solana.com";
const q = (cluster) => (cluster && cluster !== "mainnet-beta" ? `?cluster=${cluster}` : "");
export const explorerTx = (sig, cluster = "devnet") => `${EXPLORER}/tx/${sig}${q(cluster)}`;
export const explorerAddress = (addr, cluster = "devnet") => `${EXPLORER}/address/${addr}${q(cluster)}`;

/** The follow Config and the agent's Plan (null when the agent has none). */
export async function readPlan(ctx, agent) {
  if (!ctx.followConfig) throw new Error("Copying isn't set up on this server yet (no follow config).");
  const planAddress = follow.planAddress(ctx.followConfig, agent, ctx.followProgram);
  const [c, p] = await ctx.connection.getMultipleAccountsInfo([ctx.followConfig, planAddress], "confirmed");
  const config = c && c.owner.equals(ctx.followProgram) ? follow.decodeFollowAccount(c.data) : null;
  const plan = p && p.owner.equals(ctx.followProgram) ? follow.decodeFollowAccount(p.data) : null;
  if (!config || config.type !== "Config") throw new Error("The follow program's config isn't on this cluster yet.");
  return { config, planAddress, plan: plan && plan.type === "Plan" ? plan : null };
}

/** The wallet's Follow account for one plan, if any. */
export async function readFollow(ctx, plan, follower) {
  const address = follow.followAddress(plan, follower, ctx.followProgram);
  const info = await ctx.connection.getAccountInfo(address, "confirmed");
  const f = info && info.owner.equals(ctx.followProgram) ? follow.decodeFollowAccount(info.data) : null;
  return f && f.type === "Follow" ? { address, ...f } : null;
}

/** The wallet's Velocity accounts: UserStats, every subaccount, the State, and what to create for copying. */
export async function readVelocity(ctx, authority) {
  const P = ctx.velocityProgram;
  const [statsInfo, stateInfo] = await ctx.connection.getMultipleAccountsInfo([velocity.userStatsAddress(authority, P), velocity.stateAddress(P)], "confirmed");
  const stats = statsInfo && statsInfo.owner.equals(P) ? velocity.decodeUserStats(statsInfo.data) : null;
  const state = stateInfo && stateInfo.owner.equals(P) ? velocity.decodeState(stateInfo.data) : null;
  const n = stats ? Math.min(stats.numberOfSubAccountsCreated, 64) : 0;
  const ids = Array.from({ length: n }, (_, i) => i);
  const infos = ids.length ? await ctx.connection.getMultipleAccountsInfo(ids.map((i) => velocity.userAddress(authority, i, P)), "confirmed") : [];
  const users = infos.map((info) => (info && info.owner.equals(P) ? velocity.decodeUser(info.data) : null));
  const plan = ctx.copier ? velocity.planCopyAccount({ stats, users, copier: ctx.copier }) : null;
  return { stats, state, users, plan, programLive: Boolean(stateInfo) };
}

/**
 * Step 1, the Velocity side, as one transaction: UserStats and the main
 * subaccount 0 if this wallet has never used Velocity, then a dedicated copy
 * subaccount, then Reins' copier as its delegate.
 */
export function velocitySetupIxs(ctx, authority, v, name = "Reins copy") {
  if (!ctx.copier) throw new Error("Copying isn't set up on this server yet (no copier key).");
  const P = ctx.velocityProgram, p = v.plan, ixs = [];
  const whitelistMint = v.state ? v.state.whitelistMint : null;
  if (p.createStats) ixs.push(velocity.initializeUserStatsIx({ authority, programId: P }));
  if (p.createMain) ixs.push(velocity.initializeUserIx({ authority, subAccountId: 0, name: "Main Account", whitelistMint, programId: P }));
  if (p.createCopy) ixs.push(velocity.initializeUserIx({ authority, subAccountId: p.subAccountId, name, whitelistMint, programId: P }));
  if (p.setDelegate) ixs.push(velocity.updateUserDelegateIx({ authority, subAccountId: p.subAccountId, delegate: ctx.copier, programId: P }));
  return ixs;
}

/** Optional: deposit quote (devnet dUSDT) from the wallet into the copy subaccount. */
export async function depositIxs(ctx, authority, subAccountId, amount) {
  const P = ctx.velocityProgram, idx = velocity.DEVNET_QUOTE.marketIndex;
  const info = await ctx.connection.getAccountInfo(velocity.spotMarketAddress(idx, P), "confirmed");
  const market = info && velocity.decodeSpotMarket(info.data);
  if (!market) throw new Error("Velocity's quote market isn't readable on this cluster.");
  const mintInfo = await ctx.connection.getAccountInfo(market.mint, "confirmed");
  const tokenProgram = mintInfo ? mintInfo.owner : null;
  const userTokenAccount = velocity.quoteTokenAccount(authority, market.mint);
  return [velocity.depositIx({ authority, subAccountId, marketIndex: idx, amount, userTokenAccount, oracle: market.oracle, vault: market.vault, tokenProgram, programId: P })];
}

/**
 * Step 3, the subscription, as one transaction: the USDC account (created if
 * missing), subscribe for `months` at the terms the follower saw, and an
 * optional SPL Approve of a performance-fee allowance to their Follow account.
 */
export function subscribeIxs(ctx, { follower, agent, config, plan, months, settings, perfAllowance = 0n }) {
  const mint = config.mint;
  const followerToken = follow.associatedTokenAddress(follower, mint);
  const ixs = [
    follow.createAssociatedTokenAccountIx({ payer: follower, owner: follower, mint }),
    follow.subscribeIx({
      follower, config: ctx.followConfig, agent, followerToken, payout: plan.payout, treasury: config.treasury,
      months, settings, maxPrice: plan.price, maxPerfFeeBps: plan.perfFeeBps, programId: ctx.followProgram,
    }),
  ];
  if (BigInt(perfAllowance) > 0n) {
    const planAddress = follow.planAddress(ctx.followConfig, agent, ctx.followProgram);
    ixs.push(follow.approveIx({ account: followerToken, delegate: follow.followAddress(planAddress, follower, ctx.followProgram), owner: follower, amount: perfAllowance }));
  }
  return ixs;
}

/** Stop step 1: the follow program's `stop` (the copier skips the follow from then on). */
export const stopIxs = (ctx, follower, plan) => [follow.stopIx({ follower, plan, programId: ctx.followProgram })];
/** Stop step 2: remove the copier as the copy subaccount's delegate. The one that matters for safety. */
export const revokeIxs = (ctx, authority, subAccountId) =>
  [velocity.updateUserDelegateIx({ authority, subAccountId, delegate: PublicKey.default, programId: ctx.velocityProgram })];

/**
 * Everything the Following page shows for a wallet: each Follow account with
 * its Plan (for the agent and terms) and its copy subaccount on Velocity.
 */
export async function following(ctx, follower) {
  const follows = await follow.followsOfFollower(ctx.connection, follower, ctx.followProgram);
  if (!follows.length) return [];
  const plans = await ctx.connection.getMultipleAccountsInfo(follows.map((f) => f.plan), "confirmed");
  const users = await ctx.connection.getMultipleAccountsInfo(follows.map((f) => velocity.userAddress(follower, f.settings.subAccountId, ctx.velocityProgram)), "confirmed");
  return follows.map((f, i) => {
    const p = plans[i] && plans[i].owner.equals(ctx.followProgram) ? follow.decodeFollowAccount(plans[i].data) : null;
    const u = users[i] && users[i].owner.equals(ctx.velocityProgram) ? velocity.decodeUser(users[i].data) : null;
    return {
      follow: f, plan: p && p.type === "Plan" ? p : null, user: u,
      userAddress: velocity.userAddress(follower, f.settings.subAccountId, ctx.velocityProgram),
      delegated: Boolean(u && ctx.copier && u.delegate.equals(ctx.copier)),
      delegate: u ? u.delegate : null,
    };
  });
}

/** Hyperliquid mark prices for the devnet perp coins (an estimate: Velocity's own oracle can differ). */
export async function markPrices(fetchImpl = fetch) {
  try {
    const r = await fetchImpl("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"type":"allMids"}' });
    if (!r.ok) return {};
    const mids = await r.json(), out = {};
    for (const coin of Object.values(velocity.DEVNET_PERP_MARKETS)) if (mids && mids[coin] != null) out[coin] = Number(mids[coin]);
    return out;
  } catch {
    return {};
  }
}

export const send = wallet.send;
export const explain = wallet.explain;
export const wallets = wallet.wallets;
export const connect = wallet.connect;
export { follow, velocity, PublicKey };
