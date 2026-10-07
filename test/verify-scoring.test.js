/**
 * Callbook scoring, ported from Vanta (taoshidev/vanta-network): the metrics
 * against hand-worked numbers and Vanta's own test vectors, the fee and carry
 * maths, the challenge, eliminations, field ranking and copy detection.
 * Everything runs on made-up prices; no network, no clock.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  VANTA, VANTA_CHALLENGE, VANTA_FUNDED,
  weightingDistribution, average, variance, annDownsideVolatility,
  sharpe, sortino, omega, calmar, statisticalConfidence, pnlScore,
  dailyMaxDrawdown, drawdownPercentage, mddAugmentation, returnConsistency, allTimeCalmar,
  returnsFromCalls, drawdowns, challengeStatus, eliminationCheck,
  score, rankField, dynamicMinDays, percentiles, softmax,
  similarity, copyReport, followDelays,
} from "../app/verify/scoring.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const HOUR = 3_600;
const DAY = 86_400;
const T0 = 20_000 * DAY; // a UTC midnight in 2024
const asLog = (simple) => simple.map((r) => Math.log(1 + r));

/** A price path: `logPerDay(hourIndex)` gives each hour's log change; prices step hourly. */
function hourlyPrices(days, logPerHour) {
  const p = [100];
  for (let h = 1; h <= days * 24; h++) p.push(p[h - 1] * Math.exp(logPerHour(h)));
  return (coin, t) => p[Math.min(p.length - 1, Math.max(0, Math.ceil((t - T0) / HOUR)))];
}

/** One call a day at midnight, held 24 hours. */
const dailyCalls = (n, side = "long") =>
  Array.from({ length: n }, (_, k) => ({ t: T0 + k * DAY, coin: "BTC", side, horizonSec: DAY }));

/** Small deterministic PRNG (mulberry32). */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ metrics

describe("metrics against hand-worked numbers", () => {
  // 60 days alternating +2% and 0% (log): mean 0.01, population variance 1e-4.
  const xs = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0 : 0.02));

  test("the recency weights decay from 1 towards 0.15, oldest first", () => {
    const w = weightingDistribution(3);
    near(w[2], 1);
    near(w[1], 0.15 + 0.85 * Math.exp(-0.075));
    near(w[0], 0.15 + 0.85 * Math.exp(-0.15));
    // weighted mean of [0, 0, 1] is the newest weight's share
    near(average([0, 0, 1], { weighting: true }), 1 / (w[0] + w[1] + w[2]));
  });

  test("variance divides by n, as Vanta's does", () => {
    near(variance(xs), 1e-4, 1e-15);
    near(variance([1, 3]), 1); // a sample variance would be 2
  });

  test("Sharpe: (0.01 * 365 - 0.0389) / sqrt(1e-4 * 365) = 18.9013", () => {
    near(sharpe(xs), 3.6111 / Math.sqrt(0.0365), 1e-9);
    near(sharpe(xs), 18.90132, 1e-4);
  });

  test("Sortino: no day is below the daily risk-free rate except the zeros, whose spread is 0, so the 1% floor applies", () => {
    near(sortino(xs), 3.6111 / 0.01, 1e-9); // 361.11
  });

  test("Omega: winning days 30 * 0.02 over losing days, floored at 1%", () => {
    near(omega(xs), 0.6 / 0.01); // the zero days sum to 0, so the floor binds
    near(omega(Array.from({ length: 60 }, (_, i) => (i % 2 ? -0.01 : 0.02))), 2);
  });

  test("statistical confidence is the one-sample t statistic", () => {
    // mean 0.01, sample sd sqrt(60 * 1e-4 / 59), n 60
    near(statisticalConfidence(xs), 0.01 / (Math.sqrt(0.006 / 59) / Math.sqrt(60)), 1e-9);
    near(statisticalConfidence(xs), 7.68115, 1e-4);
  });

  test("Calmar: annual log return in percent over the drawdown percent; 0 with no drawdown or 10%+", () => {
    near(calmar(xs, 0.98), 365 * 0.5); // 365% / 2%
    assert.equal(calmar(xs, 1.0), 0);
    assert.equal(calmar(xs, 0.89), 0);
    // (1 - 0.9) * 100 is 9.999999999999998 in floating point, so exactly 10% still counts, in numpy too.
    near(calmar(xs, 0.9), 365 / (0.1 * 100), 1e-9);
  });

  test("too few days gives the no-confidence values", () => {
    const short = xs.slice(0, 59);
    assert.equal(sharpe(short), -100);
    assert.equal(sortino(short), -100);
    assert.equal(calmar(short, 0.98), -100);
    assert.equal(statisticalConfidence(short), -100);
    assert.equal(omega(short), 0);
    assert.ok(sharpe(short, { minDays: 7 }) > 0);
  });
});

