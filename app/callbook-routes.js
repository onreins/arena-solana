/**
 * Callbook's HTTP surface, mounted by app/server.js (and so by the Vercel
 * function in api/index.js, which serves the same app).
 *
 *   GET /api/callbook               every book and caller, the totals and the feed
 *   GET /api/callbook/book/:id      one book with every period
 *   GET /api/callbook/caller/:id    one caller (an open-call book) with every call
 *   GET /api/callbook/solana-config what the Copy flow and the Following page need (Solana only):
 *                                   the follow Config, the copier's delegate key, the mints and program ids
 *   GET /api/callbook/report/:id    the canonical report a validation response
 *       ?asOf=<unix seconds>        points to; its keccak256 is the responseHash
 *                                   (cached by id and asOf; 30 a minute per client)
 *   POST /api/callbook/relay/lock   gasless lock: { account, callHash, horizon, deadline, signature }
 *   POST /api/callbook/relay/seal   gasless seal: { bookId, p, callHash, deadline, signature }
 *   POST /api/callbook/relay/reveal any reveal, with its preimage
 *   POST /api/callbook/relay/profile gasless profile: { account, bookId, name, bio, link, deadline, signature }
 *   POST /api/callbook/relay/link   link an agent to a wallet: { agent, wallet, deadline, agentSig, walletSig }
 *   POST /api/callbook/relay/unlink { agent, signer, deadline, signature } (signer: the agent or its wallet)
 *   POST /api/callbook/relay/link-check  check a link request's agent half; sends nothing
 *   (the relay routes answer 503 unless CALLBOOK_RELAYER_KEY is set; see app/verify/callbook-relay.js)
 *
 * Read from the network in CALLBOOK_NETWORK (see app/verify/callbook-network.js),
 * cached in memory for a minute; chain reads start from the runner's state
 * snapshot when there is one, and carry on from the last block seen. With
 * nothing configured, the index, book and caller routes redirect to the
 * static export in app/public/data, and the report route answers 404.
 *
 * With ARENA_NETWORK=solana-devnet the same routes read Arena's Solana program
 * instead (app/verify/solana-network.js, solana-chain.js): the chain has the
 * same shape, so scoring and the API are unchanged. Agent links and the EVM
 * relayer don't exist there: the link route answers 404 and the relay 503.
 *
 * Client addresses for rate limits come from req.ip, which honours the app's
 * TRUST_PROXY setting (app/server.js). On Vercel set TRUST_PROXY=1: Vercel
 * overwrites X-Forwarded-For with the real client address, and trusting one
 * hop reads exactly that. Without it every visitor shares the proxy's address.
 * IPv6 clients are limited by /64.
 */
