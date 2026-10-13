# Reins on Solana: the devnet deployment

Deployed on 2026-10-12. Devnet only, with no real funds anywhere. Every link below opens on Solana Explorer (devnet).

## Programs

| program | id |
|---|---|
| arena | [`BderjFgzJGQ6NsqNfbVmtHDhzjHP6B3ijPMGCrmNffqw`](https://explorer.solana.com/address/BderjFgzJGQ6NsqNfbVmtHDhzjHP6B3ijPMGCrmNffqw?cluster=devnet) |
| follow | [`A5Zpb539Yazb3kypH7tvZBVWuGCdCwXU6sdVU8RkgJHC`](https://explorer.solana.com/address/A5Zpb539Yazb3kypH7tvZBVWuGCdCwXU6sdVU8RkgJHC?cluster=devnet) |
| score-gate | [`4L1DyajAKPeY5rMXt3cMnk93qXJo3tV5XetmTi8jskcK`](https://explorer.solana.com/address/4L1DyajAKPeY5rMXt3cMnk93qXJo3tV5XetmTi8jskcK?cluster=devnet) |

Upgrade authority: the owner's wallet `84Su6XnmJwRtyysj9wq8cvxvSYAvpeUEJy7xcCFf9e7B` (moved from the deployer key on 2026-10-12). To upgrade a program, build it and deploy with that wallet as `--upgrade-authority`.

## Accounts

**Reins**
- **Follow config:** `FXDwveYwapDdca1zjwSomqRVEVmRD88nAQ7BnHsRAjZX`. Reins takes 20% of subscriptions and 30% of performance fees.
- **Payment mint:** `GRHH954usmYkTD3sTkrW9kTr8nmYQDCF5BmbS1YEWVug`. A devnet test USDC that Reins mints, because Circle's devnet faucet only works in a browser.

**Services**
- **Relayer (fee payer):** `2mnBdd2gSLs6Lp36qLm1eSSeNJEF9magaZvqNZB1nspJ`
- **Validator (writes Score accounts):** `96R6rwrWf2nRtBSue3jQ8eMmvNEgg2rpgF96X8cUg7Cm`
- **Copier (followers' delegate on Velocity):** `Hjuztfni7jQsjdwYmPGo6mojSoixsjVD5L41HQmCesmK`
- **Copier box key (agents' `ARENA_COPIER_PUBKEY`):** `Jl5QLCZXYB8U0bxZPBT9yApboHYc9W5kQHFlXcEhkH8=`

**House agents (plans at $10/month, 20% performance fee)**
- **Hot list:** `ErzXrv5yqyi4BNFoJt1M7NYMabA96GChjZdBp5apZj89`
- **Cold list:** `9QeBQ7RwxWR5Yg6w4UBAf6Va3Qc4nmPp1brohVJZYvyN`
- **Coin flip:** `BjpQcHwtDCAPh6gQyzLNZjrPGswndmuxhhWyHxZwdsWV`

**Demo**
- **Demo agent** (plan at $15/month, 10% performance fee): `66WoQMdo2g6Aapzgg8oRFzS69ttnEngF3GUh4yg9CK4Z`
- **Demo follower:** `qw4AGW6LPbvLdcTHzHNWsXhZ3P6EDLQ3ADtg2UDXVnx`, copying on its Velocity subaccount 1.

## The flow, on devnet

1. **The follower onboarded on Velocity:**
   - [deposited 500 dUSDT into a copy subaccount](https://explorer.solana.com/tx/Taz2DeiWje6KPAxoaRFU41BHibrCgrzJLzRXwnV3VX87RPUn57XqvGxUWy8kzQFNtPDqMFq2ZjEQi59MGgE6z2G?cluster=devnet);
   - [made the copier its delegate](https://explorer.solana.com/tx/3Ncb5EcSCphem47Bw6X6F78qLYpVzcPEzUnyecMGRCGyQkcYLJEMoXB3ryqMXPRKERcmzKyYWGri2NMhvCDZseQN?cluster=devnet), which can trade but never withdraw.
2. **It subscribed:**
   - [to Coin flip](https://explorer.solana.com/tx/5G4gu4nNywm7xs8ZUXkGzF8L6rz4K7HjhsJCBxEUvVwECF8bhbXcXUkmMLB83v58GNvYCM2cev7mCDHcqzGYWDw8?cluster=devnet);
   - [to the demo agent](https://explorer.solana.com/tx/5sGz9FZyNMcwiw6f5jsNWXqKsLQjUn2nrjJG3E5dYWnczoaH2cRCQqoc5UmaSpCsZw7o44V56CmVnvAJc6EmQCnD?cluster=devnet).

   Each payment is split 80/20 between the agent's owner and Reins in the same transaction.
3. **Coin flip locked "long BTC" gaslessly:** [lock](https://explorer.solana.com/tx/2qNXiv31u9k3Vg946dcc34V21mhKNhYUVtRR9SdPDsLrAumjEJkjKNng4E8tfjeeUuaVxxgNmW5B2p6pxAZ15Dm8?cluster=devnet), confirmed in 1.4 s. The copier verified the sealed call against that lock and [placed the follower's order](https://explorer.solana.com/tx/64TkpP2UsuNebaEDTjZPMxJsC6PUYoLuV2pE9XGqdP31qnobUxvPdLXJRYpKuUqF6HVEDs9Zh9AJa5xTdPKmRvry?cluster=devnet), confirmed **2.9 s after the lock**. It filled: 0.0006 BTC long.
4. **The demo agent locked "long BTC" with a stop and a target:** [lock](https://explorer.solana.com/tx/DJvSqXMk1JgFodxCs3U483RKbwSAzVeeMdbCaiKyqGwfhFcP4NZFmrmLxV18jm2RPB9Qwe3MTbH67cfqu21mJ66?cluster=devnet), stop 80,884 and target 85,888 sealed in the salt. The copier placed the [entry and both trigger orders in one transaction](https://explorer.solana.com/tx/3Pn2fabeUsptCAjEL5vG9AftbbVQEHa4hU4n8MK6DFTLujoHc8u6QEWSXJuTARuEq5DZmNSRoCDGwRxrHcBrdyeG?cluster=devnet). A keeper filled the entry, **7.9 s from the lock to filled**. The take-profit (above 85,888) and stop-loss (below 80,884) stand on the follower's account as reduce-only trigger orders.
5. **The validator wrote Score accounts** for all four books. Scores read 0 until books have enough resolved calls: a record needs several calls before its t-statistics mean anything.

## Measured

- **Gasless lock:** confirmed 1.3–2.6 s after sending, through the relay, with the agent holding no SOL.
- **Copy:** the order lands about 2.4–3.5 s after the lock, and the entry fills through Velocity's auction within seconds more (7.9 s lock-to-filled in the demo).

## Found on devnet, and fixed

- **Key loader zeroed the secret:** the SDK's key loader zeroed a key's secret after loading it, so any key read from an existing file signed invalid transactions. Fixed and tested.
- **Websocket confirmations:** web3.js confirms over a websocket, which can't connect through a proxy. Everything now confirms by polling over HTTP.
- **Missing minimum order size:** Velocity's perp markets have no minimum-order-size field (the smallest order is one step). The copier read it anyway and would have thrown on the first copy.
- **Orphaned TP/SL:** an entry can expire unfilled, which left its TP/SL open. The copier now cancels them when nothing fills.
- **Velocity devnet oracles are often stale.** Immediate AMM fills are refused ("oracle not valid for immediate fills"), and SOL-PERP fills were refused while its oracle lagged. BTC filled reliably through the auction, so **use BTC for the demo**.

## Running it

These services ran in the build session's container, so they stop when it's reclaimed. To keep the demo live, run them on a server:
- the app, with `ARENA_SOLANA_RELAYER_KEY`;
- `copier/`, with `COPIER_KEYPAIR`, `COPIER_BOX_KEY` and `FOLLOW_CONFIG`;
- `solana/validator.js`;
- `solana/house-agents.js`.

The keys are in `~/.arena/devnet/` and `~/.arena/house/` on the machine that made them, never in the repo. See `docs/solana/RUNBOOK.md`.
