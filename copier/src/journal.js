/**
 * The copier's journal: one row per (call, follow), written to disk before
 * anything is sent, so an order is placed at most once even across restarts.
 *
 * A row moves claimed -> signed (the exact transaction bytes kept) -> sent ->
 * confirmed | failed | expired | skipped. A signed transaction is only ever
 * re-broadcast byte for byte, which the chain dedupes by signature; a new one
 * is never signed for a row that already has one.
 *
 * Append-only JSON lines, fsync'd on every write; the newest line per key wins.
 */
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const jobKey = ({ book, callId, follow }) => `${book}:${callId}:${follow}`;

/** A journal at `path` (or in memory when path is null). */
export function openJournal(path = null) {
  const rows = new Map();
  if (path && existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        rows.set(r.key, r);
      } catch {
        // a torn last line from a crash mid-write: the row before it stands
      }
    }
  }
  if (path) mkdirSync(dirname(path), { recursive: true });

  function write(row) {
    rows.set(row.key, row);
    if (!path) return;
    appendFileSync(path, `${JSON.stringify(row)}\n`);
    const fd = openSync(path, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  return {
    get: (key) => rows.get(key) ?? null,
    /** Claim a job: true the first time for a key, false ever after. */
    claim(key, info = {}) {
      if (rows.has(key)) return false;
      write({ key, status: "claimed", at: Date.now(), ...info });
      return true;
    },
    update(key, patch) {
      const row = rows.get(key);
      if (!row) throw new Error(`no job ${key}`);
      write({ ...row, ...patch, key, updatedAt: Date.now() });
      return rows.get(key);
    },
    /** Rows a restart must look at: signed or sent but not settled. */
    unsettled: () => [...rows.values()].filter((r) => r.status === "signed" || r.status === "sent" || r.status === "claimed"),
    all: () => [...rows.values()],
  };
}
