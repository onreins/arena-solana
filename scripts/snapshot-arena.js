/**
 * Save Arena's chain reads so a fresh API instance doesn't rescan the chain.
 *
 *   ARENA_NETWORK=testnet npm run snapshot:arena
 *
 * The API (app/callbook-routes.js) reads every book, lock and reveal from logs,
 * paged 5,000 blocks at a time through Arc's rate-limited public RPC. A
 * long-lived server does that once; a serverless one does it on every cold
 * start, and a few days after a deploy it runs past the function's time limit.
 * Past logs never change, so this writes the state up to the chain's head to
 * app/data/callbook-state-<network>.json (the file the API and the runner
 * already resume from); the API then reads only newer blocks. It resumes from
 * the last snapshot, and reads every reveal's salt (stop and target) so the
 * API doesn't have to.
 *
 * Settings: the same ARENA_* variables as the API (app/verify/callbook-network.js).
 * A snapshot only counts when it was read with the API's contract, registry and
 * validator, so set ARENA_VALIDATOR as the API does (or let the deployment record name it).
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

import { callbookNetwork, clientFor } from "../app/verify/callbook-network.js";
import { readCallbook, snapshotText, stateFromSnapshot } from "../app/verify/callbook-chain.js";
import { EXITS_SINCE } from "../app/verify/callbook-exits.js";

const ATTEMPTS = 30;
const BACKOFF_MS = 4_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A read resumes from where the failed one stopped, so retrying after a rate limit is cheap. */
async function patiently(label, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;
      console.log(`  ${label}: ${err.shortMessage ?? err.message}; retrying (${attempt})`);
      await sleep(BACKOFF_MS);
    }
  }
}

/** Reveals whose salt hasn't been read yet (callbook-chain.js reads a batch per read). */
const unread = (state) => [...state.books.values()].filter((b) => b.kind === "free")
  .reduce((n, b) => n + [...b.locks.values()].filter((l) => l.reveal && l.reveal.salt === undefined && l.lockedAt >= EXITS_SINCE).length, 0);

async function main() {
  const net = callbookNetwork(process.env);
  if (!net) throw new Error("set ARENA_NETWORK (testnet or mainnet)");
  if (net.validationOff) console.log(`  note: ${net.validationOff}`);
  const client = clientFor(net);
  const chainId = await client.getChainId();
  const opts = { validationRegistry: net.registry ?? undefined, validator: net.validator ?? undefined };

  let state = existsSync(net.stateFile)
    ? stateFromSnapshot(readFileSync(net.stateFile, "utf8"), { address: net.address, chainId, ...opts })
    : null;
  console.log(state ? `\n  resuming from block ${state.toBlock}` : `\n  reading ${net.label} from block ${net.fromBlock}`);

  const read = () => readCallbook({ client, address: net.address, fromBlock: net.fromBlock, ...opts, state });
  state = await patiently("logs", read);
  // Each read looks up a batch of reveal salts; keep going until none is left (or they stop moving).
  for (let left = unread(state), last = Infinity; left && left < last; last = left, left = unread(state)) {
    console.log(`  reading ${left} reveal salt${left === 1 ? "" : "s"}`);
    state = await patiently("salts", read);
  }

  const tmp = `${net.stateFile}.tmp`;
  writeFileSync(tmp, `${snapshotText(state, opts)}\n`);
  renameSync(tmp, net.stateFile);
  const books = state.books.size, calls = [...state.books.values()].reduce((n, b) => n + (b.locks?.size ?? b.seals?.size ?? 0), 0);
  console.log(`  ${books} books, ${calls} calls, up to block ${state.toBlock}: saved to ${path.relative(process.cwd(), net.stateFile)}\n`);
}

main().catch((err) => {
  console.error("\n  snapshot failed:", err.shortMessage ?? err.message);
  process.exit(1);
});
