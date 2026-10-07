/**
 * Callers: open-call (free) books, where a call is locked whenever its caller
 * likes, with a horizon fixed at lock time, instead of once per period. An
 * account's default book (opened by its first gasless lock) names no coins:
 * each call carries its coin as text.
 *
 * Rules (docs/CALLBOOK.md, "Open calls" and "The caller score"):
 *
 *   - every lock counts; there is no flat and no period to miss
 *   - prices are Hyperliquid hourly candle opens: entry at the first hour at
 *     or after the lock's entryAt, exit at the first hour at or after
 *     entryAt + horizon. Hourly candles are the only Hyperliquid prices with
 *     months of history, so a score can always be rebuilt; the cost is that a
 *     call can enter up to 59 minutes after its entryAt (never earlier, so it
 *     can't see its own entry)
 *   - fees: Vanta's 0.03% each way; funding: Hyperliquid's, as for books
 *   - a symbol is matched to a Hyperliquid perp without regard to case,
 *     before any price is fetched; one Hyperliquid doesn't list makes the call
 *     unscorable: flagged, never fetched, and scored as the worst outcome
 *   - a lock never revealed by entryAt + its horizon + 7 days is withheld
 *   - a withheld or unscorable call scores the worst outcome at its horizon
 *     over the candidates: the book's own coins, or, for an any-coin book, the
 *     fixed reference set REFERENCE_SET (callbook-v1: Hyperliquid's 50 most
 *     traded perps on 2026-10-07), long or short. The report names the set
 */
import { encodeAbiParameters, keccak256, toHex } from "viem";

import { VANTA } from "./scoring.js";
import { canonicalJson, hashText, SCORING_VERSION, requestForBook, latestResponse } from "./callbook-chain.js";
import { priceBook, resolveSymbol } from "./callbook-prices.js";
import { callerInfo } from "./callbook-agents.js";
import { maxOf, minOf } from "./callbook-util.js";

const HOUR = 3_600;
const DAY = 86_400;
export const GRACE = 7 * DAY;

/**
 * The reference set for any-coin books' hidden and unknown calls (callbook-v1):
 * Hyperliquid's 50 most traded perps by 24h volume on 2026-10-07. Frozen, not
 * recomputed at scoring time, so a score rebuilds the same tomorrow; changing
 * it is a new scoring version.
 */
export const REFERENCE_SET = Object.freeze([
  "BTC", "ETH", "HYPE", "ZEC", "SOL", "NEAR", "PUMP", "XRP", "ENA", "UNI", "ZRO", "LIT", "SUI", "TAO", "WLD", "ONDO", "AVAX",
  "DOGE", "PONS", "kPEPE", "XPL", "ADA", "ARB", "VVV", "MON", "AAVE", "XMR", "FARTCOIN", "LINK", "PENGU", "LTC", "BNB",
  "CASHCAT", "ETHFI", "JUP", "CRV", "GRAM", "INJ", "GRASS", "TRUMP", "CHIP", "GRIFFAIN", "SAND", "MINA", "FET", "kNEIRO",
  "ASTER", "RENDER", "BCH", "ICP",
]);
export const REFERENCE_SET_NAME = "hyperliquid-top50-2026-10-07";
/** Kept for older imports: the reference set. */
export const REFERENCE_COINS = REFERENCE_SET;

export const CALLER_RULES = Object.freeze({
  recordDays: 61, // as for books: Vanta's 61-day minimum
  recordCalls: 30, // and enough calls for a t-statistic to mean something
  edgeFullT: 3,
  maxDrawdown: VANTA.drawdownMaxPercent / 100,
  edgeWeight: 0.6,
  riskWeight: 0.4,
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const round = (x, dp = 6) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** dp) / 10 ** dp);

// ------------------------------------------------------------------ preimages

export const LOCKED_TAG = keccak256(toHex("callbook.locked"));
export const SYMBOL_TAG = keccak256(toHex("callbook.locked.symbol"));

