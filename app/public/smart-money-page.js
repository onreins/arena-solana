/* The Smart Money strategy page, from /data/smart-money.json
   (written by `node research/smart-money-periods.mjs --export`). Six months of
   a test on Hyperliquid data. */
(function () {
  "use strict";
  var U = window.ReinsUI, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  U.topbar("strategies");
  $("crumb-ic").innerHTML = U.icon("right");

  var pct = function (x, dp) { return (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(dp == null ? 1 : dp) + "%"; };
  var day = function (t) { return new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }); };
  var tone = function (x) { return x > 0 ? "up" : x < 0 ? "down" : ""; };

  // ------------------------------------------------------------- the chart
  function chart(a) {
    var W = 640, H = 270, P = { l: 8, r: 52, t: 12, b: 24 };
    var all = a.map(function (p) { return p.index; });
    var lo = Math.min.apply(null, all) * 0.98, hi = Math.max.apply(null, all) * 1.02;
    var t0 = a[0].t, t1 = a[a.length - 1].t;
    var x = function (t) { return P.l + (t - t0) / (t1 - t0) * (W - P.l - P.r); };
    var y = function (v) { return P.t + (hi - v) / (hi - lo) * (H - P.t - P.b); };
    var path = function (c) { return c.map(function (p, i) { return (i ? "L" : "M") + x(p.t).toFixed(1) + " " + y(p.index).toFixed(1); }).join(" "); };
    var grid = "";
    for (var g = 0; g <= 4; g++) {
      var v = lo + (hi - lo) * g / 4, gy = y(v).toFixed(1);
      grid += '<line class="g" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + gy + '" y2="' + gy + '"/>' +
        '<text x="' + (W - P.r + 6) + '" y="' + (+gy + 4) + '">$' + v.toFixed(2) + "</text>";
    }
    var one = y(1).toFixed(1);
    var months = "";
    for (var t = t0; t <= t1; t += 30 * 86400) months += '<text x="' + x(t).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + day(t) + "</text>";
    var area = path(a) + " L" + x(t1).toFixed(1) + " " + (H - P.b) + " L" + x(t0).toFixed(1) + " " + (H - P.b) + " Z";
    $("plot").innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">' +
      '<defs><linearGradient id="sm-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#5aaeff" stop-opacity=".28"/><stop offset="1" stop-color="#5aaeff" stop-opacity="0"/></linearGradient></defs>' +
      grid + '<line class="g one" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + one + '" y2="' + one + '"/>' + months +
      '<path d="' + area + '" fill="url(#sm-fill)"/>' +
      '<path class="l-strat" d="' + path(a) + '" fill="none"/>' +
      '<g class="cur" id="cur" style="display:none"><line y1="' + P.t + '" y2="' + (H - P.b) + '"/><circle r="4" fill="#5aaeff" id="cur-a"/></g></svg>';
    var svg = $("plot").querySelector("svg"), read = $("read"), cur = $("cur"), line = cur.querySelector("line");
    var show = function (i) {
      var pa = a[i];
      cur.style.display = "";
      line.setAttribute("x1", x(pa.t)); line.setAttribute("x2", x(pa.t));
      $("cur-a").setAttribute("cx", x(pa.t)); $("cur-a").setAttribute("cy", y(pa.index));
      read.innerHTML = day(pa.t) + " <b>" + pct(pa.index - 1) + "</b>";
    };
    svg.addEventListener("pointermove", function (e) {
      var r = svg.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width * W;
      var tt = t0 + (fx - P.l) / (W - P.l - P.r) * (t1 - t0);
      show(Math.max(0, Math.min(a.length - 1, Math.round((tt - t0) / 86400))));
    });
    svg.addEventListener("pointerleave", function () { cur.style.display = "none"; read.textContent = ""; });
  }

  // ------------------------------------------------------------- the page
  U.getJson("/data/smart-money.json").then(function (d) {
    var st = d.stats, n = d.months.length;
    $("headline").innerHTML = '<span class="from">Over the six months tested</span><span class="to calm">' + pct(st.totalReturn, 0) + "</span>";
    $("vs").innerHTML = "Worst drop from a high: <b>" + pct(st.maxDrawdown, 1) + "</b>, across " + st.trades.toLocaleString("en-US") + " trades. A test on past data, not live results.";
    $("fine").textContent = "Positions are sized so the account is never more than fully invested. Costs: " + d.costs + ". " +
      "Tested " + day(d.window[0]) + " to " + day(d.window[1]) + " " + new Date(d.window[1] * 1000).getUTCFullYear() + ".";
    chart(d.curve);

    $("s-months").innerHTML = st.monthsBeatingMarket + '<span class="sm-of"> of ' + st.months + "</span>";
    $("s-edge").innerHTML = '<span class="' + tone(st.perTradeVsMarket) + '">' + pct(st.perTradeVsMarket, 2) + "</span>";
    $("s-edge-sub").textContent = pct(st.fallingMonthsVsMarket, 2) + " in falling months";
    $("s-pf").textContent = st.pfAfterFees.toFixed(2);
    $("s-pf-sub").textContent = "after fees · " + st.pfVsMarket.toFixed(2) + " against the market";
    $("s-dd").textContent = pct(st.maxDrawdown, 1);
    $("s-dd-sub").textContent = "from a high, over the six months";
    $("s-trades").textContent = st.trades.toLocaleString("en-US");
    $("s-trades-sub").textContent = "median hold " + Math.round(st.medianHoldHours) + "h · " + Math.round(st.longShare * 100) + "% long";

    var max = Math.max.apply(null, d.months.map(function (m) { return Math.abs(m.vsMarket); })) || 1;
    $("months").innerHTML =
      '<div class="sm-mh"><span>Month</span><span>Market</span><span>Strategy vs market, per trade</span><span></span><span>Trades</span></div>' +
      d.months.map(function (m) {
        var w = Math.abs(m.vsMarket) / max * 50;
        return '<div class="sm-m"><span class="d">' + day(m.start) + " – " + day(m.end) + "</span>" +
          '<span class="mk ' + tone(m.market) + '">' + pct(m.market, 0) + (m.market <= 0 ? ' <i class="sm-fall">falling</i>' : "") + "</span>" +
          '<span class="bar"><i class="' + (m.vsMarket >= 0 ? "pos" : "neg") + '" style="width:' + w.toFixed(1) + "%;" + (m.vsMarket >= 0 ? "left:50%" : "right:50%") + '"></i></span>' +
          '<b class="v ' + tone(m.vsMarket) + '">' + pct(m.vsMarket, 2) + "</b>" +
          '<span class="n">' + m.trades + "</span></div>";
      }).join("");

    var proof = [
      ["ok", "It isn't just a rising market.", "Measured against the market, it came out ahead in " + st.monthsBeatingMarket + " of " + n + " months, including the month the market fell hardest, and " + pct(st.fallingMonthsVsMarket, 2) + " per trade across falling months."],
      ["ok", "No hindsight.", "Each month's traders are chosen only from what happened before it, and every trade fills after the move it follows, at a price that was really there."],
      ["ok", "It held the line.", "The worst drop from a high was " + pct(st.maxDrawdown, 1) + ", through a stretch that included two falling months."],
      ["warn", "Not proven yet.", "Across all " + st.trades.toLocaleString("en-US") + " trades the edge over the market is " + pct(st.perTradeVsMarket, 2) + " per trade, which isn't yet statistically convincing (t = " + st.t.toFixed(1) + "), and two months were negative. It's a strong lead, not a guarantee."],
      ["warn", "Six months of history.", "Hyperliquid keeps a limited history per trader, so the test can't reach further back, and the coins and accounts are drawn from today's market, which can flatter it."],
      ["next", "Next: a live paper agent.", "With the rules frozen, every trade is logged in public as it happens. A few months of that is the proof a backtest can't give, before any real money."],
    ];
    $("proof").innerHTML = proof.map(function (p) {
      return '<li class="' + p[0] + '"><i aria-hidden="true">' + (p[0] === "ok" ? "✓" : p[0] === "warn" ? "!" : "→") + "</i><div><b>" + esc(p[1]) + "</b> " + esc(p[2]) + "</div></li>";
    }).join("");
  }).catch(function () {
    $("headline").innerHTML = '<span class="from">The results couldn’t load. Reload the page to try again.</span>';
  });
})();
