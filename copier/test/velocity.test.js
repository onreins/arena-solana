// The copier's orders translate into Velocity's own order params correctly,
// checked with the real SDK's types and enums (no network needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import sdk from "@velocity-exchange/sdk";

import { velocityOrderParams } from "../src/velocity.js";
import { ordersFor } from "../src/orders.js";
import { withExits } from "../../app/verify/callbook-exits.js";

const { OrderType, OrderTriggerCondition, PositionDirection, MarketType, isVariant, DevnetPerpMarkets } = sdk;

test("a long with exits becomes a market entry plus reduce-only trigger TP and SL", () => {
  const salt = withExits(`0x${"ab".repeat(32)}`, { stop: "140", target: "175.5" });
  const orders = ordersFor({ side: 1, base: 1_660_000_000n, salt });
  const [entry, tp, sl] = velocityOrderParams(orders, { marketIndex: 0, userOrderId: 254, maxTs: 1_800_000_030 });

  assert.ok(isVariant(entry.orderType, "market"));
  assert.ok(isVariant(entry.direction, "long"));
  assert.ok(isVariant(entry.marketType, "perp"));
  assert.equal(entry.baseAssetAmount.toString(), "1660000000");
  assert.equal(entry.reduceOnly, false);
  assert.equal(entry.maxTs.toString(), "1800000030");

  assert.ok(isVariant(tp.orderType, "triggerMarket"));
  assert.ok(isVariant(tp.direction, "short"));
  assert.ok(isVariant(tp.triggerCondition, "above"));
  assert.equal(tp.triggerPrice.toString(), "175500000");
  assert.equal(tp.reduceOnly, true);

  assert.ok(isVariant(sl.orderType, "triggerMarket"));
  assert.ok(isVariant(sl.triggerCondition, "below"));
  assert.equal(sl.triggerPrice.toString(), "140000000");
  assert.equal(sl.reduceOnly, true);

  assert.deepEqual([entry.userOrderId, tp.userOrderId, sl.userOrderId], [254, 255, 1], "consecutive ids wrap within 1..255");
  assert.equal(entry.builderIdx ?? null, null, "no builder fee unless configured");
});

test("a builder fee rides on every order when configured", () => {
  const orders = ordersFor({ side: -1, base: 10_000_000n, salt: `0x${"cd".repeat(32)}` });
  const [entry] = velocityOrderParams(orders, { marketIndex: 2, userOrderId: 7, maxTs: 1, builder: { idx: 0, feeTenthBps: 50 } });
  assert.ok(isVariant(entry.direction, "short"));
  assert.equal(entry.marketIndex, 2);
  assert.deepEqual([entry.builderIdx, entry.builderFeeTenthBps], [0, 50]);
});

test("devnet lists SOL, BTC and ETH, the coins the copier can copy there", () => {
  assert.deepEqual(DevnetPerpMarkets.map((m) => m.baseAssetSymbol), ["SOL", "BTC", "ETH"]);
  assert.ok(OrderType && OrderTriggerCondition && PositionDirection && MarketType);
});
