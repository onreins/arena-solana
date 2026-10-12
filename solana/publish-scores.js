/**
 * Posting Arena scores to Solana: the validator writes each book's Score
 * account (programs/arena write_score), the stand-in for ERC-8004's
 * Validation Registry that any program can read through the arena-score
 * crate. The same scorer as on Arc decides the number (callbook.js
 * buildCallbook); this only writes it down.
 *
 * Cadence and spend follow callbook-publish.js: at most one write per book a
 * day unless nothing changed, only books on `allow` (owners, base58), and a
 * daily lamport budget. A Score write costs one fee, plus its rent the first time.
 */
import { Transaction } from "@solana/web3.js";

import { shouldPublish } from "../app/verify/callbook-publish.js";
import { requestForBook, latestResponse, SCORING_VERSION } from "../app/verify/callbook-chain.js";
import { writeScoreIx, scoreAddress, bookAddress, ARENA_PROGRAM_ID } from "./arena.js";

const DAY = 86_400;
const FEE = 5_000;
/** Rent for a Score account (8 + 175 bytes), rounded up: only charged on the first write. */
export const SCORE_RENT_LAMPORTS = 2_165_000;
export const PUBLISH_DAILY_LAMPORTS = 50_000_000; // 0.05 SOL

/** The Score account's fields from one evaluated book (callbook.js `evaluated`). */
export function scoreArgsOf(ev) {
  const m = ev.scored.metrics ?? {};
  const revealed = m.revealed ?? 0;
  // withheld and unscorable calls both score at their worst
  const withheld = (m.withheld ?? 0) + (m.unscorable ?? 0);
  const value = ev.scored.score?.value;
  if (!Number.isInteger(value) || value < 0 || value > 100) return null;
  return {
    score: value,
    calls: revealed + withheld,
    revealed,
    withheld,
    throughCall: ev.book.locks?.size ?? 0,
    reportHash: Buffer.from(String(ev.report.hash).replace(/^0x/, ""), "hex"),
    scoring: SCORING_VERSION,
  };
}

/**
 * opts: { chain, evaluated, connection, validator: Keypair, now, allow: Set<owner>,
 *         budgetLamports?, spent?: Map<day, lamports>, dryRun?, log?, programId? }
 * Returns one row per book considered.
 */
export async function publishSolanaScores({
  chain, evaluated, connection, validator, now, allow, budgetLamports = PUBLISH_DAILY_LAMPORTS,
  spent = new Map(), dryRun = false, log, programId = ARENA_PROGRAM_ID,
}) {
  if (!(allow instanceof Set)) throw new Error("publishSolanaScores needs an allowlist of owners (allow: Set)");
  const day = Math.floor(now / DAY);
  const out = [];
  for (const ev of evaluated) {
    const { book } = ev;
    if (!allow.has(String(book.owner))) continue;
    const args = scoreArgsOf(ev);
    if (!args) continue;
    const req = requestForBook(chain, book.id, validator.publicKey.toBase58());
    const last = req ? latestResponse(chain, req.requestHash) : null;
    const decision = shouldPublish({ last, score: args.score, reportHash: ev.report.hash, now });
    const row = { bookId: book.id, owner: book.owner, score: args.score, ...decision };
    if (!decision.due || dryRun) {
      out.push(row);
      continue;
    }
    const account = scoreAddress(validator.publicKey, bookAddress(book.owner, programId), programId);
    const exists = Boolean(await connection.getAccountInfo(account));
    const cost = FEE + (exists ? 0 : SCORE_RENT_LAMPORTS);
    if ((spent.get(day) ?? 0) + cost > budgetLamports) {
      out.push({ ...row, due: false, why: "daily budget used up" });
      log?.(`book ${book.id}: not posted, the daily budget is used up`);
      continue;
    }
    spent.set(day, (spent.get(day) ?? 0) + cost);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: validator.publicKey, blockhash, lastValidBlockHeight })
      .add(writeScoreIx({ validator: validator.publicKey, owner: book.owner, ...args, programId }));
    tx.sign(validator);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`write_score for book ${book.id} failed (${signature})`);
    log?.(`book ${book.id}: score ${args.score} (${decision.why}) ${signature}`);
    out.push({ ...row, tx: signature, account: account.toBase58() });
  }
  return out;
}
