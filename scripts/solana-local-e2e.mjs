/**
 * The whole Solana product end to end on a local validator: a gasless lock
 * through the app's relay, the sealed preimage reaching the copier, which
 * checks it against the on-chain lock and sizes orders for a paid follower; a
 * subscription split on chain; the reveal; the chain read back into the shared
 * scorer; the Score account written; and another program gating on it.
 *
 *   solana-test-validator --reset \
 *     --bpf-program BderjFgzJGQ6NsqNfbVmtHDhzjHP6B3ijPMGCrmNffqw target/deploy/arena.so \
 *     --bpf-program A5Zpb539Yazb3kypH7tvZBVWuGCdCwXU6sdVU8RkgJHC target/deploy/follow.so \
 *     --bpf-program 4L1DyajAKPeY5rMXt3cMnk93qXJo3tV5XetmTi8jskcK target/deploy/score_gate.so
 *   node scripts/solana-local-e2e.mjs [--no-wait]
 *
 * What stays out: Velocity, which isn't on a local validator, so the copier's
 * exchange is a recorder that prints the orders it would place; and Hyperliquid
 * prices, which the scorer here gets as synthetic candles (labelled below).
 * With --no-wait it stops before the reveal (which is ~6 minutes after the lock).
 */
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} from "@solana/web3.js";

import { mountCallbook } from "../app/callbook-routes.js";
import { createCallbookClient } from "../callbook/sdk.js";
import { generateRecipientKeys } from "../solana/preimage-box.js";
import { bookAddress, scoreAddress } from "../solana/arena.js";
import {
  TOKEN_PROGRAM_ID, configAddress, planAddress, followAddress, associatedTokenAddress, createAssociatedTokenAccountIx,
  initConfigIx, setPlanIx, subscribeIx, approveIx, followsOfPlan, decodeFollowAccount, SIZE_FIXED,
} from "../solana/follow.js";
import { createCopier } from "../copier/src/copier.js";
import { openJournal } from "../copier/src/journal.js";
import { preimageHandler } from "../copier/src/server.js";
import { readSolanaArena } from "../app/verify/solana-chain.js";
import { buildCallbook } from "../app/verify/callbook.js";
import { publishSolanaScores } from "../solana/publish-scores.js";

