/**
 * The Solana backend of the Arena SDK and MCP server, against a mock chain
 * (an in-memory Arena program speaking solana/arena.js's encoding) and a mock
 * relayer (injected fetch) that co-signs like /api/solana/relay. No network.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import path from "node:path";
import bs58 from "bs58";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  ARENA_PROGRAM_ID, GRACE, bookAddress, callAddress, profileAddress, scoreAddress, callHash, saltBytes, coinBytes, decodeAccount,
} from "../solana/arena.js";
import { open as openBox, generateRecipientKeys } from "../solana/preimage-box.js";
import { CallbookClient, SolanaCallbookClient, createCallbookClient } from "../callbook/sdk.js";
import { createCallbookMcpServer } from "../callbook/mcp-server.js";
import { createMarkets } from "../callbook/markets.js";
import { withExits, exitsOf } from "../app/verify/callbook-exits.js";

const PID = ARENA_PROGRAM_ID;
const RELAY = "http://relay.test";
const T0 = 1_800_000_000; // a whole minute

// ------------------------------------------------------------------ fixtures

const NAMES = ["BTC", "ETH", "SOL", "HYPE", ...Array.from({ length: 60 }, (_, i) => `COIN${i}`)];
const META = [
  { universe: NAMES.map((name) => ({ name, maxLeverage: 10 })) },
  NAMES.map((_, i) => ({ dayNtlVlm: String(5e9 / (i + 1)), markPx: "100", funding: "0.0000125" })),
];
const markets = () => createMarkets({ fetch: async () => ({ ok: true, json: async () => META }) });

const sha = (s) => createHash("sha256").update(s).digest();
const disc = (kind, name) => sha(`${kind}:${name}`).subarray(0, 8);
const u8 = (n) => Buffer.from([n & 0xff]);
const i8 = (n) => { const b = Buffer.alloc(1); b.writeInt8(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const str = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([u32(b.length), b]); };

const encBook = (b) => Buffer.concat([disc("account", "Book"), u8(1), u8(255), b.owner.toBuffer(), u64(b.lockCount), i64(b.openedAt)]);
function encCall(c) {
  const coin = Buffer.alloc(16);
  let len = 0;
  if (c.coin) { const cb = coinBytes(c.coin); cb.copy(coin); len = cb.length; }
  return Buffer.concat([disc("account", "Call"), u8(254), c.book.toBuffer(), u64(c.callId), c.callHash, i64(c.lockedAt), i64(c.entryAt), u32(c.horizon),
    u8(c.revealed ? 1 : 0), i8(c.side ?? 0), u8(len), coin, i64(c.revealedAt ?? 0)]);
}
const encProfile = (p) => Buffer.concat([disc("account", "Profile"), u8(1), u8(253), p.owner.toBuffer(), str(p.name), str(p.bio), str(p.link), i64(p.updatedAt)]);
const encScore = (s) => Buffer.concat([disc("account", "Score"), u8(1), u8(252), s.validator.toBuffer(), s.book.toBuffer(), s.owner.toBuffer(), u8(s.score),
  u32(s.calls), u32(s.revealed), u32(s.withheld), u64(s.throughCall), i64(s.scoredAt), Buffer.alloc(32, 7), Buffer.from("arena-v1".padEnd(16, "\0"))]);
const event = (name, ...parts) => `Program data: ${Buffer.concat([disc("event", name), ...parts]).toString("base64")}`;

class ProgramError extends Error {
  constructor(name, idx) { super(name); this.idx = idx; }
}
const ERR = ["EmptyCall", "BadHorizon", "StaleId", "AlreadyRevealed", "RevealTooEarly", "RevealExpired", "BadCoin", "BadSide", "WrongPreimage", "ProfileTooLong"];
const perr = (name) => new ProgramError(name, ERR.indexOf(name));

/** An in-memory Arena program and the Connection methods the SDK uses. */
class MockChain {
  constructor() {
    this.accounts = new Map();
    this.now = T0;
    this.txs = new Map();
    this.byAddress = new Map();
    this.sent = []; // every processed transaction
    this.beforeLock = null;
    this.blockhash = bs58.encode(Buffer.alloc(32, 3));
  }
  put(addr, data) { this.accounts.set(addr.toBase58(), { data, owner: PID, lamports: 1, executable: false }); }
  get(addr) { const a = this.accounts.get(addr.toBase58()); return a ? decodeAccount(a.data) : null; }

