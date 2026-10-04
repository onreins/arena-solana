/**
 * The Charts page: a full-screen market terminal. Every perpetual on
 * Hyperliquid in a list on the left, LuxAlgo's Vela chart in
 * the middle, the coin's agent thesis below it, and the round's hot list on
 * the right. Prices come straight from Hyperliquid's public API; the
 * numbers and the sample thesis live in markets.js.
 */
(function () {
  "use strict";
  var U = window.ReinsUI, M = window.ReinsMarkets, V = window.ReinsVela;
  var $ = function (id) { return document.getElementById(id); };
  var esc = U.esc;

  var REFRESH_MS = 30 * 1000;
  var FETCH_TIMEOUT_MS = 12 * 1000;
  var LIST_MAX = 200;
  var FAV_KEY = "reins-charts-favs";
  var ROUND_KEY = "reins-charts-round";
  var DEFAULT_SYMBOL = "hyperliquid:BTC";
  var VENUE = { hyperliquid: "Hyperliquid" };
  // Spot quotes, so an old link to a spot pair opens the same coin's perp.
  var SPOT_QUOTE = /[-/]?(USDT|USDC|FDUSD|BUSD|USD|EUR)$/i;
  var MARK_COLOR = { hot: "#ff8a4c", watch: "#e6b062", cold: "#5fa8ff" };
  var STANCE = { bull: "Bullish", bear: "Bearish", watch: "Neutral", caution: "Careful" };
  var GLYPH = {
    hot: '<path d="M12 3.5c.5 3-1.8 4.6-3 6.4-1.1 1.6-1.6 3-1.1 4.9.6 2.4 2.6 3.7 4.1 3.7 2.6 0 4.6-2 4.6-4.8 0-1.6-.6-2.8-1.5-3.9.1 1.4-.4 2.4-1.3 2.9.3-3.5-.8-6.6-1.8-9.2z"/>',
    watch: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.6"/>',
    cold: '<path d="M12 3.5v17M4.6 7.8l14.8 8.4M4.6 16.2l14.8-8.4"/>',
    Trend: '<path d="M3.5 17.5 9 12l3.5 3.5 8-8"/><path d="M15 7.5h5.5V13"/>',
    Flow: '<path d="M4 8h12M12.5 4.5 16 8l-3.5 3.5M20 16H8M11.5 12.5 8 16l3.5 3.5"/>',
    Risk: '<path d="M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6z"/><path d="M12 8.5v4M12 15.5h.01"/>',
    flask: '<path d="M9.5 3.5h5M10.5 3.5v5.2L5.4 17.6A2 2 0 0 0 7.1 20.5h9.8a2 2 0 0 0 1.7-2.9l-5.1-8.9V3.5"/><path d="M7.5 14.5h9"/>',
  };
  var glyph = function (name) { return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + GLYPH[name] + "</svg>"; };

  var state = {
    rows: [], byVenue: {}, ok: {}, venue: "all", query: "", sort: "volUsd", dir: "desc",
    symbol: null, favs: readFavs(), last: {}, hot: { hot: [], cold: [] }, round: readRound(),
  };

  // ------------------------------------------------------------------ frame
  $("brand").innerHTML = U.MARK + "<span>Reins</span>";
  $("nav").innerHTML = U.TABS.map(function (t) {
    return '<a href="' + t[2] + '"' + (t[0] === "charts" ? ' aria-current="page"' : "") + ">" + U.icon(t[0]) + t[1] + "</a>";
  }).join("");
  U.tabbar("charts");

  function readFavs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || {}; } catch (e) { return {}; }
  }
  // The round's picks hold for its four hours, across reloads; their prices stay live.
  function readRound() {
    try {
      var r = JSON.parse(localStorage.getItem(ROUND_KEY));
      return r && r.start === M.round(Date.now()).start && Array.isArray(r.hot) && Array.isArray(r.cold) ? r : null;
    } catch (e) { return null; }
  }
  function pickRound() {
    var start = M.round(Date.now()).start;
    var all = Object.keys(FEEDS).every(function (v) { return state.byVenue[v]; });
    // Saved picks whose markets are mostly gone (a venue was dropped) are picked again, not shown half-empty.
    var gone = function (r) {
      var ids = r.hot.concat(r.cold), found = ids.filter(function (id) { return M.find(state.rows, id); }).length;
      return all && ids.length > 0 && found < ids.length / 2;
    };
    if (!state.round || state.round.start !== start || (!state.round.full && all) || gone(state.round)) {
      var fresh = M.hotList(state.rows, 8);
      var ids = function (list) { return list.map(function (x) { return x.row.id; }); };
      state.round = { start: start, full: all, hot: ids(fresh.hot), cold: ids(fresh.cold) };
      try { localStorage.setItem(ROUND_KEY, JSON.stringify(state.round)); } catch (e) { /* storage off */ }
    }
    var live = function (list) {
      return list.map(function (id) { return M.find(state.rows, id); }).filter(Boolean)
        .map(function (r) { return { row: r, thesis: M.thesis(state.rows, r) }; });
    };
    return { hot: live(state.round.hot), cold: live(state.round.cold) };
  }
  function saveFavs() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(state.favs)); } catch (e) { /* storage off */ }
  }

  // ------------------------------------------------------------------ feeds
  function getJson(url, init) {
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT_MS);
    return fetch(url, Object.assign({ signal: ctl.signal }, init)).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error(url + " answered " + r.status);
      return r.json();
    }, function (err) { clearTimeout(timer); throw err; });
  }
  var FEEDS = {
    hyperliquid: function () {
      return getJson("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"type":"metaAndAssetCtxs"}' })
        .then(M.fromHyperliquid);
    },
  };

  var asked = {};
  function refresh() {
    return Promise.all(Object.keys(FEEDS).map(function (venue) {
      var mine = asked[venue] = (asked[venue] || 0) + 1;
      return FEEDS[venue]().then(function (rows) {
        if (mine !== asked[venue]) return; // a newer answer is on its way
        state.byVenue[venue] = rows;
        state.ok[venue] = true;
        merge();
      }, function () { if (mine === asked[venue]) state.ok[venue] = false; });
    })).then(function () {
      setLive();
      if (state.rows.length || Object.keys(state.byVenue).length) return;
      var down = "Couldn\u2019t reach the exchanges. Trying again every 30 seconds.";
      ["list", "hot-list"].forEach(function (id) { $(id).removeAttribute("data-sig"); $(id).innerHTML = '<li class="tm-empty">' + down + "</li>"; });
      $("t-body").innerHTML = '<p class="tm-empty">' + down + "</p>";
    });
  }
  /**
   * Put new HTML in place without rebuilding it when only the numbers moved
   * (same rows, same order): focus, hover and a tap in progress survive a
   * refresh, and a price that changed flashes. Live parts carry class "lv".
   */
  function paint(el, html, sig) {
    if (el.getAttribute("data-sig") === sig) {
      var tpl = document.createElement("template");
      tpl.innerHTML = html;
      var next = tpl.content.querySelectorAll(".lv"), now = el.querySelectorAll(".lv");
      if (next.length === now.length) {
        for (var i = 0; i < now.length; i++) {
          if (now[i].innerHTML !== next[i].innerHTML) {
            now[i].innerHTML = next[i].innerHTML;
            if (/flash-/.test(next[i].className)) { now[i].className = ""; void now[i].offsetWidth; }
          }
          // An unchanged price keeps the flash it got a moment ago, when another exchange's data landed.
          var bare = function (c) { return c.replace(/\s*flash-(up|down)/g, ""); };
          if (bare(now[i].className) !== bare(next[i].className) || /flash-/.test(next[i].className)) now[i].className = next[i].className;
          if (now[i].title !== next[i].title) now[i].title = next[i].title;
        }
        return;
      }
    }
    el.innerHTML = html;
    el.setAttribute("data-sig", sig);
  }
  // Grey rows in the shape of the real ones while the first prices load.
  function skeleton(n, cls) {
    var out = "";
    for (var i = 0; i < n; i++) out += '<li class="sk-row ' + cls + '" aria-hidden="true"><i class="sk sk-c"></i><i class="sk sk-a"></i><i class="sk sk-b"></i></li>';
    return out;
  }
  $("list").innerHTML = skeleton(14, "sk-list");
  $("hot-list").innerHTML = skeleton(6, "sk-hot");
  var mergeQueued = false;
  function merge() {
    if (mergeQueued) return;
    mergeQueued = true;
    // A macrotask, not a frame: a background tab still gets its list, and three venues landing together render once.
    setTimeout(function () {
      mergeQueued = false;
      state.rows = [].concat.apply([], Object.keys(state.byVenue).map(function (k) { return state.byVenue[k]; }));
      state.hot = pickRound();
      renderList();
      renderBar();
      renderThesis();
      renderHot();
      syncMarks();
      if (plan) plan.tick();
      Object.keys(state.byVenue).forEach(function (k) { state.byVenue[k].forEach(function (r) { state.last[r.id] = r.last; }); });
    }, 0);
  }
  function setLive() {
    var venues = Object.keys(FEEDS), up = venues.filter(function (v) { return state.ok[v]; });
    var el = $("live");
    el.className = "tm-live " + (up.length === venues.length ? "ok" : up.length ? "part" : "off");
    el.title = venues.map(function (v) { return VENUE[v] + (state.ok[v] ? ": live" : ": not answering"); }).join("\n");
    el.lastElementChild.textContent = up.length === venues.length ? "Live" : up.length ? up.length + " of " + venues.length + " exchanges" : "Offline";
  }

  // ------------------------------------------------------------ the chart
  var ws = null;
  function startChart() {
    if (!V) return showMsg("The chart didn't load. Check your connection and refresh.");
    var hyperliquid = new V.HyperliquidProvider();
    try {
      ws = new V.VelaWorkspace("#chart", {
        layout: "1",
        symbol: DEFAULT_SYMBOL,
        timeframe: "60",
        live: true,
        theme: "dark",
        persist: "reins-terminal-3", // -3: perps only, so a saved spot layout doesn't come back
        timeframes: ["1", "5", "15", "60", "240", "1D", "1W"],
        providers: { hyperliquid: function () { return hyperliquid; } },
      });
    } catch (err) {
      return showMsg("This browser can't draw the chart: " + (err && err.message ? err.message : "unknown error") + ".");
    }
    var wanted = new URLSearchParams(location.search).get("s") || "";
    var at = wanted.indexOf(":");
    if (at > 0) wanted = wanted.slice(0, at).toLowerCase() + wanted.slice(at);
    if (/^(binance|coinbase):[A-Za-z0-9./@-]{1,40}$/.test(wanted)) wanted = "hyperliquid:" + wanted.split(":")[1].replace(SPOT_QUOTE, "").toUpperCase();
    if (/^hyperliquid:[A-Za-z0-9./@-]{1,40}$/.test(wanted)) ws.active.setSymbol(wanted);
    ws.on("state:changed", follow);
    ws.on("cell:active", function () {
      var before = watched;
      follow();
      var c = ws.active ? ws.active.chart : null;
      if (c && c !== before) { watchChart(); state.markSig = null; syncMarks(); if (plan) plan.reset(); }
    });
    // A new layout rebuilds the charts: the round mark and the plan lines go back on the active one.
    ws.on("layout:changed", function () { watched = null; state.markSig = null; follow(); watchChart(); syncMarks(); if (plan) plan.reset(); });
    follow();
  }
  function showMsg(text) {
    $("msg").textContent = text;
    $("msg").hidden = false;
  }
  /** The chart's market is the page's market, however it was picked. */
  function chartSymbol() {
    var s = ws && ws.active ? String(ws.active.symbol || "") : "";
    if (!s) return state.symbol || DEFAULT_SYMBOL;
    return s.indexOf(":") > 0 ? s.split(":")[0].toLowerCase() + ":" + s.split(":").slice(1).join(":") : "hyperliquid:" + s;
  }
  function follow() {
    var s = chartSymbol();
    if (s.toLowerCase() === String(state.symbol || "").toLowerCase()) return;
    state.symbol = s;
    try { history.replaceState(null, "", "?s=" + encodeURIComponent(s)); } catch (e) { /* sandboxed */ }
    renderBar();
    renderThesis();
    markList();
    markHot();
    watchChart();
    if (plan) plan.reset();
    syncMarks();
  }
  /** The active chart tells us when its market has loaded: marks and plan lines go on then. */
  var watched = null, hooked = [];
  function watchChart() {
    var c = ws && ws.active ? ws.active.chart : null;
    if (!c || c === watched) return;
    watched = c;
    if (hooked.indexOf(c) >= 0) return; // already listening: a chart is hooked once, however often it becomes active
    hooked.push(c);
    if (hooked.length > 16) hooked.shift(); // charts from old layouts are gone; don't hold on to them
    // A saved chart restores its drawings once it is ready: stale plan lines come off then.
    c.ready().then(function () { if (c === watched && plan) plan.sweep(); }, function () { /* the chart failed to load; nothing to tidy */ });
    c.on("market:changed", function () {
      if (c !== watched) return;
      state.markSig = null;
      syncMarks();
      if (plan) plan.reset();
    });
  }
  /** The current agent round, on the chart's timeline, in its verdict's colour. */
  function syncMarks() {
    var c = ws && ws.active ? ws.active.chart : null, r = current();
    if (!c || !c.marks || !c.marks.supported) return;
    var rd = M.round(Date.now()), t = r ? M.thesis(state.rows, r) : null;
    var sig = state.symbol + "|" + rd.start + "|" + (t ? t.verdict : "");
    if (sig === state.markSig) return;
    state.markSig = sig;
    if (!t) { c.marks.clear(); return; }
    var at = new Date(rd.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    c.marks.defineGroup({ id: "agents", label: "Agent rounds" });
    c.marks.set([{
      id: "round", time: rd.start, group: "agents",
      title: "Agent round " + at + " (sample)",
      tooltip: "Agents say " + t.verdict,
      glyph: { shape: "circle", color: MARK_COLOR[t.verdict], letter: t.verdict.charAt(0).toUpperCase() },
      content: { type: "text", text: t.summary },
    }]);
  }
  function select(id) {
    if (!ws) return;
    ws.active.setSymbol(id);
    state.symbol = null; // follow() takes the new one, with the chart's own spelling
    follow();
    if (window.matchMedia("(max-width: 900px)").matches) {
      setPanel("thesis");
      $("bar").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  function current() { return M.find(state.rows, state.symbol); }

  // ------------------------------------------------------------- shared bits
  function hue(base) {
    var h = 0;
    for (var i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function coin(base, cls) {
    var b = String(base || "?").replace(/^k(?=[A-Z])/, "");
    return '<span class="tm-coin' + (cls ? " " + cls : "") + '" style="--h:' + hue(b) + '"><i aria-hidden="true">' + esc(b.charAt(0)) + "</i>" +
      '<img src="https://crypto-icons.ledger.com/' + encodeURIComponent(b.toUpperCase()) + '.png" alt="" loading="lazy" onerror="this.remove()"></span>';
  }
  function chg(x) {
    if (x == null) return '<span class="tm-chg lv flat">–</span>';
    return '<span class="tm-chg lv ' + (x > 0.0005 ? "up" : x < -0.0005 ? "down" : "flat") + '">' + M.pctText(x, 2) + "</span>";
  }
  function flash(id, now) {
    var before = state.last[id];
    return before == null || now == null || before === now ? "" : now > before ? " flash-up" : " flash-down";
  }
  function heat(t, cls) {
    var n = Math.max(0, Math.min(5, Math.abs(t.score) + (t.verdict === "watch" ? 0 : 1)));
    var bars = "";
    for (var i = 0; i < 5; i++) bars += "<i" + (i < n ? ' class="f"' : "") + "></i>";
    return '<span class="heat lv ' + cls + '" aria-hidden="true">' + bars + "</span>";
  }

  // ----------------------------------------------------------------- list
  function renderList() {
    var shown = M.view(state.rows, { venue: state.venue, query: state.query, sort: state.sort, dir: state.dir, favs: state.favs });
    var list = $("list");
    if (!state.rows.length) return;
    list.removeAttribute("aria-busy");
    if (!shown.length) {
      list.removeAttribute("data-sig");
      list.innerHTML = '<li class="tm-empty">' + (state.venue === "fav" && !state.query ? "Star a market to keep it here." : "No market matches “" + esc(state.query) + "”.") + "</li>";
    } else {
      var top = shown.slice(0, LIST_MAX), sigBefore = list.getAttribute("data-sig");
      paint(list, top.map(function (r) {
        var on = r.id.toLowerCase() === String(state.symbol).toLowerCase(), fav = !!state.favs[r.id];
        return '<li class="tm-item' + (on ? " on" : "") + '">' +
          '<button type="button" class="tm-star" data-star="' + esc(r.id) + '" aria-pressed="' + fav + '" aria-label="Star ' + esc(M.label(r)) + '">★</button>' +
          '<button type="button" class="tm-row" data-s="' + esc(r.id) + '"' + (on ? ' aria-current="true"' : "") + ">" +
          '<span class="tm-name">' + coin(r.base, "sm") + "<div><b>" + esc(r.base) + (r.kind === "perp" ? ' <span class="tm-perp">PERP</span>' : "<em>/" + esc(r.quote) + "</em>") + "</b>" +
          '<small class="lv" title="' + VENUE[r.venue] + ', ' + M.money(r.volUsd) + ' traded in 24 hours"><i class="vd ' + r.venue + '"></i>' + M.money(r.volUsd) + " vol</small></div></span>" +
          '<span class="num lv' + flash(r.id, r.last) + '">' + M.price(r.last) + "</span>" + chg(r.change) + "</button></li>";
      }).join(""), top.map(function (r) { return r.id; }).join("|"));
      if (list.getAttribute("data-sig") !== sigBefore) cursor = -1; // new rows: the keyboard mark starts over
    }
    var total = state.rows.length;
    $("count").textContent = shown.length > LIST_MAX
      ? "Top " + LIST_MAX + " of " + shown.length.toLocaleString("en-US") + " by " + sortName() + ". Search to find the rest."
      : shown.length.toLocaleString("en-US") + " of " + total.toLocaleString("en-US") + " markets";
    document.querySelectorAll("#cols button").forEach(function (b) {
      var k = b.getAttribute("data-k"), on = k === state.sort;
      b.classList.toggle("on", on);
      b.classList.toggle("asc", on && state.dir === "asc");
    });
  }
  function sortName() { return { volUsd: "volume", change: "24h move", last: "price", name: "name" }[state.sort]; }
  function markList() {
    document.querySelectorAll("#list .tm-item").forEach(function (li) {
      var on = li.querySelector(".tm-row").getAttribute("data-s").toLowerCase() === String(state.symbol).toLowerCase();
      li.classList.toggle("on", on);
    });
  }

  $("list").addEventListener("click", function (e) {
    var star = e.target.closest("[data-star]");
    if (star) {
      var id = star.getAttribute("data-star");
      if (state.favs[id]) delete state.favs[id]; else state.favs[id] = 1;
      saveFavs();
      star.setAttribute("aria-pressed", String(!!state.favs[id]));
      if (state.venue === "fav") renderList();
      return;
    }
    var row = e.target.closest("[data-s]");
    if (row) select(row.getAttribute("data-s"));
  });
  $("venues").addEventListener("click", function (e) {
    var b = e.target.closest("[data-v]");
    if (!b) return;
    state.venue = b.getAttribute("data-v");
    document.querySelectorAll("#venues [data-v]").forEach(function (x) { x.setAttribute("aria-selected", String(x === b)); });
    $("list").scrollTop = 0;
    renderList();
  });
  $("cols").addEventListener("click", function (e) {
    var b = e.target.closest("[data-k]");
    if (!b) return;
    var k = b.getAttribute("data-k");
    if (state.sort === k) state.dir = state.dir === "desc" ? "asc" : "desc";
    else { state.sort = k; state.dir = k === "name" ? "asc" : "desc"; }
    renderList();
  });
  var typing;
  $("q").addEventListener("input", function () {
    clearTimeout(typing);
    typing = setTimeout(function () { state.query = $("q").value; $("list").scrollTop = 0; renderList(); }, 80);
  });
  // Up and down walk the list from the search box; Enter opens the one marked (or the first).
  var cursor = -1;
  function moveCursor(step) {
    var rows = $("list").querySelectorAll(".tm-row");
    if (!rows.length) return;
    if (rows[cursor]) rows[cursor].classList.remove("kb");
    cursor = Math.max(0, Math.min(rows.length - 1, cursor + step));
    rows[cursor].classList.add("kb");
    rows[cursor].scrollIntoView({ block: "nearest" });
  }
  $("q").addEventListener("input", function () { cursor = -1; });
  $("q").addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveCursor(e.key === "ArrowDown" ? 1 : -1); return; }
    if (e.key !== "Enter") return;
    var marked = $("list").querySelectorAll(".tm-row")[cursor];
    if (marked) { select(marked.getAttribute("data-s")); return; }
    state.query = $("q").value;
    var first = M.view(state.rows, { venue: state.venue, query: state.query, sort: state.sort, dir: state.dir, favs: state.favs })[0];
    if (first) select(first.id);
  });
  document.addEventListener("keydown", function (e) {
    var t = document.activeElement && document.activeElement.tagName;
    if (e.key === "/" && t !== "INPUT" && t !== "TEXTAREA" && t !== "SELECT" && !(document.activeElement && document.activeElement.isContentEditable)) {
      e.preventDefault();
      if (window.matchMedia("(max-width: 900px)").matches) setPanel("markets");
      $("q").focus();
    }
  });

  // ------------------------------------------------------------------ bar
  function renderBar() {
    var r = current(), s = String(state.symbol || DEFAULT_SYMBOL);
    var venue = s.split(":")[0], ticker = s.split(":").slice(1).join(":");
    $("b-coin").outerHTML = '<span id="b-coin">' + coin(r ? r.base : ticker) + "</span>";
    var v = r ? M.thesis(state.rows, r).verdict : null;
    document.title = (r ? M.label(r) + " " + M.price(r.last) : ticker) + " · Reins Charts";
    $("b-name").innerHTML = esc(r ? M.label(r) : ticker) + (v ? ' <button type="button" class="tm-verdict-mini v-' + v + '" data-go="thesis" title="What the agents say: read the thesis">' + glyph(v) + v + "</button>" : "");
    $("b-venue").textContent = (VENUE[venue] || venue) + " · " + (r ? (r.kind === "perp" ? "Perpetual" + (r.maxLeverage ? ", up to " + r.maxLeverage + "×" : "") : "Spot") : "Market");
    if (!r) { $("b-stats").removeAttribute("data-sig"); $("b-stats").innerHTML = state.rows.length ? '<div><dt>24h</dt><dd class="muted">No 24-hour stats for this market</dd></div>' : ""; return; }
    var stat = function (label, value, cls) { return "<div" + (cls ? ' class="' + cls + '"' : "") + "><dt>" + label + '</dt><dd class="lv">' + value + "</dd></div>"; };
    var change = r.change == null ? "–" : '<span class="num ' + (r.change >= 0 ? "up" : "down") + '" title="' + (r.last - r.open >= 0 ? "+" : "−") + M.price(Math.abs(r.last - r.open)) + '">' + M.pctText(r.change, 2) + "</span>";
    var parts = [
      stat("Price", '<span class="' + barFlash(r) + '">' + M.price(r.last) + "</span>", "big"),
      stat("24h change", change),
    ];
    if (r.kind === "perp") {
      var apr = r.funding != null ? r.funding * 24 * 365 : null;
      parts.push(stat("Funding / hour", r.funding == null ? "–" : '<span class="num ' + (r.funding >= 0 ? "up" : "down") + '" title="' + (apr >= 0 ? "" : "−") + Math.abs(apr * 100).toFixed(1) + '% a year">' + (r.funding * 100).toFixed(4) + "%</span>"));
      parts.push(stat("Open interest", '<span class="num">' + M.money(r.oiUsd) + "</span>"));
    } else {
      parts.push(stat("24h range", '<span class="num">' + M.price(r.low) + ' <span class="muted">–</span> ' + M.price(r.high) + "</span>"));
    }
    parts.push(stat("24h volume", '<span class="num">' + M.money(r.volUsd) + "</span>"));
    paint($("b-stats"), parts.join(""), r.id);
    state.last["bar:" + r.id] = r.last;
  }
  /** The bar's price flashes when it moves, and keeps that flash while other exchanges' data lands. */
  function barFlash(r) {
    var before = state.last["bar:" + r.id], kept = state.barFlash;
    var cls = before != null && before !== r.last ? (r.last > before ? "flash-up" : "flash-down")
      : kept && kept.id === r.id && kept.price === r.last ? kept.cls : "";
    state.barFlash = { id: r.id, price: r.last, cls: cls };
    return cls;
  }
  $("bar").addEventListener("click", function (e) {
    if (!e.target.closest("[data-go]")) return;
    setPanel("thesis");
    $("thesis").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  // --------------------------------------------------------------- thesis
  function roundHtml() {
    var rd = M.round(Date.now()), share = 1 - rd.left / M.ROUND_MS, c = 2 * Math.PI * 5;
    var at = new Date(rd.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return '<svg viewBox="0 0 14 14" aria-hidden="true"><circle class="trk" cx="7" cy="7" r="5" fill="none" stroke-width="2"/>' +
      '<circle class="val" cx="7" cy="7" r="5" fill="none" stroke-width="2" stroke-linecap="round" transform="rotate(-90 7 7)" stroke-dasharray="' + (share * c).toFixed(2) + " " + c.toFixed(2) + '"/></svg>' +
      "Round " + at + " · next in " + M.left(rd.left);
  }
  function renderRound() {
    $("t-round").innerHTML = roundHtml();
    $("h-round").innerHTML = roundHtml();
    $("x-round").innerHTML = roundHtml();
  }
  function renderThesis() {
    var r = current();
    if (!r) {
      $("t-h").textContent = "Agent thesis";
      $("t-body").innerHTML = '<p class="tm-empty">' + (state.rows.length ? "No thesis for this market yet: its exchange doesn't publish 24-hour stats for it. Pick one from the list." : "Reading the markets…") + "</p>";
      return;
    }
    var t = M.thesis(state.rows, r), filled = Math.min(5, Math.abs(t.score) + 1);
    var meter = "";
    for (var i = 0; i < 5; i++) meter += "<i" + (i < filled ? ' class="f"' : "") + "></i>";
    $("t-h").textContent = r.base + " thesis";
    state.rules = t.rules;
    var html =
      '<div class="th-head"><span class="th-verdict v-' + t.verdict + '">' + glyph(t.verdict) + t.verdict + "</span>" +
      '<p class="th-sum">' + esc(t.summary) + "</p>" +
      '<span class="th-meter v-' + t.verdict + '" title="Conviction" aria-hidden="true">' + meter + "</span>" +
      '<a class="th-go" href="/chat.html?idea=' + encodeURIComponent(M.idea(r, t)) + '">' + glyph("flask") + "Backtest this idea</a></div>" +
      '<div class="th-reads">' + t.reads.map(function (x) {
        return '<article class="th-read s-' + x.stance + '"><header><span class="th-av">' + glyph(x.agent) + "</span>" +
          "<div><b>" + x.agent + " agent</b><small>" + x.role + "</small></div>" +
          '<span class="th-stance">' + STANCE[x.stance] + "</span></header><p>" + esc(x.text) + "</p></article>";
      }).join("") + "</div>" +
      '<div class="th-foot"><div class="th-rules">Rules it would run under' +
      "<b>Loss limit " + t.rules.lossPercent + "%</b><b>Largest trade " + t.rules.tradePercent + "%</b><b>Price band 1%</b>" +
      '<span class="th-why">enforced on chain once an agent runs it</span></div>' +
      '<button type="button" class="pl-chip th-plan" data-plan>Plan it on the chart</button></div>';
    if ($("t-body").innerHTML !== html) $("t-body").innerHTML = html;
  }

  // ------------------------------------------------------------ hot list
  function hotRow(x, i, cls) {
    var r = x.row, on = r.id.toLowerCase() === String(state.symbol).toLowerCase();
    return '<li><button type="button" class="tm-hot-row' + (on ? " on" : "") + '" data-s="' + esc(r.id) + '">' +
      coin(r.base) +
      "<div><b>" + esc(r.base) + (r.kind === "perp" ? ' <span class="tm-perp">PERP</span>' : "") + ' <span class="vn"><i class="vd ' + r.venue + '"></i>' + VENUE[r.venue] + "</span></b>" +
      '<small class="lv">' + esc(M.reason(x.thesis)) + "</small></div>" +
      '<span class="side-r">' + chg(r.change) + heat(x.thesis, cls) + "</span></button></li>";
  }
  function renderHot() {
    if (!state.rows.length) return;
    var ids = function (list) { return list.map(function (x) { return x.row.id; }).join("|"); };
    paint($("hot-list"), state.hot.hot.length ? state.hot.hot.map(function (x, i) { return hotRow(x, i, "hot"); }).join("") : '<li class="tm-empty">Nothing stands out this round.</li>', "hot:" + ids(state.hot.hot));
    paint($("cold-list"), state.hot.cold.length ? state.hot.cold.map(function (x, i) { return hotRow(x, i, "cold"); }).join("") : '<li class="tm-empty">Nothing is cooling off this round.</li>', "cold:" + ids(state.hot.cold));
    $("h-sub").textContent = "Three agents read " + state.rows.length.toLocaleString("en-US") + " markets, every 4 hours.";
  }
  function markHot() {
    document.querySelectorAll(".tm-hot-row").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-s").toLowerCase() === String(state.symbol).toLowerCase());
    });
  }
  $("hot").addEventListener("click", function (e) {
    var b = e.target.closest("[data-s]");
    if (b) select(b.getAttribute("data-s"));
  });

  // --------------------------------------------------------- thesis / plan
  function setView(v) {
    var planning = v === "plan";
    $("t-body").hidden = planning;
    $("p-body").hidden = !planning;
    $("t-sample").hidden = planning;
    $("t-round").hidden = planning;
    document.body.classList.toggle("planning", planning);
    document.querySelectorAll("#tp [data-t]").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-t") === v)); });
    if (planning) plan.show(); else plan.hide();
  }
  $("tp").addEventListener("click", function (e) {
    var b = e.target.closest("[data-t]");
    if (b) setView(b.getAttribute("data-t"));
  });
  $("t-body").addEventListener("click", function (e) {
    if (!e.target.closest("[data-plan]")) return;
    plan.use(state.rules);
    setView("plan");
  });
  $("share").addEventListener("click", function () {
    var b = $("share"), label = b.lastElementChild;
    var done = function (text) { label.textContent = text; setTimeout(function () { label.textContent = "Share"; }, 1600); };
    if (!navigator.clipboard) return done("Copy the address bar");
    navigator.clipboard.writeText(location.href).then(function () { done("Link copied"); }, function () { done("Couldn\u2019t copy"); });
  });

  // ------------------------------------------------- panels (narrow screens)
  function setPanel(p) {
    document.body.setAttribute("data-panel", p);
    document.querySelectorAll("#tabs [data-p]").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-p") === p)); });
  }
  $("tabs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-p]");
    if (b) setPanel(b.getAttribute("data-p"));
  });
  setPanel("thesis");

  // ---------------------------------------------------------------- start
  var plan = window.ReinsChartPlan({
    el: $("p-body"),
    chart: function () { return ws && ws.active ? ws.active.chart : null; },
    market: current,
    rules: function () { return state.rules || null; },
  });
  startChart();
  renderRound();
  refresh();
  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  setInterval(renderRound, 30 * 1000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { refresh(); renderRound(); } });
})();
