// Bun runtime adapter — uses built-in bun:sqlite (native, fastest under Bun).
// Loaded only when process.versions.bun is present.
import { createClient } from "@libsql/client";

const CHECKPOINT_INTERVAL_MS = 60 * 1000;

async function createBunSqliteAdapter(filePath) {
  const dbUrl = process.env.DATABASE_URL;
  const dbToken = process.env.DATABASE_TOKEN;

  if (dbUrl && dbToken) {
    const db = createClient({
      url: dbUrl,
      authToken: dbToken,
    });

    return {
      driver: "@libsql/client",
      run(sql, params = []) {
        return db.execute(sql, params);
      },
      get(sql, params = []) {
        return db.execute(sql, params).rows[0];
      },
      all(sql, params = []) {
        return db.execute(sql, params).rows;
      },
      exec(sql) { return db.execute(sql); },
      transaction(fn) {
        return db.transaction(fn);
      },
      checkpoint() {},
      close() {},
      raw: db,
    };
  }

  // Fallback ke bun:sqlite lokal
  const { Database } = await import("bun:sqlite");
  const db = new Database(filePath, { create: true });
  db.exec(PRAGMA_SQL);

  // ... (keep existing bun:sqlite adapter code)
}
