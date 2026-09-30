const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('tag management', async t => {
  const s = await setup(t);
  s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES ('https://a.test','A',1),('https://b.test','B',2)").run();
  const put = (id, tag) => s.db.prepare('INSERT INTO bookmark_tags VALUES (?, ?)').run(id, tag);
  const tags = id => s.db.prepare('SELECT tag FROM bookmark_tags WHERE bookmark_id = ? ORDER BY tag').all(id).map(r => r.tag);
  put(1, 'a'); put(1, 'b'); put(2, 'b');

  await t.test('rename onto an existing tag merges without duplicates', async () => {
    await s.post('/tags/rename', new URLSearchParams({ from: 'a', to: ' B ' }));
    assert.deepEqual(tags(1), ['b']);
    assert.deepEqual(tags(2), ['b']);
  });

  await t.test('rename to itself keeps everything; empty target is rejected', async () => {
    await s.post('/tags/rename', new URLSearchParams({ from: 'b', to: 'b' }));
    assert.deepEqual(tags(1), ['b']);
    assert.equal((await s.post('/tags/rename', new URLSearchParams({ from: 'b', to: ' , ' }))).status, 400);
  });

  await t.test('hostile tag name cannot break out of the page', async () => {
    put(1, "x');alert(1);('");
    const html = await s.get('/tags');
    assert.doesNotMatch(html, /x'\);alert/);
    assert.match(html, /x&#39;\);alert/);
  });

  await t.test('delete removes the tag everywhere', async () => {
    await s.post('/tags/delete', new URLSearchParams({ tag: 'b' }));
    assert.deepEqual(tags(2), []);
    assert.match(await s.get('/'), /Manage tags/);
  });
});
