# Port Arena to Solana

The brief for porting Arena to Solana in this repo (`onreins/arena-solana`, a private copy of `onreins/reinsApp`).

**To start:** open a new cloud session on `onreins/arena-solana` and say:

> Read `docs/SOLANA-PORT.md` and do it.

---

## Goal

Add a Solana version of **Arena** (code name *Callbook*) alongside the existing Arc/EVM version, and keep the EVM version working. Work on a branch `solana-port`, push it, and open a PR into `master` of `onreins/arena-solana` when done.

**Why:** to enter the Colosseum Solana hackathon. It's Fall 2026 and reportedly runs until about **Nov 2, 2026**. Reported requirements: a working MVP on Solana, a GitHub repo, a monetization plan and team info. These are unverified, so check colosseum.com if you can. Aim for a demoable MVP well before the deadline.

## What Arena is

A tamper-proof track record for AI trading agents:
1. An agent locks (commits) a hashed prediction before the market moves.
2. It reveals the prediction after the prediction's horizon (time window) ends.
3. An off-chain scorer grades revealed calls against real Hyperliquid prices. Calls never revealed ("withheld") score at their worst.

It records predictions only: no funds, no orders, no positions. On Arc it is live on mainnet at app.reins.one.

## Read these first (the EVM version)

| File | What it is |
|---|---|
| `contracts/Callbook.sol` | The contract |
| `app/verify/callbook-chain.js` | Chain reader that builds the in-memory `chain` state |
| `app/verify/callbook-callers.js`, `callbook.js`, `callbook-prices.js` | The scorer |
| `app/verify/callbook-relay.js` | Gasless relay |
| `app/callbook-routes.js` | API |
| `callbook/sdk.js`, `callbook/mcp-server.js` | The `@onreins/mcp` agent tools: `arena_lock`, `arena_reveal_due`, `arena_status`, `arena_verify`, `arena_profile`, … |
| `docs/` | Design notes |

## MVP scope, in priority order

### 1. Anchor program `programs/arena` (Rust)
- **Open-call books first** (the path agents use through MCP): one book per account, opened on its first lock.
- `lock(call_hash, horizon)` records the entry time from the on-chain `Clock`. No client-supplied timestamps, so no backdating.
- `reveal(book, call_id, symbol, side, salt)` checks the commitment. The commitment must bind the program id, book, call id, horizon, coin, side and salt, using fixed-layout hashing (no ambiguous concatenation).
- A call can be revealed only after it exits, within a GRACE window, and only once.
- **Emit events that include the salt.** The audit found the EVM scorer could only read the salt from transaction calldata, which a front-runner could hide.
- Profiles next: name, bio and link, with length caps.
- Scheduled seal/reveal books are lower priority.
- Scores: a validator authority writes a Score account per book, standing in for ERC-8004's Validation Registry.

### 2. Gasless locking (the relayer pays the fee)
- The user's keypair signs, and the relayer co-signs as fee payer.
- Before co-signing, the relay checks that the transaction contains **only Arena instructions** from a plain user signer.
- Limits mirror `callbook-relay.js`: per account, per IP, a global hourly cap, and a daily lamport budget.
- The rate-limit store **fails closed**: if it can't be reached, refuse.
- Each signed transaction is sent **at most once**.
- Short validity: recent blockhash only.

### 3. Program tests
Use `anchor test`, or litesvm/bankrun. Cover:
- commitment binding
- no backdating
- the reveal window, and a double reveal
- a withheld call stays withheld
- profile length caps

### 4. Off-chain chain reader
A Solana chain reader that produces the **same** in-memory `chain` shape as `readCallbook`, so the existing scorer, API and pages are reused unchanged. Pick the network by config, e.g. `ARENA_NETWORK=solana-devnet`.

### 5. SDK and MCP
- A Solana backend in `callbook/sdk.js` and `mcp-server.js`, with the same tool names.
- The key lives in a local file with `0600` permissions, and is never printed or sent.

### 6. Scorer fix from the audit (in the shared scorer)
- A hidden or withheld call must score at a **real worst**: the adverse move **along the price path** (candle highs and lows), not just the entry-to-exit move.
- For any-coin books, the candidate coins must include the coins **the book itself revealed**. Otherwise "reveal the winning side, hide the losing side" on a coin outside the top-50 reference set beats revealing.
- **Do not change `SCORING_VERSION` (`"arena-v1"`).** It is embedded in on-chain validation request descriptors.

### 7. Devnet and README
- Deploy the program to **Solana devnet only**.
- Add a hackathon section to the README:
  - what Arena is
  - the demo flow: an agent locks through MCP, then reveals, then gets scored
  - the architecture
  - the devnet program id
  - the monetization idea: a marketplace to subscribe to agents with proven records

## Hard rules
- Never commit secrets or keypairs: gitignore them, and never print secret values.
- **No mainnet deploys, and no spending real funds.** Devnet airdrops only.
- Keep the repo private. Don't push to or change `onreins/reinsApp`.
- Use conventional commit messages, with no attribution or co-author lines.
- Write tests first for program logic, run them, and report real results.
- If the environment can't install Rust, the Solana CLI or Anchor, say so plainly and do the TypeScript/off-chain parts you can.

## Final report
- What works end to end
- Test results (pass/fail counts)
- The devnet program id
- The PR link
- What's left before submission
