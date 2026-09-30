const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, bare } = require('./test-helpers');

test('instant save', async t => {
  let release;
  const gate = new Promise(r => { release = r; });
  const s = await setup(t, {
    '/slow': async (req, res) => { await gate; res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>Slow Page</title></head><body></body></html>'); },
  });
  const row = p => s.db.prepare('SELECT * FROM bookmarks WHERE url = ?').get(p);

  await t.test('POST /save answers before the page has been fetched', async () => {
    const r = await s.postRaw('/save', new URLSearchParams({ url: s.fake + '/slow' }));
    assert.equal(r.status, 303);
    assert.match(r.headers.get('location'), /^\/b\/\d+\?new=1$/);
    assert.equal(row(s.fake + '/slow').title, '');
    assert.equal(row(s.fake + '/slow').archived_at, null);
    assert.match(bare(await s.get(r.headers.get('location'))), /role=status> Saved /);
  });

  await t.test('a title typed meanwhile survives the fetch', async () => {
    const { id } = row(s.fake + '/slow');
    await s.postRaw(`/b/${id}`, new URLSearchParams({ title: 'My title', tags: 'x', note: '' }));
    release();
    await s.settled();
    assert.equal(row(s.fake + '/slow').title, 'My title');
    assert.ok(row(s.fake + '/slow').archived_at);
  });

  await t.test('fetch fills in title and text when the user typed nothing', async () => {
    await s.post('/save', new URLSearchParams({ url: s.fake + '/article' }));
    assert.equal(row(s.fake + '/article').title, 'Fluff Article');
    assert.match(row(s.fake + '/article').text, /Zanzibarfluff/);
  });

  await t.test('offline page: domain as title, stays pending for a retry', async () => {
    await s.post('/save', new URLSearchParams({ url: 'http://127.0.0.1:1/x' }));
    const b = row('http://127.0.0.1:1/x');
    assert.equal(b.title, '127.0.0.1');
    assert.equal(b.archived_at, null);
  });

  await t.test('saving twice opens the existing bookmark with a notice', async () => {
    const r = await s.post('/save', new URLSearchParams({ url: s.fake + '/article' }));
    assert.match(r.headers.get('location'), /\?dup=1$/);
    assert.match(await s.get(r.headers.get('location')), /Already saved/);
  });

  await t.test('edit form from a new save closes the tab; a normal edit redirects', async () => {
    const { id } = row(s.fake + '/article');
    const done = await s.post(`/b/${id}`, new URLSearchParams({ title: '', tags: 'a', note: '', done: '1' }));
    assert.equal(done.status, 200);
    assert.match(await done.text(), /window\.close\(\)/);
    assert.equal((await s.post(`/b/${id}`, new URLSearchParams({ title: '', tags: 'a', note: '' }))).status, 303);
  });
});
