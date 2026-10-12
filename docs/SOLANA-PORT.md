# Reins on Solana: the Colosseum build

The brief for the Solana version of Reins in this repo (`onreins/arena-solana`, a full private copy of `onreins/reinsApp`), for Colosseum's Solana hackathon.

**To start:** open a new cloud session on `onreins/arena-solana` and say:

> Read `docs/SOLANA-PORT.md` and do it.

---

## What we're building

The Solana version of Reins centres on **agents and copy-trading**. Mandates are out of scope.

1. **Arena:** proof of skill for AI trading agents. Every call is locked on Solana before the market moves and scored against real prices. Nothing can be deleted, and anyone can check the math.
2. **Copy-trading:** follow a proven agent and its trades are placed on your own account the moment it locks a call, with the call's take-profit and stop-loss as real orders. Reins never holds anyone's money.
3. **Revenue built in:** subscriptions, a share of followers' profits, and a fee on copied trades.

The flow: **a proven record, then one click to copy, then everyone earns.**

Keep the Arc version working throughout. Solana goes alongside it, chosen by config.

## The hackathon

- **This round:** Colosseum's Fall 2026 hackathon, reportedly running until about **Nov 2, 2026**. These dates come from a third-party listing, so confirm them on colosseum.com.
- **Last round's prizes (Spring 2026):**
  - Grand Champion: $30,000
  - Public Goods Award: $10,000
  - University Award: $10,000
  - $10,000 each to 20 more teams
  - plus accelerator and pre-seed chances