/** Callbook.lockedHashOf: a call in a free book with a coin list. */
export function lockedHash({ callbook, chainId, bookId, callId, coinIndex, side, horizon, salt }) {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }, { type: "uint8" }, { type: "int8" }, { type: "uint32" }, { type: "bytes32" }],
    [LOCKED_TAG, String(callbook).toLowerCase(), BigInt(chainId), BigInt(bookId), BigInt(callId), coinIndex, side, horizon, salt],
  ));
}

/** Callbook.symbolCallHashOf: a call in an any-coin book, bound to the account and its nonce. */
export function symbolCallHash({ callbook, chainId, account, nonce, coin, side, horizon, salt }) {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" }, { type: "int8" }, { type: "uint32" }, { type: "bytes32" }],
    [SYMBOL_TAG, String(callbook).toLowerCase(), BigInt(chainId), String(account).toLowerCase(), BigInt(nonce), keccak256(toHex(coin)), side, horizon, salt],
  ));
}

// ------------------------------------------------------------------ statuses

/** At most this many locks per book are scored (the latest); older ones are dropped and the book is flagged. */
export const MAX_LOCKS_PER_BOOK = 5_000;

/** When an unrevealed lock becomes withheld: its own horizon (fixed when it was locked) plus GRACE. */
export const withheldAfter = (book, lock) => lock.entryAt + (lock.horizon ?? book.maxHorizon) + GRACE;

/**
 * Every lock as of `now`: revealed, unscorable (revealed, but Hyperliquid
 * doesn't list its coin), pending (not revealed yet, and still could be) or
 * withheld. Locks and reveals after `now` are ignored.
 */
export function deriveLocks(book, now, perpNames) {
  const all = [...book.locks.values()].filter((l) => l.lockedAt <= now).sort((a, b) => a.callId - b.callId);
  const kept = all.length > MAX_LOCKS_PER_BOOK ? all.slice(-MAX_LOCKS_PER_BOOK) : all;
  return kept.map((l) => {
    const horizon = l.horizon ?? l.reveal?.horizon ?? null;
    const c = { callId: l.callId, hash: l.hash, lockedAt: l.lockedAt, entryAt: l.entryAt, lockTx: l.lockTx ?? null, horizon, exitAt: horizon == null ? null : l.entryAt + horizon };
    if (l.reveal && l.reveal.at <= now) {
      const coin = resolveSymbol(l.reveal.symbol, perpNames);
      return {
        ...c, status: coin ? "revealed" : "unscorable", symbol: l.reveal.symbol, coin, side: l.reveal.side,
        revealedAt: l.reveal.at, revealTx: l.reveal.tx ?? null,
      };
    }
    return { ...c, status: now > withheldAfter(book, l) ? "withheld" : "pending", withheldAfter: withheldAfter(book, l) };
  });
}

// ------------------------------------------------------------------ outcomes

/** A position's net return: side × the funding-adjusted move, less Vanta's fee each way. */
export function netOf(side, move) {
  const gross = side * move;
  const fee = VANTA.fees.orderRate * (1 + Math.max(0, 1 + gross));
  return { gross, fee, net: gross - fee };
}

const moveOf = (prices, coin, from, to) => {
  const a = prices.index(coin, from), b = prices.index(coin, to);
  return a > 0 && b > 0 ? b / a - 1 : null;
};

/**
 * The worst a hidden or unknown call could have done over `horizon`: among the
 * candidate coins, the largest move called the wrong way.
 */
export function worstOver(prices, coins, entryAt, horizon) {
  let worst = { coin: coins[0] ?? null, side: 1, horizon, move: 0 };
  for (const coin of coins) {
    const m = moveOf(prices, coin, entryAt, entryAt + horizon);
    if (m != null && Math.abs(m) > Math.abs(worst.move)) worst = { coin, side: m > 0 ? -1 : 1, horizon, move: m };
  }
  return { ...worst, ...netOf(worst.side, worst.move) };
}

