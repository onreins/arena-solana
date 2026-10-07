# DoraHacks submission: Arc Microgrants

Ready to paste. Fill the `[…]` placeholders after the mainnet deploy
(docs/CALLBOOK-RUNBOOK.md, step 9), and re-run the registry check in
"Why Arc" on the day you submit.

---

## Project name

Arena

## One-liner

Trading agents seal every call on Arc before the market moves; an open,
re-checkable score is posted to Arc's ERC-8004 Validation Registry.

## Short description

Every strategy product shows a track record, and most track records are
backtests that can be produced with hindsight in seconds. The only record
nobody can fake is one fixed before the outcome.

Arena gives trading agents that record on Arc. An agent opens a book (its
coins, its 4-hour period and horizon, and a hash of its strategy), then seals
one call per period, long, short or flat, as a hash, before the period starts.
After the horizon the call is revealed. A skipped period counts as a miss and
a call that is never revealed counts as its worst possible outcome, so an
agent can't hide its bad stretches.

Revealed calls are scored with open rules ported from Vanta Network (MIT):
entry at the period start and exit at the horizon on Hyperliquid's public
prices, with fees and real funding, then return against the market, drawdown
and a t-statistic. The score (0 to 100) and the hash of a full report go to
Arc's ERC-8004 ValidationRegistry. Anyone can rebuild any score from Arc
events and public prices with `npm run arena:verify`, with no keys and no
trust in us.

## What it uses Arc for

- **USDC as gas.** Agents pay for every seal and reveal in USDC, at a
  predictable cost: about 0.0015 USDC per seal and 0.0008 per reveal at
  Arc's 20 gwei floor, so a book calling every 4 hours costs about 0.014 USDC
  a day.
- **Sealed calls.** `Callbook.sol` holds no funds. It fixes each call's hash
  with a block timestamp, enforces "one seal per period, at least 60 seconds
  before it starts", and only accepts the exact preimage on reveal.
- **ERC-8004 identity.** Each of our agents is an ERC-8004 agent on Arc's
  IdentityRegistry, with a registration file listing its book; a book can only
  be linked to an agent by that agent's owner or operator.
- **ERC-8004 validation.** Each book's owner files one `validationRequest`
  naming our validator; the validator answers it daily with
  `validationResponse(score, reportURI, reportHash, "arena-v1")`. Checked
  read-only on 2026-10-05 (02:10 UTC, block 24,317,242) through the
  registry's own getters: Arc mainnet's ValidationRegistry (v2.0.0) has 1,413
  registered agents, one validation request (agent #193, filed 2026-09-24)
  and no responses at all. Once live, Arena would be the first validator
  answering on Arc mainnet. *(Re-check before submitting:
  `node scripts/erc8004-stats.js --list`.)*

## How it works

1. **Open.** `open(agentId, caller, strategyHash, coins, period, horizon)`.
   The strategy's rules stay private; the hash fixes them. Books can't change
   after opening, and every book is shown, abandoned ones included, so nobody
   can open twenty and show the lucky one.
2. **Seal.** Every period the caller commits
   `keccak256(book, period, coinIndex, side, salt)`. Salts are derived from a
   secret per book and period, because a call has few possible values.
3. **Reveal.** After the horizon, within a 7-day grace window.
4. **Score.** `app/verify/` computes each call's net return at public prices
   and the book's metrics, Vanta's drawdown and challenge rules, and the
   score:
   `100 × record × coverage × (0.6 × edge + 0.4 × risk)`, where record is the
   share of Vanta's 61-day minimum, coverage the share of periods revealed,
   edge the t-statistic of returns beyond the book's average market exposure,
   and risk staying inside a 10% drawdown with enough time in the market.
5. **Publish.** The score goes to ERC-8004 with the report's URI and keccak256.
6. **Re-check.** `npm run arena:verify -- <bookId> --network mainnet`
   rebuilds the exact report and compares hashes.

## What's live

| | |
|---|---|
| Arena contract (Arc mainnet) | [`0x…`](https://explorer.arc.io/address/0x…) |
| Deploy transaction | [`0x…`](https://explorer.arc.io/tx/0x…) |
| Our agents (ERC-8004 ids) | Hot list #[…], Cold list #[…], Coin flip #[…] |
| Their books | #[…], #[…], #[…] |
| Validation requests | [tx], [tx], [tx] |
| First validation response | [tx] on [date] |
| Validator address | [`0x…`](https://explorer.arc.io/address/0x…) |
| Arena page | https://app.reins.one/arena |
| Registration files | https://app.reins.one/arena/agents/hot-list.json (and cold-list, coin-flip) |
| Testnet run (rehearsal) | Arena [`0x…`](https://explorer.testnet.arc.io/address/0x…) |

## The honest result so far

Before going live we replayed the last 30 days (2026-09-05 to 2026-10-05) on
a local chain over real Hyperliquid prices, with the same runner, contract
and scorer that run live. Three agents, a call every 4 hours, 180 periods
each: 539 calls sealed, 535 revealed, one deliberate miss and one deliberate
withheld call (on the control).

| Book | Return | vs market | Max drawdown | t-stat | Score |
|---|---|---|---|---|---|
| Hot list (long the hottest coin) | +14.2% | −2.4% | 19.7% | −0.13 | 0 / 100 |
| Cold list (short the coldest) | −15.0% | −1.3% | 29.4% | −0.10 | 0 / 100 |
| Coin flip (control, random BTC side) | −10.5% | −10.7% | 13.8% | −1.15 | 0 / 100 |

All three of our own books score 0. None beat the market with any
statistical confidence, all three broke the 10% drawdown limit, and 30 days
is half of the 61-day record the score asks for. Hot list made money, but
only by riding a rising market, which the score is built not to reward. We
publish this because the point of Arena is that a record can't be
dressed up, ours included.

## Roadmap

- **Open calls**: people and agents lock single calls (coin, side, horizon)
  whenever they like, ranked separately from strategy books. Contract
  functions written and under test.
- **MCP server for agents**: `arena_open`, `arena_seal`,
  `arena_lock`, `arena_reveal_due`, `arena_status`,
  `arena_verify`, so any MCP-speaking agent can keep a book without
  writing chain code.
- **Profiles**: anyone names their record by asking their agent
  (`arena_profile`, gasless), and each person gets a page with all their
  records and stats at `/arena/p/<address>`.
- **x402 test fee**: a small USDC fee per scored test run, paid over x402
  through Circle Gateway; one public counter of all test runs feeds a
  multiple-testing penalty.
- **Mandate-linked trades**: books whose calls are also executed through a
  Reins Mandate (a spending-limited agent wallet on Arc), so a record can be
  tied to real trades without the scorer touching anyone's funds.

## Links

- Repository: https://github.com/onreins/reinsApp
- App: https://app.reins.one/arena
- How it works in detail: `docs/CALLBOOK.md` in the repo
- Demo video: [link]

## Builder

[Name], [one line on background], [contact / X / GitHub].

## Credits

- Scoring rules ported from [taoshidev/vanta-network](https://github.com/taoshidev/vanta-network),
  Copyright © 2024 Taoshi Inc, MIT License (see `app/verify/NOTICE`).
- ERC-8004 reference contracts by the erc-8004 team
  ([erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts)),
  deployed on Arc; our local test fixture mirrors their IdentityRegistry.
- Prices and funding from Hyperliquid's public API.
