import Database from "libsql";
console.log("Database type:", typeof Database);
// remote connection URL + token
const db = new Database("file:/tmp/remote.db", { /* no auth for file */ });
console.log("instance proto:", Object.getOwnPropertyNames(Object.getPrototypeOf(db)).slice(0, 20));
// exec + prepare interface
db.exec("CREATE TABLE IF NOT EXISTS u (id INTEGER PRIMARY KEY, name TEXT)");
db.exec("INSERT INTO u (name) VALUES ('alice')");
console.log("row:", JSON.stringify(db.prepare("SELECT * FROM u WHERE id = ?").get(1)));
console.log("all:", JSON.stringify(db.prepare("SELECT * FROM u").all()));
const r = db.prepare("INSERT INTO u (name) VALUES (?)").run("bob");
console.log("run result:", JSON.stringify(r));
// transaction
db.transaction(() => {
  db.prepare("INSERT INTO u (name) VALUES (?)").run("carol");
  db.exec("UPDATE u SET name = 'ALICE' WHERE id = 1");
})();
console.log("after tx:", JSON.stringify(db.prepare("SELECT name FROM u ORDER BY id").all().map(x => x.name)));
// rollback
try {
  db.transaction(() => {
    db.exec("DELETE FROM u");
    throw new Error("boom");
  })();
} catch (e) { console.log("rollback ok:", e.message); }
console.log("after rollback count:", db.prepare("SELECT COUNT(*) AS n FROM u").get().n);