/** The coins a book's hidden call is scored against: its own coins that Hyperliquid lists, or the reference set. */
export function candidatesFor(book, perpNames) {
  if (book.anyCoin) return [...REFERENCE_SET];
  return book.coins.map((c) => resolveSymbol(c, perpNames)).filter(Boolean);
}

/** Each lock with its outcome: revealed at prices; withheld and unscorable at their worst. */
export function priceLocks(book, locks, prices, perpNames = book.coins) {
  const candidates = candidatesFor(book, perpNames);
  return locks.map((c) => {
    if (c.status === "revealed") {
      const move = moveOf(prices, c.coin, c.entryAt, c.exitAt);
      if (move == null) return { ...c, status: "unscorable", note: "no Hyperliquid price for this window", ...worstPriced(prices, candidates, c) };
      const r = netOf(c.side, move);
      return { ...c, move, ret: r.net, fee: r.fee, entry: prices.price(c.coin, c.entryAt), exit: prices.price(c.coin, c.exitAt), resolvedAt: c.exitAt };
    }
    if (c.status === "unscorable") return { ...c, note: `Hyperliquid lists no perp "${c.symbol}"`, ...worstPriced(prices, candidates, c) };
    if (c.status === "withheld") return { ...c, ...worstPriced(prices, candidates, c), resolvedAt: c.withheldAfter };
    return { ...c };
  });
}

/** A hidden or unknown call's worst: its own horizon, on the candidate coins, either side. */
function worstPriced(prices, coins, c) {
  const w = worstOver(prices, coins, c.entryAt, c.horizon);
  return { ret: w.net, fee: w.fee, move: 0, worst: { coin: w.coin, side: w.side, horizon: w.horizon }, resolvedAt: c.exitAt };
}

/**
 * Each coin's passive drift per second over the caller's record: what simply
 * holding it would have earned on average. The edge is measured against
 * beta × this drift times the call's horizon, so an always-long caller is
 * judged on *when* it was long, not on the coin going up.
 */
export function driftRates(prices, coins, from, to) {
  const rates = new Map();
  if (!(to > from)) return rates;
  for (const coin of coins) {
    const m = moveOf(prices, coin, from, to);
    if (m != null) rates.set(coin, m / (to - from));
  }
  return rates;
}

// ------------------------------------------------------------------ the caller score

/** One-sample t statistic against zero; 0 with under two values or no spread. */
function tStat(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const sd = Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
  return sd > 1e-12 ? m / (sd / Math.sqrt(xs.length)) : 0;
}

/** Worst fall of 1 + the running sum of returns from its running peak (which starts at 1). */
export function curveDrawdown(rets) {
  let v = 1, peak = 1, worst = 0;
  for (const r of rets) {
    v += r;
    peak = Math.max(peak, v);
    worst = Math.max(worst, peak > 0 ? 1 - v / peak : 1);
  }
  return worst;
}

/**
 * The caller score (docs/CALLBOOK.md, "The caller score"):
 *   score  = 100 × record × (0.6 × edge + 0.4 × risk)
 *   record = min(1, days / 61) × min(1, resolved calls / 30)
 *   edge   = clamp(t / 3, 0, 1), t of (net return − beta × expected), beta the
 *            average side and `expected` the coin's passive drift over the
 *            call's horizon (0 for withheld and unscorable calls)
 *   risk   = clamp(1 − maxDrawdown / 10%, 0, 1), drawdown of the call-by-call curve (1 unit a call)
 * outcomes: resolved calls in order [{ side, ret, expected }].
 */
export function callerScore({ days, outcomes, maxDrawdown }) {
  const R = CALLER_RULES;
  const n = outcomes.length;
  const record = clamp(days / R.recordDays, 0, 1) * Math.min(1, n / R.recordCalls);
  const beta = n ? mean(outcomes.map((o) => o.side ?? 0)) : 0;
  const t = tStat(outcomes.map((o) => o.ret - beta * (o.expected ?? o.move ?? 0)));
  const edge = clamp(t / R.edgeFullT, 0, 1);
  const risk = n ? clamp(1 - maxDrawdown / R.maxDrawdown, 0, 1) : 0;
  const value = clamp(Math.round(100 * record * (R.edgeWeight * edge + R.riskWeight * risk)), 0, 100);
  return { value, record, beta, tStat: t, edge, risk };
}

