const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('archive backfill', async t => {
  const s = await setup(t);
  const row = p => s.db.prepare('SELECT * FROM bookmarks WHERE url = ?').get(s.fake + p);

  await s.post('/import', `<DL><DT><A HREF="${s.fake}/article">Imported</A><DT><A HREF="${s.fake}/plain">Plain</A><DT><A HREF="${s.fake}/missing">Gone</A></DL>`,
    { 'content-type': 'text/plain', origin: s.base });
  assert.match(await s.get('/'), /Archive 3 pages/);

  await t.test('fills text once, keeps user title, flags 404, never retries', async () => {
    assert.equal(await s.archiveMissing(), 1);
    assert.match(row('/article').text, /Zanzibarfluff/);
    assert.equal(row('/article').title, 'Imported');
    assert.match(await s.get('/?q=zanzibarfluff'), /Imported/);
    assert.equal(row('/missing').status, 404);
    assert.ok(row('/plain').archived_at);
    assert.equal(await s.archiveMissing(), 0);
  });

  await t.test('POST /archive redirects (nothing pending, so the job is a no-op)', async () => {
    assert.equal((await s.post('/archive', '')).status, 303);
  });

  await t.test('a network failure is not final: the page stays pending', async () => {
    await s.post('/import', '<DL><DT><A HREF="http://127.0.0.1:1/unreachable">Offline</A></DL>', { 'content-type': 'text/plain', origin: s.base });
    assert.equal(await s.archiveMissing(), 0);
    const r = s.db.prepare("SELECT archived_at FROM bookmarks WHERE url = 'http://127.0.0.1:1/unreachable'").get();
    assert.equal(r.archived_at, null);
    assert.equal(s.db.prepare("SELECT count(*) n FROM bookmarks WHERE archived_at IS NULL AND text = ''").get().n, 1);
  });
});
