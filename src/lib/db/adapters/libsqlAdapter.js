// Turso (libsql) adapter for Vercel / remote DB.
//
// IMPORTANT: @libsql/client is fully ASYNC (execute() returns a Promise).
// The rest of the codebase calls db.get()/db.run()/db.all() SYNCHRONOUSLY
// (157 call sites, better-sqlite3-style). We cannot await inside those calls.
//
// Strategy: sql.js in-memory DB = source of truth for sync reads/writes.
//   - On init:  pull schema + rows from Turso into sql.js (sync load).
//   - On write: apply to sql.js (sync) AND push to a serial async queue.
//   - On tx:    statements inside an active tx frame accumulate; on commit
//               they replay to Turso as ONE atomic batch; on rollback the
//               frame is discarded (matches sql.js savepoint semantics).
//
// The queue runs strictly one item at a time (prevents SQLITE_BUSY on
// file:/ URLs) and is fail-open: errors retry up to MAX_RETRIES then drop
// with a log — sync callers never see a thrown exception.
import initSqlJs from "sql.js";

const RETRY_DELAY_MS = 200;
const MAX_RETRIES = 3;

export async function createLibsqlAdapter() {
  const dbUrl = process.env.DATABASE_URL;
  const dbToken = process.env.DATABASE_TOKEN;
  if (!dbUrl) return null;
  // Token required only for remote URLs; file:/ URLs need none.
  const isRemote = !dbUrl.startsWith("file:");
  if (isRemote && !dbToken) return null;

  let turso;
  try {
    const { createClient } = await import("@libsql/client");
    turso = createClient({ url: dbUrl, authToken: dbToken });
    const res = await turso.execute("SELECT 1 AS ok");
    if (!res?.rows?.length) throw new Error("empty response");
    console.log("[DB] Turso connected:", dbUrl.replace(/\?.*$/, ""));
  } catch (e) {
    console.warn("[DB] Turso connection failed, falling through:", e.message);
    return null;
  }

  const SQL = await initSqlJs();
  const memDb = new SQL.Database();

  // Seed sql.js from existing Turso DB (empty on first run = fresh).
  await syncFromTurso(turso, memDb);

  // ── Serial async write queue (one worker; atomic batch per tx) ──────
  const queue = [];
  let flushing = false;

  async function flush() {
    if (flushing) return;
    flushing = true;
    while (queue.length) {
      const item = queue.shift();
      try {
        if (item.txBatch) {
          // Atomic replay of the whole transaction
          await turso.batch(item.txBatch.map((s) => ({ sql: s.sql, args: s.args || [] })));
        } else {
          await turso.execute({ sql: item.sql, args: item.args || [] });
        }
      } catch (e) {
        item.retries = (item.retries || 0) + 1;
        if (item.retries >= MAX_RETRIES) {
          console.error("[DB] Turso flush dropped:", (item.sql || `tx(${item.txBatch?.length})`).slice(0, 80), "->", e.message);
        } else {
          queue.unshift({ ...item, retries: item.retries });
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }
    flushing = false;
  }

  function enqueue(item) {
    queue.push(item);
    flush().catch((e) => console.error("[DB] queue worker error:", e.message));
  }

  // ── Transaction frame stack (nested-safe, rollback discards) ─────────
  const txStack = [];
  function queueStmt(sql, args) {
    const frame = txStack[txStack.length - 1];
    if (frame) { frame.stmts.push({ sql, args }); return; }
    enqueue({ sql, args });
  }

  // ── Adapter interface (sync — mirrors better-sqlite3 / sql.js) ──────
  function run(sql, params = []) {
    const stmt = memDb.prepare(sql);
    try {
      stmt.bind(params.length ? params : undefined);
      stmt.step();
      const changes = memDb.getRowsModified();
      const li = memDb.exec("SELECT last_insert_rowid() as id");
      const lastInsertRowid = li[0]?.values?.[0]?.[0] ?? null;
      queueStmt(sql, params);
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
    queueStmt(sql, []);
  }

  function transaction(fn) {
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    const frame = { stmts: [] };
    txStack.push(frame);
    memDb.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      memDb.exec(`RELEASE ${sp}`);
      txStack.pop();
      if (frame.stmts.length) enqueue({ txBatch: frame.stmts });
      return result;
    } catch (e) {
      try { memDb.exec(`ROLLBACK TO ${sp}`); memDb.exec(`RELEASE ${sp}`); } catch {}
      if (txStack[txStack.length - 1] === frame) txStack.pop();
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

// ── Pull schema + rows from Turso → sql.js ───────────────────────────
async function syncFromTurso(turso, memDb) {
  try {
    const masters = await turso.execute(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index')"
    );
    const tables = [];
    for (const row of masters.rows) {
      try { memDb.exec(row.sql); } catch {}
      if (row.type === "table" && row.name !== "sqlite_sequence") tables.push(row.name);
    }

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
      } catch {}
    }
    console.log(`[DB] Turso → sql.js: ${tables.length} tables, ${totalRows} rows`);
  } catch (e) {
    console.warn("[DB] Turso sync failed:", e.message);
  }
}