/**
 * Metrics, curve and score for a caller's priced locks, as of `asOf`.
 * `drift`: Map coin -> passive move per second (driftRates); without it the
 * edge is measured against nothing (expected 0).
 */
export function scoreCaller(book, priced, { asOf, drift = new Map() }) {
  const resolved = priced.filter((c) => c.ret != null).sort((a, b) => a.resolvedAt - b.resolvedAt || a.callId - b.callId);
  const revealed = priced.filter((c) => c.status === "revealed");
  const count = (s) => priced.filter((c) => c.status === s).length;
  const first = priced.length ? minOf(priced.map((c) => c.entryAt)) : null;
  const days = first == null ? 0 : Math.max(0, (asOf - first) / DAY);
  const rets = resolved.map((c) => c.ret);
  const maxDrawdown = curveDrawdown(rets);
  const outcomes = resolved.map((c) => {
    const real = c.status === "revealed";
    return { side: real ? c.side : 0, ret: c.ret, move: real ? c.move : 0, expected: real ? (drift.get(c.coin) ?? 0) * c.horizon : 0 };
  });
  const score = callerScore({ days, outcomes, maxDrawdown });
  const pick = (c) => (c ? { callId: c.callId, coin: c.coin ?? c.worst?.coin ?? null, side: c.side ?? c.worst?.side ?? null, ret: round(c.ret, 5), status: c.status } : null);
  const byRet = [...resolved].sort((a, b) => a.ret - b.ret);
  const resolvedCount = revealed.length + count("withheld") + count("unscorable");
  const metrics = {
    calls: priced.length,
    revealed: revealed.length,
    withheld: count("withheld"),
    unscorable: count("unscorable"),
    pending: count("pending"),
    coverage: resolvedCount ? revealed.length / resolvedCount : null,
    days,
    hitRate: revealed.length ? revealed.filter((c) => c.ret > 0).length / revealed.length : null,
    meanReturn: resolved.length ? mean(rets) : null,
    meanMove: revealed.length ? mean(revealed.map((c) => c.move)) : null,
    // Against the coin's own move over the same window, direction-neutral by the caller's average side.
    vsCoin: resolved.length ? mean(outcomes.map((o) => o.ret - score.beta * o.move)) : null,
    totalReturn: sum(rets),
    tStat: score.tStat,
    maxDrawdown,
    avgHorizonHours: revealed.length ? mean(revealed.map((c) => c.horizon)) / HOUR : null,
    best: pick(byRet[byRet.length - 1]),
    worst: pick(byRet[0]),
  };
  return { periods: priced, metrics, score, curve: curveOf(resolved, first, asOf) };
}

/** The record as daily points: 1 + every resolved call's return, counted on the day it resolved. */
function curveOf(resolved, first, asOf) {
  if (first == null) return [];
  const out = [{ t: first, v: 1 }];
  let v = 1, i = 0;
  for (let end = (Math.floor(first / DAY) + 1) * DAY; ; end += DAY) {
    const stop = Math.min(end, asOf);
    while (i < resolved.length && resolved[i].resolvedAt <= stop) v += resolved[i++].ret;
    out.push({ t: stop === end ? end - 1 : stop, v: round(v, 5) });
    if (end >= asOf) break;
  }
  return out;
}

// ------------------------------------------------------------------ report and API

