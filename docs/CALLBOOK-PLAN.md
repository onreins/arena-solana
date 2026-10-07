# Callbook: build plan

Target: DoraHacks Arc Microgrants, live on Arc **mainnet** before
2026-10-14 23:59 ET, ideally live by 2026-10-08 so there is a record to show.
Everything below is local until the founder approves a commit, a push and a
mainnet deploy.

## Two modes

| | Strategy books | Open calls |
|---|---|---|
| Who | Agents running a strategy | People or agents with their own view |
| When | Every period, no skipping (a skip is a miss) | Whenever they like |
| A call | Coin + long / short / flat | Coin + long / short + horizon |
| Entry | Period start | Next whole minute, at least 60s after locking |
| Proves | The strategy works, consistently | This caller beats the market, call by call |
| Board | Strategies | Callers, ranked separately (choosing when to call is part of the skill) |

## Easy to use: the rules every phase follows

- **Browsing needs nothing.** No wallet, no sign-up to see books, callers and scores.
- **Locking a call takes three taps:** coin, up or down, how long. Sensible defaults (the last coin, 4h). One signature, no gas: the person signs, Reins submits the transaction and pays the gas (about $0.002 a call).
- **No setup.** A wallet's call book opens automatically on its first call.
- **No jargon on the surface.** People see "Lock call", "Locked", "Revealed", "Beat the market by…". Hash, salt, period index and ERC-8004 live one tap away, under "Proof".
- **Nothing to remember.** The secret that hides a call comes from a wallet signature, so it can be recreated on any device; reveals happen by themselves when the person comes back, or with one tap.
- **Every number says what it means** in a short line underneath, and every empty state says what to do next.
- **Agents get one command.** The MCP server needs one key in its config; it opens the book on first use, seals or locks, and reveals by itself.

## Phases

### 1. Contract and data fit (running)
- [x] `Callbook.sol` strategy books, 58 tests; `NO_AGENT` sentinel; ERC-8004 mock matches v2.0.0
- [x] Vanta scoring port, 43 tests
- [x] Engine, runner, verify script, API, 30-day replay (22 tests)
- [ ] Open calls in the contract: `openFree`, `lock`, `revealLocked`, domain-separated hashes
- [ ] Pages fitted to the replay data (period numbers, drawdown bars, score breakdown, honest replay labels)

### 2. Engine v2
- Score open calls per call and per caller (hit rate, return per call vs the coin's move, t-stat, worst call, record length)
- API: `callers` on `/api/callbook`, `/api/callbook/caller/:id`, locks in the feed
- Replay: a few labelled sample callers lock calls over the same 30 days of real prices

### 3. Site v2
- Strategies | Callers switch on the Callbook page
- **Lock a call**: connect wallet, pick a perp, long or short, horizon, preview ("entry 14:32 UTC, reveals 18:32"), sign, lock
  - the hiding salt comes from a wallet signature, so the call can be revealed from any device
  - reveal: automatic when the caller returns, a one-click reveal, and agents reveal through the MCP
- Caller pages: record, calls (sealed ones as hashes until revealed), score
- **Phone layout**: audit and fix every page at 375, 390 and 414 wide, not just Callbook

### 4. MCP for agents
One server, `callbook/mcp-server.js`, on a shared `callbook/sdk.js`:
- `callbook_markets`: coins it can call
- `callbook_open`: open a strategy book or a call book (optionally linked to an ERC-8004 agent)
- `callbook_seal`: this period's call for a strategy book (salt derived, nothing to store)
- `callbook_lock`: an open call with a horizon
- `callbook_reveal_due`: reveal everything that has matured
- `callbook_status`: record, score, next deadline
- `callbook_verify`: rebuild a score from chain and prices
- a copy-paste config for Claude Desktop, Cursor and other MCP clients, and docs

### 5. Going live
- `scripts/callbook-setup.js`: register our ERC-8004 agents on Arc, open their books, file validation requests (checked against the real IdentityRegistry ABI)
- Deploy runbook: testnet dry run, then mainnet (needs a funded key)
- Runner and API configured for mainnet; scores posted daily
- `docs/DORAHACKS.md`: the submission text and links

### 6. QA
- Full test suite with a local node running
- Browser QA, desktop and phone, no console errors
- Security review of the contract and the browser signing flow
- Founder reviews, then commit, push, deploy

## Needs from the founder
1. The name (Callbook, Receipts, Sealed, Tape, Called It…)
2. A fresh Arc mainnet key with a few USDC, and the go-ahead to deploy
3. The go-ahead to commit and push
