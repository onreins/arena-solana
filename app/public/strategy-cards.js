/* The strategy cards, on the Strategies page and the Agents page. Every
   strategy is a card: what it does, three numbers and its curve. The
   smart-money test leads, then the backtested templates by recent return.
   Loaded after ui.js:  var list = ReinsStrategyCards.mount(el);  list.filter(fn). */
window.ReinsStrategyCards = (function () {
  "use strict";
  var U = window.ReinsUI, esc = U.esc;
  var T2024 = Date.UTC(2024, 0, 1) / 1000;
  var YR = '<small class="yr" title="A year, compounded, backtested">/yr</small>';
  var pc = function (x, dp) { return (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(dp) + "%"; };

  function card(c) {
    return '<a class="st-card ' + c.cls + '" href="' + c.href + '">' +
      '<div><span class="k">' + c.tags + "</span><h3>" + c.title + "</h3><p>" + esc(c.text) + "</p></div>" +
      "<dl>" + c.stats.map(function (s) { return "<div><dt>" + s[0] + "</dt><dd>" + s[1] + "</dd></div>"; }).join("") + "</dl>" +
      '<span class="sp">' + U.spark(c.curve).replace('<svg class="spark"', '<svg class="spark" preserveAspectRatio="none"') + "</span></a>";
  }
  function smartCard(d) {
    var st = d.stats;
    return {
      cls: "smart", href: "/smart-money", search: "smart money hyperliquid traders testing",
      tags: '<span class="tagp sm-tag">New</span><span class="tagp">Testing</span><span>Hyperliquid traders</span>',
      title: "Smart Money",
      text: "Trades alongside a hand-picked group of Hyperliquid's most profitable traders.",
      stats: [["Beat the market", st.monthsBeatingMarket + " of " + st.months + " months"], ["Worst drop", pc(st.maxDrawdown, 1)], ["Profit factor", st.pfAfterFees.toFixed(2)]],
      curve: d.curve.map(function (p) { return p.index; }),
    };
  }
  function templateCard(s) {
    var st = s.stats, valid = s.status === "validated";
    return {
      cls: valid ? "valid" : "", href: "/strategy?s=" + encodeURIComponent(s.id), search: s.name + " " + s.universe.join(" ") + " " + s.status,
      tags: '<span class="tagp' + (valid ? " ok" : "") + '">' + (valid ? "Validated" : "Candidate") + "</span><span>" + U.coinCount(s.universe) + " coins</span><span>" + esc(s.hold) + "</span>",
      title: U.coins(s.universe) + esc(s.name),
      text: s.tagline,
      stats: [["Since 2024", U.pctHtml(st.cagr_since_2024 * 100, 0) + YR], ["Worst drop", U.pct(st.max_drawdown * 100, 0)], ["Worst month", U.pct(st.worst_month * 100, 0)]],
      curve: s.curve.filter(function (p) { return p.t >= T2024; }).map(function (p) { return p.index; }),
    };
  }

  function mount(el) {
    var smart = null, strats = [], loaded = false;
    var keep = function () { return true; };
    function render() {
      var all = (smart ? [smartCard(smart)] : []).concat(strats.map(templateCard));
      var rows = all.filter(function (c) { return keep(c.search); });
      el.innerHTML = rows.length
        ? rows.map(card).join("")
        : all.length
          ? '<p class="st-empty"><b>Nothing matches</b>Try another name or coin.</p>'
          : loaded ? '<p class="st-empty"><b>Strategies couldn’t load</b>Reload the page to try again.</p>' : el.innerHTML;
    }
    // The smart-money strategy: tested on Hyperliquid traders over six months.
    U.getJson("/data/smart-money.json")
      .then(function (d) { smart = d; render(); })
      .catch(function () { /* the templates still show */ });
    U.getJson("/data/strategies.json")
      .then(function (d) {
        strats = (d.strategies || []).slice().sort(function (a, b) { return b.stats.cagr_since_2024 - a.stats.cagr_since_2024; });
        loaded = true;
        render();
      })
      .catch(function () { strats = []; loaded = true; render(); });
    // fn(searchText) -> keep the card?
    return { filter: function (fn) { keep = fn || keep; render(); } };
  }

  return { mount: mount };
})();