  // Connection
  async getAccountInfo(addr) { return this.accounts.get(new PublicKey(addr).toBase58()) ?? null; }
  async getMultipleAccountsInfo(addrs) { return addrs.map((a) => this.accounts.get(new PublicKey(a).toBase58()) ?? null); }
  async getLatestBlockhash() { return { blockhash: this.blockhash, lastValidBlockHeight: 1000 }; }
  async getSlot() { return 5; }
  async getBlockTime() { return this.now; }
  async sendRawTransaction(raw) { return this.process(Transaction.from(raw)).signature; }
  async confirmTransaction({ signature }) { return { context: { slot: 5 }, value: { err: this.txs.get(signature)?.err ?? null } }; }
  async getSignaturesForAddress(addr) {
    return (this.byAddress.get(new PublicKey(addr).toBase58()) ?? []).slice().reverse().map((s) => ({ signature: s, err: this.txs.get(s).err }));
  }
  async getTransaction(sig) { const t = this.txs.get(sig); return t && { meta: { err: t.err, logMessages: t.logs } }; }

  /** Run a fully signed transaction atomically. { signature, err, logs } */
  process(tx, { commit = true } = {}) {
    assert.ok(tx.verifySignatures(true), "every signature is present and valid");
    const signature = bs58.encode(tx.signature);
    const signers = new Set(tx.signatures.map((s) => s.publicKey.toBase58()));
    const snapshot = new Map(this.accounts);
    const logs = [];
    let err = null;
    tx.instructions.forEach((ix, i) => {
      if (err) return;
      assert.ok(ix.programId.equals(PID), "only Arena instructions");
      logs.push(`Program ${PID.toBase58()} invoke [1]`);
      try {
        this.run(ix, signers, logs);
        logs.push(`Program ${PID.toBase58()} success`);
      } catch (e) {
        if (!(e instanceof ProgramError)) throw e;
        logs.push(`Program log: AnchorError occurred. Error Code: ${e.message}. Error Number: ${6000 + e.idx}.`, `Program ${PID.toBase58()} failed: custom program error: 0x${(6000 + e.idx).toString(16)}`);
        err = { InstructionError: [i, { Custom: 6000 + e.idx }] };
      }
    });
    if (err || !commit) this.accounts = snapshot;
    if (commit) {
      this.txs.set(signature, { err, logs, tx });
      this.sent.push({ signature, tx, err });
      for (const k of tx.compileMessage().accountKeys) {
        const a = k.toBase58();
        this.byAddress.set(a, [...(this.byAddress.get(a) ?? []), signature]);
      }
    }
    return { signature, err, logs };
  }