describe("metrics against Vanta's own test vectors", () => {
  test("Sortino of 100 flat days is minus the risk-free percentage (test_metrics.py:200-206)", () => {
    near(sortino(Array(100).fill(0)), -3.89, 1e-12);
  });

  test("Sortino with no losing days is 0, its downside volatility infinite (test_metrics.py:208-214, 292-296)", () => {
    assert.equal(sortino(Array(100).fill(0.002)), 0);
    assert.equal(annDownsideVolatility([9 / 252, 10 / 252, 11 / 252]), Infinity);
  });

  test("Omega of only losing days is 0 (test_metrics.py:48-54)", () => {
    assert.equal(omega(Array(50).fill([-0.003, -0.001]).flat()), 0);
  });

  test("daily max drawdown of 110 -> 77 is 30%, and a one-day halving is 50% (test_metrics.py:390-424)", () => {
    near(dailyMaxDrawdown([Math.log(1.1), Math.log(0.7), Math.log(1.1), Math.log(1.1), Math.log(1.06)]), 0.3, 1e-12);
    near(dailyMaxDrawdown([0.01, 0.02, Math.log(0.5), 0.01, 0.02]), 0.5, 1e-12);
  });

  test("drawdown percent and the calmar normaliser (test_ledger_utils.py:444-499)", () => {
    near(drawdownPercentage(0.95), 5);
    assert.equal(drawdownPercentage(0), 100);
    near(mddAugmentation(0.99), 1);
    near(mddAugmentation(0.98), 0.5);
    for (const r of [0.5, 1.1, 0, -1]) assert.equal(mddAugmentation(r), 0);
  });

  test("all-time calmar: 7% over a 4% drawdown is 1.75 (test_metrics.py:167-176)", () => {
    near(allTimeCalmar(0.07, 0.96), 1.75);
    near(allTimeCalmar(0.06, 1.0), 60);
  });

  test("return consistency caps each day at 1.5% (test_metrics.py:134-165)", () => {
    near(returnConsistency(asLog([0.01, 0.01, 0.01, 0.01])), 0.25);
    near(returnConsistency(asLog([...Array(20).fill(0.004), 0.03])), 0.015 / 0.095);
    near(returnConsistency(asLog([0.01, 0.01, 0.01, 0.01, -0.02])), 0.5);
    assert.equal(returnConsistency([]), 1);
  });

  test("PnL score is the mean daily PnL (test_metrics.py:481-492)", () => {
    // realised [100, -50, 75, -15] plus the last day's open loss of -10
    assert.equal(pnlScore([100, -50, 75, -25]), 25);
    assert.ok(pnlScore([10, 20, 30], { weighting: true }) > 20);
  });

  test("variance needs two days (test_metrics.py:329-339)", () => {
    assert.equal(variance([]), 0);
    assert.equal(variance([1]), Infinity);
  });
});

// ------------------------------------------------------------------ returns, fees, carry

