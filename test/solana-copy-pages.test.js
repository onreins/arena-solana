// The Copy flow and the Following page: their files exist and parse, and the
// built bundle (npm run build:solana-copy) loads in a browser-like sandbox and
// builds the same instruction as the source module. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { Keypair, PublicKey } from "@solana/web3.js";

import * as vel from "../app/client/solana-velocity-browser.js";
import * as web from "../app/client/solana-follow-browser.js";

const pub = (p) => new URL(`../app/public/${p}`, import.meta.url);

test("each page's scripts and styles exist, and the page scripts parse", () => {
  for (const page of ["arena-following.html", "arena-caller.html"]) {
    const html = readFileSync(pub(page), "utf8");
    const refs = [...html.matchAll(/(?:src|href)="\/([\w.-]+\.(?:js|css))"/g)].map((m) => m[1]);
    assert.ok(refs.includes("solana-copy-ui.js") && refs.includes("solana-copy.css"), page);
    for (const r of refs) assert.ok(existsSync(pub(r)), `${page} -> ${r}`);
  }
  for (const f of ["solana-copy-ui.js", "callbook-copy.js", "callbook-following.js"]) new vm.Script(readFileSync(pub(f), "utf8"), { filename: f });
  const following = readFileSync(pub("arena-following.html"), "utf8");
  assert.match(following, /Not investment advice/);
  const ui = readFileSync(pub("solana-copy-ui.js"), "utf8");
  assert.match(ui, /never withdraw|ever withdrawing/);
  assert.match(ui, /may be regulated in some countries/);
});

test("the bundle loads as window.ReinsSolanaCopy and matches the source modules", () => {
  const file = pub("vendor/solana-copy.js");
  assert.ok(existsSync(file), "run npm run build:solana-copy");
  const ctx = { console, TextEncoder, TextDecoder, crypto: globalThis.crypto, setTimeout, clearTimeout, URL, addEventListener() {}, dispatchEvent() {}, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } } };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(file, "utf8"), ctx);
  const R = ctx.ReinsSolanaCopy;
  for (const fn of ["init", "readPlan", "readVelocity", "velocitySetupIxs", "depositIxs", "subscribeIxs", "stopIxs", "revokeIxs", "following", "send", "wallets", "connect", "explorerTx"]) {
    assert.equal(typeof R[fn], "function", fn);
  }
  const a = Keypair.generate().publicKey.toBase58(), c = Keypair.generate().publicKey.toBase58();
  const fromBundle = R.velocity.updateUserDelegateIx({ authority: a, subAccountId: 3, delegate: c });
  const fromSource = vel.updateUserDelegateIx({ authority: a, subAccountId: 3, delegate: c });
  assert.equal(Buffer.from(fromBundle.data).toString("hex"), Buffer.from(fromSource.data).toString("hex"));
  assert.equal(fromBundle.keys[0].pubkey.toBase58(), fromSource.keys[0].pubkey.toBase58());
  const plan = web.planAddress(Keypair.generate().publicKey, a);
  assert.equal(Buffer.from(R.follow.stopIx({ follower: a, plan: plan.toBase58() }).data).toString("hex"), Buffer.from(web.stopIx({ follower: a, plan }).data).toString("hex"));
  assert.equal(R.explorerTx("abc"), "https://explorer.solana.com/tx/abc?cluster=devnet");
});

test("the Copy flow's transactions are what the page promises", () => {
  const follower = Keypair.generate().publicKey, agent = Keypair.generate().publicKey, copier = Keypair.generate().publicKey;
  const followConfig = Keypair.generate().publicKey;
  // The bundle entry is ESM too: import it through the source to check the composed instruction lists.
  return import("../app/client/solana-copy.js").then((S) => {
    const ctx = S.init({ rpc: "http://127.0.0.1:9", followConfig: followConfig.toBase58(), copier: copier.toBase58() });
    // A wallet new to Velocity: stats, main #0, copy #1, delegate.
    const v = { plan: vel.planCopyAccount({ stats: null, copier }), state: { whitelistMint: PublicKey.default } };
    const setup = S.velocitySetupIxs(ctx, follower, v);
    assert.deepEqual(setup.map((ix) => [...ix.data.subarray(0, 8)]), [vel.VELOCITY_IX.initialize_user_stats, vel.VELOCITY_IX.initialize_user, vel.VELOCITY_IX.initialize_user, vel.VELOCITY_IX.update_user_delegate]);
    assert.equal(setup[3].data.readUInt16LE(8), 1);
    assert.equal(new PublicKey(setup[3].data.subarray(10, 42)).toBase58(), copier.toBase58());
    // Subscribe: ATA, subscribe at the terms seen, then the optional allowance to the Follow PDA.
    const config = { mint: web.DEVNET_USDC, treasury: Keypair.generate().publicKey };
    const plan = { payout: Keypair.generate().publicKey, price: 9_990_000n, perfFeeBps: 1500 };
    const settings = { sizeMode: 0, sizeValue: 25_000_000n, maxTrade: 100_000_000n, maxOpen: 3, dailyLossCap: 50_000_000n, subAccountId: 1 };
    const ixs = S.subscribeIxs(ctx, { follower, agent, config, plan, months: 2, settings, perfAllowance: 5_000_000n });
    assert.equal(ixs.length, 3);
    assert.equal(ixs[0].programId.toBase58(), web.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    const sub = ixs[1].data;
    assert.equal(sub.readBigUInt64LE(sub.length - 10), 9_990_000n, "max price = the price shown");
    assert.equal(sub.readUInt16LE(sub.length - 2), 1500, "max fee = the fee shown");
    const followPda = web.followAddress(web.planAddress(followConfig, agent), follower);
    assert.equal(ixs[2].keys[1].pubkey.toBase58(), followPda.toBase58(), "the allowance goes to the follower's own Follow account");
    assert.equal(S.subscribeIxs(ctx, { follower, agent, config, plan, months: 1, settings }).length, 2, "no allowance unless asked");
    // Stop: the follow program's stop, and revoking the delegate (PublicKey.default).
    const revoke = S.revokeIxs(ctx, follower, 1)[0];
    assert.equal(new PublicKey(revoke.data.subarray(10, 42)).toBase58(), PublicKey.default.toBase58());
    assert.deepEqual([...S.stopIxs(ctx, follower, web.planAddress(followConfig, agent))[0].data], web.IX_DISCRIMINATORS.stop);
  });
});
