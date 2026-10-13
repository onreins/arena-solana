/**
 * Turn the built site into the Solana-only one: run after `npm run build` in
 * the Solana Vercel project (Build Command: npm run build && node scripts/solana-site.mjs).
 *
 * Every page gets <meta name="reins-site" content="solana">, so the frame
 * (app/public/ui.js) shows only Arena and Solana's explorer; the home page and
 * the Arc app's own pages send visitors to the Solana Arena. Nothing changes
 * unless this script runs, so the Arc site is untouched.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The built site, edited in place (on the build machine); a test passes a copy.
const dir = process.argv[2] || fileURLToPath(new URL("../app/public/", import.meta.url));
const META = '<meta name="reins-site" content="solana">';
/** Pages that belong to the Arc app, not to Arena: on the Solana site they lead to Arena. */
export const ARC_PAGES = ["index", "strategies", "strategy", "chat", "charts", "create", "mandate", "smart-money", "arena-marketplace"];
const redirect = (to) => `<!doctype html><html lang="en"><head><meta charset="utf-8">${META}<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Reins Arena on Solana</title><meta http-equiv="refresh" content="0; url=${to}"><link rel="canonical" href="${to}"></head>` +
  `<body><p><a href="${to}">Reins Arena on Solana</a></p><script>location.replace(${JSON.stringify(to)})</script></body></html>\n`;

/**
 * Arc wording a page shows before its data loads, and its Solana version. The
 * page scripts swap some of it once the API answers; writing it here means a
 * visitor never sees Arc on the Solana site, even while loading.
 */
export const SOLANA_TEXT = {
  "arena.html": [
    ["It lives in an open registry on Arc (ERC-8004), not in our database.",
      "It lives on Solana, in Score accounts any program can read, not in our database."],
    ["send predictions straight to the Arena contract on Arc,",
      "send predictions straight to the Arena program on Solana,"],
    ["Arena runs on Arc testnet today, with mainnet next. Predictions, reveals and scores are real transactions you can open on the Arc explorer.",
      "Arena runs on Solana devnet today, with mainnet next. Predictions, reveals and scores are real transactions you can open on Solana Explorer."],
    ['<span id="feed-t">On Arc, as it happens</span>', '<span id="feed-t">On Solana, as it happens</span>'],
  ],
};

let marked = 0, redirected = 0, reworded = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".html"))) {
  const name = f.replace(/\.html$/, "");
  if (ARC_PAGES.includes(name)) {
    writeFileSync(join(dir, f), redirect("/arena"));
    redirected++;
    continue;
  }
  let html = readFileSync(join(dir, f), "utf8");
  for (const [arc, solana] of SOLANA_TEXT[f] ?? []) {
    if (html.includes(arc)) { html = html.replace(arc, solana); reworded++; }
    else if (!html.includes(solana)) throw new Error(`solana site: ${f} no longer has "${arc}"; update SOLANA_TEXT`);
  }
  if (!html.includes(META)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>\n  ${META}`);
    marked++;
  }
  writeFileSync(join(dir, f), html);
}
console.log(`solana site: ${marked} page(s) marked, ${reworded} Arc phrase(s) reworded, ${redirected} Arc page(s) now lead to /arena`);