describe("returns from calls", () => {
  const prices = { BTC: [[T0, 100], [T0 + 8 * HOUR, 100], [T0 + 16 * HOUR, 100], [T0 + 24 * HOUR, 110]] };

  test("a 24h long pays 0.03% in, 0.03% out on the exit value, and 0.01% per 8h on market value", () => {
    const h = returnsFromCalls([{ t: T0, coin: "BTC", side: "long", horizonSec: DAY }], prices);
    const c = h.calls[0];
    near(c.grossReturn, 0.1);
    near(c.fees.entry, 0.0003);
    near(c.fees.carry, 0.0001 + 0.0001 + 0.00011); // the last interval is charged at 1.1
    near(c.fees.exit, 0.0003 * 1.1);
    near(c.netReturn, 0.09906);
    near(h.equityNow, 1.09906);
  });

  test("a short pays on its own (smaller) market value", () => {
    const c = returnsFromCalls([{ t: T0, coin: "BTC", side: "short", horizonSec: DAY }], prices).calls[0];
    near(c.fees.carry, 0.0001 + 0.0001 + 0.00009);
    near(c.netReturn, -0.1 - 0.0003 - 0.00029 - 0.00027);
  });

  test("no carry under 8 hours, and entry is the first price at or after the call", () => {
    const table = { ETH: [[T0 + 60, 50], [T0 + 7 * HOUR, 55]] };
    const c = returnsFromCalls([{ t: T0 + 1, coin: "ETH", side: "long", horizonSec: 7 * HOUR - 1 }], table).calls[0];
    assert.equal(c.entryPrice, 50);
    assert.equal(c.fees.carry, 0);
    near(c.netReturn, 0.1 - 0.0003 - 0.0003 * 1.1);
  });

  test("leverage is capped at 1x a position and 2x in total; flat calls hold nothing", () => {
    const calls = [
      { t: T0, coin: "BTC", side: "long", horizonSec: HOUR, leverage: 3 },
      { t: T0, coin: "BTC", side: "long", horizonSec: HOUR },
      { t: T0, coin: "BTC", side: "short", horizonSec: HOUR },
      { t: T0, coin: "BTC", side: "flat", horizonSec: HOUR },
    ];
    const out = returnsFromCalls(calls, () => 100).calls;
    assert.deepEqual(out.map((c) => c.leverage), [1, 1, 0, 0]);
    assert.deepEqual(out.map((c) => c.status), ["closed", "closed", "rejected", "flat"]);
  });

  test("only complete UTC days are returns; the part-days at either end are kept for drawdowns only", () => {
    const h = returnsFromCalls([{ t: T0 + 6 * HOUR, coin: "BTC", side: "flat", horizonSec: 3 * DAY }], () => 1);
    assert.equal(h.logReturns.length, 2);
    assert.deepEqual(h.days.map((d) => d.complete), [false, true, true, false]);
  });

  test("refuses calls it cannot read", () => {
    assert.throws(() => returnsFromCalls([{ t: T0, coin: "BTC", side: "up", horizonSec: 1 }], () => 1), /side/);
    assert.throws(() => returnsFromCalls([{ t: T0, coin: "BTC", side: "long", horizonSec: 1 }], {}), /no price/);
  });

  test("drawdowns: end-of-day from the high-water mark (at least 1), intraday from the open", () => {
    const d = drawdowns([1.1, 1.0, 1.05]);
    near(d.eod.current, 1 - 1.05 / 1.1);
    near(d.eod.worst, 1 - 1 / 1.1);
    near(d.max, 1 - 1 / 1.1);
    const days = [{ open: 1, low: 0.94, close: 0.99, complete: true }];
    near(drawdowns(days).intraday, 0.06);
  });
});

// ------------------------------------------------------------------ challenge and elimination

describe("the challenge", () => {
  // BTC rises 0.4% a day (log); a long held each day nets about 0.31% after fees.
  const rising = hourlyPrices(100, () => 0.004 / 24);

  test("passes once 61 days are up with more than 10% return and no breach", () => {
    const h = returnsFromCalls(dailyCalls(70), rising, { now: T0 + 70 * DAY });
    const s = challengeStatus(h);
    assert.equal(s.status, "pass", s.reasons.join("; "));
    assert.equal(s.at, T0 + 61 * DAY);
    assert.ok(s.currentReturn > 0.1);
  });

  test("is still in progress before day 61, however good the return", () => {
    const h = returnsFromCalls(dailyCalls(40), rising, { now: T0 + 40 * DAY });
    const s = challengeStatus(h);
    assert.equal(s.status, "in-progress");
    assert.match(s.reasons.join(";"), /needs 61 days/);
  });

  test("fails on a 7% dip inside a day", () => {
    const dip = hourlyPrices(100, (hr) => 0.004 / 24 + (hr === 20 * 24 + 12 ? Math.log(0.93) : hr === 20 * 24 + 13 ? -Math.log(0.93) : 0));
    const s = challengeStatus(returnsFromCalls(dailyCalls(70), dip, { now: T0 + 70 * DAY }));
    assert.equal(s.status, "fail");
    assert.match(s.reasons[0], /intraday drawdown/);
    assert.equal(s.at, T0 + 21 * DAY);
  });

  test("fails on a 6% slide across four closes, each day under the intraday limit", () => {
    const slide = hourlyPrices(100, (hr) => (hr > 10 * 24 && hr <= 14 * 24 ? -0.015 / 24 : 0.004 / 24));
    const h = returnsFromCalls(dailyCalls(70), slide, { now: T0 + 70 * DAY });
    const s = challengeStatus(h);
    assert.equal(s.status, "fail");
    assert.match(s.reasons[0], /end-of-day drawdown/);
    assert.ok(s.drawdowns.intraday < 0.05);
  });

  test("fails when 90 days pass without the return", () => {
    const h = returnsFromCalls(dailyCalls(92, "flat"), () => 100, { now: T0 + 92 * DAY });
    const s = challengeStatus(h);
    assert.equal(s.status, "fail");
    assert.match(s.reasons[0], /within 90 days/);
    assert.equal(s.at, T0 + 90 * DAY);
  });

  test("a rank outside the top 25 holds back an otherwise passing trader", () => {
    const h = returnsFromCalls(dailyCalls(70), rising, { now: T0 + 70 * DAY });
    assert.equal(challengeStatus(h, { rank: 26 }).status, "in-progress");
    assert.equal(challengeStatus(h, { ...VANTA_CHALLENGE, returnThreshold: 0.5 }).status, "in-progress");
  });
});

