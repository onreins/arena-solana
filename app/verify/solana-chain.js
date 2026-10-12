/**
 * Reading Arena from Solana into the same in-memory `chain` that
 * callbook-chain.js readCallbook builds from Arc, so the scorer, the API and
 * the pages run on it unchanged.
 *
 * Only the program's own transactions and their logs are read: signatures for
 * the program id (newest first, paged with before/until), then each
 * transaction's log lines and block time. Events come from "Program data:"
 * lines logged while the Arena program itself runs (solana/arena.js
 * eventsFromLogs), so another program can't forge one. Failed transactions
 * are skipped.
 *
 * How Solana maps onto Arc's shape:
 *   - one book per owner (PDA ["book", owner]): an any-coin free book, horizons
 *     MIN_HORIZON..MAX_HORIZON. Books get numeric ids 1, 2, 3, ... in the order
 *     their BookOpened events happened (slot, then transaction, then log), so
 *     every reader gives the same book the same id. `address` keeps the PDA
 *   - a lock's `nonce` is its call id; the Revealed event carries the salt, so
 *     each reveal has its salt at once (checked against the lock's hash)
 *   - ProfileSet is the owner's profile (profileKey(owner, 0)); no agent links
 *   - Score accounts stand in for ERC-8004's ValidationRegistry: each book has
 *     an implied request for the configured validator (its key is the Score
 *     account's address) and every ScoreWritten from that validator is a
 *     response to it. Without a validator, scores are ignored: anyone can write
 *     a Score account naming themselves
 *
 * Addresses stay base58 as the chain has them: base58 is case-sensitive.
 * (Arc-era code lowercases some keys; profileKey lowercases both sides of a
 * lookup alike, so those still match.)
 *
 * A previous read can be passed back as `state`: only signatures newer than
 * the last one applied are read. The state advances one transaction at a
 * time, so a read that fails partway leaves it consistent.
 */
import { PublicKey } from "@solana/web3.js";

import { ARENA_PROGRAM_ID, MIN_HORIZON, MAX_HORIZON, bookAddress, scoreAddress, callHash, eventsFromLogs } from "../../solana/arena.js";
import { profileKey, RATE_LIMIT_TRIES } from "./callbook-chain.js";

export const SOLANA_STATE_KIND = "solana";
export const SIGNATURE_PAGE = 1_000; // getSignaturesForAddress's largest page
/** Transactions fetched at once (then applied in order). */
export const TX_CONCURRENCY = 8;
/** At most this many transactions per read; the rest wait for the next read. */
export const MAX_TX_PER_READ = 5_000;
const NO_STRATEGY = `0x${"0".repeat(64)}`;

const RATE_LIMIT_FIRST_WAIT_MS = 1_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (b) => `0x${Buffer.from(b).toString("hex")}`;
const base58 = (k) => (k instanceof PublicKey ? k.toBase58() : new PublicKey(k).toBase58());

function isRateLimit(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e.status === 429 || e.code === 429 || /\b429\b|rate limit|too many requests/i.test(String(e.message ?? ""))) return true;
  }
  return false;
}

/** An RPC call, retried after 1s, 2s, 4s, ... while the RPC says it's rate limited. */
async function patiently(fn, wait) {
  for (let limited = 0; ;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimit(err) || ++limited >= RATE_LIMIT_TRIES) throw err;
      await wait(RATE_LIMIT_FIRST_WAIT_MS * 2 ** (limited - 1));
    }
  }
}

export function emptySolanaState({ programId = ARENA_PROGRAM_ID, chainId = "solana-devnet", validator = null } = {}) {
  return {
    kind: SOLANA_STATE_KIND,
    address: base58(programId),
    chainId,
    validator: validator ? base58(validator) : null,
    newestSignature: null, // the last transaction applied
    toSlot: 0,
    nextBookId: 1,
    bookIds: new Map(), // book address -> id
    books: new Map(),
    profiles: new Map(),
    links: new Map(),
    validation: { requests: new Map(), responses: new Map() },
  };
}

