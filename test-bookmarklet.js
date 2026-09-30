const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

// Some browsers (e.g. embedded browser panes) open a form's target=_blank as a plain GET and drop the POST body,
// so the bookmarklet must carry the address in the link itself, and errors must say what happened.
test('bookmarklet robustness', async t => {
  const s = await setup(t);
  const count = () => s.db.prepare('SELECT count(*) n FROM bookmarks').get().n;

  await t.test('standard bookmarklet puts the address in the link (no form post)', async () => {
    const html = await s.get('/bookmarklet');
    assert.match(html, /<textarea[^>]*>javascript:\(function\(\)\{[^<]*save\?url=[^<]*window\.open\(/);
    assert.doesNotMatch(html, /createElement\(&#39;form&#39;\)/);
  });

  await t.test('GET /save?url= auto-submits the POST form, but does not save by itself', async () => {
    const html = await s.get(`/save?url=${encodeURIComponent(s.fake + '/article')}`);
    assert.match(html, /<form id=f method=post action="\/save">/);
    assert.match(html, /getElementById\('f'\)\.submit\(\)/);
    assert.equal(count(), 0);
  });

  await t.test('a missing address explains what happened and how to fix it', async () => {
    const res = await fetch(s.base + '/save');
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /No web address arrived/);
    assert.match(html, /href="\/bookmarklet"/);
    assert.equal((await s.post('/save', '')).status, 400);
  });

  await t.test('a bad address is echoed back, escaped', async () => {
    const res = await fetch(s.base + '/save?url=' + encodeURIComponent('<script>alert(1)</script>'));
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /&#60;script&#62;alert\(1\)/);
    assert.doesNotMatch(html, /<script>alert/);
    const post = await s.post('/save', new URLSearchParams({ url: 'ftp://files.test/x' }));
    assert.equal(post.status, 400);
    assert.match(await post.text(), /ftp:\/\/files\.test\/x/);
  });

  await t.test('the old form-post bookmarklet keeps working', async () => {
    const r = await s.post('/save', new URLSearchParams({ url: s.fake + '/article' }));
    assert.equal(r.status, 303);
    assert.equal(count(), 1);
  });
});