describe("elimination", () => {
  const slide = hourlyPrices(100, (hr) => (hr > 10 * 24 && hr <= 14 * 24 ? -0.015 / 24 : 0.004 / 24));
  const h = returnsFromCalls(dailyCalls(30), slide, { now: T0 + 30 * DAY });

  test("a 6% end-of-day drawdown survives the funded 8% limit but not the challenge's 5%", () => {
    assert.equal(eliminationCheck(h, VANTA_FUNDED).eliminated, false);
    const out = eliminationCheck(h, VANTA_CHALLENGE);
    assert.equal(out.eliminated, true);
    assert.match(out.reason, /end-of-day/);
  });

  test("60 days without a call is allowed; a moment more is not", () => {
    const one = [{ t: T0, coin: "BTC", side: "flat", horizonSec: HOUR }];
    assert.equal(eliminationCheck(returnsFromCalls(one, () => 1, { now: T0 + 60 * DAY })).eliminated, false);
    const out = eliminationCheck(returnsFromCalls(one, () => 1, { now: T0 + 60 * DAY + 1 }));
    assert.equal(out.eliminated, true);
    assert.match(out.reason, /inactive/);
    assert.equal(out.at, T0 + 60 * DAY);
  });
});

// ------------------------------------------------------------------ score and rank

describe("score and rank", () => {
  const good = returnsFromCalls(dailyCalls(30), hourlyPrices(40, () => 0.004 / 24), { now: T0 + 30 * DAY });
  const meh = returnsFromCalls(dailyCalls(30), hourlyPrices(40, () => 0.001 / 24), { now: T0 + 30 * DAY });
  const crash = returnsFromCalls(dailyCalls(30), hourlyPrices(40, (hr) => (hr === 100 ? Math.log(0.85) : 0.004 / 24)), { now: T0 + 30 * DAY });

  test("score lists every metric, Vanta's weights (PnL only) and the drawdown penalty", () => {
    const s = score(good);
    assert.deepEqual(Object.keys(s.metrics).sort(), ["calmar", "omega", "pnl", "sharpe", "sortino", "statisticalConfidence"]);
    assert.equal(s.weights.pnl, 1);
    assert.equal(s.penalty, 1);
    assert.equal(s.minDays, 7);
    assert.equal(score(crash).penalty, 0); // a 15% drop is past the 10% line
  });

  test("percentiles are strict and softmax leaves zeros at zero", () => {
    assert.deepEqual(percentiles([3, 1, 2, 2]), [0.75, 0, 0.25, 0.25]);
    const s = softmax([0.5, 0]);
    near(s[0], 1 / (1 + 1e-6));
    assert.equal(s[1], 0);
  });

  test("the field's minimum days is 7 below 20 traders", () => {
    assert.equal(dynamicMinDays([30, 30, 5]), 7);
    assert.equal(dynamicMinDays(Array(25).fill(90)), 60);
    assert.equal(dynamicMinDays([]), 60);
  });

  test("rankField: better PnL takes the weight, a 10%+ drawdown takes nothing, one trader gets 1", () => {
    const ranked = rankField([{ id: "meh", history: meh }, { id: "good", history: good }, { id: "crash", history: crash }]);
    assert.deepEqual(ranked.map((r) => r.id), ["good", "meh", "crash"]);
    assert.ok(ranked[0].weight > 0.99);
    assert.equal(ranked[2].weight, 0);
    near(ranked.reduce((a, r) => a + r.weight, 0), 1, 1e-6);
    assert.equal(rankField([{ id: "solo", history: crash }])[0].weight, 1);
  });
});

