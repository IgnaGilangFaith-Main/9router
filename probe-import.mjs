process.env.DATABASE_URL = "file:/tmp/import-test.db";
process.env.DATABASE_TOKEN = "";

// Simulate what importDb does
const { createLibsqlAdapter } = await import("./src/lib/db/adapters/libsqlAdapter.js");
const db = await createLibsqlAdapter();

// Create tables first (like migrate would)
db.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS providerConnections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL, name TEXT, email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS providerNodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS proxyPools (id TEXT PRIMARY KEY, isActive INTEGER DEFAULT 1, testStatus TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS combos (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT, models TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key))`);
db.exec(`CREATE TABLE IF NOT EXISTS usageHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, provider TEXT, model TEXT, connectionId TEXT, apiKey TEXT, endpoint TEXT, promptTokens INTEGER DEFAULT 0, completionTokens INTEGER DEFAULT 0, cost REAL DEFAULT 0, status TEXT, tokens TEXT, meta TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS usageDaily (dateKey TEXT PRIMARY KEY, data TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS requestDetails (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, provider TEXT, model TEXT, connectionId TEXT, status TEXT, data TEXT NOT NULL)`);

// Insert initial data
db.run(`INSERT INTO settings(id, data) VALUES(1, '{"requireApiKey":false}') ON CONFLICT(id) DO UPDATE SET data = excluded.data`);

console.log("Before import:", db.get(`SELECT data FROM settings WHERE id=1`));

// Now simulate importDb transaction exactly as written in index.js
try {
  db.transaction(() => {
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);

    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, ['{"requireApiKey":true,"tunnelEnabled":false}']);
    db.run(`INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`, ["k1", "sk-test-key-123", "test-key", "machine1", 1, new Date().toISOString()]);
    db.run(`INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["conn1", "openai", "apikey", "my-openai", null, 1, 1, '{"apiKey":"sk-xxx"}', new Date().toISOString(), new Date().toISOString()]);
  });
  console.log("Transaction succeeded");
} catch (e) {
  console.log("Transaction FAILED:", e.message);
  console.log("Stack:", e.stack?.split('\n').slice(0,5).join('\n'));
}

console.log("After import settings:", db.get(`SELECT data FROM settings WHERE id=1`));
console.log("After import keys:", db.all(`SELECT id, key FROM apiKeys`));
console.log("After import conns:", db.all(`SELECT id, provider, name FROM providerConnections`));

db.close();
process.exit(0);
