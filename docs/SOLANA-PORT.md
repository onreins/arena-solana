# Arena on Solana: the Colosseum build

The brief for porting Arena to Solana in this repo (`onreins/arena-solana`, a private copy of `onreins/reinsApp`), shaped to win Colosseum's Solana hackathon and get into its accelerator.

**To start:** open a new cloud session on `onreins/arena-solana` and say:

> Read `docs/SOLANA-PORT.md` and do it.

---

## The pitch, in one line

**Arena is the credit score for AI trading agents.** An agent commits every prediction on Solana before the market moves, and anyone can verify its track record. Faking, deleting and cherry-picking are all impossible. Any Solana program can read the score on-chain, so vaults, copy-trading apps and agent launchpads can trust an agent's record without trusting the agent.

## The hackathon

Colosseum runs Solana's global hackathons and backs the winners through its accelerator and pre-seed fund.

- **This round:** Fall 2026, reportedly running until about **Nov 2, 2026**. These dates come from a third-party listing, so confirm them on colosseum.com.
- **Last round's prizes (Spring 2026, Solana Frontier):**
  - Grand Champion: $30,000
  - Public Goods Award: $10,000
  - University Award: $10,000
  - $10,000 each to the next 20 standout teams
  - on top of the cash: a shot at Colosseum's accelerator and pre-seed funding
- **Eligibility:** the Spring 2026 official rules don't bar existing projects. Only one project per team is allowed, and every member must register on colosseum.com before the registration cutoff (it was a week before the deadline).

### How it's judged (official criteria, Spring 2026)

Every piece of work below should move at least one of these:

| Criterion | What judges ask | How Arena on Solana wins it |
|---|---|---|
| **Functionality** | How well does it work? Code quality? | A deployed devnet program with real tests, plus a real end-to-end flow: an agent locks, reveals and is scored. No mock data in the demo. |
| **Potential impact** | Total addressable market? Impact on the Solana ecosystem? | Solana is where AI agents trade. Every agent needs a track record that can't be faked, so this is infrastructure for the whole agent economy. |
| **Novelty** | How unique is it? | Commit–reveal on-chain records with scores that other programs can read. Existing "agent leaderboards" are self-reported. |
| **UX** | Does it use Solana's speed for great UX? | Locks confirm in about 400ms, fees are fractions of a cent, and the relayer pays them, so agents need no SOL. Installing it into Claude or Cursor is one line through MCP. |
| **Open source** | Is it open source? Does it compose with other Solana primitives? | **Scores as on-chain accounts any program can read** through a CPI-friendly crate (a Rust library other programs call into). An adapter for the Solana Agent Kit / ElizaOS ecosystem. (The repo is private; see the open-source decision below.) |
| **Business plan** | Is there a viable business? | The marketplace: agents with proven records sell subscriptions to their calls, bonded so a hidden call pays subscribers back, and Arena takes a fee. There's also a paid scoring API for funds and launchpads. |

---

## What Arena is (the Arc version this ports)

A tamper-proof track record for AI trading agents, live on Arc mainnet at app.reins.one:
1. An agent **locks** a hashed prediction before the market moves.
2. It **reveals** the prediction after the prediction's horizon (time window) ends.
3. An off-chain scorer grades revealed calls against real Hyperliquid prices. Calls never revealed ("withheld") score at their worst.

It records predictions only: no funds, no orders, no positions.

### Read these first

| File | What it is |
|---|---|
| `contracts/Callbook.sol` | The EVM contract |
| `app/verify/callbook-chain.js` | Chain reader that builds the in-memory `chain` state |
| `app/verify/callbook-callers.js`, `callbook.js`, `callbook-prices.js` | The scorer |
| `app/verify/callbook-relay.js` | Gasless relay |
| `app/callbook-routes.js` | API |
| `callbook/sdk.js`, `callbook/mcp-server.js` | The `@onreins/mcp` agent tools: `arena_lock`, `arena_reveal_due`, `arena_status`, `arena_verify`, `arena_profile`, … |
| `docs/` | Design notes |

---

## Build plan, in priority order

Work on branch `solana-port`, push it, and open a PR into `master` of `onreins/arena-solana`. Keep the Arc version working: Solana goes alongside it, not in place of it.

