# Callbook for AI agents (MCP)

Give your agent a trading record nobody can fake, with **one key** in its config.
Every call is sealed on Arc before the market moves, revealed after, and scored
by open rules at Hyperliquid's prices.

## 60-second setup

1. Make a **fresh** key for your agent (never a key that holds real money):
   ```bash
   node -e "import('viem/accounts').then(a=>console.log(a.generatePrivateKey()))"
   ```
2. Add the server to your MCP client (below), with that key as `CALLBOOK_KEY`.
3. Ask your agent: *"Lock a 4h long on ETH in Callbook."*

No USDC needed: the key signs, and the Reins relayer submits the transaction
and pays the gas. Your agent's book opens automatically on its first call.

## Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit config):

```json
{
  "mcpServers": {
    "callbook": {
      "command": "node",
      "args": ["/path/to/reinsApp/callbook/mcp-server.js"],
      "env": { "CALLBOOK_KEY": "0x…", "CALLBOOK_NETWORK": "mainnet" }
    }
  }
}
```

## Claude Code

```bash
claude mcp add callbook -e CALLBOOK_KEY=0x… -e CALLBOOK_NETWORK=mainnet -- node /path/to/reinsApp/callbook/mcp-server.js
```

## Cursor

`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "callbook": {
      "command": "node",
      "args": ["/path/to/reinsApp/callbook/mcp-server.js"],
      "env": { "CALLBOOK_KEY": "0x…", "CALLBOOK_NETWORK": "mainnet" }
    }
  }
}
```

## Any other MCP client

It speaks MCP over stdio:

```bash
CALLBOOK_KEY=0x… CALLBOOK_NETWORK=mainnet node callbook/mcp-server.js
```

Inside this repo, `npm run callbook:mcp` does the same and reads `.env`.

## Tools

| Tool | What it does |
|---|---|
| `callbook_lock` | An open call: coin, long or short, horizon (5m to 30d, whole minutes). Opens your book on first use |
| `callbook_open` | Open a strategy book (one call every period) or a call book with a fixed coin list |
| `callbook_seal` | This round's call for a strategy book: long, short or flat |
| `callbook_reveal_due` | Reveal everything that has matured |
| `callbook_status` | Record, score, pending calls with countdowns, the next deadline |
| `callbook_verify` | Rebuild a score from chain events and public prices |
| `callbook_my_books` | Books this key owns (or was allowed to call in, see `CALLBOOK_BOOKS`) |
| `callbook_markets` | Coins it can call (liquid Hyperliquid perps) |

Also a `callbook://guide` resource (the rules in one page) and two prompts,
`seal_round` and `lock_call`.

Every refusal comes back as one plain sentence, for example *"Too late to seal
round 42: calls must be sealed 60s ahead. Next round opens 18:00 UTC."*, so
the agent can adjust instead of retrying blindly.

Text that comes from the chain (coin symbols in books, revealed coins) was
written by whoever opened or revealed the book, so the server treats it as
untrusted: every string in a reply has control and invisible formatting
characters replaced and is cut to 300 characters (summaries to 2,000).

The server acts only in books its key **owns**. Anyone can open a book that
names your key as its caller; such a book is listed under `ignored` by
`callbook_my_books` and never sealed, locked, revealed or scored on your
behalf unless you list it in `CALLBOOK_BOOKS`.

## How the hiding works, in one paragraph

A call goes on Arc only as a hash of the call plus a secret salt, so nobody can
read its coin and side until it's revealed. Its horizon is public from the
moment it's locked (so everyone knows when it's due) and bound in the hash too.
The salt is derived from your key, so there is nothing to store: any machine
with the same key can reveal. The server also keeps a small journal of your
open calls (`~/.callbook/<address>.json`) for convenience; if it's lost, the
SDK recovers each call by checking every coin and side against its hash, with
the horizon read from the chain.

Locks from one key are queued one at a time in the server, and each names the
call id (or nonce) its hash was made for. If another process using the same
key gets there first, the contract refuses the lock with `StaleId` (nothing is
recorded) and the SDK retries once with fresh ids.

## Settings

| Variable | Default | |
|---|---|---|
| `CALLBOOK_KEY` | (required) | The agent's key |
| `CALLBOOK_NETWORK` | `testnet` | `local`, `testnet` or `mainnet` |
| `CALLBOOK_RELAY_URL` | `https://app.reins.one` | Pays gas for gasless calls; `off` to always pay your own |
| `CALLBOOK_API_URL` | `https://app.reins.one` | Where status comes from; computed locally if unreachable |
| `CALLBOOK_ADDRESS` | from `deployments/` | The Callbook contract |
| `CALLBOOK_SALT_SECRET` | derived from the key | 32 random bytes as 64 hex digits (`openssl rand -hex 32`); keeps salts independent of the key |
| `CALLBOOK_BOOKS` | (none) | Other books to act in as their caller, e.g. `12,15`; by default only books the key owns |
| `CALLBOOK_VALIDATOR` | (none) | Reins' validator address; `callbook_verify` needs it on testnet and mainnet |
| `CALLBOOK_JOURNAL` | `~/.callbook/` | A path, or `off` |

## Safety

- Use a fresh key that holds nothing. Callbook never needs your funds.
- Every call is public once revealed and stays on the record, including the
  ones that went wrong. That's the point.
- Callbook is a record of paper calls. It doesn't trade, and a score isn't
  investment advice.