export function buildCallerReport({ chainId, callbook, book, asOf, scored }) {
  const report = {
    version: SCORING_VERSION,
    kind: "caller",
    scoring: "Vanta Network fees (MIT), see app/verify/NOTICE; caller score per docs/CALLBOOK.md",
    chainId: Number(chainId),
    callbook: String(callbook).toLowerCase(),
    bookId: String(book.id),
    asOf,
    book: {
      owner: book.owner, agentId: book.agentId == null ? null : String(book.agentId), coins: book.anyCoin ? null : book.coins,
      minHorizon: book.minHorizon, maxHorizon: book.maxHorizon, metaHash: book.strategyHash,
      closedAt: book.closedAt != null && book.closedAt <= asOf ? book.closedAt : null,
    },
    prices: { source: "hyperliquid", interval: "1h", price: "candle open", costs: "hyperliquid-funding", fees: VANTA.fees, reference: REFERENCE_SET_NAME, referenceSet: book.anyCoin ? REFERENCE_SET : null },
    // [callId, status, coin, side, horizon, net return]
    calls: scored.periods.map((c) => [c.callId, c.status, c.coin ?? c.worst?.coin ?? null, c.side ?? c.worst?.side ?? null, c.horizon ?? c.worst?.horizon ?? null, c.ret == null ? null : round(c.ret)]),
    metrics: Object.fromEntries(Object.entries(scored.metrics).map(([k, v]) => [k, typeof v === "number" ? round(v) : v])),
    score: Object.fromEntries(Object.entries(scored.score).map(([k, v]) => [k, round(v)])),
  };
  const text = canonicalJson(report);
  return { report, text, hash: hashText(text) };
}

/**
 * Load prices and score one caller as of `asOf`. Coins are matched to
 * Hyperliquid's perp list first; only listed coins are ever fetched. The
 * reference set is fetched only when an any-coin book has a call to score at
 * its worst. `budget` (optional) is shared across a rebuild and caps the
 * distinct coins it fetches: { coins: Set, max }.
 */
export async function evaluateCaller({ chain, book, source, asOf, reportBase, reportUri, budget }) {
  const names = await source.perpNames();
  const locks = deriveLocks(book, asOf, names);
  const own = new Set();
  for (const c of locks) if (c.coin) own.add(c.coin);
  if (!book.anyCoin) for (const c of candidatesFor(book, names)) own.add(c);
  if (budget) {
    const fresh = [...own].filter((c) => !budget.coins.has(c));
    if (budget.coins.size + fresh.length > budget.max) throw new Error(`over the ${budget.max}-coin limit for one rebuild`);
    for (const c of fresh) budget.coins.add(c);
  }
  const needsReference = book.anyCoin && locks.some((c) => c.status === "withheld" || c.status === "unscorable");
  const coins = new Set([...own, ...(needsReference ? REFERENCE_SET : [])]);
  let prices = priceBook({ interval: "1h", candles: {}, funding: {}, fundingOk: true });
  let first = null;
  if (locks.length && coins.size) {
    first = minOf(locks.map((c) => c.entryAt));
    const data = await source.load([...coins], first - DAY, asOf + HOUR, "1h");
    prices = priceBook({ ...data, interval: "1h" }, { useFunding: true });
  }
  const drift = first == null ? new Map() : driftRates(prices, [...own], first, asOf);
  const scored = scoreCaller(book, priceLocks(book, locks, prices, names), { asOf, drift });
  scored.truncated = book.locks.size > MAX_LOCKS_PER_BOOK;
  const report = buildCallerReport({ chainId: chain.chainId, callbook: chain.address, book, asOf, scored });
  return { book, scored, report, uri: reportUri({ base: reportBase, chainId: chain.chainId, callbook: chain.address, bookId: book.id, asOf }) };
}

const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function callOut(c) {
  const o = { callId: c.callId, status: c.status, hash: c.hash, lockedAt: c.lockedAt, entryAt: c.entryAt, lockTx: c.lockTx };
  if (c.horizon != null) Object.assign(o, { horizon: c.horizon, exitAt: c.exitAt, coin: c.coin, symbol: c.symbol, side: c.side, revealedAt: c.revealedAt, revealTx: c.revealTx });
  if (c.status === "revealed") Object.assign(o, { entry: c.entry, exit: c.exit, move: round(c.move, 5) });
  if (c.ret != null) Object.assign(o, { ret: round(c.ret, 5), fee: round(c.fee, 5) });
  if (c.worst) o.worst = c.worst;
  if (c.note) o.note = c.note;
  if (c.status === "pending") o.withheldAfter = c.withheldAfter;
  return o;
}

