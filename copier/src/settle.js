/**
 * Performance-fee settlement: for every follow under the config's plans, read
 * the follower's copy subaccount's all-time PnL from the exchange and record
 * it with settle_performance. The program applies the high-water mark: the
 * first settlement only sets it, later ones charge the plan's rate on the gain
 * above it, split between the agent's owner and Reins, taken from the
 * allowance the follower granted to their Follow account.
 *
 * The PnL is measured off-chain by the config's admin (the settler); every
 * settlement and its report hash are on-chain, so each one can be checked
 * against the exchange's own history.
 *
 *   node src/settle.js            (env as server.js, plus SETTLER_KEYPAIR: the config admin, 0600)
 */
import "./poll-confirm.js";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

import {
  FOLLOW_PROGRAM_ID, accountDiscriminator, decodeFollowAccount, followsOfPlan, associatedTokenAddress, settlePerformanceIx,
} from "../../solana/follow.js";
import { readSecretFile } from "./server.js";
import { confirmByPolling } from "../../solana/arena.js";

/** The report a settlement commits to: what was measured, from where, when. */
export function settlementReport({ follow, follower, subAccountId, pnl, at }) {
  const text = JSON.stringify({ at, follow: String(follow), follower: String(follower), pnl: String(pnl), source: "velocity:getTotalAllTimePnl", subAccountId });
  return { text, hash: createHash("sha256").update(text).digest() };
}

/** What the program will charge for a reported PnL (mirrors programs/follow performance_fee). */
export function expectedFee({ hwmSet, hwm, pnl, perfFeeBps }) {
  if (!hwmSet || pnl <= hwm) return 0n;
  return ((BigInt(pnl) - BigInt(hwm)) * BigInt(perfFeeBps)) / 10_000n;
}

/** Plans under a config: Plan accounts whose `config` (offset 10) matches. */
export async function plansOfConfig(connection, config) {
  const rows = await connection.getProgramAccounts(FOLLOW_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("Plan")) } }, { memcmp: { offset: 10, bytes: new PublicKey(config).toBase58() } }],
  });
  return rows.map(({ pubkey, account }) => ({ address: pubkey, ...decodeFollowAccount(account.data) }));
}

/**
 * One settlement pass. `pnlOf(follow)` returns the copy subaccount's all-time
 * PnL (BigInt, quote units). Returns a row per follow.
 */
export async function settleAll({ connection, admin, config, configAccount, pnlOf, now = () => Math.floor(Date.now() / 1000), dryRun = false, log = () => {} }) {
  const out = [];
  for (const plan of await plansOfConfig(connection, config)) {
    for (const f of await followsOfPlan(connection, plan.address)) {
      const pnl = await pnlOf(f);
      const fee = expectedFee({ hwmSet: f.hwmSet, hwm: f.hwm, pnl, perfFeeBps: f.perfFeeBps }); // the rate the follower agreed to
      const report = settlementReport({ follow: f.address, follower: f.follower, subAccountId: f.settings.subAccountId, pnl, at: now() });
      const row = { follow: f.address.toBase58(), pnl: String(pnl), fee: String(fee), first: !f.hwmSet };
      if (dryRun) { out.push(row); continue; }
      const ix = settlePerformanceIx({
        admin: admin.publicKey, config, plan: plan.address, follower: f.follower,
        followerToken: associatedTokenAddress(f.follower, configAccount.mint), payout: plan.payout, treasury: configAccount.treasury,
        pnl, reportHash: report.hash,
      });
      try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: admin.publicKey, blockhash, lastValidBlockHeight }).add(ix);
        tx.sign(admin);
        row.tx = await connection.sendRawTransaction(tx.serialize());
        await confirmByPolling(connection, row.tx, lastValidBlockHeight);
        log(`${row.follow}: pnl ${row.pnl}, fee ${row.fee}${row.first ? " (sets the high-water mark)" : ""} ${row.tx}`);
      } catch (err) {
        // Usually an allowance too small or revoked: nothing moved, the mark stays; the copier can pause this follow.
        row.error = String(err?.message ?? err).slice(0, 200);
        log(`${row.follow}: not settled (${row.error})`);
      }
      out.push(row);
    }
  }
  return out;
}

async function main() {
  const env = process.env;
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readSecretFile(env.SETTLER_KEYPAIR))));
  const copierKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readSecretFile(env.COPIER_KEYPAIR))));
  const config = new PublicKey(env.FOLLOW_CONFIG);
  const connection = new Connection(env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const info = await connection.getAccountInfo(config);
  const configAccount = info && decodeFollowAccount(info.data);
  if (configAccount?.type !== "Config" || !configAccount.admin.equals(admin.publicKey)) throw new Error("SETTLER_KEYPAIR isn't this config's admin.");
  const { createVelocityExchange } = await import("./velocity.js");
  const exchange = await createVelocityExchange({ connection, keypair: copierKey });
  const rows = await settleAll({
    connection, admin, config, configAccount, dryRun: process.argv.includes("--dry-run"), log: console.log,
    pnlOf: async (f) => (await exchange.pnl(f)),
  });
  console.log(`${rows.length} follow(s) settled`);
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`settle: ${err.message}`);
    process.exit(1);
  });
}
