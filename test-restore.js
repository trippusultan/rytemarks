const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

const CHROME = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://top.test/" ADD_DATE="1">Top</A>
        <DT><H3>Dev Stuff</H3>
        <DL><p>
            <DT><A HREF="https://a.test/" ADD_DATE="1" TAGS="Read, dev stuff">A</A>
            <DT><H3>CSS, tricks</H3>
            <DL><p>
                <DT><A HREF="https://b.test/" ADD_DATE="1">B</A>
            </DL><p>
        </DL><p>
        <DT><A HREF="https://after.test/" ADD_DATE="1">After</A>
    </DL><p>
    <DT><H3>Other bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://other.test/">Other</A>
    </DL><p>
</DL><p>`;

test('restore from JSON and folders as tags', async t => {
  const s = await setup(t);
  const imp = (body, q = '') => s.post('/import' + q, body, { 'content-type': 'text/plain', origin: s.base });

  await t.test('folder names become tags; browser root folders do not; commas in names are flattened', () => {
    const by = Object.fromEntries(s.parseImport(CHROME).map(i => [i.url, i.tags]));
    assert.deepEqual(by['https://top.test/'], []);
    assert.deepEqual(by['https://a.test/'], ['read', 'dev stuff']); // TAGS attribute first, folder tag deduped
    assert.deepEqual(by['https://b.test/'], ['dev stuff', 'css tricks']);
    assert.deepEqual(by['https://after.test/'], [], 'a bookmark after a subfolder is back in its parent folder');
    assert.deepEqual(by['https://other.test/'], []);
  });

  await t.test('dry run counts folder tags', async () => {
    const r = await (await imp(CHROME, '?dry=1')).json();
    assert.deepEqual(r, { total: 5, fresh: 5, dupes: 0, tags: 3 });
  });

  await t.test('export then import restores everything, including archived text, and it is searchable', async () => {
    const ins = s.db.prepare('INSERT INTO bookmarks(url,title,note,text,saved_at,status,description) VALUES (?,?,?,?,?,?,?)');
    ins.run('https://r1.test/', 'Restore One', 'my note', 'zebrafish archive body', 1700000000, 200, 'desc');
    ins.run('https://r2.test/', 'Restore Two', '', '', 1700000100, null, '');
    s.db.prepare("INSERT INTO bookmark_tags VALUES (1,'keep'),(1,'x'),(2,'y')").run();
    const dump = await s.get('/export');
    s.db.prepare('DELETE FROM bookmarks').run(); // tags cascade
    assert.equal(s.db.prepare('SELECT count(*) n FROM bookmarks').get().n, 0);
    const res = await (await imp(dump)).text();
    assert.match(res, /Imported 2 new of 2/);
    const r1 = s.db.prepare('SELECT * FROM bookmarks WHERE url = ?').get('https://r1.test/');
    assert.deepEqual([r1.title, r1.note, r1.text, r1.saved_at, r1.status, r1.description], ['Restore One', 'my note', 'zebrafish archive body', 1700000000, 200, 'desc']);
    assert.ok(r1.archived_at, 'restored text counts as archived, so the Archive button leaves it alone');
    assert.equal(s.db.prepare("SELECT archived_at FROM bookmarks WHERE url = 'https://r2.test/'").get().archived_at, null);
    assert.deepEqual(s.db.prepare('SELECT tag FROM bookmark_tags WHERE bookmark_id = ? ORDER BY tag').all(r1.id).map(r => r.tag), ['keep', 'x']);
    assert.match(await s.get('/?q=zebrafish'), /Restore One/);
  });

  await t.test('importing the same JSON again adds nothing', async () => {
    const dump = await s.get('/export');
    assert.match(await (await imp(dump)).text(), /Imported 0 new of 2/);
  });

  await t.test('hostile or broken JSON never crashes or writes: only valid http(s) entries survive', async () => {
    const before = s.db.prepare('SELECT count(*) n FROM bookmarks').get().n;
    const evil = JSON.stringify([{ url: 'javascript:alert(1)' }, { url: 5 }, null, 'x', [], { url: 'https://ok.test/', tags: 'a, B', saved_at: 'garbage', status: '200', title: { x: 1 } }]);
    const items = s.parseImport(evil);
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].url, items[0].tags, items[0].status, items[0].title], ['https://ok.test/', ['a', 'b'], null, '']);
    assert.ok(Math.abs(items[0].saved_at - Math.floor(Date.now() / 1000)) < 5, 'bad date falls back to now');
    for (const bad of ['{"a":1}', '[1,2', '', '[]', '"just a string"']) assert.deepEqual(s.parseImport(bad), [], bad);
    assert.deepEqual(await (await imp('[1,2', '?dry=1')).json(), { total: 0, fresh: 0, dupes: 0, tags: 0 });
    assert.equal(s.db.prepare('SELECT count(*) n FROM bookmarks').get().n, before);
  });

  await t.test('the Import page says it takes JSON too', async () => {
    const html = await s.get('/import');
    assert.match(html, /accept="\.html,\.htm,\.json"/);
    assert.match(html, /or choose a file \(\.html or \.json\)/);
    assert.match(html, /a JSON export from rytemarks itself/);
  });
});
