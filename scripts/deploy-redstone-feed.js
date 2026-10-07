/**
 * Deploy the RedStone EURC/USD feed to Arc testnet and record it.
 *
 *   node --env-file=.env scripts/deploy-redstone-feed.js
 *
 * Deploys RedStonePriceFeed for RedStone's "EUROC" feed (Circle's EURC under
 * its first ticker), pushes the first signed price, and writes the address to
 * deployments/mandate-testnet.json as contracts.priceFeed. New agents created
 * in the app read it instead of PinnedFeed, so their trades are checked
 * against a price seconds old rather than a copy refreshed every few hours.
 *
 * Uses RATCHET_DEPLOYER_KEY, which is testnet-only and must never hold value.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, stringToHex, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { artifact } from "./artifact.js";
import { OUT } from "./deploy-testnet.js";
import { pushPrice, REDSTONE_FEED_ABI } from "../mandate/redstone.js";

const FEED_ID = "EUROC";
const DESCRIPTION = "EURC / USD (RedStone EUROC, primary-prod)";

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

  const { abi, bytecode } = artifact("RedStonePriceFeed");
  const deployHash = await wallet.deployContract({
    abi,
    bytecode,
    args: [stringToHex(FEED_ID, { size: 32 }), DESCRIPTION],
    account,
    chain: arcTestnet,
  });
  const { contractAddress: feed, status } = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (status !== "success") throw new Error(`deploy reverted: ${deployHash}`);
  console.log(`\n  feed      ${feed}`);

  const updateHash = await pushPrice({ publicClient, wallet, feed });
  const [, answer, , updatedAt] = await publicClient.readContract({ address: feed, abi: REDSTONE_FEED_ABI, functionName: "latestRoundData" });
  console.log(`  price     $${formatUnits(answer, 8)} (${Math.round(Date.now() / 1000 - Number(updatedAt))}s old)`);
  console.log(`  updated   ${updateHash}`);

  const deployment = JSON.parse(readFileSync(OUT, "utf8"));
  deployment.contracts.priceFeed = feed;
  deployment.txs.priceFeed = deployHash;
  deployment.oracleNote =
    "New agents read priceFeed, a RedStonePriceFeed (EUROC) pushed with a fresh signed price before every trade. " +
    "PinnedFeed carries the mainnet Chainlink answer for agents created before it; Chainlink does not publish to Arc testnet.";
  writeFileSync(OUT, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`  recorded  ${OUT} contracts.priceFeed\n`);
}

main().catch((err) => {
  console.error(`\n  deploy failed: ${err.shortMessage ?? err.message}\n`);
  process.exit(1);
});
