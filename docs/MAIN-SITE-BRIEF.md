# Brief: the main site (reins.one) — bring Arena onto it

For the agent working on `site/`. Read this first; it's everything you need
from the work happening on the app (`app/`).

## Messaging (2026-10-09) — read this first

The Arena wording changed. The full guide is `docs/ARENA-MESSAGING.md`; follow
it. Where anything further down this brief disagrees (the old headline,
"lock / call", "bots", "callers"), the messaging doc wins.

- **Name:** "Arena by Reins" in titles, the hero and first mentions.
- **Hero line:** Proof of skill for AI trading agents.
- **Subhead:** Every prediction is recorded before the market moves and scored
  against real prices. Nothing can be deleted, and anyone can check the math.
- **Problem line:** Don't trust the screenshot. Check the record.
- **Builder line:** A track record your agent can't fake.
- **Words:** "prediction", not "call"; "agent" for every scored entity (Reins's
  own and anyone's), not bot / strategy / book; "people" for humans making
  predictions, not "callers"; "record / track record / score", not "book".
- **Mechanism stays out of headlines:** no "lock / locked in / sealed / before
  the market moves" in headlines, titles, meta descriptions or buttons. Explain
  the sealing only in "How it works", in plain words.
- **No jargon in headlines:** "how long it's held", not "horizon"; "an open
  registry on Arc (ERC-8004)", not "ERC-8004" alone.
- **Guardrails:** the marketplace is always "planned"; no promises of profit;
  keep "Not investment advice"; say "testnet" plainly until mainnet.
- **Buttons:** "See the leaderboard" → `https://app.reins.one/arena`,
  "Connect your agent" → `https://app.reins.one/arena-guide#agents`.

## The situation in one paragraph

Reins has two products. **Agents** (the older one): people create an agent
with spending limits enforced by a Mandate contract on Arc, and watch charts
and picks (`app.reins.one/`, `/create`, `/charts`, `/chat`). **Arena** (the
new one, and the one we're submitting to the DoraHacks Arc Microgrants, due
**2026-10-14 23:59 ET**): verifiable track records for AI trading agents and
people. A call is locked on Arc before the market moves, revealed after, and
scored on public prices with open rules anyone can re-check. The main site
(`site/index.html`) doesn't mention Arena at all yet. Judges will land on
reins.one, so Arena needs a clear place there.

## Ground rules

- **Work only in `site/`.** Don't edit anything under `app/`, `callbook/`,
  `contracts/`, `scripts/`, `docs/` (except this file), `vercel.json` or
  `package.json`; another agent is working there.
- **`site/index.html` has uncommitted edits** (about +94/−31 lines, in progress).
  Build on them; don't revert or overwrite them. Check `git diff site/index.html` first.
- **Don't commit, push or deploy** unless the user asks. Ask before anything goes live.
- The user dislikes long reads. Short, plain sentences; no hype; no
  "AI-sounding" copy. Equal emphasis, no "main attraction" framing.
- Never call Arena a market, a bet or a prediction game. It's a **record, not a
  market**: no stakes, no odds, no payouts. Avoid betting language (Up/Down, win
  big, odds). Use **long / short**, **call**, **track record**.

## What to do

1. **Add an Arena section** (and a nav link, e.g. "Arena" between Safety and
   Developers). Suggested content:
   - Headline idea: "Anyone can fake a backtest. Nobody can fake a call locked
     before the market moves." (the app's own line; reuse it).
   - Three short steps: **Lock** (coin, long or short, how long, optional
     stop-loss and take-profit; hidden on Arc until the time is up) →
     **Reveal** (checked against Hyperliquid's real prices, after fees and
     funding) → **Score** (0–100, rebuilt by anyone from chain data; Reins's
     own bots also post theirs daily to ERC-8004).
   - Who it's for: AI agents (through MCP, no wallet or gas needed) and people
     (browser wallet or Google sign-in).
   - Buttons: "See the track records" → `https://app.reins.one/arena`,
     "How Arena works" → `https://app.reins.one/arena-guide`.
2. **Developers section:** keep the existing Agents MCP (`github.com/onreins/reins-mcp`),
   and add Arena's MCP next to it:
   ```
   claude mcp add reins -- npx -y @onreins/mcp
   ```
   Works with Claude Code, Claude Desktop, Cursor and any MCP app; the agent
   then locks calls with `arena_lock`, reveals with `arena_reveal_due`, and
   checks its record with `arena_status`. Package: `npmjs.com/package/@onreins/mcp`.
   Source: `github.com/onreins/arena` (public, MIT, CI green).
3. **Hero:** one line or pill pointing at Arena, e.g. "New: Arena, track records
   nobody can fake →" linking to `/arena`. Don't replace the existing hero.
4. **Roadmap:** Arena's open calls, MCP server, profiles, sign-in and
   stop/target have **shipped**. Next on Arena: earlier results for stopped-out
   calls, daily on-chain scores for every caller, a price archive, mainnet.
5. **Footer:** add "Privacy" → `https://app.reins.one/privacy` (live) and
   "GitHub" → `https://github.com/onreins/arena`.
6. **Phones:** the app was just redesigned after pro.aave.com (slim top bar,
   round menu button, full-screen grouped menu, card lists). Check the site at
   375px and keep it consistent in spirit; no horizontal scroll.

## Facts you can use (current, 2026-10-09)

| | |
|---|---|
| App | `https://app.reins.one` (Arena: `/arena`, guide: `/arena-guide`, profiles: `/arena/p/<address>`, privacy: `/privacy`) |
| Network | Arc **testnet** now; mainnet deploy planned before the deadline |
| Arena contract (testnet) | `0x04371e9d8e7becace9c28bf879fecee401e8ad5f` |
| Our bots (ERC-8004 agents, testnet) | Hot list #897176, Cold list #897177, Coin flip #897178 |
| MCP package | `@onreins/mcp` (`npx -y @onreins/mcp`) |
| Public repo | `github.com/onreins/arena` |
| Scoring rules | ported from Vanta Network (MIT); prices and funding from Hyperliquid |

Don't hard-code numbers that change (scores, call counts); link to the app
instead. Don't claim mainnet until it's deployed.

## Accuracy notes (things that were wrong elsewhere and got fixed)

- Only **Reins's own bots** post scores on chain daily. Every other record's
  score is rebuilt live from chain data by anyone. Don't write "every score
  goes on chain daily".
- Agents need **no gas**: Reins pays it through a relayer.
- Stop/target are **optional**, and a call with them still has a time limit
  (at most 7 days).
- Google sign-in creates a Circle wallet on Arc for the person; locking a call
  from the website still needs a browser wallet for now.

## Before you finish

- Open `site/index.html` locally at desktop and at 375px; no console errors,
  no horizontal scroll, every new link works.
- Tell the user what changed in a few lines, and ask before committing or deploying.
