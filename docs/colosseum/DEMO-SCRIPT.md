# Technical demo video script (about 3 minutes)

For the Colosseum submission. Shows the real flow on Solana devnet: an agent records a prediction through MCP, the copier places it on followers' own Velocity (formerly Drift) accounts within seconds with take-profit and stop-loss attached, the prediction is revealed and scored, and the subscription and fee split are shown on-chain.

No mock data. Every transaction in the video is a real devnet transaction with an Explorer link.

## Placeholders to fill before recording

The programs are **deployed on devnet** (2026-10-12). Live accounts and transactions: `docs/solana/DEVNET.md`. Record on **BTC**: Velocity devnet's SOL oracle lags and SOL fills were refused.

| Placeholder | What it is | Reserved today |
|---|---|---|
| `<ARENA_PROGRAM_ID>` | Arena program on devnet | `BderjFgzJGQ6NsqNfbVmtHDhzjHP6B3ijPMGCrmNffqw` |
| `<FOLLOW_PROGRAM_ID>` | Follow program (plans, subscriptions, performance fees) | `A5Zpb539Yazb3kypH7tvZBVWuGCdCwXU6sdVU8RkgJHC` |
| `<SCORE_GATE_PROGRAM_ID>` | Score-gate example program | `4L1DyajAKPeY5rMXt3cMnk93qXJo3tV5XetmTi8jskcK` |
| `<VELOCITY_PROGRAM_ID>` | Velocity Exchange | `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P` (same id on devnet and mainnet) |
| `<COPIER_PUBKEY>` (`Hjuztfni7jQsjdwYmPGo6mojSoixsjVD5L41HQmCesmK`) | The copier: followers' delegate and fee payer for copied orders | |
| `<BOOK>`, `<SCORE_ACCOUNT>` | The demo agent's record account and Score account (`["score", validator, book]`) | |
| `<PLAN>`, `<FOLLOW_A>`, `<FOLLOW_B>` | The demo agent's Plan and two followers' Follow accounts | |
| `<LOCK_SIG>`, `<COPY_SIG_A>`, `<COPY_SIG_B>`, `<REVEAL_SIG>`, `<SCORE_SIG>`, `<SUB_SIG>`, `<SETTLE_SIG>`, `<GATE_SIG>` | Signatures from the take you keep | |
| `<LATENCY_MS>` | Copier log: lock to confirmed copy, per follower | about 2,900 ms on devnet (order landed); about 7.9 s lock to filled |
| `<SCORE_CMD>`, `<SETTLE_CMD>` | Commands that write the Score account and settle a performance fee | [TODO: confirm the real scripts] |

Explorer links: `https://explorer.solana.com/tx/<SIG>?cluster=devnet` and `https://explorer.solana.com/address/<ADDR>?cluster=devnet`.

## Before you hit record

- **Programs deployed** to devnet, a Config initialised (Reins share of subscriptions and of performance fees set), and the demo agent's Plan set (for example $20 a month, 10% performance fee, in devnet USDC).
- **MCP server** added to Claude Code with `ARENA_NETWORK=solana-devnet`. The agent's keypair file is `0600` and holds **no SOL**; never show its contents. `ARENA_COPIER_URL` and `ARENA_COPIER_PUBKEY` are set so each lock's preimage is sealed to the copier.
- **Copier running** (`copier/`, `npm start`) with `FOLLOW_CONFIG` pointing at the Config, against a private devnet RPC (the public one rate-limits). Its log is on screen; it prints public keys only.
- **Two followers onboarded ahead of time**, each with:
  - a Velocity devnet account funded with dUSDT from the faucet;
  - a dedicated copy subaccount whose delegate is `<COPIER_PUBKEY>`;
  - a paid Follow account (this is `<SUB_SIG>`), with size and limits set;
  - a USDC allowance granted to their Follow account, for performance fees.
- **A third follow that is unpaid or stopped**, to show the copier skipping it.
- **Coin:** SOL, BTC or ETH only. Velocity devnet lists just these three perps.
- **Horizon:** the program's minimum is 5 minutes. Use 5 minutes and cut the wait.
- **A house agent that's already scored** (for the optional score-gate beat), and one with a low score.
- Browser tabs: Solana Explorer (devnet), Velocity devnet account views for both followers [TODO: confirm a devnet UI exists; otherwise use Explorer and the Following page], the Arena page in Solana mode.
- Terminal font large. Hide keys, tokens, `.env` values and key files.
- **Builder fee:** only mention it if `builder_codes_enabled` is confirmed on devnet and the copied tx shows it.

Total: about 3:00.

---

## 1. Intro (0:00 to 0:12)

On screen: Arena leaderboard in Solana devnet mode.

> This is Reins on Solana devnet. An AI agent will record a prediction, and two followers will get the same trade on their own Velocity accounts within seconds. Then it's revealed, scored, and you'll see who got paid, on-chain.

## 2. The agent connects (0:12 to 0:30)

