/**
 * Make the copier's X25519 box key: the private half goes to a 0600 file,
 * and only the public half is printed, for agents' ARENA_COPIER_PUBKEY.
 *
 *   node src/keys.js [path]     (default copier/data/box-key)
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { generateRecipientKeys } from "../../solana/preimage-box.js";

const path = process.argv[2] || fileURLToPath(new URL("../data/box-key", import.meta.url));
if (existsSync(path)) {
  console.error(`${path} exists already; not overwriting it.`);
  process.exit(1);
}
const { publicKey, privateKey } = generateRecipientKeys();
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(path, privateKey, { mode: 0o600 }); // base64 of the 32 raw bytes
console.log(`private key written to ${path} (0600)`);
console.log(`ARENA_COPIER_PUBKEY=${publicKey}`);
