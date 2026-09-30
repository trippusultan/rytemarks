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

  await t.test('footer: three quiet zones (tools, maintenance, about), no dot separators, quiet buttons', () => {
    const footer = /<footer>[\s\S]*<\/footer>/.exec(html)[0];
    assert.match(footer, /<div class=fz><h3>Tools<\/h3><div class=fl><a class=drag href="javascript:/);
    assert.match(footer, /<div class=fz><h3>Maintenance<\/h3><div class=jobs><form method=post action="\/check" class=inline><button>Check links now<\/button><\/form>/);
    assert.match(footer, /<div class="fz about"><h3>About<\/h3><p>Made by <a href="https:\/\/github\.com\/trippusultan" rel="noopener noreferrer">@trippusultan<\/a><\/p><p>Built on Node\.js, Express, SQLite, Mozilla Readability, metascraper and jsdom\.<\/p><\/div>/);
    assert.doesNotMatch(footer.replace(/<[^>]+>/g, ''), / · /);
    assert.match(css, /form\.inline button\{[^}]*background:transparent/);
    assert.match(css, /footer\{[^}]*display:grid[^}]*grid-template-columns:/);
    assert.ok(css.lastIndexOf('@media(max-width:700px){footer{grid-template-columns:1fr}}') > css.indexOf('footer{max-width:1200px'), 'phone stack comes after the base footer rule');
    assert.match(css, /\.drag\{[^}]*border:1px dashed var\(--line\)/);
  });

  await t.test('navbar: primary links on the right with the current page marked', async () => {
    assert.match(html, /<nav aria-label="Primary"><a href="\/" aria-current=page>Bookmarks<\/a><a href="\/tags">Tags<\/a><a href="\/import">Import<\/a><\/nav><\/header>/);
    assert.match(await s.get('/tags'), /<nav aria-label="Primary"><a href="\/">Bookmarks<\/a><a href="\/tags" aria-current=page>Tags<\/a><a href="\/import">Import<\/a><\/nav>/);
    assert.match(await s.get('/import'), /<a href="\/import" aria-current=page>Import<\/a>/);
    const nope = await fetch(s.base + '/nope');
    const nav404 = /<nav aria-label="Primary">.*?<\/nav>/.exec(await nope.text())[0]; // scoped: the CSS text also contains "aria-current"
    assert.doesNotMatch(nav404, /aria-current/);
    assert.match(css, /header nav\{[^}]*display:flex/);
    assert.match(css, /\.kbd\{[^}]*white-space:nowrap/); // "Ctrl K" must not wrap onto two lines in a narrow field
    assert.match(css, /header nav a\[aria-current=page\]\{[^}]*box-shadow:inset 0 -2px 0 var\(--acc\)/);
    assert.ok(css.lastIndexOf('@media(max-width:640px){header nav{order:3;width:100%;overflow-x:auto}}') > css.indexOf('header nav{'), 'second scrollable row on phones');
    // brand and search share the first phone row, and the (now taller) header scrolls away instead of eating the screen
    const phone = css.lastIndexOf('@media(max-width:640px){header{position:static}header form{min-width:0}}');
    assert.ok(phone > css.indexOf('header form{flex:1'), 'phone header override comes after the base form rule');
  });
});
