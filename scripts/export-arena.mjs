/**
 * Export Arena as its own public repository (github.com/onreins/arena).
 *
 *   node scripts/export-arena.mjs <target-dir>
 *
 * Copies exactly the files Arena needs (the contract, the scoring engine, the
 * API, the pages, the SDK and MCP, the runner, scripts, tests and docs), writes
 * the few files that differ in the standalone repo (scripts/arena-public/:
 * server, package.json, README; and here: LICENSE, .gitignore, .env.example,
 * CI), trims the shared test helpers and mocks down to what Arena uses, then
 * refuses to finish if anything looks like a secret.
 *
 * The target's existing files are overwritten; anything else in it (its .git
 * folder, node_modules) is left alone. Run it again after Arena changes, then
 * commit in the target.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "scripts", "arena-public");
const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/export-arena.mjs <target-dir>");
  process.exit(1);
}
const OUT = path.resolve(target);
if (OUT === ROOT || OUT.startsWith(ROOT + path.sep)) {
  console.error("the target must be outside this repository");
  process.exit(1);
}

const list = (dir, re) => (existsSync(path.join(ROOT, dir)) ? readdirSync(path.join(ROOT, dir)).filter((f) => re.test(f)).map((f) => `${dir}/${f}`) : []);

const FILES = [
  "contracts/Callbook.sol",
  "hardhat.config.cjs",
  "app/callbook-routes.js",
  "app/arena-auth-routes.js",
  "scripts/circle-client.js",
  "scripts/shims/jwt-decode.js",
  "app/client/callbook-crypto.js",
  "evaluator/abi.js",
  ...list("app/verify", /^(arena-.*|callbook.*|scoring)\.js$|^NOTICE$/),
  ...list("callbook", /\.js$/),
  "runner/callbook.js",
  "runner/callbook-agents.js",
  ...["artifact.js", "compile.js", "cli-flags.js", "deploy-callbook.js", "callbook-setup.js", "callbook-setup-lib.js", "callbook-verify.js",
    "callbook-replay.js", "callbook-sample-callers.js", "callbook-local-chain.js", "build-reins-mcp.mjs"].map((f) => `scripts/${f}`),
  "packages/reins-mcp/README.md",
  "packages/reins-mcp/NOTICE",
  "packages/reins-mcp/package.json",
  ...list("deployments", /^callbook-(testnet|mainnet)(-v\d+|-books)?\.json$/),
  ...list("test", /^(callbook.*|arena-.*)\.test\.js$/),
  "test/fixtures/IdentityRegistry8004.sol",
  ...["CALLBOOK.md", "CALLBOOK-MCP.md", "CALLBOOK-RUNBOOK.md", "CALLBOOK-IDENTITY-PLAN.md", "ARENA-PROFILES-PLAN.md"].map((f) => `docs/${f}`),
  // The pages, their scripts and styles, and the data they show.
  ...list("app/public", /^arena.*\.html$|^callbook.*\.(js|css)$/),
  ...["app.css", "home.css", "ui.js", "wallet.js", "fx.js", "favicon.svg", "vendor/callbook-crypto.js",
    "auth.js", "auth.css", "circle-auth.js", "vendor/circle-wallets.js"].map((f) => `app/public/${f}`),
  ...list("app/public/data", /^callbook.*\.json$/),
  ...list("app/public/tokens", /\.svg$/),
  ...list("app/public/arena/agents", /\.json$/),
];

const copied = [];
function put(rel, content) {
  const dest = path.join(OUT, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  if (content === undefined) cpSync(path.join(ROOT, rel), dest);
  else writeFileSync(dest, content);
  copied.push(rel);
}
const source = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const cut = (text, from, to) => {
  const a = text.indexOf(from);
  const b = to ? text.indexOf(to, a + 1) : text.length;
  if (a < 0 || b < 0) throw new Error(`export: marker not found: ${from.slice(0, 60)}`);
  return text.slice(a, b);
};

mkdirSync(OUT, { recursive: true });
for (const rel of FILES) {
  if (!existsSync(path.join(ROOT, rel))) throw new Error(`export: ${rel} is missing`);
  put(rel);
}

// The standalone server, package.json and README.
put("app/server.js", readFileSync(path.join(TEMPLATES, "server.js"), "utf8"));
put("package.json", readFileSync(path.join(TEMPLATES, "package.json"), "utf8"));
put("README.md", readFileSync(path.join(TEMPLATES, "README.md"), "utf8"));
// Screenshots for the README, taken from app.reins.one.
for (const img of readdirSync(path.join(TEMPLATES, "images")).filter((f) => /\.(png|jpg|gif|webp)$/.test(f))) {
  const dest = path.join(OUT, "docs", "images", img);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(path.join(TEMPLATES, "images", img), dest);
}

// The test rig without the Reins vault the Arena tests never touch.
const helpers = source("test/helpers.js")
  .replace(" * Test rig: a local node, a freshly deployed vault, and funded actors.", " * Test rig: a local node and funded actors.")
  .replace('import { VAULT_ABI, VAULT_BYTECODE } from "../src/vault.js";\n', "")
  .replace(cut(source("test/helpers.js"), "/** Deploy a fresh vault", "/** Mine `n` blocks"), "")
  .replace('name: "Ratchet Local"', 'name: "Arena Local"');
if (/vault/i.test(helpers.replace(/^\s*\*.*$/gm, ""))) throw new Error("export: test/helpers.js still mentions the vault");
put("test/helpers.js", helpers);

// The ERC-8004 registry mocks and the contract wallet, out of the shared Mocks.sol.
const mocks = source("contracts/Mocks.sol");
put("contracts/ArenaMocks.sol", [
  "// SPDX-License-Identifier: MIT",
  "pragma solidity 0.8.28;",
  "",
  "/**",
  " * Test scaffolding for a local node; nothing here ships. The ERC-8004",
  " * registries (v2.0.0) are live on Arc testnet and mainnet, and these mocks copy",
  " * the reference behaviour, so local tests fail the way the real ones would.",
  " */",
  "",
  cut(mocks, "// ---------------------------------------------------------------------------\n// ERC-8004: IdentityRegistry", "// ---------------------------------------------------------------------------\n// A hostile ERC-8183 hook").trimEnd(),
  "",
  cut(mocks, "// ---------------------------------------------------------------------------\n// ERC-1271").trimEnd(),
  "",
].join("\n"));

