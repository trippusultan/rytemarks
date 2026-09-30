const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('origin handling for real browsers', async t => {
  const s = await setup(t);
  await s.post('/save', new URLSearchParams({ url: s.fake + '/article' }));

  // With "Referrer-Policy: no-referrer" browsers send "Origin: null" on ordinary same-origin form posts
  // (Save, Delete, tag forms), which the CSRF check rejects. same-origin keeps the real Origin for our own
  // forms and still sends no Referer to other sites (favicons).
  await t.test('pages send Referrer-Policy: same-origin, never no-referrer', async () => {
    const res = await fetch(s.base + '/');
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
  });

  await t.test('a same-origin form post (Origin = our own origin) is accepted', async () => {
    const r = await s.post('/b/1', new URLSearchParams({ title: '', tags: 'a', note: 'n' }), { origin: s.base });
    assert.equal(r.status, 303);
  });

  await t.test('Origin: null and foreign origins are still refused', async () => {
    for (const origin of ['null', 'http://evil.test', 'http://127.0.0.1.evil.test']) {
      const r = await s.post('/b/1', new URLSearchParams({ title: '', tags: 'a', note: 'x' }), { origin });
      assert.equal(r.status, 403, origin);
    }
    assert.equal(s.db.prepare('SELECT note FROM bookmarks WHERE id = 1').get().note, 'n');
  });
});