// ------------------------------------------------------------------ applying events

/** The implied validation request for a book: Solana needs none filed, the Score account's address names validator and book. */
function impliedRequest(s, book, at, tx) {
  if (!s.validator) return;
  const requestHash = scoreAddress(s.validator, book.address, new PublicKey(s.address)).toBase58();
  book.scoreAccount = requestHash;
  if (s.validation.requests.has(requestHash)) return;
  s.validation.requests.set(requestHash, {
    requestHash, validator: s.validator, agentId: null, uri: null, implied: true,
    book: { chainId: s.chainId, callbook: s.address, bookId: book.id }, at, tx,
  });
}

function openBook(s, { book, owner, openedAt }, tx, programId) {
  const address = base58(book), who = base58(owner);
  if (s.bookIds.has(address)) return s.books.get(s.bookIds.get(address));
  // Only the program writes these, but the PDA check is one hash per book: a book is the owner's own.
  if (!bookAddress(who, programId).equals(new PublicKey(address))) return null;
  const id = s.nextBookId++;
  const b = {
    id, kind: "free", address, owner: who, agentId: null, caller: who, strategyHash: NO_STRATEGY,
    coins: [], anyCoin: true, minHorizon: MIN_HORIZON, maxHorizon: MAX_HORIZON,
    openedAt, openTx: tx, closedAt: null, locks: new Map(),
  };
  s.bookIds.set(address, id);
  s.books.set(id, b);
  impliedRequest(s, b, openedAt, tx);
  return b;
}

const bookOf = (s, key) => s.books.get(s.bookIds.get(base58(key)));

/** The revealed preimage hashes to the lock (the program checked it; this is the reader's own look). */
function preimageMatches(programId, book, lock, e) {
  try {
    return hex(callHash({ programId, book: book.address, callId: lock.callId, horizon: lock.horizon, coin: e.coin, side: e.side, salt: e.salt })) === lock.hash;
  } catch {
    return false;
  }
}

function applyEvent(s, e, { tx, slot, index, programId }) {
  if (e.name === "ProfileSet") {
    const owner = base58(e.owner);
    s.profiles.set(profileKey(owner, 0), { account: owner, bookId: 0, name: String(e.profileName ?? ""), bio: e.bio ?? "", link: e.link ?? "", at: e.updatedAt, tx });
    return;
  }
  if (e.name === "BookOpened") {
    openBook(s, e, tx, programId);
    return;
  }
  const book = bookOf(s, e.book);
  if (!book) return; // events for a book this read never saw open
  if (e.name === "Locked") {
    if (book.locks.has(e.callId)) return;
    book.locks.set(e.callId, {
      callId: e.callId, hash: hex(e.callHash), lockedAt: e.lockedAt, entryAt: e.entryAt, horizon: e.horizon,
      lockTx: tx, nonce: e.callId, reveal: null,
    });
  } else if (e.name === "Revealed") {
    const l = book.locks.get(e.callId);
    if (!l || l.reveal) return;
    l.reveal = {
      coinIndex: null, symbol: e.coin, side: e.side, horizon: e.horizon ?? l.horizon, at: e.revealedAt, tx,
      // The salt is in the event; one that doesn't match the lock (never, if the program accepted it) leaves the call unscorable.
      salt: preimageMatches(programId, book, l, e) ? hex(e.salt) : null,
    };
  } else if (e.name === "ScoreWritten") {
    if (!s.validator || base58(e.validator) !== s.validator) return;
    impliedRequest(s, book, book.openedAt, book.openTx);
    const requestHash = book.scoreAccount;
    const list = s.validation.responses.get(requestHash) ?? [];
    list.push({
      requestHash, validator: s.validator, agentId: null, score: e.score, uri: null, responseHash: hex(e.reportHash), tag: e.scoring,
      at: e.scoredAt, tx, block: slot, logIndex: index,
      calls: e.calls, revealed: e.revealed, withheld: e.withheld, throughCall: e.throughCall,
    });
    s.validation.responses.set(requestHash, list);
  }
}

// ------------------------------------------------------------------ reading