const RPC = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const GATE_ID = new PublicKey("4L1DyajAKPeY5rMXt3cMnk93qXJo3tV5XetmTi8jskcK");
const USDC = 1_000_000n;
const connection = new Connection(RPC, "confirmed");
const link = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(RPC)}`;
const step = (s) => console.log(`\n== ${s}`);
const send = (ixs, signers) => sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

async function funded(sol = 10) {
  const k = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
  return k;
}

/** A local stand-in for USDC: a 6-decimal mint whose authority is `admin`. */
async function makeMint(admin) {
  const mint = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(82);
  const init = Buffer.alloc(67);
  init.writeUInt8(20, 0); // InitializeMint2
  init.writeUInt8(6, 1);
  admin.publicKey.toBuffer().copy(init, 2);
  await send([
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: 82, programId: TOKEN_PROGRAM_ID }),
    new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], data: init }),
  ], [admin, mint]);
  return mint.publicKey;
}
function mintToIx({ mint, to, authority, amount }) {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  return new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, data, keys: [
    { pubkey: mint, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false },
  ] });
}
const tokenBalance = async (a) => BigInt((await connection.getTokenAccountBalance(a)).value.amount);

/** Synthetic hourly and 5-minute candles: Hyperliquid isn't reachable from every machine. Labelled as such. */
function syntheticSource() {
  const row = (t) => {
    const p = 150 + 5 * Math.sin(t / 7_200);
    return { t, o: p, h: p * 1.004, l: p * 0.996, c: p, v: 1_000 };
  };
  return {
    perpNames: async () => ["BTC", "ETH", "SOL"],
    load: async (coins, from, to, interval) => {
      const stepSec = interval === "5m" ? 300 : 3_600;
      const candles = {};
      for (const c of coins) {
        candles[c] = [];
        for (let t = Math.floor(from / stepSec) * stepSec; t <= to; t += stepSec) candles[c].push(row(t));
      }
      return { interval, from, to, candles, funding: {}, fundingOk: false };
    },
  };
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// ------------------------------------------------------------------ setup

step("setup: local validator, relayer, validator, Reins admin, an agent and a follower");
console.log(`rpc ${RPC}, version ${(await connection.getVersion())["solana-core"]}`);
const relayer = await funded(), validator = await funded(), admin = await funded(), follower = await funded();
const keyDir = mkdtempSync(join(tmpdir(), "arena-e2e-"));

const app = express();
app.use(express.json({ limit: "64kb" }));
mountCallbook(app, {
  env: { ARENA_NETWORK: "solana-devnet", ARENA_SOLANA_RELAYER_KEY: JSON.stringify([...relayer.secretKey]), ARENA_SOLANA_VALIDATOR: validator.publicKey.toBase58() },
  solanaConnection: connection, source: syntheticSource(),
});
const appServer = await listen(app);
console.log(`app with the gasless relay at ${appServer.url}`);

// the copier: a recorder in place of Velocity
const box = generateRecipientKeys();
const placed = [];
const exchange = {
  market: async (coin) => (["SOL", "BTC", "ETH"].includes(coin) ? { marketIndex: 0, minSize: 10_000_000n, stepSize: 10_000_000n, price: 150n * USDC } : null),
  account: async () => ({ netValue: 1_000n * USDC, openCopied: 0, dayPnl: 0n }),
  sign: async (f, m, orders, o) => (placed.push({ follower: f.follower.toBase58(), orders, ...o }), { signature: `local-${placed.length}`, raw: "", lastValidBlockHeight: 0 }),
  send: async () => {},
  confirm: async () => "confirmed",
  status: async () => "confirmed",
};

// ------------------------------------------------------------------ the agent and its plan

step("the agent: a fresh key with no SOL, locking through the relay");
// Hyperliquid's market list, as the SDK checks coins against it (synthetic here, like the candles)
const perps = [{ coin: "SOL", price: 150 }, { coin: "BTC", price: 60_000 }, { coin: "ETH", price: 3_000 }];
const markets = {
  resolve: async (c) => perps.find((p) => p.coin === String(c).toUpperCase())?.coin ?? null,
  perps: async () => perps, names: async () => perps.map((p) => p.coin), list: async () => perps,
};
const agent = createCallbookClient({ network: "solana-devnet", keyFile: join(keyDir, "agent.json"), connection, relayUrl: appServer.url, markets, log: () => {} });
console.log(`agent ${agent.publicKey.toBase58()}, balance ${await connection.getBalance(agent.publicKey)} lamports`);

step("subscriptions: Reins' config, the agent's plan, a follower subscribing (split on chain)");
const mint = await makeMint(admin);
const treasury = associatedTokenAddress(admin.publicKey, mint);
const payout = associatedTokenAddress(agent.publicKey, mint);
const followerToken = associatedTokenAddress(follower.publicKey, mint);
const config = configAddress(admin.publicKey);
await send([
  createAssociatedTokenAccountIx({ payer: admin.publicKey, owner: admin.publicKey, mint }),
  createAssociatedTokenAccountIx({ payer: admin.publicKey, owner: agent.publicKey, mint }),
  createAssociatedTokenAccountIx({ payer: admin.publicKey, owner: follower.publicKey, mint }),
  mintToIx({ mint, to: followerToken, authority: admin.publicKey, amount: 1_000n * USDC }),
  initConfigIx({ admin: admin.publicKey, mint, treasury, reinsBps: 2000, perfReinsBps: 3000 }),
], [admin]);
const agentKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse((await import("node:fs")).readFileSync(join(keyDir, "agent.json"), "utf8"))));
const price = 20n * USDC;
await send([setPlanIx({ agent: agent.publicKey, payer: admin.publicKey, config, payout, price, perfFeeBps: 1000, open: true })], [admin, agentKeypair]);
const plan = planAddress(config, agent.publicKey);
const settings = { sizeMode: SIZE_FIXED, sizeValue: 100n * USDC, maxTrade: 250n * USDC, maxOpen: 3, dailyLossCap: 50n * USDC, subAccountId: 1 };
const subSig = await send([
  subscribeIx({ follower: follower.publicKey, config, agent: agent.publicKey, followerToken, payout, treasury, months: 1, settings, maxPrice: price, maxPerfFeeBps: 1000 }),
  approveIx({ account: followerToken, delegate: followAddress(plan, follower.publicKey), owner: follower.publicKey, amount: 50n * USDC }),
], [follower]);
console.log(`subscribed: ${link(subSig)}`);
console.log(`  agent's owner got ${await tokenBalance(payout)}, Reins' treasury ${await tokenBalance(treasury)} (of ${price}: 80/20)`);
const followAccount = decodeFollowAccount((await connection.getAccountInfo(followAddress(plan, follower.publicKey))).data);
console.log(`  follow paid until ${new Date(followAccount.paidUntil * 1000).toISOString()}, fee rate ${followAccount.perfFeeBps} bps`);

const copier = createCopier({ connection, exchange, journal: openJournal(null), followsForAgent: (a) => followsOfPlan(connection, planAddress(config, a)) });
const copierServer = await listen(preimageHandler({ copier, boxKey: box.privateKey, log: (m) => console.log(`  copier: ${m}`) }));
agent.copier = { url: copierServer.url, publicKey: box.publicKey };

// ------------------------------------------------------------------ lock

step("lock: SOL long, 5 minutes, with a stop and a target sealed in the salt");
const locked = await agent.lock({ coin: "SOL", side: "long", horizon: "5m", stop: "140", target: "175" });
console.log(`locked call ${locked.callId ?? 0} in ${locked.latencyMs} ms (gasless: ${locked.gasless}): ${link(locked.signature)}`);
console.log(`agent still holds ${await connection.getBalance(agent.publicKey)} lamports; the relayer paid`);
for (let i = 0; i < 50 && !placed.length; i++) await new Promise((r) => setTimeout(r, 100));
if (placed.length) {
  const p = placed[0];
  console.log(`copier verified the preimage against the lock and placed for ${p.follower}:`);
  for (const o of p.orders) console.log(`  ${o.kind}: ${o.direction} ${o.base} base units${o.triggerPrice ? ` trigger ${o.triggerCondition} ${o.triggerPrice}` : ""}${o.reduceOnly ? " reduce-only" : ""}`);
} else {
  console.log("copier placed nothing (did the SDK post the preimage?)");
}

if (process.argv.includes("--no-wait")) {
  console.log("\n--no-wait: stopping before the reveal.");
  appServer.close(); copierServer.close(); process.exit(0);
}

// ------------------------------------------------------------------ reveal

step("reveal: wait for the call's horizon, then reveal_due");
const status = await agent.status();
const dueAt = status.calls?.[0]?.revealAt ?? Math.floor(Date.now() / 1000) + 6 * 60;
for (;;) {
  const blockTime = await connection.getBlockTime(await connection.getSlot());
  if (blockTime >= dueAt + 2) break;
  process.stdout.write(`\r  ${dueAt + 2 - blockTime}s to go   `);
  await new Promise((r) => setTimeout(r, 5_000));
}
const revealed = await agent.revealDue();
console.log(`\n${revealed.summary ?? JSON.stringify(revealed.revealed)}`);
for (const r of revealed.revealed ?? []) if (r.signature) console.log(`  ${link(r.signature)}`);

// ------------------------------------------------------------------ score

step("score: read the chain into the shared scorer (synthetic candles), write the Score account");
const chain = await readSolanaArena({ connection, validator: validator.publicKey.toBase58() });
console.log(`read ${chain.books.size} book(s); book 1 has ${[...chain.books.values()][0]?.locks.size} lock(s), revealed: ${[...[...chain.books.values()][0].locks.values()].filter((l) => l.reveal).length}`);
const now = Math.floor(Date.now() / 1000);
const built = await buildCallbook({ chain, source: syntheticSource(), asOf: now, meta: {}, validator: validator.publicKey.toBase58(), log: () => {} });
const rows = await publishSolanaScores({ chain, evaluated: built.evaluated, connection, validator, now, allow: new Set([agent.publicKey.toBase58()]), log: (m) => console.log(`  ${m}`) });
const scored = rows.find((r) => r.tx);
if (scored) console.log(`score ${scored.score} written: ${link(scored.tx)}`);

step("compose: score-gate admits the agent only if the validator scored it high enough");
const scoreAcct = scoreAddress(validator.publicKey, bookAddress(agent.publicKey));
const disc = (await import("node:crypto")).createHash("sha256").update("global:admit").digest().subarray(0, 8);
for (const min of [0, 101]) {
  const data = Buffer.alloc(8 + 32 + 1 + 8); // discriminator, validator, min score, max age (0: any)
  disc.copy(data, 0);
  validator.publicKey.toBuffer().copy(data, 8);
  data.writeUInt8(min, 40);
  const ix = new TransactionInstruction({ programId: GATE_ID, data, keys: [{ pubkey: agent.publicKey, isSigner: false, isWritable: false }, { pubkey: scoreAcct, isSigner: false, isWritable: false }] });
  try {
    const sig = await send([ix], [admin]);
    console.log(`min ${min}: admitted ${link(sig)}`);
  } catch (err) {
    console.log(`min ${min}: refused (${/ScoreTooLow/.test(String(err.logs ?? err.message)) ? "ScoreTooLow" : err.message.slice(0, 80)})`);
  }
}

appServer.close(); copierServer.close();
console.log("\ndone");
process.exit(0);
