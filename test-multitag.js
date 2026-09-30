const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('multi-tag filter', async t => {
  const s = await setup(t);
  s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES ('https://a.test','A page',3),('https://b.test','B page',2),('https://c.test','C page',1)").run();
  const put = (id, tag) => s.db.prepare('INSERT INTO bookmark_tags VALUES (?, ?)').run(id, tag);
  put(1, 'a'); put(1, 'b'); put(2, 'a'); put(3, 'b');

  await t.test('all listed tags must match', async () => {
    const html = await s.get('/?tag=a,b');
    assert.match(html, /A page/);
    assert.doesNotMatch(html, /B page|C page/);
    assert.match(html, /1 bookmark tagged #a, #b/);
  });

  await t.test('messy input is normalised', async () => {
    const res = await fetch(s.base + '/?tag=%20A%20,,a,b');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /A page/);
    assert.doesNotMatch(html, /B page/);
  });

  await t.test('unknown tag matches nothing, without an error', async () => {
    const res = await fetch(s.base + '/?tag=zzz,__proto__');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /No matches/);
  });

  await t.test('sidebar toggles tags in and out of the filter', async () => {
    const html = await s.get('/?tag=a');
    assert.match(html, /<a href="\/\?tag=a%2Cb" class="">#b<\/a>/);
    assert.match(html, /<a href="\/" class="on">#a<\/a>/);
  });
});
