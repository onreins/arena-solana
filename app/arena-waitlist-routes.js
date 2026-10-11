/**
 * The Arena marketplace waitlist (docs/ARENA-SITE-SPEC.md, "Waitlist API").
 * Mounted by app/server.js, and so by the Vercel function in api/index.js.
 *
 *   POST /api/arena/waitlist  { role: "subscribe" | "sell", bookId? }  (signed in)
 *        -> { ok, joined: true, counts, mine }
 *   GET  /api/arena/waitlist
 *        -> { ok, subscribe: { total, byBook: { "<id>": n } }, sell: { total }, domain, mine? }
 *
 * Signed in means what the profile and link relays check: an EIP-712
 * signature from the address. The site's sign-in lives in the browser only,
 * so the browser signs one JoinWaitlist { account, deadline } (up to 7 days
 * ahead, Arena's domain: `domain` in the GET answer) and sends it with each
 * request in the X-Arena-Session header as `<account>.<deadline>.<signature>`.
 * Google (Circle) wallets sign it through /api/auth/circle/sign.
 *
 * Stored: the lowercase address, the role, the bookId and the time of the
 * first join; nothing else. In Upstash / Vercel KV over REST when configured
 * (the same settings as the rate-limit counters), in memory otherwise. On
 * Vercel without a shared store the waitlist is off rather than kept per
 * instance. subscribe.total counts people; byBook counts each book's subscribers.
 */
import { verifyTypedData } from "viem";

import { countersFromEnv, ipBucket, brief, sharedStoreEnv } from "./verify/callbook-util.js";
import { callbookNetwork } from "./verify/callbook-network.js";

const PATH = "/api/arena/waitlist";
const HOUR = 3_600;
const MINUTE = 60;
const MAX_SESSION_SEC = 7 * 24 * HOUR;
const COUNTS_TTL_MS = 5_000;
const PREFIX = "arena:waitlist:";
export const SESSION_HEADER = "x-arena-session";
export const WAITLIST_LIMITS = Object.freeze({ joinsPerIpHour: 60, joinsPerAddressHour: 30, sessionReadsPerIpMinute: 120 });
export const WAITLIST_TYPES = Object.freeze({
  JoinWaitlist: [{ name: "account", type: "address" }, { name: "deadline", type: "uint256" }],
});
const ROLES = new Set(["subscribe", "sell"]);
const SESSION_RE = /^(0x[0-9a-fA-F]{40})\.(\d{1,12})\.(0x[0-9a-fA-F]{130})$/;
const SIGN_IN_FIRST = "Sign in first.";

class WaitlistError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- stores

/** A Redis-like pipeline in memory: the four commands the waitlist uses. */
export function memoryStore() {
  const sets = new Map(), hashes = new Map();
  const set = (k) => sets.get(k) ?? sets.set(k, new Set()).get(k);
  const run = ([cmd, key, ...args]) => {
    if (cmd === "SADD") { const s = set(key), n = s.size; args.forEach((a) => s.add(a)); return s.size - n; }
    if (cmd === "SCARD") return sets.get(key)?.size ?? 0;
    if (cmd === "SMEMBERS") return [...(sets.get(key) ?? [])];
    if (cmd === "HSETNX") {
      const h = hashes.get(key) ?? hashes.set(key, new Map()).get(key);
      if (h.has(args[0])) return 0;
      h.set(args[0], args[1]);
      return 1;
    }
    throw new Error(`unsupported command ${cmd}`);
  };
  return { kind: "memory", pipeline: async (cmds) => cmds.map(run) };
}

/** Upstash / Vercel KV over REST: one POST /pipeline per call; any command's error fails the call. */
export function restStore({ url, token, fetchImpl = globalThis.fetch }) {
  const base = url.replace(/\/$/, "");
  return {
    kind: "rest",
    async pipeline(cmds) {
      const res = await fetchImpl(`${base}/pipeline`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(cmds),
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) throw new Error(`waitlist store answered ${res.status}`);
      const out = await res.json();
      if (!Array.isArray(out) || out.length !== cmds.length) throw new Error("waitlist store answered out of shape");
      const failed = out.find((r) => r?.error);
      if (failed) throw new Error("waitlist store refused a command");
      return out.map((r) => r?.result);
    },
  };
}

// ---------------------------------------------------------------- the waitlist

