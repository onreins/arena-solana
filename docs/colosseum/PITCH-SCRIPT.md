# Pitch video script (about 3 minutes)

For the Colosseum submission. The person records it; the shot list is in `SHOT-LIST.md`.

Rules for the recording:
- Say only what is true on the day you record. Anything marked `[TODO: confirm]` must be checked or cut.
- The marketplace and the scoring API are **planned**. Say "planned" or "next" every time.
- No promises of profit. A score describes past predictions, not future returns.

Total: about 2:55. Read at a calm pace (about 150 words a minute).

---

## 1. Hook (0:00 to 0:15)

> AI agents are starting to trade on Solana. They manage money, run vaults and sell signals.
> And every one of them says it's profitable.
> None of them can prove it.

## 2. The problem (0:15 to 0:45)

> Today an agent's track record is a screenshot, a backtest, or a leaderboard it reports itself.
> A backtest can be made with hindsight in seconds. Losing predictions get deleted. Winners get picked out after the fact.
> So when a vault, a copy-trading app or a launchpad wants to trust an agent, it has nothing to check.
> It has to trust the agent's own word.

## 3. The solution (0:45 to 1:20)

> Arena by Reins is the credit score for AI trading agents.
> An agent records every prediction on Solana before the market moves. Only a fingerprint goes on-chain, so nobody can copy it early.
> When time is up, the agent reveals it. We score it against real market prices, after fees.
> A prediction that is never revealed counts as the worst possible result. So hiding losers doesn't help.
> Nothing can be faked, deleted or cherry-picked. And anyone can rebuild any score themselves.
> The score is stored as an on-chain account. Any Solana program can read it.
> A vault can say: only agents scoring 70 or more may manage this money. And it can check that in its own code.

## 4. Why Solana (1:20 to 1:45)

> Solana is where AI agents trade. That's where the agents, the vaults and the agent frameworks are.
> A prediction confirms in about 400 milliseconds, and costs a fraction of a cent.
> Our relayer pays that fee, so an agent needs no SOL to start.
> And because scores are plain accounts, other programs can compose with them. That's what makes it infrastructure and not just a website.

## 5. Traction (1:45 to 2:10)

> This isn't a slide. Arena is already live on Arc mainnet at app.reins.one.
> The contract went live on October 11, 2026. Three house agents, each with an on-chain identity, record predictions every four hours.
> Scores are posted on-chain, and one command rebuilds any of them from public data.
> [TODO: confirm] So far: [N] predictions recorded, [N] revealed, [N] agents scored.
> [TODO: confirm] [N] outside agents connected, if any.
> For this hackathon we ported it to Solana. The program runs on devnet, with tests, and agents connect in one line through MCP.

Facts behind this section (check before recording):
- Arena contract on Arc mainnet: `0xBb3a454E3C15C548791170F769A4F9A0C2813368`, deployed 2026-10-11 (`deployments/callbook-mainnet.json`).
- House agents: Hot list, Cold list, Coin flip, with ERC-8004 agent ids 2364, 2365, 2366 (`deployments/callbook-mainnet-books.json`).
- Every 4 hours is the house agents' period on mainnet.
- Counts of predictions, reveals and outside agents: read them from app.reins.one/arena on the day. Do not guess.
- If `@onreins/mcp` is not yet published on npm, don't say "one line" for Arc; say it for the Solana demo build only. [TODO: confirm]

## 6. Business model (2:10 to 2:35)

> Once skill can be proven, it can be paid for.
> Next, we're building a marketplace. Agents with proven records sell subscriptions to their predictions.
> The seller posts a bond. If an agent hides a prediction, the bond pays its subscribers back.
> Arena takes a fee on each subscription. [TODO: confirm fee before stating a number]
> We're also planning a paid scoring API, for funds and launchpads that need to check many agents at once.
> Both are planned. The record comes first, and it's live.

## 7. Team (2:35 to 2:50)

> We're [TODO: team names and one line each].
> [TODO: one line on relevant background, e.g. what each person has shipped before.]
> We built Reins on Arc: rule-bound trading agents and Arena. Now we're bringing Arena to Solana.

## 8. Close (2:50 to 2:55)

> Don't trust an agent's claims. Check its record.
> Arena by Reins. [TODO: repo or site link to show on screen]

---

## Word check

Use: prediction, record, score, agent, "recorded before the market moves", "anyone can check the math", planned.

Avoid: guaranteed, returns, profits, alpha, trustless (as a bare claim), "most trusted". Avoid "lock a call" outside the technical demo.
