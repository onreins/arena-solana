/* The crowd panel on the Arena page: what callers lean, coin by coin, and how
   that consensus has done after costs (app/verify/callbook-crowd.js). Built
   only from revealed calls: a locked call stays hidden until its reveal, so
   this never shows what anyone is calling now. Reads the index the page
   already loaded; an API without a consensus leaves the panel hidden. */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, esc = U && U.esc;
  var el = document.getElementById("crowd");
  if (!el || !C || !esc) return;

  var STYLE =
    ".crw-d { margin-top: 4px; color: var(--ink-3); font-size: 13px; }" +
    ".crw { display: grid; gap: 8px; margin: 14px 0 0; padding: 0; list-style: none; }" +
    ".crw-r { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; gap: 8px 14px; align-items: center; padding: 12px 14px; border-radius: 12px; background: rgba(255, 255, 255, .025); box-shadow: inset 0 0 0 1px var(--line); }" +
    ".crw-c { font: 600 14px var(--sans); color: var(--ink); }" +
    ".crw-bar { position: relative; height: 6px; border-radius: 99px; background: rgba(232, 113, 107, .45); overflow: hidden; }" +
    ".crw-bar.none { background: var(--line-2); }" +
    ".crw-bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: inherit; background: var(--green); }" +
    ".crw-l { font: 500 12.5px var(--mono); color: var(--ink-2); white-space: nowrap; }" +
    ".crw-l.long { color: var(--green); } .crw-l.short { color: var(--red); }" +
    ".crw-m { grid-column: 2 / -1; color: var(--ink-3); font-size: 12.5px; }" +
    ".crw-e { margin-top: 14px; padding: 16px; border-radius: 12px; background: rgba(255, 255, 255, .02); box-shadow: inset 0 0 0 1px var(--line); color: var(--ink-3); font-size: 13.5px; line-height: 1.5; }" +
    "@media (max-width: 520px) { .crw-r { grid-template-columns: 56px minmax(0, 1fr) auto; padding: 10px 12px; } }";

  var pct = function (x, dp) { return x == null ? "–" : (x * 100).toFixed(dp || 0) + "%"; };
  var signedPct = function (x) { return x == null ? "–" : (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(2) + "%"; };
  var plural = function (n, one, many) { return n + " " + (n === 1 ? one : many); };

  function row(c) {
    var r = c.recent || {}, rec = c.record || {};
    var share = r.longShare;
    var lean = r.callers ? (r.lean === "split" ? "split" : pct(share) + " long") : "quiet";
    var cls = r.lean === "long" ? "long" : r.lean === "short" ? "short" : "";
    var bar = r.callers
      ? '<div class="crw-bar" role="img" aria-label="' + esc(pct(share) + " of " + plural(r.callers, "caller", "callers") + " long this week") + '"><i style="width:' + Math.round((share || 0) * 100) + '%"></i></div>'
      : '<div class="crw-bar none" role="img" aria-label="No revealed calls this week"></div>';
    var record = rec.days
      ? "Consensus " + pct(rec.hitRate) + " right over " + plural(rec.days, "day", "days") + ", " + signedPct(rec.meanReturn) + " a call after costs"
      : "No consensus record yet";
    var who = r.callers ? plural(r.callers, "caller", "callers") + " this week" : "No calls this week";
    return '<li class="crw-r"><b class="crw-c">' + esc(c.coin) + "</b>" + bar + '<span class="crw-l ' + cls + '">' + esc(lean) + "</span>" +
      '<span class="crw-m">' + esc(who + " · " + record) + "</span></li>";
  }

  function render(index) {
    var cons = index && index.consensus;
    if (!cons || !Array.isArray(cons.coins)) return;
    if (!document.getElementById("crowd-style")) {
      var s = document.createElement("style");
      s.id = "crowd-style"; s.textContent = STYLE;
      document.head.appendChild(s);
    }
    var coins = cons.coins.filter(function (c) { return (c.recent && c.recent.callers) || (c.record && c.record.days); }).slice(0, 8);
    var days = cons.rules && cons.rules.recentDays ? cons.rules.recentDays : 7;
    var body = coins.length
      ? '<ol class="crw">' + coins.map(row).join("") + "</ol>"
      : '<p class="crw-e">The crowd forms when two or more callers reveal calls on the same coin and day. It only ever uses revealed calls, so it never shows what anyone is calling now.</p>';
    el.innerHTML =
      '<div class="hm-panel-h"><div><h2 id="crowd-h">The crowd</h2>' +
      '<p class="crw-d">What callers leaned over the last ' + esc(String(days)) + " days, coin by coin, from revealed calls only. Each caller counts once.</p></div></div>" + body;
    el.hidden = false;
  }

  window.CallbookCrowd = { render: render };
  C.loadIndex().then(render).catch(function () { /* no index here: the panel stays hidden */ });
})();
