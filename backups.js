// backups.js: daily rotating backups. Pure helpers, no server needed.
const fs = require('node:fs');
const path = require('node:path');

const NAME = /^marks-(\d{4}-\d{2}-\d{2})\.db$/;
const backupName = (date = new Date()) => `marks-${date.toISOString().slice(0, 10)}.db`;

// Keep the newest `keep` dated backups. Anything else in the folder (manual copies, notes) is never touched.
function prune(dir, keep) {
  const dated = fs.readdirSync(dir).filter(f => NAME.test(f)).sort().reverse();
  const gone = dated.slice(keep);
  for (const f of gone) fs.rmSync(path.join(dir, f));
  return gone;
}

// One backup per calendar day (UTC). Written to <name>.part and renamed, so a crash or a full disk can never leave
// a half-written file that looks like a valid backup.
async function backupOnce(db, dir, { keep = 14, date = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, backupName(date));
  if (fs.existsSync(dest)) return { dest, skipped: true };
  const part = dest + '.part';
  try {
    await db.backup(part);
    fs.renameSync(part, dest);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  prune(dir, keep);
  return { dest, skipped: false };
}

function latestBackup(dir) {
  try {
    const dated = fs.readdirSync(dir).filter(f => NAME.test(f)).sort();
    return dated.length ? NAME.exec(dated[dated.length - 1])[1] : null;
  } catch { return null; }
}

module.exports = { backupName, prune, backupOnce, latestBackup };
