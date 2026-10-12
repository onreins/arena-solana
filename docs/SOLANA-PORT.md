# Reins on Solana: the Colosseum build

The brief for bringing Reins to Solana in this repo (`onreins/arena-solana`, a private copy of `onreins/reinsApp`), for Colosseum's Solana hackathon.

**To start:** open a new cloud session on `onreins/arena-solana` and say:

> Read `docs/SOLANA-PORT.md` and do it.

---

## What we're building: the same Reins, on Solana

No new pitch and no new product. Reins stays exactly what it is on Arc, in its own words:

> **Hand an AI agent the reins, never the keys.**
> The all-in-one platform for AI trading agents: agents that trade under limits they can't break, with every call locked before the market moves.

Reins has two parts, and both come to Solana:

1. **Mandates.** The agent's money sits in an on-chain account that enforces its owner's rules:
   - only allowed assets
   - a size limit per trade
   - fair prices, checked against an oracle
   - a loss limit, with a public freeze that anyone can trigger
   - an expiry
   - no way for the agent to move money out

   The owner can take everything back at any time, and the rules are fixed when the Mandate is created. See `README.md` ("How a Mandate protects the money") and `contracts/Mandate.sol`.
2. **Arena.** *Proof of skill for AI trading agents.* Every prediction is locked before the market moves and scored against real prices. Nothing can be deleted, and anyone can check the math. See `contracts/Callbook.sol` and the `app/verify/callbook-*.js` files.

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
- **Judging (official, Spring 2026):**
  - functionality
  - potential impact
  - novelty
  - UX (using Solana's speed)
  - open source and composability
  - business plan

  Build well against these, but don't invent features or marketing to chase them. The product is Reins.

---

## Build plan, in priority order

Work on branch `solana-port`, push it, and open a PR into `master` of `onreins/arena-solana`.

### Phase A: Arena on Solana (start here: smaller, and most of its off-chain code is reused)

1. **Anchor program `programs/arena` (Rust)**, matching `Callbook.sol`:
   - **Open-call books first** (the path agents use through MCP): one book per account, opened on its first lock.
   - `lock(call_hash, horizon)` records the entry time from the on-chain `Clock`. No client-supplied timestamps, so no backdating.
   - `reveal(book, call_id, symbol, side, salt)` checks the commitment. The commitment binds the program id, book, call id, horizon, coin, side and salt, using fixed-layout hashing.
   - A call can be revealed only after it exits, within a GRACE window, and only once.
   - **Emit events that include the salt.** The audit found the EVM scorer could only read the salt from transaction calldata, which a front-runner could hide.
   - **Score accounts:** a validator authority writes one Score account per book, standing in for ERC-8004's Validation Registry.
   - Then profiles (name, bio and link, with length caps), then scheduled seal/reveal books.
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
4. **Solana chain reader:** produces the **same** in-memory `chain` shape as `readCallbook` (`app/verify/callbook-chain.js`), so the existing scorer, API and pages work unchanged. Select it with `ARENA_NETWORK=solana-devnet`.
5. **SDK and MCP:** a Solana backend in `callbook/sdk.js` and `callbook/mcp-server.js`, with the **same tool names**. The key lives in a local file with `0600` permissions, and is never printed or sent.
6. **Scorer fix from the audit** (in the shared scorer):
   - Hidden and withheld calls score at a real worst: the adverse move along the price path (candle highs and lows).
   - For any-coin books, the candidates include the coins the book itself revealed.
   - **Do not change `SCORING_VERSION` (`"arena-v1"`).**

### Phase B: Mandates on Solana

1. **Anchor program `programs/mandate`**, matching `Mandate.sol`'s rules one for one: a PDA vault holds the agent's USDC (SPL), the owner sets the rules once at creation, and the agent can only trade within them.
   - **Venue:** an adapter interface, like `UniswapV4Venue.sol` on Arc. On mainnet that would be Jupiter. Jupiter has no devnet, so for devnet use a devnet AMM if one is usable (Orca or Raydium devnet), otherwise a minimal test venue program. Say which in the README.
   - **Oracle:** Pyth (it has devnet feeds) for the fair-price band and the loss limit, standing in for Chainlink/RedStone on Arc.
   - **Exits:** the owner's withdraw and revoke never depend on the oracle being healthy, the same as on Arc.
2. **Program tests**, one for each rule:
   - an asset that isn't allowed is refused
   - an oversized trade is refused
   - a price outside the band is refused
   - a trade past the loss limit is refused
   - anyone can freeze the Mandate once the market alone pushes it past the limit
   - an expired Mandate stops trading
   - the agent can never move money out
   - the owner can always exit
3. **App:** the existing pages (Agents, an agent's page, Create agent) get a Solana mode, reading Mandates from devnet.

### Phase C: Deploy and demo

- Deploy both programs to **Solana devnet only**.
- Run a few house agents so the demo shows real Mandates and real Arena records.
- Show Solana Explorer links for every transaction.
- **README:** a Solana section in the same voice as the existing README: what Reins is, how a Mandate protects the money, how Arena works, the devnet program ids, and how to try it (one line through MCP).

---

## Submission kit (prepare in `docs/colosseum/`)

Colosseum usually asks for the items below. Confirm the exact list on the submission form.

1. **Pitch video (about 3 minutes):** Reins as it is (hand an agent the reins, never the keys), why Solana, and traction (live on Arc).
2. **Technical demo video (about 3 minutes):** create a Mandate, watch an agent trade inside its limits and get refused outside them, lock a call through MCP, then reveal it and see it scored.
3. The GitHub repo, with the README.
4. A short project description for the form.

Write the scripts and a shot list as markdown. The person records the videos.

## The open-source decision (for the user)

Judges score open source. This repo is private and **stays private until the user decides**.
- Add a `LICENSE` file (suggested: Apache-2.0).
- Keep the programs and SDK free of secrets and private business details, so the user can make them public in one step if they choose.
- **Do not make anything public yourself.**

## Hard rules
- Never commit secrets or keypairs: gitignore them, and never print secret values.
- **No mainnet deploys, and no spending real funds.** Devnet airdrops only.
- Keep the repo private. Don't push to or change `onreins/reinsApp`.
- Use conventional commit messages, with no attribution or co-author lines.
- Write tests first for program logic, run them, and report real results.
- If the environment can't install Rust, the Solana CLI or Anchor, say so plainly and do the TypeScript/off-chain parts you can.
- Don't add product features, names or marketing that Reins doesn't already have.

## Final report
- What works end to end, per phase
- Test results (pass/fail counts)
- The devnet program ids
- The PR link
- The status of the submission kit
- What's left before submission
