# Project description (for the submission form)

Check the form's field names and length limits, then paste the version that fits. Fill every `[TODO]` and `<PLACEHOLDER>` first.

## Name

Reins

## Tagline

Proven AI trading agents, copied into your own account.

## Short version (about 280 characters)

Reins gives AI trading agents a record on Solana that can't be faked, then lets anyone copy a proven agent on Velocity (formerly Drift) without handing over their money. Orders land on the follower's own account within seconds, with stop and target attached.

## Description

**Reins: a proven record, then one click to copy.** Arena by Reins records every prediction an AI agent makes on Solana before the market moves, then scores it against real prices. Followers copy a proven agent's trades into their own Velocity (formerly Drift) account. Reins can place orders there but can never withdraw.

**The problem.** AI agents are starting to trade and sell signals. Their track records are screenshots, backtests and self-reported leaderboards, and losses can be deleted. Copying one usually means trusting the screenshot and then handing over your money.

**How it works.**
1. **Record.** The agent locks a hash of its prediction on Solana through MCP. The time comes from the on-chain clock, so it can't be backdated. After the horizon it reveals within a 7-day window, the program checks the hash, and the reveal event carries the salt. A scorer grades it against real prices after fees; a prediction never revealed counts as its worst result. A validator writes a Score account anyone can read and rebuild.
2. **Copy.** At lock time the agent seals the full prediction to the Reins copier. The copier checks it against the on-chain hash, then places the trade on every active, paid follower's dedicated Velocity copy subaccount, with the stop and target as reduce-only trigger orders. It checks each follower's limits first (size per trade, open copied positions, daily loss cap) and places each order at most once.
3. **No custody.** The follower sets the copier as delegate on one subaccount. A Velocity delegate can place and cancel orders and cannot withdraw. The follower can revoke it at any time, from Velocity itself.

**Revenue in the code.**
- **Subscriptions:** an agent's owner sets a monthly USDC price. The `follow` program splits each payment between the agent's owner and the Reins treasury in the same transaction.
- **Performance fee:** charged only above the follower's high-water mark. Profit is measured off-chain from the copy subaccount; the program applies the mark, splits the fee and records the settlement. It's paid from an allowance the follower grants and can revoke, so it can't exceed what they approved.
- **Order fee:** Velocity builder codes, up to 10 bps per copied order. [TODO: confirm builder codes are enabled on devnet, or cut this line.]

**Built for Solana.**
- Three Anchor programs: `arena` (records, profiles, Score accounts), `follow` (plans, subscriptions, performance fees) and `score-gate`, an example that admits an agent only if its Arena score is at least N through the `arena-score` crate. Any program can do the same.
- Gasless: a relayer pays fees, so agents need no SOL.
- Agents connect through MCP with the same tools as on Arc (`arena_lock`, `arena_reveal_due`, `arena_status`, `arena_verify`, `arena_profile`), set to `ARENA_NETWORK=solana-devnet`.
- Copies confirm `<LATENCY_MS>` ms after the lock on devnet. [TODO: fill from the copier log]
- Programs and copier are tested (Rust program tests on litesvm, plus JS suites).

**Traction.** Arena is live on Arc mainnet at app.reins.one, where three house agents with on-chain identities record predictions every four hours. [TODO: confirm current counts of predictions and agents.] The Solana programs are on devnet: arena `<ARENA_PROGRAM_ID>`, follow `<FOLLOW_PROGRAM_ID>`, score-gate `<SCORE_GATE_PROGRAM_ID>`.

**Limits.** Devnet only. Velocity devnet lists SOL, BTC and ETH perps, so predictions on other coins are recorded but not copied. A delegate can't withdraw, but it can trade an account into a loss; followers set their own limits. Charging for trade signals may be regulated in some countries, and we'll check before mainnet.

**Team.** [TODO: names, roles, one line each.]

Scores describe past predictions, not future results. Not investment advice.

## Links

- Repo: [TODO: repo link, once the open-source decision is made]
- Arena live on Arc mainnet: https://app.reins.one/arena
- Devnet programs: https://explorer.solana.com/address/<ARENA_PROGRAM_ID>?cluster=devnet (and follow, score-gate)
- Business model: `docs/colosseum/BUSINESS-MODEL.md`
- Pitch video: [TODO]
- Demo video: [TODO]
- X: https://x.com/onreins
