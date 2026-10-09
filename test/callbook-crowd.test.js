/**
 * The crowd: Arena's consensus (Numerai's meta model, without the money) and
 * each caller's edge over it (Numerai's MMC idea), built only from revealed
 * calls. Priced calls are synthetic; nothing here touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { crowdOf, CROWD_RULES } from "../app/verify/callbook-crowd.js";
import { netOf } from "../app/verify/callbook-callers.js";

const HOUR = 3600, DAY = 86400;
const T0 = 1_790_000_000 - (1_790_000_000 % DAY);
const ASOF = T0 + 30 * DAY;

let nextId = 1;
/** A revealed, priced open call, as scoreCaller's periods hold it. */
function call({ coin = "BTC", side, move, day = 0, hour = 1, horizon = 4 * HOUR, revealedAt }) {
  const entryAt = T0 + day * DAY + hour * HOUR;
  const { net, fee } = netOf(side, move);
  return { callId: nextId++, status: "revealed", coin, side, entryAt, exitAt: entryAt + horizon, horizon, move, ret: net, fee, revealedAt: revealedAt ?? entryAt + horizon + 60 };
}
const caller = (id, periods) => ({ id: String(id), periods });

test("a caller who copies the crowd has no edge over it", () => {
  const crowd = [1, 2, 3].map((id) => caller(id, [call({ side: 1, move: 0.02 })]));
  const copier = caller(9, [call({ side: 1, move: 0.02 })]);
  const { byCaller } = crowdOf([...crowd, copier], { asOf: ASOF });
  const m = byCaller.get("9");
  assert.equal(m.withCrowd, 1);
  assert.equal(m.agreement, 1);
  assert.ok(Math.abs(m.edge) < 1e-12, `edge ${m.edge}`);
});

test("a caller right where the crowd was wrong has a large edge", () => {
  const crowd = [1, 2, 3].map((id) => caller(id, [call({ side: 1, move: -0.02 })]));
  const niche = caller(9, [call({ side: -1, move: -0.02 })]);
  const { byCaller } = crowdOf([...crowd, niche], { asOf: ASOF });
  const m = byCaller.get("9");
  const expected = netOf(-1, -0.02).net - netOf(1, -0.02).net;
  assert.ok(Math.abs(m.edge - expected) < 1e-12);
  assert.ok(m.edge > 0.035);
  assert.equal(m.agreement, 0);
  // A member who went with the crowd earned what the crowd earned: no edge either way.
  assert.ok(Math.abs(byCaller.get("1").edge) < 1e-12);
});

test("a caller alone on a coin and day has no crowd to beat: n/a, not zero", () => {
  const lone = caller(1, [call({ coin: "SOL", side: 1, move: 0.01 })]);
  const other = caller(2, [call({ coin: "ETH", side: 1, move: 0.01 })]);
  const { byCaller } = crowdOf([lone, other], { asOf: ASOF });
  const m = byCaller.get("1");
  assert.equal(m.withCrowd, 0);
  assert.equal(m.edge, null);
  assert.equal(m.coverage, 0);
});

test("only revealed calls count: pending, withheld, unscorable and not-yet-revealed ones never do", () => {
  const visible = [1, 2].map((id) => caller(id, [call({ side: 1, move: 0.01 })]));
  const hidden = caller(3, [
    { callId: 900, status: "pending", entryAt: T0 + HOUR, horizon: 4 * HOUR, hash: "0xabc" },
    { callId: 901, status: "withheld", entryAt: T0 + HOUR, horizon: 4 * HOUR, ret: -0.05, worst: { coin: "BTC", side: -1 } },
    { callId: 902, status: "unscorable", symbol: "NOPE", side: -1, entryAt: T0 + HOUR, ret: -0.05 },
    call({ side: -1, move: 0.01, revealedAt: ASOF + HOUR }),
  ]);
  const { consensus, byCaller } = crowdOf([...visible, hidden], { asOf: ASOF });
  const btc = consensus.coins.find((c) => c.coin === "BTC");
  assert.equal(btc.record.days, 1);
  assert.equal(btc.callers, 2);
  assert.equal(byCaller.get("3").withCrowd, 0);
  assert.equal(byCaller.get("3").revealed, 0);
});

test("the consensus weighs callers equally, not calls", () => {
  const busy = caller(1, Array.from({ length: 10 }, () => call({ side: 1, move: 0.01, day: 28 })));
  const quiet = [2, 3].map((id) => caller(id, [call({ side: -1, move: 0.01, day: 28 })]));
  const { consensus } = crowdOf([busy, ...quiet], { asOf: ASOF });
  const btc = consensus.coins.find((c) => c.coin === "BTC");
  assert.equal(btc.recent.longShare, 1 / 3);
  assert.equal(btc.recent.lean, "short");
  assert.equal(btc.recent.calls, 12);
  assert.equal(btc.recent.callers, 3);
});

test("the consensus keeps its own record, after costs", () => {
  const right = [1, 2].map((id) => caller(id, [call({ side: 1, move: 0.03, day: 0 }), call({ side: 1, move: -0.01, day: 1 })]));
  const { consensus } = crowdOf(right, { asOf: ASOF });
  const btc = consensus.coins.find((c) => c.coin === "BTC");
  assert.equal(btc.record.days, 2);
  assert.equal(btc.record.hitRate, 0.5);
  const expected = (netOf(1, 0.03).net + netOf(1, -0.01).net) / 2;
  assert.ok(Math.abs(btc.record.meanReturn - expected) < 1e-9);
});

test("recent lean only looks at the last days; the record keeps everything", () => {
  const old = [1, 2].map((id) => caller(id, [call({ side: -1, move: 0.01, day: 0 }), call({ side: 1, move: 0.01, day: 29 })]));
  const { consensus } = crowdOf(old, { asOf: ASOF });
  const btc = consensus.coins.find((c) => c.coin === "BTC");
  assert.equal(btc.recent.lean, "long");
  assert.equal(btc.recent.calls, 2);
  assert.equal(btc.record.days, 2);
  assert.equal(consensus.rules.recentDays, CROWD_RULES.recentDays);
});

test("the same calls in any order give the same crowd", () => {
  const a = [1, 2, 3].map((id) => caller(id, [call({ side: id === 2 ? -1 : 1, move: 0.015 }), call({ coin: "ETH", side: -1, move: -0.02, day: 2 })]));
  const first = crowdOf(a, { asOf: ASOF });
  const second = crowdOf([...a].reverse().map((c) => ({ ...c, periods: [...c.periods].reverse() })), { asOf: ASOF });
  assert.deepEqual(first.consensus, second.consensus);
  assert.deepEqual(Object.fromEntries(first.byCaller), Object.fromEntries(second.byCaller));
});
