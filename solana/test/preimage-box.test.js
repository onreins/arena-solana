import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { seal, open, generateRecipientKeys, ALG } from "../preimage-box.js";

const PREIMAGE = {
  program: "BderjFgzJGQ6NsqNfbVmtHDhzjHP6B3ijPMGCrmNffqw",
  book: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  owner: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
  callId: 7, coin: "ETH", side: 1, horizon: 14_400,
  salt: `0x${"ab".repeat(16)}${"5afe0e17"}${"00".repeat(12)}`,
  exits: { stop: "2900", target: "3500" },
};

test("a sealed preimage opens with the recipient's key, and only that", () => {
  const keys = generateRecipientKeys();
  const box = seal(PREIMAGE, keys.publicKey);
  assert.equal(box.alg, ALG);
  assert.deepEqual(Object.keys(box).sort(), ["alg", "ct", "epk", "iv", "tag", "v"]);
  assert.ok(!JSON.stringify(box).includes("ETH"), "the box hides the call");
  assert.deepEqual(open(box, keys.privateKey), PREIMAGE);
  assert.deepEqual(open(JSON.stringify(box), Buffer.from(keys.privateKey, "base64")), PREIMAGE, "string box, raw-bytes key");
  // Two boxes of the same preimage look unrelated (fresh ephemeral key and nonce).
  const again = seal(PREIMAGE, Buffer.from(keys.publicKey, "base64"));
  assert.notEqual(again.epk, box.epk);
  assert.notEqual(again.ct, box.ct);
  // A KeyObject works too.
  const kp = generateKeyPairSync("x25519");
  assert.deepEqual(open(seal(PREIMAGE, kp.publicKey), kp.privateKey), PREIMAGE);
});

test("any change to the box is detected", () => {
  const keys = generateRecipientKeys();
  const box = seal(PREIMAGE, keys.publicKey);
  const flip = (b64, i = 0) => {
    const b = Buffer.from(b64, "base64");
    b[i] ^= 1;
    return b.toString("base64");
  };
  for (const field of ["ct", "tag", "iv", "epk"]) {
    assert.throws(() => open({ ...box, [field]: flip(box[field], 3) }, keys.privateKey), /doesn't open|damaged|altered/, field);
  }
  assert.throws(() => open({ ...box, v: 2 }, keys.privateKey), /Not an arena.preimage.v1 box/);
  assert.throws(() => open({ ...box, alg: "none" }, keys.privateKey), /Not an arena.preimage.v1 box/);
});

test("the wrong key can't open it", () => {
  const right = generateRecipientKeys(), wrong = generateRecipientKeys();
  const box = seal(PREIMAGE, right.publicKey);
  assert.throws(() => open(box, wrong.privateKey), /doesn't open with this key/);
  assert.throws(() => seal(PREIMAGE, "c2hvcnQ="), /32 raw bytes/);
  assert.throws(() => seal({ coin: "ETH" }, right.publicKey), /needs program/);
});
