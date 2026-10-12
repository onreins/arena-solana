// The Solana house agents: one lock per agent per 4-hour period, the Arc
// strategies' picks, reveals first, and nothing locked when flat.
import { test } from "node:test";
import assert from "node:assert/strict";

import { tick, decideCall, periodOf, PERIOD } from "../house-agents.js";
import { AGENTS } from "../../runner/callbook-agents.js";

const T = 1_800_000_000 - (1_800_000_000 % PERIOD) + 60;
const source = { load: async () => ({ candles: {}, funding: {} }) };

function fakeAgent(key, pick) {
  return { key, name: key, strategy: `test/${key}`, decide: async (ctx) => (pick ? pick(ctx) : { coinIndex: -1, side: 0, why: "flat" }) };
}
function fakeClient() {
  const c = { locks: [], reveals: 0 };
  c.lock = async (o) => (c.locks.push(o), { signature: `s${c.locks.length}` });
  c.revealDue = async () => (c.reveals++, { revealed: [] });
  return c;
}

test("each agent locks once per period, reveals every tick, and skips flat periods", async () => {
  const agents = [fakeAgent("hot", ({ coins }) => ({ coinIndex: coins.indexOf("ETH"), side: 1, why: "ETH hot" })), fakeAgent("cold")];
  const clients = { hot: fakeClient(), cold: fakeClient() };
  const locked = new Map();
  const run = (now) => tick({ agents, clients, source, coins: ["BTC", "ETH", "SOL"], secret: "s".repeat(32), now, locked, log: () => {} });
  await run(T);
  await run(T + 60); // same period: no second lock
  assert.deepEqual(clients.hot.locks, [{ coin: "ETH", side: 1, horizon: "4h" }]);
  assert.equal(clients.cold.locks.length, 0, "flat: nothing locked");
  assert.equal(clients.hot.reveals, 2);
  await run(T + PERIOD); // next period
  assert.equal(clients.hot.locks.length, 2);
});

test("the coin flip agent calls BTC with the Arc coin flip; picks stay inside the copyable coins", async () => {
  const flip = AGENTS.find((a) => a.key === "flip");
  const call = await decideCall(flip, { coins: ["BTC", "ETH", "SOL"], view: null, now: T, secret: "x".repeat(32) });
  assert.equal(call.coin, "BTC");
  assert.ok(call.side === 1 || call.side === -1);
  assert.equal(call.p, periodOf(T));
  const again = await decideCall(flip, { coins: ["BTC", "ETH", "SOL"], view: null, now: T + 100, secret: "x".repeat(32) });
  assert.equal(again.side, call.side, "fixed within a period");
});