  run(ix, signers, logs) {
    const d = ix.data, tag = d.subarray(0, 8).toString("hex");
    const k = ix.keys.map((x) => x.pubkey);
    if (tag === disc("global", "lock").toString("hex")) {
      const [owner, payer, book, call] = k;
      assert.ok(signers.has(owner.toBase58()) && signers.has(payer.toBase58()), "owner and payer sign");
      assert.ok(book.equals(bookAddress(owner)), "the owner's book");
      const callId = Number(d.readBigUInt64LE(8)), hash = d.subarray(16, 48), horizon = d.readUInt32LE(48);
      this.beforeLock?.(owner);
      if (hash.equals(Buffer.alloc(32))) throw perr("EmptyCall");
      if (horizon % 60 || horizon < 300 || horizon > 2_592_000) throw perr("BadHorizon");
      const b = this.get(book) ?? { owner, lockCount: 0, openedAt: this.now, fresh: true };
      if (callId !== b.lockCount) throw perr("StaleId");
      assert.ok(call.equals(callAddress(book, callId)), "the call's address");
      const entryAt = Math.ceil((this.now + 60) / 60) * 60;
      this.put(book, encBook({ owner, lockCount: b.lockCount + 1, openedAt: b.openedAt }));
      this.put(call, encCall({ book, callId, callHash: Buffer.from(hash), lockedAt: this.now, entryAt, horizon, revealed: false }));
      logs.push(event("Locked", book.toBuffer(), owner.toBuffer(), u64(callId), hash, i64(this.now), i64(entryAt), u32(horizon)));
      return;
    }
    if (tag === disc("global", "reveal").toString("hex")) {
      const [revealer, book, call] = k;
      assert.ok(signers.has(revealer.toBase58()));
      const c = this.get(call);
      const n = d.readUInt32LE(8), coin = d.subarray(12, 12 + n).toString("utf8"), side = d.readInt8(12 + n), salt = d.subarray(13 + n, 45 + n);
      if (c.revealed) throw perr("AlreadyRevealed");
      const exit = c.entryAt + c.horizon;
      if (this.now < exit) throw perr("RevealTooEarly");
      if (this.now > exit + GRACE) throw perr("RevealExpired");
      const want = callHash({ book, callId: c.callId, horizon: c.horizon, coin, side, salt });
      if (!want.equals(Buffer.from(c.callHash))) throw perr("WrongPreimage");
      this.put(call, encCall({ ...c, revealed: true, coin, side, revealedAt: this.now }));
      const owner = this.get(book).owner;
      logs.push(event("Revealed", book.toBuffer(), owner.toBuffer(), u64(c.callId), str(coin), i8(side), u32(c.horizon), salt, i64(this.now)));
      return;
    }
    if (tag === disc("global", "set_profile").toString("hex")) {
      const [owner, payer, profile] = k;
      assert.ok(signers.has(owner.toBase58()) && signers.has(payer.toBase58()));
      let at = 8;
      const s = () => { const n = d.readUInt32LE(at); const v = d.subarray(at + 4, at + 4 + n).toString("utf8"); at += 4 + n; return v; };
      const name = s(), bio = s(), link = s();
      this.put(profile, encProfile({ owner, name, bio, link, updatedAt: this.now }));
      return;
    }
    throw new Error("unknown instruction");
  }
}

