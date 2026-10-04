/* The create page's choices, as rules the contract enforces. A personality
   sets the loss limit, the largest trade as a share of the deposit, and how far
   from the oracle a fill may land; a strategy template takes its loss limit
   from its backtest. Needs strategy-math.js (for the template loss limit).
   Tested by test/create-math.test.js. */
window.ReinsCreate = (function () {
  "use strict";

  var MIN_TRADE_USD = 0.01; // the contract refuses a zero per-trade cap
  var DAYS = { month: 30, quarter: 90, year: 365 };

  /**
   * Limits planned on the Charts page, read from the address. Each one is held
   * to its slider's range; null when there's no plan (no loss limit given).
   */
  function fromPlan(p) {
    var n = function (x) { var v = Number(x); return x !== null && x !== undefined && x !== "" && Number.isFinite(v) ? v : null; };
    var loss = n(p && p.loss);
    if (loss === null) return null;
    var keep = function (x, lo, hi, d) { return x === null ? d : Math.min(hi, Math.max(lo, x)); };
    var deposit = n(p.deposit);
    return {
      id: "plan", label: "Your chart plan", icon: "strategies",
      lossPercent: Math.round(keep(loss, 1, 60, 10)),
      tradeShare: Math.round(keep(n(p.trade), 5, 100, 20) / 5) * 5 / 100,
      bandPercent: Math.round(keep(n(p.band), 0.1, 5, 1) * 10) / 10,
      deposit: deposit === null ? null : Math.round(keep(deposit, 1, 1e6, 50)),
    };
  }

  var PERSONALITIES = {
    careful: { id: "careful", label: "Careful", lossPercent: 5, tradeShare: 0.1, bandPercent: 0.5,
      line: "Small trades, tight prices, stops early.", icon: "shield" },
    balanced: { id: "balanced", label: "Balanced", lossPercent: 10, tradeShare: 0.2, bandPercent: 1,
      line: "Room to work, a firm floor.", icon: "strategies" },
    bold: { id: "bold", label: "Bold", lossPercent: 25, tradeShare: 0.35, bandPercent: 2,
      line: "Bigger swings, a lower floor.", icon: "explore" },
  };

  var cents = function (n) { return Math.round(n * 100) / 100; };

  /** The contract's rules for a personality and a deposit. */
  function rulesFor(p, deposit) {
    return {
      maxTradeUsd: Math.max(MIN_TRADE_USD, cents((Number(deposit) || 0) * p.tradeShare)),
      maxLossPercent: p.lossPercent,
      maxSlippagePercent: p.bandPercent,
    };
  }

  /** A personality from a strategy template: its loss limit a little beyond its worst drop. */
  function fromTemplate(s) {
    return { id: "template", label: s.name, lossPercent: window.ReinsStrategyMath.lossLimit(s.stats.max_drawdown),
      tradeShare: PERSONALITIES.balanced.tradeShare, bandPercent: PERSONALITIES.balanced.bandPercent,
      line: "Rules set from its backtest.", icon: "strategies" };
  }

  /** Where it freezes: the deposit less the loss limit. */
  function floorOf(deposit, lossPercent) { return cents((Number(deposit) || 0) * (1 - lossPercent / 100)); }

  var FIRST = ["Steady", "Patient", "Nimble", "Quiet", "Brave", "Careful", "Clever", "Swift", "Calm", "Bright", "Sly", "Gentle"];
  var SECOND = ["Otter", "Falcon", "Heron", "Fox", "Badger", "Lynx", "Owl", "Hare", "Wren", "Marten", "Ibis", "Stoat"];
  /** A two-word name from two rolls in [0, 1). */
  function nameIdea(a, b) {
    var pick = function (list, r) { return list[Math.min(list.length - 1, Math.floor(r * list.length))]; };
    return pick(FIRST, a) + " " + pick(SECOND, b);
  }

  return { PERSONALITIES: PERSONALITIES, fromPlan: fromPlan, DAYS: DAYS, MIN_TRADE_USD: MIN_TRADE_USD, rulesFor: rulesFor, fromTemplate: fromTemplate, floorOf: floorOf, nameIdea: nameIdea };
})();
