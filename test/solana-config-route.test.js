// GET /api/callbook/solana-config: what the Copy flow and the Following page
// need, in Solana mode only, public keys only. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Keypair } from "@solana/web3.js";

import { mountCallbook, solanaCopyConfig } from "../app/callbook-routes.js";
import { solanaNetwork } from "../app/verify/solana-network.js";
import { FOLLOW_PROGRAM_ID, DEVNET_USDC } from "../solana/follow.js";
import { VELOCITY_PROGRAM_ID } from "../app/client/solana-velocity-browser.js";

const FOLLOW_CONFIG = Keypair.generate().publicKey.toBase58();
const COPIER = Keypair.generate().publicKey.toBase58();
const SOLANA = { ARENA_NETWORK: "solana-devnet", ARENA_STATE_FILE: "/nonexistent/state.json" };

async function serve(env, fn) {
  const app = express();
  mountCallbook(app, { env, solanaConnection: {} });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("Solana mode serves the copy config, with devnet defaults", async () => {
  await serve({ ...SOLANA, FOLLOW_CONFIG, COPIER_PUBKEY: ` ${COPIER} `, SOLANA_RPC_URL: "https://rpc.example/?api-key=SECRET" }, async (url) => {
    const res = await fetch(`${url}/api/callbook/solana-config`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control"), /max-age=60/);
    const body = await res.json();
    assert.equal(body.ready, true);
    assert.deepEqual(body.problems, []);
    assert.equal(body.followConfig, FOLLOW_CONFIG);
    assert.equal(body.copier, COPIER, "trimmed");
    assert.equal(body.usdcMint, DEVNET_USDC.toBase58());
    assert.equal(body.followProgram, FOLLOW_PROGRAM_ID.toBase58());
    assert.equal(body.velocityProgram, VELOCITY_PROGRAM_ID.toBase58());
    assert.equal(body.cluster, "devnet");
    assert.equal(body.explorer, "https://explorer.solana.com?cluster=devnet");
    assert.equal(body.rpc, "https://api.devnet.solana.com", "the server's own RPC URL (and its key) never reaches the browser");
    assert.doesNotMatch(JSON.stringify(body), /SECRET/);
    assert.equal(body.quote.symbol, "dUSDT");
  });
});

test("without a follow config or copier key, copying isn't ready and says why", async () => {
  await serve({ ...SOLANA, COPIER_PUBKEY: "not-a-key", SOLANA_PUBLIC_RPC_URL: "https://public.example" }, async (url) => {
    const body = await (await fetch(`${url}/api/callbook/solana-config`)).json();
    assert.equal(body.ready, false);
    assert.equal(body.followConfig, null);
    assert.equal(body.copier, null);
    assert.equal(body.rpc, "https://public.example");
    assert.ok(body.problems.some((p) => /COPIER_PUBKEY isn't a valid public key/.test(p)));
    assert.ok(body.problems.some((p) => /FOLLOW_CONFIG is not set/.test(p)));
  });
});

test("outside Solana mode the route answers 404", async () => {
  await serve({}, async (url) => {
    assert.equal((await fetch(`${url}/api/callbook/solana-config`)).status, 404);
  });
});

test("solanaCopyConfig takes overrides and keeps defaults for bad ones", () => {
  const net = solanaNetwork(SOLANA);
  const usdc = Keypair.generate().publicKey.toBase58();
  const c = solanaCopyConfig({ FOLLOW_CONFIG, COPIER_PUBKEY: COPIER, USDC_MINT: usdc, VELOCITY_PROGRAM_ID: "bad" }, net);
  assert.equal(c.usdcMint, usdc);
  assert.equal(c.velocityProgram, VELOCITY_PROGRAM_ID.toBase58());
  assert.equal(c.ready, true);
  assert.deepEqual(c.problems, ["VELOCITY_PROGRAM_ID isn't a valid public key"]);
});
