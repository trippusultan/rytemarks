const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('chrome: toast, add composer, header, footer', async t => {
  const s = await setup(t);
  s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES ('https://a.test','A',1)").run();
  const html = await s.get('/');
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];

  await t.test('flash is a toast: fixed, fades out by itself; the delete toast with Undo stays put', async () => {
    const saved = await s.get('/?ok=saved');
    assert.match(saved, /<div class="toast" role=status><span class=tick>✓<\/span>Saved\.<\/div>/);
    assert.doesNotMatch(saved, /<p class=flash/);
    await s.post('/b/1/delete', new URLSearchParams({}));
    const del = await s.get('/?ok=deleted');
    assert.match(del, /<div class="toast keep" role=status><span class=tick>✓<\/span>Bookmark deleted\. <form method=post action="\/undo" class=inline><button>Undo<\/button><\/form><\/div>/);
    assert.match(css, /\.toast\{[^}]*position:fixed[^}]*animation:toast 4\.5s/);
    assert.match(css, /\.toast\{[^}]*width:max-content[^}]*max-width:calc\(100vw - 2rem\)/); // left:50% alone would squeeze it to half the screen
    assert.match(css, /@keyframes toast\{[^@]*opacity:0/);
    assert.match(css, /\.toast\.keep\{[^}]*animation:toast-in/);
  });

  await t.test('add form: labelled, one contained field with the button inside', () => {
    assert.match(html, /<form method=post action="\/save" class=add><label class=sr for=add-url>Web address to save<\/label><input id=add-url type=text name=url inputmode=url autocomplete=off placeholder="Paste a URL to save" required><button>Save<\/button><\/form>/);
    assert.match(css, /\.add\{[^}]*background:var\(--surface\)[^}]*border:1px solid var\(--line\)/);
    assert.match(css, /\.add:focus-within\{/);
    assert.match(css, /\.sr\{[^}]*position:absolute/);
  });

  await t.test('header: Save is the only filled action; search is short, labelled, and submits on Enter', () => {
    assert.match(html, /<input type=search name=q value="" placeholder="Search bookmarks" aria-label="Search title, note and page text">/);
    assert.match(html, /<button class=sr>Search<\/button>/);
  });

  await t.test('footer: tools left, maintenance right, no dot separators, quiet buttons', () => {
    const footer = /<footer>[\s\S]*<\/footer>/.exec(html)[0];
    assert.match(footer, /<div class=fl><a class=drag href="javascript:/);
    assert.match(footer, /<div class=jobs><form method=post action="\/check" class=inline><button>Check links now<\/button><\/form>/);
    assert.doesNotMatch(footer.replace(/<[^>]+>/g, ''), / · /);
    assert.match(css, /form\.inline button\{[^}]*background:transparent/);
    assert.match(css, /footer\{[^}]*display:flex[^}]*justify-content:space-between/);
    assert.match(css, /\.drag\{[^}]*border:1px dashed var\(--line\)/);
  });
});