/** A relayer like /api/solana/relay: fee payer, co-signs, simulates, sends. Also a copier endpoint. */
function mockFetch(chain, relayer, { copier } = {}) {
  const calls = { get: 0, posts: [], copier: [] };
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetch = async (url, init = {}) => {
    if (url === `${RELAY}/api/solana/relay`) {
      if ((init.method ?? "GET") === "GET") {
        calls.get++;
        chain.onRelayGet?.(); // between the SDK's read of lockCount and its transaction
        return json(200, { feePayer: relayer.publicKey.toBase58(), blockhash: chain.blockhash, lastValidBlockHeight: 1000 });
      }
      const tx = Transaction.from(Buffer.from(JSON.parse(init.body).tx, "base64"));
      calls.posts.push(tx);
      assert.ok(tx.feePayer.equals(relayer.publicKey), "the relayer pays");
      assert.equal(tx.signatures.find((s) => s.publicKey.equals(relayer.publicKey)).signature, null, "the relayer's slot comes empty");
      tx.partialSign(relayer);
      const sim = chain.process(tx, { commit: false });
      if (sim.err) return json(400, { error: "Transaction simulation failed: Error processing Instruction 0", logs: sim.logs });
      return json(200, { signature: chain.process(tx).signature });
    }
    if (copier && url === `${copier.url}/preimage`) {
      calls.copier.push(JSON.parse(init.body));
      if (copier.fail) throw new Error("connect ECONNREFUSED");
      return json(copier.status ?? 200, {});
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, calls };
}

function setup({ selfPay = false, copier, journal, keypair = Keypair.generate(), validator, chain = new MockChain() } = {}) {
  const relayer = Keypair.generate();
  const { fetch, calls } = mockFetch(chain, relayer, { copier });
  const logs = [];
  const client = new SolanaCallbookClient({
    network: "solana-devnet", keypair, connection: chain, relayUrl: RELAY, selfPay, fetch, markets: markets(),
    journal: journal ?? false, now: () => chain.now, log: (m) => logs.push(m), copier, validator,
  });
  return { client, chain, relayer, calls, logs, keypair };
}

/** The salt derivation, written out independently of the SDK. */
function expectedSalt(kp, book, callId) {
  const secret = createHmac("sha256", Buffer.from(kp.secretKey).toString("hex")).update("arena solana salt secret v1").digest("hex");
  return `0x${createHmac("sha256", secret).update(`solana:${PID.toBase58()}:${book.toBase58()}:lock:${callId}`).digest("hex")}`;
}

const secretForms = (kp) => [
  bs58.encode(kp.secretKey), Buffer.from(kp.secretKey).toString("hex"), Buffer.from(kp.secretKey).toString("base64"),
  JSON.stringify(Array.from(kp.secretKey)), Array.from(kp.secretKey).join(","), Buffer.from(kp.secretKey.subarray(0, 32)).toString("hex"),
  bs58.encode(kp.secretKey.subarray(0, 32)),
];

// ------------------------------------------------------------------ choosing the backend

describe("choosing Solana", () => {
  test("network solana-devnet gives the Solana client through either entry point", () => {
    const kp = Keypair.generate();
    const a = new CallbookClient({ network: "solana-devnet", keypair: kp, journal: false, connection: new MockChain() });
    const b = createCallbookClient({ network: "solana-devnet", keypair: kp, journal: false, connection: new MockChain() });
    assert.ok(a instanceof SolanaCallbookClient && b instanceof SolanaCallbookClient);
    assert.equal(a.address, kp.publicKey.toBase58());
    assert.equal(a.book.toBase58(), bookAddress(kp.publicKey).toBase58());
    // Arc is unchanged.
    const arc = new CallbookClient({ network: "local", key: `0x${"59".repeat(32)}`, address: "0x0000000000000000000000000000000000000001", journal: false });
    assert.ok(arc instanceof CallbookClient && !arc.solana);
  });
});

// ------------------------------------------------------------------ locking

describe("lock", () => {
  test("builds the lock instruction and hash, partially signed, with the relayer paying", async () => {
    const { client, chain, relayer, calls, keypair, logs } = setup();
    const r = await client.lock({ coin: "eth", side: "long", horizon: "4h" });
    assert.equal(calls.posts.length, 1);
    const tx = calls.posts[0];
    assert.equal(tx.instructions.length, 1);
    const ix = tx.instructions[0];
    const book = bookAddress(keypair.publicKey);
    assert.ok(ix.programId.equals(PID));
    assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
      [keypair.publicKey.toBase58(), true, false],
      [relayer.publicKey.toBase58(), true, true],
      [book.toBase58(), false, true],
      [callAddress(book, 0).toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
    ]);
    const salt = expectedSalt(keypair, book, 0);
    const hash = callHash({ book, callId: 0, horizon: 4 * 3600, coin: "ETH", side: 1, salt });
    assert.deepEqual(ix.data, Buffer.concat([disc("global", "lock"), u64(0), hash, u32(4 * 3600)]));
    assert.ok(Buffer.from(chain.get(callAddress(book, 0)).callHash).equals(hash));

    assert.equal(r.callId, 0);
    assert.equal(r.coin, "ETH");
    assert.equal(r.side, "long");
    assert.equal(r.openedBook, true);
    assert.equal(r.gasless, true);
    assert.equal(r.entryAt, T0 + 60);
    assert.equal(r.revealAt, T0 + 60 + 4 * 3600);
    assert.equal(r.explorer, `https://explorer.solana.com/tx/${r.signature}?cluster=devnet`);
    assert.ok(Number.isInteger(r.latencyMs) && r.latencyMs >= 0);
    assert.match(r.summary, /confirmed in \d+ ms/);
    assert.ok(r.summary.includes(r.explorer));
    assert.match(logs.join("\n"), /lock 0 confirmed in \d+ ms \(gasless\)/);

    const second = await client.lock({ coin: "BTC", side: "short", horizon: "15m" });
    assert.equal(second.callId, 1);
    assert.equal(second.openedBook, false);
  });

  test("self-pay: the key is the fee payer and sends directly", async () => {
    const { client, chain, calls, keypair } = setup({ selfPay: true });
    const r = await client.lock({ coin: "SOL", side: "short", horizon: "1h" });
    assert.equal(calls.posts.length + calls.get, 0, "the relayer isn't used");
    assert.equal(r.gasless, false);
    const { tx } = chain.sent[0];
    assert.ok(tx.feePayer.equals(keypair.publicKey));
    assert.ok(tx.instructions[0].keys[1].pubkey.equals(keypair.publicKey), "the owner pays rent too");
  });

  test("a lock that loses its call id to another lock re-reads the count and retries once", async () => {
    const { client, chain, calls, keypair } = setup();
    const book = bookAddress(keypair.publicKey);
    let raced = false;
    chain.onRelayGet = () => {
      if (raced) return;
      raced = true; // another process's lock lands first
      chain.put(book, encBook({ owner: keypair.publicKey, lockCount: 1, openedAt: chain.now }));
      chain.put(callAddress(book, 0), encCall({ book, callId: 0, callHash: Buffer.alloc(32, 1), lockedAt: chain.now, entryAt: chain.now + 60, horizon: 300 }));
    };
    // The first attempt read lockCount 0, then loses id 0 at execution (the relayer's simulation refuses it).
    const r = await client.lock({ coin: "ETH", side: "long", horizon: "1h" });
    assert.equal(calls.posts.length, 2);
    assert.equal(r.callId, 1);
    const hash = callHash({ book, callId: 1, horizon: 3600, coin: "ETH", side: 1, salt: expectedSalt(keypair, book, 1) });
    assert.ok(Buffer.from(chain.get(callAddress(book, 1)).callHash).equals(hash), "rehashed for the new id");
  });

  test("a StaleId that persists (or arrives on the self-pay path) is reported, after one retry", async () => {
    const { client, chain } = setup({ selfPay: true });
    chain.beforeLock = () => { throw perr("StaleId"); };
    await assert.rejects(client.lock({ coin: "ETH", side: "long", horizon: "1h" }), (e) => e.code === "StaleId" && /got there first/.test(e.message));
    assert.equal(chain.sent.length, 2, "tried twice");
  });

  test("refusals: a bad side, horizon, coin or someone else's book", async () => {
    const { client } = setup();
    await assert.rejects(client.lock({ coin: "ETH", side: "flat" }), /long or short/);
    await assert.rejects(client.lock({ coin: "ETH", side: "long", horizon: "61.5m" }), /whole number of minutes/);
    await assert.rejects(client.lock({ coin: "ETH", side: "long", horizon: "31d" }), /between 5m and 30d/);
    await assert.rejects(client.lock({ coin: "NOPE", side: "long" }), /no perp called/);
    await assert.rejects(client.lock({ coin: "ETH", side: "long", book: Keypair.generate().publicKey.toBase58() }), /one book/);
    await assert.rejects(client.seal({ book: 1, coin: "ETH", side: "long" }), (e) => e.code === "NotOnSolana");
  });
});

