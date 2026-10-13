// The copier's /preimage endpoint with a box sealed exactly as the agent SDK
// seals it (solana/preimage-box.js), and the body the SDK posts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seal, generateRecipientKeys } from "../../solana/preimage-box.js";
import { preimageHandler, readSecretFile } from "../src/server.js";

const keys = generateRecipientKeys();
const preimage = { program: "P", book: "B", owner: "O", callId: 4, coin: "SOL", side: 1, horizon: 3600, salt: `0x${"11".repeat(32)}` };

async function serve(copier) {
  const server = createServer(preimageHandler({ copier, boxKey: keys.privateKey, log: () => {} }));
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}
const post = (url, body) => fetch(`${url}/preimage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a sealed preimage reaches the copier opened, and its result comes back", async () => {
  const seen = [];
  const s = await serve({ handlePreimage: async (p) => (seen.push(p), { results: [{ status: "confirmed", latencyMs: 900 }] }) });
  try {
    const res = await post(s.url, { signature: "sig", owner: "O", book: "B", callId: 4, box: seal(preimage, keys.publicKey) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).results[0].latencyMs, 900);
    assert.deepEqual(seen[0], preimage);
  } finally { await s.close(); }
});

test("a box for another key, a tampered box, or a mismatched envelope is refused", async () => {
  const s = await serve({ handlePreimage: async () => assert.fail("must not reach the copier") });
  try {
    const other = generateRecipientKeys();
    assert.equal((await post(s.url, { owner: "O", callId: 4, box: seal(preimage, other.publicKey) })).status, 400);
    const box = seal(preimage, keys.publicKey);
    assert.equal((await post(s.url, { owner: "O", callId: 4, box: { ...box, ct: Buffer.from("x").toString("base64") } })).status, 400);
    assert.equal((await post(s.url, { owner: "someone else", callId: 4, box })).status, 400);
    assert.equal((await post(s.url, { owner: "O", callId: 5, box })).status, 400);
    assert.equal((await fetch(`${s.url}/preimage`, { method: "POST", body: "x".repeat(9_000) })).status, 413);
  } finally { await s.close(); }
});

test("the copier's refusals pass through with their status", async () => {
  const s = await serve({ handlePreimage: async () => { const e = new Error("x"); e.reason = "preimage-mismatch"; e.status = 422; throw e; } });
  try {
    const res = await post(s.url, { owner: "O", callId: 4, box: seal(preimage, keys.publicKey) });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: "preimage-mismatch" });
  } finally { await s.close(); }
});

test("secret files readable by others are refused", () => {
  const p = join(mkdtempSync(join(tmpdir(), "copier-")), "k");
  writeFileSync(p, "secret");
  chmodSync(p, 0o644);
  assert.throws(() => readSecretFile(p), /chmod 600/);
  chmodSync(p, 0o600);
  assert.equal(readSecretFile(p), "secret");
});

test("a slow copy is accepted with 202 inside the SDK's timeout, and carries on", async () => {
  let finished = false;
  const copier = { handlePreimage: () => new Promise((r) => setTimeout(() => { finished = true; r({ results: [] }); }, 300)) };
  const server = createServer(preimageHandler({ copier, boxKey: keys.privateKey, log: () => {}, replyWithinMs: 50 }));
  await new Promise((r) => server.listen(0, r));
  try {
    const res = await post(`http://127.0.0.1:${server.address().port}`, { owner: "O", callId: 4, box: seal(preimage, keys.publicKey) });
    assert.equal(res.status, 202);
    assert.equal(finished, false);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(finished, true);
  } finally { server.close(); }
});
