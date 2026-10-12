// The pages' shared helpers (app/public/callbook-common.js) link Solana
// accounts and signatures to Solana's explorer and keep base58 case, while
// Arc's links come out exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadCommon() {
  const noop = () => {};
  const document = { addEventListener: noop, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, appendChild: noop }), body: { appendChild: noop }, readyState: "complete" };
  const window = {
    ReinsUI: { esc: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), icon: () => "", identicon: () => "" },
    addEventListener: noop, matchMedia: () => ({ matches: true }),
  };
  const ctx = { window, document, location: { search: "", pathname: "/arena", origin: "http://x" }, URLSearchParams, fetch: () => Promise.reject(new Error("offline")), setTimeout, console };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../app/public/callbook-common.js", import.meta.url), "utf8"), ctx);
  return window.Callbook;
}

const C = loadCommon();
const SOL_OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SOL_SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const ARC = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";

test("Arc links and profile links are unchanged", () => {
  assert.equal(C.profileHref(ARC), `/arena/p/${ARC.toLowerCase()}`);
  const html = C.txLink("https://explorer.testnet.arc.io", `0x${"ab".repeat(32)}`, "tx");
  assert.match(html, new RegExp(`href="https://explorer\\.testnet\\.arc\\.io/tx/0x${"ab".repeat(32)}"`));
  assert.match(C.txLink("https://explorer.arc.io/", ARC, "c", "address"), new RegExp(`href="https://explorer\\.arc\\.io/address/${ARC}"`));
});

test("Solana accounts keep their case, and links go to Solana's explorer with the cluster", () => {
  assert.equal(C.profileHref(SOL_OWNER), `/arena/p/${SOL_OWNER}`);
  assert.ok(C.isAccount(SOL_OWNER) && C.isAccount(ARC));
  assert.ok(!C.isAccount("not an address"));
  const base = "https://explorer.solana.com?cluster=devnet";
  assert.match(C.txLink(base, SOL_SIG, "tx"), new RegExp(`href="https://explorer\\.solana\\.com/tx/${SOL_SIG}\\?cluster=devnet"`));
  assert.match(C.txLink(base, SOL_OWNER, "a", "address"), new RegExp(`href="https://explorer\\.solana\\.com/address/${SOL_OWNER}\\?cluster=devnet"`));
  assert.doesNotMatch(C.txLink(base, "javascript:alert(1)", "x"), /href/);
});
