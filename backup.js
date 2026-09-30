// backup.js — `npm run backup [dest.db]`. SQLite online backup: safe while the server is running.
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const src = process.env.MARKS_DB || path.join(__dirname, 'marks.db');
const dest = process.argv[2] || path.join(__dirname, 'backups', `marks-${new Date().toISOString().slice(0, 10)}.db`);
const db = new Database(src, { fileMustExist: true });
fs.mkdirSync(path.dirname(dest), { recursive: true });
db.backup(dest)
  .then(() => { console.log('backup written:', dest); db.close(); })
  .catch(e => { console.error(e.message); process.exit(1); });
