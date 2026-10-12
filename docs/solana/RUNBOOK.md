# Reins on Solana: devnet runbook

The steps that couldn't run from the build container (its network blocks Solana RPC), in order. Devnet only, never mainnet.

## 0. Tools

- Solana CLI 2.3 (Agave), Anchor 0.31.1, Rust, Node 22.
- A devnet wallet at `~/.config/solana/id.json` with a few SOL (`solana airdrop 5 --url devnet`).
- A private devnet RPC is strongly advised: the public one rate-limits the reader and the copier. Set `SOLANA_RPC_URL` / `ARENA_SOLANA_RPC`.

## 1. Program ids

The ids in the code come from keypairs in `target/deploy/` that are gitignored and were never committed. On a new machine:

```sh
anchor keys sync        # writes new ids into the programs and Anchor.toml
```

Then put the same ids in `solana/arena.js` (`ARENA_PROGRAM_ID`), `solana/follow.js` (`FOLLOW_PROGRAM_ID`), `crates/arena-score/src/lib.rs` (`ARENA_PROGRAM_ID`), `crates/arena-tests/tests/arena.rs` (the score-gate id), `README.md` and `docs/colosseum/`. Then run `npm run test:programs` and `npm run test:solana`. The arena-score test checks the crate's id against the program's.

## 2. Deploy

```sh
scripts/solana-devnet-deploy.sh     # refuses any cluster but devnet
```

## 3. House agents, plans, validator

```sh
export ARENA_NETWORK=solana-devnet
ARENA_HOUSE_SECRET=$(openssl rand -hex 32) node solana/house-agents.js --once   # makes ~/.arena/house/{hot,cold,flip}.json (0600) and locks
node scripts/solana-follow-setup.mjs                                            # Reins' Config + a plan per house agent; prints FOLLOW_CONFIG
```

Run the relay in the app with `ARENA_SOLANA_RELAYER_KEY` set and a KV store (`KV_REST_API_*`). It refuses to run without a store. Then the validator:

```sh
ARENA_SOLANA_VALIDATOR_KEYPAIR=… ARENA_SCORE_OWNERS=<hot>,<cold>,<flip> node solana/validator.js
```

Serve the app with `ARENA_NETWORK=solana-devnet ARENA_SOLANA_VALIDATOR=<validator pubkey>`.

## 4. Copier

Check these on Velocity devnet first (docs/solana/DRIFT-CHECK.md):

- the program is live;
- account creation isn't whitelisted;
- whether builder codes are on;
- the faucet works;
- the minimum order sizes.

Then:

```sh
cd copier && npm ci
npm run keys                          # data/box-key (0600); prints ARENA_COPIER_PUBKEY for agents
COPIER_KEYPAIR=… COPIER_BOX_KEY=data/box-key FOLLOW_CONFIG=… npm start
```

Agents set `ARENA_COPIER_URL` and `ARENA_COPIER_PUBKEY`.

## 5. A follower, by hand (until the app's Copy flow is in)

1. On Velocity devnet, create the account, get dUSDT from the faucet, create a copy subaccount (id ≥ 1) and deposit into it.
2. Call `updateUserDelegate(<copier pubkey>, <sub id>)`.
3. Call `subscribe` on the follow program with `maxPrice` and `maxPerfFeeBps` set to what the plan shows.
4. Optional: SPL `approve` a USDC allowance to the Follow account, for performance fees.

## 6. The demo numbers to record

- **Lock confirmation latency:** the SDK prints `latencyMs`.
- **Copy latency from the lock:** the copier logs `fromLockMs` per order, and it's also in `copier/data/journal.jsonl`.
- **Explorer links** for: a lock, a reveal, a Score write, a subscription (showing the split), a copied order (entry with TP/SL), and a performance settlement.

## 7. Performance fees

```sh
cd copier && SETTLER_KEYPAIR=<config admin> COPIER_KEYPAIR=… FOLLOW_CONFIG=… npm run settle -- --dry-run
```

Drop `--dry-run` to send. The first settlement for a follow only sets its high-water mark.
