// backups.js: daily rotating backups. Pure helpers, no server needed.
const fs = require('node:fs');
const path = require('node:path');

const NAME = /^marks-(\d{4}-\d{2}-\d{2})\.db$/;
// The LOCAL calendar day: the nightly job is scheduled in local time, so a UTC name would label it with yesterday.
const pad = n => String(n).padStart(2, '0');
const backupName = (date = new Date()) => `marks-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.db`;

// The one crash-safe way to write a backup: copy to <dest>.part, then rename over <dest>. A crash, a full disk or an
// early exit can never leave a half-written file under the real name; on failure any old <dest> is kept untouched.
async function backupTo(db, dest) {
  const part = dest + '.part';
  try {
    await db.backup(part);
    fs.renameSync(part, dest);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
}

// Keep the newest `keep` dated backups. Anything else in the folder (manual copies, notes) is never touched.
function prune(dir, keep) {
  const dated = fs.readdirSync(dir).filter(f => NAME.test(f)).sort().reverse();
  const gone = dated.slice(keep);
  for (const f of gone) fs.rmSync(path.join(dir, f));
  return gone;
}

// One backup per local calendar day, written with backupTo so it is never half-written.
async function backupOnce(db, dir, { keep = 14, date = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, backupName(date));
  if (fs.existsSync(dest)) return { dest, skipped: true };
  await backupTo(db, dest);
  prune(dir, keep);
  return { dest, skipped: false };
}

function latestBackup(dir) {
  try {
    const dated = fs.readdirSync(dir).filter(f => NAME.test(f)).sort();
    return dated.length ? NAME.exec(dated[dated.length - 1])[1] : null;
  } catch { return null; }
}

module.exports = { backupName, prune, backupTo, backupOnce, latestBackup };
