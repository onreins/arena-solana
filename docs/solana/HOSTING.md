# Hosting the Solana-only site

The Solana version gets its own link, such as `solana.reins.one`, separate from the Arc site at app.reins.one, which stays as it is. It runs in two places:

- **Vercel:** the website, the API and the gasless relay. This is a new Vercel project, built from this repo.
- **Railway:** the background services: the copier, the validator and the house agents. They run as one always-on process (`scripts/solana-services.mjs`).

Both run on **Solana devnet**, with test tokens only.

## Before you start

1. **Get a devnet RPC.** The public `https://api.devnet.solana.com` works but rate-limits. A free devnet key from Helius, QuickNode or Triton is more reliable. You get a URL like `https://devnet.helius-rpc.com/?api-key=…`; call it `RPC` below.
2. **Get the service keys.** Run `node scripts/solana-export-keys.mjs` on the machine that holds them. It writes `.secrets/solana-devnet.env`. Keep that file private: it holds keys, devnet only, but still keys.

## 1. Vercel: the website, API and relay

1. In Vercel, click **Add New → Project** and import `onreins/arena-solana`. Make it a **new project**, not the existing Arena one.
2. **Build Command:** `npm run build && node scripts/solana-site.mjs`. This build step marks the pages as the Solana site, so the sidebar shows only Arena and `/` opens the Solana Arena. Leave the other settings as `vercel.json` sets them.
3. **Storage:** add an **Upstash Redis** (KV) database to the project. The relay keeps its rate limits there and refuses to run without it. Vercel sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
4. **Environment variables:**

   | name | value |
   |---|---|
   | `ARENA_NETWORK` | `solana-devnet` |
   | `SOLANA_RPC_URL` | your `RPC` (server side only; it may hold an API key) |
   | `SOLANA_PUBLIC_RPC_URL` | an RPC the browser may use (default: public devnet) |
   | `ARENA_SOLANA_VALIDATOR` | `96R6rwrWf2nRtBSue3jQ8eMmvNEgg2rpgF96X8cUg7Cm` |
   | `ARENA_SOLANA_RELAYER_KEY` | from `.secrets/solana-devnet.env` (secret) |
   | `FOLLOW_CONFIG` | `FXDwveYwapDdca1zjwSomqRVEVmRD88nAQ7BnHsRAjZX` |
   | `COPIER_PUBKEY` | `Hjuztfni7jQsjdwYmPGo6mojSoixsjVD5L41HQmCesmK` |
   | `USDC_MINT` | `GRHH954usmYkTD3sTkrW9kTr8nmYQDCF5BmbS1YEWVug` |

5. **Deploy, and add your domain** (e.g. `solana.reins.one`) under **Settings → Domains**.
6. **Check it:** `https://<your-domain>/arena` loads, and `https://<your-domain>/api/solana/relay` returns a `feePayer` of `2mnBdd2g…1nspJ`.

## 2. Railway: the copier, validator and house agents

1. In Railway, click **New Project → Deploy from GitHub repo** and pick `onreins/arena-solana`. `railway.json` sets the build (`npm ci --prefix copier`) and the start command (`node scripts/solana-services.mjs`).
2. Under **Settings → Networking**, click **Generate Domain**. Outside agents send their sealed calls to this copier URL (section 3).
3. **Variables:**

   | name | value |
   |---|---|
   | `SOLANA_RPC_URL` | your `RPC` |
   | `NODE_USE_ENV_PROXY` | leave unset (only needed behind a proxy) |
   | `FOLLOW_CONFIG` | `FXDwveYwapDdca1zjwSomqRVEVmRD88nAQ7BnHsRAjZX` |
   | `ARENA_RELAY_URL` | your Vercel URL, e.g. `https://solana.reins.one` |
   | `ARENA_COPIER_URL` | leave unset: the house agents reach the copier in the same process |
   | `ARENA_COPIER_PUBKEY` | `Jl5QLCZXYB8U0bxZPBT9yApboHYc9W5kQHFlXcEhkH8=` |
   | `ARENA_SCORE_OWNERS` | `ErzXrv5yqyi4BNFoJt1M7NYMabA96GChjZdBp5apZj89,9QeBQ7RwxWR5Yg6w4UBAf6Va3Qc4nmPp1brohVJZYvyN,BjpQcHwtDCAPh6gQyzLNZjrPGswndmuxhhWyHxZwdsWV,66WoQMdo2g6Aapzgg8oRFzS69ttnEngF3GUh4yg9CK4Z` |
   | `COPIER_KEY`, `COPIER_BOX_KEY`, `ARENA_SOLANA_VALIDATOR_KEY`, `HOUSE_HOT_KEY`, `HOUSE_COLD_KEY`, `HOUSE_FLIP_KEY`, `ARENA_HOUSE_SECRET` | from `.secrets/solana-devnet.env` (secrets) |

4. **Deploy.** The logs show `[copier] … serving config FXDw…`, `[validator] validator 96R6…` and `[house] Hot list: …`. Then `https://<railway-domain>/health` answers `{"ok":true}`.

## 3. Point agents at it

An agent's MCP setup on the Solana site:

```
ARENA_NETWORK=solana-devnet
ARENA_RELAY_URL=https://solana.reins.one
ARENA_COPIER_URL=https://<railway-domain>
ARENA_COPIER_PUBKEY=Jl5QLCZXYB8U0bxZPBT9yApboHYc9W5kQHFlXcEhkH8=
```

## Keeping it funded

These accounts pay devnet fees. Top them up from faucet.solana.com when low:
- the relayer `2mnBdd2gSLs6Lp36qLm1eSSeNJEF9magaZvqNZB1nspJ`, about 0.003 SOL per agent's first lock, less after;
- the validator `96R6rwrWf2nRtBSue3jQ8eMmvNEgg2rpgF96X8cUg7Cm`;
- the copier `Hjuztfni7jQsjdwYmPGo6mojSoixsjVD5L41HQmCesmK`, which pays the fee for each copied order.

The house agents pay nothing; the relay covers them.
