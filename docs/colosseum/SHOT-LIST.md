# Shot list

For both videos. Scripts: `PITCH-SCRIPT.md` and `DEMO-SCRIPT.md`. Durations are targets; aim for about 3:00 each.

General:
- Record at 1080p or higher. Use a large terminal and editor font.
- Hide keys, `.env` values, key files and private dashboards. Check every frame before export.
- Show real data only. Fill every `[TODO]` and `<PLACEHOLDER>` before recording.
- Label the Solana build "devnet" on screen.
- Captions are worth adding; many judges watch muted.

## Pitch video

| # | Time | Duration | On screen | Voiceover cue |
|---|---|---|---|---|
| P1 | 0:00 | 0:15 | Speaker on camera, or title card "Reins" | "AI agents are starting to trade..." |
| P2 | 0:15 | 0:25 | Text cards: "Screenshot", "Backtest", "Self-reported". Losing rows fading out of a table. Then "Trust the screenshot" → "Hand over your money" | "Today an agent's track record is a screenshot..." |
| P3 | 0:40 | 0:15 | Three steps: Recorded before the market moves → Revealed → Scored against real prices | "First, a record that can't be faked..." |
| P4 | 0:55 | 0:25 | Diagram: agent → Arena on Solana → copier → follower A / B Velocity copy subaccounts. Delegate arrow labelled "can trade, can't withdraw" | "Second, copying without custody..." |
| P5 | 1:20 | 0:20 | Copier log with per-follower latency; a copied order on Solana Explorer (devnet) | "Copying only works if followers get in at the agent's price..." |
| P6 | 1:40 | 0:25 | app.reins.one/arena live on Arc mainnet: leaderboard and one agent's record; the contract on Arc's explorer | "This isn't a slide. Arena is already live on Arc mainnet..." |
| P7 | 2:05 | 0:35 | Three streams diagram (subscription split, performance fee above high-water mark, order fee), then the per-follower table from `BUSINESS-MODEL.md` with "Assumptions" visible | "Reins earns three ways..." |
| P8 | 2:40 | 0:12 | Team photos with names and one line each | "We're [team]..." |
| P9 | 2:52 | 0:08 | End card: "Don't trust an agent's claims. Check its record." plus link | "Don't trust an agent's claims..." |

## Technical demo video

| # | Time | Duration | On screen | Voiceover cue |
|---|---|---|---|---|
| D1 | 0:00 | 0:12 | Arena leaderboard in Solana devnet mode | "This is Reins on Solana devnet..." |
| D2 | 0:12 | 0:18 | Terminal: `claude mcp add` line with `ARENA_NETWORK=solana-devnet`; `/mcp` tool list; agent wallet at 0 SOL | "The agent connects through MCP..." |
| D3 | 0:30 | 0:12 | Claude chat: `arena_lock` SOL long, 5 minutes; result with `<LOCK_SIG>` | "Only a hash goes on-chain..." |
| D4 | 0:42 | 0:13 | Explorer: the lock tx; zoom on program id and relayer as fee payer | "The entry time comes from Solana's clock..." |
| D5 | 0:55 | 0:15 | Copier log: preimage verified; follower A and B copied with latency; follow C skipped (not paid) | "The copier checks it against the hash on-chain..." |
| D6 | 1:10 | 0:15 | Explorer: `<COPY_SIG_A>` on Velocity; signer is the copier; entry + two reduce-only trigger orders | "One transaction: the entry, then the stop-loss and take-profit..." |
| D7 | 1:25 | 0:10 | Follower A's copy subaccount: open position, two resting trigger orders, delegate field | "It can place and cancel orders. It can't withdraw..." |
| D8 | 1:35 | 0:05 | On-screen clock jumping past 5 minutes (edited cut) | (none) |
| D9 | 1:40 | 0:12 | Claude chat: `arena_reveal_due`; Explorer: reveal tx with the event log | "The reveal sends the coin, side and salt..." |
| D10 | 1:52 | 0:13 | Terminal: scorer run; Explorer: Score account fields; `arena_verify` result | "The scorer grades revealed predictions..." |
| D11 | 2:05 | 0:15 | Explorer: `<SUB_SIG>` with two token transfers (agent owner, treasury); Follow account fields | "One transaction, two transfers..." |
| D12 | 2:20 | 0:15 | Explorer: `<SETTLE_SIG>` with the PerformanceSettled event (pnl, high-water mark before/after, fee split) | "The performance fee is charged only above the follower's previous peak..." |
| D13 | 2:35 | 0:15 | Optional: editor with the two score-gate lines; gate passes, then `ScoreTooLow` | "Any Solana program can use the record..." |
| D14 | 2:50 | 0:10 | README "Reins on Solana" section; end card | "A record that can't be faked..." |

## Assets to prepare

- Logo and end card ("Reins", with "Arena by Reins" where the record is shown).
- Three-step record diagram.
- Copy-trading diagram: agent → copier → followers' own Velocity subaccounts, delegate "can trade, can't withdraw".
- Revenue diagram and per-follower table (from `BUSINESS-MODEL.md`), with assumptions visible.
- Team photos.
- Devnet signatures and addresses from the take you keep, for the description and README.
