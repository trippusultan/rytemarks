const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('undo delete and flash messages', async t => {
  const s = await setup(t);
  await s.post('/save', new URLSearchParams({ url: s.fake + '/article' }));
  await s.post('/b/1', new URLSearchParams({ title: '', tags: 'keep, me', note: 'n' }));
  const count = () => s.db.prepare('SELECT count(*) n FROM bookmarks').get().n;
  const del = () => s.post('/b/1/delete', new URLSearchParams({ back: '/?tag=keep' }));

  await t.test('delete keeps you on your list and offers Undo', async () => {
    const r = await del();
    assert.equal(r.headers.get('location'), '/?tag=keep&ok=deleted');
    assert.equal(count(), 0);
    const html = await s.get('/?ok=deleted');
    assert.match(html, /Bookmark deleted\./);
    assert.match(html, /action="\/undo"/);
  });

  await t.test('undo restores id, fields, tags and search; a second undo is a no-op', async () => {
    assert.equal((await s.post('/undo', '')).headers.get('location'), '/?ok=restored');
    const b = s.db.prepare('SELECT * FROM bookmarks WHERE id = 1').get();
    assert.equal(b.note, 'n');
    assert.match(b.text, /Zanzibarfluff/);
    assert.deepEqual(s.db.prepare('SELECT tag FROM bookmark_tags WHERE bookmark_id = 1 ORDER BY tag').all().map(r => r.tag), ['keep', 'me']);
    assert.match(await s.get('/?q=zanzibarfluff'), /Fluff Article/);
    assert.equal((await s.post('/undo', '')).headers.get('location'), '/');
    assert.equal(count(), 1);
  });

  await t.test('an expired undo is refused', async () => {
    await del();
    s.undo.item.at = 0;
    assert.equal((await s.post('/undo', '')).headers.get('location'), '/');
    assert.equal(count(), 0);
  });

  await t.test('undo still works when the id was taken meanwhile', async () => {
    await s.post('/save', new URLSearchParams({ url: s.fake + '/article' }));
    await s.post('/b/1', new URLSearchParams({ title: '', tags: 'keep', note: 'orig' }));
    await del();
    await s.post('/save', new URLSearchParams({ url: s.fake + '/plain' })); // reuses id 1
    assert.equal(count(), 1);
    assert.equal((await s.post('/undo', '')).headers.get('location'), '/?ok=restored');
    assert.equal(count(), 2);
    const b = s.db.prepare('SELECT * FROM bookmarks WHERE url = ?').get(s.fake + '/article');
    assert.equal(b.note, 'orig');
    assert.deepEqual(s.db.prepare('SELECT tag FROM bookmark_tags WHERE bookmark_id = ?').all(b.id).map(r => r.tag), ['keep']);
  });

  await t.test('undo says so when the page was saved again', async () => {
    s.db.prepare('DELETE FROM bookmarks').run();
    await s.post('/save', new URLSearchParams({ url: s.fake + '/article' }));
    const id = s.db.prepare('SELECT id FROM bookmarks').get().id;
    await s.post(`/b/${id}/delete`, new URLSearchParams({}));
    await s.post('/save', new URLSearchParams({ url: s.fake + '/article' }));
    assert.equal((await s.post('/undo', '')).headers.get('location'), '/?ok=exists');
    assert.equal(count(), 1);
    assert.match(await s.get('/?ok=exists'), /saved again/);
  });

  await t.test('flash keys are whitelisted', async () => {
    for (const k of ['__proto__', 'constructor', '<script>alert(1)</script>']) {
      const html = await s.get(`/?ok=${encodeURIComponent(k)}`);
      assert.doesNotMatch(html, /\[object Object\]|<script>alert/, k);
    }
  });

  await t.test('editing reports Saved', async () => {
    await s.post('/save', new URLSearchParams({ url: s.fake + '/article' }));
    const { id } = s.db.prepare('SELECT id FROM bookmarks').get(); // ids are reused after deletes
    const r = await s.post(`/b/${id}`, new URLSearchParams({ title: '', tags: 'a', note: '' }));
    assert.equal(r.headers.get('location'), '/?ok=saved');
  });
});
