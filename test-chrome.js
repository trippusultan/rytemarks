const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, bare } = require('./test-helpers');

test('chrome: toast, add composer, header, footer', async t => {
  const s = await setup(t);
  s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES ('https://a.test','A',1)").run();
  const html = await s.get('/');
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];

  await t.test('flash is a toast: fixed, fades out by itself; the delete toast with Undo stays put', async () => {
    const saved = await s.get('/?ok=saved');
    assert.match(bare(saved), /<div class="toast" role=status><span class=tick><\/span>Saved\.<\/div>/);
    assert.doesNotMatch(saved, /<p class=flash/);
    await s.post('/b/1/delete', new URLSearchParams({}));
    const del = await s.get('/?ok=deleted');
    assert.match(bare(del), /<div class="toast keep" role=status><span class=tick><\/span>Bookmark deleted\. <form method=post action="\/undo" class=inline><button>Undo<\/button><\/form><\/div>/);
    assert.match(css, /\.toast\{[^}]*position:fixed[^}]*animation:toast 4\.5s/);
    assert.match(css, /\.toast\{[^}]*width:max-content[^}]*max-width:calc\(100vw - 2rem\)/); // left:50% alone would squeeze it to half the screen
    assert.match(css, /@keyframes toast\{[^@]*opacity:0/);
    assert.match(css, /\.toast\.keep\{[^}]*animation:toast-in/);
  });

  await t.test('add form: labelled, one contained field with the button inside', () => {
    assert.match(bare(html), /<form method=post action="\/save" class=add><label class=sr for=add-url>Web address to save<\/label><input id=add-url type=text name=url inputmode=url autocomplete=off placeholder="Paste a URL to save" required><button>Save<\/button><\/form>/);
    assert.match(css, /\.add\{[^}]*background:var\(--surface\)[^}]*border:1px solid var\(--line\)/);
    assert.match(css, /\.add:focus-within\{/);
    assert.match(css, /\.sr\{[^}]*position:absolute/);
  });

  await t.test('header: Save is the only filled action; search is short, labelled, and submits on Enter', () => {
    assert.match(html, /<input type=search name=q value="" placeholder="Search bookmarks" aria-label="Search title, note and page text">/);
    assert.match(html, /<button class=sr>Search<\/button>/);
  });

  await t.test('footer: one slim bar (credit left, tool links right), no dot separators, quiet buttons', () => {
    const footer = bare(/<footer>[\s\S]*<\/footer>/.exec(html)[0]);
    assert.match(footer, /<footer><div class=fbar><div class=fl2><span>Made by <a href="https:\/\/github\.com\/trippusultan" rel="noopener noreferrer">@trippusultan<\/a><\/span><\/div>/);
    assert.match(footer, /<div class=fr2><a class=drag href="javascript:/);
    assert.match(footer, /<p class=fine>Built on Node\.js, Express, SQLite, Mozilla Readability, metascraper and jsdom\. Icons by Phosphor \(MIT\)\.<\/p>/);
    assert.doesNotMatch(footer, /Maintenance|Check links/, 'maintenance moved to the Status panel');
    assert.doesNotMatch(footer.replace(/<[^>]+>/g, ''), / · /);
    assert.match(css, /form\.inline button\{[^}]*background:transparent/);
    assert.match(css, /footer\{[^}]*display:flex[^}]*flex-direction:column/);
    assert.match(css, /\.drag\{[^}]*border:1px dashed var\(--line\)/);
  });

  await t.test('navbar: icon + label links with the current page marked', async () => {
    const nav = h => /<nav aria-label="Primary" class=topnav>.*?<\/nav>/.exec(bare(h))[0]; // scoped: the CSS text also contains "aria-current"
    assert.equal(nav(html), '<nav aria-label="Primary" class=topnav><a href="/" aria-current=page><span>Bookmarks</span></a><a href="/tags"><span>Tags</span></a><a href="/import"><span>Import</span></a></nav>');
    assert.match(nav(await s.get('/tags')), /<a href="\/">.*<a href="\/tags" aria-current=page>.*<a href="\/import">/);
    assert.match(nav(await s.get('/import')), /<a href="\/import" aria-current=page>/);
    const nope = await fetch(s.base + '/nope');
    assert.doesNotMatch(nav(await nope.text()), /aria-current/);
    assert.match(css, /\.topnav\{[^}]*display:flex/);
    assert.match(css, /\.kbd\{[^}]*white-space:nowrap/); // "Ctrl K" must not wrap onto two lines in a narrow field
    assert.match(css, /\.topnav a\[aria-current=page\]\{[^}]*box-shadow:inset 0 -2px 0 var\(--acc\)/);
  });
});
