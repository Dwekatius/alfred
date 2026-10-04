// Consistent SQLite backup using the backup API, invoked by scripts/backup.ps1.
import { DatabaseSync } from "node:sqlite";

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error("usage: node backup-db.mjs <source.sqlite> <target.sqlite>");
  process.exit(2);
}
const db = new DatabaseSync(source);
try {
  db.exec("PRAGMA busy_timeout = 5000;");
  const escaped = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
} finally {
  db.close();
}
console.log(`database backed up to ${target}`);
