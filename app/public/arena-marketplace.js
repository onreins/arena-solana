/* The Arena marketplace page (docs/ARENA-SITE-SPEC.md, "Marketplace"). PLANNED,
   not live: no prices, no payments. It lists every real record from
   /api/callbook with at least one revealed prediction, as cards you can
   filter, sort and open for details, and takes a waitlist through
   /api/arena/waitlist (subscribe to a record, or sell your own). Without that
   API the listings still show, without counts, and joining is off. Wording
   follows docs/ARENA-MESSAGING.md. Escapes everything it prints. */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  U.topbar("callbook");
  C.tooltips();

  var API = "/api/arena/waitlist";
  var BOOK_ID = /^\d{1,12}$/;
  var SESSION_KEY = "reins.session.v1";
  // The waitlist's sign-in (app/arena-waitlist-routes.js): one signed JoinWaitlist
  // { account, deadline }, sent as X-Arena-Session "<account>.<deadline>.<signature>".
  // Kept for this browser until it expires; the server takes up to 7 days ahead.
  var TOKEN_KEY = "reins.arena.waitlist.v1";
  var TOKEN_SEC = 6 * 86400, TOKEN_SLACK = 300;
  var TYPES = {
    EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
    JoinWaitlist: [{ name: "account", type: "address" }, { name: "deadline", type: "uint256" }],
  };
  var TOKEN_RE = /^(0x[0-9a-f]{40})\.(\d{1,12})\.(0x[0-9a-fA-F]{130})$/;
  var MSG = {
    off: "The waitlist isn’t open yet. Check back soon.",
    sample: "Sample record: the waitlist opens on real records.",
    net: "Couldn’t reach the waitlist. Try again.",
    busy: "Too many tries. Wait a minute and try again.",
    bad: "This record can’t be joined.",
    signin: "Sign in first.",
    sign: "Confirm in your wallet. It’s free and sends nothing.",
  };

  var CHECK = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  var CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  var D = null, LIST = [];
  var view = { kind: "all", q: "", sort: "score" };
  // The waitlist: "loading" until the first GET, "open" when the API answers, "off" when it doesn't.
  // `domain` is what a join is signed against; without it nobody can join.
  var NONE = { subscribe: [], sell: false };
  var wl = { status: "loading", subscribe: {}, subTotal: 0, sellTotal: 0, mine: NONE, domain: null };
  var canJoin = function () { return wl.status === "open" && !!wl.domain; };

  // ------------------------------------------------------------ who's signed in
  function me() {
    try {
      var s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      return s && C.ADDR_RE.test(s.address || "") ? String(s.address).toLowerCase() : null;
    } catch (e) { return null; }
  }
  /** The saved waitlist token for whoever is signed in now, if it hasn't expired. */
  function token() {
    var a = me();
    if (!a) return null;
    try {
      var t = String(localStorage.getItem(TOKEN_KEY) || ""), m = TOKEN_RE.exec(t);
      return m && m[1] === a && Number(m[2]) > Date.now() / 1000 + TOKEN_SLACK ? t : null;
    } catch (e) { return null; }
  }
  function forgetToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* storage off */ } }
  /** Sign a fresh token with the signed-in wallet (a prompt in the wallet; no gas, nothing sent on chain). */
  async function signToken() {
    var a = me();
    if (!a || !wl.domain || !window.ReinsAuth) throw new Error(MSG.signin);
    var deadline = Math.floor(Date.now() / 1000) + TOKEN_SEC;
    var sig = await window.ReinsAuth.signTypedData({
      types: TYPES, primaryType: "JoinWaitlist", domain: wl.domain, message: { account: a, deadline: String(deadline) },
    });
    if (!/^0x[0-9a-fA-F]{130}$/.test(sig || "")) throw new Error("The wallet didn’t return a signature.");
    var t = a + "." + deadline + "." + sig;
    try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* storage off: this page only */ }
    return t;
  }
  function headers(withBody, tok) {
    var h = { accept: "application/json" };
    if (withBody) h["content-type"] = "application/json";
    if (tok) h["x-arena-session"] = tok;
    return h;
  }

  // ------------------------------------------------------------ the waitlist API
  var isCount = function (n) { return C.isNum(n) && n >= 0; };
  /** The counts in either the GET body or a POST's `counts`, checked; null when malformed. */
  function readCounts(c) {
    if (!c || !c.subscribe || typeof c.subscribe !== "object") return null;
    var by = {}, src = c.subscribe.byBook && typeof c.subscribe.byBook === "object" ? c.subscribe.byBook : {};
    Object.keys(src).forEach(function (k) { if (BOOK_ID.test(k) && isCount(src[k])) by[k] = Math.floor(src[k]); });
    return {
      subscribe: by,
      subTotal: isCount(c.subscribe.total) ? Math.floor(c.subscribe.total) : 0,
      sellTotal: c.sell && isCount(c.sell.total) ? Math.floor(c.sell.total) : 0,
    };
  }
  function readMine(m) {
    if (!m || typeof m !== "object") return NONE;
    var ids = Array.isArray(m.subscribe) ? m.subscribe.map(String).filter(function (x) { return BOOK_ID.test(x); }) : [];
    return { subscribe: ids, sell: m.sell === true };
  }
  function readDomain(d) {
    if (!d || d.name !== "Arena" || String(d.version) !== "1" || !C.isNum(Number(d.chainId)) || !C.ADDR_RE.test(d.verifyingContract || "")) return null;
    return { name: "Arena", version: "1", chainId: Number(d.chainId), verifyingContract: d.verifyingContract };
  }
  async function loadWaitlist() {
    try {
      var tok = token();
      var res = await fetch(API, { headers: headers(false, tok), credentials: "same-origin", cache: tok ? "no-store" : "default" });
      var body = res.ok ? await res.json() : null;
      var counts = body && body.ok === true ? readCounts(body) : null;
      if (!counts) { wl = Object.assign({}, wl, { status: "off" }); return; }
      wl = Object.assign({}, counts, { status: "open", domain: readDomain(body.domain), mine: tok ? readMine(body.mine) : NONE });
    } catch (e) {
      wl = Object.assign({}, wl, { status: "off" });
    }
  }
  var serverWords = function (data, fallback) { return (data && typeof data.error === "string" && data.error.slice(0, 160)) || fallback; };
  var explain = function (e) { return window.ReinsWallet && window.ReinsWallet.explain ? window.ReinsWallet.explain(e) : MSG.signin; };
  /** POST a join, signing a token first when there's none; resolves { ok, message }. Updates `wl` on success. */
  async function postJoin(role, bookId, onSign, retried) {
    var tok = token();
    if (!tok) {
      onSign();
      try { tok = await signToken(); } catch (e) { return { ok: false, message: explain(e) }; }
    }
    var body = role === "sell" ? { role: "sell" } : { role: "subscribe", bookId: Number(bookId) };
    var res;
    try {
      res = await fetch(API, { method: "POST", headers: headers(true, tok), credentials: "same-origin", body: JSON.stringify(body) });
    } catch (e) { return { ok: false, message: MSG.net }; }
    var data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (res.ok && data && data.ok === true) {
      var counts = readCounts(data.counts);
      var mine = data.mine ? readMine(data.mine) : {
        subscribe: role === "subscribe" && wl.mine.subscribe.indexOf(String(bookId)) < 0 ? wl.mine.subscribe.concat([String(bookId)]) : wl.mine.subscribe,
        sell: role === "sell" ? true : wl.mine.sell,
      };
      wl = Object.assign({}, wl, counts || bumped(role, bookId), { mine: mine });
      return { ok: true };
    }
    // A token the server no longer takes (expired, another deployment): sign a new one, once.
    if (res.status === 401) { forgetToken(); return retried ? { ok: false, message: serverWords(data, MSG.signin) } : postJoin(role, bookId, onSign, true); }
    if (res.status === 429) return { ok: false, message: MSG.busy };
    if (res.status === 400) return { ok: false, message: MSG.bad };
    if (res.status === 404) { wl = Object.assign({}, wl, { status: "off" }); return { ok: false, message: MSG.off }; }
    if (res.status === 503) return { ok: false, message: serverWords(data, MSG.off) };
    return { ok: false, message: MSG.net };
  }
  // The server sent no counts back: count the join here, once.
  function bumped(role, bookId) {
    if (role === "sell") return wl.mine.sell ? {} : { sellTotal: wl.sellTotal + 1 };
    var id = String(bookId), already = wl.mine.subscribe.indexOf(id) >= 0;
    if (already) return {};
    var by = Object.assign({}, wl.subscribe);
    by[id] = (by[id] || 0) + 1;
    return { subscribe: by, subTotal: wl.subTotal + 1 };
  }

  // ------------------------------------------------------------ the records
  var isControl = function (x) { return !!(x.baseline || x.control); };
  function records(d) {
    var tag = function (kind) { return function (x) { return Object.assign({}, x, { kind: kind }); }; };
    var all = (d.books || []).map(tag("agent")).concat((d.callers || []).map(tag("person")));
    return all.filter(function (x) { return x && x.metrics && !x.sample && (x.metrics.revealed || 0) >= 1; });
  }
  // Each sort's value; a record without one goes last.
  var SORTS = {
    score: function (x) { return C.scoreOf(x); },
    ret: function (x) { return x.metrics.totalReturn; },
    calls: function (x) { return x.metrics.calls; },
    days: function (x) { return x.metrics.days; },
  };
  function shown() {
    var key = SORTS[view.sort] || SORTS.score, q = view.q.trim().toLowerCase();
    var val = function (x) { var v = key(x); return C.isNum(v) ? v : -Infinity; };
    return LIST.filter(function (x) {
      if (view.kind !== "all" && x.kind !== view.kind) return false;
      if (!q) return true;
      return [C.nameOf(x), (x.coins || []).join(" "), x.description || ""].join(" ").toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) {
      // The control always sits last: it's the bar, not a listing.
      if (isControl(a) !== isControl(b)) return isControl(a) ? 1 : -1;
      return val(b) - val(a) || (b.metrics.days || 0) - (a.metrics.days || 0);
    });
  }
  var joinable = function (x) { return D && D.mode !== "mock" && !isControl(x) && BOOK_ID.test(String(x.id)); };
  var byId = function (id) { return LIST.filter(function (x) { return String(x.id) === String(id); })[0] || null; };
  function hrefOf(x) {
    return x.kind === "agent" ? "/arena-bot?b=" + encodeURIComponent(x.id) : "/arena-caller?c=" + encodeURIComponent(x.id);
  }
  // Who runs a record: the wallet its agent is linked to, if any, else its owner.
  function whoseOf(x) { var w = D.links && C.own(D.links, x.owner); return w || x.owner || ""; }
  function byLine(x) {
    var who = whoseOf(x), p = D.people && C.own(D.people, who);
    var name = p && p.name ? p.name : x.ours ? "Reins" : C.ADDR_RE.test(who) ? U.short(who) : "";
    if (!name) return "";
    var href = C.profileHref(who);
    return "by " + (href ? '<a href="' + esc(href) + '">' + esc(name) + "</a>" : esc(name));
  }

  // ------------------------------------------------------------ the pieces
  // A letter on a tinted square, the same tint for the same record every time.
  var TINTS = 6;
  function avatar(x, big) {
    var s = String(x.kind) + ":" + String(x.id), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    var letter = (C.nameOf(x).match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
    return '<span class="mk-av t' + (h % TINTS) + (big ? " big" : "") + '" aria-hidden="true">' + esc(letter) + "</span>";
  }
  function chips(x) {
    var out = ['<span class="mk-chip">' + (x.kind === "agent" ? "Agent" : "Person") + "</span>"];
    var coins = Array.isArray(x.coins) ? x.coins.filter(function (c) { return typeof c === "string" && c; }) : [];
    if (x.anyCoin) out.push('<span class="mk-chip">Any coin</span>');
    coins.slice(0, 3).forEach(function (c) { out.push('<span class="mk-chip coin">' + esc(c) + "</span>"); });
    if (coins.length > 3) out.push('<span class="mk-chip more" data-tip="' + esc(coins.slice(3).join(", ")) + '" tabindex="0">+' + (coins.length - 3) + "</span>");
    if (C.isNum(x.horizonSec)) out.push('<span class="mk-chip">' + esc(C.hours(x.horizonSec)) + " predictions</span>");
    return out.join("");
  }
  // Growth of 1 over the record, as a filled line against where it started.
  function area(x, w, h, uid) {
    var pts = (x.curve || []).filter(function (p) { return C.isNum(p.v) && C.isNum(p.t); });
    var box = 'viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none"';
    if (pts.length < 2) return '<svg class="mk-area flat" ' + box + ' aria-hidden="true"><path class="base" d="M0 ' + h / 2 + "H" + w + '"/></svg>';
    var vs = pts.map(function (p) { return p.v; }).concat([1]);
    var lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs), sp = hi - lo || 0.01, pad = 3;
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    var X = function (t) { return ((t - t0) / (t1 - t0 || 1)) * w; };
    var Y = function (v) { return pad + (1 - (v - lo) / sp) * (h - pad * 2); };
    var line = pts.map(function (p, i) { return (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.v).toFixed(1); }).join("");
    var tone = pts[pts.length - 1].v >= 1 ? "up" : "down", gid = "mkg-" + uid;
    return '<svg class="mk-area ' + tone + '" ' + box + ' aria-hidden="true">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>' +
      '<path class="base" d="M0 ' + Y(1).toFixed(1) + "H" + w + '"/>' +
      '<path class="fill" fill="url(#' + gid + ')" d="' + line + "L" + w + " " + h + "L0 " + h + 'Z"/>' +
      '<path class="ln" d="' + line + '"/></svg>';
  }
  function scoreChip(x) {
    var v = C.scoreOf(x);
    if (!C.isNum(v)) return '<span class="mk-score none" tabindex="0" data-tip="Not scored yet: it needs more predictions">—<small>/100</small></span>';
    return '<span class="mk-score" tabindex="0" data-tip="Arena score: skill after fees, from 0 to 100">' + esc(Math.max(0, Math.min(100, Math.round(v)))) + "<small>/100</small></span>";
  }
  function cell(label, value, tip) {
    return "<div><dt" + (tip ? ' tabindex="0" data-tip="' + esc(tip) + '"' : "") + ">" + esc(label) + "</dt><dd>" + value + "</dd></div>";
  }
  var HIDDEN_TIP = "Predictions kept hidden. Each one counts as the worst result.";
  var RET_TIP = "What its predictions made, compounded, after fees and funding";
  var hiddenHtml = function (n) { return '<span class="' + (n ? "down" : "") + '">' + C.int(n) + "</span>"; };

  function card(x) {
    var m = x.metrics, control = isControl(x), id = String(x.id);
    return '<article class="mk-card' + (control ? " control" : "") + '" data-id="' + esc(id) + '">' +
      '<header class="mk-card-h">' + avatar(x) +
        '<div class="mk-who"><h3><button type="button" class="mk-open" data-open="' + esc(id) + '">' + esc(C.nameOf(x)) + "</button></h3>" +
        '<p class="mk-by">' + (byLine(x) || "&nbsp;") + "</p></div>" + scoreChip(x) + "</header>" +
      '<div class="mk-chips">' + chips(x) + (control ? '<span class="mk-chip ctl">Control · not for sale</span>' : "") + "</div>" +
      '<div class="mk-perf"><div><p class="mk-lbl">Return after fees</p><p class="mk-ret">' + C.pctHtml(m.totalReturn) + "</p></div>" +
        area(x, 160, 52, "c" + id) + "</div>" +
      '<dl class="mk-stats">' +
        cell("Predictions", C.int(m.calls)) +
        cell("Hidden", hiddenHtml(m.withheld || 0), HIDDEN_TIP) +
        cell("Worst drop", '<span class="down">' + C.dd(C.eodOf(m)) + "</span>", "Its worst fall from a high") +
      "</dl>" +
      (control
        ? '<p class="mk-ctl-note">Random picks: the bar every agent has to beat.</p>'
        : '<div class="mk-act" data-act="subscribe" data-id="' + esc(id) + '">' + actionHtml("subscribe", x) + "</div>") +
      "</article>";
  }

  // ------------------------------------------------------------ the buttons
  // One place draws a join button, its count and its message, for a card, the drawer or the seller panel.
  function actionHtml(role, x) {
    var id = x ? String(x.id) : "";
    var joined = role === "sell" ? wl.mine.sell : wl.mine.subscribe.indexOf(id) >= 0;
    var label = role === "sell" ? "Join the seller waitlist" : "Join waitlist";
    var n = role === "sell" ? wl.sellTotal : wl.subscribe[id] || 0;
    var off = !canJoin() || (x && !joinable(x));
    // Cards stay quiet when the waitlist is off (the page says it once); the seller panel says it too.
    var note = wl.status === "loading" ? "" : x && !joinable(x) ? MSG.sample : !x && !canJoin() ? MSG.off : "";
    var wait = canJoin()
      ? '<span class="mk-wait">' + C.int(n) + (role === "sell" ? " agent owners" : "") + " waiting</span>"
      : role === "sell" ? "" : '<span class="mk-wait">Price set at launch</span>';
    var btn = joined
      ? '<button type="button" class="mk-btn done" aria-disabled="true">' + CHECK + "On the list</button>"
      : '<button type="button" class="mk-btn" data-role="' + role + '"' + (x ? ' data-id="' + esc(id) + '"' : "") + (off ? " disabled" : "") + ">" + label + "</button>";
    return wait + btn + '<span class="mk-msg" role="status">' + esc(note) + "</span>";
  }
  function drawActions() {
    document.querySelectorAll('[data-act="subscribe"]').forEach(function (el) {
      var x = byId(el.getAttribute("data-id"));
      if (x) el.innerHTML = actionHtml("subscribe", x);
    });
    $("mk-sell-act").innerHTML = actionHtml("sell", null);
    var notes = [];
    if (D && D.mode === "mock") notes.push("Sample data: made-up records that show how the page works.");
    if (wl.status !== "loading" && !canJoin()) notes.push(MSG.off);
    note(notes.join(" "));
  }
  function say(where, text) {
    var msg = where && where.querySelector(".mk-msg");
    if (msg) msg.textContent = text || "";
  }
  // The open drawer's button first, so a join started there finishes there.
  function scopeOf(role, id) {
    if (role === "sell") return $("mk-sell-act");
    var sel = '[data-act="subscribe"][data-id="' + CSS.escape(String(id)) + '"]';
    return (!$("mk-drawer").hidden && $("mk-drawer").querySelector(sel)) || document.querySelector(sel);
  }

  async function join(btn) {
    var role = btn.getAttribute("data-role"), id = btn.getAttribute("data-id");
    var box = btn.closest("[data-act]");
    if (!canJoin() || btn.disabled) return;
    if (role !== "sell" && !BOOK_ID.test(id || "")) { say(box, MSG.bad); return; }
    if (!me()) {
      try { await U.connect(); } catch (e) { return; } // the sign-in panel was closed
      await loadWaitlist(); // your own joins, now that we know who you are
      drawActions();
      if (role === "sell" ? wl.mine.sell : wl.mine.subscribe.indexOf(id) >= 0) return;
      box = scopeOf(role, id);
      btn = box && box.querySelector(".mk-btn[data-role]");
      if (!btn || btn.disabled) return;
    }
    btn.disabled = true;
    btn.classList.add("wait");
    say(box, "");
    var label = btn.textContent;
    var r = await postJoin(role, id, function () { btn.textContent = "Confirm in your wallet…"; say(box, MSG.sign); });
    if (r.ok) {
      drawActions();
      var done = scopeOf(role, id), b = done && done.querySelector(".mk-btn.done");
      if (b) b.focus();
      return;
    }
    btn.textContent = label;
    btn.disabled = !canJoin();
    btn.classList.remove("wait");
    say(box, r.message);
  }

  // ------------------------------------------------------------ the drawer
  var opener = null;
  function drawerHtml(x) {
    var m = x.metrics, control = isControl(x), id = String(x.id);
    var desc = typeof x.description === "string" && x.description.trim() ? '<p class="mk-d-desc">' + esc(x.description.trim().slice(0, 400)) + "</p>" : "";
    return '<header class="mk-d-h">' + avatar(x, true) +
        '<div class="mk-who"><h2 id="mk-d-name">' + esc(C.nameOf(x)) + '</h2><p class="mk-by">' + (byLine(x) || "") + "</p></div>" +
        '<button type="button" class="mk-x" data-close aria-label="Close">' + CLOSE + "</button></header>" +
      '<div class="mk-d-body">' +
        '<div class="mk-chips">' + chips(x) + (control ? '<span class="mk-chip ctl">Control · not for sale</span>' : "") + "</div>" + desc +
        '<div class="mk-d-perf"><div class="mk-d-top"><div><p class="mk-lbl">Return after fees</p><p class="mk-ret big">' + C.pctHtml(m.totalReturn) + "</p></div>" + scoreChip(x) + "</div>" +
          area(x, 440, 120, "d" + id) + '<p class="mk-d-axis"><span>Start</span><span>' + esc(C.int(Math.floor(m.days || 0))) + " days of record</span></p></div>" +
        '<dl class="mk-d-stats">' +
          cell("Predictions", C.int(m.calls)) +
          cell("Revealed", C.int(m.revealed)) +
          cell("Hidden", hiddenHtml(m.withheld || 0), HIDDEN_TIP) +
          cell("Return after fees", C.pctHtml(m.totalReturn), RET_TIP) +
          cell("Against the market", C.pctHtml(m.vsMarket), "Its return minus holding the same coins") +
          cell("Worst drop", '<span class="down">' + C.dd(C.eodOf(m)) + "</span>", "Its worst fall from a high") +
          cell("Win rate", C.isNum(m.winRate) ? esc(Math.round(m.winRate * 100)) + "%" : "—") +
          cell("Days of record", C.int(Math.floor(m.days || 0))) +
        "</dl>" +
        (control ? '<p class="mk-ctl-note">A control with no edge by design: random picks. It pays fees and funding like everyone else, so it shows the bar every agent has to beat.</p>'
          : '<div class="mk-d-terms"><p class="mk-k">At launch</p><dl>' +
              cell("Price", "Monthly, in USDC, set by the seller") +
              cell("Bond", "Posted at listing, pays you back if a prediction is hidden") +
              cell("You get", "Every prediction the moment it’s recorded, checkable on Arc") +
            "</dl></div>") +
      "</div>" +
      '<footer class="mk-d-f"><a class="mk-ghost" href="' + esc(hrefOf(x)) + '">Full record</a>' +
        (control ? "" : '<div class="mk-act" data-act="subscribe" data-id="' + esc(id) + '">' + actionHtml("subscribe", x) + "</div>") +
      "</footer>";
  }
  function openDrawer(id, from) {
    var x = byId(id);
    if (!x) return;
    opener = from || null;
    var d = $("mk-drawer");
    d.innerHTML = drawerHtml(x);
    $("mk-scrim").hidden = false;
    d.hidden = false;
    document.documentElement.classList.add("mk-lock");
    requestAnimationFrame(function () { d.classList.add("in"); $("mk-scrim").classList.add("in"); });
    d.focus();
  }
  function closeDrawer() {
    var d = $("mk-drawer");
    if (d.hidden) return;
    d.classList.remove("in");
    $("mk-scrim").classList.remove("in");
    d.hidden = true;
    $("mk-scrim").hidden = true;
    document.documentElement.classList.remove("mk-lock");
    if (opener && document.contains(opener)) opener.focus();
    opener = null;
  }
  // Keep Tab inside the open drawer.
  function trap(e) {
    var d = $("mk-drawer");
    var f = Array.prototype.filter.call(d.querySelectorAll("a[href],button:not([disabled]),[tabindex]:not([tabindex='-1'])"), function (el) { return el.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === d)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ------------------------------------------------------------ events
  document.addEventListener("click", function (e) {
    var t = e.target;
    var b = t.closest && t.closest(".mk-btn[data-role]");
    if (b) { join(b); return; }
    if (t.closest("[data-close]") || t.id === "mk-scrim") { closeDrawer(); return; }
    var open = t.closest(".mk-open");
    if (open) { openDrawer(open.getAttribute("data-open"), open); return; }
    // A click anywhere else on a card opens it, unless it was on a link or a control.
    var c = t.closest(".mk-card[data-id]");
    if (c && !t.closest("a,button,[data-tip],.mk-act")) openDrawer(c.getAttribute("data-id"), c.querySelector(".mk-open"));
  });
  document.addEventListener("keydown", function (e) {
    if ($("mk-drawer").hidden) return;
    if (e.key === "Escape") closeDrawer();
    else if (e.key === "Tab") trap(e);
  });
  document.querySelectorAll(".mk-seg button").forEach(function (b) {
    b.addEventListener("click", function () {
      view = Object.assign({}, view, { kind: b.getAttribute("data-kind") });
      document.querySelectorAll(".mk-seg button").forEach(function (o) { o.setAttribute("aria-pressed", String(o === b)); });
      drawList();
    });
  });
  $("mk-q").addEventListener("input", function () { view = Object.assign({}, view, { q: this.value.slice(0, 60) }); drawList(); });
  $("mk-sort").addEventListener("change", function () { view = Object.assign({}, view, { sort: SORTS[this.value] ? this.value : "score" }); drawList(); });
  // Signing in or out elsewhere (the top bar, another tab) changes which joins are yours.
  window.addEventListener("reins:session", function () {
    if (!me()) forgetToken();
    if (wl.status === "loading") return;
    loadWaitlist().then(drawActions);
  });

  // ------------------------------------------------------------ the page
  function note(text) {
    $("mk-note").textContent = text || "";
    $("mk-note").hidden = !text;
  }
  function drawList() {
    var grid = $("mk-grid"), list = shown();
    grid.setAttribute("aria-busy", "false");
    var real = LIST.filter(function (x) { return !isControl(x); }).length;
    $("mk-count").textContent = list.length === LIST.length ? real + (real === 1 ? " listing" : " listings") : list.length + " of " + LIST.length;
    if (!LIST.length) {
      grid.innerHTML = '<p class="mk-empty">No records to list yet. Agents and people appear here after their first revealed prediction.</p>';
      return;
    }
    grid.innerHTML = list.length ? list.map(card).join("") : '<p class="mk-empty">Nothing matches. Try another name or coin.</p>';
  }

  var dataP = C.loadIndex().then(function (d) {
    D = d;
    LIST = records(d);
    $("mk-status").innerHTML = C.statusPill(d);
    $("foot-net").textContent = d.network || "Arc";
    drawList();
  }).catch(function () {
    $("mk-grid").setAttribute("aria-busy", "false");
    $("mk-grid").innerHTML = '<p class="mk-empty">Couldn’t load the records. Reload to try again.</p>';
  });
  Promise.all([dataP, loadWaitlist()]).then(drawActions);
})();