// ------------------------------------------------------------------ revealing

describe("reveal_due", () => {
  test("reveals only due calls, with the preimage the program checks", async () => {
    const { client, chain, keypair } = setup();
    await client.lock({ coin: "ETH", side: "long", horizon: "5m" });     // 0
    await client.lock({ coin: "BTC", side: "short", horizon: "1h" });    // 1
    await client.lock({ coin: "SOL", side: "long", horizon: "1d" });     // 2
    const early = await client.revealDue();
    assert.equal(early.revealed.length, 0);
    assert.equal(early.waiting.length, 3);
    assert.deepEqual(early.waiting.map((w) => w.coin), ["ETH", "BTC", "SOL"]);

    chain.now = T0 + 60 + 3600; // 0 and 1 matured, 2 not
    const before = chain.sent.length;
    const r = await client.revealDue();
    assert.deepEqual(r.revealed.map((x) => [x.callId, x.coin, x.side]), [[0, "ETH", "long"], [1, "BTC", "short"]]);
    assert.deepEqual(r.waiting.map((x) => x.callId), [2]);
    assert.equal(r.failed.length, 0);
    assert.equal(chain.sent.length - before, 2, "one transaction per due call");
    assert.ok(chain.sent.slice(before).every((s) => s.err === null));
    for (const x of r.revealed) assert.equal(x.explorer, `https://explorer.solana.com/tx/${x.signature}?cluster=devnet`);
    const book = bookAddress(keypair.publicKey);
    assert.equal(chain.get(callAddress(book, 0)).coin, "ETH");
    assert.equal(chain.get(callAddress(book, 1)).side, -1);
    assert.equal(chain.get(callAddress(book, 2)).revealed, false);
    // Running again does nothing new.
    const again = await client.revealDue();
    assert.equal(again.revealed.length, 0);
  });

  test("a call past the reveal window is reported, not sent", async () => {
    const { client, chain } = setup();
    await client.lock({ coin: "ETH", side: "long", horizon: "5m" });
    chain.now = T0 + 60 + 300 + GRACE + 1;
    const before = chain.sent.length;
    const r = await client.revealDue();
    assert.equal(r.expired.length, 1);
    assert.equal(r.revealed.length, 0);
    assert.equal(chain.sent.length, before);
  });

  test("without the journal, a call is recovered from its hash with the derived salt", async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "arena-sol-j-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const keypair = Keypair.generate();
    const chain = new MockChain();
    const a = setup({ keypair, chain, journal: path.join(dir, "j.json") });
    await a.client.lock({ coin: "HYPE", side: "short", horizon: "10m" });
    chain.now = T0 + 60 + 600;
    const b = setup({ keypair, chain }); // another machine: same key, no journal
    const r = await b.client.revealDue();
    assert.deepEqual(r.revealed.map((x) => [x.coin, x.side]), [["HYPE", "short"]]);
  });

  test("a stop and a target ride in the salt, survive to the reveal, and need the journal", async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "arena-sol-x-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const keypair = Keypair.generate();
    const chain = new MockChain();
    const { client, calls } = setup({ keypair, chain, journal: path.join(dir, "j.json") });
    const r = await client.lock({ coin: "ETH", side: "long", horizon: "1h", stop: 95, target: "110" });
    assert.equal(r.stop, "95");
    assert.equal(r.target, "110");
    const book = bookAddress(keypair.publicKey);
    const salt = withExits(expectedSalt(keypair, book, 0), { stop: "95", target: "110" });
    assert.deepEqual(exitsOf(salt), { stop: { value: exitsOf(salt).stop.value, text: "95" }, target: { value: exitsOf(salt).target.value, text: "110" } });
    const hash = callHash({ book, callId: 0, horizon: 3600, coin: "ETH", side: 1, salt });
    assert.ok(calls.posts[0].instructions[0].data.subarray(16, 48).equals(hash), "the hash commits to the exits");

    chain.now = T0 + 60 + 3600;
    // Another machine without the journal can't find it: the exits aren't searchable.
    const other = setup({ keypair, chain });
    const miss = await other.client.revealDue();
    assert.equal(miss.failed.length, 1);
    assert.equal(miss.revealed.length, 0);
    // This machine reveals it, and the Revealed event's salt carries the stop and target.
    const done = await client.revealDue();
    assert.equal(done.revealed.length, 1);
    const sig = done.revealed[0].signature;
    const ixData = chain.txs.get(sig).tx.instructions[0].data;
    assert.ok(ixData.subarray(ixData.length - 32).equals(saltBytes(salt)));
    const v = await client.verify();
    assert.equal(v.checked.length, 1);
    assert.equal(v.match, true);
  });
});