/** Signatures newer than `until`, oldest first. */
async function newSignatures(connection, programId, until, wait) {
  const out = [];
  let before;
  for (;;) {
    const opts = { limit: SIGNATURE_PAGE };
    if (before) opts.before = before;
    if (until) opts.until = until;
    const page = await patiently(() => connection.getSignaturesForAddress(programId, opts, "confirmed"), wait);
    out.push(...page);
    if (page.length < SIGNATURE_PAGE) break;
    before = page[page.length - 1].signature;
  }
  // The RPC answers newest first (and in reverse order within a slot): reversed, that's chain order.
  return out.reverse();
}

/**
 * Every book, lock, reveal and profile, and (with `validator`) every score it
 * wrote. Returns a chain like readCallbook's:
 *   { kind: "solana", address: program id, chainId, toSlot, newestSignature,
 *     books: Map<id, book>, profiles, links (empty), validation: { requests, responses } }
 * and it is itself a valid `state` for the next call.
 *
 * opts: { connection, programId?, chainId?, validator?, state?, wait?, maxTransactions? }
 */
export async function readSolanaArena({ connection, programId = ARENA_PROGRAM_ID, chainId = "solana-devnet", validator = null, state, wait = sleep, maxTransactions = MAX_TX_PER_READ }) {
  const program = new PublicKey(programId);
  const s = state ?? emptySolanaState({ programId: program, chainId, validator });
  const sigs = await newSignatures(connection, program, s.newestSignature, wait);
  const todo = sigs.slice(0, maxTransactions);
  for (let i = 0; i < todo.length; i += TX_CONCURRENCY) {
    const batch = todo.slice(i, i + TX_CONCURRENCY);
    const txs = await Promise.all(batch.map((info) => (info.err
      ? null // failed: nothing to fetch
      : patiently(() => connection.getTransaction(info.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }), wait))));
    for (let k = 0; k < batch.length; k++) {
      const info = batch[k], tx = txs[k];
      if (!info.err) {
        // Listed but not served yet: the RPC lagging. Stop here, so it's read (in order) next time.
        if (!tx) return s;
        if (!tx.meta?.err) {
          const events = eventsFromLogs(tx.meta?.logMessages ?? [], program);
          events.forEach((e, index) => applyEvent(s, e, { tx: info.signature, slot: tx.slot ?? info.slot, index, programId: program }));
        }
      }
      s.newestSignature = info.signature;
      s.toSlot = Math.max(s.toSlot, Number(tx?.slot ?? info.slot ?? 0));
    }
  }
  return s;
}

// ------------------------------------------------------------------ snapshots

const SOLANA_SNAPSHOT_VERSION = 1;
const pack = (_, v) => (v instanceof Map ? { __map: [...v.entries()] } : v);
const unpack = (_, v) => (v && typeof v === "object" && Array.isArray(v.__map) ? new Map(v.__map) : v);

/** A read's state as text, so a cold start continues from its newest signature. */
export function solanaSnapshotText(state) {
  return JSON.stringify({ version: SOLANA_SNAPSHOT_VERSION, kind: SOLANA_STATE_KIND, savedAt: new Date().toISOString(), state }, pack);
}

/** A state from solanaSnapshotText, or null when it was read from another program, cluster or validator. */
export function solanaStateFromSnapshot(text, { programId = ARENA_PROGRAM_ID, chainId = "solana-devnet", validator = null } = {}) {
  try {
    const snap = JSON.parse(text, unpack);
    const s = snap?.state;
    if (snap?.version !== SOLANA_SNAPSHOT_VERSION || snap.kind !== SOLANA_STATE_KIND || !s) return null;
    if (s.address !== base58(programId) || s.chainId !== chainId) return null;
    if ((s.validator ?? null) !== (validator ? base58(validator) : null)) return null;
    if (!(s.books instanceof Map) || !(s.bookIds instanceof Map)) return null;
    return { ...s, links: s.links ?? new Map(), profiles: s.profiles ?? new Map() };
  } catch {
    return null;
  }
}
