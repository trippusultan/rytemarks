const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, bare } = require('./test-helpers');

const tick = () => new Promise(r => setTimeout(r, 25));

test('sub pages: sticky footer, tags, import, bookmarklet, edit, messages', async t => {
  const s = await setup(t);
  const now = Math.floor(Date.now() / 1000);
  const home = await s.get('/');
  const css = /<style>([\s\S]*?)<\/style>/.exec(home)[1];
  const open = (html, extra = {}) => new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/', ...extra });

  await t.test('CSS: sticky footer (full-height column, content takes the free space) and the shared page header', () => {
    assert.match(css, /body\{[^}]*min-height:100dvh[^}]*display:flex[^}]*flex-direction:column/);
    assert.match(css, /main\{[^}]*width:100%[^}]*flex:1/);
    assert.match(css, /footer\{[^}]*width:100%/);
    assert.match(css, /\.ph\{[^}]*justify-content:space-between/);
    assert.match(css, /\.ph h1\{[^}]*font-size:clamp\(1\.9rem,4vw,2\.6rem\)/);
    assert.match(css, /\.lede\{[^}]*color:var\(--mut\)/);
    assert.match(css, /\[hidden\]\{display:none!important\}/); // display:flex/grid on a component must not defeat the hidden attribute
    assert.match(css, /summary \.ic\{[^}]*transition:transform/); // disclosures look openable: a caret icon that turns when open
    assert.match(css, /details\[open\]>summary \.ic\{[^}]*transform:rotate\(90deg\)/);
  });

  // ---------- tags ----------
  s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES ('https://a.test','A',3),('https://b.test','B',2),('https://c.test','C',1)").run();
  const put = (id, tag) => s.db.prepare('INSERT INTO bookmark_tags VALUES (?, ?)').run(id, tag);
  put(1, 'dev'); put(2, 'dev'); put(3, 'dev'); put(1, 'css'); put(2, 'css'); put(3, 'zeta'); put(1, 'alpha');
  const order = html => [...html.matchAll(/<li class=tagcard style="--i:\d+" data-name="([^"]+)">/g)].map(m => m[1]);

  await t.test('tags: header block, live lede, sort toggle (server-rendered), cards in order', async () => {
    const html = await s.get('/tags');
    assert.match(html, /<div class=ph><div><h1>Tags<\/h1><p class=lede>4 tags across 3 bookmarks\. Rename a tag onto another to merge them; delete removes it from every bookmark\.<\/p><\/div><div class=act><div class=seg role=group aria-label="Sort tags"><a class="sg on" href="\/tags" aria-current=true>Most used<\/a><a class="sg" href="\/tags\?sort=az">A to Z<\/a><\/div><\/div><\/div>/);
    assert.deepEqual(order(html), ['dev', 'css', 'alpha', 'zeta']);
    const az = await s.get('/tags?sort=az');
    assert.deepEqual(order(az), ['alpha', 'css', 'dev', 'zeta']);
    assert.match(az, /<a class="sg" href="\/tags">Most used<\/a><a class="sg on" href="\/tags\?sort=az" aria-current=true>A to Z<\/a>/);
    assert.deepEqual(order(await s.get('/tags?sort=%3Cscript%3E')), ['dev', 'css', 'alpha', 'zeta']); // unknown sort falls back
  });

  await t.test('tags: each card has an Edit disclosure with rename, merge note and a two-step delete that names the count', async () => {
    const html = await s.get('/tags');
    assert.match(bare(html), /<details class=tedit><summary>Edit<\/summary><form method=post action="\/tags\/rename"><input type=hidden name=from value="dev"><label for=rn-0>New name<\/label><input id=rn-0 type=text name=to value="dev" autocomplete=off><p class=hint>Renaming onto an existing tag merges them\. #dev is on 3 bookmarks\.<\/p><button>Rename<\/button><\/form><details class=del><summary>Delete tag<\/summary><p class=hint>Removes #dev from 3 bookmarks\. The bookmarks themselves stay\.<\/p><form method=post action="\/tags\/delete"><input type=hidden name=tag value="dev"><button>Remove from 3 bookmarks<\/button><\/form><\/details><\/details>/);
    assert.match(html, /#zeta is on 1 bookmark\./);
    assert.match(html, /<button>Remove from 1 bookmark<\/button>/);
    assert.doesNotMatch(html, /confirm\(/, 'no browser popup');
  });

  await t.test('tags: filter box narrows the cards as you type', async () => {
    const html = await s.get('/tags');
    assert.match(html, /<label class=sr for=tag-filter>Filter tags<\/label><input id=tag-filter type=search placeholder="Filter tags" autocomplete=off>/);
    const win = open(html).window, d = win.document;
    const inp = d.getElementById('tag-filter');
    const shown = () => [...d.querySelectorAll('.tagcard')].filter(c => !c.hidden).map(c => c.dataset.name);
    inp.value = 'e'; inp.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.deepEqual(shown(), ['dev', 'zeta']);
    assert.equal(d.getElementById('tag-none').hidden, true);
    inp.value = 'qqq'; inp.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.deepEqual(shown(), []);
    assert.equal(d.getElementById('tag-none').hidden, false);
    inp.value = ''; inp.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.equal(shown().length, 4);
  });

  await t.test('tags: hostile names stay inert; delete and rename routes still work', async () => {
    put(1, `x"><img src=x onerror=alert(1)>`);
    assert.doesNotMatch(await s.get('/tags'), /<img src=x/);
    s.db.prepare('DELETE FROM bookmark_tags WHERE tag LIKE ?').run('x%');
    await s.post('/tags/delete', new URLSearchParams({ tag: 'zeta' }));
    assert.equal(order(await s.get('/tags')).includes('zeta'), false);
  });

  await t.test('tags: a composed empty state that explains how tags get created', async () => {
    s.db.prepare('DELETE FROM bookmarks').run();
    const html = await s.get('/tags');
    assert.match(html, /<h1>Tags<\/h1><p class=lede>Nothing tagged yet\.<\/p>/);
    assert.match(bare(html), /<div class=empty><span class=ei><\/span><h3>No tags yet<\/h3><p>Tags appear when you add them to a bookmark\. Open any bookmark, type a tag \(separate several with commas\) and press Save\.<\/p><a href="\/">Back to your bookmarks<\/a><\/div>/);
    assert.doesNotMatch(html, /id=tag-filter/);
  });

  // ---------- import ----------
  await t.test('import: header block, dropzone with a real file input, export how-to', async () => {
    const html = await s.get('/import');
    assert.match(html, /<h1>Import bookmarks<\/h1><p class=lede>Bring in a bookmarks export from Chrome, Firefox, Safari or Raindrop, or a JSON export from rytemarks itself/);
    assert.match(bare(html), /<label class=drop id=drop for=f><input type=file id=f accept="\.html,\.htm,\.json"><span class=drop-i><\/span><span class=drop-t>Drop your bookmarks file here<\/span><span class=drop-s>or choose a file \(\.html or \.json\)<\/span><\/label>/);
    assert.match(bare(html), /<details class=howto><summary>How do I export my bookmarks\?<\/summary><ul>/);
    assert.doesNotMatch(html, /page text is not fetched/);
  });

  await t.test('import: dry run counts new, already saved (including repeats in the file) and tags, and writes nothing', async () => {
    s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES ('https://exists.test/','Have',1)").run();
    const file = `<DL><DT><A HREF="https://x.test/1" TAGS="a,b">One</A><DT><A HREF="https://x.test/1" TAGS="c">One again</A><DT><A HREF="https://x.test/2" TAGS="b">Two</A><DT><A HREF="https://exists.test/" TAGS="z">Have</A><DT><A HREF="javascript:alert(1)">bookmarklet</A></DL>`;
    const before = s.db.prepare('SELECT count(*) n FROM bookmarks').get().n;
    const dry = await s.post('/import?dry=1', file, { 'content-type': 'text/plain', origin: s.base });
    assert.equal(dry.status, 200);
    assert.deepEqual(await dry.json(), { total: 4, fresh: 2, dupes: 2, tags: 2 });
    assert.equal(s.db.prepare('SELECT count(*) n FROM bookmarks').get().n, before, 'dry run wrote nothing');
    const real = await s.post('/import', file, { 'content-type': 'text/plain', origin: s.base });
    assert.match(await real.text(), /Imported 2 new of 4 http\(s\) links\./);
    assert.equal(s.db.prepare('SELECT count(*) n FROM bookmarks').get().n, before + 2);
    const junk = await s.post('/import?dry=1', '<html>hello</html>', { 'content-type': 'text/plain', origin: s.base });
    assert.deepEqual(await junk.json(), { total: 0, fresh: 0, dupes: 0, tags: 0 });
    const foreign = await s.post('/import?dry=1', file, { 'content-type': 'text/plain', origin: 'http://evil.test' });
    assert.equal(foreign.status, 403);
  });

  await t.test('import: choosing a file shows a preview, confirming shows the result card', async () => {
    const html = await s.get('/import');
    const win = open(html).window, d = win.document;
    const calls = [];
    win.fetch = async (url) => {
      calls.push(url);
      if (url === '/import?dry=1') return { ok: true, json: async () => ({ total: 5, fresh: 3, dupes: 2, tags: 4 }) };
      return { ok: true, text: async () => 'Imported 3 new of 5 http(s) links.' };
    };
    const f = d.getElementById('f');
    Object.defineProperty(f, 'files', { value: [new win.File(['<a href="https://x.test">x</a>'], 'export.html')] });
    f.dispatchEvent(new win.Event('change'));
    await tick();
    assert.equal(d.getElementById('preview').hidden, false);
    assert.deepEqual(['p-new', 'p-dupe', 'p-tags'].map(id => d.getElementById(id).textContent), ['3', '2', '4']);
    assert.equal(d.getElementById('go').textContent, 'Import 3 bookmarks');
    assert.equal(d.getElementById('go').disabled, false);
    d.getElementById('go').click();
    await tick();
    assert.equal(d.getElementById('result').hidden, false);
    assert.equal(d.getElementById('preview').hidden, true);
    assert.deepEqual(['r-added', 'r-skipped'].map(id => d.getElementById(id).textContent), ['3', '2']);
    assert.deepEqual(calls, ['/import?dry=1', '/import']);
    assert.match(bare(d.getElementById('result').innerHTML), /<a class="btn" href="\/">View bookmarks<\/a><form method="post" action="\/archive" class="inline"><button>Archive pages now<\/button><\/form>/);
  });

  await t.test('import: nothing new disables the button; a non-export and a failed request show readable errors', async () => {
    const html = await s.get('/import');
    const pick = async (fetchImpl) => {
      const win = open(html).window, d = win.document;
      win.fetch = fetchImpl;
      const f = d.getElementById('f');
      Object.defineProperty(f, 'files', { value: [new win.File(['x'], 'x.html')] });
      f.dispatchEvent(new win.Event('change'));
      await tick();
      return d;
    };
    let d = await pick(async () => ({ ok: true, json: async () => ({ total: 2, fresh: 0, dupes: 2, tags: 0 }) }));
    assert.equal(d.getElementById('go').disabled, true);
    assert.equal(d.getElementById('go').textContent, 'Nothing new to import');
    assert.equal(d.getElementById('p-none').hidden, false);
    d = await pick(async () => ({ ok: true, json: async () => ({ total: 0, fresh: 0, dupes: 0, tags: 0 }) }));
    assert.equal(d.getElementById('err').hidden, false);
    assert.match(d.getElementById('err').textContent, /doesn't look like a bookmarks export/);
    assert.equal(d.getElementById('preview').hidden, true);
    d = await pick(async () => { throw new Error('offline'); });
    assert.match(d.getElementById('err').textContent, /Could not read that file/);
  });

  // ---------- bookmarklet ----------
  await t.test('bookmarklet: three numbered steps, a draggable button, a Copy button, code behind a disclosure', async () => {
    const html = await s.get('/bookmarklet');
    assert.match(html, /<h1>Save button<\/h1><p class=lede>One click on any page saves it to rytemarks\./);
    assert.match(html, /<ol class=steps><li><b>Show your bookmarks bar\.<\/b>/);
    assert.equal((/<ol class=steps>([\s\S]*?)<\/ol>/.exec(html)[1].match(/<li>/g) || []).length, 3);
    assert.match(html, /<a class=dragbtn href="javascript:/);
    assert.match(bare(html), /<button type=button class=ghost data-copy=code-std><span class=bl>Copy code<\/span><\/button>/);
    assert.match(bare(html), /<details class=howto><summary>Show the code<\/summary><textarea id=code-std readonly rows=6/);
    const win = open(html).window, d = win.document;
    let copied = null;
    Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async v => { copied = v; } } });
    const btn = d.querySelector('[data-copy=code-std]');
    btn.click();
    await tick();
    assert.match(copied, /^javascript:\(function\(\)\{/);
    assert.equal(btn.textContent, 'Copied');
  });

  // ---------- edit page ----------
  await t.test('edit page: form left, details card right (description, saved, last check, archived)', async () => {
    s.db.prepare('DELETE FROM bookmarks').run();
    s.db.prepare("INSERT INTO bookmarks(url,title,description,favicon,text,saved_at,status,archived_at) VALUES ('https://ok.test/p','OK page','A short description',?, 'body text', ?, 200, ?)").run('https://ok.test/f.ico', now - 3600, now);
    s.db.prepare("INSERT INTO bookmarks(url,title,saved_at,status) VALUES ('https://gone.test/p','Gone page', ?, 404)").run(now - 60);
    s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES ('https://new.test/p','New page', ?)").run(now - 30);
    const ok = await s.get('/b/1');
    assert.match(ok, /<div class=ph><div><h1>OK page<\/h1><p class=lede><a href="https:\/\/ok\.test\/p" rel="noopener noreferrer">https:\/\/ok\.test\/p<\/a><\/p><\/div><\/div>/);
    assert.match(ok, /<div class=edit-layout><div class=col-main>/);
    assert.match(ok, /<aside class="side dcard" aria-label="Bookmark details">/);
    assert.match(ok, /<dt>Description<\/dt><dd>A short description<\/dd>/);
    assert.match(ok, /<dt>Saved<\/dt><dd>1h ago <span class=meta>\(/);
    assert.match(ok, /<dt>Last check<\/dt><dd><span class="badge">HTTP 200<\/span><\/dd>/);
    assert.match(ok, /<dt>Page text<\/dt><dd>Archived<\/dd>/);
    assert.match(ok, /<a href="\/">Cancel<\/a>/);
    assert.match(await s.get('/b/2'), /<span class="badge bad">HTTP 404<\/span>/);
    const fresh = await s.get('/b/3');
    assert.match(fresh, /<dt>Description<\/dt><dd>None captured yet<\/dd>/);
    assert.match(fresh, /<dt>Last check<\/dt><dd>Not checked yet<\/dd>/);
    assert.match(fresh, /<dt>Page text<\/dt><dd>Not archived yet<\/dd>/);
    assert.match(css, /\.edit-layout\{[^}]*grid-template-columns:minmax\(0,1fr\) 20rem/);
    assert.ok(css.lastIndexOf('@media(max-width:820px){.edit-layout{grid-template-columns:1fr}}') > css.indexOf('.edit-layout{'), 'stacks on phones');
  });

  // ---------- message pages ----------
  await t.test('404 and bad-URL pages share a friendlier message page with search and ways back', async () => {
    const nf = await fetch(s.base + '/nope');
    assert.equal(nf.status, 404);
    const html = await nf.text();
    assert.match(html, /<h1>Page not found<\/h1>/);
    assert.match(html, /<div class=msg><p class=meta>Nothing lives at \/nope\.<\/p><form action="\/" role=search class=msg-search><label class=sr for=msg-q>Search your bookmarks<\/label><input id=msg-q type=search name=q placeholder="Search bookmarks"><button>Search<\/button><\/form><p class=links><a href="\/">Back to your bookmarks<\/a><a href="\/tags">Tags<\/a><\/p><\/div>/);
    const bad = await fetch(s.base + '/save?t=' + s.token);
    assert.equal(bad.status, 400);
    const badHtml = await bad.text();
    assert.match(badHtml, /<h1>Couldn&#39;t save that<\/h1>/);
    assert.match(badHtml, /No web address arrived/);
    assert.match(badHtml, /class=msg-search/);
    const missing = await fetch(s.base + '/b/9999');
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /<h1>Bookmark not found<\/h1>/);
  });
});
