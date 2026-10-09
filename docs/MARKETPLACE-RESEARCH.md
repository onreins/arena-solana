# Arena as a marketplace of provable agents — research (2026-10-09)

Web research on comparables, money models, agent payments on Arc, and risks. Sources inline. Items marked **unverified** need checking before they go in the grant application.

## The headline

- **Arc mainnet is live (2026-09-16)**, and Circle launched its x402 payment service on Arc the same day ([The Block](https://www.theblock.co/news/ecosystems/2026-09-16-circle-launches-arc-mainnet-with-blackrock-and-visa-among-validators-mints-10-billion-arc-tokens-415250), [Arc blog](https://arc.io/blog/arc-mainnet-goes-live-on-september-16-2026), [Circle release notes](https://developers.circle.com/release-notes/agent-stack-2026)). The rails for "agents pay verified bots for alpha" exist today. Arena is on testnet; moving to mainnet is the near-term milestone.
- **Nobody else combines** a continuous commit-reveal record on live prices, "hide a loser = worst result", and a score anyone can rebuild from public ERC-8004 data. The nearest rival (Recall Network) runs time-boxed, largely simulated competitions.

## Comparables

| Product | What's verified | How it earns | Notes |
|---|---|---|---|
| Recall Network (closest) | Agents log trades/rationale in time-boxed competitions; AgentRank; RECALL staking ([4Pillars](https://research.4pillars.io/en/research/the-market-decides-which-ai-wins-in-the-recall-skill-market)) | Token staking/fees, sponsored prize pools ($25k AlphaWave, [Recall](https://paragraph.xyz/@recall/alphawave-the-ultimate-battleground-for-defai-agents)) | $30M raised; token on Base Oct 2025 ([Defiant](https://thedefiant.io/news/press-releases/recall-announces-launch-of-erc-20-token-on-base-october-15)). Mainnet date unverified. |
| Numerai Signals | Staked signals scored vs a hidden target ([docs](https://docs.numer.ai/numerai-signals/staking)) | Trades its own fund on the crowd's signals; stakes burned for bad results | ~$700M AUM (Jul 2026) ([Defiant](https://thedefiant.io/news/press-releases/numerai-completes-third-strategic-nmr-buyback-bringing-total-repurchases-to-3-2-million)). Proof that slashable stakes work as a quality filter. |
| Bittensor SN8 (Taoshi) | 60-day challenge, then profit ranking ([PR](https://www.aap.com.au/aapreleases/cision20250423ae70413/)) | Validators resell signals via API | Mostly emission-subsidised. 2026 status unverified. |
| Collective2 | Off-chain broker records; shows all of a developer's systems | Subscriptions ~$20–200/mo, platform ~50% reported ([forum](https://nexusfi.com/d/education/collective2)) | Official fee schedule unverified. |
| Virtuals ACP | On-chain escrow per job + evaluator ([Forkast](https://forkast.news/the-machine-as-buyer-virtuals-acp-and-the-evaluator-problem/)) | Agent fees, heavy incentives | $479M "agent GDP" vs ~$1.16M real revenue ([BlockEden](https://blockeden.xyz/blog/2026/04/21/agdp-agent-gdp-virtuals-protocol-ai-blockchain-valuation-primitive-tvl-displacement/)) — lead with real revenue, not volume. |
| Olas Mech Marketplace | Agents hire agents per request; mechs now in ERC-8004 registries, some with x402 ([SiliconANGLE](https://siliconangle.com/2025/02/27/olas-launches-decentralized-ai-marketplace-ai-agents-can-hire/), [QuickNode 8004](https://erc-8004.quicknode.com/agents/gnosis-mainnet/2649)) | Pay per request | Transaction counts conflict (4–14M). |
| Giza / Almanak | Yield agents in self-custodied accounts; no forecast-skill proof | Performance fees (Giza ~10%, unverified) | Giza ~$31M TVL ([DefiLlama](https://preview.dl.llama.fi/protocol/giza)). |
| Copy trading | Exchange-held records you must trust | Hyperliquid vault leaders: fixed 10% of profit, must keep ≥5% ([HL docs](https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/vaults/for-vault-leaders)); Bybit 10–15% ([Bybit](https://www.bybit.com/en/help-center/article/Copy-Trading-Profit-Sharing-Explained)); eToro ~1.5%/yr of copied assets ([eToro](https://etoro.com/popular-investor)) | Huge user bases. |

Kaito and MyShell: 2026 status not found.

## Money models that fit Arena

1. **Pay-per-signal between agents (x402, USDC on Arc)** — best fit. An agent calls `GET /signal/{agent}` and pays in USDC; Circle's hosted x402 service handles relaying, gas and sanctions screening ([Crypto Briefing](https://cryptobriefing.com/circle-x402-facilitator-service-arc-launch/)). Suggested Arena take: 10–20% (judgment: between Collective2's ~50% and exchanges' 10%). Caveat: a lot of public x402 volume is artificial ([summary](https://www.mexc.com/news/392947)).
2. **Live paid, delayed free.** Commit-reveal already gives the free tier (everyone sees the call after its horizon). Subscribers pay to get the call at lock time.
3. **Bonds.** Agents post USDC per call or per season; a skipped reveal or broken rule forfeits it. Quality signal (Numerai), makes fake-agent farming expensive; revenue from forfeits plus a small fee.
4. **Data API for funds.** Sell score and call history (rank feeds). Low regulatory risk.
5. **Profit share on copied trades / vaults routed to proven agents** (Hyperliquid's 10% as the reference). Highest revenue per user, highest regulatory risk — later, after legal review.
6. **Sponsored seasons** (exchanges/protocols fund prize pools). Good for growth, not recurring.
7. Listing / "verified" badge fees — better as anti-spam than as income; can look pay-to-play.

## Agent payments on Arc today

- **ERC-8004 on Arc testnet:** Identity `0x8004A818…D9e`, Reputation `0x8004B663…713`, Validation `0x8004Cb1B…272`; Arc's tutorial covers `giveFeedback` and `validationRequest`/`validationResponse` (0–100) ([Arc docs](https://docs.arc.io/arc/tutorials/register-your-first-ai-agent)). **Mainnet addresses unverified.**
- **Gas in USDC**; Circle Gas Station can sponsor it.
- **Circle Agent Stack** (2026-05-11): Agent Wallets with spending limits, Circle CLI, Nanopayments; **Agent Marketplace** (2026-07-31) — a curated, sanctions-screened directory of paid x402 services with a public discovery API; Arc mainnet support 2026-09-16 ([Circle PR](https://circle.com/pressroom/circle-launches-ai-infrastructure-to-power-the-agentic-economy), [release notes](https://developers.circle.com/release-notes/agent-stack-2026)).
- **Nanopayments:** the mainnet launch post lists 11 chains, not Arc; the Arc release note touches the Nanopayments docs but doesn't state support. **Confirm before claiming.**
- **ERC-8004 + x402 elsewhere:** the standard keeps payments separate, but the off-chain feedback file has a `proofOfPayment` field for x402 tx hashes ([EIP-8004](https://eips.ethereum.org/EIPS/eip-8004)). Celo and Polygon document discover → check reputation → pay with x402 → post feedback ([Celo](https://docs.celo.org/build-on-celo/build-with-ai/8004), [Polygon](https://docs.polygon.technology/payment-services/agentic-payments/erc8004)). Arena's edge: its score is a *Validation* computed from market prices, not opinion.

## Risks and how to handle them

- **Regulation (not legal advice).** US publisher exclusion covers impersonal, regularly published advice (*Lowe v. SEC*, [Cornell](https://www.law.cornell.edu/supremecourt/text/472/181)). Bigger exposure is the CFTC: Hyperliquid perps are commodity derivatives, and a paid signal seller can be a Commodity Trading Advisor even "through a publication" ([Blank Rome](https://blankrome.com/publications/ctas-trading-signals-and-defi-connecting-dots-or-unconnected-leaps-logic)); CFTC fined SignalPush $100k in 2023 ([CFTC](https://www.cftc.gov/PressRoom/SpeechesTestimony/phamstatement082923)). So: Arena stays a neutral venue and data layer; **agent owners sell their own signals**; no personalised advice or auto-execution at first; geo-gating; counsel before copy trading/vaults.
- **Paid signals vs the public record.** Selling doesn't weaken the record — the hash is fixed at lock. At lock, buyers get the plain call + salt (encrypted to them) and check `hash(call, salt)` against the on-chain commit, so an agent can't send different calls to different buyers; the public sees it at reveal. Resale by buyers hurts only the seller's revenue. Mitigate with buyer caps per call, short horizons, flags for calls too large for liquidity, and disclosure of whether the agent trades its own calls.
- **Sybil score farming** (run 100 random agents, promote the lucky ones). Show all agents per owner, minimum call counts with confidence bands, bonds, age-weighting, and keep "hidden = worst".
- **Survivorship.** Keep dead agents on the board; show scores against a baseline (Arena's coin-flip bot already exists).

## Decision (2026-10-09): flat subscriptions + seller bonds

Paying per call feels wrong to buyers when any call can lose, so the model is a
**flat monthly USDC subscription** to a bot's live calls (agents over x402,
people with a wallet), with a small platform fee on the subscription, never on
trades. The free tier is the public feed, delayed until each reveal.

**Rejected: "money back if the calls don't beat the market."** Four independent
reviews (a retail trader, a bot seller, a mechanism designer, a precedents and
legal check) all said drop it:

- **It's mostly noise.** P(a month beats zero) ≈ Φ(Sharpe/√12): 61% for a
  Sharpe-1 bot, 67% at 1.5, 50% for a coin flip. A good bot works free about one
  month in three, and earns only ~1.2× what luck earns.
- **It's easy to game.** A tiny target with a wide stop gets a zero-skill bot
  paid ~90% of months; stopping when ahead and tripling size when behind pushes
  it higher; two opposite bots collect every month; subscribers still trade the
  calls in red months and get refunded.
- **"Beat the market" has no simple honest definition** for mixed long/short
  calls on different coins and horizons.
- **Traders read it as a scam signal** ("money back" sits next to "guaranteed
  returns"), and it protects the fee, not their account.
- **Precedent and law:** untested as an on-chain escrow; tipster money-back
  guarantees were repeatedly struck down by the UK ASA, and the CFTC cited false
  money-back guarantees (Guarino, 2003). A results-linked fee also weakens the
  "impersonal publisher" position (Lowe v. SEC; CFTC 4.14(a)(9)); the FTC
  guarantee guides (16 CFR 239.3) require every condition to be disclosed.
  The proven designs put risk on the seller (Numerai stakes, Hyperliquid vault
  leaders' 5%) or charge above a high-water mark.

**Adopted: a seller-posted USDC bond**, slashed pro rata to that month's
subscribers if the bot leaves a call unrevealed or goes quiet (fewer than N
calls while subscribers pay). It guarantees what the seller controls and the
chain can check — honesty and activity — and leaves skill to the long-run score.
Also: show every agent an owner runs on one page, minimum record length before
listing, one definition of each metric in plain words. Still ask counsel before
launch (CTA status for paid signals on perps).

## Recommendation (original, before the decision above)

**Pitch line:** "Arena is the proof-of-skill layer for AI trading agents on Arc. Agents lock hidden calls on chain; Arena scores them against real Hyperliquid prices after fees and funding and posts the score to ERC-8004, where anyone can recompute it. Hiding a loss counts as the worst result, so the record can't be faked. On that record, Arena becomes a marketplace: people and other agents find verified bots and pay them in USDC over x402 for live calls — checked against the on-chain commit, public after the reveal. Reputation becomes revenue on Circle's own rails."

**Roadmap**
1. **Now → Arc mainnet:** ERC-8004 scores on mainnet, USDC bonds per call, a public rebuildable leaderboard API.
2. **Marketplace:** profiles per owner, filters by verified score and confidence, listings in Circle's Agent Marketplace, sponsored seasons.
3. **Agent-to-agent alpha:** x402 paid live calls delivered at lock and verified against the commit; payment proof written into ERC-8004 feedback; 10–20% fee; profit share later after legal review.

**Confirm before the application:** ERC-8004 registries on Arc mainnet; Nanopayments on Arc; Circle's hosted x402 pricing; Recall's mainnet status.
