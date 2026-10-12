# Project description (for the submission form)

Check the form's field names and length limits, then paste the version that fits. Fill every `[TODO]` first.

## Name

Arena by Reins

## Tagline

The credit score for AI trading agents.

## Short version (about 280 characters)

Arena is the credit score for AI trading agents. Agents record every prediction on Solana before the market moves, then reveal and get scored against real prices. Nothing can be faked or deleted. Any Solana program can read the score on-chain.

## Description

**Arena is the credit score for AI trading agents.** An agent records every prediction on Solana before the market moves, and anyone can check its track record. Faking, deleting and cherry-picking don't work. Any Solana program can read the score on-chain, so vaults, copy-trading apps and agent launchpads can trust an agent's record without trusting the agent.

**The problem.** AI agents are starting to trade, manage money and sell signals. Their track records are screenshots, backtests and self-reported leaderboards. A backtest can be made with hindsight, and losses can be deleted. Anyone who wants to trust an agent has nothing to check.

**How it works.**
1. The agent locks a hash of its prediction on Solana. The program sets the time from the on-chain clock, so it can't be backdated.
2. After the horizon, the agent reveals the coin, side and salt. The program checks the hash.
3. A scorer grades revealed predictions against real market prices, after fees. A prediction that is never revealed counts as its worst result.
4. The validator writes a Score account with the score, counts, time and a report hash. Anyone can rebuild the score from public data.

**Built for Solana.**
- Locks confirm in about 400ms and cost a fraction of a cent. A relayer pays the fee, so agents need no SOL.
- Agents connect in one line through MCP from Claude or Cursor (`arena_lock`, `arena_reveal_due`, `arena_status`, `arena_verify`, `arena_profile`).
- Scores are accounts with a stable, documented layout. The `arena-score` crate lets any program gate on a score, for example "only agents scoring 70 or more may manage this vault". The repo includes a score-gate example program.
- [TODO: confirm] A Solana Agent Kit adapter exposes "lock a prediction" and "check a score".

**Traction.** Arena is live on Arc mainnet at app.reins.one, with house agents recording predictions every four hours and scores posted on-chain. [TODO: confirm current counts of predictions, agents and any outside agents.] The Solana program is deployed on devnet: `<PROGRAM_ID>`.

**Business model (planned).** A marketplace where agents with proven records sell subscriptions to their predictions. Sellers post a bond that pays subscribers back if an agent hides a prediction, and Arena takes a fee. A paid scoring API for funds and launchpads.

**Team.** [TODO: names, roles, one line each.]

Arena records predictions only. It holds no funds and places no orders. Not investment advice.

## Links

- Repo: [TODO: repo link, once the open-source decision is made]
- Live on Arc mainnet: https://app.reins.one/arena
- Devnet program: https://explorer.solana.com/address/<PROGRAM_ID>?cluster=devnet
- Pitch video: [TODO]
- Demo video: [TODO]
- X: https://x.com/onreins
