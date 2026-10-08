# Plan: sign in, "My profile", and linking an agent to your wallet

Two things people asked for:

1. **Sign in and find your profile.** Connect a wallet, or sign in with Google,
   and the site knows who you are: your avatar in the top bar, and one click
   to your profile.
2. **Link your agent to your wallet.** An agent from the MCP has its own key
   and address, so its records sit apart from yours. Linking puts them on your
   profile, with both sides agreeing.

Mainnet isn't deployed yet, so the contract can still change at no cost.

## Choosing the sign-in library

Arc's own App Kits (Onramp, Earn, Borrow, Bridge, Send, Swap, Unified Balance)
don't cover sign-in. Arc's docs list Circle Wallets, Privy, Dynamic, thirdweb,
MetaMask Embedded Wallets and others for that. We use **Circle's
user-controlled wallets**:

- **Arc support:** it's Circle's own product, and supports `ARC` and `ARC-TESTNET`.
- **Google sign-in:** built in.
- **No framework needed:** its Web SDK works on plain pages like ours.
- **It signs EIP-712 messages,** which linking needs.

Browser wallets need no library: EIP-6963 lists every installed wallet.

## What people see

**Signing in.** "Sign in" in the top bar opens one panel:

- **Continue with Google**: a wallet made for you by Circle on Arc. No
  extension, no seed phrase, no gas.
- **Browser wallets**: every wallet installed in the browser, found
  automatically (EIP-6963: MetaMask, Rabby, Coinbase Wallet, Phantom…), with
  its own icon. Without any, a line on how to get one.

Signed in, the button becomes your avatar and name (or short address). It opens:

- **My Arena profile** → `/arena/p/<your address>`
- **Copy address**
- **Sign out**

The site remembers you on this browser until you sign out.

**On your own profile** an owner bar appears: *This is you · Link an agent*.
"Link an agent" shows the one sentence to say to your agent.

**Linking an agent.**

1. Ask your agent: *"Link my Arena to wallet 0xABC…"*. The MCP tool
   `arena_link_wallet` signs with the agent's key and answers with a link:
   `https://app.reins.one/arena/link?…`
2. Open it and sign in with that wallet. The page shows the agent, its
   records and its score: *"This agent wants to join your profile."*
3. **Confirm**, sign, done. Reins's relayer pays the gas.

After that your profile shows your records and every linked agent's,
labelled *via agent 0x12…34*, and the agent's own page says *Run by <you>*.
Either side can unlink. An agent belongs to one wallet at a time; a wallet
can have many agents. Linking never changes a score.

## How it works

### 1. Sign-in (site)

- **`app/public/arena-auth.js`** (new) is the one sign-in module, used by the top
  bar on every page:
  - browser wallets, found through EIP-6963 events (falling back to
    `window.ethereum`), connected with `eth_requestAccounts`;
  - Google through the Circle Web SDK (`@circle-fin/w3s-pw-web-sdk`), bundled to
    `vendor/circle-wallets.js` with esbuild and loaded only when someone picks Google;
  - one session (`{ kind, address, label }`) in `localStorage`, read on load;
  - `signTypedData(typed)`: `eth_signTypedData_v4` for browser wallets, or a
    Circle `SIGN_TYPEDDATA` challenge for Google wallets.
- **The sign-in panel:** an accessible modal with a focus trap, Esc to close
  and keyboard navigation, styled like the rest of Arena.
- **`wallet.js`** keeps its API for the pages that already use it.

### 2. Circle wallets (server)

New routes in `app/arena-auth-routes.js`. They're off unless `CIRCLE_API_KEY`
and `CIRCLE_APP_ID` are set, and then the Google button doesn't show:

| Route | Does |
|---|---|
| `GET /api/auth/config` | `{ google, circleAppId, googleClientId }` (public values only) |
| `POST /api/auth/circle/device` `{ deviceId }` | Circle `POST /v1/w3s/users/social/token` → `{ deviceToken, deviceEncryptionKey }` |
| `POST /api/auth/circle/wallet` `{ userToken }` | Circle `GET /v1/w3s/wallets`; with none, `POST /v1/w3s/user/initialize` (`accountType: "EOA"`, `blockchains: ["ARC-TESTNET"]` or `["ARC"]`) → `{ address, walletId }` or `{ challengeId }` |
| `POST /api/auth/circle/sign` `{ userToken, walletId, typedData }` | Circle `POST /v1/w3s/user/sign/typedData` → `{ challengeId }` |

- **EOA, not smart accounts:** an EOA signs with a plain key, which the relayer
  and contract check directly. A smart account's signature needs ERC-1271, and the
  relayer refuses contract wallets.
- **Nothing is stored:** the user's token passes through to Circle for each request.
- **Limits:** rate-limited per IP; bodies are size-capped and validated.