// ------------------------------------------------------------------ status, verify, profile

describe("status, verify and profile", () => {
  test("status counts and countdowns; verify checks every reveal against its lock; Score accounts are read", async () => {
    const validator = Keypair.generate().publicKey;
    const { client, chain, keypair } = setup({ validator });
    assert.match((await client.status()).summary, /no book yet/);
    await client.lock({ coin: "ETH", side: "long", horizon: "5m" });
    await client.lock({ coin: "BTC", side: "long", horizon: "2h" });
    chain.now = T0 + 60 + 300;
    let st = await client.status();
    assert.equal(st.calls, 2);
    assert.equal(st.due.length, 1);
    assert.equal(st.pending.length, 1);
    assert.match(st.summary, /arena_reveal_due/);
    await client.revealDue();
    const book = bookAddress(keypair.publicKey);
    chain.put(scoreAddress(validator, book), encScore({ validator, book, owner: keypair.publicKey, score: 61, calls: 2, revealed: 1, withheld: 0, throughCall: 1, scoredAt: chain.now }));
    st = await client.status();
    assert.equal(st.revealed, 1);
    assert.equal(st.score.score, 61);
    const v = await client.verify({ book: keypair.publicKey.toBase58() }); // by owner
    assert.equal(v.book, book.toBase58());
    assert.equal(v.checked.length, 1);
    assert.equal(v.mismatched.length, 0);
    assert.equal(v.posted.score, 61);
    assert.equal((await client.verify({ book: book.toBase58() })).checked.length, 1, "by book address");
    const mine = await client.myBooks();
    assert.equal(mine.books[0].calls, 2);
  });

  test("profile: set gasless, then read back", async () => {
    const { client, chain, keypair } = setup();
    const r = await client.setProfile({ name: "Night Owl", bio: "momentum", link: "https://x.com/owl" });
    assert.equal(r.name, "Night Owl");
    assert.match(r.explorer, /cluster=devnet$/);
    assert.equal(chain.get(profileAddress(keypair.publicKey)).name, "Night Owl");
    const p = await client.profile();
    assert.equal(p.profile.name, "Night Owl");
    await assert.rejects(client.setProfile({ name: "x" }), /at least 3/);
  });
});

