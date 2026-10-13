# Pitch video script (about 3 minutes)

For the Colosseum submission. The person records it; the shot list is in `SHOT-LIST.md`, the numbers come from `BUSINESS-MODEL.md`.

Rules for the recording:
- Say only what is true on the day you record. Anything marked `[TODO: confirm]` must be checked or cut.
- The Solana programs run on **devnet**. Say "devnet" whenever the Solana build is on screen. Mainnet copying is not live.
- No promises of profit. A score describes past predictions, not future results. Keep "not investment advice".
- Revenue numbers are examples built on stated assumptions. Say "for example" or "assume".
- Say "Velocity, formerly Drift" the first time the exchange comes up.

Total: about 3:00. Read at a calm pace (about 150 words a minute).

---

## 1. Hook (0:00 to 0:15)

> AI agents are starting to trade. Some sell their signals, and some let you copy them.
> Every one of them says it's profitable.
> None of them can prove it.

## 2. The problem (0:15 to 0:40)

> Today an agent's track record is a screenshot, a backtest, or a leaderboard it reports itself.
> A backtest can be made with hindsight. Losing trades get deleted.
> And copying a bot usually means two leaps of faith: trust the screenshot, then hand over your money.

## 3. Reins (0:40 to 1:20)

> Reins fixes both.
> First, a record that can't be faked. Arena by Reins records every prediction on Solana before the market moves. When time is up, it's revealed and scored against real prices. A prediction that's never revealed counts as its worst result, so hiding losers doesn't help. Anyone can check the math.
> Second, copying without custody. A follower keeps their own account on Velocity, formerly Drift, a perps exchange on Solana. They give Reins permission to place orders on one subaccount. It can trade. It can never withdraw. They can revoke it any time, from Velocity itself.
> When the agent records a prediction, the same trade lands on every follower's account, with the stop-loss and take-profit placed as real orders.
> A proven record, then one click to copy.

## 4. Why Solana (1:20 to 1:40)

> Copying only works if followers get in at the agent's price, not a minute later.
> On Solana, a copied order confirms within seconds of the agent's prediction. [TODO: confirm the measured latency on devnet and say the real number.]
> Fees are a fraction of a cent, so a relayer pays them. An agent needs no SOL to start.
> And the record is plain on-chain accounts. Any Solana program can read an agent's score. A vault can admit only agents scoring 70 or more, in its own code.

## 5. Traction (1:40 to 2:05)

> This isn't a slide. Arena is already live on Arc mainnet, at app.reins.one.
> Three house agents, each with an on-chain identity, record predictions every four hours, and one command rebuilds any score from public data.
> [TODO: confirm] So far: [N] predictions recorded and [N] agents scored.
> For this hackathon we built the Solana version: three programs, a copier service, and the same MCP tools, all tested and running on devnet.

Facts behind this section (check before recording):
- Arena contract on Arc mainnet: `0xBb3a454E3C15C548791170F769A4F9A0C2813368`, deployed 2026-10-11 (`deployments/callbook-mainnet.json`).
- House agents: Hot list, Cold list, Coin flip, with ERC-8004 agent ids 2364, 2365, 2366 (`deployments/callbook-mainnet-books.json`).
- Every 4 hours is the house agents' period on mainnet.
- Counts: read them from app.reins.one/arena on the day. Do not guess.
- "Running on devnet" is only true once the programs are deployed. Until then, say "built and tested, deploying to devnet". [TODO: confirm]

## 6. Business model (2:05 to 2:40)

> Reins earns three ways, and all three are in the code.
> One: subscriptions. An agent's owner sets a monthly price in USDC. Each payment is split between the agent's owner and Reins in the same transaction.
> Two: a performance fee, only on profit above the follower's previous peak. It's capped by an allowance the follower sets and can revoke.
> Three: a small fee on each copied order, up to 10 basis points, through Velocity's builder codes.
> For example: assume a 20 dollar subscription with Reins taking 20 percent, and a 5 basis point order fee. That's about 9 dollars a month per follower to Reins. A thousand followers is about 110 thousand dollars a year. Agent owners earn about twice that.
> Those are assumptions, not results. The model is in our repo.

Before recording: if builder codes aren't confirmed on the network you show, drop "Three" and say "about 4 dollars a month per follower, about 50 thousand a year at a thousand followers" instead.

## 7. Team (2:40 to 2:52)

> We're [TODO: team names and one line each].
> [TODO: one line on relevant background.]

## 8. Close (2:52 to 3:00)

> Don't trust an agent's claims. Check its record. Then copy it, without handing over your money.
> Reins. [TODO: repo or site link on screen]

---

## Word check

Use: prediction, record, score, agent, follow, copy, "recorded before the market moves", "anyone can check the math", "your own account", devnet, "for example", "assume".

Avoid: guaranteed, returns, profits (as a promise), alpha, trustless (as a bare claim), "most trusted", "passive income". Avoid "lock a call" outside the technical demo.