const metricsOut = (m) => ({
  calls: m.calls, revealed: m.revealed, withheld: m.withheld, unscorable: m.unscorable, pending: m.pending,
  coverage: round(m.coverage, 3), days: round(m.days, 1), hitRate: round(m.hitRate, 3), meanReturn: round(m.meanReturn, 5),
  meanMove: round(m.meanMove, 5), vsCoin: round(m.vsCoin, 5), totalReturn: round(m.totalReturn, 5), tStat: round(m.tStat, 2),
  maxDrawdown: round(m.maxDrawdown, 4), avgHorizonHours: round(m.avgHorizonHours, 1), best: m.best, worst: m.worst,
});

/** The /api/callbook caller summary, its /api/callbook/caller/:id detail, and its feed. */
export function callerToApi({ chain, ev, validator, asOf }) {
  const { book, scored } = ev;
  const info = callerInfo({ chainId: chain.chainId, callbook: chain.address, book });
  const req = requestForBook(chain, book.id, validator);
  const last = req ? latestResponse(chain, req.requestHash) : null;
  const lastCall = scored.periods.length ? maxOf(scored.periods.map((c) => c.lockedAt)) : null;
  const summary = {
    id: String(book.id), name: info.name ?? shortAddress(book.owner), description: info.description, sample: info.sample, ours: info.ours, baseline: info.baseline,
    owner: book.owner, agentId: book.agentId, caller: book.caller, coins: book.anyCoin ? null : book.coins, anyCoin: book.anyCoin,
    minHorizon: book.minHorizon, maxHorizon: book.maxHorizon, openedAt: book.openedAt, closed: book.closedAt != null && book.closedAt <= asOf,
    metrics: metricsOut(scored.metrics),
    score: { value: scored.score.value, asOf, reportHash: ev.report.hash, parts: Object.fromEntries(Object.entries(scored.score).map(([k, v]) => [k, round(v, 4)])) },
    validation: last ? { score: last.score, tag: last.tag, responseHash: last.responseHash, txHash: last.tx, at: last.at, uri: last.uri } : null,
    curve: scored.curve,
    pending: scored.metrics.pending,
    lastCallAt: lastCall,
  };
  const detail = {
    ...summary,
    calls: scored.periods.map(callOut),
    report: { hash: ev.report.hash, uri: ev.uri, version: SCORING_VERSION, kind: "caller", reference: REFERENCE_SET_NAME },
  };
  const base = { bookId: String(book.id), callerId: String(book.id), book: summary.name, caller: true };
  const feed = [];
  for (const c of scored.periods) {
    feed.push({ ...base, t: c.lockedAt, kind: "locked", callId: c.callId, hash: c.hash, tx: c.lockTx });
    if (c.revealedAt != null) feed.push({ ...base, t: c.revealedAt, kind: "revealed", callId: c.callId, hash: c.hash, coin: c.coin ?? c.symbol, side: c.side, horizon: c.horizon, ret: round(c.ret, 5), tx: c.revealTx, ...(c.status === "unscorable" ? { note: "unscorable" } : {}) });
    if (c.status === "withheld") feed.push({ ...base, t: c.withheldAfter, kind: "missed", note: "withheld", callId: c.callId, hash: c.hash, ret: round(c.ret, 5), tx: null });
  }
  for (const r of req ? chain.validation.responses.get(req.requestHash) ?? [] : []) {
    feed.push({ ...base, t: r.at, kind: "validated", hash: r.responseHash, score: r.score, tx: r.tx });
  }
  return { summary, detail, feed };
}
