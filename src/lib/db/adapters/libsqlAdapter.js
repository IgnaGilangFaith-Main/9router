// Turso (libsql) adapter for Vercel / remote DB.
// Uses sql.js (sync) for in-process ops + @libsql/client (async) for Turso persistence.
// On init: fetches schema + data from Turso → loads into sql.js in-memory.
// On write: executes in sql.js (sync) + fire-and-forget to Turso.
// This lets the rest of the codebase call db.get/run/all synchronously.
import initSqlJs from "sql.js";

export async function createLibsqlAdapter() {
  const dbUrl = process.env.DATABASE_URL;
  const dbToken = process.env.DATABASE_TOKEN;
  if (!dbUrl || !dbToken) return null;

  let turso;
  try {
    const { createClient } = await import("@libsql/client");
    turso = createClient({ url: dbUrl, authToken: dbToken });
    await turso.execute("SELECT 1");
    console.log("[DB] Turso connected:", dbUrl.replace(/\?.*$/, ""));
  } catch (e) {
    console.warn("[DB] Turso connection failed, falling through:", e.message);
    return null;
  }

  const SQL = await initSqlJs();
  const memDb = new SQL.Database();

  // ── Sync schema + data from Turso → sql.js ──────────────────────────
  await _syncFromTurso(turso, memDb);

  // ── Fire-and-forget helper (async, non-blocking) ────────────────────
  function _flush(sql, params) {
    turso.execute({ sql, args: params || [] }).catch((e) => {
      console.error("[DB] Turso write failed:", e.message);
    });
  }

  function _flushRaw(sql) {
    turso.execute(sql).catch((e) => {
      console.error("[DB] Turso exec failed:", e.message);
    });
  }

  // ── Adapter interface (sync, matches better-sqlite3 / sql.js) ──────
  function run(sql, params = []) {
    const stmt = memDb.prepare(sql);
    try {
      stmt.bind(params.length ? params : undefined);
      stmt.step();
      const changes = memDb.getRowsModified();
      const li = memDb.exec("SELECT last_insert_rowid() as id");
      const lastInsertRowid = li[0]?.values?.[0]?.[0] ?? null;
      _flush(sql, params);
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const stmt = memDb.prepare(sql);
    try {
      stmt.bind(params.length ? params : undefined);
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = memDb.prepare(sql);
    try {
      stmt.bind(params.length ? params : undefined);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function exec(sql) {
    memDb.exec(sql);
    _flushRaw(sql);
  }

  function transaction(fn) {
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    memDb.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      memDb.exec(`RELEASE ${sp}`);
      _flushRaw(`RELEASE ${sp}`);
      return result;
    } catch (e) {
      try { memDb.exec(`ROLLBACK TO ${sp}`); memDb.exec(`RELEASE ${sp}`); } catch {}
      throw e;
    }
  }

  function checkpoint() {}
  function close() { memDb.close(); }

  return {
    driver: "libsql",
    run, get, all, exec, transaction, checkpoint, close,
    raw: memDb,
  };
}

// ── Sync Turso → sql.js ──────────────────────────────────────────────
async function _syncFromTurso(turso, memDb) {
  try {
    // 1. Get DDL for all tables + indexes
    const masters = await turso.execute(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index')"
    );
    const tables = [];
    for (const row of masters.rows) {
      try {
        memDb.exec(row.sql);
      } catch { /* may already exist */ }
      if (row.type === "table" && row.name !== "sqlite_sequence") {
        tables.push(row.name);
      }
    }

    // 2. Copy data from each table
    let totalRows = 0;
    for (const tableName of tables) {
      try {
        const data = await turso.execute(`SELECT * FROM \`${tableName}\``);
        if (!data.rows.length) continue;
        const cols = data.columns;
        const placeholders = cols.map(() => "?").join(", ");
        const insertSql = `INSERT OR REPLACE INTO \`${tableName}\`(${cols.join(", ")}) VALUES(${placeholders})`;
        for (const row of data.rows) {
          const values = cols.map((c) => {
            const v = row[c];
            return typeof v === "bigint" ? Number(v) : v;
          });
          try {
            const stmt = memDb.prepare(insertSql);
            stmt.bind(values);
            stmt.step();
            stmt.free();
            totalRows++;
          } catch (e) {
            console.warn(`[DB] sync row ${tableName}: ${e.message}`);
          }
        }
      } catch { /* empty table or missing */ }
    }
    console.log(`[DB] Turso → sql.js: ${tables.length} tables, ${totalRows} rows`);
  } catch (e) {
    console.warn("[DB] Turso sync failed:", e.message);
  }
}
