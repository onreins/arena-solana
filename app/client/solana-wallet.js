/**
 * A Solana wallet in the browser, without a framework: Wallet Standard wallets
 * (Phantom, Solflare, Backpack… register themselves through the
 * "wallet-standard:*" window events) and, as a fallback, the injected
 * window.phantom.solana / window.solana provider.
 *
 * The page builds each transaction, the wallet only signs it, and the page
 * sends it to its own devnet RPC and waits for confirmation: one code path
 * for every wallet, whatever cluster the wallet itself is set to.
 */
import { PublicKey, Transaction } from "@solana/web3.js";

const standard = [];
let listening = false;

/** Start listening for Wallet Standard wallets (idempotent). */
export function discover() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const register = (...wallets) => {
    for (const w of wallets) if (w && !standard.includes(w)) standard.push(w);
    return () => {};
  };
  const api = Object.freeze({ register });
  window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail(api); } catch { /* a broken wallet */ } });
  try { window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api })); } catch { /* old browser */ }
}

const canSign = (w) => Boolean(w?.features?.["standard:connect"] && w.features["solana:signTransaction"] && (w.chains || []).some((c) => /^solana:/.test(c)));

/** Wallets the page can use: [{ id, name, icon, kind }]. */
export function wallets() {
  discover();
  const out = standard.filter(canSign).map((w, i) => ({ id: `std:${i}`, name: w.name, icon: w.icon, kind: "standard", w }));
  const injected = typeof window !== "undefined" ? (window.phantom && window.phantom.solana) || window.solana : null;
  if (injected && typeof injected.connect === "function" && !out.some((x) => /phantom/i.test(x.name) && injected.isPhantom)) {
    out.push({ id: "injected", name: injected.isPhantom ? "Phantom" : "Browser wallet", icon: null, kind: "injected", w: injected });
  }
  return out;
}

/**
 * Connect a wallet (an entry from wallets()). Returns
 * { publicKey, name, signTransaction(tx) -> signed Transaction, disconnect() }.
 */
export async function connect(entry, { chain = "solana:devnet" } = {}) {
  if (!entry) throw new Error("No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload.");
  if (entry.kind === "standard") {
    const w = entry.w;
    const res = await w.features["standard:connect"].connect();
    const account = (res?.accounts || w.accounts || [])[0];
    if (!account) throw new Error("The wallet didn't share an account");
    const publicKey = new PublicKey(account.address ?? account.publicKey);
    const signer = w.features["solana:signTransaction"];
    return {
      publicKey, name: w.name,
      async signTransaction(tx) {
        const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        const [out] = await signer.signTransaction({ account, transaction: bytes, chain });
        return Transaction.from(out.signedTransaction);
      },
      async disconnect() { try { await w.features["standard:disconnect"]?.disconnect(); } catch { /* fine */ } },
    };
  }
  const p = entry.w;
  const res = await p.connect();
  const publicKey = new PublicKey((res && res.publicKey) || p.publicKey);
  return {
    publicKey, name: entry.name,
    signTransaction: (tx) => p.signTransaction(tx),
    async disconnect() { try { await p.disconnect(); } catch { /* fine */ } },
  };
}

/**
 * Build, sign and send one transaction of `instructions` from `wallet`, then
 * wait for "confirmed". Returns the signature. Throws with the program's logs
 * attached (err.logs) when the cluster rejects it.
 */
export async function send(connection, wallet, instructions) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
  const signed = await wallet.signTransaction(tx);
  let signature;
  try {
    signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
  } catch (err) {
    const e = new Error(explain(err));
    e.logs = err.logs || (typeof err.getLogs === "function" ? await err.getLogs(connection).catch(() => null) : null);
    throw e;
  }
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value && res.value.err) {
    const e = new Error(`The transaction failed on chain: ${JSON.stringify(res.value.err)}`);
    e.signature = signature;
    throw e;
  }
  return signature;
}

/** A short, plain reason from a wallet or RPC error. */
export function explain(err) {
  const m = String((err && (err.message || err)) || "");
  if (/reject|denied|cancel/i.test(m)) return "You cancelled it in the wallet.";
  if (/insufficient (funds|lamports)|0x1\b/i.test(m)) return "Not enough funds: you need a little devnet SOL for fees and rent, and enough USDC.";
  if (/blockhash/i.test(m)) return "The transaction expired before it landed. Try again.";
  return m.replace(/^Error:\s*/, "").slice(0, 300) || "Something went wrong.";
}