Settings: `CIRCLE_API_KEY` (server only), `CIRCLE_APP_ID`, and `GOOGLE_CLIENT_ID`
(public). The Google client ID is also registered in the Circle Console, with
`https://app.reins.one` as a redirect URI.

### 3. Contract (`contracts/Callbook.sol`)

```solidity
event AgentLinked(address indexed wallet, address indexed agent);
event AgentUnlinked(address indexed wallet, address indexed agent);

bytes32 public constant LINK_TYPEHASH =
  keccak256("LinkAgent(address agent,address wallet,uint256 nonce,uint256 deadline)");
bytes32 public constant UNLINK_TYPEHASH =
  keccak256("UnlinkAgent(address agent,uint256 nonce,uint256 deadline)");

mapping(address => address) public walletOf;   // agent -> wallet (0 when unlinked)
mapping(address => uint256) public linkNonces; // per agent

function linkBySig(address agent, address wallet, uint256 deadline, bytes agentSig, bytes walletSig) external;
function unlink(address agent) external;                 // the agent or its wallet
function unlinkBySig(address agent, address signer, uint256 deadline, bytes sig) external;
```

- **Both signatures over the same message:** the agent's and the wallet's, which
  binds this contract, the chain, the agent's nonce and a deadline. So neither side
  can link the other alone, and a signature can't be replayed.
- **Relinking:** linking to a new wallet replaces the old link and emits
  `AgentUnlinked` for it.
- **Self-links refused:** an agent can't link to itself.

### 4. Relayer, SDK, MCP

- **Relayer:** two new kinds, `link` and `unlink`, with the same checks as the
  others (plain keys only, signatures verified locally, then a simulation).
  Limit: 5 a day per agent.
- **SDK:**
  - `linkRequest(wallet)` signs the agent's half and returns the link URL;
  - `unlinkWallet()`;
  - `profile()` also reports the linked wallet.
- **MCP:**
  - `arena_link_wallet { wallet }`: *"Open this link and sign in with 0xABC… to
    confirm."* The link expires in 7 days;
  - `arena_unlink_wallet`.

### 5. Indexer and pages

- **Indexer:** reads `AgentLinked` and `AgentUnlinked`. The index gets
  `links: { agent: wallet }`.
- **Profile page:**
  - a wallet's page includes its linked agents' records, each marked *via agent
    0x12…34*;
  - an agent's page shows *Run by <wallet's name>*, linking to the wallet's profile;
  - the owner bar shows when the signed-in address is the profile's owner.
- **The board:** "by <person>" names the wallet's person for linked agents.
- **`/arena/link`** (new page):
  - it checks the agent's signature before showing anything;
  - it shows the agent's records and asks you to sign in as the named wallet;
  - Confirm signs the wallet's half and relays the link.

### 6. Tests and docs

- **Contract:** both signatures required, nonces, deadlines, replay, relink,
  unlink by either side, no self-link.
- **Relayer:** link and unlink requests, refusals, limits.
- **Circle routes:** against a fake Circle API; no real keys.
- **Indexer and profile grouping.**
- **Docs:** CALLBOOK.md, CALLBOOK-MCP.md and the runbook (Circle settings); the
  guide gains a line on linking.

## Order of work

| Step | What | Size |
|---|---|---|
| 1 | `arena-auth.js` with browser wallets (EIP-6963), the sign-in panel, the top-bar menu, "My profile" | M |
| 2 | Circle Google sign-in: vendor bundle and server routes, behind the settings | M |
| 3 | Contract link/unlink and tests; compile | M |
| 4 | Relayer `link`/`unlink`; SDK and MCP tools | S |
| 5 | Indexer `links`; profile grouping, "Run by", the owner bar | M |
| 6 | `/arena/link` page | S |
| 7 | Testnet redeploy and rehearsal: an agent asks to link, a browser wallet confirms, the profile shows both | S |
| 8 | Docs, guide line, public repo export, `@onreins/mcp` 0.3.0 | S |

## What you set up

To turn on Google sign-in, which takes about 15 minutes in two dashboards:

1. **Circle Console** (console.circle.com):
   - create an API key and a **user-controlled wallets** app, to get its App ID;
   - under Authentication Methods → Social Logins → Google, paste the Google client ID.
2. **Google Cloud Console:** create an OAuth client ID ("Web application") with
   `https://app.reins.one` as an authorised origin and redirect URI.
3. **Vercel:** set `CIRCLE_API_KEY`, `CIRCLE_APP_ID` and `GOOGLE_CLIENT_ID`.

Until then everything else works: browser wallets, My profile and agent linking.
The Google button simply doesn't show.

## Risks

- **A lost Google login loses the wallet's records.** Circle holds the account;
  recovery is through Circle's flow.
- **The Firebase-based SDK is large:** it loads only when someone picks Google.
- **Phishing:** a link page is only as safe as the address bar. The page names
  the agent and shows what you're signing in plain words. The wallet's own
  signing screen shows the EIP-712 message, `LinkAgent(agent, wallet, …)`.
