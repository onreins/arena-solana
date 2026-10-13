/**
 * Set up copy-trading subscriptions on Solana DEVNET: Reins' Config (fee
 * split and treasury) and a Plan for each house agent, so followers can
 * subscribe on day one.
 *
 *   node scripts/solana-follow-setup.mjs
 *
 * Env:
 *   SOLANA_ADMIN_KEYPAIR   the config admin and settler (default ~/.config/solana/id.json), 0600
 *   ARENA_HOUSE_KEYS_DIR   the house agents' keys (default ~/.arena/house), as solana/house-agents.js
 *   USDC_MINT              default Circle's devnet USDC
 *   REINS_BPS=2000 PERF_REINS_BPS=3000 PLAN_PRICE_USDC=10 PLAN_PERF_BPS=2000
 *
 * Idempotent: an existing Config is left alone and plans are set again.
 * Only public keys are printed.
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Connection, Keypair, Transaction, PublicKey } from "@solana/web3.js";

import { sendAndConfirmByPolling } from "../solana/arena.js";
import {
  DEVNET_USDC, configAddress, planAddress, associatedTokenAddress, createAssociatedTokenAccountIx, initConfigIx, setPlanIx,
} from "../solana/follow.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const env = process.env;

function keypairFile(path) {
  if (statSync(path).mode & 0o077) throw new Error(`${path} is readable by others: chmod 600 it.`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

const connection = new Connection(env.ARENA_SOLANA_RPC || "https://api.devnet.solana.com", "confirmed");
if ((await connection.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("Refusing: this RPC isn't devnet.");

const admin = keypairFile(env.SOLANA_ADMIN_KEYPAIR || join(homedir(), ".config", "solana", "id.json"));
const mint = new PublicKey(env.USDC_MINT || DEVNET_USDC);
const treasury = associatedTokenAddress(admin.publicKey, mint);
const config = configAddress(admin.publicKey);
const send = (ixs, signers) => sendAndConfirmByPolling(connection, new Transaction().add(...ixs), signers);
const tx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

if (!(await connection.getAccountInfo(config))) {
  const sig = await send([
    createAssociatedTokenAccountIx({ payer: admin.publicKey, owner: admin.publicKey, mint }),
    initConfigIx({ admin: admin.publicKey, mint, treasury, reinsBps: Number(env.REINS_BPS ?? 2000), perfReinsBps: Number(env.PERF_REINS_BPS ?? 3000) }),
  ], [admin]);
  console.log(`config ${config.toBase58()} created: ${tx(sig)}`);
} else {
  console.log(`config ${config.toBase58()} exists`);
}

const dir = env.ARENA_HOUSE_KEYS_DIR || join(homedir(), ".arena", "house");
const price = BigInt(Math.round(Number(env.PLAN_PRICE_USDC ?? 10) * 1e6));
for (const key of ["hot", "cold", "flip"]) {
  const file = join(dir, `${key}.json`);
  if (!existsSync(file)) {
    console.log(`${key}: no key at ${file} (run solana/house-agents.js once first); skipped`);
    continue;
  }
  const agent = keypairFile(file);
  const payout = associatedTokenAddress(agent.publicKey, mint);
  const sig = await send([
    createAssociatedTokenAccountIx({ payer: admin.publicKey, owner: agent.publicKey, mint }),
    setPlanIx({ agent: agent.publicKey, payer: admin.publicKey, config, payout, price, perfFeeBps: Number(env.PLAN_PERF_BPS ?? 2000), open: true }),
  ], [admin, agent]);
  console.log(`${key}: plan ${planAddress(config, agent.publicKey).toBase58()} for agent ${agent.publicKey.toBase58()}: ${tx(sig)}`);
}
console.log(`FOLLOW_CONFIG=${config.toBase58()}`);
