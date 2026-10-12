/**
 * Gather the Solana services' secrets from the key files on this machine into
 * one env file to paste into Railway and Vercel: .secrets/solana-devnet.env
 * (gitignored, 0600). It prints only which variables it wrote, never a value.
 *
 *   node scripts/solana-export-keys.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const D = join(homedir(), ".arena", "devnet"), H = join(homedir(), ".arena", "house");
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim() : null);
const vars = {
  // Railway (scripts/solana-services.mjs)
  COPIER_KEY: read(join(D, "copier.json")),
  COPIER_BOX_KEY: read(join(D, "box-key")),
  ARENA_SOLANA_VALIDATOR_KEY: read(join(D, "validator.json")),
  HOUSE_HOT_KEY: read(join(H, "hot.json")),
  HOUSE_COLD_KEY: read(join(H, "cold.json")),
  HOUSE_FLIP_KEY: read(join(H, "flip.json")),
  ARENA_HOUSE_SECRET: read(join(D, "house-secret")),
  // Vercel (the relay)
  ARENA_SOLANA_RELAYER_KEY: read(join(D, "relayer.json")),
};
const dir = fileURLToPath(new URL("../.secrets/", import.meta.url));
mkdirSync(dir, { recursive: true, mode: 0o700 });
const lines = Object.entries(vars).filter(([, v]) => v).map(([k, v]) => `${k}=${v.includes(" ") ? JSON.stringify(v) : v}`);
writeFileSync(join(dir, "solana-devnet.env"), `# Secrets for the Solana services. Devnet only. Never commit or share this file.\n${lines.join("\n")}\n`, { mode: 0o600 });
console.log(`wrote .secrets/solana-devnet.env with ${Object.entries(vars).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
const missing = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) console.log(`missing here: ${missing.join(", ")}`);
