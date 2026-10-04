/**
 * Does agreement among good Hyperliquid traders predict the next move?
 *
 *   node research/smart-money-study.mjs            fetch (cached) and analyse
 *   node research/smart-money-study.mjs --fresh    refetch everything
 *
 * No lookahead:
 * - Traders are picked by the PnL they made BEFORE the test window
 *   (all-time PnL minus last-30-day PnL, both from the public leaderboard).
 *   Nothing they did inside the window decides whether they're in.
 * - A trader's position at time t comes only from fills at or before t.
 *   Every fill carries the position before it, so positions are exact.
 * - The outcome is the coin's return from t to t+4h, strictly after t.
 * - Returns are also measured against the average coin at the same moment,
 *   so a market that simply rose doesn't count as skill.
 * - A control group of random active traders is run through the same test:
 *   if they "predict" as well, the signal is crowding, not skill.
 *
 * Known limits: the leaderboard is today's, so accounts that vanished before
 * today are missing (some survivorship); Hyperliquid serves at most each
 * trader's 10,000 most recent fills, so very busy traders only count from
 * their earliest fetched fill onward.
 */
import fs from "node:fs";
import path from "node:path";

const API = "https://api.hyperliquid.xyz/info";
const DIR = path.resolve("research/data/smart-money");
const HOUR = 3600e3, STEP = 4 * HOUR, DAYS = 30;
const SMART = 150, CONTROL = 150, MIN_TRADERS = 3, STRONG = 0.5;
const FEE_ROUND_TRIP = 0.0007; // taker in and out, about 0.035% each way
const fresh = process.argv.includes("--fresh");
// --cached: analyse only the traders already fetched (a partial run's judgement)
const cachedOnly = process.argv.includes("--cached");
// --directional: leave out market makers and bots (10,000+ fills a month: their positions are inventory, not views)
const directional = process.argv.includes("--directional");
// --focused: also leave out basket books (15+ coins held at once) and keep the 40 most-traded coins
const focused = process.argv.includes("--focused");
// --first-batch: only the traders in research/data/smart-money-first-batch.txt (the first analysis)
// --holdout: only the smart traders NOT in that list (a clean second sample)
const listed = () => new Set(fs.readFileSync("research/data/smart-money-first-batch.txt", "utf8").split(/\s+/).filter(Boolean));
const firstBatch = process.argv.includes("--first-batch") ? listed() : null;
const holdout = process.argv.includes("--holdout") ? listed() : null;

fs.mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(body, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    if (r.status === 429) { await sleep(4000 * (i + 1)); continue; }
    throw new Error(`${body.type} HTTP ${r.status}`);
  }
  throw new Error(`${body.type}: rate limited`);
}
function cached(name, make) {
  const f = path.join(DIR, name);
  if (!fresh && fs.existsSync(f)) return Promise.resolve(JSON.parse(fs.readFileSync(f, "utf8")));
  return make().then((v) => { fs.writeFileSync(f, JSON.stringify(v)); return v; });
}

// ------------------------------------------------------------------ traders
const END = Math.floor(Date.now() / STEP) * STEP;
const START = END - DAYS * 24 * HOUR;
const board = await cached("leaderboard.json", async () => {
  const r = await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");
  return (await r.json()).leaderboardRows.map((x) => ({ a: x.ethAddress, w: Object.fromEntries(x.windowPerformances) }));
});
const pre = (t, k) => +t.w.allTime[k] - +t.w.month[k]; // before the test window
const active = board.filter((t) => pre(t, "vlm") > 5e6 && +t.w.month.vlm > 1e6);
// --ranks=FROM-TO: a different tier of the same ranking (e.g. 150-400 as a holdout)
const ranksArg = (process.argv.find((x) => x.startsWith("--ranks=")) || "").slice(8).split("-").map(Number);
const [R0, R1] = ranksArg.length === 2 && ranksArg.every(Number.isFinite) ? ranksArg : [0, SMART];
const smart = active.filter((t) => pre(t, "pnl") > 0).sort((a, b) => pre(b, "pnl") - pre(a, "pnl")).slice(R0, R1);
const seeded = (n) => { let x = n; return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); };
const rnd = seeded(7);
const control = (process.argv.includes("--no-control") ? [] : active).filter((t) => !smart.includes(t)).map((t) => [rnd(), t]).sort((a, b) => a[0] - b[0]).slice(0, CONTROL).map((p) => p[1]);
console.log(`leaderboard ${board.length}, active ${active.length}, smart ${smart.length}, control ${control.length}`);

