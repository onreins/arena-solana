# Handoff: Callbook (for the next AI picking this up)

> **Callbook is now called Arena.** Everything people, agents and wallets see says Arena (pages at /arena, tools arena_*, ERC-8004 tags arena-v1 and arena-skill-v1, EIP-712 domain "Arena", settings ARENA_* with CALLBOOK_* still read). Internal names (files, the Callbook contract, /api/callbook) are unchanged.


Written 2026-10-05. Repo: `E:\ratchet` (GitHub `onreins/reinsApp`, **public**).
Branch `feat/app-site-bridge`. Live app: https://app.reins.one (deploys from
`master` via Vercel; push the branch, then `git push origin HEAD:master`).

**Nothing below is committed.** The founder must approve every commit, push,
and any transaction on Arc testnet or mainnet. Never print secrets from `.env`.
No attribution lines in commit messages.

## What Callbook is

A notary for trading agents on Arc (Circle's L1; USDC is gas). Agents seal a
hashed call (coin, long/short/flat) before each period starts, reveal it after
the horizon, and Reins scores the revealed calls with rules ported from Vanta
Network (MIT), then posts each score to Arc's ERC-8004 ValidationRegistry.
Anyone can rebuild any score from chain data + Hyperliquid prices.

Two modes: **strategy books** (a call every period, a skip is a miss) and
**open calls** (lock a call whenever you like, with a horizon). Gasless: people
sign, a Reins relayer submits.

Built for the **DoraHacks Arc Microgrants** (500 USDC; must be deployed and
working on **Arc mainnet**; public repo; deadline **2026-10-14 23:59 ET**).
Arc mainnet's ValidationRegistry had 1 request and 0 responses on 2026-10-05,
so Callbook would be its first working validator (`scripts/erc8004-stats.js`
re-checks this).

"Callbook" is a working name; the founder hasn't chosen (other ideas:
Receipts, Sealed, Tape, Called It).

## Read these first

1. `docs/CALLBOOK.md`: design, rules, score formula, ERC-8004 flow.
2. `docs/CALLBOOK-PLAN.md`: phases, the two modes, the "easy to use" rules.
3. `docs/CALLBOOK-RUNBOOK.md`: exact mainnet go-live steps, keys, costs.
4. `docs/DORAHACKS.md`: the submission text (fill placeholders after deploy).

## State of each piece

| Piece | Files | State |
|---|---|---|
| Contract | `contracts/Callbook.sol` | Done. Strategy books, open calls (`openFree`/`lock`/`revealLocked`), gasless (`lockBySig`/`sealBySig`/`revealLockedSymbol`), `NO_AGENT = 2^256-1`. 48 tests in `test/callbook.test.js` pass |
| ERC-8004 mocks | `contracts/Mocks.sol`, `test/fixtures/IdentityRegistry8004.sol` | Validation mock matches the live v2.0.0. Note: `MockIdentityRegistry` only has `register()`; the fixture matches the real registry (`register(string)`, metadata, `Registered` event) |
| Scoring (Vanta port) | `app/verify/scoring.js`, `app/verify/NOTICE` | Done, 43 tests (`test/verify-scoring.test.js`) |
| Engine v1 | `app/verify/callbook*.js`, `app/callbook-routes.js`, `runner/callbook*.js`, `scripts/callbook-verify.js`, `scripts/callbook-replay.js` | Done for strategy books, 22 tests (`test/callbook-engine.test.js`). API redirects to the static export when no network is configured |
| Engine v2 (callers, relayer, sample callers) | `app/callbook-routes.js` (relay routes), `scripts/callbook-sample-callers.js`, `test/callbook-callers.test.js`, `app/public/data/callbook-caller-*.json` | **Interrupted mid-way.** Relay routes and caller files exist. Check: run its tests, re-run `npm run callbook:replay` to regenerate `app/public/data/callbook*.json` (book ids moved from 1–3 to 5–7; delete stale exports), confirm `baseline: true` on Coin flip / Random caller |
| SDK + MCP | `callbook/` (`sdk.js`, `mcp-server.js`, `relay.js`, `journal.js`, …), `test/callbook-sdk.test.js` | **Interrupted** while writing tests. Finish tests, add `npm run callbook:mcp`, write `docs/CALLBOOK-MCP.md` (copy-paste configs for Claude Desktop, Claude Code, Cursor; one env var `CALLBOOK_KEY`) |
| Go-live kit | `scripts/callbook-setup*.js`, `scripts/deploy-callbook.js`, `scripts/erc8004-stats.js`, `app/public/arena/agents/*.json`, `test/callbook-setup.test.js` | Done, 25 tests; dry-runs against testnet/mainnet work (read-only) |
| Pages | `app/public/callbook.html`, `callbook-book.html`, `callbook.css`, `callbook-common.js`, `callbook-page.js`, `callbook-book.js`; tab added in `ui.js` | Done and polished (leaderboard after explainingmarkets.ai, plain words, "Proof" disclosures, one status pill, Methodology section, phone-ready). "Callers" tab is marked SOON |
| Phone layout, rest of app | `app.css`, `home.css`, `strategy.css`, `smart-money*.{css,js}`, `create.css`, `agent.css`, `charts.css` | Done (375/390/414/768) |

