const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('saving without the bookmarklet', async t => {
  const s = await setup(t);

  await t.test('GET /save asks first and never saves', async () => {
    const html = await s.get(`/save?t=${s.token}&url=${encodeURIComponent(s.fake + '/article')}`);
    assert.match(html, /<form id=f method=post action="\/save">/);
    assert.equal(s.db.prepare('SELECT count(*) n FROM bookmarks').get().n, 0);
    assert.equal((await fetch(s.base + '/save?t=' + s.token + '&url=javascript:alert(1)')).status, 400);
  });

  await t.test('bookmarklet page shows both variants', async () => {
    const html = await s.get('/bookmarklet');
    assert.match(html, /<textarea[^>]*>javascript:\(function\(\)/);
    assert.match(html, /save\?url=/);
  });

  await t.test('home page has an add box; schemeless, padded URL is accepted', async () => {
    assert.match(await s.get('/'), /<form method=post action="\/save" class=add>/);
    const r = await s.post('/save', new URLSearchParams({ url: '  example.test/x ' }));
    assert.equal(r.status, 303);
    assert.ok(s.db.prepare("SELECT 1 FROM bookmarks WHERE url = 'https://example.test/x'").get());
  });
});
