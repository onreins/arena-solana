/**
 * The agent's Solana key for Arena: a keypair file in the Solana CLI format
 * (a JSON array of the 64 secret-key bytes), default ~/.arena/solana-keypair.json,
 * or the path in ARENA_SOLANA_KEYPAIR.
 *
 * Made on first use with owner-only permissions (the file 0600, a directory
 * it creates 0700). An existing file that its group or others can read or
 * write is refused, not fixed: someone may already have copied it, so the
 * person decides (chmod 600 it, or move it and start a new key).
 *
 * Nothing here ever prints, logs or returns the secret in a message: errors
 * name the file, never its contents. Callers get a Keypair object to sign with.
 */
import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Keypair } from "@solana/web3.js";

import { CallbookError } from "./errors.js";

const NO_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);
const POSIX = process.platform !== "win32";

export const defaultSolanaKeyPath = () => path.join(homedir(), ".arena", "solana-keypair.json");

function read(file) {
  let st;
  try {
    st = statSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (!st.isFile()) throw new CallbookError(`${file} isn't a file, so it can't be the Solana key.`, "BadKeyFile");
  if (POSIX && st.mode & 0o077) {
    throw new CallbookError(
      `${file} is readable or writable by other users (mode ${(st.mode & 0o777).toString(8)}), so it isn't used. ` +
      `If nobody else could have copied it, run: chmod 600 ${file}. Otherwise move it away and a new key is made.`,
      "KeyFileOpen",
    );
  }
  let bytes;
  try {
    bytes = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    bytes = null;
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new CallbookError(`${file} isn't a Solana keypair file (a JSON array of 64 bytes). Fix or move it: it's never overwritten.`, "BadKeyFile");
  }
  const secret = Uint8Array.from(bytes);
  bytes.fill(0);
  try {
    return Keypair.fromSecretKey(secret);
  } catch {
    throw new CallbookError(`${file} holds 64 bytes that aren't a valid Solana keypair.`, "BadKeyFile");
  } finally {
    secret.fill(0);
  }
}

/**
 * The keypair in `file`, made first if there isn't one.
 * @returns {{ keypair: Keypair, publicKey: string, file: string, created: boolean }}
 */
export function loadOrCreateSolanaKeypair(file = defaultSolanaKeyPath()) {
  const existing = read(file);
  if (existing) return { keypair: existing, publicKey: existing.publicKey.toBase58(), file, created: false };

  const dir = path.dirname(file);
  const made = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (made && POSIX) chmodSync(dir, 0o700); // the umask can't loosen a directory we made
  const keypair = Keypair.generate();
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, { mode: 0o600 });
  if (POSIX) chmodSync(tmp, 0o600);
  const done = (created) => {
    const kp = created ? keypair : read(file);
    return { keypair: kp, publicKey: kp.publicKey.toBase58(), file, created };
  };
  try {
    linkSync(tmp, file);
    return done(true);
  } catch (err) {
    if (err.code === "EEXIST") return done(false);
    if (!NO_LINKS.has(err.code)) throw err;
    try {
      writeFileSync(file, `${JSON.stringify(Array.from(keypair.secretKey))}\n`, { flag: "wx", mode: 0o600 });
      return done(true);
    } catch (e) {
      if (e.code === "EEXIST") return done(false);
      throw e;
    }
  } finally {
    unlinkSync(tmp);
  }
}
