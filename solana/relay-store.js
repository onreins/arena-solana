/**
 * The Solana relay's rate-limit store. Same backends as the Callbook relay's
 * counters (app/verify/callbook-util.js): in memory, or Upstash / Vercel KV
 * over their REST API (KV_REST_API_URL/KV_REST_API_TOKEN or
 * UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN).
 *
 * One difference, on purpose: this store never falls back to memory. A shared
 * store that errors, times out or answers something odd throws, and the relay
 * refuses (503) instead of signing. The relay key pays real SOL, so a limit
 * that silently stops holding is worse than a relay that stops.
 *
 * Interface (all async):
 *   hit(key, windowSec, by = 1) -> count in the current fixed window, after adding `by`
 *   peek(key, windowSec)        -> count in the current fixed window
 *   claim(key, ttlSec)          -> true if this call set the key (it didn't exist), else false
 *   has(key)                    -> whether a claimed key exists
 */
import { sharedStoreEnv } from "../app/verify/callbook-util.js";

const nowSec = () => Math.floor(Date.now() / 1000);

export function memoryRelayStore({ now = nowSec } = {}) {
  const counts = new Map();
  const claims = new Map();
  const sweep = (t) => {
    if (counts.size > 50_000) for (const [k, v] of counts) if (v.until <= t) counts.delete(k);
    if (claims.size > 50_000) for (const [k, until] of claims) if (until <= t) claims.delete(k);
  };
  return {
    kind: "memory",
    async hit(key, windowSec, by = 1) {
      const t = now();
      const w = Math.floor(t / windowSec);
      const k = `${key}:${w}`;
      const n = (counts.get(k)?.n ?? 0) + by;
      counts.set(k, { n, until: (w + 1) * windowSec });
      sweep(t);
      return n;
    },
    async peek(key, windowSec) {
      return counts.get(`${key}:${Math.floor(now() / windowSec)}`)?.n ?? 0;
    },
    async claim(key, ttlSec) {
      const t = now();
      const until = claims.get(key);
      if (until !== undefined && until > t) return false;
      claims.set(key, t + ttlSec);
      sweep(t);
      return true;
    },
    async has(key) {
      const until = claims.get(key);
      return until !== undefined && until > now();
    },
  };
}

/** Upstash / Vercel KV over REST. Every command's answer is checked; anything off throws. */
export function restRelayStore({ url, token, prefix = "arena-sol:", fetch: doFetch = globalThis.fetch, now = nowSec, timeoutMs = 3_000 }) {
  const base = String(url).replace(/\/$/, "");
  async function pipeline(cmds) {
    const res = await doFetch(`${base}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`rate-limit store answered ${res.status}`);
    const out = await res.json();
    if (!Array.isArray(out) || out.length !== cmds.length) throw new Error("rate-limit store answered an unexpected shape");
    for (const r of out) if (!r || typeof r !== "object" || r.error) throw new Error("rate-limit store refused a command");
    return out.map((r) => r.result);
  }
  const int = (v) => {
    const n = v === null ? 0 : Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("rate-limit store answered a non-count");
    return n;
  };
  return {
    kind: "rest",
    async hit(key, windowSec, by = 1) {
      const k = `${prefix}${key}:${Math.floor(now() / windowSec)}`;
      const [n] = await pipeline([["INCRBY", k, String(by)], ["EXPIRE", k, String(windowSec * 2)]]);
      const v = int(n);
      if (v < by) throw new Error("rate-limit store answered a count below the increment");
      return v;
    },
    async peek(key, windowSec) {
      const [n] = await pipeline([["GET", `${prefix}${key}:${Math.floor(now() / windowSec)}`]]);
      return int(n);
    },
    async claim(key, ttlSec) {
      const [r] = await pipeline([["SET", `${prefix}${key}`, "1", "NX", "EX", String(ttlSec)]]);
      if (r === "OK") return true;
      if (r === null) return false;
      throw new Error("rate-limit store answered an unexpected claim result");
    },
    async has(key) {
      const [n] = await pipeline([["EXISTS", `${prefix}${key}`]]);
      return int(n) > 0;
    },
  };
}

/**
 * The store the environment asks for: { store, off }. Shared when the KV /
 * Upstash variables are set; in memory otherwise, except on Vercel, where each
 * instance has its own memory and limits wouldn't hold: then store is null and
 * `off` says why the relay is off.
 */
export function relayStoreFromEnv(env = process.env, { now, fetch } = {}) {
  const shared = sharedStoreEnv(env);
  if (shared) return { store: restRelayStore({ ...shared, now, fetch }), off: null };
  if (env.VERCEL) return { store: null, off: "the Solana gasless relayer is off on this server (no shared rate-limit store configured)" };
  return { store: memoryRelayStore({ now }), off: null };
}
