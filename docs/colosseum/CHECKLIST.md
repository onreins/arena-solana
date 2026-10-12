# Pre-submission checklist

Work through this before submitting. Criteria are from the Spring 2026 official rules; check they still apply this round.

## Registration and eligibility

- [ ] Confirm the hackathon dates, registration cutoff and submission deadline on colosseum.com. (The Nov 2, 2026 end date came from a third-party listing.)
- [ ] Read this round's official rules. Confirm existing projects are allowed and what must be built during the hackathon.
- [ ] Every team member registers on colosseum.com **before the registration cutoff** (last round it was a week before the deadline).
- [ ] One project per team. Confirm no member is on another team's submission.
- [ ] Check the submission form's exact list of required items and field limits. Update `DESCRIPTION.md` to fit.
- [ ] Decide which tracks or awards to enter (e.g. Public Goods Award depends on the open-source decision).
- [ ] Submit before the deadline, not on it. Save a copy of everything submitted.

## Repo visibility

- [ ] The repo stays **private** until the owner decides on open source. Nobody on the team or any agent makes it public without that decision.
- [ ] If the form needs a repo link while private, check whether judges can be given access, and how.
- [ ] Before any open-source step: the program, the `arena-score` crate and the SDK contain no secrets, keypairs or private business details. `LICENSE` (Apache-2.0) is in place.

## 1. Functionality

- [ ] Arena program deployed to Solana **devnet** only. Program id recorded in the README and description.
- [ ] Program tests pass: commitment binding, no backdating, reveal window, double reveal, withheld stays withheld, profile length caps, Score written only by the validator. Real pass/fail counts noted.
- [ ] End-to-end flow works on devnet: lock, reveal, score, Score account read by the score-gate program.
- [ ] House agents are locking and revealing on devnet on a schedule, so records are real.
- [ ] Demo uses no mock data. Every transaction in the video has an Explorer link.
- [ ] The Arc version still works.

## 2. Potential impact

- [ ] Pitch explains who uses the score: vaults, copy-trading apps, agent launchpads, funds.
- [ ] Pitch says why Solana: it's where AI agents trade.
- [ ] Any market-size number has a source, or is cut.

## 3. Novelty

- [ ] Pitch and README make the difference clear: commit-reveal records scored on real prices, with scores other programs can read, vs self-reported leaderboards.
- [ ] Withheld predictions scored at their worst along the price path is explained in one plain sentence.

## 4. UX

- [ ] Lock confirmation time measured and shown honestly (target: under a second).
- [ ] Relayer pays fees; demo agent has 0 SOL on screen.
- [ ] One-line MCP install works from a clean machine with the Solana backend.
- [ ] Solana mode of the Arena pages shows Explorer links for every lock and reveal.
- [ ] Stretch: a Solana Action / Blink that shares an agent's record.

## 5. Open source and composability

- [ ] Score account layout is stable and documented.
- [ ] `arena-score` crate has a read helper that checks the account owner, plus docs.
- [ ] Score-gate example program builds, is tested, and is shown in the demo.
- [ ] Solana Agent Kit adapter works (ElizaOS if time allows).
- [ ] `LICENSE` present. Open-source decision made by the owner and reflected in the form.

## 6. Business plan

- [ ] Marketplace (bonded subscriptions, Arena fee) and paid scoring API described, and labelled **planned**.
- [ ] Fee rate stated only if decided. No private financials in any public text.
- [ ] Traction section states only verified facts: Arena live on Arc mainnet at app.reins.one, current counts read on the day.

## Submission kit

- [ ] Pitch video recorded from `PITCH-SCRIPT.md`, about 3 minutes, every `[TODO]` resolved.
- [ ] Demo video recorded from `DEMO-SCRIPT.md`, about 3 minutes, every `<PLACEHOLDER>` filled.
- [ ] Both videos checked frame by frame for keys, `.env` values and private data.
- [ ] Videos uploaded where the form asks, with links tested in a logged-out browser.
- [ ] README top section: one-line pitch, problem, diagram, devnet program id, one-line MCP install, composability, business model, team.
- [ ] `DESCRIPTION.md` pasted into the form.
- [ ] Team details and contact info complete.
- [ ] No claims of profit; "not investment advice" kept.
