/**
 * Names for Callbook books. A book on chain carries only a strategy hash; the
 * names and descriptions live here, off-chain, keyed by that hash (or, for a
 * book someone else runs, by `${chainId}:${callbook}:${bookId}`).
 *
 * A strategy hash is keccak256 of the strategy's id string, which names a
 * version: changing the rules means a new id, a new hash, and a new book.
 */
import { keccak256, toHex } from "viem";

export const strategyHashOf = (id) => keccak256(toHex(id));

/** Our own agents' strategies, by id. runner/callbook-agents.js implements them. */
export const OUR_STRATEGIES = {
  "reins/callbook/hot-list/v1": {
    key: "hot",
    name: "Hot list",
    description:
      "Goes long the top coin on the Charts hot list (markets.js thesis: trend, flow and risk reads over the last 24 hourly candles), or stays flat when no coin qualifies.",
  },
  "reins/callbook/cold-list/v1": {
    key: "cold",
    name: "Cold list",
    description:
      "Shorts the coldest coin on the Charts list (the same thesis, read the other way), or stays flat when no coin is cold.",
  },
  "reins/callbook/coin-flip/v1": {
    key: "flip",
    name: "Coin flip",
    baseline: true,
    description:
      "A control: long or short BTC every period by a keyed coin flip. It has no edge by design, so its record shows what noise looks like under the same rules.",
  },
};

const BY_HASH = new Map(Object.entries(OUR_STRATEGIES).map(([id, s]) => [strategyHashOf(id).toLowerCase(), { id, ...s, ours: true }]));

/** Names for books that aren't ours, filled in as people register them: "chainId:callbook:bookId" -> { name, description }. */
export const OTHER_BOOKS = {};

/**
 * The sample callers the local replay runs (scripts/callbook-replay.js), by
 * the Hardhat test account that signs for each. Only ever applied on the
 * local chain (31337): these keys are public.
 */
export const SAMPLE_CALLERS = {
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc": {
    key: "breakout", name: "Breakout watcher",
    description: "Sample caller in the replay: goes long a coin when its hourly close breaks its 3-day high, for 12 hours.",
  },
  "0x976ea74026e726554db657fa54763abd0c3a0aa9": {
    key: "reverter", name: "Mean reverter",
    description: "Sample caller in the replay: fades any 24-hour move bigger than 8%, for 24 hours.",
  },
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955": {
    key: "weekend", name: "Weekend fader",
    description: "Sample caller in the replay: on weekends, fades BTC's and ETH's last 12 hours when they moved more than 1.5%, for 8 hours.",
  },
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f": {
    key: "random", name: "Random caller", baseline: true,
    description: "Sample caller in the replay and the BASELINE: random coin, side and horizon at random times. It held back two early calls and named one coin Hyperliquid doesn't list, to show how withheld and unscorable calls are scored.",
  },
};

/** { name, description, sample, ours } for an open-call book; name null means "use the short address". */
export function callerInfo({ chainId, callbook, book }) {
  const sample = Number(chainId) === 31337 ? SAMPLE_CALLERS[book.owner] : null;
  if (sample) return { name: sample.name, description: sample.description, sample: true, ours: false, baseline: Boolean(sample.baseline), key: sample.key };
  const other = OTHER_BOOKS[`${chainId}:${String(callbook).toLowerCase()}:${book.id}`];
  if (other) return { name: other.name, description: other.description ?? null, sample: false, ours: false, baseline: Boolean(other.baseline) };
  return { name: null, description: null, sample: false, ours: false, baseline: false };
}

/** Is this book one of ours? Its owner must be our owner AND it must be in our books record. */
export function isOurBook(ours, { bookId, owner }) {
  return Boolean(ours && owner && String(owner).toLowerCase() === ours.owner && ours.bookIds.has(Number(bookId)));
}

/**
 * { name, ours, description, key? } for a book. Our name and description go
 * only to a book that is ours by owner and record (isOurBook): a strategy hash
 * or a caller address is public, so anyone could copy them onto a book of
 * their own. Every other book is "Book #N".
 */
export function agentInfo({ chainId, callbook, bookId, strategyHash, owner, ours: ourBooks }) {
  const ours = isOurBook(ourBooks, { bookId, owner }) ? BY_HASH.get(String(strategyHash).toLowerCase()) : null;
  if (ours) return { name: ours.name, ours: true, baseline: Boolean(ours.baseline), description: ours.description, key: ours.key, strategy: ours.id };
  const other = OTHER_BOOKS[`${chainId}:${String(callbook).toLowerCase()}:${bookId}`];
  if (other) return { name: other.name, ours: false, baseline: Boolean(other.baseline), description: other.description ?? null };
  return { name: `Book #${bookId}`, ours: false, baseline: false, description: null };
}
