/**
 * Deploy FreshCheckpoint to Arc testnet and record it.
 *
 *   node --env-file=.env scripts/deploy-fresh-checkpoint.js
 *
 * FreshCheckpoint pushes a fresh RedStone price and runs a mandate's public
 * stop-loss in one transaction. The app's "freeze" action sends to it for
 * mandates priced by a RedStone feed. Writes contracts.freshCheckpoint to
 * deployments/mandate-testnet.json.
 *
 * Uses RATCHET_DEPLOYER_KEY, which is testnet-only and must never hold value.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { artifact } from "./artifact.js";
import { OUT } from "./deploy-testnet.js";

async function main() {
  const key = process.env.RATCHET_DEPLOYER_KEY;
  if (!key) {
    console.error("\n  RATCHET_DEPLOYER_KEY missing from .env\n");
    process.exit(1);
  }
  const transport = http(undefined, { retryCount: 5, retryDelay: 800 });
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });
  const wallet = createWalletClient({ account, chain: arcTestnet, transport });

  const { abi, bytecode } = artifact("FreshCheckpoint");
  const hash = await wallet.deployContract({ abi, bytecode, account, chain: arcTestnet });
  const { contractAddress, status } = await publicClient.waitForTransactionReceipt({ hash });
  if (status !== "success") throw new Error(`deploy reverted: ${hash}`);

  const deployment = JSON.parse(readFileSync(OUT, "utf8"));
  deployment.contracts.freshCheckpoint = contractAddress;
  deployment.txs.freshCheckpoint = hash;
  writeFileSync(OUT, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`\n  freshCheckpoint  ${contractAddress}\n  recorded         ${OUT}\n`);
}

main().catch((err) => {
  console.error(`\n  deploy failed: ${err.shortMessage ?? err.message}\n`);
  process.exit(1);
});