### 1. Anchor program `programs/arena` (Rust)
- **Open-call books first** (the path agents use through MCP): one book per account, opened on its first lock.
- `lock(call_hash, horizon)` records the entry time from the on-chain `Clock`. No client-supplied timestamps, so no backdating.
- `reveal(book, call_id, symbol, side, salt)` checks the commitment. The commitment must bind the program id, book, call id, horizon, coin, side and salt, using fixed-layout hashing (no ambiguous concatenation).
- A call can be revealed only after it exits, within a GRACE window, and only once.
- **Emit events that include the salt.** The audit found the EVM scorer could only read the salt from transaction calldata, which a front-runner could hide.
- **Score accounts:** a validator authority writes one Score account per book, holding the score, call counts, the time of scoring and a report hash. This stands in for ERC-8004's Validation Registry. Make the layout **stable and documented**, and publish a tiny `arena-score` Rust crate with a read helper, so other programs can gate on a score (for example "only agents scoring ≥ 70 may manage this vault"). This is what earns the composability marks.
- Profiles next: name, bio and link, with length caps.
- Scheduled seal/reveal books are lower priority. Skip them if time is short.

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
- a Score account written only by the validator authority

### 4. Off-chain chain reader
A Solana chain reader that produces the **same** in-memory `chain` shape as `readCallbook`, so the existing scorer, API and pages are reused unchanged. Pick the network by config, e.g. `ARENA_NETWORK=solana-devnet`.

### 5. SDK, MCP and agent-framework adapters
- A Solana backend in `callbook/sdk.js` and `mcp-server.js`, with the same tool names.
- The key lives in a local file with `0600` permissions, and is never printed or sent.
- **Adapters for the Solana agent ecosystem:** a small plugin or wrapper for **Solana Agent Kit** (and ElizaOS if time allows) that exposes "lock a call" and "check a score". This is high value for impact and composability.

### 6. Scorer fix from the audit (in the shared scorer)
- A hidden or withheld call must score at a **real worst**: the adverse move **along the price path** (candle highs and lows), not just the entry-to-exit move.
- For any-coin books, the candidate coins must include the coins **the book itself revealed**. Otherwise "reveal the winning side, hide the losing side" on a coin outside the top-50 reference set beats revealing.
- **Do not change `SCORING_VERSION` (`"arena-v1"`).** It is embedded in on-chain validation request descriptors.

### 7. The demo surface
- A Solana network mode on the existing Arena pages (leaderboard, an agent's record, the guide) reading from devnet. Show **Solana Explorer links** for every lock and reveal, and show a lock confirming in under a second.
- *Stretch goal:* a **Solana Action / Blink** that shares an agent's live record, and "follow this agent", as a link that unfurls in X or Discord. A cheap UX and novelty win.

### 8. Deploy and document
- Deploy the program to **Solana devnet only**, and seed a few house agents that lock and reveal on a schedule, so the demo shows real records.
- Hackathon README (top of `README.md`):
  - the one-line pitch
  - the problem (agent track records are self-reported and fakeable)
  - how it works (diagram)
  - the devnet program id
  - how to try it in one line through MCP
  - the composability story (reading a Score account from another program)
  - the business model
  - the team

---

## Submission kit (prepare in `docs/colosseum/`)

Colosseum usually asks for the items below. Confirm the exact list on the submission form.

1. **Pitch video (about 3 minutes):** the problem, the solution, why Solana, traction (Arena is already live on Arc mainnet, with real agents and records), the business model, and the team.
2. **Technical demo video (about 3 minutes):** an agent in Claude or Cursor locks a call through MCP, sees it on devnet in under a second, reveals it, gets scored, and the Score account is read by another program.
3. **The GitHub repo** with the README above.
4. **The project description** for the form: short, plain, and leading with the one-line pitch.

Write the video **scripts** and a **shot list** as markdown. The person records the videos.

## The open-source decision (for the user)

Judges explicitly score **open source**, and the Public Goods Award rewards it. This repo is private, and **must stay private until the user says otherwise**. Prepare for both outcomes:
- Add a `LICENSE` file (suggested: Apache-2.0 for the program, the `arena-score` crate and the SDK).
- Keep everything that's to be open-sourced free of secrets and private business details, so the user can make the program, crate and SDK public in one step if they choose.
- **Do not make anything public yourself.**

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
- The status of the submission kit (scripts, README, license)
- What's left before submission, mapped to the six judging criteria
