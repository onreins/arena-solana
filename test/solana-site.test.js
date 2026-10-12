// The Solana-only site build (scripts/solana-site.mjs), run on a copy of app/public.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("marks Arena pages as the Solana site and sends the Arc app's pages to /arena", () => {
  const dir = mkdtempSync(join(tmpdir(), "solana-site-"));
  try {
    for (const f of ["index.html", "arena.html", "arena-caller.html", "arena-following.html", "charts.html", "strategies.html"]) {
      cpSync(new URL(`../app/public/${f}`, import.meta.url), join(dir, f));
    }
    execFileSync(process.execPath, [new URL("../scripts/solana-site.mjs", import.meta.url).pathname, dir]);
    for (const f of ["arena.html", "arena-caller.html", "arena-following.html"]) {
      const html = readFileSync(join(dir, f), "utf8");
      assert.match(html, /<meta name="reins-site" content="solana">/, f);
      assert.equal(html.match(/reins-site/g).length, 1, `${f} marked once`);
    }
    for (const f of ["index.html", "charts.html", "strategies.html"]) {
      assert.match(readFileSync(join(dir, f), "utf8"), /url=\/arena/, `${f} leads to /arena`);
    }
    execFileSync(process.execPath, [new URL("../scripts/solana-site.mjs", import.meta.url).pathname, dir]); // twice: still marked once
    assert.equal(readFileSync(join(dir, "arena.html"), "utf8").match(/reins-site/g).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the frame shows only Arena on the Solana site", () => {
  const ui = readFileSync(new URL("../app/public/ui.js", import.meta.url), "utf8");
  assert.match(ui, /SOLANA_SITE \? \[/);
  assert.match(ui, /"Following", "\/arena-following"/);
});
