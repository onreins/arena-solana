// The app serves the Solana gasless relay at /api/solana/relay on a Solana
// network, and only with a relayer key; the key itself is never served.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Keypair } from "@solana/web3.js";

import { mountCallbook } from "../app/callbook-routes.js";

async function serve(env, connection = {}) {
  const app = express();
  app.use(express.json());
  mountCallbook(app, { env, solanaConnection: connection, source: { perpNames: async () => [], load: async () => ({ candles: {}, funding: {} }) } });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("with a relayer key, GET answers the fee payer and a blockhash, and never the key", async () => {
  const relayer = Keypair.generate();
  const connection = { getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 9 }) };
  const s = await serve({ ARENA_NETWORK: "solana-devnet", ARENA_SOLANA_RELAYER_KEY: JSON.stringify([...relayer.secretKey]) }, connection);
  try {
    const res = await fetch(`${s.url}/api/solana/relay`);
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.feePayer, relayer.publicKey.toBase58());
    assert.equal(body.lastValidBlockHeight, 9);
    assert.ok(!text.includes(JSON.stringify([...relayer.secretKey]).slice(1, 40)), "no part of the secret key");
    const bad = await fetch(`${s.url}/api/solana/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: "not a transaction" }) });
    assert.equal(bad.status, 400);
  } finally { s.close(); }
});

test("without a relayer key, or off Solana, it answers 503", async () => {
  for (const env of [{ ARENA_NETWORK: "solana-devnet" }, {}]) {
    const s = await serve(env);
    try {
      const res = await fetch(`${s.url}/api/solana/relay`);
      assert.equal(res.status, 503);
      assert.match((await res.json()).error, /relay/);
    } finally { s.close(); }
  }
});