// ------------------------------------------------------------------ copy-trading hook

describe("copier", () => {
  test("after a lock, the sealed preimage goes to the copier and matches the on-chain hash", async () => {
    const keys = generateRecipientKeys();
    const copier = { url: "http://copier.test", publicKey: keys.publicKey };
    const { client, chain, calls, keypair } = setup({ copier });
    const r = await client.lock({ coin: "ETH", side: "short", horizon: "30m", stop: "120" });
    assert.equal(r.copier, "sent");
    assert.equal(calls.copier.length, 1);
    const post = calls.copier[0];
    assert.equal(post.signature, r.signature);
    assert.ok(!JSON.stringify(post).includes("ETH"), "only the box carries the call");
    const pre = openBox(post.box, keys.privateKey);
    assert.deepEqual(Object.keys(pre).sort(), ["book", "callId", "coin", "exits", "horizon", "owner", "program", "salt", "side"]);
    assert.equal(pre.owner, keypair.publicKey.toBase58());
    const onChain = chain.get(callAddress(new PublicKey(pre.book), pre.callId)).callHash;
    assert.ok(callHash({ programId: pre.program, book: pre.book, callId: pre.callId, horizon: pre.horizon, coin: pre.coin, side: pre.side, salt: pre.salt }).equals(Buffer.from(onChain)));
    assert.equal(exitsOf(pre.salt).stop.text, "120");
  });

  test("a copier failure never fails the lock, and the warning holds no secrets", async () => {
    const keys = generateRecipientKeys();
    for (const c of [{ fail: true }, { status: 500 }]) {
      const copier = { url: "http://copier.test", publicKey: keys.publicKey, ...c };
      const { client, logs, keypair } = setup({ copier });
      const r = await client.lock({ coin: "BTC", side: "long", horizon: "1h" });
      assert.equal(r.copier, "failed");
      const warn = logs.find((l) => /warning/.test(l));
      assert.match(warn, /copier/);
      for (const s of secretForms(keypair)) assert.ok(!warn.includes(s));
      assert.ok(!warn.includes(client.lockSalt(0).slice(2)), "nor the salt");
    }
  });
});

