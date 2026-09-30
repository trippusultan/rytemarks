const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup } = require('./test-helpers');

test('save button secret', async t => {
  const s = await setup(t);
  const url = encodeURIComponent(s.fake + '/article');
  const rows = () => s.db.prepare('SELECT count(*) n FROM bookmarks').get().n;
  const body = extra => new URLSearchParams({ url: s.fake + '/article', ...extra });

  await t.test('the token is 36 hex characters, stored beside the database and stable across restarts', () => {
    assert.match(s.token, /^[0-9a-f]{36}$/);
    assert.equal(fs.readFileSync(`${s.db.name}.token`, 'utf8').trim(), s.token);
  });

  await t.test('GET /save needs the token: missing or wrong gets a readable 403 with a way back', async () => {
    for (const q of [`url=${url}`, `url=${url}&t=wrong`, `url=${url}&t=${s.token.slice(0, -1)}`]) {
      const r = await fetch(`${s.base}/save?${q}`);
      assert.equal(r.status, 403, q);
      const html = await r.text();
      assert.match(html, /Save link out of date/);
      assert.match(html, /href="\/bookmarklet"/);
    }
    assert.equal(rows(), 0);
  });

  await t.test('GET /save with the token shows the auto-submitting form; a bad URL is still a 400', async () => {
    const ok = await fetch(`${s.base}/save?url=${url}&t=${s.token}`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /<form id=f method=post action="\/save">/);
    assert.equal((await fetch(`${s.base}/save?url=javascript:alert(1)&t=${s.token}`)).status, 400);
    assert.equal(rows(), 0, 'GET never saves');
  });

  await t.test('POST /save from another site with no token is refused and saves nothing', async () => {
    const r = await s.postRaw('/save', body(), { origin: 'http://evil.test' });
    assert.equal(r.status, 403);
    assert.match(await r.text(), /Saves must come from rytemarks itself or from your save button/);
    assert.equal((await s.postRaw('/save', body(), { origin: '' })).status, 403, 'no Origin and no Referer');
    assert.equal(rows(), 0);
  });

  await t.test('POST /save is allowed from our own pages, from the save button (valid token), or with our own Referer', async () => {
    assert.equal((await s.post('/save', body())).status, 303); // helper sends Origin: our own base
    s.db.prepare('DELETE FROM bookmarks').run();
    assert.equal((await s.post('/save', body({ t: s.token }), { origin: 'http://evil.test' })).status, 303);
    s.db.prepare('DELETE FROM bookmarks').run();
    assert.equal((await s.post('/save', body(), { origin: '', referer: `${s.base}/` })).status, 303);
    assert.equal(rows(), 1);
  });

  await t.test('both bookmarklet variants carry the token, and the page explains old ones stop working', async () => {
    const html = await s.get('/bookmarklet');
    // esc() writes "&" as "&#38;" in both the href and the textarea
    assert.equal((html.match(new RegExp(`&#38;t=${s.token}`, 'g')) || []).length, 5, 'footer chip, two buttons and two code boxes');
    assert.match(html, /Have an older save bookmark/);
  });
});
