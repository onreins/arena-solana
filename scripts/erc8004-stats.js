/**
 * How busy Arc's ERC-8004 registries are: agents registered, validation
 * requests filed, and how many of them have had any response. Read-only.
 *
 *   node scripts/erc8004-stats.js [--network mainnet|testnet] [--rpc URL] [--list]
 *
 * Uses only the reference contracts' getters (no log scan, which public RPCs
 * cap at a few thousand blocks): agent ids count up from 0, so the agent count
 * is the first id with no owner; per agent, getAgentValidations gives its
 * requests and getSummary(agentId, [], "") counts those with a response.
 * --list prints every request with its validator and latest response.
 */
import { createPublicClient, http, parseAbi } from "viem";
import { arc, arcTestnet } from "viem/chains";

import { REGISTRIES } from "../evaluator/abi.js";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const BATCH = 150;
/** Past this many agents (testnet has ~900k) a per-agent sweep is too slow for a public RPC. */
const MAX_SWEEP = 20_000;
const ABI = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function getAgentValidations(uint256) view returns (bytes32[])",
  "function getSummary(uint256, address[], string) view returns (uint64 count, uint8 avg)",
  "function getValidationStatus(bytes32) view returns (address validator, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
  "function getVersion() view returns (string)",
]);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
};

async function agentCount(client, identity) {
  const exists = (id) => client.readContract({ address: identity, abi: ABI, functionName: "ownerOf", args: [BigInt(id)] }).then(() => true, () => false);
  if (!(await exists(0))) return 0;
  let hi = 1;
  while (await exists(hi)) hi *= 2;
  let lo = hi / 2; // exists(lo), !exists(hi)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }
  return hi;
}

async function main() {
  const chain = arg("--network", "mainnet") === "testnet" ? arcTestnet : arc;
  const { identity, validation } = REGISTRIES[chain.id];
  const client = createPublicClient({ chain, transport: http(arg("--rpc", undefined), { retryCount: 6, retryDelay: 1_500 }) });
  const block = await client.getBlock();
  const n = await agentCount(client, identity);
  const version = await client.readContract({ address: validation, abi: ABI, functionName: "getVersion" });

  const withRequests = [];
  let requests = 0, answered = 0;
  if (n > MAX_SWEEP) {
    console.log(`\n  ${chain.name}: ${n} agents, too many to sweep request by request; nothing counted\n`);
    return;
  }
  for (let s = 0; s < n; s += BATCH) {
    const ids = Array.from({ length: Math.min(BATCH, n - s) }, (_, k) => BigInt(s + k));
    const res = await client.multicall({
      multicallAddress: MULTICALL3, allowFailure: false,
      contracts: ids.flatMap((id) => [
        { address: validation, abi: ABI, functionName: "getAgentValidations", args: [id] },
        { address: validation, abi: ABI, functionName: "getSummary", args: [id, [], ""] },
      ]),
    });
    ids.forEach((id, k) => {
      const hashes = res[2 * k], [count] = res[2 * k + 1];
      requests += hashes.length;
      answered += Number(count);
      if (hashes.length) withRequests.push({ id, hashes });
    });
  }

  console.log(`\n  ${chain.name} (chain ${chain.id}) at block ${block.number}, ${new Date(Number(block.timestamp) * 1000).toISOString()}`);
  console.log(`  IdentityRegistry ${identity}: ${n} agents`);
  console.log(`  ValidationRegistry ${validation} v${version}: ${requests} requests from ${withRequests.length} agents, ${answered} with a response`);
  if (process.argv.includes("--list")) {
    for (const { id, hashes } of withRequests) {
      for (const h of hashes) {
        const s = await client.readContract({ address: validation, abi: ABI, functionName: "getValidationStatus", args: [h] });
        console.log(`    agent #${id} ${h} validator ${s[0]} response ${s[2]} tag "${s[4]}" updated ${new Date(Number(s[5]) * 1000).toISOString()}`);
      }
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n  failed: ${err.shortMessage ?? err.message}\n`);
  process.exitCode = 1;
});
