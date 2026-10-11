#!/usr/bin/env node
/**
 * Spread USDC from the funded deployer to the other Arena mainnet roles, after you confirm.
 *
 *   node --env-file=.env.mainnet scripts/fund-mainnet-roles.mjs
 *
 * Fund the deployer first (its address is printed), then run this. It prints the
 * deployer's balance and the exact transfers, and sends nothing until you type "yes".
 * Amounts are in USDC (Arc's gas token); the deployer keeps the rest for the deploy.
 * A role that already holds its amount is skipped, so running it twice is safe.
 */
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, http, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "viem/chains";

// What each role needs for the first days (testnet fees: a prediction 0.006, a score post 0.06, the deploy up to 2.75).
const PLAN = { OWNER: "0.5", AGENT: "0.5", VALIDATOR: "1", RELAYER: "1" };
const DEPLOYER_KEEPS = parseEther("3");

function account(role) {
  const key = process.env[`CALLBOOK_${role}_KEY`];
  if (!key) throw new Error(`CALLBOOK_${role}_KEY is missing from .env.mainnet`);
  return privateKeyToAccount(key);
}

async function main() {
  if (process.env.CALLBOOK_NETWORK !== "mainnet") throw new Error("run with --env-file=.env.mainnet (CALLBOOK_NETWORK must be mainnet)");
  const transport = http(process.env.ARENA_RPC || undefined);
  const pub = createPublicClient({ chain: arc, transport });
  const deployer = account("DEPLOYER");
  const wallet = createWalletClient({ account: deployer, chain: arc, transport });

  const balance = await pub.getBalance({ address: deployer.address });
  console.log(`Deployer ${deployer.address}: ${formatEther(balance)} USDC on ${arc.name} (${arc.id})\n`);

  const sends = [];
  for (const [role, amount] of Object.entries(PLAN)) {
    const to = account(role).address;
    const want = parseEther(amount);
    const has = await pub.getBalance({ address: to });
    const value = has >= want ? 0n : want - has;
    console.log(`${role.padEnd(10)} ${to}  has ${formatEther(has).padEnd(8)} → send ${formatEther(value)} USDC`);
    if (value > 0n) sends.push({ role, to, value });
  }
  const total = sends.reduce((s, x) => s + x.value, 0n);
  console.log(`\nTotal to send: ${formatEther(total)} USDC. Deployer keeps ${formatEther(balance - total)} (needs about ${formatEther(DEPLOYER_KEEPS)}).`);
  if (!sends.length) { console.log("Nothing to send: every role already has its amount."); return; }
  if (balance < total + DEPLOYER_KEEPS) {
    throw new Error(`not enough: fund the deployer with at least ${formatEther(total + DEPLOYER_KEEPS - balance)} more USDC and run this again`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\nType "yes" to send these transfers on Arc MAINNET: ')).trim();
  rl.close();
  if (answer !== "yes") { console.log("Nothing sent."); return; }

  for (const s of sends) {
    const hash = await wallet.sendTransaction({ to: s.to, value: s.value });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(`${s.role.padEnd(10)} sent ${formatEther(s.value)} USDC · ${receipt.status} · ${hash}`);
  }
  console.log("\nDone. Tell Claude, and it will check the balances and start the deploy.");
}

main().catch((e) => { console.error(`Stopped: ${e.shortMessage || e.message}`); process.exit(1); });