import { existsSync, readFileSync } from "node:fs";
import { createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { readCallbook, buildCallbook, evaluateAny, stateFromSnapshot } from "./verify/callbook.js";
import { createPriceSource } from "./verify/callbook-prices.js";
import { callbookNetwork, clientFor, arenaEnv } from "./verify/callbook-network.js";
import { createRelayer, RelayError } from "./verify/callbook-relay.js";
import { createAgentCards } from "./verify/arena-agent-card.js";
import { countersFromEnv, ipBucket, brief } from "./verify/callbook-util.js";
import { artifact } from "../scripts/artifact.js";
import { PublicKey } from "@solana/web3.js";
import { solanaNetwork, connectionFor, publicKeyText } from "./verify/solana-network.js";
import { FOLLOW_PROGRAM_ID, DEVNET_USDC } from "../solana/follow.js";
import { VELOCITY_PROGRAM_ID, DEVNET_QUOTE } from "./client/solana-velocity-browser.js";
import { readSolanaArena, solanaStateFromSnapshot } from "./verify/solana-chain.js";

const TTL_MS = 60_000;
const ID_RE = /^\d{1,12}$/;
const REPORT_CACHE = 200;
const REPORTS_PER_MINUTE = 30;
const LINK_READ_TTL_MS = 5_000;
const linkReads = new Map(); // agent -> { at, body }: GET /api/callbook/link/:agent, briefly
const VIEWS = parseAbi([
  "function identityRegistry() view returns (address)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function walletOf(address agent) view returns (address)",
  "function linkNonces(address agent) view returns (uint256)",
]);

/**
 * The board and each record: browsers keep them 30s, and Vercel's CDN (which
 * only reads s-maxage) serves them for 30s and a minute more while it fetches
 * the next, so a crowd of visitors costs one rebuild, not one each.
 */
const CACHE_INDEX = "public, max-age=30, s-maxage=30, stale-while-revalidate=60";

export function mountCallbook(app, { env: rawEnv = process.env, source, now = () => Math.floor(Date.now() / 1000), solanaConnection = null } = {}) {
  const env = arenaEnv(rawEnv); // ARENA_X settings are read as CALLBOOK_X
  const log = (m) => console.error("[callbook]", m);
  let net = null, setupError = null;
  try {
    net = solanaNetwork(env) ?? callbookNetwork(env); // a Solana network first: callbookNetwork knows only Arc's
    if (net?.validationOff) log(net.validationOff);
  } catch (err) {
    setupError = err.message;
    log(err.message);
  }

  const prices = source ?? createPriceSource({ log: (m) => console.error("[callbook prices]", m) });
  const counter = countersFromEnv(env, { now, log });
  let client = null, chainState = null, cache = null, building = null, identity;
  const solana = net?.kind === "solana";
  let connection = solanaConnection;

  /** The runner's last snapshot, if it matches what we read: a cold start continues from there. */
  async function initialState() {
    if (!net.stateFile || !existsSync(net.stateFile)) return null;
    if (solana) return solanaStateFromSnapshot(readFileSync(net.stateFile, "utf8"), { programId: net.programId, chainId: net.chainId, validator: net.validator });
    return stateFromSnapshot(readFileSync(net.stateFile, "utf8"), {
      address: net.address, chainId: await client.getChainId(), validationRegistry: net.registry, validator: net.validator,
    });
  }

  // One chain read at a time: two reads continuing the same state would apply the same logs twice.
  let reading = Promise.resolve();
  function chain() {
    const next = reading.then(async () => {
      if (solana) {
        connection ??= connectionFor(net);
        if (!chainState) chainState = await initialState().catch(() => null);
        chainState = await readSolanaArena({ connection, programId: net.programId, chainId: net.chainId, validator: net.validator, state: chainState });
        return chainState;
      }
      client ??= clientFor(net);
      if (!chainState) chainState = await initialState().catch(() => null);
      chainState = await readCallbook({
        client, address: net.address, fromBlock: net.fromBlock, validationRegistry: net.registry ?? undefined,
        validator: net.validator ?? undefined, state: chainState,
      });
      return chainState;
    });
    reading = next.catch(() => {});
    return next;
  }

  /** The current owner of an ERC-8004 agent, to flag books whose agent has moved. */
  async function agentOwner(agentId) {
    if (identity === undefined) identity = await client.readContract({ address: net.address, abi: VIEWS, functionName: "identityRegistry" }).catch(() => null);
    if (!identity || /^0x0+$/.test(identity)) return null;
    return client.readContract({ address: identity, abi: VIEWS, functionName: "ownerOf", args: [BigInt(agentId)] });
  }

  /**
   * The name in a linked agent's ERC-8004 registration file (cached a day; see arena-agent-card.js).
   * The index only peeks: a card being read in the background shows on the next rebuild.
   */
  const agentCards = createAgentCards({
    tokenUri: async (agentId) => {
      if (identity === undefined) identity = await client.readContract({ address: net.address, abi: VIEWS, functionName: "identityRegistry" }).catch(() => null);
      if (!identity || /^0x0+$/.test(identity)) return null;
      return client.readContract({ address: identity, abi: VIEWS, functionName: "tokenURI", args: [BigInt(agentId)] });
    },
  });
  const agentCard = (agentId) => agentCards.peek(agentId);

  /** Everything, rebuilt at most once a minute; concurrent requests share one build. */
  async function current() {
    if (cache && Date.now() - cache.at < TTL_MS) return cache;
    building ??= (async () => {
      try {
        const state = await chain();
        const meta = {
          mode: net.local ? "replay" : "live", network: net.label, chainId: state.chainId, explorer: net.explorer,
          // A Solana program id is base58, which is case-sensitive.
          contract: solana ? net.address : net.address.toLowerCase(), validationRegistry: net.registry?.toLowerCase() ?? null,
        };
        const built = await buildCallbook({
          chain: state, source: prices, asOf: now(), meta, validator: net.validator ?? undefined, reportBase: env.CALLBOOK_REPORT_BASE,
          log, ours: net.ours, agentOwner, agentCard,
        });
        cache = { at: Date.now(), ...built };
        return cache;
      } finally {
        building = null;
      }
    })();
    return building;
  }

  const off = (res) => res.status(404).json({ error: setupError ? "Callbook is misconfigured on this server" : "Callbook isn't configured on this server" });
  const fail = (res, err) => {
    log(brief(err));
    res.status(502).json({ error: "couldn't read Callbook right now" });
  };

  /** GET /api/callbook/link/:agent -> { agent, wallet (or null), nonce }: what an unlink or link signs against. */
  app.get("/api/callbook/link/:agent", async (req, res) => {
    if (!net) return res.status(404).json({ error: "Arena isn't configured on this server" });
    if (solana) return res.status(404).json({ error: "agent links aren't on Solana" });
    if (!/^0x[0-9a-fA-F]{40}$/.test(req.params.agent)) return res.status(400).json({ error: "that isn't an address" });
    try {
      // Each answer costs two RPC reads: limited per client, and kept a few seconds.
      if ((await counter.hit(`link-read:${ipBucket(req.ip)}`, 60)) > REPORTS_PER_MINUTE) return res.status(429).json({ error: "too many requests; try again in a minute" });
      const key = req.params.agent.toLowerCase(), hit = linkReads.get(key);
      if (hit && Date.now() - hit.at < LINK_READ_TTL_MS) return res.set("cache-control", "no-store").json(hit.body);
      client ??= clientFor(net);
      const [wallet, nonce] = await Promise.all([
        client.readContract({ address: net.address, abi: VIEWS, functionName: "walletOf", args: [req.params.agent] }),
        client.readContract({ address: net.address, abi: VIEWS, functionName: "linkNonces", args: [req.params.agent] }),
      ]);
      const body = { agent: key, wallet: /^0x0{40}$/.test(wallet) ? null : wallet.toLowerCase(), nonce: String(nonce) };
      if (linkReads.size > 1_000) linkReads.clear();
      linkReads.set(key, { at: Date.now(), body });
      res.set("cache-control", "no-store").json(body);
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * GET /api/callbook/solana-config: public keys only, for the browser's Copy flow.
   *   FOLLOW_CONFIG          the follow program Config whose plans Reins' copier serves
   *   COPIER_PUBKEY          the copier's public key: the delegate followers set on Velocity
   *   USDC_MINT              subscription mint (default: Circle's devnet USDC, solana/follow.js)
   *   FOLLOW_PROGRAM_ID, VELOCITY_PROGRAM_ID   overrides of the program ids
   *   SOLANA_PUBLIC_RPC_URL  the RPC browsers use (default: the cluster's public RPC). Never
   *                          SOLANA_RPC_URL, which may carry an API key.
   * Copying is `ready` only with a valid follow config and copier key.
   */
  app.get("/api/callbook/solana-config", (_req, res) => {
    if (!solana) return res.status(404).json({ error: "copy-trading runs on Solana; this server isn't in Solana mode" });
    res.set("cache-control", "public, max-age=60").json(solanaCopyConfig(rawEnv, net));
  });

  // With no network configured, the routes point at the static export, so a
  // page loads it without an error in the browser's console.
  app.get("/api/callbook", async (_req, res) => {
    if (!net) return setupError ? off(res) : res.redirect(302, "/data/callbook.json");
    try {
      res.set("cache-control", CACHE_INDEX).json((await current()).index);
    } catch (err) {
      fail(res, err);
    }
  });

  const detailRoute = (kind, staticName, pick) => async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: `a ${kind} id is a number` });
    if (!net) return setupError ? off(res) : res.redirect(302, `/data/${staticName}-${Number(req.params.id)}.json`);
    try {
      const found = pick(await current()).get(String(Number(req.params.id)));
      if (!found) return res.status(404).json({ error: `no such ${kind}` });
      res.set("cache-control", CACHE_INDEX).json(found);
    } catch (err) {
      fail(res, err);
    }
  };
  app.get("/api/callbook/book/:id", detailRoute("book", "callbook-book", (c) => c.details));
  app.get("/api/callbook/caller/:id", detailRoute("caller", "callbook-caller", (c) => c.callerDetails));

  // Reports are deterministic for a given (book, asOf): keep the latest few, and
  // limit how often one client can make us build a new one.
  const reports = new Map();
  app.get("/api/callbook/report/:id", async (req, res) => {
    if (!net) return off(res);
    const asOf = Number(req.query.asOf ?? now());
    if (!ID_RE.test(req.params.id) || !Number.isInteger(asOf) || asOf <= 0 || asOf > now()) {
      return res.status(400).json({ error: "pass a book id and an asOf in the past (unix seconds)" });
    }
    const key = `${Number(req.params.id)}:${asOf}`;
    try {
      let rep = reports.get(key);
      if (!rep) {
        if ((await counter.hit(`report:${ipBucket(req.ip)}`, 60)) > REPORTS_PER_MINUTE) return res.status(429).json({ error: "too many report requests; try again in a minute" });
        const state = await chain();
        const book = state.books.get(Number(req.params.id));
        if (!book) return res.status(404).json({ error: "no such book" });
        const ev = await evaluateAny({ chain: state, book, source: prices, asOf });
        rep = { hash: ev.report.hash, text: ev.report.text };
        reports.set(key, rep);
        if (reports.size > REPORT_CACHE) reports.delete(reports.keys().next().value);
      }
      // The exact text whose keccak256 is the report hash.
      res.set("x-report-hash", rep.hash).set("cache-control", "public, max-age=3600").type("application/json").send(rep.text);
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------------------------------------------------------- the relayer
  let relayer = null, relayOff = null;
  if (!net) relayOff = "Callbook isn't configured on this server";
  else if (solana) relayOff = "the gasless relayer isn't available on Solana from this server yet";
  else if (!/^0x[0-9a-fA-F]{64}$/.test(env.CALLBOOK_RELAYER_KEY ?? "")) relayOff = "the gasless relayer is off on this server (no relayer key configured)";
  // On Vercel each instance has its own memory: limits and the gas budget only hold with shared counters.
  else if (env.VERCEL && counter.kind !== "rest") { relayOff = "the gasless relayer is off on this server (no shared rate-limit store configured)"; log("relay off: set KV_REST_API_URL and KV_REST_API_TOKEN for shared rate limits on Vercel"); }
  const getRelayer = async () => {
    if (relayer) return relayer;
    client ??= clientFor(net);
    const wallet = createWalletClient({ account: privateKeyToAccount(env.CALLBOOK_RELAYER_KEY), chain: net.chain, transport: http(net.rpc) });
    relayer = createRelayer({
      publicClient: client, wallet, callbook: net.address, abi: artifact("Callbook").abi, chainId: await client.getChainId(),
      limits: env.CALLBOOK_RELAYER_DAILY_USDC ? { dailyBudgetUsdc: Number(env.CALLBOOK_RELAYER_DAILY_USDC) } : {}, now, counter,
      log: (m) => console.error("[callbook relay]", m),
    });
    return relayer;
  };
  // ---------------------------------------------------------------- health
  /**
   * GET /api/callbook/health -> { ok, problems: [sentences], network, relayer, validator, chain }:
   * what an outside check (.github/workflows/health.yml) watches. Problems: Arena or the relayer
   * off, the relayer's or validator's wallet under its minimum (ARENA_RELAYER_MIN_USDC, default 1;
   * ARENA_VALIDATOR_MIN_USDC, default 0.5), no validator set, or the chain unreachable.
   * Answered from memory for 30s; never starts a full chain read.
   */
  let health = null, healthing = null;
  const usdc = (wei) => Number(wei) / 1e18;
  // Public chain facts only (addresses and balances anyone can read), so the CDN may keep it 30s too.
  app.get("/api/callbook/health", async (_req, res) => {
    if (!health || Date.now() - health.at >= 30_000) {
      healthing ??= checkHealth().then((body) => { health = { at: Date.now(), body }; }).finally(() => { healthing = null; });
      await healthing;
    }
    res.set("cache-control", "public, max-age=30, s-maxage=30").json(health.body);
  });
  /** One health check at a time: concurrent requests share it. */
  async function checkHealth() {
    const problems = [];
    const body = { ok: false, problems, network: net?.name ?? null, contract: net?.address ?? null };
    if (!net) problems.push(setupError ?? "Arena isn't configured on this server");
    else if (solana) await checkSolanaHealth(body, problems);
    else {
      try {
        client ??= clientFor(net);
        const head = await client.getBlockNumber();
        // Reads follow visits, so a lag is information, not a fault.
        body.chain = { head: String(head), readTo: chainState ? String(chainState.toBlock) : null, lagBlocks: chainState ? Number(head - chainState.toBlock) : null };
        const minRelay = Number(env.CALLBOOK_RELAYER_MIN_USDC ?? 1);
        if (relayOff) {
          body.relayer = { on: false };
          problems.push(relayOff);
        } else {
          const address = privateKeyToAccount(env.CALLBOOK_RELAYER_KEY).address;
          const balance = usdc(await client.getBalance({ address }));
          body.relayer = { on: true, address, balanceUsdc: Math.round(balance * 1e4) / 1e4, minUsdc: minRelay };
          if (balance < minRelay) problems.push(`the relayer ${address} has ${balance.toFixed(4)} USDC, under ${minRelay}: fund it or gasless locks stop`);
        }
        const minValidator = Number(env.CALLBOOK_VALIDATOR_MIN_USDC ?? 0.5);
        if (!net.validator) {
          body.validator = null;
          problems.push(net.validationOff ?? "no validator is set, so no published score is shown");
        } else {
          const balance = usdc(await client.getBalance({ address: net.validator }));
          body.validator = { address: net.validator, balanceUsdc: Math.round(balance * 1e4) / 1e4, minUsdc: minValidator };
          if (balance < minValidator) problems.push(`the validator ${net.validator} has ${balance.toFixed(4)} USDC, under ${minValidator}: fund it or daily scores stop`);
        }
      } catch (err) {
        problems.push(`the chain couldn't be read: ${brief(err)}`);
      }
    }
    body.ok = problems.length === 0;
    return body;
  }

  /** Solana: the cluster reachable, how far the reader is behind, and the validator's SOL. */
  async function checkSolanaHealth(body, problems) {
    try {
      connection ??= connectionFor(net);
      const head = await connection.getSlot("confirmed");
      body.chain = { head: String(head), readTo: chainState ? String(chainState.toSlot) : null, lagSlots: chainState ? head - chainState.toSlot : null };
      body.relayer = { on: false };
      problems.push(relayOff);
      if (!net.validator) {
        body.validator = null;
        problems.push(net.validationOff);
      } else {
        const sol = (await connection.getBalance(new PublicKey(net.validator), "confirmed")) / 1e9;
        const minSol = Number(env.CALLBOOK_VALIDATOR_MIN_SOL ?? 0.01);
        body.validator = { address: net.validator, balanceSol: Math.round(sol * 1e4) / 1e4, minSol };
        if (sol < minSol) problems.push(`the validator ${net.validator} has ${sol.toFixed(4)} SOL, under ${minSol}: fund it or daily scores stop`);
      }
    } catch (err) {
      problems.push(`the chain couldn't be read: ${brief(err)}`);
    }
  }

  // Route name -> relayer function. link-check sends nothing: it checks a link request's agent half.
  const RELAY = { lock: "lock", seal: "seal", reveal: "reveal", profile: "profile", link: "link", unlink: "unlink", "link-check": "linkCheck" };
  for (const [action, fn] of Object.entries(RELAY)) {
    app.post(`/api/callbook/relay/${action}`, async (req, res) => {
      if (relayOff) return res.status(503).json({ error: relayOff });
      try {
        const r = await getRelayer();
        res.json(await r[fn](req.body ?? {}, { ip: req.ip }));
        // The next read shows a new call or link. A name waits for the next minute's rebuild: it's cheap to send, so it's no reason to rebuild.
        if (action !== "profile" && action !== "link-check") cache = null;
      } catch (err) {
        if (err instanceof RelayError) return res.status(err.status).json({ error: err.message, ...err.extra });
        log(`relay ${action}: ${brief(err)}`);
        res.status(502).json({ error: "the relayer couldn't send that right now" });
      }
    });
  }
}

/** The Copy flow's settings from the environment (see GET /api/callbook/solana-config). Pure. */
export function solanaCopyConfig(env, net) {
  const problems = [];
  const keyOf = (name, fallback = null) => {
    const raw = String(env[name] ?? "").trim();
    if (!raw) return fallback;
    const k = publicKeyText(raw);
    if (!k) problems.push(`${name} isn't a valid public key`);
    return k ?? fallback;
  };
  const followConfig = keyOf("FOLLOW_CONFIG");
  const copier = keyOf("COPIER_PUBKEY");
  const out = {
    cluster: net.cluster, network: net.label, explorer: net.explorer,
    rpc: String(env.SOLANA_PUBLIC_RPC_URL ?? "").trim() || (net.cluster === "devnet" ? "https://api.devnet.solana.com" : net.rpc),
    followProgram: keyOf("FOLLOW_PROGRAM_ID", FOLLOW_PROGRAM_ID.toBase58()),
    followConfig, copier,
    usdcMint: keyOf("USDC_MINT", DEVNET_USDC.toBase58()),
    velocityProgram: keyOf("VELOCITY_PROGRAM_ID", VELOCITY_PROGRAM_ID.toBase58()),
    quote: { ...DEVNET_QUOTE },
    ready: false, problems,
  };
  if (!followConfig) problems.push("FOLLOW_CONFIG is not set, so there is nothing to subscribe to");
  if (!copier) problems.push("COPIER_PUBKEY is not set, so there is no delegate to set on Velocity");
  out.ready = Boolean(followConfig && copier);
  return out;
}
