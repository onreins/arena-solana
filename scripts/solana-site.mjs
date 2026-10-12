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

let marked = 0, redirected = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".html"))) {
  const name = f.replace(/\.html$/, "");
  if (ARC_PAGES.includes(name)) {
    writeFileSync(join(dir, f), redirect("/arena"));
    redirected++;
    continue;
  }
  const html = readFileSync(join(dir, f), "utf8");
  if (html.includes(META)) continue;
  writeFileSync(join(dir, f), html.replace(/<head([^>]*)>/i, `<head$1>\n  ${META}`));
  marked++;
}
console.log(`solana site: ${marked} page(s) marked, ${redirected} Arc page(s) now lead to /arena`);
