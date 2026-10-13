/* The Copy button on an agent's page (?c=<id>), Solana mode only: connect a
   Solana wallet, set up a copy subaccount on Velocity (formerly Drift) with
   Reins' copier as its delegate, choose size and limits, then subscribe in the
   follow program. Every transaction links to Solana Explorer. Hidden unless
   GET /api/callbook/solana-config answers (the server is in Solana mode). */
(function () {
  "use strict";
  var U = window.ReinsUI, C = window.Callbook, K = window.ReinsCopyUI, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };
  var slot = $("copy-slot");
  if (!slot || !K) return;

  var cfg = null, agent = null, record = null;

  Promise.all([K.config(), C.loadIndex()]).then(function (r) {
    cfg = r[0];
    if (!cfg) return; // not Solana mode: no Copy button
    var id = String(C.params.get("c") || "");
    record = ((r[1] && r[1].callers) || []).filter(function (x) { return String(x.id) === id; })[0] || null;
    agent = record && record.owner;
    if (!agent || !C.isAccount(agent) || /^0x/i.test(agent)) return;
    slot.innerHTML = '<button type="button" class="ar-btn" id="copy-open">Copy this agent</button>' +
      "<small>Its trades placed on your own Velocity account, within your limits. Devnet. Not investment advice.</small>";
    slot.hidden = false;
    $("copy-open").addEventListener("click", open);
  }).catch(function () { /* no Copy button */ });

  // ------------------------------------------------------------------ the dialog
  var dlg = null, S = null, ctx = null, W = null, terms = null, vel = null, txs = [], subDone = false, velDone = false;

  function open() {
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.className = "sc-dlg";
      dlg.setAttribute("aria-labelledby", "sc-title");
      document.body.appendChild(dlg);
      dlg.addEventListener("click", function (e) { if (e.target === dlg) dlg.close(); });
    }
    dlg.innerHTML = '<div class="sc-bar"><b id="sc-title">Copy ' + esc(C.nameOf(record)) + '</b><button type="button" class="sc-x" id="sc-x" aria-label="Close">' + U.icon("close") + "</button></div>" +
      '<div class="sc-body">' +
        '<div class="sc-step" id="st-0"><p class="sc-p" id="sc-terms">Reading this agent’s plan…</p></div>' +
        step(1, "Connect a Solana wallet", '<div id="st-1-b"></div>') +
        step(2, "Set up your copy account on Velocity", '<div id="st-2-b"><p>Connect a wallet first.</p></div>') +
        step(3, "Choose size and limits", form()) +
        step(4, "Subscribe", '<div id="st-4-b"><p>One transaction from your wallet: the subscription, and an optional performance-fee allowance.</p>' +
          '<div class="sc-acts"><button type="button" class="btn-white" id="sc-sub" disabled>Subscribe</button></div><div id="st-4-msg"></div></div>') +
        '<p class="sc-legal">' + K.CUSTODY + "</p>" +
        '<p class="sc-legal">' + K.LEGAL + "</p>" +
      "</div>";
    $("sc-x").addEventListener("click", function () { dlg.close(); });
    wireForm();
    dlg.showModal();
    txs = []; subDone = false; velDone = false;
    K.bundle().then(function (lib) {
      S = lib;
      ctx = S.init(cfg);
      return loadTerms();
    }).then(function () {
      if (!terms) return;
      setActive(1);
      return K.pickWallet(S, $("st-1-b")).then(connected);
    }).catch(function (err) { $("sc-terms").innerHTML = '<span class="sc-msg bad">' + esc(S ? S.explain(err) : err.message) + "</span>"; });
  }

  function step(n, title, body) {
    return '<section class="sc-step off" id="st-' + n + '"><h3><i>' + n + "</i>" + esc(title) + "</h3>" + body + "</section>";
  }
  function setActive(n) {
    for (var i = 1; i <= 4; i++) { var el = $("st-" + i); if (el) el.classList.toggle("off", i > n); }
  }
  function markDone(n) { var el = $("st-" + n); if (el) el.classList.add("done"); }

  function loadTerms() {
    if (!cfg.ready) {
      $("sc-terms").innerHTML = "<b>Copying isn’t switched on for this server yet.</b> " + esc((cfg.problems || []).join("; ")) + ".";
      return Promise.resolve();
    }
    return S.readPlan(ctx, agent).then(function (r) {
      if (!r.plan || !r.plan.open) {
        $("sc-terms").innerHTML = "<b>This agent’s owner hasn’t opened copying yet.</b> There’s no subscription plan for it in the follow program" +
          (r.plan ? " (its plan is closed)" : "") + ". Its record stays public either way.";
        return;
      }
      terms = r;
      var price = K.money(r.plan.price), fee = K.bps(r.plan.perfFeeBps);
      $("sc-terms").innerHTML = "<b>" + esc(price) + " USDC a month</b>" +
        (Number(r.plan.perfFeeBps) ? ", plus a <b>" + esc(fee) + " performance fee</b> on copied profit above your previous peak" : "") +
        ". Each payment is split between the agent’s owner and Reins (" + esc(K.bps(r.config.reinsBps)) + " to Reins) in the same transaction. " +
        "The subscription is fixed at these terms: if the owner raises them before your transaction lands, it’s refused.";
      updateTotal();
    });
  }

  // ------------------------------------------------------------------ step 1: wallet
  function connected(w) {
    W = w;
    $("st-1-b").innerHTML = '<p>Connected: <b class="mono">' + esc(K.short(w.publicKey.toBase58())) + "</b> (" + esc(w.name) + "). Set the wallet to devnet.</p>";
    markDone(1);
    setActive(2);
    return Promise.all([readVel(), S.readFollow(ctx, terms.planAddress, W.publicKey)]).then(function (r) {
      var f = r[1];
      if (f && f.active && f.paidUntil > Date.now() / 1000) {
        $("st-4-msg").innerHTML = '<div class="sc-msg">You already copy this agent, paid until <b>' + esc(C.stamp(f.paidUntil)) + "</b>. Subscribing again adds months. " +
          'Manage it on <a href="/arena-following">Following</a>.</div>';
      }
    });
  }

  // ------------------------------------------------------------------ step 2: Velocity
  function readVel() {
    $("st-2-b").innerHTML = "<p>Reading your Velocity accounts…</p>";
    return S.readVelocity(ctx, W.publicKey).then(function (v) {
      vel = v;
      drawVel();
    }).catch(function (err) { $("st-2-b").innerHTML = '<div class="sc-msg bad">' + esc(S.explain(err)) + "</div>"; });
  }
  function drawVel() {
    var p = vel.plan, k = p.subAccountId;
    if (!vel.programLive) {
      $("st-2-b").innerHTML = '<div class="sc-msg bad">Velocity’s program isn’t answering on this cluster right now, so a copy account can’t be set up. Try again later.</div>';
      return;
    }
    var userAddr = S.velocity.userAddress(W.publicKey, k, ctx.velocityProgram);
    if (!p.setDelegate) {
      velDone = true;
      $("st-2-b").innerHTML = "<p>Your subaccount <b>#" + esc(k) + "</b> (" + K.addressLink(S, userAddr, cfg.cluster) + ") already has Reins’ copier as its delegate. Nothing to do.</p>" + depositHtml();
      markDone(2); setActive(3); wireDeposit(); checkReady();
      return;
    }
    var will = [];
    if (p.createStats) will.push("open your Velocity account (its stats account)");
    if (p.createMain) will.push("create your main subaccount #0, which Velocity needs first");
    will.push("create a dedicated copy subaccount <b>#" + esc(k) + "</b>, named “Reins copy”");
    will.push("make Reins’ copier (" + K.addressLink(S, ctx.copier, cfg.cluster) + ") its delegate: it can trade there, never withdraw");
    $("st-2-b").innerHTML = "<p>One transaction will:</p><p>" + will.map(function (w, i) { return (i + 1) + ". " + w; }).join("<br>") + "</p>" +
      "<p>Copied trades stay apart from anything else you hold on Velocity, so their profit and loss are measured on their own. Rent is about 0.035 devnet SOL per account.</p>" +
      '<div class="sc-acts"><button type="button" class="btn-white" id="sc-vel">Set up the copy account</button></div><div id="st-2-msg"></div>';
    $("sc-vel").addEventListener("click", function () {
      var b = $("sc-vel");
      b.disabled = true; b.textContent = "Confirm in your wallet…";
      run(S.velocitySetupIxs(ctx, W.publicKey, vel), "Velocity: copy subaccount and delegate", "st-2-msg").then(function () {
        return readVel();
      }).catch(function () { b.disabled = false; b.textContent = "Set up the copy account"; });
    });
  }
  function depositHtml() {
    return '<details class="sc-p"><summary>Add collateral now (optional)</summary>' +
      "<p>The copy subaccount trades with its own collateral, " + esc(cfg.quote.symbol) + " on Velocity devnet (not the USDC you subscribe with). " +
      "Get test " + esc(cfg.quote.symbol) + " from Velocity’s devnet faucet, then deposit it here or on Velocity.</p>" +
      '<div class="sc-grid"><label class="sc-f">Amount (' + esc(cfg.quote.symbol) + ')<input id="sc-dep-amt" inputmode="decimal" placeholder="100"></label>' +
      '<div class="sc-f"><span>&nbsp;</span><button type="button" class="chip" id="sc-dep">Deposit</button></div></div><div id="st-2-dep"></div></details>';
  }
  function wireDeposit() {
    var b = $("sc-dep");
    if (!b) return;
    b.addEventListener("click", function () {
      var units = S.follow.toUnits($("sc-dep-amt").value, cfg.quote.decimals);
      if (!units || units <= 0n) { $("st-2-dep").innerHTML = '<div class="sc-msg bad">Enter an amount.</div>'; return; }
      var k = vel.plan.subAccountId, has = vel.users[k];
      if (has && has.perpPositions.length) { $("st-2-dep").innerHTML = '<div class="sc-msg">This subaccount has open positions: deposit on Velocity instead.</div>'; return; }
      b.disabled = true;
      S.depositIxs(ctx, W.publicKey, k, units).then(function (ixs) {
        return run(ixs, "Velocity: deposit " + S.follow.fromUnits(units, cfg.quote.decimals) + " " + cfg.quote.symbol, "st-2-dep");
      }).catch(function (err) { $("st-2-dep").innerHTML = '<div class="sc-msg bad">' + esc(S.explain(err)) + "</div>"; }).then(function () { b.disabled = false; });
    });
  }

  // ------------------------------------------------------------------ step 3: size and limits
  function form() {
    return '<div id="st-3-b"><p>The copier checks these before every order. Amounts are in US dollars (' + esc(cfg && cfg.quote ? cfg.quote.symbol : "dUSDT") + " on Velocity devnet).</p>" +
      '<div class="sc-grid">' +
        '<div class="sc-f full"><span>Size of each copied trade</span><div class="sc-seg" role="group" aria-label="Size">' +
          '<button type="button" data-mode="fixed" aria-pressed="true">Fixed amount</button><button type="button" data-mode="percent" aria-pressed="false">% of the copy account</button></div></div>' +
        '<label class="sc-f" id="f-usd">Amount per trade ($)<input id="sc-size-usd" inputmode="decimal" value="25"></label>' +
        '<label class="sc-f" id="f-pct" hidden>Percent of the copy account (%)<input id="sc-size-pct" inputmode="decimal" value="5"></label>' +
        '<label class="sc-f">Maximum size per trade ($)<input id="sc-max" inputmode="decimal" value="100"></label>' +
        '<label class="sc-f">Open copied positions at most<select id="sc-open">' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) { return "<option" + (n === 3 ? " selected" : "") + ">" + n + "</option>"; }).join("") + "</select></label>" +
        '<label class="sc-f">Daily loss cap ($)<small>copying pauses for the day once hit</small><input id="sc-loss" inputmode="decimal" value="50"></label>' +
        '<label class="sc-f">Months<select id="sc-months">' + [1, 2, 3, 6, 12].map(function (n) { return "<option>" + n + "</option>"; }).join("") + "</select></label>" +
        '<label class="sc-f">Performance-fee allowance (USDC, optional)<small>the most the fee can ever take; 0 for none</small><input id="sc-allow" inputmode="decimal" value="0"></label>' +
      '</div><div id="st-3-msg"></div></div>';
  }
  var mode = "fixed";
  function wireForm() {
    dlg.querySelectorAll(".sc-seg button").forEach(function (b) {
      b.addEventListener("click", function () {
        mode = b.getAttribute("data-mode");
        dlg.querySelectorAll(".sc-seg button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        $("f-usd").hidden = mode !== "fixed"; $("f-pct").hidden = mode === "fixed";
        checkReady();
      });
    });
    ["sc-size-usd", "sc-size-pct", "sc-max", "sc-open", "sc-loss", "sc-months", "sc-allow"].forEach(function (id) {
      $(id).addEventListener("input", function () { updateTotal(); checkReady(); });
    });
    $("sc-sub").addEventListener("click", subscribe);
  }
  function settings() {
    return S.follow.settingsFromForm({
      sizeMode: mode, sizeUsd: $("sc-size-usd").value, sizePercent: $("sc-size-pct").value, maxTradeUsd: $("sc-max").value,
      maxOpen: $("sc-open").value, dailyLossUsd: $("sc-loss").value, subAccountId: vel ? vel.plan.subAccountId : 0,
    }, cfg.quote.decimals);
  }
  function updateTotal() {
    if (!terms || !$("st-4-b")) return;
    var months = Number($("sc-months").value), total = BigInt(terms.plan.price) * BigInt(months);
    $("st-4-b").querySelector("p").innerHTML = "One transaction from your wallet: <b>" + esc(K.money(total)) + " USDC</b> for " + months + " month" + (months > 1 ? "s" : "") +
      ", and the performance-fee allowance if you set one. A token account holds one allowance at a time, so setting one here replaces any earlier allowance on your USDC account.";
  }
  function checkReady() {
    if (!S || !$("sc-sub")) return;
    var problems = vel ? S.follow.settingsProblems(settings()) : [];
    var allow = S.follow.toUnits($("sc-allow").value || "0", 6);
    if (allow == null) problems.push("the allowance must be a number (0 for none)");
    $("st-3-msg").innerHTML = problems.length && velDone ? '<div class="sc-msg bad">Fix: ' + esc(problems.join("; ")) + ".</div>" : "";
    $("sc-sub").disabled = !(W && terms && velDone && !problems.length) || subDone;
    if (velDone) setActive(problems.length ? 3 : 4);
  }

  // ------------------------------------------------------------------ step 4: subscribe
  function subscribe() {
    var b = $("sc-sub"), s = settings(), months = Number($("sc-months").value);
    var allow = S.follow.toUnits($("sc-allow").value || "0", 6) || 0n;
    b.disabled = true; b.textContent = "Confirm in your wallet…";
    var mint = terms.config.mint, ata = S.follow.associatedTokenAddress(W.publicKey, mint), need = BigInt(terms.plan.price) * BigInt(months);
    ctx.connection.getTokenAccountBalance(ata, "confirmed").then(function (r) { return BigInt(r.value.amount); }, function () { return 0n; }).then(function (have) {
      if (have < need) {
        throw new Error("Your USDC account has " + K.money(have) + " USDC; this needs " + K.money(need) + ". Get devnet USDC from faucet.circle.com (Solana devnet), then try again.");
      }
      var ixs = S.subscribeIxs(ctx, { follower: W.publicKey, agent: agent, config: terms.config, plan: terms.plan, months: months, settings: s, perfAllowance: allow });
      return run(ixs, "Follow program: subscribe" + (allow > 0n ? " + fee allowance" : ""), "st-4-msg");
    }).then(function () {
      subDone = true;
      markDone(3); markDone(4);
      b.textContent = "Subscribed";
      $("st-4-msg").insertAdjacentHTML("beforeend", '<div class="sc-msg ok"><b>You’re copying ' + esc(C.nameOf(record)) + ".</b> Its next prediction is placed on your copy subaccount, within your limits. " +
        'See it, change it or stop on <a href="/arena-following">Following</a>.</div>');
    }).catch(function (err) {
      b.disabled = false; b.textContent = "Subscribe";
      if (!/^\s*$/.test(err.message || "") && !err.shown) $("st-4-msg").innerHTML = '<div class="sc-msg bad">' + esc(S.explain(err)) + "</div>";
    });
  }

  /** Send one transaction, list it with an Explorer link under `box`; rejects (already shown) on failure. */
  function run(ixs, label, box) {
    $(box).innerHTML = '<div class="sc-msg">Waiting for your wallet…</div>';
    return S.send(ctx.connection, W, ixs).then(function (sig) {
      txs.push({ label: label, sig: sig });
      $(box).innerHTML = '<div class="sc-msg ok">Confirmed.' + K.txList(S, [{ label: label, sig: sig }], cfg.cluster) + "</div>";
      return sig;
    }, function (err) {
      $(box).innerHTML = '<div class="sc-msg bad">' + esc(S.explain(err)) + (err.signature ? K.txList(S, [{ label: label, sig: err.signature }], cfg.cluster) : "") + "</div>";
      err.shown = true;
      throw err;
    });
  }
})();