// ------------------------------------------------------------------- fills
async function fillsOf(addr) {
  return cached(`fills-${addr}.json`, async () => {
    const fills = [];
    let from = START, raw = 0, earliest = END;
    for (let page = 0; page < 6; page++) {
      const got = await post({ type: "userFillsByTime", user: addr, startTime: from, endTime: END });
      await sleep(700);
      if (!got.length) break;
      raw += got.length;
      earliest = Math.min(earliest, got[0].time);
      for (const f of got) if (!f.coin.startsWith("@") && !f.coin.includes("/")) fills.push({ c: f.coin, t: f.time, s: +f.startPosition, d: f.side === "B" ? +f.sz : -f.sz });
      if (got.length < 2000) break;
      from = got[got.length - 1].time + 1;
    }
    // What they hold now: a position held all window long, with no fills, still counts.
    const now = await post({ type: "clearinghouseState", user: addr });
    await sleep(300);
    const held = Object.fromEntries((now.assetPositions || []).map((p) => [p.position.coin, +p.position.szi]));
    return { fills: fills.sort((a, b) => a.t - b.t), raw, earliest, held };
  });
}

/**
 * Per coin, a timeline of [time, position after each fill], known from `known`
 * onward. Hyperliquid serves at most 10,000 recent fills: under that, nothing
 * was cut off and the position before a coin's first fill held from the start
 * of the window; at the cap, positions are known only from the earliest fill
 * fetched (from then on every fill is there).
 */
function timeline(data) {
  const truncated = data.raw >= 10000;
  const known = truncated ? data.earliest : START;
  const by = {};
  for (const f of data.fills) (by[f.c] ??= []).push(f);
  const tl = {};
  for (const [c, fs] of Object.entries(by)) tl[c] = { known, steps: [[known, fs[0].s], ...fs.map((f) => [f.t, f.s + f.d])] };
  for (const [c, size] of Object.entries(data.held)) if (!tl[c] && size) tl[c] = { known, steps: [[known, size]] };
  return { tl, truncated };
}
function positionAt(tc, t) {
  if (!tc || t < tc.known) return null;
  let p = 0;
  for (const [ft, pos] of tc.steps) { if (ft <= t) p = pos; else break; }
  return p;
}

async function cohort(name, list) {
  const out = [];
  let i = 0;
  for (const t of list) {
    i++;
    if (cachedOnly && !fs.existsSync(path.join(DIR, `fills-${t.a}.json`))) continue;
    if (firstBatch && !firstBatch.has(t.a)) continue;
    if (holdout && name === "smart" && holdout.has(t.a)) continue;
    try {
      const data = await fillsOf(t.a), tl = timeline(data);
      const basket = Object.values(data.held).filter(Boolean).length >= 15;
      if (!(directional && tl.truncated) && !(focused && (tl.truncated || basket))) out.push(tl);
    } catch (e) { console.log(`  ${name} ${t.a.slice(0, 8)} skipped: ${e.message}`); }
    if (i % 25 === 0) console.log(`  ${name}: ${i}/${list.length}`);
  }
  return out.filter((x) => Object.keys(x.tl).length);
}
console.log("fetching fills (cached after the first run)…");
const smartTL = await cohort("smart", smart);
const controlTL = await cohort("control", control);

