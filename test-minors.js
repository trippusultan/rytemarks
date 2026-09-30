const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('deferred minors', async t => {
  let laterCalls = 0, hugeChunks = 0, hits = 0, releaseCap;
  const gateCap = new Promise(r => { releaseCap = r; });
  const routes = {
    '/later': (req, res) => {
      if (laterCalls++ === 0) return req.socket.destroy(); // first fetch fails (offline)
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>Later Title</title></head><body></body></html>');
    },
    '/huge': async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><head><title>Huge</title></head><body>');
      const chunk = 'x'.repeat(1 << 20);
      for (let i = 0; i < 40; i++) {
        if (res.destroyed) break;
        if (!res.write(chunk)) await new Promise(r => { res.once('drain', r); res.once('close', r); });
        hugeChunks = i + 1;
      }
      res.end();
    },
  };
  for (let i = 0; i < 12; i++) routes['/cap' + i] = async (req, res) => { hits++; await gateCap; res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Cap</title>'); };
  const s = await setup(t, routes);
  const row = p => s.db.prepare('SELECT * FROM bookmarks WHERE url = ?').get(p);

  await t.test('empty POSTs are rejected without a 500 and without clearing anything', async () => {
    await s.post('/save', new URLSearchParams({ url: s.fake + '/article' }));
    await s.post('/b/1', new URLSearchParams({ title: '', tags: 'a', note: 'keep me' }));
    assert.equal((await s.post('/save', '')).status, 400);
    assert.equal((await s.post('/b/1', '')).status, 400);
    assert.equal(s.db.prepare('SELECT note FROM bookmarks WHERE id = 1').get().note, 'keep me');
  });

  await t.test('the Undo button disappears once the undo window has passed', async () => {
    await s.post('/b/1/delete', new URLSearchParams({}));
    assert.match(await s.get('/?ok=deleted'), /action="\/undo"/);
    s.undo.item.at = 0;
    assert.doesNotMatch(await s.get('/?ok=deleted'), /action="\/undo"/);
  });

  await t.test('a placeholder title from an offline save is upgraded by a later Archive', async () => {
    await s.post('/save', new URLSearchParams({ url: s.fake + '/later' }));
    assert.equal(row(s.fake + '/later').title, '127.0.0.1');
    await s.archiveMissing();
    assert.equal(row(s.fake + '/later').title, 'Later Title');
  });

  await t.test('the sidebar keeps the dead-links filter', async () => {
    s.db.prepare("INSERT INTO bookmarks(url,title,saved_at,status) VALUES ('https://d.test','Dead one',9,404)").run();
    const { id } = row('https://d.test');
    s.db.prepare("INSERT INTO bookmark_tags VALUES (?, 'x')").run(id);
    assert.match(await s.get('/?dead=1'), /href="\/\?tag=x(&#38;|&)dead=1"/);
  });

  await t.test('a huge page is read only up to a cap', async () => {
    await s.post('/save', new URLSearchParams({ url: s.fake + '/huge' }));
    assert.equal(row(s.fake + '/huge').title, 'Huge');
    assert.ok(hugeChunks < 20, `server wrote ${hugeChunks} MB`);
  });

  await t.test('at most 10 background fetches run at once; the rest stay pending for Archive', async () => {
    for (let i = 0; i < 12; i++) await s.postRaw('/save', new URLSearchParams({ url: s.fake + '/cap' + i }));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(hits, 10);
    releaseCap();
    await s.settled();
    const pending = s.db.prepare("SELECT count(*) n FROM bookmarks WHERE url LIKE '%/cap%' AND archived_at IS NULL").get().n;
    assert.equal(pending, 2);
  });
});