put("LICENSE", `MIT License

Copyright (c) 2026 Reins

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);
// (The Vanta Network port's own MIT notice is app/verify/NOTICE; the README credits it.
// LICENSE stays the plain MIT text so GitHub recognises it.)

put(".gitignore", `node_modules/
build/
packages/reins-mcp/dist/
.env
.env.*
!.env.example
deployments/callbook-local*
app/data/
*.log
`);

put(".env.example", `# Arena settings. Copy to .env and fill in what you use; never commit .env.
# Every ARENA_X is also read as CALLBOOK_X.

# Which Arena to read: local, testnet or mainnet. Unset, the pages show the replay export.
ARENA_NETWORK=testnet
# A dedicated RPC (the public one rate-limits) and the contract's deploy block.
ARENA_RPC=
ARENA_FROM_BLOCK=
# The validator whose ERC-8004 responses count as Arena scores.
ARENA_VALIDATOR=

# Gasless calls and names: the relayer's key (a wallet used only for this) and its daily budget.
ARENA_RELAYER_KEY=
ARENA_RELAYER_DAILY_USDC=5
# Shared rate limits for the relayer (Vercel KV or Upstash Redis).
KV_REST_API_URL=
KV_REST_API_TOKEN=
# Behind one proxy (Vercel), so rate limits see each visitor's address.
TRUST_PROXY=

# Google sign-in through Circle user-controlled wallets (off until all three are set).
CIRCLE_API_KEY=
CIRCLE_APP_ID=
GOOGLE_CLIENT_ID=

# Deploying, setup and the runner (scripts/deploy-callbook.js, callbook-setup.js, runner/callbook.js).
CALLBOOK_DEPLOYER_KEY=
CALLBOOK_OWNER_KEY=
CALLBOOK_AGENT_KEY=
CALLBOOK_VALIDATOR_KEY=
CALLBOOK_SALT_SECRET=
CALLBOOK_REPORT_BASE=https://app.reins.one
`);

put(".github/workflows/test.yml", `name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      - run: npm run build
      - name: Local chains (the contract, engine, setup and SDK tests each use one)
        run: |
          for port in 8545 8546 8547 8548; do npx hardhat node --port $port > /dev/null 2>&1 & done
          for port in 8545 8546 8547 8548; do
            for i in $(seq 1 60); do
              curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' http://127.0.0.1:$port > /dev/null && break
              sleep 1
            done
          done
      - run: npm test
`);

// Nothing that looks like a secret goes out. Hardhat's well-known test mnemonic is fine.
const SECRET = [
  { re: /(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, what: "a 32-byte hex value (a key?)" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, what: "a PEM private key" },
  { re: /\b(sk|pk|rk)_(live|test)_[0-9a-zA-Z]{16,}/g, what: "an API key" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, what: "an AWS key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, what: "a GitHub token" },
  { re: /\bnpm_[A-Za-z0-9]{30,}/g, what: "an npm token" },
];
// 32-byte values that are public by nature: tx hashes, typehashes and hashes in
// deployments, data exports and docs. Keys only ever appear in code, so code is checked strictly.
const PUBLIC_HASHES = (rel) => /^(deployments|app\/public\/data|app\/public\/arena|docs)\//.test(rel) || rel.endsWith(".md");
const findings = [];
for (const rel of copied) {
  const full = path.join(OUT, rel);
  if (statSync(full).size > 5_000_000) continue;
  const text = readFileSync(full, "utf8");
  for (const { re, what } of SECRET) {
    for (const m of text.matchAll(re)) {
      if (what.startsWith("a 32-byte") && PUBLIC_HASHES(rel)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      const context = text.split("\n")[line - 1];
      // In code, a named public constant (a typehash, a tag, a storage slot, the secp256k1 order) or a test fixture is public.
      if (what.startsWith("a 32-byte") && (/TYPEHASH|_TAG|_STORAGE|SECP256K1|keccak|salt|hash|Hash|0x0{8}|0xf{8}/.test(context) || rel.startsWith("test/"))) continue;
      findings.push(`${rel}:${line}: ${what}`);
    }
  }
}
if (findings.length) {
  console.error(`export: stopped, these look like secrets:\n  ${findings.join("\n  ")}`);
  process.exit(2);
}
console.log(`exported ${copied.length} files to ${OUT}`);
