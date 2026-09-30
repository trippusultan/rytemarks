// backup.js — `npm run backup [dest.db]`. SQLite online backup: safe while the server is running.
// Same crash-safe write as the daily job (.part then rename) and the same local-date name, so a manual backup
// counts as today's backup and the home page "Last backup" line sees it.
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { backupName, backupTo } = require('./backups');

const src = process.env.MARKS_DB || path.join(__dirname, 'marks.db');
const dest = process.argv[2] || path.join(__dirname, 'backups', backupName());
const db = new Database(src, { fileMustExist: true });
fs.mkdirSync(path.dirname(dest), { recursive: true });
backupTo(db, dest)
  .then(() => { console.log('backup written:', dest); db.close(); })
  .catch(e => { console.error(e.message); process.exit(1); });
