/**
 * Arena on Solana: which cluster, program, RPC and validator to read. The
 * counterpart of callbook-network.js, chosen with ARENA_NETWORK=solana-devnet
 * (any other value, or none, keeps the Arc path exactly as it was).
 *
 *   ARENA_NETWORK             solana-devnet
 *   SOLANA_RPC_URL            RPC URL (default: the cluster's public RPC)
 *   ARENA_SOLANA_PROGRAM_ID   the Arena program (default: solana/arena.js ARENA_PROGRAM_ID)
 *   ARENA_SOLANA_VALIDATOR    the validator whose Score accounts count. Anyone can
 *                             write a Score account naming themselves, so without a
 *                             valid one every score is ignored (like Arc's validator)
 *   ARENA_STATE_FILE          the chain-state snapshot (default app/data/callbook-state-<network>.json)
 *
 * Every ARENA_X is also read as CALLBOOK_X (arenaEnv), as for Arc.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";

import { ARENA_PROGRAM_ID } from "../../solana/arena.js";
import { arenaEnv } from "./callbook-network.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const SOLANA_NETWORKS = Object.freeze({
  "solana-devnet": Object.freeze({ cluster: "devnet", label: "Solana devnet", rpc: "https://api.devnet.solana.com" }),
});

export const isSolanaNetwork = (name) => Object.prototype.hasOwnProperty.call(SOLANA_NETWORKS, String(name ?? ""));

const EXPLORER = "https://explorer.solana.com";
const clusterQuery = (cluster) => (cluster && cluster !== "mainnet-beta" ? `?cluster=${cluster}` : "");

/** A transaction on Solana's explorer. */
export const explorerTx = (sig, cluster = "devnet") => `${EXPLORER}/tx/${sig}${clusterQuery(cluster)}`;
/** An account on Solana's explorer. */
export const explorerAddress = (addr, cluster = "devnet") => `${EXPLORER}/address/${addr}${clusterQuery(cluster)}`;
/**
 * The explorer base the pages get as `explorer` (app/public/callbook-common.js
 * txLink puts the path before the query: <base>/tx/<sig>?cluster=devnet).
 */
export const explorerBase = (cluster = "devnet") => `${EXPLORER}${clusterQuery(cluster)}`;

/** A base58 public key as text, or null when it isn't one. */
export function publicKeyText(value) {
  if (!value) return null;
  try {
    return new PublicKey(String(value).trim()).toBase58();
  } catch {
    return null;
  }
}

/** The configured Solana network, or null when ARENA_NETWORK isn't a Solana one. Throws on a bad program id. */
export function solanaNetwork(rawEnv = process.env) {
  const env = arenaEnv(rawEnv);
  const name = env.CALLBOOK_NETWORK;
  if (!isSolanaNetwork(name)) return null;
  const known = SOLANA_NETWORKS[name];
  const programText = env.CALLBOOK_SOLANA_PROGRAM_ID ?? ARENA_PROGRAM_ID.toBase58();
  const address = publicKeyText(programText);
  if (!address) throw new Error("ARENA_SOLANA_PROGRAM_ID must be a base58 public key");
  let validator = null, validationOff = null;
  if (env.CALLBOOK_SOLANA_VALIDATOR) validator = publicKeyText(env.CALLBOOK_SOLANA_VALIDATOR);
  if (!validator) validationOff = "ARENA_SOLANA_VALIDATOR is not set to a valid public key, so Score accounts are ignored";
  return {
    kind: "solana", name, label: known.label, cluster: known.cluster, chainId: name,
    rpc: (env.SOLANA_RPC_URL ?? "").trim() || known.rpc,
    address, programId: new PublicKey(address), validator, validationOff,
    explorer: explorerBase(known.cluster), registry: null, local: false, ours: null,
    stateFile: env.CALLBOOK_STATE_FILE ?? path.join(ROOT, "app", "data", `callbook-state-${name}.json`),
  };
}

/**
 * A Connection for the reader. Its own retry on 429 is off: solana-chain.js
 * backs off itself, as callbook-chain.js does for Arc.
 */
export function connectionFor(net) {
  return new Connection(net.rpc, { commitment: "confirmed", disableRetryOnRateLimit: true });
}
