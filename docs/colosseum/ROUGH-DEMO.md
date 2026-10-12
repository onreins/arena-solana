# Rough demo: the Arc video plus a Solana section

About 3 minutes. Keep most of the Arc video ("Reins - Dorahacks Grant on Arc") and replace its Arc-specific middle with about 75 seconds of Solana footage.

## From the Arc video, keep

- **The intro and the problem:** agents' records are self-reported, and copying a bot means trusting a screenshot.
- **How Arena works:** commit before the market moves, reveal after, score against real prices, nothing deleted.
- **The scoring explanation and the leaderboard idea.**
- **The team and the close.**

**Cut** anything that says Arc mainnet, ERC-8004, USDC gas or mandates, or point at it as "where it started". One line covers it: "Arena is live on Arc. This is the Solana version."

## New Solana section (about 75 s)

Clips are in `.screens/clips/`: silent 1280×720 recordings of the Solana site.

| # | clip | length | voiceover |
|---|---|---|---|
| 1 | `1-home.mp4` | ~20 s | "Reins on Solana. The same proof of skill for AI trading agents, now with copy-trading on Velocity, formerly Drift." |
| 2 | `2-agent-record.mp4` | ~25 s | "Every call is locked on Solana before the market moves. The agent pays no fees: a relayer covers them, and a lock confirms in about a second and a half. Here's an agent's record: each call with its stop and target, scored against real prices." |
| 3 | `3-copy-dialog.mp4` | ~20 s | "Like it? Copy it. Your money stays in your own Velocity account. Our copier is only a delegate: it can trade, never withdraw. You set the size and limits. The subscription is paid on-chain, split between the agent's owner and Reins in the same transaction." |
| 4 | your Explorer clip (below) | ~10 s | "When the agent locks a call, the copier checks it against the on-chain lock and places it on your account about three seconds later, with the stop-loss and take-profit as real orders." |

## Record these yourself (Explorer blocks automated browsers)

Open each link in your browser and screen-record about 10 seconds, scrolling to the instructions.

1. **The agent's gasless lock** (fee paid by the relayer):
   https://explorer.solana.com/tx/DJvSqXMk1JgFodxCs3U483RKbwSAzVeeMdbCaiKyqGwfhFcP4NZFmrmLxV18jm2RPB9Qwe3MTbH67cfqu21mJ66?cluster=devnet
2. **The copied order on Velocity**: one transaction with the entry, the take-profit and the stop-loss:
   https://explorer.solana.com/tx/3Pn2fabeUsptCAjEL5vG9AftbbVQEHa4hU4n8MK6DFTLujoHc8u6QEWSXJuTARuEq5DZmNSRoCDGwRxrHcBrdyeG?cluster=devnet
3. **The subscription, split 80/20 on-chain** (the token balance changes show it):
   https://explorer.solana.com/tx/5sGz9FZyNMcwiw6f5jsNWXqKsLQjUn2nrjJG3E5dYWnczoaH2cRCQqoc5UmaSpCsZw7o44V56CmVnvAJc6EmQCnD?cluster=devnet

## Optional, if there's time

Show the MCP side, an agent in Claude locking a call. It needs the services running. Ask, and they can be brought up for a recording window.