- **Eligibility:** the rules don't bar existing projects. One project per team, and every member registers on colosseum.com before the cutoff.
- **Judging (official, Spring 2026):** functionality, potential impact, novelty, UX (using Solana's speed), open source and composability, and **business plan**. Colosseum backs companies, so the revenue has to be real and visible in the code.

---

## Build plan, in priority order

Work on branch `solana-port`, push it, and open a PR into `master` of `onreins/arena-solana`.

### Phase A: Arena on Solana (the trust layer)

Read first: `contracts/Callbook.sol`, `app/verify/callbook-chain.js`, `callbook-callers.js`, `callbook.js`, `callbook-prices.js`, `callbook-relay.js`, `app/callbook-routes.js`, `callbook/sdk.js` and `callbook/mcp-server.js`.

1. **Anchor program `programs/arena` (Rust)**, matching `Callbook.sol`:
   - **Open-call books** (the path agents use through MCP): one book per account, opened on its first lock.
   - `lock(call_hash, horizon)` takes the entry time from the on-chain `Clock`, so nothing can be backdated.
   - `reveal(book, call_id, symbol, side, salt)` checks the commitment. The commitment binds the program id, book, call id, horizon, coin, side and salt, using fixed-layout hashing.
   - A call can be revealed only after it exits, within a GRACE window, and only once.
   - **Emit events that include the salt.** The audit found the EVM scorer could only read the salt from transaction calldata, which a front-runner could hide.
   - **Score accounts:** a validator authority writes one Score account per book, standing in for ERC-8004's Validation Registry.
   - Then profiles (name, bio and link, with length caps).
2. **Gasless locking:** the relayer pays the fee, the user signs, and the relayer co-signs.
   - Before co-signing, check that the transaction contains only Arena instructions.
   - Limits mirror `callbook-relay.js`, and the rate-limit store **fails closed**.
   - Each signed transaction is sent at most once, and only with a recent blockhash.
3. **Program tests:**
   - commitment binding
   - no backdating
   - the reveal window, and a double reveal
   - a withheld call stays withheld
   - profile caps
   - Score accounts are written only by the validator
4. **Solana chain reader:** produces the **same** in-memory `chain` shape as `readCallbook`, so the existing scorer, API and pages work unchanged. Select it with `ARENA_NETWORK=solana-devnet`.
5. **SDK and MCP:** a Solana backend in `callbook/sdk.js` and `callbook/mcp-server.js`, with the **same tool names**. The key lives in a local file with `0600` permissions, and is never printed or sent.
6. **Scorer fix from the audit** (in the shared scorer):
   - Hidden and withheld calls score at a real worst: the adverse move along the price path (candle highs and lows).
   - For any-coin books, the candidates include the coins the book itself revealed.
   - **Do not change `SCORING_VERSION` (`"arena-v1"`).**

### Phase B: Copy-trading on Drift (the product people pay for)

Drift is Solana's main perps exchange and has a devnet. **Check each Drift feature below against Drift's current docs and SDK before building on it.** If one doesn't exist or works differently, say so and pick the closest real alternative.

1. **No custody, through Drift delegates.**
   - A follower keeps their own Drift account and sets Reins' copier as its **delegate**, an authority that can place and cancel orders but **cannot withdraw**.
   - Reins never holds follower funds, and a follower can revoke at any time from Drift itself.
2. **The copier service (`copier/`, Node).** When a followed agent locks a call, it places the same trade on every follower's account:
   - **Size:** each follower's own setting (a fixed amount or a % of account).
   - **TP and SL:** the call's take-profit and stop-loss go in as real trigger orders. The stop and target are already part of an Arena call (`callbook-exits.js`).
   - **Follower limits, checked before every order:** a maximum size per trade, a maximum number of open copied positions, and a daily loss cap that pauses copying once hit.
   - **Speed:** orders go out within seconds of the lock. Log the latency per order, because it's a demo number.
   - **Safety:** each order is placed exactly once, a restart never sends duplicates, and the copier's key comes from the environment and is never printed.
3. **How followers get the call at lock time.**
   - The public sees a call only at its reveal. Followers have to act at entry.
   - The agent's SDK sends the call's preimage to the copier, encrypted to the copier's key, when it locks.
   - The copier checks it against the on-chain lock hash before trading, so it trades only on what was actually committed.
   - The public record is unchanged: the reveal later proves the timing.
4. **A follow program `programs/follow` (Anchor), for subscriptions on-chain:**
   - Each follower–agent pair is one Follow account, with a paid-until date, size settings and limits.
   - The follower pays in USDC (SPL): a monthly price set by the agent's owner, split between the agent's owner and a Reins treasury at a fixed rate.
   - The copier trades only for active, paid follows.
5. **Revenue, all three ways:**
   - **Subscriptions:** described in 4.
   - **Performance fee:** a share of a follower's copied profit, only above their previous peak (a high-water mark). Settled periodically from the follower's PnL as reported by Drift, and split between the agent's owner and Reins. If doing this fully on-chain is too much for the MVP, compute it off-chain, record each settlement on-chain, and say so.
   - **A fee on copied orders:** if Drift lets an app add its own fee to orders it routes (builder or referral fees), use it. If not, leave it out and say so.
6. **Tests:**
   - the copier refuses unpaid follows
   - follower limits hold
   - an order is never placed twice
   - a preimage that doesn't match the lock is refused
   - the subscription split is exact
   - the performance fee is charged only above the high-water mark
7. **App:**
   - On an agent's page, a **Copy** button: connect a Solana wallet, set up the Drift delegate, choose size and limits, then subscribe.
   - A **Following** page showing each copied agent, open positions, PnL, fees paid and a stop-copying button.
   - The existing leaderboard, agent pages and guide get a Solana mode.

### Phase C: Deploy and demo

- Deploy the programs to **Solana devnet only**.
- Run a few **house agents** from the existing agents in the repo, so the demo has real records and agents to copy on day one.
- Show Solana Explorer links for every lock, reveal, subscription and copied order.
- **README:** a Solana section in the existing README's voice:
  - Arena
  - copy-trading
  - how follower money stays in the follower's own account
  - the revenue model
  - the devnet program ids
  - how to connect an agent (one line through MCP)

---

## Submission kit (prepare in `docs/colosseum/`)

Colosseum usually asks for the items below. Confirm the exact list on the submission form.

1. **Pitch video (about 3 minutes):**
   - the problem: agent trading records are self-reported, and copying a bot means trusting a screenshot
   - Reins: proven records plus copy-trading without custody
   - why Solana: speed for copy orders
   - traction: live on Arc
   - **the business model with simple numbers** (for example: followers × subscription + the performance fee)
2. **Technical demo video (about 3 minutes):** an agent locks a call through MCP, followers' orders land on Drift devnet within seconds with TP and SL attached, then the call is revealed and scored, and the subscription and fee split are shown on-chain.
3. The GitHub repo, with the README.
4. A short project description for the form.

Write the scripts, a shot list and a one-page **business model** (pricing, take rates, a simple revenue projection) as markdown. The person records the videos.

## The open-source decision (for the user)

Judges score open source. This repo is private and **stays private until the user decides**.
- Add a `LICENSE` file (suggested: Apache-2.0).
- Keep the programs and SDK free of secrets and private business details, so the user can make them public in one step if they choose.
- **Do not make anything public yourself.**

## Hard rules
- Never commit secrets or keypairs: gitignore them, and never print secret values.
- **No mainnet deploys, and no spending real funds.** Devnet only.
- **No custody:** follower funds never leave the follower's own Drift account, and Reins' authority can never withdraw.
- Keep the repo private. Don't push to or change `onreins/reinsApp`.
- Use conventional commit messages, with no attribution or co-author lines.
- Write tests first for program and copier logic, run them, and report real results.
- If the environment can't install Rust, the Solana CLI or Anchor, say so plainly and do the TypeScript/off-chain parts you can.
- Verify every Drift and Solana feature against current docs before relying on it, and report anything that didn't exist as assumed.
- Note in the README that charging subscription and performance fees for trade signals may be regulated in some countries, and should be checked before mainnet.

## Final report
- What works end to end, per phase
- Test results (pass/fail counts)
- The devnet program ids
- Copy-order latency
- The PR link
- The status of the submission kit
- What's left before submission
