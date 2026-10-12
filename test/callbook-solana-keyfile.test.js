// The Solana key file: made owner-only, refused when others can read it, and never shown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, readFileSync, readdirSync } from "node:fs";
import { inspect } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

import { loadOrCreateSolanaKeypair } from "../callbook/solana-keyfile.js";
import { keyFromEnv, clientFromEnv } from "../callbook/mcp-server.js";

const posix = process.platform !== "win32";
const tmp = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "arena-solkey-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const secretForms = (kp) => [
  bs58.encode(kp.secretKey), Buffer.from(kp.secretKey).toString("hex"), Buffer.from(kp.secretKey).toString("base64"),
  JSON.stringify(Array.from(kp.secretKey)), Buffer.from(kp.secretKey.subarray(0, 32)).toString("hex"),
];

test("a missing key file is made 0600 in a 0700 directory, then reused", { skip: !posix }, (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "nested", ".arena", "solana-keypair.json");
  const a = loadOrCreateSolanaKeypair(file);
  assert.equal(a.created, true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  const bytes = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(bytes.length, 64, "Solana CLI format: 64 bytes as JSON");
  assert.equal(a.publicKey, a.keypair.publicKey.toBase58());
  const b = loadOrCreateSolanaKeypair(file);
  assert.equal(b.created, false);
  assert.equal(b.publicKey, a.publicKey);
  assert.ok(!readdirSync(path.dirname(file)).some((f) => f.endsWith(".tmp")), "no temp file left behind");
});

test("a key file others can read or write is refused, and the error never shows the key", { skip: !posix }, (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "k.json");
  const kp = Keypair.generate();
  writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  for (const mode of [0o644, 0o640, 0o604, 0o620, 0o660]) {
    chmodSync(file, mode);
    let err;
    try {
      loadOrCreateSolanaKeypair(file);
    } catch (e) {
      err = e;
    }
    assert.ok(err, `mode ${mode.toString(8)} is refused`);
    assert.equal(err.code, "KeyFileOpen");
    assert.match(err.message, /chmod 600/);
    for (const s of secretForms(kp)) assert.ok(!err.message.includes(s), "no secret in the error");
    assert.equal(statSync(file).mode & 0o777, mode, "refused, not silently changed");
  }
  chmodSync(file, 0o600);
  assert.equal(loadOrCreateSolanaKeypair(file).publicKey, kp.publicKey.toBase58());
});

test("a file that isn't a keypair is refused without echoing it, and never overwritten", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "k.json");
  writeFileSync(file, "[1,2,3] secret-ish junk", { mode: 0o600 });
  assert.throws(() => loadOrCreateSolanaKeypair(file), (e) => e.code === "BadKeyFile" && !e.message.includes("junk"));
  assert.equal(readFileSync(file, "utf8"), "[1,2,3] secret-ish junk");
  assert.throws(() => loadOrCreateSolanaKeypair(dir), /isn't a file/);
});

test("ARENA_NETWORK=solana-devnet takes the key from ARENA_SOLANA_KEYPAIR", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "agent.json");
  const env = { ARENA_NETWORK: "solana-devnet", ARENA_SOLANA_KEYPAIR: file, ARENA_JOURNAL: "off", ARENA_SOLANA_SELF_PAY: "1",
    ARENA_COPIER_URL: "http://copier.test", ARENA_COPIER_PUBKEY: Buffer.alloc(32, 9).toString("base64"), CALLBOOK_KEY: `0x${"11".repeat(32)}` };
  const own = keyFromEnv(env);
  assert.equal(own.created, true);
  assert.equal(own.file, file);
  assert.ok(!("key" in own), "no EVM key is made or read on Solana");
  const client = clientFromEnv(env, own);
  assert.equal(client.solana, true);
  assert.equal(client.address, own.publicKey);
  assert.equal(client.network, "solana-devnet");
  assert.equal(client.selfPay, true);
  assert.equal(client.copier.url, "http://copier.test");
  assert.equal(client.keyFile, file);
  // Without `own`, it loads the same file.
  assert.equal(clientFromEnv(env).address, own.publicKey);
  for (const s of secretForms(own.keypair)) {
    assert.ok(!JSON.stringify(client).includes(s));
    assert.ok(!inspect(client, { depth: 5 }).includes(s));
  }
});

test("a key loaded from an existing file still signs validly (its secret isn't zeroed)", async () => {
  const { Transaction, SystemProgram } = await import("@solana/web3.js");
  const dir = mkdtempSync(path.join(tmpdir(), "arena-key-"));
  try {
    const kp = Keypair.generate();
    const file = path.join(dir, "k.json");
    writeFileSync(file, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
    const { keypair } = loadOrCreateSolanaKeypair(file);
    assert.equal(keypair.publicKey.toBase58(), kp.publicKey.toBase58());
    const tx = new Transaction({ feePayer: keypair.publicKey, blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 })
      .add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: kp.publicKey, lamports: 1 }));
    tx.sign(keypair);
    assert.ok(tx.verifySignatures(), "the signature verifies");
    assert.ok(keypair.secretKey.some((b) => b !== 0), "the secret is intact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
