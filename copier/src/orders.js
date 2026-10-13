/**
 * Sizing and limits for one follower's copy of one call: pure functions, so
 * every rule the copier promises is testable without an exchange.
 *
 * Units follow the exchange (Velocity, formerly Drift): quote amounts and
 * prices at 1e6, base amounts at 1e9, all BigInt.
 */
import { exitsOf } from "../../app/verify/callbook-exits.js";

export const QUOTE_PRECISION = 1_000_000n;
export const PRICE_PRECISION = 1_000_000n;
export const BASE_PRECISION = 1_000_000_000n;
export const BPS = 10_000n;
export const SIZE_FIXED = 0;
export const SIZE_PERCENT = 1;

/**
 * Whether to copy, and how much. `settings` is the Follow account's (BigInt
 * amounts in quote units); `account` is the follower's copy subaccount now:
 * { netValue, openCopied, dayPnl }; `market` is { minSize, stepSize, price }.
 * Returns { ok: true, quote, base, clamped } or { ok: false, reason }.
 */
export function sizeOrder({ settings, account, market }) {
  const s = settings;
  if (BigInt(account.dayPnl) <= -BigInt(s.dailyLossCap)) return { ok: false, reason: "daily-loss-cap" };
  if (account.openCopied >= s.maxOpen) return { ok: false, reason: "max-open" };

  let quote = s.sizeMode === SIZE_PERCENT ? (BigInt(account.netValue) * BigInt(s.sizeValue)) / BPS : BigInt(s.sizeValue);
  const clamped = quote > BigInt(s.maxTrade);
  if (clamped) quote = BigInt(s.maxTrade);
  if (quote <= 0n) return { ok: false, reason: "no-size" };

  const price = BigInt(market.price);
  if (price <= 0n) return { ok: false, reason: "no-price" };
  const step = BigInt(market.stepSize) || 1n;
  const base = ((quote * BASE_PRECISION) / price / step) * step; // round down: never over the limit
  if (base < BigInt(market.minSize) || base === 0n) return { ok: false, reason: "below-min-size" };
  return { ok: true, quote, base, clamped };
}

/** A decimal price text ("187.5") at PRICE_PRECISION. */
export function priceUnits(text) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text));
  if (!m) throw new Error(`"${text}" isn't a price.`);
  const frac = (m[2] ?? "").slice(0, 6).padEnd(6, "0");
  return BigInt(m[1]) * PRICE_PRECISION + BigInt(frac);
}

/**
 * The orders for one copied call: a market entry, plus the call's
 * take-profit and stop-loss as reduce-only trigger orders when its salt
 * carries them. The salt is bound into the locked hash, so these are the
 * levels the agent committed to, not ones anyone added later.
 */
export function ordersFor({ side, base, salt }) {
  const long = side === 1;
  const orders = [{ kind: "entry", direction: long ? "long" : "short", base, reduceOnly: false }];
  const exits = exitsOf(salt);
  const close = long ? "short" : "long";
  if (exits?.target) {
    orders.push({ kind: "take-profit", direction: close, base, reduceOnly: true, triggerPrice: priceUnits(exits.target.text), triggerCondition: long ? "above" : "below" });
  }
  if (exits?.stop) {
    orders.push({ kind: "stop-loss", direction: close, base, reduceOnly: true, triggerPrice: priceUnits(exits.stop.text), triggerCondition: long ? "below" : "above" });
  }
  return orders;
}
