/**
 * The exchange adapter for Velocity (formerly Drift; see docs/solana/DRIFT-CHECK.md).
 *
 * The copier's key is the *delegate* of each follower's dedicated copy
 * subaccount: Velocity lets a delegate place and cancel orders, never
 * withdraw, and the follower can revoke it at any time from Velocity itself.
 *
 * Orders go out as one placeOrders instruction per copied call: the market
 * entry plus its take-profit and stop-loss triggers, in a legacy transaction
 * the copier signs and journals before sending (copier.js). Devnet lists
 * SOL, BTC and ETH only; anything else is "not copyable".
 *
 * Not exercised against a live network from the build container (Solana RPC
 * is blocked there): the order translation is unit-tested with the real SDK
 * types (test/velocity.test.js); the rest needs a devnet run.
 */
import sdk from "@velocity-exchange/sdk";
import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

import { sendAndConfirmByPolling } from "../../solana/arena.js";

const {
  VelocityClient, Wallet, BN, DevnetPerpMarkets, PerpMarkets, PositionDirection, OrderTriggerCondition, MarketType,
  getMarketOrderParams, getTriggerMarketOrderParams, BulkAccountLoader, isVariant,
} = sdk;

const big = (bn) => BigInt(bn.toString());
const bn = (x) => new BN(x.toString());

/** How far past the oracle price a copied entry may fill: 1%. */
export const ENTRY_SLIPPAGE_BPS = 100n;

/**
 * The exchange's order params for the copier's orders (copier/src/orders.js). Pure.
 * The entry is a market order filled through Velocity's auction by its keepers,
 * with a limit `slippageBps` past `oraclePrice` so it never fills at a bad price.
 * (An immediate fill against the AMM needs a fresh oracle in the same
 * transaction, a paid Pyth Lazer update: on devnet it fails with "oracle not
 * valid for immediate fills".)
 */
export function velocityOrderParams(orders, { marketIndex, userOrderId, maxTs, builder = null, oraclePrice = null, slippageBps = ENTRY_SLIPPAGE_BPS }) {
  return orders.map((o, i) => {
    const common = {
      marketIndex,
      marketType: MarketType.PERP,
      direction: o.direction === "long" ? PositionDirection.LONG : PositionDirection.SHORT,
      baseAssetAmount: bn(o.base),
      reduceOnly: o.reduceOnly,
      // entry, take-profit and stop-loss of one call carry consecutive ids, wrapping within 1..255
      userOrderId: ((userOrderId - 1 + i) % 255) + 1,
      ...(builder ? { builderIdx: builder.idx, builderFeeTenthBps: builder.feeTenthBps } : {}),
    };
    if (o.kind === "entry") {
      const limit = oraclePrice == null ? {} : {
        price: bn((BigInt(oraclePrice) * (10_000n + (o.direction === "long" ? 1n : -1n) * BigInt(slippageBps))) / 10_000n),
      };
      return getMarketOrderParams({ ...common, maxTs: bn(maxTs), ...limit });
    }
    return getTriggerMarketOrderParams({
      ...common,
      triggerPrice: bn(o.triggerPrice),
      triggerCondition: o.triggerCondition === "above" ? OrderTriggerCondition.ABOVE : OrderTriggerCondition.BELOW,
    });
  });
}

/** One lock at a time around the SDK's "active user", which instruction builders read. */
function mutex() {
  let last = Promise.resolve();
  return (fn) => {
    const run = last.then(fn, fn);
    last = run.catch(() => {});
    return run;
  };
}

/**
 * opts: { connection, keypair (the copier: delegate and fee payer), env = "devnet",
 *         builder?: { idx, feeTenthBps }, computeUnits = 400_000, pollMs = 1_000 }
 */
