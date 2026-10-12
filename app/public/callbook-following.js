/* The Following page (Solana mode): for the connected wallet, every agent it
   copies (Follow accounts in the follow program where follower = wallet), the
   terms, limits and fees paid, the copy subaccount's open positions on
   Velocity, and Stop copying in two labelled steps: the follow program's
   `stop`, then removing the copier as the subaccount's delegate (the one that
   matters for safety). */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, K = window.ReinsCopyUI, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  U.topbar("callbook");
  C.tooltips();
  $("custody").innerHTML = K.CUSTODY;
  $("legal").innerHTML = K.LEGAL;

  var cfg = null, S = null, ctx = null, W = null, names = {}, prices = {};

  K.config().then(function (c) {
    cfg = c;
    if (!cfg) {
      $("body").innerHTML = '<div class="sc-empty"><b>Copy-trading runs on Solana</b>This server shows Arena on another network, so there is nothing to follow here. <a href="/arena">Back to Arena</a></div>';
      return;
    }
    $("foot-net").textContent = cfg.network || "";
    C.loadIndex().then(function (d) {
      ((d && d.callers) || []).forEach(function (x) { if (x.owner && !names[x.owner]) names[x.owner] = { name: C.nameOf(x), id: x.id }; });
    }).catch(function () { /* names stay keys */ });
    return K.bundle().then(function (lib) {
      S = lib;
      ctx = S.init(cfg);
      S.markPrices().then(function (p) { prices = p; });
      askWallet();
    });
  }).catch(function (err) {
    $("body").innerHTML = '<div class="sc-empty"><b>Couldn’t load</b>' + esc(err.message || "") + "</div>";
  });

  function askWallet() {
    $("body").innerHTML = '<div class="sc-card"><h2 class="sc-p" style="margin:0;color:var(--ink)">Connect the wallet you copy with</h2><div id="pick"></div></div>';
    K.pickWallet(S, $("pick")).then(function (w) {
      W = w;
      $("who").innerHTML = '<span class="sc-pill on mono">' + esc(K.short(w.publicKey.toBase58())) + "</span>" +
        '<button type="button" class="chip" id="reload">Refresh</button>';
      $("reload").addEventListener("click", load);
      load();
    });
  }

  function load() {
    $("body").innerHTML = '<div class="sc-empty"><b>Reading your subscriptions…</b></div>';
    S.following(ctx, W.publicKey).then(draw).catch(function (err) {
      $("body").innerHTML = '<div class="sc-empty"><b>Couldn’t read your subscriptions</b>' + esc(S.explain(err)) +
        "<br>Some public RPCs refuse this kind of query; the server can set SOLANA_PUBLIC_RPC_URL to one that allows it.</div>";
    });
  }

  function draw(rows) {
    if (!rows.length) {
      $("body").innerHTML = '<div class="sc-empty"><b>You don’t copy any agent yet</b>Open an agent’s record and press <b>Copy this agent</b>. <a href="/arena-leaderboard">See the leaderboard</a></div>';
      return;
    }
    var now = Date.now() / 1000;
    // Active first, then the latest paid-until.
    rows.sort(function (a, b) { return (b.follow.active - a.follow.active) || (b.follow.paidUntil - a.follow.paidUntil); });
    $("body").innerHTML = '<div class="sc-cards">' + rows.map(function (r, i) { return card(r, i, now); }).join("") + "</div>";
    rows.forEach(function (r, i) { wireStop(r, i); });
  }

  function card(r, i, now) {
    var f = r.follow, s = f.settings, p = r.plan, agent = p ? p.agent.toBase58() : null, who = agent && names[agent];
    var paid = f.paidUntil > now, copying = f.active && paid;
    var state = !f.active ? '<span class="sc-pill">Stopped</span>' : paid ? '<span class="sc-pill on">Copying</span>' : '<span class="sc-pill warn">Expired: renew to keep copying</span>';
    var title = who ? '<a href="/arena-caller?c=' + esc(who.id) + '">' + esc(who.name) + "</a>" : agent ? K.addressLink(S, agent, cfg.cluster, "Agent " + K.short(agent)) : "Unknown agent";
    var size = Number(s.sizeMode) === 1 ? K.bps(s.sizeValue) + " of the copy account" : "$" + K.money(s.sizeValue, cfg.quote.decimals) + " per trade";
    var dt = function (k, v, sub) { return "<div><dt>" + esc(k) + "</dt><dd>" + v + (sub ? "<small>" + sub + "</small>" : "") + "</dd></div>"; };
    var deleg = r.user ? (r.delegated ? "Reins’ copier" : r.delegate && r.delegate.equals(S.PublicKey.default) ? "none (revoked)" : "another key: " + esc(K.short(r.delegate.toBase58()))) : "no subaccount";
    return '<article class="sc-card" id="f-' + i + '">' +
      '<div class="sc-card-h"><h2>' + title + "</h2>" + state + "</div>" +
      '<dl class="sc-kv">' +
        dt("Paid until", esc(C.stamp(f.paidUntil)), paid ? "in " + esc(C.span(f.paidUntil - now)) : "ended " + esc(C.ago(f.paidUntil))) +
        dt("Size", esc(size), "at most $" + esc(K.money(s.maxTrade, cfg.quote.decimals)) + " per trade") +
        dt("Limits", esc(s.maxOpen) + " open copied position" + (Number(s.maxOpen) > 1 ? "s" : ""), "daily loss cap $" + esc(K.money(s.dailyLossCap, cfg.quote.decimals))) +
        dt("Subscriptions paid", esc(K.money(f.totalPaid)) + " USDC", p ? esc(K.money(p.price)) + " USDC a month now" : "") +
        dt("Performance fees paid", esc(K.money(f.perfFeesPaid)) + " USDC", esc(K.bps(f.perfFeeBps)) + " of profit above the peak · " + esc(f.settlements) + " settlement" + (f.settlements === 1 ? "" : "s")) +
        dt("High-water mark", f.hwmSet ? "$" + esc(K.money(f.hwm, cfg.quote.decimals)) : "not set yet", f.lastSettledAt ? "last settled " + esc(C.ago(f.lastSettledAt)) : "set at the first settlement") +
        dt("Copy subaccount", "#" + esc(s.subAccountId) + " · " + K.addressLink(S, r.userAddress, cfg.cluster), "delegate: " + deleg) +
        dt("Follow account", K.addressLink(S, f.address, cfg.cluster)) +
      "</dl>" + positions(r) + stopBox(r, i, copying) + "</article>";
  }

  function positions(r) {
    var u = r.user;
    if (!u) return '<div class="sc-pos sc-p">The copy subaccount isn’t on Velocity (closed, or Velocity’s devnet was reset).</div>';
    var rows = u.perpPositions.filter(function (p) { return p.baseAssetAmount !== 0n; }).map(function (p) {
      var v = S.velocity.positionView(p, prices[S.velocity.DEVNET_PERP_MARKETS[p.marketIndex]]);
      return "<tr><td><b>" + esc(v.coin) + "</b> " + C.sidePill(v.side === "long" ? 1 : -1) + '</td><td class="r mono">' + esc(v.size.toLocaleString("en-US", { maximumFractionDigits: 4 })) + "</td>" +
        '<td class="r mono">' + (v.entry != null ? esc(v.entry.toLocaleString("en-US", { maximumFractionDigits: 2 })) : "—") + "</td>" +
        '<td class="r mono">' + (v.pnl != null ? '<span class="' + U.dirOf(v.pnl) + '">' + (v.pnl >= 0 ? "+" : "−") + "$" + esc(Math.abs(v.pnl).toFixed(2)) + "</span>" : "—") + "</td></tr>";
    });
    var settled = Number(u.settledPerpPnl) / 1e6, net = (Number(u.totalDeposits) - Number(u.totalWithdraws)) / 1e6;
    return '<div class="sc-pos"><h3>On Velocity</h3>' +
      (rows.length ? '<div class="dense-wrap"><table class="dense"><thead><tr><th scope="col">Position</th><th scope="col" class="r">Size</th><th scope="col" class="r">Entry</th>' +
        '<th scope="col" class="r" data-tip="At Hyperliquid’s mid price, before funding: an estimate. Velocity’s own oracle can differ." tabindex="0">PnL (est.)</th></tr></thead><tbody>' + rows.join("") + "</tbody></table></div>"
        : '<p class="sc-p">No open copied positions.</p>') +
      '<p class="sc-p">Settled profit and loss <b class="' + U.dirOf(settled) + '">' + (settled >= 0 ? "+" : "−") + "$" + esc(Math.abs(settled).toFixed(2)) + "</b> · deposited, net of withdrawals, $" + esc(net.toFixed(2)) +
      " · " + esc(u.openOrders) + " open order" + (u.openOrders === 1 ? "" : "s") + ". Velocity’s app shows its own live numbers for this subaccount.</p></div>";
  }

  function stopBox(r, i, copying) {
    var revoke = r.delegated;
    if (!r.follow.active && !revoke) return '<div class="sc-stop sc-p">Stopped, and the copier is no longer your subaccount’s delegate.</div>';
    return '<div class="sc-stop"><b>Stop copying</b> <span class="sc-p">two transactions, in this order:</span><ol>' +
      '<li><span><b>1. End the subscription.</b> The follow program marks it stopped, so the copier skips it from now on. Months already paid aren’t refunded.</span>' +
        (r.follow.active ? '<button type="button" class="chip" id="stop-' + i + '">End subscription</button>' : '<span class="sc-pill">Done</span>') + "</li>" +
      '<li><span><b>2. Remove Reins’ copier as the delegate</b> of subaccount #' + esc(r.follow.settings.subAccountId) + " on Velocity. <b>This is the step that matters for safety:</b> once it lands, the copier can’t place anything on your account, whatever happens to Reins. " +
        "Orders it already placed (stops and targets) stay until you cancel them on Velocity.</span>" +
        (revoke ? '<button type="button" class="chip danger" id="revoke-' + i + '">Remove delegate</button>' : '<span class="sc-pill">Done</span>') + "</li>" +
      '</ol><div id="stop-msg-' + i + '"></div></div>';
    void copying;
  }

  var sent = [];
  function wireStop(r, i) {
    var stop = $("stop-" + i), revoke = $("revoke-" + i), box = $("stop-msg-" + i);
    var go = function (btn, ixs, label) {
      btn.disabled = true;
      box.innerHTML = '<div class="sc-msg">Waiting for your wallet…</div>';
      S.send(ctx.connection, W, ixs).then(function (sig) {
        sent.push({ label: label, sig: sig });
        box.innerHTML = '<div class="sc-msg ok">Confirmed.' + K.txList(S, [{ label: label, sig: sig }], cfg.cluster) + "</div>";
        btn.outerHTML = '<span class="sc-pill">Done</span>';
      }, function (err) {
        btn.disabled = false;
        box.innerHTML = '<div class="sc-msg bad">' + esc(S.explain(err)) + (err.signature ? K.txList(S, [{ label: label, sig: err.signature }], cfg.cluster) : "") + "</div>";
      });
    };
    if (stop) stop.addEventListener("click", function () { go(stop, S.stopIxs(ctx, W.publicKey, r.follow.plan), "Follow program: stop"); });
    if (revoke) revoke.addEventListener("click", function () { go(revoke, S.revokeIxs(ctx, W.publicKey, r.follow.settings.subAccountId), "Velocity: remove delegate"); });
  }
})();