**Update, later on 2026-10-05:** the interrupted work is verified. With local
nodes on 8545 **and** 8546, all Callbook suites pass (callbook, engine,
callers, sdk incl. MCP tools, setup, scoring, evaluator). The replay v2 export
is complete (books 5–7, callers 1–4, `baseline` flags set). The MCP is done:
`npm run callbook:mcp`, docs in `docs/CALLBOOK-MCP.md`. In progress after
that: site v2 (Callers board, Lock a call panel, caller pages) and a security
review of the contract and relayer.

**Update, 2026-10-07:** site v2 (Callers board, caller page, Lock a call
panel) is built in `app/public`. A security review (no critical, 7 HIGH) is
being fixed before mainnet, against this new lock interface:
`lock(bookId, callHash, uint32 horizon, uint64 expectedId)` (reverts
`StaleId` if the call id / nonce moved), `lockBySig(account, callHash, uint32
horizon, deadline, signature)` with
`LockCall(address account,bytes32 callHash,uint32 horizon,uint256 nonce,uint256 deadline)`,
`Locked(…, entryAt, horizon)`, reveals without a horizon argument
(`revealLocked(bookId, callId, coinIndex, side, salt)`,
`revealLockedSymbol(bookId, callId, coin, side, salt)`), lock deadline
`entryAt + horizon + 7d`, and the seal window's upper bound exclusive. Other
fixes: the runner acts only on our books; the relayer simulates before using
quota, refuses contract wallets, caps gas, and can use a shared rate-limit
store; unknown coins are never fetched; our names only for our books; no
validation data without `CALLBOOK_VALIDATOR`; agentId in the request hash;
mainnet scripts need `--yes`. Check `git diff` against this list if it's
unclear how far it got.

**Update, later on 2026-10-07: all of the above is done.** Every HIGH and
the planned MEDIUM/LOW fixes are in; validation requests now bind the agent id.
With nodes on 8545–8548, 296 tests pass with none skipped (callbook, engine,
callers, security, sdk/MCP, setup, scoring, evaluator, app, strategy-math,
markets, charts-page). The replay data is regenerated, and every Callbook page
renders without errors. `npm run build:callbook-crypto` rebuilds the browser
bundle. What remains is the founder's part: name, funded keys, go-ahead.

## Arc testnet (2026-10-07)