// ------------------------------------------------------------------ prices
let coinsSeen = new Set();
for (const x of [...smartTL, ...controlTL]) for (const c of Object.keys(x.tl)) coinsSeen.add(c);
if (focused) {
  const [meta, ctx] = await post({ type: "metaAndAssetCtxs" });
  const top = meta.universe.map((u, i) => [u.name, +ctx[i].dayNtlVlm]).sort((a, b) => b[1] - a[1]).slice(0, 40).map((x) => x[0]);
  coinsSeen = new Set(top.filter((c) => coinsSeen.has(c)));
}
const prices = {};
console.log(`fetching hourly candles for ${coinsSeen.size} coins…`);
for (const c of coinsSeen) {
  try {
    const k = await cached(`candles-${c}.json`, async () => {
      const got = await post({ type: "candleSnapshot", req: { coin: c, interval: "1h", startTime: START - HOUR, endTime: END + STEP + HOUR } });
      await sleep(300);
      return got.map((x) => [x.t, +x.o]);
    });
    prices[c] = new Map(k); // open of the hour starting at t = the price at t
  } catch (e) { /* a delisted or renamed coin: no prices, no samples */ }
}

// --------------------------------------------------------------- samples
function samples(tls) {
  const rows = [];
  for (let t = START; t + STEP <= END; t += STEP) {
    const at = [];
    for (const c of coinsSeen) {
      const p0 = prices[c]?.get(t), p1 = prices[c]?.get(t + STEP);
      if (!p0 || !p1) continue;
      let L = 0, S = 0;
      for (const x of tls) {
        const p = positionAt(x.tl[c], t);
        if (p > 0) L++; else if (p < 0) S++;
      }
      if (L + S >= MIN_TRADERS) at.push({ t, c, n: L + S, s: (L - S) / (L + S), r: p1 / p0 - 1 });
    }
    // relative to the other coins in the sample at the same moment
    const all = [];
    for (const c of coinsSeen) { const p0 = prices[c]?.get(t), p1 = prices[c]?.get(t + STEP); if (p0 && p1) all.push(p1 / p0 - 1); }
    const mkt = all.reduce((a, b) => a + b, 0) / (all.length || 1);
    for (const x of at) rows.push({ ...x, rx: x.r - mkt });
  }
  return rows;
}

// ---------------------------------------------------------------- statistics
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const tstat = (a) => (a.length > 1 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : 0);
const bp = (x) => (x * 1e4).toFixed(1).padStart(7) + " bp";

