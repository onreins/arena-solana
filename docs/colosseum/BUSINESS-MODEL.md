# Business model (one page)

Reins on Solana earns three ways, and all three are in the code: subscriptions, a share of the performance fee, and a small fee on copied orders. Reins never holds follower money, so none of this depends on custody.

Every number below that isn't read from the code is an **assumption**, labelled as one. Nothing here is a forecast of anyone's trading results.

## Who pays whom

| Stream | Who pays | Who receives | Where it happens | Status |
|---|---|---|---|---|
| **Subscription** | Follower, monthly, in USDC | Agent owner and Reins treasury, split in the same transaction | `follow` program, `subscribe` | Built and tested |
| **Performance fee** | Follower, only on profit above their high-water mark | Agent owner and Reins treasury, split in the same transaction | `follow` program, `settle_performance`, from an allowance the follower grants | Built and tested; profit measured off-chain |
| **Order fee** | Follower, per copied order | Reins | Velocity builder code on each delegate-placed order | Built; whether builder codes are switched on for Velocity devnet is **unconfirmed** |

## Pricing and take rates

What the code fixes, and what we would set:

| Item | In the code | Our example setting (assumption) |
|---|---|---|
| Subscription price | Set per agent by its owner (`set_plan`) | **$20 a month** |
| Reins share of each subscription | Fixed per config (`reins_bps`), at most 50% | **20%** (agent owner keeps 80%) |
| Performance fee rate | Set per agent by its owner (`perf_fee_bps`), at most 50% | **10%** of new profit above the high-water mark |
| Reins share of the performance fee | Fixed per config (`perf_reins_bps`), at most 50% | **20%** (agent owner keeps 80%) |
| Order fee | Velocity caps builder fees at 10 bps per order | **5 bps**, only if builder codes are enabled |

The agent owner earns most of the money. That's deliberate: good agents need a reason to list.

## Simple revenue projection

Per paying follower, per month, with the settings above and these **assumptions**:

- **Assumption:** each follower subscribes to one agent at $20 a month.
- **Assumption:** each copy subaccount holds about $1,000 and copies about $10,000 of notional a month (entry orders; take-profit and stop-loss exits counted in that figure).
- **Assumption:** the average follower makes $10 a month of new profit above their high-water mark. Many will make none, and some will lose money. This is a placeholder to show the mechanism, not an expected return.

| Per follower per month | Follower pays | Agent owner gets | Reins gets |
|---|---|---|---|
| Subscription | $20.00 | $16.00 | $4.00 |
| Performance fee (10% of $10) | $1.00 | $0.80 | $0.20 |
| Order fee (5 bps of $10,000) | $5.00 | — | $5.00 |
| **Total** | **$26.00** | **$16.80** | **$9.20** |

At three scales (**assumption:** paying followers, averaged over a year):

| Paying followers | Reins per month | Reins per year | Reins per year without the order fee | Paid to agent owners per year |
|---|---|---|---|---|
| 100 | $920 | $11,040 | $5,040 | $20,160 |
| 1,000 | $9,200 | $110,400 | $50,400 | $201,600 |
| 10,000 | $92,000 | $1,104,000 | $504,000 | $2,016,000 |

The "without the order fee" column is the case where builder codes aren't available. Subscriptions alone carry most of the model.

## Unit economics

- **Gasless agents cost us SOL.** The relayer pays fees and rent so agents need no SOL. A first lock costs about **0.003 SOL**: about 10,000 lamports of fees, about 0.00178 SOL of rent for the prediction's account, and about 0.0013 SOL of rent for the agent's record account, opened once. Later locks skip the record account, so they cost about 0.0018 SOL. [TODO: confirm on devnet; confirm whether any rent is ever reclaimed.]
- **Assumption:** at $150 per SOL, a first lock costs about $0.47 and a later one about $0.27. An agent recording a prediction every 4 hours costs about $1.60 a day. The relayer keeps limits per key so this can't be drained; a free tier with a cap, and paid agents lifting it, is one option.
- **The copier pays the fee on each copied order** (it signs as the follower's delegate). [TODO: measure per-order cost on devnet, including any priority fee.]
- **Optional onboarding cost:** we can pay the rent for a follower's Velocity fee escrow, so they sign less. [TODO: measure.]
- At the assumed SOL price, one paying follower covers about 15 later locks a month without the order fee ($4.20 to Reins), or about 34 with it ($9.20). Price agent subsidies against that.

## What this model does not do

- Reins never takes custody. The delegate on a follower's Velocity account can place and cancel orders but cannot withdraw. Fees come from the follower's own USDC account, through payments they sign or an allowance they set and can revoke.
- The performance fee can never exceed the allowance the follower granted.
- Scores describe past predictions, not future results. Nothing in Reins is investment advice.

## Before mainnet

- Charging subscription and performance fees for trade signals may be regulated in some countries. Check this before mainnet, and before any marketing to the public.
- Confirm Velocity builder codes on the target network, and the final fee settings.
- Velocity mainnet is a whitelisted private beta today; copying on mainnet depends on its public launch.
