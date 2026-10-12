/**
 * A sealed box for a call's preimage, so a copier can trade a followed agent's
 * call at lock time without anyone else learning it before the reveal.
 *
 *   const box = seal(preimage, copierPublicKey);   // the agent's SDK, after a lock
 *   const preimage = open(box, copierPrivateKey);  // the copier, before trading
 *
 * Ephemeral X25519 ECDH with the recipient's key, HKDF-SHA256 (salt = the
 * ephemeral public key then the recipient's, info "arena.preimage.v1") to one
 * AES-256-GCM key, and a random 12-byte nonce. The header (version, algorithm,
 * ephemeral key) is the GCM associated data, so changing any byte of the box
 * makes open() throw. A fresh ephemeral key per box means the agent keeps no
 * key, and two boxes of the same preimage look unrelated.
 *
 * Keys are the 32 raw X25519 bytes, as a Buffer/Uint8Array or base64 (or a
 * node KeyObject). The box is a small JSON object of base64 strings; open()
 * also takes it as a JSON string.
 *
 * The copier must still check the opened preimage against the on-chain lock
 * hash (solana/arena.js callHash) before trading: the box proves nothing about
 * who sealed it.
 *
 * preimage = { program, book, owner, callId, coin, side, horizon, salt, exits? }
 */
import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, KeyObject,
} from "node:crypto";

export const INFO = "arena.preimage.v1";
export const ALG = "x25519-hkdf-sha256-aes256gcm";
const VERSION = 1;

// DER wrappers for raw X25519 keys (RFC 8410).
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

function raw32(key, what) {
  const b = typeof key === "string" ? Buffer.from(key, "base64") : Buffer.from(key ?? []);
  if (b.length !== 32) throw new Error(`An X25519 ${what} key is 32 raw bytes (base64 of 32 bytes).`);
  return b;
}

function publicKeyObject(key) {
  if (key instanceof KeyObject) return key.type === "public" ? key : createPublicKey(key);
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw32(key, "public")]), format: "der", type: "spki" });
}

function privateKeyObject(key) {
  if (key instanceof KeyObject) {
    if (key.type !== "private") throw new Error("Opening a box needs the recipient's private key.");
    return key;
  }
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw32(key, "private")]), format: "der", type: "pkcs8" });
}

/** The 32 raw bytes of an X25519 public KeyObject. */
const rawPublic = (k) => k.export({ format: "der", type: "spki" }).subarray(-32);

/** A recipient key pair (e.g. the copier's): { publicKey, privateKey } as base64 of the 32 raw bytes. */
export function generateRecipientKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: rawPublic(publicKey).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64"),
  };
}

const header = (epk) => Buffer.concat([Buffer.from(`${INFO}|${ALG}|${VERSION}|`), epk]);

function keyFor(shared, epk, rpk) {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, rpk]), Buffer.from(INFO), 32));
}

const FIELDS = ["program", "book", "owner", "callId", "coin", "side", "horizon", "salt"];

/** Seal `preimage` (a JSON-able object) to `recipientPublicKey`. Returns { v, alg, epk, iv, ct, tag }. */
export function seal(preimage, recipientPublicKey) {
  if (!preimage || typeof preimage !== "object") throw new Error("A preimage is an object.");
  for (const f of FIELDS) if (preimage[f] == null) throw new Error(`A preimage needs ${f}.`);
  const recipient = publicKeyObject(recipientPublicKey);
  const rpk = rawPublic(recipient);
  const eph = generateKeyPairSync("x25519");
  const epk = rawPublic(eph.publicKey);
  const key = keyFor(diffieHellman({ privateKey: eph.privateKey, publicKey: recipient }), epk, rpk);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header(epk));
  const ct = Buffer.concat([cipher.update(JSON.stringify(preimage), "utf8"), cipher.final()]);
  return { v: VERSION, alg: ALG, epk: epk.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

/** Open a box with the recipient's private key. Throws if it was altered or isn't for this key. */
export function open(box, recipientPrivateKey) {
  const b = typeof box === "string" ? JSON.parse(box) : box;
  if (!b || b.v !== VERSION || b.alg !== ALG) throw new Error("Not an arena.preimage.v1 box.");
  const epk = raw32(b.epk, "ephemeral public");
  const iv = Buffer.from(String(b.iv), "base64");
  const tag = Buffer.from(String(b.tag), "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("A damaged box.");
  const priv = privateKeyObject(recipientPrivateKey);
  const rpk = rawPublic(createPublicKey(priv));
  const key = keyFor(diffieHellman({ privateKey: priv, publicKey: publicKeyObject(epk) }), epk, rpk);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(header(epk));
  decipher.setAuthTag(tag);
  let text;
  try {
    text = Buffer.concat([decipher.update(Buffer.from(String(b.ct), "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("The box doesn't open with this key, or it was altered.");
  }
  return JSON.parse(text);
}