export async function createVelocityExchange({ connection, keypair, env = "devnet", builder = null, computeUnits = 400_000, pollMs = 1_000, now = () => Date.now() }) {
  const markets = env === "devnet" ? DevnetPerpMarkets : PerpMarkets[env];
  const client = new VelocityClient({
    connection,
    wallet: new Wallet(keypair),
    env,
    authoritySubAccountMap: new Map(),
    accountSubscription: { type: "polling", accountLoader: new BulkAccountLoader(connection, "confirmed", pollMs) },
  });
  await client.subscribe();
  const locked = mutex();
  const added = new Set();
  const watching = new Map(); // signature -> the entry to watch after it lands
  const dayStart = new Map(); // follow -> { day, pnl }: the copy subaccount's all-time PnL at 00:00 UTC (first seen)

  const authorityOf = (f) => new PublicKey(f.follower.toString());
  const sub = (f) => Number(f.settings.subAccountId);

  async function ensureUser(f) {
    const k = `${f.follower}:${sub(f)}`;
    if (added.has(k)) return;
    await client.addUser(sub(f), authorityOf(f));
    added.add(k);
  }

  return {
    async market(coin) {
      const m = markets.find((x) => x.baseAssetSymbol === coin);
      if (!m) return null;
      const perp = client.getPerpMarketAccount(m.marketIndex);
      if (!perp) return null;
      const oracle = client.getOracleDataForPerpMarket(m.marketIndex);
      return {
        marketIndex: m.marketIndex,
        // Velocity's perp markets carry only orderStepSize (no minimum order size field, unlike Drift's
        // spot markets): the smallest order is one step. Checked against devnet's markets on 2026-10-12.
        minSize: big(perp.minOrderSize ?? perp.amm?.minOrderSize ?? perp.orderStepSize),
        stepSize: big(perp.orderStepSize ?? perp.amm?.orderStepSize),
        price: big(oracle.price),
      };
    },

    async account(f) {
      await ensureUser(f);
      const user = client.getUser(sub(f), authorityOf(f));
      const pnl = big(user.getTotalAllTimePnl());
      const day = Math.floor(now() / 86_400_000);
      const key = String(f.address);
      if (dayStart.get(key)?.day !== day) dayStart.set(key, { day, pnl });
      return {
        netValue: big(user.getNetUsdValue()),
        // the subaccount is the follower's dedicated copy account: every open position in it was copied
        openCopied: user.getActivePerpPositions().length,
        dayPnl: pnl - dayStart.get(key).pnl,
      };
    },

    /** The copy subaccount's all-time PnL (quote units): what performance fees are settled on. */
    async pnl(f) {
      await ensureUser(f);
      return big(client.getUser(sub(f), authorityOf(f)).getTotalAllTimePnl());
    },

    async sign(f, market, orders, { userOrderId, maxTs }) {
      await ensureUser(f);
      const params = velocityOrderParams(orders, { marketIndex: market.marketIndex, userOrderId, maxTs, builder, oraclePrice: market.price });
      const ixs = await locked(async () => {
        await client.switchActiveUser(sub(f), authorityOf(f));
        return [await client.getPlaceOrdersIx(params, sub(f))];
      });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight })
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), ...ixs);
      tx.sign(keypair);
      const signature = bs58.encode(tx.signature);
      watching.set(signature, { f, entryId: params[0].userOrderId, bracketIds: params.slice(1).map((p) => p.userOrderId), maxTs });
      return { signature, raw: tx.serialize().toString("base64"), lastValidBlockHeight };
    },

    async send(raw) {
      await connection.sendRawTransaction(Buffer.from(raw, "base64"), { skipPreflight: true, maxRetries: 0 });
    },

    async status(signature, lastValidBlockHeight) {
      const { value: [s] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return s.err ? "failed" : "confirmed";
      const height = await connection.getBlockHeight("confirmed");
      return height > lastValidBlockHeight ? "expired" : "pending";
    },

    /**
     * Wait for it to land, re-broadcasting the same bytes, until it confirms or
     * can no longer land. Then watch the entry until its maxTs: "confirmed" once
     * it fills; if it expires with nothing filled, its take-profit and stop-loss
     * are cancelled (they'd otherwise wait for a later position) and the result
     * is "unfilled"; a partial fill keeps them ("partial": reduce-only, they can
     * never exceed the position).
     */
    async confirm(signature, lastValidBlockHeight, raw = null) {
      let s;
      for (;;) {
        s = await this.status(signature, lastValidBlockHeight);
        if (s !== "pending") break;
        if (raw) await this.send(raw).catch(() => {});
        await new Promise((r) => setTimeout(r, 400));
      }
      const w = watching.get(signature);
      watching.delete(signature);
      if (s !== "confirmed" || !w) return s;
      return this.watchEntry(w);
    },

    async watchEntry({ f, entryId, bracketIds, maxTs }) {
      const user = client.getUser(sub(f), authorityOf(f));
      const orderOf = () => user.getUserAccount()?.orders.find((o) => o.userOrderId === entryId && !isVariant(o.status, "init"));
      let o;
      while (now() / 1000 < maxTs + 15) {
        await user.fetchAccounts().catch(() => {});
        o = orderOf();
        if (o && !isVariant(o.status, "open")) break;
        await new Promise((r) => setTimeout(r, pollMs));
      }
      const filled = o ? big(o.baseAssetAmountFilled) : 0n;
      if (o && filled > 0n && filled === big(o.baseAssetAmount)) return "confirmed";
      if (filled > 0n) return "partial";
      if (bracketIds.length) {
        const ixs = await locked(async () => {
          await client.switchActiveUser(sub(f), authorityOf(f));
          return Promise.all(bracketIds.map((id) => client.getCancelOrderByUserIdIx(id, sub(f))));
        });
        await sendAndConfirmByPolling(connection, new Transaction().add(...ixs), [keypair]).catch(() => {});
      }
      return "unfilled";
    },

    client,
  };
}
