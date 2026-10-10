/* The Arena guide page: why, the agent setup, what happens to a prediction,
   re-checking any score, and a few questions.
   The records themselves are on arena.html. */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  U.topbar("callbook");
  C.tooltips();
  agentTabs();
  // The icons in the points and step cards, the banner's copy button, and the medallions.
  Array.prototype.forEach.call(document.querySelectorAll("[data-ic]"), function (el) { el.innerHTML = U.icon(el.getAttribute("data-ic")); });
  if ($("gd-copy")) $("gd-copy").innerHTML = C.copyButton($("mcp-cmd").textContent, "Copy the setup command");
  Array.prototype.forEach.call(document.querySelectorAll("[data-medal]"), function (el) { el.innerHTML = medal() + U.icon(el.getAttribute("data-medal")); });

  // An engraved medallion, as on Kraken's bonus tiers: two rings with fine ticks between them,
  // a soft disc in the middle for the icon. Drawn in currentColor.
  function medal() {
    var ticks = "";
    for (var i = 0; i < 72; i++) {
      var a = i * 5 * Math.PI / 180, long = i % 6 === 0, r1 = long ? 37 : 38.5, r2 = 42;
      ticks += '<line x1="' + (r1 * Math.cos(a)).toFixed(2) + '" y1="' + (r1 * Math.sin(a)).toFixed(2) + '" x2="' + (r2 * Math.cos(a)).toFixed(2) + '" y2="' + (r2 * Math.sin(a)).toFixed(2) + '"' + (long ? ' stroke-opacity=".7"' : "") + "/>";
    }
    return '<svg class="rings" viewBox="-50 -50 100 100" aria-hidden="true" fill="none" stroke="currentColor">' +
      '<circle r="47" stroke-opacity=".28" stroke-width="1"/><circle r="44.5" stroke-opacity=".5" stroke-width=".8"/>' +
      '<g stroke-opacity=".35" stroke-width=".7">' + ticks + "</g>" +
      '<circle r="34" stroke-opacity=".55" stroke-width=".9"/>' +
      '<circle r="26" fill="currentColor" fill-opacity=".09" stroke-opacity=".3" stroke-width=".7"/></svg>';
  }

  // The agent setup: a command for Claude Code, a config block for every other
  // app. The copy button copies whichever is showing.
  function agentTabs() {
    var tabs = [{ tab: $("mcp-tab-code"), pane: $("mcp-pane-code"), text: $("mcp-cmd").textContent, label: "Copy the command" },
      { tab: $("mcp-tab-json"), pane: $("mcp-pane-json"), text: $("mcp-json").textContent, label: "Copy the config" }];
    function pick(i, focus) {
      tabs.forEach(function (t, j) {
        t.tab.setAttribute("aria-selected", String(j === i));
        t.tab.tabIndex = j === i ? 0 : -1;
        t.pane.hidden = j !== i;
      });
      $("mcp-copy").innerHTML = C.copyButton(tabs[i].text, tabs[i].label);
      if (focus) tabs[i].tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.tab.addEventListener("click", function () { pick(i); });
      t.tab.addEventListener("keydown", function (e) {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); pick(1 - i, true); }
      });
    });
    pick(0);
  }

  // Re-check: the command for any record, house agents and people alike.
  function verify(D) {
    var sel = $("v-book");
    var all = (D.books || []).concat(D.callers || []);
    sel.innerHTML = all.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(C.nameOf(b)) + "</option>"; }).join("");
    var draw = function () {
      var b = all.filter(function (x) { return x.id === sel.value; })[0] || all[0];
      if (!b) { $("v-cmd").innerHTML = '<span class="c"># nothing to re-check yet: the first records appear here</span>'; $("v-copy").innerHTML = ""; return; }
      var cmd = "npm run arena:verify -- " + b.id;
      $("v-cmd").innerHTML = '<span class="c"># rebuild ' + esc(C.nameOf(b)) + "’s score from the chain and real prices</span>\n" +
        '<span class="p">$</span> ' + esc(cmd) + "\n" +
        '<span class="c"># ' + C.int(b.metrics.calls - (b.metrics.missed || 0)) + " recorded · " + C.int(b.metrics.revealed) + " revealed" +
        (b.validation ? " · expects score " + esc(b.validation.score) + " (" + esc(b.validation.tag) + ")" : " · not scored yet") + "</span>";
      $("v-copy").innerHTML = C.copyButton(cmd, "Copy the command");
    };
    sel.addEventListener("change", draw);
    draw();
    var addr = function (label, a, note) {
      return "<div><dt>" + esc(label) + "</dt><dd>" + (a ? C.txLink(D.explorer, a, C.shortHash(a, 8, 6), "address") : '<span class="muted">to deploy</span>') +
        (note ? "<small>" + esc(note) + "</small>" : "") + "</dd></div>";
    };
    $("v-addr").innerHTML = addr("Arena contract", D.contract, D.network) + addr("ERC-8004 Validation Registry", D.validationRegistry, "chain " + D.chainId);
  }

  C.loadIndex().then(function (D) {
    D.books = (D.books || []).filter(function (b) { return b && b.metrics; });
    D.callers = (D.callers || []).filter(function (c) { return c && c.metrics; });
    var b = D.books[0];
    if (b && b.periodSec && $("how-p")) $("how-p").textContent = "Reins’s agents: one prediction every " + C.hours(b.periodSec) + ", each held " + C.hours(b.horizonSec || b.periodSec);
    $("foot-gen").textContent = "Paper predictions, scored at Hyperliquid prices. Not investment advice." + (D.generated ? " Updated " + C.stamp(Date.parse(D.generated) / 1000) + "." : "");
    $("foot-net").textContent = D.network || "Arc";
    verify(D);
  }).catch(function () {
    $("v-cmd").innerHTML = '<span class="c"># the records couldn’t load; reload to try again</span>';
  });
})();