/** Joins, counts and one address's entries over a store. */
function waitlistOver(store) {
  const k = (name) => PREFIX + name;
  async function join(address, role, bookId, at) {
    const field = `${role}:${bookId ?? "-"}:${address}`;
    const cmds = [["HSETNX", k("at"), field, String(at)]];
    if (role === "subscribe") {
      cmds.push(["SADD", k("subscribe"), address], ["SADD", k(`subscribe:${bookId}`), address],
        ["SADD", k("books"), String(bookId)], ["SADD", k(`by:${address}`), `subscribe:${bookId}`]);
    } else {
      cmds.push(["SADD", k("sell"), address], ["SADD", k(`by:${address}`), "sell"]);
    }
    await store.pipeline(cmds);
  }
  async function counts() {
    const [books, subscribers, sellers] = await store.pipeline([["SMEMBERS", k("books")], ["SCARD", k("subscribe")], ["SCARD", k("sell")]]);
    const ids = (books ?? []).filter((b) => /^\d{1,16}$/.test(b)).sort((a, b) => Number(a) - Number(b));
    const sizes = ids.length ? await store.pipeline(ids.map((id) => ["SCARD", k(`subscribe:${id}`)])) : [];
    const byBook = {};
    ids.forEach((id, i) => { if (Number(sizes[i]) > 0) byBook[id] = Number(sizes[i]); });
    return { subscribe: { total: Number(subscribers) || 0, byBook }, sell: { total: Number(sellers) || 0 } };
  }
  async function mine(address) {
    const [entries] = await store.pipeline([["SMEMBERS", k(`by:${address}`)]]);
    const subscribe = (entries ?? []).map((e) => /^subscribe:(\d{1,16})$/.exec(e)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
    return { subscribe, sell: (entries ?? []).includes("sell") };
  }
  return { join, counts, mine };
}

// ---------------------------------------------------------------- input

/** { role, bookId } from a request body, or a 400. Extra fields are ignored; input is never echoed. */
export function parseJoin(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new WaitlistError(400, 'Send { role, bookId } as JSON.');
  const { role, bookId } = body;
  if (typeof role !== "string" || !ROLES.has(role)) throw new WaitlistError(400, 'role must be "subscribe" or "sell".');
  const given = bookId !== undefined;
  if (role === "subscribe" && !given) throw new WaitlistError(400, "bookId is required to subscribe.");
  if (given && !(Number.isSafeInteger(bookId) && bookId > 0)) throw new WaitlistError(400, "bookId must be a positive whole number.");
  return { role, bookId: given ? bookId : null };
}

// ---------------------------------------------------------------- routes

/** opts: { env, now?, fetchImpl?, counters?, limits?, log? } */
export function mountWaitlist(app, { env = process.env, now = () => Math.floor(Date.now() / 1000), fetchImpl, counters, limits = {}, log = (m) => console.error("[waitlist]", m) } = {}) {
  const L = { ...WAITLIST_LIMITS, ...limits };
  const shared = sharedStoreEnv(env);
  const store = shared ? restStore({ ...shared, fetchImpl }) : memoryStore();
  const list = waitlistOver(store);
  const counter = counters ?? countersFromEnv(env, { now, log });
  // On Vercel each instance has its own memory: a waitlist kept there would be lost and split.
  const off = env.VERCEL && !shared ? "The waitlist isn't set up on this server yet." : null;
  let domain = null;
  try {
    const net = callbookNetwork(env);
    if (net) domain = Object.freeze({ name: "Arena", version: "1", chainId: net.chain.id, verifyingContract: net.address });
  } catch { /* no Arena deployment configured: nothing to sign against, so nobody can join */ }

  let cached = null; // { at, counts }: one instance's counts for a few seconds
  async function counts(fresh = false) {
    if (!fresh && cached && Date.now() - cached.at < COUNTS_TTL_MS) return cached.counts;
    cached = { at: Date.now(), counts: await list.counts() };
    return cached.counts;
  }

  /** The signed-in address from the session header (lowercase), or null. */
  async function sessionAddress(req) {
    const m = SESSION_RE.exec(String(req.get(SESSION_HEADER) ?? "").trim());
    if (!m || !domain) return null;
    const [, account, deadlineText, signature] = m;
    const deadline = Number(deadlineText), t = now();
    if (deadline <= t || deadline > t + MAX_SESSION_SEC) return null;
    const ok = await verifyTypedData({
      address: account, domain, types: WAITLIST_TYPES, primaryType: "JoinWaitlist",
      message: { account, deadline: BigInt(deadline) }, signature,
    }).catch(() => false);
    return ok ? account.toLowerCase() : null;
  }

  async function limit(key, windowSec, max) {
    if ((await counter.hit(key, windowSec)) > max) throw new WaitlistError(429, "Too many requests. Try again later.");
  }

  function reply(res, err) {
    if (err instanceof WaitlistError) return res.status(err.status).json({ ok: false, error: err.message });
    log(`store: ${brief(err)}`);
    res.status(503).json({ ok: false, error: "The waitlist can't be reached right now. Try again in a moment." });
  }

  app.post(PATH, async (req, res) => {
    res.set("cache-control", "private, no-store");
    try {
      if (off) throw new WaitlistError(503, off);
      await limit(`waitlist:ip:${ipBucket(req.ip)}`, HOUR, L.joinsPerIpHour);
      if (!req.get(SESSION_HEADER)) throw new WaitlistError(401, SIGN_IN_FIRST);
      const { role, bookId } = parseJoin(req.body);
      if (!domain) throw new WaitlistError(503, "Arena isn't configured on this server, so there's nothing to join yet.");
      const address = await sessionAddress(req);
      if (!address) throw new WaitlistError(401, SIGN_IN_FIRST);
      // After the signature: bad signatures naming someone can't use up their quota.
      await limit(`waitlist:addr:${address}`, HOUR, L.joinsPerAddressHour);
      await list.join(address, role, bookId, now());
      res.json({ ok: true, joined: true, counts: await counts(true), mine: await list.mine(address) });
    } catch (err) {
      reply(res, err);
    }
  });

  app.get(PATH, async (req, res) => {
    res.vary(SESSION_HEADER);
    try {
      if (off) throw new WaitlistError(503, off);
      let address = null;
      if (req.get(SESSION_HEADER)) {
        await limit(`waitlist:read:${ipBucket(req.ip)}`, MINUTE, L.sessionReadsPerIpMinute);
        address = await sessionAddress(req);
      }
      const body = { ok: true, ...(await counts()), domain };
      if (!address) return res.set("cache-control", "public, max-age=30").json(body);
      res.set("cache-control", "private, no-store").json({ ...body, mine: await list.mine(address) });
    } catch (err) {
      res.set("cache-control", "no-store");
      reply(res, err);
    }
  });

  return { on: !off, store: store.kind, domain };
}
