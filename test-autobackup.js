const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { setup } = require('./test-helpers');
const { backupName, prune, backupOnce, backupTo, latestBackup } = require('./backups');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'marks-bk-test-'));
const day = n => new Date(2026, 0, n); // local midnight; day(3) = 2026-01-03 in any timezone

test('automatic backups', async t => {
  const s = await setup(t);

  await t.test('names are dated and sort by date', () => {
    assert.equal(backupName(day(5)), 'marks-2026-01-05.db');
    assert.ok(backupName(day(9)) > backupName(day(10)) === false);
  });

  await t.test('the name follows the LOCAL calendar day (the nightly 02:15 run is cron-local, so a UTC name would say yesterday)', () => {
    assert.equal(backupName(new Date(2026, 0, 3, 0, 1)), 'marks-2026-01-03.db');   // just after local midnight
    assert.equal(backupName(new Date(2026, 0, 3, 23, 59)), 'marks-2026-01-03.db'); // just before the next one
    assert.equal(backupName(new Date(2026, 11, 31, 2, 15)), 'marks-2026-12-31.db');
  });

  await t.test('writes a readable copy once per day, then skips, leaving no .part file', async () => {
    const dir = tmp(), db = new Database(path.join(dir, 'src.db'));
    db.exec('CREATE TABLE b(x); INSERT INTO b VALUES (1),(2)');
    const out = path.join(dir, 'out');
    const a = await backupOnce(db, out, { date: day(3) });
    assert.equal(a.skipped, false);
    const copy = new Database(a.dest, { readonly: true });
    assert.equal(copy.prepare('SELECT count(*) n FROM b').get().n, 2);
    copy.close();
    assert.equal((await backupOnce(db, out, { date: day(3) })).skipped, true);
    assert.deepEqual(fs.readdirSync(out), ['marks-2026-01-03.db']);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('backupTo (shared with `npm run backup`) replaces an existing file atomically; a failure keeps the old file and leaves no .part', async () => {
    const dir = tmp(), dest = path.join(dir, 'x.db');
    fs.writeFileSync(dest, 'old');
    const closed = new Database(':memory:');
    closed.close();
    await assert.rejects(backupTo(closed, dest));
    assert.equal(fs.readFileSync(dest, 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(dir), ['x.db']);
    const db = new Database(path.join(dir, 'src.db'));
    db.exec('CREATE TABLE b(x); INSERT INTO b VALUES (1)');
    await backupTo(db, dest);
    const copy = new Database(dest, { readonly: true });
    assert.equal(copy.prepare('SELECT count(*) n FROM b').get().n, 1);
    copy.close();
    assert.deepEqual(fs.readdirSync(dir).sort(), ['src.db', 'x.db']);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('keeps the newest N dated backups and never touches other files', () => {
    const dir = tmp();
    for (let i = 1; i <= 16; i++) fs.writeFileSync(path.join(dir, backupName(day(i))), 'x');
    fs.writeFileSync(path.join(dir, 'marks-before-dedupe-123.db'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    assert.deepEqual(prune(dir, 14), ['marks-2026-01-02.db', 'marks-2026-01-01.db']);
    const left = fs.readdirSync(dir);
    assert.equal(left.length, 14 + 2);
    assert.ok(left.includes('marks-before-dedupe-123.db') && left.includes('notes.txt'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('a failing backup rejects, leaves no .part file and keeps older backups', async () => {
    const dir = tmp(), db = new Database(':memory:');
    db.close(); // backing up a closed database fails
    fs.writeFileSync(path.join(dir, 'marks-2026-01-01.db'), 'old');
    await assert.rejects(backupOnce(db, dir, { date: day(2) }));
    assert.deepEqual(fs.readdirSync(dir), ['marks-2026-01-01.db']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('latestBackup returns the newest date, or null for an empty or missing folder', () => {
    const dir = tmp();
    assert.equal(latestBackup(dir), null);
    assert.equal(latestBackup(path.join(dir, 'missing')), null);
    fs.writeFileSync(path.join(dir, 'marks-2026-01-09.db'), 'x');
    fs.writeFileSync(path.join(dir, 'marks-2026-01-10.db'), 'x');
    assert.equal(latestBackup(dir), '2026-01-10');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('home Status panel says when the last backup was, or that there is none', async () => {
    assert.match(await s.get('/'), /<p class=meta>No backup yet<\/p>/);
    fs.writeFileSync(path.join(process.env.MARKS_BACKUPS, 'marks-2026-09-30.db'), '');
    assert.match(await s.get('/'), /<p class=meta>Last backup: 2026-09-30<\/p>/);
  });
});
