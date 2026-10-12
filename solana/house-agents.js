/**
 * Our house agents on Solana: the same Hot list, Cold list and Coin flip
 * strategies as on Arc (runner/callbook-agents.js), each locking a call every
 * four hours from its own key and revealing it once due, so the demo has real
 * records and agents to copy from day one.
 *
 * Solana books are open-call books, so each period is a lock with a 4-hour
 * horizon. Coins default to the ones Velocity's devnet lists, so every call
 * can be copied.
 *
 *   ARENA_NETWORK=solana-devnet node solana/house-agents.js [--once]
 *
 * Env:
 *   ARENA_HOUSE_KEYS_DIR   folder with hot.json, cold.json, flip.json (Solana keypairs, 0600;
 *                          made on first run, like the SDK's own key file)
 *   ARENA_HOUSE_SECRET     at least 32 characters: the coin flip derives from it
 *   ARENA_HOUSE_COINS      default BTC,ETH,SOL
 *   plus the SDK's: ARENA_RELAY_URL, ARENA_SOLANA_RPC, ARENA_COPIER_URL, ARENA_COPIER_PUBKEY
 *
 * Secrets are never logged.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { AGENTS } from "../runner/callbook-agents.js";
import { createPriceSource, priceBook, intervalFor } from "../app/verify/callbook-prices.js";
import { createCallbookClient } from "../callbook/sdk.js";
import { ARENA_PROGRAM_ID } from "./arena.js";

export const PERIOD = 4 * 3_600;
const DAY = 86_400;

/** The period a lock made now belongs to. */
export const periodOf = (nowSec) => Math.floor(nowSec / PERIOD);

/**
 * One agent's call for the period: the Arc strategy, given only the coins
 * copyable here and the same price view. null when it has no view (flat).
 */
export async function decideCall(agent, { coins, view, now, secret }) {
  const p = periodOf(now);
  const pick = await agent.decide({
    coins: agent.key === "flip" ? ["BTC"] : coins, view, now, secret,
    chainId: "solana-devnet", callbook: ARENA_PROGRAM_ID.toBase58(), bookId: agent.key, p,
  });
  if (!pick || pick.side === 0 || pick.coinIndex < 0) return null;
  const list = agent.key === "flip" ? ["BTC"] : coins;
  return { coin: list[pick.coinIndex], side: pick.side, why: pick.why, p };
}

/** One pass: reveal what's due, then lock this period's call if not yet locked. */
export async function tick({ agents, clients, source, coins, secret, now = Math.floor(Date.now() / 1000), locked, log = console.log }) {
  for (const agent of agents) {
    const client = clients[agent.key];
    try {
      const revealed = await client.revealDue();
      if (revealed?.revealed?.length) log(`${agent.name}: revealed ${revealed.revealed.length}`);
    } catch (err) {
      log(`${agent.name}: reveal failed: ${err.message}`);
    }
    const p = periodOf(now);
    if (locked.get(agent.key) === p) continue;
    const want = agent.key === "flip" ? ["BTC"] : coins;
    const interval = intervalFor(PERIOD, PERIOD);
    const data = await source.load(want, now - 2 * DAY, now, interval);
    const view = priceBook({ ...data, interval }, { upTo: now });
    const call = await decideCall(agent, { coins, view, now, secret });
    locked.set(agent.key, p);
    if (!call) {
      log(`${agent.name}: no call this period`);
      continue;
    }
    const out = await client.lock({ coin: call.coin, side: call.side > 0 ? "long" : "short", horizon: "4h" });
    log(`${agent.name}: ${call.side > 0 ? "long" : "short"} ${call.coin} (${call.why}) ${out.explorer ?? out.signature ?? ""}`);
  }
}

async function main() {
  const env = process.env;
  const secret = env.ARENA_HOUSE_SECRET ?? "";
  if (secret.length < 32) throw new Error("ARENA_HOUSE_SECRET must be at least 32 characters.");
  const dir = env.ARENA_HOUSE_KEYS_DIR || join(homedir(), ".arena", "house");
  const coins = (env.ARENA_HOUSE_COINS || "BTC,ETH,SOL").split(",").map((c) => c.trim()).filter(Boolean);
  const network = env.ARENA_NETWORK || "solana-devnet";
  const copier = env.ARENA_COPIER_URL && env.ARENA_COPIER_PUBKEY ? { url: env.ARENA_COPIER_URL, publicKey: env.ARENA_COPIER_PUBKEY } : undefined;
  const clients = Object.fromEntries(AGENTS.map((a) => [a.key, createCallbookClient({
    network, keyFile: join(dir, `${a.key}.json`), relayUrl: env.ARENA_RELAY_URL, rpc: env.ARENA_SOLANA_RPC, copier,
    selfPay: env.ARENA_SOLANA_SELF_PAY === "1",
  })]));
  for (const a of AGENTS) {
    const c = clients[a.key];
    console.log(`${a.name}: ${c.publicKey.toBase58()}`);
    await c.setProfile({ name: a.name, bio: `Reins house agent: ${a.strategy}`, link: "https://app.reins.one" }).catch((err) => console.log(`${a.name}: profile not set (${err.message})`));
  }
  const source = createPriceSource({ log: () => {} });
  const locked = new Map();
  const once = process.argv.includes("--once");
  for (;;) {
    await tick({ agents: AGENTS, clients, source, coins, secret, locked });
    if (once) break;
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`house agents: ${err.message}`);
    process.exit(1);
  });
}
