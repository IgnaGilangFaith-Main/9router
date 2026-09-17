// Turso (libsql) adapter for Vercel / remote DB — SYNC NATIVE.
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

    try { db.exec("PRAGMA busy_timeout = 8000"); } catch {}
    try { db.exec("PRAGMA foreign_keys = ON"); } catch {}
    try { db.exec(PRAGMA_SQL); } catch {}

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
      exec(sql) {
        db.exec(sql);
      },
      executeMultiple(stmts) {
        // Build one big SQL string, execute in single round-trip to Turso.
        // stmts: array of { sql, params } or plain strings.
        const parts = [];
        for (const s of stmts) {
          if (typeof s === "string") {
            parts.push(s.endsWith(";") ? s : s + ";");
          } else if (s && s.sql) {
            let sql = s.sql;
            if (s.params && s.params.length) {
              let idx = 0;
              sql = sql.replace(/\?/g, () => {
                const v = s.params[idx++];
                if (v === null || v === undefined) return "NULL";
                if (typeof v === "number") return String(v);
                return "'" + String(v).replace(/'/g, "''") + "'";
              });
            }
            parts.push(sql.endsWith(";") ? sql : sql + ";");
          }
        }
        db.exec(parts.join("\n"));
      },
      transaction(fn) {
        return db.transaction(fn)();
      },
      checkpoint() {},
      close() { try { db.close(); } catch {} },
      raw: db,
    };
  } catch (e) {
    console.warn("[DB] Turso (sync) connection failed, falling through:", e.message);
    return null;
  }
}
