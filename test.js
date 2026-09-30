const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.MARKS_DB = path.join(os.tmpdir(), `marks-test-${process.pid}-${Date.now()}.db`);
const { app, db, checkLinks, settled } = require('./server');

const para = 'Zanzibarfluff is the unique word in this readable article paragraph, repeated so Readability keeps it. ';
const article = `<html><head><title>Fluff Article</title><meta name="description" content="About fluff">
<meta property="og:image" content="http://img.test/x.png"><link rel="icon" href="/fav.png"></head>
<body><nav>menu</nav><article><h1>Fluff Article</h1>${`<p>${para.repeat(6)}</p>`.repeat(4)}</article></body></html>`;

test('bookmark manager end to end', async t => {
  let flipStatus = 200;
  const site = http.createServer((req, res) => {
    if (req.url === '/article') return res.writeHead(200, { 'content-type': 'text/html' }).end(article);
    if (req.url === '/flip') return res.writeHead(flipStatus, { 'content-type': 'text/html' }).end('<title>Flip</title>');
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  const srv = app.listen(0, '127.0.0.1');
  t.after(() => { site.closeAllConnections(); srv.closeAllConnections(); site.close(); srv.close(); db.close(); require('node:fs').rmSync(process.env.MARKS_DB, { force: true }); require('node:fs').rmSync(process.env.MARKS_DB + '.token', { force: true }); });
  await Promise.all([new Promise(r => site.once('listening', r)), new Promise(r => srv.once('listening', r))]);
  const base = `http://127.0.0.1:${srv.address().port}`, fake = `http://127.0.0.1:${site.address().port}`;
  const post = async (p, body, headers = {}) => {
    const r = await fetch(base + p, { method: 'POST', redirect: 'manual', body, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, ...headers } });
    if (p === '/save') await settled();
    return r;
  };
  const get = async p => (await fetch(base + p)).text();

  await t.test('save scrapes metadata + article text', async () => {
    const r = await post('/save', new URLSearchParams({ url: `${fake}/article` }));
    assert.equal(r.status, 303);
    const b = db.prepare('SELECT * FROM bookmarks WHERE id=1').get();
    assert.equal(b.title, 'Fluff Article');
    assert.equal(b.description, 'About fluff');
    assert.equal(b.image, 'http://img.test/x.png');
    assert.equal(b.favicon, `${fake}/fav.png`);
    assert.match(b.text, /Zanzibarfluff/);
    assert.equal((await post('/save', new URLSearchParams({ url: 'javascript:alert(1)' }))).status, 400);
    await post('/save', new URLSearchParams({ url: `${fake}/article` })); // duplicate is a no-op
    assert.equal(db.prepare('SELECT count(*) n FROM bookmarks').get().n, 1);
  });

  await t.test('tags, note, search, filter', async () => {
    await post('/b/1', new URLSearchParams({ title: '', tags: 'Alpha, beta ,alpha', note: 'remember pineapplenote' }));
    assert.deepEqual(db.prepare('SELECT tag FROM bookmark_tags ORDER BY tag').all().map(r => r.tag), ['alpha', 'beta']);
    for (const q of ['zanzibarfluff', 'zanzib', 'pineapplenote', 'fluff article']) assert.match(await get(`/?q=${q}`), /Fluff Article/, q);
    assert.doesNotMatch(await get('/?q=nonexistentword'), /Fluff Article/);
    assert.equal((await fetch(base + '/?q=%22+OR+(%5E*')).status, 200); // hostile FTS syntax must not 500
    assert.match(await get('/?tag=beta'), /Fluff Article/);
    assert.doesNotMatch(await get('/?tag=nope'), /Fluff Article/);
    await post('/b/1', new URLSearchParams({ title: '', tags: 'alpha', note: 'changed' }));
    assert.doesNotMatch(await get('/?q=pineapplenote'), /Fluff Article/); // FTS follows updates
  });

  await t.test('link check flags 404 and clears it on recovery', async () => {
    await post('/save', new URLSearchParams({ url: `${fake}/flip` }));
    flipStatus = 404;
    assert.equal(await checkLinks(), 1);
    assert.match(await get('/'), /class=dead/);
    flipStatus = 200;
    assert.equal(await checkLinks(), 0);
    assert.doesNotMatch(await get('/'), /class=dead/);
  });

  await t.test('netscape import', async () => {
    const html = `<DL><p><DT><H3>Folder</H3><DL><p>
      <DT><A HREF="https://example.com/a" ADD_DATE="1600000000" TAGS="Tools, dev">Example A</A>
      <DD>a note here
      <DT><A HREF="javascript:alert(1)">bookmarklet</A>
      <DT><A HREF="https://example.com/a">dup</A>
      </DL></DL>`;
    const r = await post('/import', html, { 'content-type': 'text/plain', origin: base });
    assert.match(await r.text(), /Imported 1 new of 2/);
    const b = db.prepare("SELECT * FROM bookmarks WHERE url='https://example.com/a'").get();
    assert.equal([b.title, b.note, b.saved_at].join('|'), 'Example A|a note here|1600000000');
    assert.match(await get('/?tag=tools'), /Example A/);
    assert.match(await get('/?q=note'), /Example A/);
  });

  await t.test('export json + csv', async () => {
    const json = JSON.parse(await get('/export?format=json'));
    assert.equal(json.length, 3);
    assert.ok(json.find(b => b.url.endsWith('/article')).text.includes('Zanzibarfluff'));
    assert.deepEqual(json.find(b => b.url.includes('example.com')).tags, ['dev', 'folder', 'tools']); // "folder" is the fixture's <H3>Folder</H3>: folders become tags
    db.prepare("UPDATE bookmarks SET title='=HYPERLINK(1)' WHERE id=1").run();
    const csv = await get('/export?format=csv');
    assert.match(csv, /^url,title,description/);
    assert.match(csv, /'=HYPERLINK\(1\)/);
  });

  await t.test('rejects foreign Host and cross-origin posts', async () => {
    const status = await new Promise(res => http.get(base, { headers: { host: 'evil.test' } }, r => { r.resume(); res(r.statusCode); }));
    assert.equal(status, 403);
    assert.equal((await post('/b/1/delete', '', { origin: 'http://evil.test' })).status, 403);
    assert.equal(db.prepare('SELECT count(*) n FROM bookmarks').get().n, 3);
    assert.equal((await post('/b/1/delete', '', { origin: base })).status, 303);
    assert.equal(db.prepare('SELECT count(*) n FROM bookmarks').get().n, 2);
  });
});
