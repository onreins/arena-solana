/**
 * The Solana validator loop: read the Arena program, keep the API's chain
 * snapshot fresh, score every book with the shared scorer, and write Score
 * accounts for the books on the allowlist.
 *
 *   ARENA_NETWORK=solana-devnet node solana/validator.js [--once]
 *
 * Env:
 *   ARENA_SOLANA_VALIDATOR_KEYPAIR   the validator's keypair file (0600); its public key is ARENA_SOLANA_VALIDATOR
 *   ARENA_SCORE_OWNERS               comma-separated owners (base58) to post scores for, e.g. the house agents
 *   ARENA_STATE_FILE                 where the API reads its snapshot (default data/solana-devnet-state.json)
 *   SOLANA_RPC_URL                   default https://api.devnet.solana.com
 *   ARENA_REPORT_BASE                public URL of the app, for report URIs
 */
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair } from "@solana/web3.js";

import { readSolanaArena, solanaSnapshotText, solanaStateFromSnapshot } from "../app/verify/solana-chain.js";
import { buildCallbook } from "../app/verify/callbook.js";
import { createPriceSource } from "../app/verify/callbook-prices.js";
import { publishSolanaScores } from "./publish-scores.js";

const HOUR = 3_600_000;

async function main() {
  const env = process.env;
  const keyFile = env.ARENA_SOLANA_VALIDATOR_KEYPAIR;
  if (!keyFile) throw new Error("ARENA_SOLANA_VALIDATOR_KEYPAIR is not set");
  if (statSync(keyFile).mode & 0o077) throw new Error(`${keyFile} is readable by others: chmod 600 it.`);
  const validator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyFile, "utf8"))));
  const validatorText = validator.publicKey.toBase58();
  const connection = new Connection(env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const stateFile = env.ARENA_STATE_FILE || fileURLToPath(new URL("../data/solana-devnet-state.json", import.meta.url));
  const allow = new Set((env.ARENA_SCORE_OWNERS || "").split(",").map((s) => s.trim()).filter(Boolean));
  const source = createPriceSource({ log: () => {} });
  const spent = new Map();
  console.log(`validator ${validatorText}; posting for ${allow.size} owner(s)`);

  let state = existsSync(stateFile) ? solanaStateFromSnapshot(readFileSync(stateFile, "utf8"), { validator: validatorText }) : null;
  let lastScoring = 0;
  const once = process.argv.includes("--once");
  for (;;) {
    try {
      state = await readSolanaArena({ connection, validator: validatorText, state: state ?? undefined });
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(`${stateFile}.tmp`, solanaSnapshotText(state));
      renameSync(`${stateFile}.tmp`, stateFile);
      if (once || Date.now() - lastScoring >= HOUR) {
        lastScoring = Date.now();
        const now = Math.floor(Date.now() / 1000);
        const built = await buildCallbook({ chain: state, source, asOf: now, meta: {}, validator: validatorText, reportBase: env.ARENA_REPORT_BASE, log: console.log });
        await publishSolanaScores({ chain: state, evaluated: built.evaluated, connection, validator, now, allow, spent, log: console.log });
      }
    } catch (err) {
      console.error(`validator: ${err.message}`);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`validator: ${err.message}`);
    process.exit(1);
  });
}