// ------------------------------------------------------------------ the MCP server

async function connect(client, keyFile) {
  const server = createCallbookMcpServer({ client, keyFile });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test-agent", version: "1.0.0" });
  await Promise.all([server.connect(b), mcp.connect(a)]);
  return mcp;
}

describe("the MCP server on Solana", () => {
  let env;
  beforeEach(() => { env = setup({ copier: { url: "http://copier.test", publicKey: generateRecipientKeys().publicKey } }); });

  test("the tool names are identical on Arc and Solana", async () => {
    const arc = new CallbookClient({ network: "local", key: `0x${"59".repeat(32)}`, address: "0x0000000000000000000000000000000000000001", journal: false, markets: markets() });
    const [m1, m2] = [await connect(arc, null), await connect(env.client, "/tmp/k.json")];
    const names = async (m) => (await m.listTools()).tools.map((x) => x.name).sort();
    const a = await names(m1), s = await names(m2);
    assert.deepEqual(s, a);
    assert.ok(a.includes("arena_lock") && a.includes("arena_reveal_due") && a.includes("arena_verify") && a.includes("arena_profile"));
    assert.deepEqual((await m2.listPrompts()).prompts.map((p) => p.name).sort(), (await m1.listPrompts()).prompts.map((p) => p.name).sort());
    await m1.close();
    await m2.close();
  });

  test("every tool's output (and the logs) leaves out the secret key", async () => {
    const { client, chain, keypair, logs } = env;
    const mcp = await connect(client, "/home/agent/.arena/solana-keypair.json");
    const texts = [];
    const callTool = async (name, args = {}) => {
      const res = await mcp.callTool({ name, arguments: args });
      texts.push(...res.content.map((c) => c.text));
      return res;
    };
    const lock = await callTool("arena_lock", { coin: "ETH", side: "long", horizon: "5m", stop: 90 });
    assert.ok(!lock.isError, lock.content[0].text);
    assert.match(lock.content[0].text, /explorer\.solana\.com\/tx\/.+\?cluster=devnet/);
    assert.match(lock.content[0].text, /confirmed in \d+ ms/);
    chain.now = T0 + 60 + 300;
    const rev = await callTool("arena_reveal_due");
    assert.equal(JSON.parse(rev.content.at(-1).text).revealed.length, 1);
    await callTool("arena_status");
    await callTool("arena_status", { book: client.book.toBase58() });
    const ver = await callTool("arena_verify", {});
    assert.ok(!ver.isError, ver.content[0].text);
    await callTool("arena_verify", { book: keypair.publicKey.toBase58() });
    await callTool("arena_my_books");
    const acct = await callTool("arena_account");
    assert.match(acct.content[0].text, /solana-keypair\.json/);
    assert.ok(acct.content[0].text.includes(keypair.publicKey.toBase58()));
    await callTool("arena_markets", { limit: 3 });
    await callTool("arena_profile", { name: "Night Owl" });
    await callTool("arena_profile");
    await callTool("arena_open", { kind: "calls" });
    for (const name of ["arena_seal", "arena_link_wallet", "arena_unlink_wallet"]) {
      const args = name === "arena_seal" ? { book: client.book.toBase58(), coin: "ETH", side: "long" } : name === "arena_link_wallet" ? { wallet: `0x${"ab".repeat(20)}`, confirmed: true } : {};
      const res = await callTool(name, args);
      assert.ok(res.isError, `${name} refuses on Solana`);
    }
    const all = [...texts, ...logs, JSON.stringify(client), inspect(client, { depth: 6 })].join("\n");
    for (const s of secretForms(keypair)) assert.ok(!all.includes(s), "the secret key never appears");
    await mcp.close();
  });
});
