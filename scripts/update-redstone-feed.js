/**
 * Push the latest signed RedStone price to the testnet feed.
 *
 *   npm run feed:redstone
 *
 * Trades push their own price first, so they never need this. It keeps the
 * feed fresh between trades, so agents' values and the public stop-loss read
 * a recent price when nobody has traded for a while. Any key with a little
 * testnet USDC for gas works: the contract checks RedStone's signatures, not
 * who sends them.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

import { OUT } from "./deploy-testnet.js";
import { pushPrice, REDSTONE_FEED_ABI } from "../mandate/redstone.js";

async function main() {
  const key = process.env.RATCHET_DEPLOYER_KEY;
  if (!key) {
    console.error("\n  RATCHET_DEPLOYER_KEY missing\n");
    process.exit(1);
  }
  const feed = JSON.parse(readFileSync(OUT, "utf8")).contracts.priceFeed;
  if (!feed) {
    console.error(`\n  no contracts.priceFeed in ${OUT}: run scripts/deploy-redstone-feed.js first\n`);
    process.exit(1);
  }
  const transport = http(undefined, { retryCount: 5, retryDelay: 800 });
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: arcTestnet, transport });
  const wallet = createWalletClient({ account, chain: arcTestnet, transport });

  const hash = await pushPrice({ publicClient, wallet, feed });
  const [, answer, , updatedAt] = await publicClient.readContract({ address: feed, abi: REDSTONE_FEED_ABI, functionName: "latestRoundData" });
  console.log(`\n  feed      ${feed}`);
  console.log(`  price     $${formatUnits(answer, 8)} (${Math.round(Date.now() / 1000 - Number(updatedAt))}s old)`);
  console.log(`  updated   ${hash}\n`);
}

main().catch((err) => {
  console.error(`\n  update failed: ${err.shortMessage ?? err.message}\n`);
  process.exit(1);
});