On screen: terminal, then Claude Code `/mcp`.

Show: `claude mcp add reins -e ARENA_NETWORK=solana-devnet -- npx -y @onreins/mcp` [TODO: confirm a published package includes the Solana backend; otherwise show `ARENA_NETWORK=solana-devnet npm run callbook:mcp` from the repo]

> The agent connects through MCP, with the same tools as on Arc. Its key has no SOL. A relayer pays the fee, and it only co-signs transactions that contain nothing but Arena instructions.

Show: the tool list (`arena_lock`, `arena_reveal_due`, `arena_status`, `arena_verify`, `arena_profile`) and the agent wallet at 0 SOL.

## 3. Record a prediction (0:30 to 0:55)

On screen: Claude chat, with the copier log visible beside it.

Prompt:

> Use arena_lock: SOL long, 5 minute horizon, with a stop and a target.

> Only a hash goes on-chain. The entry time comes from Solana's clock, so it can't be backdated, and nobody can read the prediction until it's revealed.

Show: `<LOCK_SIG>` in the tool result, then Explorer: program `<ARENA_PROGRAM_ID>`, fee payer is the relayer.

## 4. Followers' orders land (0:55 to 1:35)

On screen: copier log, then Explorer.

> At the same moment, the agent sealed the full prediction to the copier. The copier checks it against the hash on-chain before it trades anything. It can only copy what was actually committed.

Point at the log lines: preimage verified; follower A copied in `<LATENCY_MS>` ms; follower B copied in `<LATENCY_MS>` ms; follow C skipped, not paid.

> Two paid followers, copied in about `<LATENCY_MS>` milliseconds from the lock. The unpaid one is skipped.

Open `<COPY_SIG_A>` on Explorer: program `<VELOCITY_PROGRAM_ID>`, signer `<COPIER_PUBKEY>` as delegate, one transaction with the market entry plus two reduce-only trigger orders.

> One transaction: the entry, then the stop-loss and take-profit as real reduce-only orders on Velocity. Each follower's size and limits are checked first: size per trade, open copied positions, and a daily loss cap.

Show follower A's copy subaccount: the open SOL position and the two resting trigger orders.

> The copier is a delegate on this one subaccount. It can place and cancel orders. It can't withdraw. The follower can revoke it from Velocity at any time. The money never leaves their account.

## 5. Reveal and score (1:35 to 2:05)

Cut the 5-minute wait; keep an on-screen clock.

Prompt:

> Use arena_reveal_due.

> The reveal sends the coin, side and salt. The program checks they match the hash, and the event carries the salt, so any scorer can read it.

Show: `<REVEAL_SIG>` on Explorer.

Show: `<SCORE_CMD>`, then `<SCORE_SIG>` and the `<SCORE_ACCOUNT>` fields.

> The scorer grades revealed predictions against real prices, after fees, and writes a Score account. A prediction that's never revealed counts as its worst result along the price path. `arena_verify` rebuilds the score from chain data and public prices.

## 6. Who got paid (2:05 to 2:35)

On screen: Explorer.

Open `<SUB_SIG>` (follower A's subscription).

> Here's follower A's subscription. One transaction, two transfers: most to the agent's owner, the rest to the Reins treasury, at a fixed rate. The Follow account records paid-until, size and limits.

Open `<FOLLOW_A>` and point at paid-until and settings.

Open `<SETTLE_SIG>` (after `<SETTLE_CMD>`).

> The performance fee is charged only above the follower's previous peak. We measure the copy subaccount's profit off-chain, and the program applies the high-water mark, splits the fee and records it. It's paid from an allowance the follower set on their own USDC account, so it can never exceed what they approved, and they can revoke it.

If the builder fee is confirmed on devnet, add:

> And each copied order carries a small Velocity builder fee, at most 10 basis points.

## 7. Optional: another program reads the score (2:35 to 2:50)

On screen: editor with `programs/score-gate/src/lib.rs`, then Explorer.

```rust
let s = arena_score::read_score(&ctx.accounts.score, &validator, &agent)?;
require!(s.score >= min_score, GateError::ScoreTooLow);
```

> Any Solana program can use the record. This example admits an agent only if its Arena score is at least a minimum. The `arena-score` crate checks the account really is Arena's.

Show: `<GATE_SIG>` succeeding for the high-scoring agent, and `ScoreTooLow` for the low one.

Cut this section if time is short.

## 8. Close (2:50 to 3:00)

On screen: README "Reins on Solana" section with the program ids.

> A record that can't be faked. Copies within seconds. The follower's money stays in the follower's account.
> Don't trust an agent's claims. Check its record.

---

## If something fails on the take

- Don't edit a failure into a success. Re-record the step.
- Say the real latency, whatever it is. Don't trim it.
- If the relayer is rate-limited, wait or use another demo key; don't raise limits for the video.
- If Velocity devnet was wiped or changed, re-run follower onboarding before recording.
