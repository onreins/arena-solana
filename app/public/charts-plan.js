/**
 * The Charts page's planner: set an agent's limits against the chart. Four
 * lines go on the chart (where it starts, the price that would freeze it, and
 * its price band either side) and follow the sliders; dragging a line moves
 * its slider. The plan opens on the create page as it is.
 *
 *   var plan = ReinsChartPlan({ el, chart: () => vela, market: () => row, rules: () => thesisRules });
 *   plan.show(); plan.hide(); plan.reset(); plan.use(rules); plan.tick();
 */
window.ReinsChartPlan = function (opts) {
  "use strict";
  var M = window.ReinsMarkets, esc = window.ReinsUI.esc;
  var KEY = "reins-charts-plan";
  // How a plan line from an earlier visit is recognised: its exact label, on a horizontal line in a plan colour.
  var LABEL = /^(Start|Freeze \u2212\d+%|Band [+\u2212][\d.]+%)$/;
  var ZOOMS = ["1M", "3M", "1Y"];
  var COLORS = { start: "#1e9bff", floor: "#e8716b", band: "#8f8e8e" };

  var plan = M.cleanPlan(read());
  var start = null;      // the starting price the lines hang from
  var lines = {};        // line role -> drawing id, on `drawn`
  var drawn = null;      // the chart the lines are on
  var stop = [];         // event unsubscribers for `drawn`
  var quiet = false;     // our own line moves aren't a person dragging
  var visible = false;
  var removed = false;   // the person took the lines off: they stay off until asked back
  var zoom = 0;

  function read() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(plan)); } catch (e) { /* storage off */ } }
  var $ = function (id) { return document.getElementById(id); };
  var price = function (p) { return "$" + M.price(p); };
  var usd = function (v) {
    return "$" + (v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString("en-US"));
  };

  // ------------------------------------------------------------------ form
  function form() {
    var slider = function (id, label, min, max, step) {
      return '<div class="pl-row"><label for="' + id + '">' + label + '</label><output id="' + id + '-v"></output>' +
        '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '"></div>';
    };
    opts.el.innerHTML =
      '<div class="pl">' +
      '<div class="pl-in">' +
      '<label class="pl-dep" for="pl-dep">Deposit<span>$<input id="pl-dep" type="number" min="5" max="1000000" step="50" inputmode="decimal"></span></label>' +
      slider("pl-loss", "Loss limit", M.PLAN.loss[0], M.PLAN.loss[1], 1) +
      slider("pl-trade", "Largest trade", M.PLAN.trade[0], M.PLAN.trade[1], 5) +
      slider("pl-band", "Price band", M.PLAN.band[0], M.PLAN.band[1], 0.1) +
      '<div class="pl-acts"><button type="button" class="pl-chip" id="pl-rules" title="Set the limits the agents suggest for this coin">Agents’ rules</button>' +
      '<button type="button" class="pl-chip" id="pl-zoom" title="Widen the chart until the lines come into view">Zoom out</button>' +
      '<button type="button" class="pl-chip" id="pl-clear">Remove lines</button></div></div>' +
      '<div class="pl-ladder" id="pl-ladder" aria-hidden="true"></div>' +
      '<div class="pl-out"><ul class="pl-facts" id="pl-facts"></ul>' +
      '<a class="th-go" id="pl-go" href="/create.html">Create an agent with these limits</a>' +
      '<p class="pl-note">Drag the lines on the chart to change them. Agents trade USDC and EURC on Arc testnet for now; the limits carry over.</p></div>' +
      "</div>";
    $("pl-dep").addEventListener("change", function () { set({ deposit: $("pl-dep").value }); });
    $("pl-loss").addEventListener("input", function () { set({ lossPercent: $("pl-loss").value }); });
    $("pl-trade").addEventListener("input", function () { set({ tradePercent: $("pl-trade").value }); });
    $("pl-band").addEventListener("input", function () { set({ bandPercent: $("pl-band").value }); });
    $("pl-rules").addEventListener("click", function () { var r = opts.rules(); if (r) set({ lossPercent: r.lossPercent, tradePercent: r.tradePercent, bandPercent: 1 }); });
    $("pl-clear").addEventListener("click", function () {
      if (drawn) { removed = true; erase(); } else { removed = false; draw(); }
      paint();
    });
    $("pl-zoom").addEventListener("click", function () {
      var c = opts.chart();
      if (!c) return;
      if (!drawn) { removed = false; draw(); }
      c.setVisibleRangePreset(ZOOMS[zoom % ZOOMS.length]);
      zoom++;
      setTimeout(move, 300); // the labels move to the new view's left side
    });
  }

  function set(patch) {
    plan = M.cleanPlan(Object.assign({}, plan, patch));
    save();
    move();
    paint();
  }

  /** The numbers beside the sliders, the ladder and the facts. */
  function paint() {
    if (!$("pl-loss")) return;
    var r = opts.market(), s = start || (r && r.last);
    $("pl-dep").value = plan.deposit;
    $("pl-loss").value = plan.lossPercent;
    $("pl-trade").value = plan.tradePercent;
    $("pl-band").value = plan.bandPercent;
    $("pl-loss-v").textContent = "−" + plan.lossPercent + "%";
    $("pl-trade-v").textContent = plan.tradePercent + "%";
    $("pl-band-v").textContent = "±" + plan.bandPercent + "%";
    ["pl-loss", "pl-trade", "pl-band"].forEach(function (id) {
      var el = $(id), share = (el.value - el.min) / (el.max - el.min);
      el.style.setProperty("--fill", (share * 100).toFixed(1) + "%");
    });
    $("pl-go").href = M.createLink(plan, r);
    $("pl-clear").textContent = drawn ? "Remove lines" : "Show lines";
    if (!s) {
      $("pl-facts").innerHTML = '<li class="tm-empty">Pick a market with prices to plan on it.</li>';
      $("pl-ladder").innerHTML = "";
      return;
    }
    var L = M.planLines(s, plan), coin = r ? esc(r.base) : "it";
    $("pl-facts").innerHTML =
      '<li><i class="pl-dot floor"></i><div><b>Freezes at ' + price(L.floor) + "</b>" + usd(L.floorUsd) + " left of " + usd(plan.deposit) +
        " if it were all in " + coin + ". Holding some cash means a deeper fall first.</div></li>" +
      '<li><i class="pl-dot trade"></i><div><b>Trades up to ' + usd(L.tradeUsd) + "</b>" + plan.tradePercent + "% of the deposit; a bigger trade is refused.</div></li>" +
      '<li><i class="pl-dot band"></i><div><b>Fills between ' + price(L.bandLo) + " and " + price(L.bandHi) + "</b>" +
        plan.bandPercent + "% either side of the oracle price; worse fills are refused.</div></li>";
    $("pl-ladder").innerHTML = ladder(L);
  }

  /** A small price ladder: every line in view, even when the chart's scale hides some. */
  function ladder(L) {
    var top = L.bandHi * 1.002, bottom = L.floor * 0.998, h = 156, pad = 10;
    var y = function (p) { return pad + (top - p) / (top - bottom) * (h - pad * 2); };
    var row = function (p, cls, text) {
      return '<line class="' + cls + '" x1="4" x2="34" y1="' + y(p).toFixed(1) + '" y2="' + y(p).toFixed(1) + '"/>' +
        '<text x="40" y="' + (y(p) + 3.5).toFixed(1) + '" class="' + cls + '">' + text + "</text>";
    };
    return '<svg viewBox="0 0 120 ' + h + '" role="img">' +
      '<rect class="zone" x="4" width="30" y="' + y(L.bandHi).toFixed(1) + '" height="' + Math.max(2, y(L.bandLo) - y(L.bandHi)).toFixed(1) + '"/>' +
      '<line class="axis" x1="19" x2="19" y1="' + pad + '" y2="' + (h - pad) + '"/>' +
      row(L.start, "start", M.price(L.start)) + row(L.floor, "floor", M.price(L.floor)) + "</svg>";
  }

  // ------------------------------------------------------- lines on chart
  function lineDefs() {
    var L = M.planLines(start, plan);
    return {
      start: { price: L.start, color: COLORS.start, style: "solid", width: 2, text: "Start" },
      floor: { price: L.floor, color: COLORS.floor, style: "dashed", width: 2, text: "Freeze −" + plan.lossPercent + "%" },
      hi: { price: L.bandHi, color: COLORS.band, style: "dotted", width: 1, text: "Band +" + plan.bandPercent + "%" },
      lo: { price: L.bandLo, color: COLORS.band, style: "dotted", width: 1, text: "Band −" + plan.bandPercent + "%" },
    };
  }
  /** A horizontal line's label starts at its anchor and runs right, so the anchor sits near the left of the view. */
  function anchorTime(at) {
    var c = drawn || opts.chart(), vr = null;
    try { vr = c && c.getVisibleRange(); } catch (e) { vr = null; }
    return vr && vr.to > vr.from ? vr.from + (vr.to - vr.from) * at : Date.now();
  }
  var record = function (d) {
    return {
      // The band's labels sit further right than the start's, so the three don't stack when the band is narrow.
      anchors: [{ time: anchorTime(d.style === "dotted" ? 0.16 : 0.03), price: d.price }],
      style: { lineColor: d.color, lineWidth: d.width, lineStyle: d.style },
      text: { value: d.text, color: d.color, size: "small", hAlign: "left", vAlign: "top", bold: d.width > 1 },
    };
  };

  function draw() {
    var c = opts.chart(), r = opts.market();
    if (!c || !r || !r.last || !c.drawings || !c.drawings.supported) return;
    erase();
    sweep(c); // a saved chart can restore old plan lines after the page first looked
    start = start || r.last;
    var defs = lineDefs();
    quiet = true;
    try {
      Object.keys(defs).forEach(function (role) {
        var d = c.drawings.add("hline", record(defs[role]));
        if (d) lines[role] = d.id;
      });
    } finally { quiet = false; }
    drawn = c;
    stop.push(c.on("drawing:edited", dragged));
    stop.push(c.on("drawing:removed", function (e) {
      Object.keys(lines).forEach(function (k) { if (lines[k] === e.id) delete lines[k]; });
      if (!Object.keys(lines).length) { drawn = null; paint(); }
    }));
    paint();
  }

  /** The sliders moved: the lines follow. */
  function move() {
    if (!drawn || !start) return;
    var defs = lineDefs();
    quiet = true;
    try {
      drawn.drawings.updateMany(Object.keys(lines).map(function (role) {
        var rec = record(defs[role]);
        return { id: lines[role], patch: { anchors: rec.anchors, text: rec.text } };
      }));
    } catch (e) { /* the chart went away; the next draw starts fresh */ } finally { quiet = false; }
  }

  /** A person dragged a line: its slider follows, then the lines snap to the clean value. */
  function dragged(e) {
    if (quiet || !drawn) return;
    var role = Object.keys(lines).filter(function (k) { return lines[k] === e.id; })[0];
    if (!role) return;
    var d = drawn.drawings.all().filter(function (x) { return x.id === e.id; })[0];
    var p = d && d.anchors && d.anchors[0] ? d.anchors[0].price : null;
    if (p == null) return;
    if (role === "start") {
      if (!(p > 0)) { move(); return; } // dragged off the bottom of the price scale: back where it was
      start = p; move(); paint(); return;
    }
    var v = role === "floor" ? M.lossFromFloor(start, p) : M.bandFromLine(start, p);
    if (v === null) { move(); return; }
    set(role === "floor" ? { lossPercent: v } : { bandPercent: v });
  }

  function erase() {
    stop.forEach(function (fn) { try { fn(); } catch (e) { /* already gone */ } });
    stop = [];
    if (drawn) {
      var ids = Object.keys(lines).map(function (k) { return lines[k]; });
      quiet = true;
      try { if (ids.length) drawn.drawings.removeMany(ids); } catch (e) { /* the chart went away */ } finally { quiet = false; }
    }
    lines = {};
    drawn = null;
  }

  /** Plan lines a chart saved from an earlier visit are stale: they come off. */
  function sweep(c) {
    if (!c || !c.drawings || !c.drawings.supported) return;
    var mine = Object.keys(lines).map(function (k) { return lines[k]; });
    var old = c.drawings.all().filter(function (d) {
      var v = d.text ? String(d.text.value || "") : "";
      var color = d.style ? String(d.style.lineColor || "").toLowerCase() : "";
      var ours = Object.keys(COLORS).some(function (k) { return COLORS[k] === color; });
      return d.type === "hline" && ours && LABEL.test(v) && mine.indexOf(d.id) < 0;
    }).map(function (d) { return d.id; });
    if (old.length) c.drawings.removeMany(old);
  }

  form();
  paint();
  return {
    /** The plan tab opened: draw on the chart if there's nothing there yet. */
    show: function () { visible = true; if (!drawn && !removed) draw(); paint(); },
    hide: function () { visible = false; },
    /** A new market: the old lines go, and come back on the new one if the tab is open. */
    reset: function () {
      erase();
      start = null;
      zoom = 0;
      sweep(opts.chart());
      if (visible && !removed) draw();
      paint();
    },
    /** Start from the agents' suggested rules. */
    use: function (rules) { if (rules) plan = M.cleanPlan(Object.assign({}, plan, { lossPercent: rules.lossPercent, tradePercent: rules.tradePercent, bandPercent: 1 })); save(); move(); paint(); },
    /** New prices landed: the facts follow (the lines stay where they were drawn). */
    tick: function () {
      if (!drawn && visible && !removed) draw(); // the tab opened before prices had loaded
      if (!drawn) paint();
    },
    sweep: function () { sweep(opts.chart()); },
  };
};
