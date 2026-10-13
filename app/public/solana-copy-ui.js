/* Shared by the Copy flow (callbook-copy.js) and the Following page
   (callbook-following.js), Solana mode only: the server's copy config, the
   bundle (vendor/solana-copy.js, built from app/client/solana-copy.js), the
   wallet picker, explorer links and the plain-words disclosures. */
(function () {
  "use strict";
  var U = window.ReinsUI, esc = U.esc;

  var cfgOnce = null;
  /** GET /api/callbook/solana-config, or null when this server isn't in Solana mode. */
  function config() {
    return (cfgOnce = cfgOnce || fetch("/api/callbook/solana-config", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }));
  }

  var bundleOnce = null;
  /** The copy bundle, loaded on first use: window.ReinsSolanaCopy. */
  function bundle() {
    if (window.ReinsSolanaCopy) return Promise.resolve(window.ReinsSolanaCopy);
    return (bundleOnce = bundleOnce || new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/vendor/solana-copy.js";
      s.onload = function () { window.ReinsSolanaCopy ? resolve(window.ReinsSolanaCopy) : reject(new Error("The copy tools didn't load.")); };
      s.onerror = function () { bundleOnce = null; reject(new Error("The copy tools didn't load. Check your connection and try again.")); };
      document.head.appendChild(s);
    }));
  }

  var LAST = "reins.solana.wallet";
  var lastWallet = function () { try { return localStorage.getItem(LAST); } catch (e) { return null; } };
  var rememberWallet = function (name) { try { localStorage.setItem(LAST, name); } catch (e) { /* storage off */ } };

  /**
   * Show the wallets in `box` and resolve with a connected wallet once one is
   * picked. Wallet Standard wallets register a moment after load, so the list
   * is drawn again for a couple of seconds.
   */
  function pickWallet(S, box) {
    return new Promise(function (resolve, reject) {
      var tries = 0, timer = null, busy = false;
      function draw() {
        var list = S.wallets();
        if (!list.length) {
          box.innerHTML = '<p class="sc-p">No Solana wallet found in this browser. Install <a href="https://phantom.com" target="_blank" rel="noopener">Phantom</a>, ' +
            '<a href="https://solflare.com" target="_blank" rel="noopener">Solflare</a> or <a href="https://backpack.app" target="_blank" rel="noopener">Backpack</a>, set it to devnet, then reload.</p>';
        } else {
          var last = lastWallet();
          list.sort(function (a, b) { return (b.name === last) - (a.name === last); });
          box.innerHTML = '<div class="sc-wallets">' + list.map(function (w, i) {
            return '<button type="button" data-i="' + i + '">' + (w.icon && /^data:image\//.test(w.icon) ? '<img src="' + esc(w.icon) + '" alt="">' : U.icon("agent")) + esc(w.name) + "</button>";
          }).join("") + "</div>";
          box.querySelectorAll("button[data-i]").forEach(function (b) {
            b.addEventListener("click", function () {
              if (busy) return;
              busy = true;
              clearInterval(timer);
              var w = list[+b.getAttribute("data-i")];
              b.textContent = "Connecting…";
              S.connect(w).then(function (conn) { rememberWallet(w.name); resolve(conn); }).catch(function (err) {
                busy = false;
                box.insertAdjacentHTML("beforeend", '<div class="sc-msg bad">' + esc(S.explain(err)) + "</div>");
                draw();
              });
            });
          });
        }
      }
      draw();
      timer = setInterval(function () { if (++tries > 6) clearInterval(timer); else if (!busy) draw(); }, 400);
      void reject;
    });
  }

  /** Units (BigInt or number, 10^-decimals) as "12.50". */
  function money(units, decimals) {
    var d = decimals == null ? 6 : decimals, v = Number(units) / Math.pow(10, d);
    return isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  }
  function bps(n) { return (Number(n) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "%"; }
  function short(k) { k = String(k); return k.length > 12 ? k.slice(0, 4) + "…" + k.slice(-4) : k; }

  /** A list of transactions with Solana Explorer links: [{ label, sig }]. */
  function txList(S, txs, cluster) {
    if (!txs.length) return "";
    return '<ul class="sc-txs">' + txs.map(function (t) {
      return "<li>" + esc(t.label) + ': <a class="mono" href="' + esc(S.explorerTx(t.sig, cluster)) + '" target="_blank" rel="noopener">' + esc(short(t.sig)) + "</a></li>";
    }).join("") + "</ul>";
  }
  function addressLink(S, addr, cluster, label) {
    return '<a class="mono" href="' + esc(S.explorerAddress(String(addr), cluster)) + '" target="_blank" rel="noopener">' + esc(label || short(addr)) + "</a>";
  }

  // The disclosures (docs/ARENA-MESSAGING.md guardrails; README, "Reins on Solana").
  var CUSTODY = "<b>Your money stays in your own Velocity account.</b> Reins’ copier becomes the delegate of one copy subaccount: it can place and cancel orders there, " +
    "and Velocity’s program stops it from ever withdrawing. You can revoke it any time, here or on Velocity itself. A delegate can still trade an account into a loss, which is why you set the limits.";
  var LEGAL = "<b>Devnet only:</b> test tokens, no real money. A score describes past predictions, not future results. Nothing here is investment advice. " +
    "Charging subscription and performance fees for trade signals may be regulated in some countries; that must be checked before any of this runs on mainnet.";

  window.ReinsCopyUI = {
    config: config, bundle: bundle, pickWallet: pickWallet, money: money, bps: bps, short: short, txList: txList, addressLink: addressLink,
    CUSTODY: CUSTODY, LEGAL: LEGAL,
  };
})();
