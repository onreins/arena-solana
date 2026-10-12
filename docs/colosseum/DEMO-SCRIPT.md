# Technical demo video script (about 3 minutes)

For the Colosseum submission. Shows the real flow on Solana devnet: an agent records a prediction through MCP, it confirms in under a second, it's revealed, it's scored, and another on-chain program reads the score.

No mock data. Every transaction in the video is a real devnet transaction with an Explorer link.

## Placeholders to fill before recording

| Placeholder | What it is |
|---|---|
| `<PROGRAM_ID>` | Arena program id on devnet |
| `<GATE_PROGRAM_ID>` | The score-gate example program id on devnet |
| `<BOOK>` | The demo agent's book (record) account address |
| `<SCORE_ACCOUNT>` | The demo agent's Score account address |
| `<LOCK_SIG>`, `<REVEAL_SIG>`, `<SCORE_SIG>`, `<GATE_SIG>` | Transaction signatures from the take you keep |
| `<DEMO_HORIZON>` | A short horizon for the demo, e.g. 60 seconds. [TODO: confirm the shortest horizon the devnet program allows] |
| `<SCORE_CMD>` | The command that runs the scorer and writes the Score account. [TODO: confirm the real npm script] |

Explorer links use `https://explorer.solana.com/tx/<SIG>?cluster=devnet` and `https://explorer.solana.com/address/<ADDR>?cluster=devnet`.

## Before you hit record

- MCP server installed in Claude Code (or Cursor) with the Solana backend, network `solana-devnet`. [TODO: confirm the exact install line and env var, e.g. `ARENA_NETWORK=solana-devnet`]
- The agent's key file exists with `0600` permissions. Never show its contents. The demo keypair holds **no SOL**, to show the relayer pays the fee.
- Have a demo agent that was **already scored** (a house agent with a score of 70 or more), so the score-gate step doesn't wait on a scoring run. Also have one low-scoring agent to show a refusal. [TODO: confirm which devnet agents qualify]
- Browser tabs ready: Solana Explorer (devnet), the Arena page in Solana mode, the score-gate source in an editor.
- Terminal font large. Hide anything with keys, tokens or `.env` values.

Total: about 3:00.

---

## 1. Intro (0:00 to 0:15)

On screen: Arena leaderboard in Solana devnet mode.

> This is Arena running on Solana devnet. I'll show an AI agent record a prediction, reveal it, get scored, and then another Solana program read that score on-chain.

## 2. Connect the agent (0:15 to 0:35)

On screen: terminal, then Claude Code.

> The agent connects through MCP. One line adds the Arena tools to Claude.

Show: `claude mcp add reins -- npx -y @onreins/mcp` [TODO: confirm the Solana install line; add the network env var if needed]

> The agent's keypair has no SOL. It won't need any. Our relayer pays the fee, and it only co-signs transactions that contain nothing but Arena instructions.

Show: `/mcp` listing the tools `arena_lock`, `arena_reveal_due`, `arena_status`, `arena_verify`, `arena_profile`.

## 3. Lock a prediction (0:35 to 1:05)

On screen: Claude chat.

Prompt to type:

> Use arena_lock to record a prediction: SOL long, horizon <DEMO_HORIZON>.

> The agent calls `arena_lock`. Only a hash goes on-chain. It binds the program id, the book, the call id, the horizon, the coin, the side and a secret salt. Nobody can read the prediction yet, and nobody can change it later.

Show: the tool result with the signature `<LOCK_SIG>` and the time to confirmation.

> Confirmed in [TODO: real measured time, e.g. about 400] milliseconds.

Click the Explorer link.

On screen: Solana Explorer, `<LOCK_SIG>` on devnet. Point at: program `<PROGRAM_ID>`, fee payer is the relayer, not the agent.

> The entry time comes from Solana's on-chain clock, not from the agent. So it can't be backdated.

## 4. Check status (1:05 to 1:20)

On screen: Claude chat.

Prompt:

> Use arena_status to show my open predictions.

> `arena_status` shows the open prediction and when it can be revealed. It can be revealed only after the horizon ends, within a grace window, and only once.

## 5. Reveal (1:20 to 1:45)

Wait for `<DEMO_HORIZON>` to pass (cut the wait in editing; keep the on-screen clock so viewers see time passed).

Prompt:

> Use arena_reveal_due to reveal anything that's due.

> `arena_reveal_due` sends the coin, the side and the salt. The program checks they match the hash. The reveal event includes the salt, so any scorer can read it straight from the event.

Show: `<REVEAL_SIG>` and click through to Explorer.

> If the agent never reveals, the prediction counts as its worst possible result, measured along the real price path. Hiding a loser doesn't help.

## 6. Score (1:45 to 2:10)

On screen: terminal, then the agent's record page in Solana mode.

Show: `<SCORE_CMD>` running against devnet.

> The scorer grades revealed predictions against real market prices, after fees. The validator authority writes the result to a Score account: the score, the counts, the time of scoring and a hash of the full report.

Show: `<SCORE_SIG>` in Explorer, then `<SCORE_ACCOUNT>` on the record page.

Prompt in Claude:

> Use arena_verify on my book, then arena_profile.

> `arena_verify` rebuilds the score from chain data and public prices. No keys, and no trust in us. `arena_profile` shows the agent's name and record.

## 7. Another program reads the score (2:10 to 2:45)

On screen: editor with the score-gate example program.

> Here's the part that makes it composable. This is a separate example program, the score gate. It uses our `arena-score` crate to read a Score account.

Show the key lines (illustrative; match them to the real crate API before recording):

```rust
// score-gate example: only agents scoring >= 70 pass
let score = arena_score::read(&ctx.accounts.score)?; // checks owner == Arena program
require!(score.book == ctx.accounts.book.key(), GateError::WrongBook);
require!(score.score >= 70, GateError::ScoreTooLow);
```

> The crate checks that the account belongs to the Arena program, so nobody can pass in a fake score. Then the gate checks the score is 70 or more.

On screen: terminal. Call the gate for the high-scoring agent.

> This agent scores [TODO: real score]. It passes.

Show: `<GATE_SIG>` in Explorer, success.

Call the gate for the low-scoring agent.

> This one scores [TODO: real score]. Refused, with `ScoreTooLow`.

> A vault, a copy-trading app or a launchpad can drop these three lines into its own program. It trusts the record, not the agent.

## 8. Close (2:45 to 3:00)

On screen: README top section with `<PROGRAM_ID>` and the one-line MCP install.

> Recorded in under a second. Fees paid by the relayer. Scored against real prices. Readable by any Solana program.
> Don't trust an agent's claims. Check its record.

---

## If something fails on the take

- Don't edit a failure into a success. Re-record the step.
- If the relayer is rate-limited, wait or use another demo key; don't raise the limits for the video.
- If you can't show a sub-second confirmation honestly, say the real time.
