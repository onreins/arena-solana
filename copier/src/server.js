/**
 * The copier service: agents' SDKs POST each lock's sealed preimage to
 * /preimage; the copier opens it, checks it against the on-chain lock, and
 * copies the call to every paying follower (copier.js).
 *
 * Env:
 *   COPIER_KEYPAIR     path to the copier's Solana keypair (0600): the followers' delegate and fee payer
 *   COPIER_BOX_KEY     path to its X25519 private key (0600), made by `npm run keys`
 *   FOLLOW_CONFIG      the follow program Config whose plans this copier serves (Reins' config address)
 *   SOLANA_RPC_URL     default https://api.devnet.solana.com
 *   COPIER_JOURNAL     default copier/data/journal.jsonl
 *   COPIER_BUILDER_IDX, COPIER_BUILDER_FEE_TENTH_BPS   optional Velocity builder fee (max 1000 = 10 bps)
 *   PORT               default 8790
 *
 * No secret is ever printed: only public keys.
 */
import "./poll-confirm.js";
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { open as openBox } from "../../solana/preimage-box.js";
import { planAddress, followsOfPlan } from "../../solana/follow.js";
import { createCopier } from "./copier.js";
import { openJournal } from "./journal.js";

const MAX_BODY = 8_192;
const PER_IP_PER_MIN = 60;

/** A secret file's contents, refused when anyone but its owner can read it. */
export function readSecretFile(path) {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is readable by others (mode ${mode.toString(8)}): chmod 600 it.`);
  return readFileSync(path, "utf8").trim();
}

/** The HTTP handler, given a copier and the box key. Exported for tests. */
export function preimageHandler({ copier, boxKey, now = () => Date.now(), log = console.log }) {
  const hits = new Map();
  return async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true });
    if (req.method !== "POST" || req.url !== "/preimage") return reply(404, { error: "not found" });

    const ip = req.socket.remoteAddress ?? "?";
    const minute = Math.floor(now() / 60_000);
    const h = hits.get(ip);
    const n = h?.minute === minute ? h.n + 1 : 1;
    hits.set(ip, { minute, n });
    if (n > PER_IP_PER_MIN) return reply(429, { error: "slow down" });

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return reply(413, { error: "too large" });
    }
    const receivedAt = now();
    let body, preimage;
    try {
      body = JSON.parse(raw);
      preimage = openBox(body.box, boxKey);
    } catch {
      return reply(400, { error: "not a sealed preimage for this copier" });
    }
    // The envelope's public fields must agree with what's inside it.
    if (String(preimage.owner) !== String(body.owner) || Number(preimage.callId) !== Number(body.callId)) {
      return reply(400, { error: "the envelope and the preimage disagree" });
    }
    try {
      const out = await copier.handlePreimage(preimage, { receivedAt });
      log(`lock ${body.signature ?? "?"}: ${out.results.length} follower(s): ${out.results.map((r) => r.status).join(", ") || out.skipped || "none"}`);
      return reply(200, out);
    } catch (err) {
      return reply(err.status ?? 500, { error: err.reason ?? "copier error" });
    }
  };
}

async function main() {
  const env = process.env;
  const need = (k) => env[k] || (() => { throw new Error(`${k} is not set`); })();
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readSecretFile(need("COPIER_KEYPAIR")))));
  const boxKey = readSecretFile(need("COPIER_BOX_KEY"));
  const config = new PublicKey(need("FOLLOW_CONFIG"));
  const connection = new Connection(env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const builder = env.COPIER_BUILDER_IDX ? { idx: Number(env.COPIER_BUILDER_IDX), feeTenthBps: Number(env.COPIER_BUILDER_FEE_TENTH_BPS || 0) } : null;

  const { createVelocityExchange } = await import("./velocity.js");
  const exchange = await createVelocityExchange({ connection, keypair, builder });
  const journal = openJournal(env.COPIER_JOURNAL || fileURLToPath(new URL("../data/journal.jsonl", import.meta.url)));
  const copier = createCopier({
    connection, exchange, journal,
    followsForAgent: (agent) => followsOfPlan(connection, planAddress(config, agent)),
    log: console.log,
  });
  const recovered = await copier.recover();
  if (recovered.length) console.log(`recovered ${recovered.length} unsettled order(s): ${recovered.map((r) => r.status).join(", ")}`);

  const port = Number(env.PORT || 8790);
  createServer(preimageHandler({ copier, boxKey })).listen(port, () => {
    console.log(`copier ${keypair.publicKey.toBase58()} (delegate) serving config ${config.toBase58()} on :${port}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`copier: ${err.message}`);
    process.exit(1);
  });
}