/** Follow strong agreement: long when s ≥ +0.5, short when s ≤ -0.5, for 4h. Averaged per moment. */
function follow(rows, key) {
  const byT = new Map();
  for (const x of rows) if (Math.abs(x.s) >= STRONG) (byT.get(x.t) ?? byT.set(x.t, []).get(x.t)).push(Math.sign(x.s) * x[key]);
  return [...byT.values()].map(mean);
}
function permutationP(rows, key, observed, runs = 2000) {
  const byT = new Map();
  for (const x of rows) (byT.get(x.t) ?? byT.set(x.t, []).get(x.t)).push(x);
  const groups = [...byT.values()];
  const r = seeded(11);
  let beat = 0;
  for (let i = 0; i < runs; i++) {
    const per = [];
    for (const g of groups) {
      const ss = g.map((x) => x.s);
      for (let j = ss.length - 1; j > 0; j--) { const k = Math.floor(r() * (j + 1)); [ss[j], ss[k]] = [ss[k], ss[j]]; }
      const v = g.map((x, j) => (Math.abs(ss[j]) >= STRONG ? Math.sign(ss[j]) * x[key] : null)).filter((v) => v !== null);
      if (v.length) per.push(mean(v));
    }
    if (mean(per) >= observed) beat++;
  }
  return (beat + 1) / (runs + 1);
}
function report(name, rows) {
  console.log(`\n=== ${name}: ${rows.length} coin-moments, ${new Set(rows.map((x) => x.t)).size} four-hour moments ===`);
  console.log("agreement bucket      samples   next 4h (raw)   vs market   hit rate");
  const buckets = [[-1, -0.6], [-0.6, -0.2], [-0.2, 0.2], [0.2, 0.6], [0.6, 1.01]];
  for (const [lo, hi] of buckets) {
    const b = rows.filter((x) => x.s >= lo && x.s < hi);
    if (!b.length) continue;
    const dir = lo >= 0.2 ? 1 : hi <= -0.2 ? -1 : 0;
    const hit = dir ? mean(b.map((x) => (Math.sign(x.rx) === dir ? 1 : 0))) : null;
    const label = `${lo <= -1 ? "strong short" : lo < -0.2 ? "lean short" : lo < 0.2 ? "split" : hi <= 0.6 ? "lean long" : "strong long"} (${lo},${Math.min(hi, 1)})`;
    console.log(`${label.padEnd(22)}${String(b.length).padStart(6)}   ${bp(mean(b.map((x) => x.r)))}   ${bp(mean(b.map((x) => x.rx)))}   ${hit === null ? "   –" : (hit * 100).toFixed(1) + "%"}`);
  }
  const f = follow(rows, "rx"), fr = follow(rows, "r");
  const obs = mean(f), p = permutationP(rows, "rx", obs);
  console.log(`follow strong agreement (|s| ≥ ${STRONG}), per 4h: ${bp(obs)} vs market (t = ${tstat(f).toFixed(2)}), ${bp(mean(fr))} raw (t = ${tstat(fr).toFixed(2)})`);
  console.log(`shuffle test: p = ${p.toFixed(3)} (chance of doing this well with random agreement)`);
  console.log(`after ~${(FEE_ROUND_TRIP * 1e4).toFixed(0)} bp round-trip fees: ${bp(mean(fr) - FEE_ROUND_TRIP)} per trade`);
  // profit factor: gross wins / gross losses
  const pf = (a) => { const w = a.filter((x) => x > 0).reduce((s, x) => s + x, 0), l = -a.filter((x) => x < 0).reduce((s, x) => s + x, 0); return l ? (w / l).toFixed(2) : "inf"; };
  const trades = rows.filter((x) => Math.abs(x.s) >= STRONG);
  const tr = trades.map((x) => Math.sign(x.s) * x.r), trx = trades.map((x) => Math.sign(x.s) * x.rx);
  console.log(`profit factor, per trade (${trades.length} trades): ${pf(tr)} raw, ${pf(tr.map((x) => x - FEE_ROUND_TRIP))} after fees, ${pf(trx)} vs market; win rate ${(mean(tr.map((x) => (x > 0 ? 1 : 0))) * 100).toFixed(1)}%`);
  console.log(`profit factor, per 4h round (${fr.length} rounds, trades averaged): ${pf(fr)} raw, ${pf(fr.map((x) => x - FEE_ROUND_TRIP))} after fees, ${pf(f)} vs market`);
  return { obs, p, t: tstat(f) };
}

const sRows = samples(smartTL), cRows = samples(controlTL);
console.log(`\nwindow ${new Date(START).toISOString().slice(0, 10)} → ${new Date(END).toISOString().slice(0, 10)} (${DAYS} days), 4h steps, at least ${MIN_TRADERS} traders in a coin`);
console.log(`smart traders with fills: ${smartTL.length} (${smartTL.filter((x) => x.truncated).length} busy enough to be cut short); control: ${controlTL.length}`);
const a = report("SMART (picked on pre-window PnL)", sRows);
const b = cRows.length ? report("CONTROL (random active traders)", cRows) : (console.log("\n(control group not fetched in this run)"), null);
fs.writeFileSync(path.join(DIR, "result.json"), JSON.stringify({ when: new Date().toISOString(), START, END, smart: a, control: b, n: { smart: sRows.length, control: cRows.length } }, null, 2));
