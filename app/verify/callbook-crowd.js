/**
 * The crowd: Arena's consensus, and each caller's edge over it (the rules
 * are here; docs/CALLBOOK.md can point to this file). Numerai's meta model and meta-model contribution,
 * without the money: nobody stakes, nothing is paid.
 *
 *   - Only revealed calls count, and only once revealed (revealedAt <= asOf).
 *     A locked call is hidden until its reveal and never feeds the crowd.
 *   - Calls are grouped by coin and UTC day of entry. In a group each caller
 *     has one view, the average side of their calls (+1 long, -1 short), so a
 *     caller who locks often weighs the same as one who locks once.
 *   - The consensus on a coin and day is the sign of the callers' average view;
 *     it has a record when at least MIN_CROWD callers called: the consensus
 *     side applied to every call's own window, after costs, averaged per
 *     caller.
 *   - A call's edge over the crowd: its net return minus what the crowd's side
 *     (everyone else's views on that coin and day, leaving the caller out)
 *     earned over the same window, after the same costs; 0 for the crowd's
 *     side when everyone else was split. A call with nobody else on its coin
 *     and day has no crowd: it isn't counted, rather than counted as 0.
 *     Going with the crowd scores about 0; being right where it was wrong
 *     scores high; being wrong where it was right scores low.
 *
 * Everything comes from revealed calls (chain data) and their priced moves
 * (public prices), so anyone can rebuild it. Inputs are sorted first, so the
 * same calls give the same crowd in any order.
 *
 * Limits: the groups are calendar days, so a caller who locks late in a day
 * after another's short call was revealed can see part of that day's crowd;
 * windows inside a day differ, which the per-call windows handle for returns
 * but not for timing. Few callers mean a noisy crowd: read `withCrowd`.
 */
import { netOf } from "./callbook-callers.js";

const DAY = 86_400;

export const CROWD_RULES = Object.freeze({
  bucketSec: DAY, // calls are grouped by coin and UTC day of entry
  recentDays: 7, // the "lean now" window
  minCrowd: 2, // callers needed on a coin and day for the consensus to have a record
  minOthers: 1, // other callers needed on a coin and day for a call's edge to count
});

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
const signOf = (x) => (x > 1e-12 ? 1 : x < -1e-12 ? -1 : 0);

/** One-sample t statistic against zero; 0 with under two values or no spread. */
function tStat(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const sd = Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
  return sd > 1e-12 ? m / (sd / Math.sqrt(xs.length)) : 0;
}

/** A call the crowd can use: revealed by asOf, a known coin, long or short, priced. */
function usable(c, asOf) {
  return c.status === "revealed" && c.coin && (c.side === 1 || c.side === -1)
    && Number.isFinite(c.move) && Number.isFinite(c.ret) && Number.isFinite(c.entryAt)
    && c.revealedAt != null && c.revealedAt <= asOf;
}

/** caller id -> average side of their calls in a list. */
function viewsOf(calls) {
  const by = new Map();
  for (const c of calls) by.set(c.callerId, [...(by.get(c.callerId) ?? []), c.side]);
  return new Map([...by].map(([id, sides]) => [id, mean(sides)]));
}

/** The consensus side applied to each call's own window, after costs, averaged per caller. */
function consensusReturn(calls, side) {
  const by = new Map();
  for (const c of calls) by.set(c.callerId, [...(by.get(c.callerId) ?? []), netOf(side, c.move).net]);
  return mean([...by.values()].map(mean));
}

/**
 * callers: [{ id, periods }] with periods as scoreCaller returns them.
 * Returns { consensus: { rules, coins }, byCaller: Map(id -> metrics) }.
 */
