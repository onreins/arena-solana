// The Railway launcher: secrets land in 0600 files, and a service that exits is restarted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";

import { writeSecrets, keep } from "../scripts/solana-services.mjs";

test("secrets are written 0600 in a 0700 folder; unset ones are skipped", () => {
  const files = writeSecrets({ "a.json": "[1,2,3]", "b": null });
  try {
    assert.equal(readFileSync(files["a.json"], "utf8"), "[1,2,3]");
    assert.equal(statSync(files["a.json"]).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(files["a.json"])).mode & 0o777, 0o700);
    assert.equal(files.b, undefined);
  } finally {
    rmSync(dirname(files["a.json"]), { recursive: true, force: true });
  }
});

test("a service that exits is restarted, and stop() ends it", async () => {
  let spawned = 0;
  const children = [];
  const spawnFn = () => {
    spawned++;
    const c = new EventEmitter();
    c.kill = () => {};
    children.push(c);
    return c;
  };
  const svc = keep("x", ["x.js"], {}, { log: () => {}, spawnFn, maxWaitMs: 5 });
  children[0].emit("exit", 1);
  await new Promise((r) => setTimeout(r, 50)); // the wait is capped by maxWaitMs (5 ms here)
  assert.equal(spawned, 2);
  svc.stop();
  children[1].emit("exit", 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(spawned, 2, "not restarted after stop()");
});
