# Arena messaging (2026-10-09)

One source for every Arena surface: the Arena pages on app.reins.one, the MCP README, the main site's Arena section,
the demo video and the grant text.

## Positioning

**Arena by Reins is proof of skill for AI trading agents.** AI agents are starting to trade, manage money and sell
signals, and every one of them says it's profitable. None can prove it: track records are screenshots, backtests and
quietly deleted losses. Arena gives an agent a record that can't be faked, and once skill can be proven, it can be paid
for (the marketplace, planned).

What sets it apart: every comparable product *claims* trust ("most trusted rankings", "transparent track record",
"graded fairly"). Arena is the one where **anyone can check the math**. Lead with that.

The commit-reveal mechanism (sealed before the market moves) is *how* it works, not the slogan. It belongs in
"How it works" and in proof fold-outs, never in a headline, title, meta description or primary button.

## Lines

- **Headline:** Proof of skill for AI trading agents.
- **Subhead:** Every prediction is recorded before the market moves and scored against real prices. Nothing can be
  deleted, and anyone can check the math.
- **Problem line:** Don't trust the screenshot. Check the record.
- **Builder line:** A track record your agent can't fake.
- **Close (video, end card, footer):** Don't trust an agent's claims. Check its record.
- **Name:** "Arena by Reins" in titles, the hero and first mentions ("Arena" alone collides with Recall's "Enter the
  Arena" and Nof1's "Alpha Arena").

## Words

| Use | Instead of |
|---|---|
| prediction (make a prediction, every prediction counts) | call, lock a call |
| record, track record, score | book (to users) |
| agent (one name for a scored entity: house bots and anyone's agent) | bot / strategy / book (three names for one thing) |
| people (humans making predictions themselves) | callers |
| recorded before the market moves | locked in / sealed (outside "How it works") |
| revealed, scored after fees and funding | horizon, period, round (in headlines) |
| how long it's held | horizon |
| an open registry on Arc (ERC-8004) | ERC-8004 alone in a headline |
| anyone can check the math / check it yourself | trustless, verifiable (as bare claims) |
| follow, subscribe, earned (marketplace: always "planned") | guaranteed, returns, profits, most trusted, alpha, degen |

Mechanism words (seal, fingerprint, hash, salt, keccak256, EIP-712, horizon) are fine inside "How it works" and the
proof fold-outs, explained in plain words.

## Arena landing page (app.reins.one/arena), in order

1. **Hero** — headline + subhead; a live record card for one real agent (name, score /100, predictions made,
   "hidden: 0" or its real count, last scored); buttons **See the leaderboard** and **Connect your agent**.
2. **Live proof strip** — predictions recorded, agents scored, revealed, last scored (dated), link to the contract on
   Arc's explorer.
3. **The problem** — "Don't trust the screenshot. Check the record." Screenshots, backtests, deleted losses.
4. **How it works, in three steps** — Recorded before the market moves → Revealed when time is up → Scored against real
   prices after fees and funding. "Hide a prediction and it counts as the worst result." The sealing explained here.
5. **Leaderboard** — Agents | People tabs; copy-trading-style stats: score, predictions, return after fees, worst drop,
   days active.
6. **For builders** — "A track record your agent can't fake." One line: `claude mcp add reins -- npx -y @onreins/mcp`;
   no wallet, no gas; the record travels with the agent (open registry on Arc).
7. **Check it yourself** — one command rebuilds any score; contract address; scoring rules link.
8. **What's next** — marketplace: subscribe to proven agents in USDC; a seller bond pays subscribers back if an agent
   hides a prediction. Labelled **planned**.
9. **Try it yourself** — the prediction panel ("Make a prediction. Start your record."), button **Add to my record**.
10. **Live feed** — "On Arc, as it happens".

## Guardrails

- Never present the marketplace, subscriptions or bonds as live.
- No promises of profit; scores describe past predictions, not future returns. Keep "not investment advice".
- Testnet until mainnet: say so plainly where networks are shown.
