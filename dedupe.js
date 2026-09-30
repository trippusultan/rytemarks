// dedupe.js: merge bookmarks whose URLs differ only by tracking params, #fragments or trailing slashes.
//   node dedupe.js            dry run: shows what would change
//   node dedupe.js --apply    takes a backup first, then merges
const { normalizeUrl } = require('./urls');

const canon = u => { try { return normalizeUrl(u); } catch { return u; } };

// Groups by canonical URL; the oldest bookmark (then lowest id) is kept. Rows that are alone but not yet canonical are "tidied".
function plan(db) {
  const groups = new Map();
  for (const r of db.prepare('SELECT id, url FROM bookmarks ORDER BY saved_at, id').all()) {
    const k = canon(r.url);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups].filter(([k, g]) => g.length > 1 || g[0].url !== k)
    .map(([url, g]) => ({ url, keep: g[0].id, drop: g.slice(1).map(r => r.id), rename: g[0].url !== url }));
}

const apply = db => db.transaction(() => {
  let merged = 0;
  for (const p of plan(db)) {
    const all = [p.keep, ...p.drop], marks = all.map(() => '?').join(',');
    const rows = all.map(id => db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id));
    const tags = db.prepare(`SELECT DISTINCT tag FROM bookmark_tags WHERE bookmark_id IN (${marks})`).all(...all).map(r => r.tag);
    const first = f => rows.map(r => r[f]).find(Boolean) || '';
    const longest = f => rows.map(r => r[f]).filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
    const note = [...new Set(rows.map(r => r.note).filter(Boolean))].join('\n\n');
    // delete the duplicates first: the kept row is about to take the canonical url, which is UNIQUE
    for (const id of p.drop) db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id); // tags cascade
    db.prepare('UPDATE bookmarks SET url = ?, title = ?, note = ?, text = ?, description = ?, image = ?, favicon = ? WHERE id = ?')
      .run(p.url, first('title'), note, longest('text'), first('description'), first('image'), first('favicon'), p.keep);
    db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id = ?').run(p.keep);
    for (const t of tags) db.prepare('INSERT INTO bookmark_tags VALUES (?, ?)').run(p.keep, t);
    merged += p.drop.length;
  }
  return merged;
})();

module.exports = { plan, apply };

if (require.main === module) {
  const path = require('node:path'), fs = require('node:fs'), Database = require('better-sqlite3');
  const src = process.env.MARKS_DB || path.join(__dirname, 'marks.db');
  const db = new Database(src, { fileMustExist: true });
  db.pragma('foreign_keys = ON');
  const p = plan(db), dupes = p.reduce((n, x) => n + x.drop.length, 0);
  console.log(`${dupes} duplicate bookmarks to merge, ${p.filter(x => !x.drop.length).length} urls to tidy.`);
  for (const x of p.slice(0, 20)) console.log(' ', x.url, x.drop.length ? `(merging ${x.drop.length + 1} into one)` : '(tidy)');
  if (p.length > 20) console.log(`  ... and ${p.length - 20} more`);
  if (!process.argv.includes('--apply')) { console.log('Dry run. Nothing changed. Re-run with --apply (a backup is taken first).'); db.close(); process.exit(0); }
  const dest = path.join(__dirname, 'backups', `marks-before-dedupe-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  db.backup(dest).then(() => { console.log('backup written:', dest); console.log('merged:', apply(db)); db.close(); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
