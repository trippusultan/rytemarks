const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('search snippets', async t => {
  const s = await setup(t);
  await s.post('/save', new URLSearchParams({ url: s.fake + '/article' }));
  s.db.prepare("UPDATE bookmarks SET text = 'before <script>alert(1)</script> zanzibarfluff after' WHERE id = 1").run();

  await t.test('hit is highlighted and page text is escaped', async () => {
    const html = await s.get('/?q=zanzibarfluff');
    assert.match(html, /<mark>zanzibarfluff<\/mark>/);
    assert.match(html, /&#60;script&#62;/);
    assert.doesNotMatch(html, /<script>alert\(1\)/);
  });

  await t.test('punctuation-only query behaves like no search', async () => {
    assert.equal((await fetch(s.base + '/?q=%22%22%21')).status, 200);
    assert.match(await s.get('/?q=!!!'), /Fluff Article/);
  });
});
