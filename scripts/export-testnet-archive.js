/**
 * Freeze Arena's testnet month as static files, so the site can keep showing it after the move to mainnet.
 *
 *   node scripts/export-testnet-archive.js [--as-of 2026-10-10T02:00:00Z]
 *
 * Reads the testnet contract (resuming from app/data/callbook-state-testnet.json), scores every
 * record as of --as-of (default: when the testnet runner stopped, so the missed rounds after it
 * don't count) and writes app/public/data/arena-testnet.json plus arena-testnet-book-<id>.json and
 * arena-testnet-caller-<id>.json. The pages read them with ?net=testnet (callbook-common.js).
 *
 * Settings: ARENA_RPC for testnet (default: the chain's public RPC); the validator and our books
 * come from deployments/callbook-testnet*.json.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callbookNetwork, clientFor } from "../app/verify/callbook-network.js";
import { readCallbook, stateFromSnapshot } from "../app/verify/callbook-chain.js";
import { buildCallbook } from "../app/verify/callbook.js";
import { createPriceSource } from "../app/verify/callbook-prices.js";
import { parseFlags } from "./cli-flags.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = path.join(ROOT, "app", "public", "data");
const DEFAULT_AS_OF = "2026-10-10T02:00:00Z"; // the testnet runner's last pass
const ATTEMPTS = 30;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function patiently(label, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;
      console.log(`  ${label}: ${err.shortMessage ?? err.message}; retrying (${attempt})`);
      await sleep(4_000);
    }
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), { values: ["--as-of"], booleans: [] });
  const asOf = Math.floor(Date.parse(flags.get("--as-of") ?? DEFAULT_AS_OF) / 1000);
  if (!Number.isFinite(asOf)) throw new Error("--as-of must be a date, e.g. 2026-10-10T02:00:00Z");

  // Only testnet, whatever the shell says; ARENA_RPC may name a testnet RPC.
  const env = { CALLBOOK_RPC: process.env.ARENA_RPC ?? process.env.CALLBOOK_RPC, CALLBOOK_NETWORK: "testnet" };
  const net = callbookNetwork(env);
  const client = clientFor(net);
  const chainId = await client.getChainId();
  if (chainId !== 5042002) throw new Error(`that RPC is chain ${chainId}, not Arc testnet (5042002)`);
  const opts = { validationRegistry: net.registry ?? undefined, validator: net.validator ?? undefined };

  let state = existsSync(net.stateFile) ? stateFromSnapshot(readFileSync(net.stateFile, "utf8"), { address: net.address, chainId, ...opts }) : null;
  console.log(state ? `\n  resuming from block ${state.toBlock}` : `\n  reading testnet from block ${net.fromBlock}`);
  state = await patiently("logs", () => readCallbook({ client, address: net.address, fromBlock: net.fromBlock, ...opts, state }));

  const when = new Date(asOf * 1000).toISOString().slice(0, 16).replace("T", " ");
  const meta = {
    mode: "live", archive: true, network: "Arc testnet", chainId, explorer: net.explorer,
    contract: net.address.toLowerCase(), validationRegistry: net.registry?.toLowerCase() ?? null,
    note: `Arena's month on Arc testnet, frozen as of ${when} UTC when it moved to mainnet. Scored with the same rules.`,
  };
  const built = await buildCallbook({
    chain: state, source: createPriceSource({ log: (m) => console.log(`  prices: ${m}`) }), asOf, meta,
    validator: net.validator ?? undefined, log: (m) => console.log(`  ${m}`), ours: net.ours, maxCoins: Infinity,
  });

  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) if (/^arena-testnet-(book|caller)-\d+\.json$/.test(f)) unlinkSync(path.join(OUT_DIR, f));
  writeFileSync(path.join(OUT_DIR, "arena-testnet.json"), `${JSON.stringify(built.index)}\n`);
  for (const [id, d] of built.details) writeFileSync(path.join(OUT_DIR, `arena-testnet-book-${id}.json`), `${JSON.stringify(d)}\n`);
  for (const [id, d] of built.callerDetails) writeFileSync(path.join(OUT_DIR, `arena-testnet-caller-${id}.json`), `${JSON.stringify(d)}\n`);
  console.log(`  ${built.index.books.length} agents, ${built.index.callers.length} people, as of ${when} UTC: written to app/public/data/arena-testnet*.json\n`);
}

main().catch((err) => {
  console.error("\n  export failed:", err.shortMessage ?? err.message);
  process.exit(1);
});