- Callbook is deployed on Arc testnet at `0x8fde4b31ac39dc05852405dc892b724244a404cb` (`deployments/callbook-testnet.json`, deployed by the runner's gas wallet).
- The packed `@onreins/mcp` was run on testnet with a fresh zero-balance key through a local relayer: gasless lock, status, reveal all worked.
- Fixed: Arc's RPC takes at most 10 event signatures per `eth_getLogs` ("requested range too large" past that), and Callbook asked for 11, so every read failed on Arc. `callbook-chain.js` now splits them (`test/callbook-chain-logs.test.js`).
- Decided (for now): open calls run from 1h, since they're priced on 1h candles from the first candle at or after entry and a shorter call has no price move. `MIN_CALL_HORIZON` in `callbook/durations.js`; the SDK, MCP and relayer refuse shorter calls (the contract still allows 5m). Shorter calls would need 5m candles plus a permanent price archive (Hyperliquid keeps only ~17 days of 5m).
- For the public to use it: push (so app.reins.one serves `/api/callbook`), set `CALLBOOK_NETWORK=testnet` and `CALLBOOK_RELAYER_KEY` on Vercel, then `npm publish` from `packages/reins-mcp`.

## Audit (2026-10-07)

Three reviews (security, scoring correctness, pages and docs). Fixed: strategy
skill now compares funding-adjusted moves with the market move; price lookups
never use a candle more than one step after the time asked; scoring as of a
moment only sees candles opened by then (`priceBook({ openBy })`), so a
published score rebuilds identically later; a revealed call waits for its exit
candle instead of scoring its worst; 5-minute pricing only for calls whose exit
is within ~17 days, reports record the candles used, `verify()` explains
expired 5-minute prices; established skill needs rated first; the record score
is posted after the skill score so the registry's latest answer is it; relayer
caps sends per IP and new books per IP per day, counts account failures only
after a valid signature, and stays off on Vercel without shared counters;
`trust proxy` defaults to 1 on Vercel; MCP strips all invisible Unicode; key
file falls back without hard links and tightens copied keys; the npm bundle
copies only public deployment fields; oversized request URIs are ignored; the
SDK checks a relayed lock really is its call; page crashes and copy fixed.
Not done: CSP headers for /callbook* (needs the inline-script cleanup first),
screen-reader text for tooltips, and the 5-minute price archive.

## What's left, in order

1. **Run the tests** whenever you change something. Start local nodes (`npx hardhat node --port 8545` and `--port 8546`), `npm run build`, then run with `--test-concurrency=1`:
   `node --test --test-concurrency=1 test/callbook.test.js test/callbook-engine.test.js test/callbook-callers.test.js test/callbook-sdk.test.js test/callbook-setup.test.js test/verify-scoring.test.js test/evaluator.test.js`.
   Don't run the whole `npm test` without a node: chain suites time out.
2. ~~Finish the MCP~~ done. It ships as the npm package `@onreins/mcp` (`packages/reins-mcp/`, built by `npm run build:reins-mcp` into one dependency-free file), so agents run `npx -y @onreins/mcp` with no clone. Not published yet: publish after the mainnet deploy so the addresses are built in (runbook, section 4).
3. **Site v2**: enable the Callers tab; build the **Lock a call** panel on `callbook.html` (connect wallet with `wallet.js`, pick a Hyperliquid perp, long/short, horizon chips, preview of entry and reveal time, sign EIP-712 `LockCall`, POST to `/api/callbook/relay/lock`); derive the salt from a wallet signature so it can be recovered on any device; auto-reveal on return; caller pages from `callbook-caller-<id>.json`. Keep the ease-of-use rules in the plan.
4. **QA**: browser check desktop + 375px, no console errors; a security review of the contract and the signing/relay flow (rate limits, gas budget).
5. **Go live (needs the founder)**: name; five fresh keys (deployer, owner, sealing caller, validator, salt secret ≥ 32 chars) funded with about $1–2 of USDC on Arc mainnet in total; then follow `docs/CALLBOOK-RUNBOOK.md`. The runner doesn't need an always-on server: a bot can seal its next round any time during the current 4h round, so an hourly scheduled job (e.g. GitHub Actions with encrypted secrets) works. Aim to be live by ~Oct 8 so there's a real record by Oct 14.
6. **Submit**: fill `docs/DORAHACKS.md`, re-check the ERC-8004 claim, commit, push to master, submit on DoraHacks.

## Facts that matter

- **Arc mainnet:** chain 5042, RPC `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`.
- **Addresses:** IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, ValidationRegistry `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58`.
- **Costs:** gas about 20 gwei, paid in USDC with 18 decimals. Deploy ≈ 4.4M gas (≈ $0.09), seal 76k, reveal 38k, gasless lock 96k (first 314k).
- **The replay** runs on a local chain over real Hyperliquid prices (Sep 5 – Oct 5). Our three bots (Hot list, Cold list, Coin flip) all scored **0/100**: no edge after fees. That's honest; keep it.
- **Smart Money:** the earlier "Smart Money" strategy page is separate (`smart-money.*`) and its method is private: `research/smart-money-*.mjs` is gitignored and must stay out of the public repo.
- **Browser cache:** Cloudflare in front of app.reins.one caches CSS/JS for 4h (Browser Cache TTL). Ask the founder to set it to "Respect Existing Headers", or add `?v=` cache-busting.
- **Founder's preferences:** short, plain answers; ask before deploying, committing or pushing; professional look, no hype or big green dollar figures; easy to use.

## Local preview

`node --env-file=.env app/server.js` serves http://localhost:4100 (Callbook at
`/callbook.html`, sample data at `?mock=1`). On the LAN: http://192.168.0.50:4100.
