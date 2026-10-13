/**
 * Gasless Arena transactions on Solana through Reins' relayer:
 *
 *   GET  {relayUrl}/api/solana/relay   -> { feePayer, blockhash, lastValidBlockHeight }
 *   POST {relayUrl}/api/solana/relay   { tx: base64 }  -> { signature }
 *
 * The SDK builds a legacy Transaction whose fee payer is the relayer, signs it
 * with the agent's key (a partial signature: the relayer's slot stays empty),
 * and posts it. The relayer checks it holds only Arena instructions, co-signs
 * and sends it. The SDK then confirms the signature itself and reads the
 * result from the chain, so it never has to trust the answer.
 *
 * Program errors (Anchor: custom error 6000 + index, or "Error Code: Name" in
 * simulation logs) come back as CallbookErrors whose code is the error's name,
 * so a caller can tell StaleId from anything else.
 */
import { PublicKey } from "@solana/web3.js";

import { CallbookError } from "./errors.js";

const RELAY_TIMEOUT_MS = 30_000;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** programs/arena ArenaError, in order: Anchor numbers them from 6000. */
export const PROGRAM_ERRORS = [
  "EmptyCall", "BadHorizon", "StaleId", "AlreadyRevealed", "RevealTooEarly", "RevealExpired",
  "BadCoin", "BadSide", "WrongPreimage", "ProfileTooLong", "BadScore", "Overflow",
];

const SENTENCES = {
  EmptyCall: "A call's hash can't be zero.",
  BadHorizon: "Horizons are whole minutes, from 5m to 30d.",
  StaleId: "Another lock from this key got there first and took this call id. Nothing was recorded.",
  AlreadyRevealed: "That call is already revealed.",
  RevealTooEarly: "Too early to reveal: the call's horizon hasn't passed on chain yet.",
  RevealExpired: "Too late to reveal: the 7-day window closed. The call now scores as its worst outcome.",
  BadCoin: "A coin is 1 to 16 bytes.",
  BadSide: "A side is long or short.",
  WrongPreimage: "The revealed call doesn't match what was locked (wrong salt secret, or a stop/target this journal doesn't have?).",
  ProfileTooLong: "That profile is too long: a name is at most 32 bytes, a bio 160 and a link 100.",
  BadScore: "The score or its counts are out of range.",
  Overflow: "Arithmetic overflow in the program.",
};

/** The Arena program error named in an error object or text, or null. */
export function programErrorName(err) {
  const ie = err?.InstructionError ?? err?.value?.err?.InstructionError ?? err?.err?.InstructionError;
  const custom = Array.isArray(ie) ? ie[1]?.Custom : undefined;
  if (Number.isInteger(custom) && PROGRAM_ERRORS[custom - 6000]) return PROGRAM_ERRORS[custom - 6000];
  const text = typeof err === "string" ? err : `${err?.message ?? ""} ${(err?.logs ?? err?.transactionLogs ?? []).join?.(" ") ?? ""} ${safeJson(err)}`;
  let m = /Error Code: (\w+)/.exec(text);
  if (m && PROGRAM_ERRORS.includes(m[1])) return m[1];
  m = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (m && PROGRAM_ERRORS[parseInt(m[1], 16) - 6000]) return PROGRAM_ERRORS[parseInt(m[1], 16) - 6000];
  m = /"Custom":\s*(\d+)/.exec(text);
  if (m && PROGRAM_ERRORS[Number(m[1]) - 6000]) return PROGRAM_ERRORS[Number(m[1]) - 6000];
  return null;
}

function safeJson(v) {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/** A Solana failure as a CallbookError with a sentence (code: the program error's name when there is one). */
export function solanaError(err, what = "transaction") {
  if (err instanceof CallbookError && err.code !== "RelayRefused") return err;
  const name = programErrorName(err?.details?.raw ?? err);
  if (name) return new CallbookError(SENTENCES[name], name);
  if (err instanceof CallbookError) return err;
  const text = String(err?.message ?? safeJson(err));
  if (/insufficient (funds|lamports)|Attempt to debit an account but found no record of a prior credit/i.test(text)) {
    return new CallbookError("This key has no SOL to pay for the transaction. Leave ARENA_SOLANA_SELF_PAY unset to go gasless through the relayer, or fund it.", "NoGas");
  }
  if (/fetch failed|ECONNREFUSED|timed out|429|503/i.test(text)) return new CallbookError(`Can't reach the Solana RPC right now (${text.slice(0, 120)}). Try again in a moment.`, "Rpc");
  return new CallbookError(`The ${what} failed: ${text.slice(0, 300)}`, "Reverted");
}

const base = (relayUrl) => `${String(relayUrl).replace(/\/$/, "")}/api/solana/relay`;

async function call(doFetch, url, init, relayUrl) {
  let res, data;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    throw new CallbookError(`Can't reach the relayer at ${relayUrl} (${err.message}). Try again, or set ARENA_SOLANA_SELF_PAY=1 and fund the key.`, "RelayDown");
  }
  if (res.status === 404 || res.status === 405) {
    throw new CallbookError(`The relayer at ${relayUrl} doesn't relay Solana transactions (HTTP ${res.status}). Set another relay URL, or ARENA_SOLANA_SELF_PAY=1.`, "NoRelay");
  }
  if (!res.ok) {
    const why = String(data?.error ?? data?.message ?? `HTTP ${res.status}`);
    const name = programErrorName(`${why} ${(data?.logs ?? []).join(" ")}`);
    if (name) throw new CallbookError(SENTENCES[name], name);
    throw new CallbookError(`The relayer refused the transaction: ${why.replace(/\.$/, "").slice(0, 300)}.`, "RelayRefused", { status: res.status });
  }
  return data;
}

/** The relayer's fee payer and a recent blockhash to build a transaction on. */
export async function relayContext({ relayUrl, fetch: doFetch = globalThis.fetch }) {
  const data = await call(doFetch, base(relayUrl), { method: "GET" }, relayUrl);
  let feePayer;
  try {
    feePayer = new PublicKey(data?.feePayer);
  } catch {
    throw new CallbookError("The relayer answered without a valid fee payer.", "RelayBadAnswer");
  }
  if (!data?.blockhash || !Number.isFinite(Number(data?.lastValidBlockHeight))) throw new CallbookError("The relayer answered without a recent blockhash.", "RelayBadAnswer");
  return { feePayer, blockhash: String(data.blockhash), lastValidBlockHeight: Number(data.lastValidBlockHeight) };
}

/** Post a partially signed transaction (base64); returns its signature. */
export async function relaySubmit({ relayUrl, fetch: doFetch = globalThis.fetch }, txBase64) {
  const data = await call(doFetch, base(relayUrl), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: txBase64 }),
  }, relayUrl);
  const sig = data?.signature;
  if (!SIGNATURE.test(sig ?? "")) throw new CallbookError("The relayer answered without a transaction signature.", "RelayBadAnswer");
  return sig;
}
