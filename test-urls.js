const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');
const { normalizeUrl } = require('./urls');
const { plan, apply } = require('./dedupe');

test('url normalisation and duplicate merge', async t => {
  const s = await setup(t);

  await t.test('normalizeUrl strips tracking, empty fragments and trailing slashes, and nothing else', () => {
    const cases = [
      ['https://a.test/x/?utm_source=tw&id=3#top', 'https://a.test/x?id=3'],
      ['https://a.test/?fbclid=abc', 'https://a.test/'],
      ['https://a.test', 'https://a.test/'],                       // root path keeps its slash
      ['https://a.test/app#/route/1', 'https://a.test/app#/route/1'], // SPA route fragments are real pages
      ['https://a.test/app#!/x', 'https://a.test/app#!/x'],
      ['https://a.test/a//', 'https://a.test/a'],
      ['https://A.test:443/Path/', 'https://a.test/Path'],
      ['https://a.test/x?b=2&a=1', 'https://a.test/x?b=2&a=1'],    // order and real params untouched
      ['https://a.test/x?utm_medium=e', 'https://a.test/x'],
      ['https://a.test/x?q=a+b&utm_x=1', 'https://a.test/x?q=a+b'],
    ];
    for (const [input, want] of cases) assert.equal(normalizeUrl(input), want, input);
  });

  await t.test('saving the same page with different tracking params is one bookmark', async () => {
    const a = await s.post('/save', new URLSearchParams({ url: s.fake + '/article?utm_source=x#frag' }));
    assert.match(a.headers.get('location'), /\?new=1$/);
    const b = await s.post('/save', new URLSearchParams({ url: s.fake + '/article/?fbclid=9' }));
    assert.match(b.headers.get('location'), /\?dup=1$/);
    assert.equal(s.db.prepare('SELECT count(*) n FROM bookmarks').get().n, 1);
    assert.equal(s.db.prepare('SELECT url FROM bookmarks').get().url, s.fake + '/article');
  });

  await t.test('import normalises too, so repeats inside a file count as already saved', () => {
    const items = s.parseNetscape('<DL><DT><A HREF="https://x.test/p?utm_campaign=1">One</A><DT><A HREF="https://x.test/p/#top">Again</A></DL>');
    assert.deepEqual(items.map(i => i.url), ['https://x.test/p', 'https://x.test/p']);
  });

  await t.test('dedupe: dry plan changes nothing; apply merges notes, tags and text into the oldest row', () => {
    s.db.prepare('DELETE FROM bookmarks').run();
    const ins = s.db.prepare('INSERT INTO bookmarks(url,title,note,text,saved_at) VALUES (?,?,?,?,?)');
    const tag = s.db.prepare('INSERT INTO bookmark_tags VALUES (?,?)');
    ins.run('https://a.test/x?utm_source=1', 'First', 'n1', '', 1);       // id 1, oldest: kept
    ins.run('https://a.test/x/', 'Second', 'n2', 'the longer archived text', 2); // id 2
    ins.run('https://a.test/x#frag', '', 'n1', '', 3);                     // id 3, same note as id 1
    ins.run('https://b.test/?fbclid=1', 'Tidy only', '', '', 4);           // id 4, no duplicate, url just tidied
    ins.run('https://c.test/untouched', 'C', '', '', 5);
    tag.run(1, 't1'); tag.run(2, 't2'); tag.run(2, 't1'); tag.run(3, 't3');
    const p = plan(s.db);
    assert.deepEqual(p.map(x => [x.url, x.keep, x.drop, x.rename]), [
      ['https://a.test/x', 1, [2, 3], true],
      ['https://b.test/', 4, [], true],
    ]);
    assert.equal(s.db.prepare('SELECT count(*) n FROM bookmarks').get().n, 5, 'plan() writes nothing');
    assert.equal(apply(s.db), 2);
    const rows = s.db.prepare('SELECT id,url,title,note,text FROM bookmarks ORDER BY id').all();
    assert.deepEqual(rows.map(r => r.id), [1, 4, 5]);
    assert.equal(rows[0].url, 'https://a.test/x');
    assert.equal(rows[0].title, 'First');
    assert.equal(rows[0].note, 'n1\n\nn2');                 // distinct notes joined, repeated note kept once
    assert.equal(rows[0].text, 'the longer archived text'); // longest text wins
    assert.equal(rows[1].url, 'https://b.test/');
    assert.deepEqual(s.db.prepare('SELECT tag FROM bookmark_tags WHERE bookmark_id = 1 ORDER BY tag').all().map(r => r.tag), ['t1', 't2', 't3']);
    assert.equal(s.db.prepare('SELECT count(*) n FROM bookmark_tags WHERE bookmark_id IN (2,3)').get().n, 0);
    assert.deepEqual(plan(s.db), [], 'running it again finds nothing');
  });

  await t.test('merged text is searchable and the dropped rows are gone from search', async () => {
    assert.match(await s.get('/?q=longer'), /First/);
    assert.doesNotMatch(await s.get('/?q=Second'), /class="card/);
  });
});
