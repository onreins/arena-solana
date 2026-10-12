# Shot list

For both videos. Scripts: `PITCH-SCRIPT.md` and `DEMO-SCRIPT.md`. Durations are targets; aim for about 3:00 each.

General:
- Record at 1080p or higher. Use a large terminal and editor font.
- Hide keys, `.env` values, key files and private dashboards. Check every frame before export.
- Show real data only. Fill every `[TODO]` and `<PLACEHOLDER>` before recording.
- Captions are worth adding; many judges watch muted.

## Pitch video

| # | Time | Duration | On screen | Voiceover cue |
|---|---|---|---|---|
| P1 | 0:00 | 0:08 | Speaker on camera, or title card "Arena by Reins" | "AI agents are starting to trade on Solana..." |
| P2 | 0:08 | 0:07 | Quick montage: agent profit screenshots, a backtest chart, a self-reported leaderboard (generic or mocked, no real brands) | "...every one of them says it's profitable. None of them can prove it." |
| P3 | 0:15 | 0:30 | Simple text cards: "Screenshot", "Backtest", "Self-reported". Losing rows fading out of a table | "Today an agent's track record is a screenshot..." |
| P4 | 0:45 | 0:20 | Three-step diagram: Recorded before the market moves, Revealed when time is up, Scored against real prices | "Arena by Reins is the credit score for AI trading agents..." |
| P5 | 1:05 | 0:15 | A Score account box with an arrow to a "Vault: score >= 70" box | "The score is stored as an on-chain account. Any Solana program can read it..." |
| P6 | 1:20 | 0:25 | Solana Explorer showing a devnet lock with its confirmation time; fee payer highlighted as the relayer | "Solana is where AI agents trade... about 400 milliseconds..." |
| P7 | 1:45 | 0:25 | app.reins.one/arena live on Arc mainnet: leaderboard and one agent's record; then the contract on Arc's explorer | "This isn't a slide. Arena is already live on Arc mainnet..." |
| P8 | 2:10 | 0:25 | Marketplace mock clearly labelled **Planned**: subscribe button, seller bond, fee | "Once skill can be proven, it can be paid for..." |
| P9 | 2:35 | 0:15 | Team photos with names and one line each | "We're [team]..." |
| P10 | 2:50 | 0:05 | End card: "Don't trust an agent's claims. Check its record." plus repo/site link | "Don't trust an agent's claims. Check its record." |

## Technical demo video

| # | Time | Duration | On screen | Voiceover cue |
|---|---|---|---|---|
| D1 | 0:00 | 0:15 | Arena leaderboard in Solana devnet mode | "This is Arena running on Solana devnet..." |
| D2 | 0:15 | 0:10 | Terminal: the one-line `claude mcp add` install | "The agent connects through MCP. One line..." |
| D3 | 0:25 | 0:10 | Claude Code `/mcp` tool list with the five `arena_*` tools; agent wallet balance 0 SOL | "The agent's keypair has no SOL. It won't need any..." |
| D4 | 0:35 | 0:15 | Claude chat: prompt to `arena_lock` SOL long; tool result with signature and confirm time | "The agent calls arena_lock. Only a hash goes on-chain..." |
| D5 | 0:50 | 0:15 | Solana Explorer, devnet: the lock tx; zoom on program id and fee payer | "Confirmed in ... milliseconds... can't be backdated." |
| D6 | 1:05 | 0:15 | Claude chat: `arena_status` result with the open prediction and reveal time | "arena_status shows the open prediction..." |
| D7 | 1:20 | 0:05 | On-screen clock jumping past the horizon (edited cut) | (no voiceover, or "After the horizon...") |
| D8 | 1:25 | 0:20 | Claude chat: `arena_reveal_due` result, then Explorer for the reveal tx with the event log | "arena_reveal_due sends the coin, the side and the salt..." |
| D9 | 1:45 | 0:10 | Terminal: scorer run against devnet | "The scorer grades revealed predictions..." |
| D10 | 1:55 | 0:15 | Explorer: Score account fields; Arena record page; Claude `arena_verify` and `arena_profile` results | "arena_verify rebuilds the score from chain data..." |
| D11 | 2:10 | 0:15 | Editor: score-gate source, the three gate lines highlighted | "This is a separate example program, the score gate..." |
| D12 | 2:25 | 0:10 | Terminal + Explorer: gate call for the high-scoring agent succeeds | "This agent scores ... It passes." |
| D13 | 2:35 | 0:10 | Terminal: gate call for the low-scoring agent fails with `ScoreTooLow` | "This one scores ... Refused." |
| D14 | 2:45 | 0:15 | README top: program id, install line; end card | "Recorded in under a second... Check its record." |

## Assets to prepare

- Logo and end card ("Arena by Reins").
- Three-step diagram (also usable in the README).
- Score account to vault diagram.
- Marketplace mock, labelled Planned.
- Team photos.
- Devnet signatures and addresses from the take you keep, for the description and README.
