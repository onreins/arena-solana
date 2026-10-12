# Drift feature check for Phase B (copy-trading)

Checked 2026-10-12 against the current code and SDKs, as the brief in `docs/SOLANA-PORT.md` (Phase B) requires.

## Read this first: Drift as the brief describes it no longer exists

1. **Drift was exploited on 2026-04-01 and its program was halted that same day.** On `drift-labs/protocol-v2` master, commit `e32903b` ("comment out all ixs", 2026-04-01) comments out every instruction in `programs/drift/src/lib.rs`: 0 active `pub fn` and 245 commented. The last public Drift program change is that commit. The repo's later commits only rename URLs to `velocity-exchange` (b516f71, 2026-06-23).
2. **Drift relaunched as Velocity Exchange.** It is a fork of protocol-v2 with a new program, a new SDK and a reduced feature set:
   - **Monorepo:** `github.com/velocity-exchange/velocity-v1`. It is public and active; HEAD `a23cd9d` is dated 2026-10-10.
   - **Program:** `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P`, the same id on devnet and mainnet (`Anchor.toml`, README "Deployments").
   - **SDK:** `@velocity-exchange/sdk@0.26.0` (2026-09-28). Its main class is `VelocityClient`, which replaces `DriftClient` with no aliases.
   - **Collateral:** USDT on mainnet (`Es9vMF…`) and a devnet dUSDT placeholder. It is no longer USDC.
   - **Migration guide:** `velocity-v1/docs/DRIFT-TO-VELOCITY.md` says: "The original Drift program is paused. Velocity is an entirely new program deployment with a new program ID … No on-chain state carries over."
3. **Mainnet is a whitelisted private beta.** Press coverage from July to September 2026 (The Defiant, CryptoTimes, Solana Compass) says public launch is "after audits", with no date given. The program can gate account creation with `State.whitelist_mint` (`programs/velocity/src/instructions/user.rs:167-171`). That doesn't matter much for us, because we are devnet only. Whether devnet has a whitelist mint set is UNCONFIRMED.
4. **The old `@drift-labs/sdk` is a dead end.** Its `latest` tag, 2.163.0-beta.13 (2026-05-11), is already a Velocity transition build:
   - its devnet program id is `vELoC…`;
   - it lists one devnet perp market;
   - its devnet quote is `dUSDT` `8FfvSR…`, which no longer matches the current Velocity devnet mint.

   `stable` 2.156.0 (2026-01) still points at the halted `dRifty…` program.

**Conclusion:** build Phase B on **Velocity** (`@velocity-exchange/sdk`) on devnet. Every mechanism the brief needs survives there, with the same names and semantics as Drift's: delegates, trigger orders, bracket orders in one tx, `userOrderId`, builder codes and PnL getters. In product copy, say "Velocity (formerly Drift)".

**Sources and access limits:**
- **Blocked:** `docs.drift.trade`, `docs.velocity.exchange`, `drift.trade` and every Solana RPC are blocked from this container (proxy 403 or DNS failure). Nothing below was run on devnet.
- **Program source:** `velocity-exchange/velocity-v1@a23cd9d` and `drift-labs/protocol-v2@13e8e9b`, including the `devnet` branch at `80b736e`.
- **Docs source:** `drift-labs/v2-teacher@35bfa83`, the source of the old Drift API docs.
- **npm tarballs read:** `@velocity-exchange/sdk@0.26.0`, `@drift-labs/sdk@2.156.0` and `@drift-labs/sdk@2.163.0-beta.13`, unpacked under `/tmp/claude-0/drift-sdk/`.

Below, **V** means `velocity-v1/programs/velocity/src/` and **SDK** means `@velocity-exchange/sdk@0.26.0/lib/node/`.

---

## Feature table

