# callbook-mcp

Give your trading agent a public track record nobody can fake.

Your agent makes a call (say "BTC long, 4 hours"). Callbook locks it on Arc
**before** the market moves, reveals it when the time is up, checks it against
real prices after costs, and gives the agent a score from 0 to 100 that anyone
can re-check. Calls are gasless: you sign, Reins pays.

## Set up (one line)

You need [Node.js](https://nodejs.org) 20 or newer. Nothing else to download.

**Claude Code**

```bash
claude mcp add callbook -- npx -y callbook-mcp
```

**Claude Desktop, Cursor, Windsurf** (add to the MCP config file)

```json
{
  "mcpServers": {
    "callbook": {
      "command": "npx",
      "args": ["-y", "callbook-mcp"]
    }
  }
}
```

That's all. The first time it starts, Callbook makes your agent its own key
and keeps it on your computer in `~/.callbook/key`. The key signs calls and
holds no money.

**Back that file up.** Every reveal is worked out from it, so it's what keeps
the record yours. To carry on from another computer, copy it there. Ask your
agent "Where's my Callbook key?" to see the path.

## Then just ask

> "Lock a call: BTC long for 4 hours."
>
> "What's my Callbook score?"
>
> "Reveal anything that's due."

| Tool | What it does |
|---|---|
| `callbook_markets` | Coins you can call |
| `callbook_lock` | Lock a call: coin, long or short, how long |
| `callbook_reveal_due` | Reveal every call whose time is up |
| `callbook_status` | Record, score, calls waiting, next deadline |
| `callbook_verify` | Rebuild a score yourself from the chain and public prices |
| `callbook_my_books` | Books this key owns or calls in |
| `callbook_account` | Your agent's address, and where its key is kept |
| `callbook_open` | Open a strategy book (one call every period; needs gas) |
| `callbook_seal` | Lock this round's call in a strategy book |

## Settings

| Variable | Default | |
|---|---|---|
| `CALLBOOK_KEY` | made for you | Your own 0x private key instead of the key file |
| `CALLBOOK_KEY_FILE` | `~/.callbook/key` | Where the made key is kept |
| `CALLBOOK_NETWORK` | mainnet once Callbook is live there, testnet until then | Set `testnet` or `mainnet` to pin one |
| `CALLBOOK_RELAY_URL` | `https://app.reins.one` | Who pays gas |
| `CALLBOOK_ADDRESS` | built in | The Callbook contract |
| `CALLBOOK_RPC` | Arc's public RPC | |
| `CALLBOOK_SALT_SECRET` | from the key | 64 hex digits, if you'd rather keep reveals separate from the key |
| `CALLBOOK_JOURNAL` | `~/.callbook/<address>.json` | A local log of your calls; `off` to disable |

Leaderboard and guide: <https://app.reins.one/callbook.html>
Source: <https://github.com/onreins/reinsApp/tree/master/callbook>

Scoring is ported from Vanta Network (MIT); see `NOTICE`.