// ------------------------------------------------------------------ copy detection

describe("copy detection", () => {
  const now = T0 + 10 * DAY;
  function randomCalls(seed, n = 70) {
    const r = rng(seed);
    return Array.from({ length: n }, (_, k) => ({
      t: T0 + HOUR + k * 3 * HOUR + Math.floor(r() * 3600),
      coin: "BTC",
      side: r() < 0.5 ? "long" : "short",
      horizonSec: HOUR + Math.floor(r() * 5 * HOUR),
    }));
  }
  const leader = randomCalls(1);
  const shift = (calls, s) => calls.map((c) => ({ ...c, t: c.t + s }));

  test("a copy placed 30 seconds later is flagged", () => {
    const out = similarity(shift(leader, 30), leader, { now });
    assert.equal(out.flagged, true);
    assert.equal(out.byCoin[0].follow, 1);
    assert.ok(out.byCoin[0].single > 0.95);
  });

  test("a copy 20 minutes late is flagged, with its delay found", () => {
    const out = similarity(shift(leader, 20 * 60), leader, { now });
    assert.equal(out.flagged, true);
    assert.equal(out.byCoin[0].lagSteps, 10);
    near(out.byCoin[0].lagSec, 1200);
    assert.ok(out.byCoin[0].single > 0.99);
  });

  test("an independent random trader is not flagged", () => {
    const out = similarity(randomCalls(2), leader, { now });
    assert.equal(out.flagged, false);
    assert.ok(out.byCoin[0].single < 0.5);
  });

  test("an identical list at the same instants slips past Vanta's rule; `unshifted` shows it", () => {
    // Under 10s is not a follow, so each call is matched to the leader's next
    // one (hours later) and the trace is shifted by hours before comparing.
    const out = similarity(leader, leader, { now });
    assert.equal(out.flagged, false);
    assert.ok(out.byCoin[0].follow > 0.75);
    assert.ok(out.byCoin[0].lagSec > HOUR);
    assert.ok(out.byCoin[0].single < 0.5);
    near(out.byCoin[0].unshifted, 1);
  });

  test("Vanta's follow scan stops at the first unfollowed call; skipUnfollowed carries on", () => {
    // The leader's first call has nothing after it from the copier within 12 hours.
    const lone = { t: T0 + 10, coin: "BTC", side: "long", horizonSec: HOUR };
    const withLone = [lone, ...leader.filter((c) => c.t > lone.t + DAY)];
    const copier = shift(withLone.slice(1), 600);
    assert.equal(similarity(copier, withLone, { now }).byCoin[0].follow, 0);
    const fixed = similarity(copier, withLone, { now, skipUnfollowed: true });
    assert.equal(fixed.flagged, true);
    near(fixed.byCoin[0].follow, (withLone.length - 1) / withLone.length);
    assert.deepEqual(followDelays([], [{ start: 0 }]), []);
  });

  test("copyReport flags the copier against its leader and nobody else", () => {
    const field = [
      { id: "leader", calls: leader },
      { id: "copier", calls: shift(leader, 600) },
      { id: "indie", calls: randomCalls(3) },
    ];
    const flagged = copyReport(field, { now }).filter((r) => r.flagged);
    assert.deepEqual(flagged.map((r) => [r.follower, r.leader]), [["copier", "leader"]]);
  });
});

test("the constants match Vanta's", () => {
  assert.equal(VANTA.fees.orderRate, 0.0003);
  assert.equal(VANTA.fees.carryRate, 0.0001);
  assert.equal(VANTA.fees.carryIntervalSec, 8 * HOUR);
  assert.equal(VANTA_CHALLENGE.minDays, 61);
  assert.equal(VANTA_CHALLENGE.maxDays, 90);
  assert.equal(VANTA_FUNDED.eodDrawdown, 0.08);
  assert.throws(() => { VANTA.fees.orderRate = 1; });
});