export function crowdOf(callers, { asOf, rules = CROWD_RULES }) {
  const calls = [...callers]
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
    .flatMap(({ id, periods }) => periods.filter((c) => usable(c, asOf)).map((c) => ({ ...c, callerId: String(id) })))
    .sort((a, b) => a.entryAt - b.entryAt || (a.callerId < b.callerId ? -1 : a.callerId > b.callerId ? 1 : 0) || a.callId - b.callId);

  // Coin and day -> its calls.
  const groups = new Map();
  for (const c of calls) {
    const key = `${c.coin}|${Math.floor(c.entryAt / rules.bucketSec)}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  // Each call's edge over everyone else on its coin and day.
  const edges = new Map(callers.map(({ id }) => [String(id), []]));
  const agree = new Map(callers.map(({ id }) => [String(id), 0]));
  for (const group of groups.values()) {
    const views = viewsOf(group);
    for (const c of group) {
      const others = [...views].filter(([id]) => id !== c.callerId).map(([, v]) => v);
      if (others.length < rules.minOthers) continue;
      const side = signOf(mean(others));
      const crowdRet = side ? netOf(side, c.move).net : 0;
      edges.get(c.callerId).push(c.ret - crowdRet);
      if (side && c.side === side) agree.set(c.callerId, agree.get(c.callerId) + 1);
    }
  }

  const byCaller = new Map(callers.map(({ id }) => {
    const key = String(id);
    const own = calls.filter((c) => c.callerId === key).length;
    const e = edges.get(key);
    return [key, {
      revealed: own,
      withCrowd: e.length,
      coverage: own ? e.length / own : null,
      agreement: e.length ? agree.get(key) / e.length : null,
      edge: mean(e),
      edgeT: tStat(e),
    }];
  }));

  // Per coin: the lean over the recent window, and the consensus's own record.
  const since = asOf - rules.recentDays * DAY;
  const coins = [...new Set(calls.map((c) => c.coin))].map((coin) => {
    const onCoin = calls.filter((c) => c.coin === coin);
    const recentCalls = onCoin.filter((c) => c.entryAt >= since);
    const recentViews = [...viewsOf(recentCalls).values()];
    const lean = signOf(mean(recentViews) ?? 0);
    const days = [...groups.entries()].filter(([k]) => k.startsWith(`${coin}|`)).map(([, g]) => g);
    const scored = days
      .map((g) => ({ g, side: signOf(mean([...viewsOf(g).values()])) }))
      .filter(({ g, side }) => side !== 0 && viewsOf(g).size >= rules.minCrowd)
      .map(({ g, side }) => consensusReturn(g, side));
    return {
      coin,
      callers: new Set(onCoin.map((c) => c.callerId)).size,
      recent: {
        callers: recentViews.length,
        calls: recentCalls.length,
        longShare: recentViews.length ? recentViews.filter((v) => v > 0).length / recentViews.length : null,
        lean: recentViews.length ? (lean > 0 ? "long" : lean < 0 ? "short" : "split") : null,
      },
      record: {
        days: scored.length,
        hitRate: scored.length ? scored.filter((r) => r > 0).length / scored.length : null,
        meanReturn: mean(scored),
      },
    };
  }).sort((a, b) => b.recent.callers - a.recent.callers || b.callers - a.callers || (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0));

  return { consensus: { rules: { ...rules }, coins }, byCaller };
}

const round = (x, dp) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);

/** A caller's crowd metrics as the API shows them. */
export const crowdMetricsOut = (m) => m && ({
  revealed: m.revealed, withCrowd: m.withCrowd, coverage: round(m.coverage, 3), agreement: round(m.agreement, 3),
  edge: round(m.edge, 5), edgeT: round(m.edgeT, 2),
});

/** The consensus as the API shows it. */
export const consensusOut = (c) => ({
  rules: c.rules,
  coins: c.coins.map((x) => ({
    coin: x.coin, callers: x.callers,
    recent: { ...x.recent, longShare: round(x.recent.longShare, 3) },
    record: { days: x.record.days, hitRate: round(x.record.hitRate, 3), meanReturn: round(x.record.meanReturn, 5) },
  })),
});
