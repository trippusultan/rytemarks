const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { setup } = require('./test-helpers');

test('backup command', async t => {
  const s = await setup(t);
  s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES ('https://a.test','A',1)").run();
  const dest = path.join(os.tmpdir(), `marks-backup-${process.pid}.db`);

  await t.test('copies a running database into a readable file', () => {
    execFileSync(process.execPath, ['backup.js', dest], { cwd: __dirname, env: process.env });
    const copy = new Database(dest, { readonly: true });
    assert.equal(copy.prepare('SELECT count(*) n FROM bookmarks').get().n, 1);
    copy.close();
    fs.rmSync(dest);
  });

  await t.test('fails loudly when the source does not exist', () => {
    const env = { ...process.env, MARKS_DB: path.join(os.tmpdir(), `nope-${process.pid}.db`) };
    assert.throws(() => execFileSync(process.execPath, ['backup.js', dest], { cwd: __dirname, env, stdio: 'pipe' }));
    assert.equal(fs.existsSync(env.MARKS_DB), false);
  });
});