| Feature | Exists? | How (method/instruction) | Source | Notes |
|---|---|---|---|---|
| **Drift protocol itself** (`dRifty…`) | **No (halted)** | — | protocol-v2 commit `e32903b`; `DRIFT-TO-VELOCITY.md` §1 | All instructions were removed on 2026-04-01. Use Velocity. |
| Set a delegate on a user (sub)account | Yes | ix `update_user_delegate(sub_account_id, delegate)`; SDK `VelocityClient.updateUserDelegate(delegate, subAccountId=0)` / `getUpdateUserDelegateIx(delegate, {subAccountId, authority})` | V `lib.rs:422`, `instructions/user.rs:3679` (handler), `UpdateUser` struct `user.rs:5627`; SDK `velocityClient.d.ts:783-795` | **One delegate per subaccount** (`User.delegate: Pubkey`). Only the owner can call it: the `UpdateUser` PDA is seeded by `authority` and `authority` must be a `Signer`. The same call works on Drift (v2-teacher `index.html.md:288-311`). |
| Revoke a delegate at any time | Yes | `updateUserDelegate(PublicKey.default, subAccountId)` | SDK `velocityClient.d.ts:770-795` jsdoc ("pass `PublicKey.default` to remove") | Takes effect immediately. The program treats a default key as "no delegate" (`instructions/constraints.rs:22-27`). Orders the delegate already placed stay live until cancelled, so the app's "stop copying" should also call `cancelOrders` signed by the owner. |
| Delegate can place, cancel and modify orders | Yes | `place_perp_order`, `place_orders`, `place_and_take_perp_order`, `place_scale_orders`, `cancel_order(s)`, `cancel_order_by_user_id`, `cancel_orders_by_ids`, `modify_order(_by_user_id)`: their account structs use `can_sign_for_user` (authority **or** delegate) | V `instructions/constraints.rs:22` `can_sign_for_user`; structs `PlaceOrder` `user.rs:5426`, `CancelOrder` `:5437`, `PlaceAndTake` `:5537` | Signed-msg (Swift) orders can also be delegate-signed (`SignedMsgOrderParamsDelegateMessage`). |
| Delegate **cannot withdraw** | Yes (enforced) | `Withdraw`, `WithdrawIsolatedPerpPosition`, `TransferDeposit`, `TransferPools`, `DeleteUser`, `InitializeUser` and `ChangeApprovedBuilder` require `has_one = authority` | V `user.rs:5262` (`Withdraw`), `:5296` (`TransferDeposit`); SDK jsdoc `velocityClient.d.ts:771-776`: "delegates can never withdraw" | Matches the brief. |
| Delegate moves funds between the owner's subaccounts | **Opt-in only** (new in Velocity) | `transfer_deposit_by_delegate` only after the owner calls `update_user_allow_delegate_transfer(true)` (`UserStats.delegate_permissions`); SDK `transferDepositByDelegate`, `updateUserAllowDelegateTransfer` | V `lib.rs:166`, `user.rs:1020-1042`, `:3689`; `DRIFT-TO-VELOCITY.md` §3 (PR #45) | Off by default, and we should never ask for it. **However:** `transfer_perp_position` and `transfer_isolated_perp_position_deposit` use `can_sign_for_user` on both from and to users. A delegate that is delegate on **both** subaccounts can move a perp position between them. Same authority only, so no funds leave the owner. |
| Delegate deposit | Yes | `deposit`: any signer may deposit from **its own** token account; a third-party depositor that isn't authority or delegate must be whitelisted on mainnet | V `user.rs:5213` (`Deposit`), `user.rs:729` | Not needed. Followers fund their own accounts. |
| Delegate swap | Yes (restricted) | `begin_swap`/`end_swap` (`Swap` struct `can_sign_for_user`; token accounts must be owned by the signer; a delegate gets a narrower program allow-list) | V `user.rs:3981`, `:4217`, `:5232-5254` | **Trust caveat:** a delegate can lose a follower's money by trading badly (bad swaps, wash trades) even though it can't withdraw. This is inherent to delegation, so say it in the UI. |
| Node: delegate signs for another authority's account | Yes | `new VelocityClient({ connection, wallet: copierWallet, env: 'devnet', authority: followerAuthority, subAccountIds: [n], activeSubAccountId: n })` for one follower; for many: `authoritySubAccountMap: new Map([[followerA.toBase58(), [n]], …])` **or** `includeDelegates: true` (auto-discovers via `getUserAccountsForDelegate(delegate)`, a `memcmp` on `User.delegate`) | SDK `velocityClientConfig.d.ts:30-47`; Drift equivalent `driftClient.js:138-152`, `:559-591`; v2-teacher `index.html.md:204-244` | `includeDelegates`, `subAccountIds` and `authoritySubAccountMap` are mutually exclusive (the constructor throws). Per order, select the account with `switchActiveUser(subId, authority)`, or pass `subAccountId` plus the active authority. `getUser(subId, authority)` reads a follower. |
| Perp market order | Yes | `getMarketOrderParams({marketIndex, direction, baseAssetAmount, userOrderId, maxTs, …})` → `placePerpOrder` (an auction filled by keepers or JIT) or `placeAndTakePerpOrder` (fills immediately against the AMM/makers in the same tx) | SDK `orderParams.d.ts`; `velocityClient.d.ts:2081`, `:2787` | `OrderType.MARKET`, `LIMIT`, `TRIGGER_MARKET`, `TRIGGER_LIMIT` and `ORACLE` exist (`types.d.ts`). |
| TP/SL trigger orders | Yes | `getTriggerMarketOrderParams({ triggerCondition: OrderTriggerCondition.ABOVE \| BELOW, triggerPrice, reduceOnly: true, direction: opposite, baseAssetAmount })` or `getTriggerLimitOrderParams` (adds `price`) | SDK `orderParams.d.ts`; `types.d.ts` (`OrderTriggerCondition` ABOVE, BELOW, TRIGGERED_ABOVE, TRIGGERED_BELOW) | Long position: TP is `ABOVE` and SL is `BELOW`, both SHORT and reduce-only; a short is the mirror. Triggers are executed by keepers (`trigger_order`) at oracle price, so fills can slip. |
| Bracket entry + TP + SL **atomically in one tx** | Yes | (a) `placeAndTakePerpWithAdditionalOrders(entryParams, makerInfo?, [tpParams, slParams], txParams, subAccountId)`: one tx holding `place_and_take_perp_order` + `place_orders([tp, sl])`; or (b) `placeOrders([marketEntry, tp, sl])`, one `place_orders` ix (max 32 orders; IOC not allowed); or (c) Swift signed message with `takeProfitOrderParams`/`stopLossOrderParams` (the program builds reduce-only `TriggerMarket` orders) | SDK `velocityClient.d.ts:2813-2840`, `:2305`; Drift impl `driftClient.js:3769-3791`; V `user.rs:3049-3097` (`max 32 order params`); Drift `keeper.rs` signed-msg SL/TP build | Option (a) is best for the demo: the entry fills in the same tx and the triggers rest. `place_orders` now checks margin per risk scope (`DRIFT-TO-VELOCITY.md` §3, #135). |
| Devnet deployment | Yes (Velocity) | Program `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P`; SDK `env: 'devnet'` (`VelocityEnv = 'devnet' \| 'mainnet-beta'`) | SDK `config.js:10-35`, `config.d.ts:11`; repo `Anchor.toml:22,30` | Couldn't confirm it is live on devnet right now, because RPC is blocked. UNCONFIRMED. |
| Devnet perp markets | Yes, 3 | SOL-PERP (0), BTC-PERP (1), ETH-PERP (2) | SDK `constants/perpMarkets.js` `DevnetPerpMarkets` | Mainnet lists SOL, BTC, ETH, HYPE and ZEC. Old Drift devnet had about 30 markets. |
| Devnet collateral (quote) and faucet | Yes | Spot 0 = **dUSDT** mint `GqmEqYsy8EyvofDpmtFxK8zhYrgWgNokAtYoduQdL7v6`; permissionless faucet program `token_faucet` `V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB`, ix `mint_to_user(amount)`; SDK class `TokenFaucet` (`tokenFaucet.d.ts`) | SDK `config.js:35`, `constants/spotMarkets.js`; repo `deploy-scripts/README.md:360-394` ("anyone can call `mint_to_user` for devnet dUSDT"); `programs/token_faucet/src/lib.rs:15,49` | **It is USDT, not USDC.** It is a placeholder mint, so it is unrelated to the SPL USDC we'd use for subscriptions. Followers also need devnet SOL for rent (about 0.035 SOL per user account). |
| Builder codes (app fee on routed orders) | **Yes**, and broader than on Drift | Builder: `initializeRevenueShare(builderAuthority)` + a Velocity user account. Follower, once: `initializeRevenueShareEscrow(followerAuthority, numOrders)` (**payer can be the app**, `overrides.payer`) + `changeApprovedBuilder(builder, maxFeeTenthBps, true)` (**follower must sign**). Per order: `OrderParams.builderIdx` + `builderFeeTenthBps` | V `user.rs:2744-2763` (`place_perp_order` loads escrow and builder for any signer), `user.rs:3134-3141` (`place_orders`), `:3267-3276` (`place_and_take`); `optional_accounts.rs:396-500`; `math/constants.rs:230` `MAX_BUILDER_FEE_TENTH_BPS = 1000` (10 bps); SDK `velocityClient.d.ts:544-615`; `DRIFT-TO-VELOCITY.md` §3 (#68, #73) | On Drift, builder codes were "limited to Swift orders only" (v2-teacher `index.html.md:1437-1492`). On Velocity they are a field on regular `OrderParams`, so they **work for delegate-placed orders.** Fees accrue in the escrow and are paid to the builder's account on `settle_pnl` or by the permissionless `settle_revenue_share`. Whether `builder_codes_enabled` is on for devnet is UNCONFIRMED (a state flag, `update_feature_bit_flags_builder_codes`). |
| Referrer fees | Yes (limited) | Referrer is set **only when the follower's first subaccount is created**: `initializeUserAccount(0, name, referrerInfo)`. It is copied into the escrow at `initializeRevenueShareEscrow` and never rewritten. Standard rate per fee tier (fresh default 10% of taker fee), plus an "accelerated" rate | V `user.rs` `handle_initialize_user` (referrer only if `number_of_sub_accounts_created == 0`); SDK jsdoc `velocityClient.d.ts:550-570`; `DRIFT-TO-VELOCITY.md` §2 (legacy path removed, #67), §3 (#429) | Only works for followers who **open their Velocity account through our app**. Existing users can't be referred later. |
| Read PnL for performance fee | Yes | `user = client.getUser(subId, authority)`: `user.getUnrealizedPNL(withFunding=true, marketIndex?)`, `user.getUnrealizedFundingPNL()`, `user.getNetUsdValue()`, **`user.getTotalAllTimePnl()`** (= net USD value + total withdrawals − total deposits). Raw fields: `UserAccount.settledPerpPnl`, `totalDeposits`, `totalWithdraws`, `cumulativePerpFunding`; `PerpPosition.settledPnl`, `quoteEntryAmount`, `quoteBreakEvenAmount`. Settle: `settlePNL(userPk, userAccount, marketIndex)` / `settleMultiplePNLs(...)` (permissionless) | SDK `user.d.ts:348-356`, `:628`, `:679`; `types.d.ts:1706-1721`, `:1785-1794`; `velocityClient.d.ts:3269`, `:3299` | All values are per **subaccount**, in `QUOTE_PRECISION` 1e6 (USDT). Settling only moves PnL into the quote balance; `getTotalAllTimePnl` already counts unsettled PnL. |
| `userOrderId` dedupe | Partly | `OrderParams.userOrderId: u8` (1-255; 0 means none). The program rejects `UserOrderIdAlreadyInUse` **only while an order with that id is still open** on that subaccount. Also `cancelOrderByUserId`, `modifyOrderByUserOrderId`, `user.getOrderByUserOrderId` | V `controller/orders.rs:160-171`; SDK `velocityClient.d.ts:2211`, `:3180`, `user.d.ts:203` | **Not idempotent for market orders:** once the entry fills, its slot frees and a retry with the same id is accepted. It does guard resting trigger orders. See the copier design. |
| `maxTs` order expiry | Yes | `OrderParams.maxTs` (unix secs). If `max_ts < now` at execution, the order is skipped (not placed) | V `controller/orders.rs:267-289` | Use a short `maxTs` (lock time + about 30 s) so a late or replayed tx can't open a stale position. |
| Limits | Yes | 32 open orders per subaccount (`User.orders: [Order; 32]`); 32 orders per `place_orders`; min order size and step per market (`perpMarket.marketStats.minOrderSize`, `perpMarket.orderStepSize`), so round `baseAssetAmount` down to the step | V `state/user.rs:101`, `user.rs:3095`, `state/perp_market.rs:364`, `controller/orders.rs:3656` | Read the live values from `client.getPerpMarketAccount(i)`, because they are admin-set (UNCONFIRMED for devnet). Each copied call uses 3 order slots (entry + TP + SL). |
| Market-order auction and oracle | Yes | Market orders use a short Dutch auction (`auctionDuration`, `auctionStartPrice`, `auctionEndPrice`, otherwise defaults from state). Oracle is Pyth Lazer plus the MM oracle; legacy Pyth pull and Switchboard were removed | `DRIFT-TO-VELOCITY.md` §2 (#7, #14), §3 (#282 auction floor) | `placeAndTakePerpOrder` avoids waiting on the auction. |
| Program API rate limits | No on-chain limit | Throughput is bounded by our RPC and tx landing; Swift server `wss://swift.velocity.exchange/ws` (devnet `wss://swift.master.velocity.exchange/ws`) | SDK `swift/*` | Public `api.devnet.solana.com` rate-limits, so use a private devnet RPC (Helius etc.). Velocity's own devnet runbook says the same. |
| SDK version, deps and format | Yes | `@velocity-exchange/sdk@0.26.0`; depends on **`@solana/web3.js` 1.99.0 (v1)** plus `@anchor-lang/core@1.0.1` (aliased as `@coral-xyz/anchor`), `@coral-xyz/anchor-29`, `gill`, which pulls `@solana/kit` transitively, `@triton-one/yellowstone-grpc`, Pyth libs and litesvm. **CommonJS only** (README: "`module` points at a browser-shimmed CommonJS build rather than ESM"); Node ≥ 20 | `npm view @velocity-exchange/sdk`; package `README.md` | Heavy: 14.2 MB unpacked, and a clean `npm install` in a scratch dir took **565 packages / 419 MB `node_modules`**. Our repo is `"type": "module"` with `@solana/web3.js ^1.98.4`. Import it via `import pkg from '@velocity-exchange/sdk'` or `createRequire`, and expect a second web3.js copy (pinned 1.99.0). Keep it inside `copier/` as its own package. |

---

## Differences from the brief

1. **"Drift" → Velocity.**
   - **Brief:** build on Drift's devnet.
   - **Reality:** Drift's program is paused and has no instructions. The successor, Velocity, is a new program (`vELoC…`) with a new SDK (`@velocity-exchange/sdk`, `VelocityClient`) and no carried-over state.
   - **Mainnet:** a whitelisted private beta.
   - **Alternative:** Velocity devnet. Every PDA differs from Drift's, so don't reuse old Drift addresses or decoders.
2. **Collateral is USDT, not USDC.**
   - **Mainnet:** quote is USDT.
   - **Devnet:** quote is the dUSDT placeholder `GqmEqY…`, minted by the permissionless `token_faucet`.
   - **Effect on our code:** the follow program's subscription payments can stay in devnet USDC (SPL), as an unrelated mint. The copier's sizing and PnL are denominated in the Velocity quote, which is (d)USDT.
3. **Devnet has only 3 perp markets: SOL, BTC and ETH.**
   - Arena calls on other coins can't be copied.
   - The copier must skip unlisted symbols, log them, and show "not copyable on Velocity".
4. **Devnet can be wiped.**
   - Velocity's runbook wipes and reinitializes devnet state after layout-breaking upgrades (`docs/agents/devnet.md`).
   - The program id has also changed twice inside the old SDK's betas: `FGXf…` → `vELoC…`.
   - **What to do:** pin the SDK version, script follower onboarding so it is repeatable, and re-check right before the demo.
5. **A delegate is per subaccount and owner-set.**
   - It works as the brief says: place, cancel and modify are allowed; withdraw is not; the owner can revoke any time.
   - **Extra (opt-in only, never request):**
     - `transfer_deposit_by_delegate` moves collateral between the owner's subaccounts, only if the owner enabled it.
     - A delegate on two of the owner's subaccounts can call `transfer_perp_position` between them.
   - **Still a trust caveat:** a delegate can't withdraw, but it can trade the account into losses.
6. **App fees.**
   - **Builder codes exist and work for delegate-placed orders,** a Velocity change; on Drift they were Swift-only.
   - **Cap:** 10 bps per order (`MAX_BUILDER_FEE_TENTH_BPS = 1000`).
   - **Follower onboarding:** the follower must sign `changeApprovedBuilder(reinsBuilder, maxFee, true)` once. The escrow init can be paid by us.
   - **Referrer:** referrer fees exist only for followers whose Velocity account was **created** with our referrer. Treat referral as a bonus, not as the fee mechanism.
   - **UNCONFIRMED:** whether `builder_codes_enabled` is set on devnet. If it's off, orders with a builder fee are simply placed without one; drop the "fee on copied orders" claim and say so, per the brief.
7. **"Placed exactly once" can't rely on `userOrderId`.**
   - Its uniqueness check only covers *currently open* orders, and it is a u8 (255 values per subaccount).
   - **Alternative:** idempotency at the transaction level, described in the design below.
8. **PnL is per subaccount, not per copied trade.**
   - `getTotalAllTimePnl` / `settledPerpPnl` mix everything traded on that subaccount, including the follower's own trades.
   - **Alternative:** require a **dedicated subaccount** for copying (`initializeUserAccount(nextSubId, 'Reins copy')`). Delegate only that one, and compute the performance fee from that subaccount's `getTotalAllTimePnl()` against a stored high-water mark.
   - **Performance fee collection** can't be pulled from the follower's Velocity account, because the delegate can't withdraw. It has to be charged separately, e.g. from a USDC allowance or prepaid balance in the follow program, or settled as an invoice. That points to the brief's fallback: off-chain computation with an on-chain settlement record.
9. **Bracket orders via Swift.**
   - Swift signed messages carry TP and SL natively.
   - **But:** Swift needs Velocity's off-chain server, and its devnet availability is UNCONFIRMED.
   - **Recommendation:** use on-chain `placeAndTakePerpWithAdditionalOrders` instead.

---

## Recommended copier design

- **SDK and account setup**
  - `copier/` is its own CJS-interop package depending on `@velocity-exchange/sdk@0.26.0`, pinned exactly.
  - Run one `VelocityClient` with `wallet` = the copier key from env (never logged) and `env: 'devnet'`.
  - Use `authoritySubAccountMap` built from active, paid Follow accounts, and rebuild it when follows change. `includeDelegates: true` also works, but it discovers every account that delegates to us, paid or not.
  - Use polling or websocket subscription against a private devnet RPC.
- **Follower onboarding (app, follower signs)**
  1. If the follower has no Velocity account: `initializeUserAccount(0, …, reinsReferrerInfo)`, plus dUSDT from the faucet and a deposit.
  2. Create a dedicated copy subaccount: `initializeUserAccount(k, 'Reins copy')`, then deposit into it.
  3. `updateUserDelegate(copierPubkey, k)`.
  4. Builder fee, optional: we pay `initializeRevenueShareEscrow(follower, numOrders ≥ 3 × maxOpenCopied)`; the follower signs `changeApprovedBuilder(reinsBuilder, maxFeeTenthBps, true)`.
  5. Subscribe in `programs/follow`. Steps 3 and 4 and the subscription can be batched into one or two wallet prompts.
- **On a verified lock (preimage matches the on-chain hash)**, for each active follow, in parallel:
  1. **Check limits** from the follow account and live state:
     - max size;
     - open copied positions, counted from `getActivePerpPositions()`;
     - daily-loss cap, from the change in `getTotalAllTimePnl()` since 00:00 UTC.
  2. **Size the order** (fixed, or % of `getNetUsdValue()`), rounded down to `orderStepSize` and ≥ `minOrderSize`.
  3. **Build one tx:** `preparePlaceAndTakePerpOrderWithAdditionalOrders(entry, undefined, [tp, sl], txParams, k)`.
     - **Entry:** MARKET, `maxTs` = now + about 30 s, `userOrderId` derived from (callId, follow) mod 255, never 0.
     - **TP and SL:** `TRIGGER_MARKET`, `reduceOnly: true`, ABOVE/BELOW from the call's exits; their `userOrderId`s are also derived.
     - **Builder fields:** `builderIdx`/`builderFeeTenthBps` when approved.
  4. **Make it idempotent:**
     - Sign the tx, **persist `(callId, follower, txSignature, rawTx, lastValidBlockHeight)` before the first send**, then send and re-broadcast the *same* bytes until confirmed or the blockhash expires.
     - On restart, read the persisted rows. Use `getSignatureStatuses` to find what landed, and only re-sign a new tx if the old blockhash has provably expired **and** the order has no on-chain trace (no matching `userOrderId` among open orders, no `OrderActionRecord` for it).
     - The `maxTs` stops a stale tx from opening a position late.
  5. **Log latency** from lock slot/time → confirmation per order.
- **Stop copying:** the follower signs `updateUserDelegate(PublicKey.default, k)` plus `cancelOrders(PERP, undefined, undefined, undefined, k)`. Delegation can also be revoked outside our app, so the copier must handle signer errors gracefully: mark the follow as revoked.
- **Performance fee:**
  - On a schedule, read `getTotalAllTimePnl()` of each copy subaccount (permissionless `settlePNL` first if desired).
  - Charge `rate × max(0, pnl − HWM)`, then raise the HWM.
  - Compute off-chain, record each settlement on-chain in `programs/follow`, and collect in USDC from the follower outside Velocity, since the delegate can't withdraw. Disclose this, as the brief allows.
- **Before building, verify on devnet with a private RPC:**
  - the program is executable and `State.whitelist_mint` is default;
  - the `builder_codes_enabled` flag;
  - `minOrderSize` and `orderStepSize` for markets 0-2;
  - the faucet `mint_to_user` works.

---

## Verified on Velocity devnet (2026-10-12)

These were read live from devnet once network access was opened:

- **Live:** the program `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P` is executable, and its State account exists.
- **Open:** `whitelist_mint` is the default key, so anyone can create an account.
- **Builder codes are on:** `feature_bit_flags` = 5, which includes `BUILDER_CODES` (4). The fee on copied orders is available on devnet.
- **Markets:** SOL-PERP, BTC-PERP and ETH-PERP exist. The order step size is 0.0001 for SOL and BTC and 0.001 for ETH.
- **No minimum order size field:** Velocity's perp markets carry only `order_step_size`, so the smallest order is one step. The copier's adapter now uses that. It used to read a minimum-size field that doesn't exist and would have thrown.
- **dUSDT** `GqmEqY…` uses the classic SPL Token program, which the app's deposit flow supports.
