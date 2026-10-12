# Pre-submission checklist

Work through this before submitting. Criteria are from the Spring 2026 official rules; check they still apply this round.

## Registration and eligibility

- [ ] Confirm the hackathon dates, registration cutoff and submission deadline on colosseum.com. (The Nov 2, 2026 end date came from a third-party listing.)
- [ ] Read this round's official rules. Confirm existing projects are allowed and what must be built during the hackathon.
- [ ] Every team member registers on colosseum.com **before the registration cutoff**.
- [ ] One project per team. Confirm no member is on another team's submission.
- [ ] Check the submission form's exact list of required items and field limits. Update `DESCRIPTION.md` to fit.
- [ ] Decide which tracks or awards to enter (the Public Goods Award depends on the open-source decision).
- [ ] Submit before the deadline, not on it. Save a copy of everything submitted.

## Repo visibility

- [ ] The repo stays **private** until the owner decides on open source. Nobody on the team or any agent makes it public without that decision.
- [ ] If the form needs a repo link while private, check whether judges can be given access, and how.
- [ ] Before any open-source step: programs, `arena-score`, SDK and copier contain no secrets, keypairs or private business details. `LICENSE` (Apache-2.0) is in place, and the README's license line matches it.

## Deploy (devnet only)

- [ ] `arena`, `follow` and `score-gate` deployed to Solana **devnet**. No mainnet deploys.
- [ ] If deploy keypairs were regenerated, `anchor keys sync` run and the new ids copied everywhere: `Anchor.toml`, `declare_id!`, `solana/*.js` defaults, README, `DESCRIPTION.md`, `DEMO-SCRIPT.md`. Reserved today: arena `BderjFgzJGQ6NsqNfbVmtHDhzjHP6B3ijPMGCrmNffqw`, follow `A5Zpb539Yazb3kypH7tvZBVWuGCdCwXU6sdVU8RkgJHC`, score-gate `4L1DyajAKPeY5rMXt3cMnk93qXJo3tV5XetmTi8jskcK`.
- [ ] Follow Config initialised: treasury, Reins share of subscriptions, Reins share of performance fees. Rates match `BUSINESS-MODEL.md`, or the doc is updated.
- [ ] Relayer running and funded with devnet SOL only.
- [ ] Copier running against a private devnet RPC; its keypair and box key are `0600` and gitignored.

## Velocity (formerly Drift) checks on devnet

- [ ] Velocity program `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P` is live on devnet, and account creation isn't whitelisted.
- [ ] dUSDT faucet works; SOL, BTC, ETH markets listed; min order size and step read.
- [ ] `builder_codes_enabled` checked. If off, cut the order-fee line from the pitch, description and README, or mark it "when enabled".
- [ ] Follower onboarding scripted and run fresh before recording (devnet can be wiped).

## 1. Functionality

- [ ] Program tests and JS suites pass. Real pass/fail counts noted in the PR, not in the pitch.
- [ ] End to end on devnet: lock via MCP → copier verifies the preimage → orders with TP/SL on two followers → reveal → Score account → subscription and performance settlement on-chain.
- [ ] Copier skips an unpaid follow and a follow over its limits, on camera or in the log.
- [ ] House agents locking and revealing on devnet, so records are real.
- [ ] Every transaction in the demo has an Explorer link. No mock data.
- [ ] The Arc version still works.

## 2. Potential impact

- [ ] Pitch names who it's for: people who want to copy an AI agent without handing over money, and agent builders who want to be paid for a record they can prove.
- [ ] Any market-size number has a source, or is cut.

## 3. Novelty

- [ ] Pitch and README make the difference clear: copying an agent whose record is committed before the market moves, verified against that commitment before each copy, with no custody.
- [ ] Withheld predictions scored at their worst along the price path is explained in one plain sentence.

## 4. UX

- [x] Copy latency measured on devnet: about 3 s from the lock to the order landing, 7.9 s to filled (docs/solana/DEVNET.md).
- [ ] Relayer pays fees; demo agent shows 0 SOL on screen.
- [ ] One-line MCP install with `ARENA_NETWORK=solana-devnet` works from a clean machine (or the demo shows the from-source line, and the README says which).
- [ ] Copy flow in the app (built: the Copy button on an agent's page and the Following page, in Solana mode). It connects a wallet, sets the delegate on a copy subaccount, chooses size and limits, and subscribes. Try it end to end with a real wallet on devnet before recording.
- [ ] Stop copying: revokes the delegate and cancels the copier's open orders.

## 5. Open source and composability

- [ ] Score account layout (`["score", validator, book]`) documented.
- [ ] `arena-score` crate checks the account owner; score-gate example builds and is tested.
- [ ] `LICENSE` present. Open-source decision made by the owner and reflected in the form.

## 6. Business plan

- [ ] `BUSINESS-MODEL.md` final: example price, take rates, projection with assumptions labelled.
- [ ] Every revenue number in the pitch is marked as an example or assumption.
- [ ] Regulatory note present in the README and description: charging subscription and performance fees for trade signals may be regulated in some countries; checked before mainnet.
- [ ] Traction states only verified facts: Arena live on Arc mainnet at app.reins.one, counts read on the day.

## Submission kit

- [ ] Pitch video recorded from `PITCH-SCRIPT.md`, about 3 minutes, every `[TODO]` resolved.
- [ ] Demo video recorded from `DEMO-SCRIPT.md`, about 3 minutes, every `<PLACEHOLDER>` filled.
- [ ] Both videos checked frame by frame for keys, `.env` values and private data.
- [ ] Videos uploaded where the form asks, links tested in a logged-out browser.
- [x] README "Reins on Solana" section has the deployed program ids (devnet, 2026-10-12) and the MCP line.
- [ ] `DESCRIPTION.md` pasted into the form.
- [ ] Team details and contact info complete.
- [ ] No claims of profit; "not investment advice" kept.
