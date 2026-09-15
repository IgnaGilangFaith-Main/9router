// Turso (libsql) adapter for Vercel / remote DB — SYNC NATIVE.
//
// Uses `libsql` (better-sqlite3-compatible native binding, sync API) pointed
// directly at the remote Turso URL. Every db.get()/db.run()/db.all()/
// db.transaction() call round-trips synchronously to Turso — no in-memory
// mirror, no async queue, no fire-and-forget. This is the ONLY adapter that
// truly persists under Vercel serverless (cold starts, frozen lambdas, no
// background process).
//
// API contract: identical to better-sqlite3 (prepare/get/all/run, exec,
// transaction, close).
import Database from "libsql";

import { PRAGMA_SQL } from "../schema.js";

export async function createLibsqlAdapter() {
  const dbUrl = process.env.DATABASE_URL;
  const dbToken = process.env.DATABASE_TOKEN;
  if (!dbUrl) return null;
  if (!dbUrl.startsWith("file:") && !dbToken) return null;

  try {
    const opts = dbUrl.startsWith("file:") ? {} : { authToken: dbToken };
    const db = new Database(dbUrl, opts);

    // PRAGMA tuning that's safe for remote (no WAL on server side; skip journal_mode)
    try { db.exec("PRAGMA busy_timeout = 8000"); } catch {}
    try { db.exec("PRAGMA foreign_keys = ON"); } catch {}
    try { db.exec(PRAGMA_SQL); } catch { /* remote may reject some pragmas; ignore */ }

    console.log("[DB] Turso connected (sync):", dbUrl.replace(/\?.*$/, ""));
    return {
      driver: "libsql",
      run(sql, params = []) {
        return db.prepare(sql).run(...params);
      },
      get(sql, params = []) {
        return db.prepare(sql).get(...params);
      },
      all(sql, params = []) {
        return db.prepare(sql).all(...params);
      },
      exec(sql) { db.exec(sql); },
      transaction(fn) { return db.transaction(fn)(); },
      checkpoint() {},
      close() { try { db.close(); } catch {} },
      raw: db,
    };
  } catch (e) {
    console.warn("[DB] Turso (sync) connection failed, falling through:", e.message);
    return null;
  }
}