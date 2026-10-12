/**
 * The Solana site's background services in one process, for Railway (or any
 * always-on host): the copier, the validator and the house agents. Each runs
 * as a child process and is restarted if it exits.
 *
 *   node scripts/solana-services.mjs
 *
 * Secrets come from the environment and are written to 0600 files in a
 * private temporary folder (the services read key files). Nothing secret is
 * ever logged. Env (see docs/solana/HOSTING.md):
 *   SOLANA_RPC_URL           a devnet RPC (a dedicated one is advised)
 *   FOLLOW_CONFIG            the follow program Config the copier serves
 *   ARENA_RELAY_URL          the Solana site (its /api/solana/relay pays the house agents' fees)
 *   PORT                     the copier listens here (Railway sets it)
 *   COPIER_KEY               the copier's keypair, a JSON array of 64 numbers
 *   COPIER_BOX_KEY           its X25519 private key, base64
 *   ARENA_SOLANA_VALIDATOR_KEY   the validator's keypair (JSON array)
 *   ARENA_SCORE_OWNERS       comma-separated agents to post scores for
 *   HOUSE_HOT_KEY, HOUSE_COLD_KEY, HOUSE_FLIP_KEY   the house agents' keypairs (JSON arrays)
 *   ARENA_HOUSE_SECRET       at least 32 characters (the coin flip)
 *   ARENA_COPIER_PUBKEY      the box key's public half, base64 (house agents send their calls to the copier)
 *   SERVICES                 optional: which to run, e.g. "copier,validator" (default all three)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = process.env;
const need = (k) => {
  if (!env[k]) throw new Error(`${k} is not set (see docs/solana/HOSTING.md)`);
  return env[k];
};

/** Secrets to 0600 files in a 0700 folder; returns their paths. */
export function writeSecrets(entries, dir = mkdtempSync(join(tmpdir(), "reins-solana-"))) {
  chmodSync(dir, 0o700);
  const paths = {};
  for (const [name, value] of Object.entries(entries)) {
    if (value == null) continue;
    const file = join(dir, name);
    writeFileSync(file, value, { mode: 0o600 });
    paths[name] = file;
  }
  return paths;
}

/** Run a service forever: restart it after it exits, waiting longer each time it fails fast. */
export function keep(name, args, extraEnv, { log = console.log, spawnFn = spawn, maxWaitMs = 60_000 } = {}) {
  let wait = 1_000, stopped = false, child = null;
  const start = () => {
    const started = Date.now();
    child = spawnFn(process.execPath, args, { cwd: root, env: { ...env, NODE_USE_ENV_PROXY: env.NODE_USE_ENV_PROXY ?? "", ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    const prefix = (chunk) => String(chunk).split("\n").filter(Boolean).forEach((l) => log(`[${name}] ${l}`));
    child.stdout?.on("data", prefix);
    child.stderr?.on("data", prefix);
    child.on("exit", (code) => {
      if (stopped) return;
      wait = Date.now() - started > 60_000 ? 1_000 : Math.min(wait * 2, maxWaitMs);
      log(`[${name}] exited (${code}); restarting in ${Math.round(wait / 1000)}s`);
      setTimeout(start, wait);
    });
  };
  start();
  return { stop: () => { stopped = true; child?.kill(); } };
}

async function main() {
  const wanted = new Set((env.SERVICES || "copier,validator,house").split(",").map((s) => s.trim()));
  const rpc = env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const files = writeSecrets({
    "copier.json": wanted.has("copier") ? need("COPIER_KEY") : null,
    "box-key": wanted.has("copier") ? need("COPIER_BOX_KEY") : null,
    "validator.json": wanted.has("validator") ? need("ARENA_SOLANA_VALIDATOR_KEY") : null,
  });
  const dataDir = join(tmpdir(), "reins-solana-data");
  mkdirSync(dataDir, { recursive: true });
  const common = { ARENA_NETWORK: "solana-devnet", SOLANA_RPC_URL: rpc, ARENA_SOLANA_RPC: rpc };

  if (wanted.has("copier")) {
    keep("copier", ["copier/src/server.js"], {
      ...common, COPIER_KEYPAIR: files["copier.json"], COPIER_BOX_KEY: files["box-key"],
      FOLLOW_CONFIG: need("FOLLOW_CONFIG"), COPIER_JOURNAL: join(dataDir, "journal.jsonl"), PORT: env.PORT || "8790",
    });
  }
  if (wanted.has("validator")) {
    keep("validator", ["solana/validator.js"], {
      ...common, ARENA_SOLANA_VALIDATOR_KEYPAIR: files["validator.json"], ARENA_SCORE_OWNERS: env.ARENA_SCORE_OWNERS || "",
      ARENA_STATE_FILE: join(dataDir, "state.json"),
    });
  }
  if (wanted.has("house")) {
    const house = writeSecrets({ "hot.json": need("HOUSE_HOT_KEY"), "cold.json": need("HOUSE_COLD_KEY"), "flip.json": need("HOUSE_FLIP_KEY") });
    keep("house", ["solana/house-agents.js"], {
      ...common, ARENA_HOUSE_KEYS_DIR: house["hot.json"].replace(/\/hot\.json$/, ""), ARENA_HOUSE_SECRET: need("ARENA_HOUSE_SECRET"),
      ARENA_RELAY_URL: need("ARENA_RELAY_URL"), ARENA_COPIER_URL: env.ARENA_COPIER_URL || `http://127.0.0.1:${env.PORT || "8790"}`,
      ARENA_COPIER_PUBKEY: env.ARENA_COPIER_PUBKEY || "",
    });
  }
  console.log(`solana services: ${[...wanted].join(", ")} on ${rpc.replace(/\?.*$/, "")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`solana services: ${err.message}`);
    process.exit(1);
  });
}
