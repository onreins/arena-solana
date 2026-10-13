/**
 * Make web3.js's Connection.confirmTransaction poll over HTTP instead of
 * waiting on a websocket. Libraries the copier uses (Velocity's SDK, Anchor's
 * provider) confirm through it, and a websocket can't connect on a proxied
 * network or behind some RPC providers. Importing this module patches the
 * Connection class those libraries load; it changes nothing else.
 */
import { Connection } from "@solana/web3.js";

import { confirmByPolling } from "../../solana/arena.js";

if (!Connection.prototype.__pollConfirm) {
  Connection.prototype.__pollConfirm = true;
  Connection.prototype.confirmTransaction = async function confirmTransaction(strategy, commitment = "confirmed") {
    const signature = typeof strategy === "string" ? strategy : strategy.signature;
    const lastValidBlockHeight = typeof strategy === "string" ? null : strategy.lastValidBlockHeight ?? null;
    const deadline = Date.now() + 90_000;
    const conn = lastValidBlockHeight == null
      ? { getSignatureStatuses: (s) => (Date.now() > deadline ? Promise.reject(new Error(`transaction ${signature} not confirmed in 90 s`)) : this.getSignatureStatuses(s)) }
      : this;
    try {
      const s = await confirmByPolling(conn, signature, lastValidBlockHeight, { commitment: commitment === "finalized" ? "finalized" : "confirmed" });
      return { context: { slot: s.slot ?? 0 }, value: { err: null } };
    } catch (err) {
      if (err.err) return { context: { slot: 0 }, value: { err: err.err } };
      throw err;
    }
  };
}
