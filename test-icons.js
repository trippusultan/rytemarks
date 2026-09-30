const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { setup } = require('./test-helpers');

const svg = n => `<svg class=ic aria-hidden=true focusable=false><use href="#i-${n}"/></svg>`;
const has = (html, lit) => assert.ok(html.includes(lit), `missing: ${lit.slice(0, 160)}`);
const tick = () => new Promise(r => setTimeout(r, 25));

test('icons, navbar, tab bar, footer', async t => {
  const s = await setup(t);
  const now = Math.floor(Date.now() / 1000);
  s.db.prepare("INSERT INTO bookmarks(url,title,saved_at,status) VALUES ('https://a.test','Alpha',?,404),('https://b.test','Beta',?,NULL)").run(now - 10, now - 20);
  s.db.prepare("INSERT INTO bookmark_tags VALUES (1, 'x')").run();
  const home = await s.get('/');
  const css = /<style>([\s\S]*?)<\/style>/.exec(home)[1];
  const open = (html, extra = {}) => new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/', ...extra });
  const key = (win, target, k, o = {}) => target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));

  await t.test('icons.js: Phosphor regular, MIT licence text included, 20 icons', () => {
    const src = fs.readFileSync(path.join(__dirname, 'icons.js'), 'utf8');
    assert.match(src, /Phosphor Icons/);
    assert.match(src, /MIT License/);
    assert.match(src, /Permission is hereby granted, free of charge/);
    assert.equal(Object.keys(require('./icons')).length, 20);
  });

  await t.test('sprite: every used icon is defined once, on every page; icons are hidden from screen readers; icon-only controls are named', async () => {
    const icons = Object.keys(require('./icons'));
    for (const p of ['/', '/tags', '/import', '/bookmarklet', '/b/1', '/nope']) {
      const html = await s.get(p);
      const defined = [...html.matchAll(/<symbol id="i-([\w-]+)" viewBox="0 0 256 256">/g)].map(m => m[1]);
      assert.deepEqual([...defined].sort(), [...icons].sort(), `${p}: sprite has each icon exactly once`);
      const used = [...html.matchAll(/<use href="#i-([\w-]+)"\/>/g)].map(m => m[1]);
      assert.ok(used.length > 0 && used.every(n => defined.includes(n)), `${p}: every <use> resolves`);
      assert.ok(!/<svg class=ic(?![^>]*aria-hidden=true)/.test(html), `${p}: every icon is aria-hidden`);
      for (const m of html.matchAll(/<(a|button)([^>]*)>\s*<svg class=ic[^>]*>.*?<\/svg>\s*<\/\1>/g)) assert.match(m[2], /aria-label=/, `${p}: icon-only ${m[1]} needs a name`);
    }
  });

  await t.test('navbar: brand, icon+label links with the current page marked, only Add on the right (no search button)', async () => {
    const nav = `<nav aria-label="Primary" class=topnav><a href="/" aria-current=page>${svg('bookmarks-simple')}<span>Bookmarks</span></a><a href="/tags">${svg('tag')}<span>Tags</span></a><a href="/import">${svg('tray-arrow-down')}<span>Import</span></a></nav>`;
    const actions = `<div class=hactions><a class="btn addbtn" href="/#add-url">${svg('plus')}<span>Add</span></a></div></header>`;
    has(home, nav + actions);
    has(await s.get('/tags'), `<a href="/">${svg('bookmarks-simple')}<span>Bookmarks</span></a><a href="/tags" aria-current=true>`.replace('aria-current=true', 'aria-current=page'));
    const header = /<header>[\s\S]*?<\/header>/.exec(home)[0];
    assert.doesNotMatch(header, /role=search/, 'the wide search field left the bar');
    const nope = await (await fetch(s.base + '/nope')).text();
    assert.doesNotMatch(/<nav aria-label="Primary" class=topnav>.*?<\/nav>/.exec(nope)[0], /aria-current/);
  });

  await t.test('tab bar for phones: Bookmarks, Tags, Import with icons and labels (no Add tab)', async () => {
    has(home, `<nav aria-label="Tabs" class=tabbar><a href="/" aria-current=page>${svg('bookmarks-simple')}<span>Bookmarks</span></a><a href="/tags">${svg('tag')}<span>Tags</span></a><a href="/import">${svg('tray-arrow-down')}<span>Import</span></a></nav>`);
    has(await s.get('/import'), `<a href="/import" aria-current=page>${svg('tray-arrow-down')}<span>Import</span></a></nav>`);
  });

  await t.test('CSS: desktop nav hides and the tab bar shows on phones (rules come after the bases); content and toasts clear the bar', () => {
    assert.match(css, /\.topnav\{[^}]*display:flex/);
    assert.match(css, /\.tabbar\{[^}]*display:none/);
    const phone = css.lastIndexOf('@media(max-width:640px){.topnav{display:none}');
    assert.ok(phone > css.indexOf('.topnav{') && phone > css.indexOf('.tabbar{'), 'phone block after both base rules');
    const block = css.slice(phone, css.indexOf('\n', phone));
    assert.match(block, /\.tabbar\{[^}]*position:fixed[^}]*bottom:0[^}]*display:grid/);
    assert.match(block, /body\{[^}]*padding-bottom:5rem/);
    assert.match(block, /\.toast\{[^}]*bottom:calc\(5\.25rem/);
    assert.match(block, /[{}]\.btn\.addbtn\{display:none\}/); // must match the base rule's specificity (.btn.addbtn), or the top-bar Add stays beside the tab bar's Add
    assert.match(css, /@media\(prefers-reduced-transparency:reduce\)\{[^@]*\.tabbar[^{]*\{[^}]*backdrop-filter:none/);
    assert.match(css, /\.tabbar a\[aria-current=page\]\{[^}]*color:var\(--acc\)/);
  });

  await t.test('behaviour: Add focuses the field, a #add-url link focuses on load, / opens the palette where there is no field', async () => {
    let win = open(home).window, d = win.document;
    d.querySelector('.addbtn').click();
    assert.equal(d.activeElement.id, 'add-url');
    d = open(home, { url: 'http://localhost/#add-url' }).window.document;
    assert.equal(d.activeElement.id, 'add-url');
    win = open(home).window; d = win.document;
    key(win, d.body, '/');
    assert.equal(d.activeElement.name, 'q', 'home: / focuses the inline search field');
    win = open(await s.get('/tags')).window; d = win.document;
    key(win, d.body, '/');
    assert.ok(d.getElementById('palette').open || d.getElementById('palette').hasAttribute('open'), 'no inline field: / opens the palette');
  });

  await t.test('home: the inline search field lives in the page (magnifier), beside the add form', () => {
    has(home, `<form action="/" role=search class=hsearch><div class=field>${svg('magnifying-glass')}<input type=search name=q value="" placeholder="Search bookmarks" aria-label="Search title, note and page text"></div><button class=sr>Search</button></form>`);
  });

  await t.test('footer: one slim bar with the credit and icon links, one fine-print line, no maintenance zone', () => {
    const footer = /<footer>[\s\S]*<\/footer>/.exec(home)[0];
    has(footer, '<footer><div class=fbar><div class=fl2>');
    has(footer, `Made by <a href="https://github.com/trippusultan" rel="noopener noreferrer">${svg('github-logo')}@trippusultan</a>`);
    has(footer, `title="Drag this to your bookmarks bar">${svg('plus')}Save to rytemarks</a>`);
    has(footer, `<a href="/bookmarklet">${svg('question')}Install help</a>`);
    has(footer, `<a href="/export?format=json">${svg('download-simple')}Export JSON</a>`);
    has(footer, `<a href="/export?format=csv">${svg('download-simple')}Export CSV</a>`);
    has(footer, '<p class=fine>Built on Node.js, Express, SQLite, Mozilla Readability, metascraper and jsdom. Icons by Phosphor (MIT).</p>');
    assert.doesNotMatch(footer.replace(/<[^>]+>/g, ' '), /Maintenance|Check links|Archive/);
    assert.match(css, /footer\{[^}]*display:flex[^}]*flex-direction:column/);
    assert.match(css, /\.fbar\{[^}]*flex-direction:column[^}]*justify-content:center/);
  });

  await t.test('Status panel now holds Check links and Archive (with icons)', () => {
    has(home, `<section class=side><h3>Status</h3><a class="stat" href="/?dead=1"><span>Dead links</span><span class="badge bad">1</span></a><p class=meta>No backup yet</p><div class=jobs><form method=post action="/check" class=inline><button>${svg('arrow-clockwise')}Check links now</button></form>`);
    has(home, `<form method=post action="/archive" class=inline><button>${svg('archive')}Archive 2 pages</button></form>`);
  });

  await t.test('icons: stat tiles, buttons, card edit and dead-link marker, feedback, empty states, dropzone, chevrons', async () => {
    has(home, `<a class=tile style="--i:0" href="/"><span class=ti>${svg('bookmarks-simple')}</span><b class=big>2</b><span>Saved</span></a>`);
    has(home, `<div class=tile style="--i:1"><span class=ti>${svg('calendar-blank')}</span><b class=big>2</b><span>This week</span></div>`);
    has(home, `<a class=tile style="--i:2" href="/tags"><span class=ti>${svg('tag')}</span>`);
    has(home, `<a class="tile bad" style="--i:3" href="/?dead=1"><span class=ti>${svg('link-break')}</span>`);
    has(home, `<form method=post action="/save" class=add>${svg('plus')}<label class=sr for=add-url>Web address to save</label>`);
    has(home, `<button>${svg('floppy-disk')}Save</button></form>`);
    assert.match(home, /<a class=edit href="\/b\/1[^"]*" aria-label="Edit Alpha"><svg class=ic aria-hidden=true focusable=false><use href="#i-pencil-simple"\/><\/svg><\/a>/);
    has(home, `<span class=dead title="HTTP 404 at last check">${svg('link-break')}<span class=sr>404</span></span>`);
    has(await s.get('/?ok=saved'), `<div class="toast" role=status><span class=tick>${svg('check-circle')}</span>Saved.</div>`);
    const imp = await s.get('/import');
    has(imp, `<input type=file id=f accept=".html,.htm"><span class=drop-i>${svg('upload-simple')}</span><span class=drop-t>`);
    has(imp, `<p id=err class=err role=alert hidden>${svg('warning-circle')}<span id=err-t></span></p>`);
    has(imp, `<button id=go type=button>${svg('download-simple')}<span id=go-t>Import</span></button>`);
    has(imp, `<summary>${svg('caret-right')}How do I export my bookmarks?</summary>`);
    has(await s.get('/bookmarklet'), `<button type=button class=ghost data-copy=code-std>${svg('copy')}<span class=bl>Copy code</span></button>`);
    has(await s.get('/tags'), `<summary>${svg('caret-right')}Edit</summary>`);
    has(await s.get('/tags'), `<button>${svg('pencil-simple')}Rename</button>`);
    assert.match(css, /details\[open\]>summary \.ic\{[^}]*transform:rotate\(90deg\)/);
    assert.match(css, /\.ic\{[^}]*width:1\.15em[^}]*height:1\.15em[^}]*fill:currentColor/);
    assert.doesNotMatch(css, /summary::before/, 'text chevron is gone');
    const edit = await s.get('/b/1?new=1');
    assert.match(edit, /<p class=flash role=status><svg class=ic aria-hidden=true focusable=false><use href="#i-check-circle"\/><\/svg> Saved/);
    has(edit, `<button>${svg('floppy-disk')}Save</button> <a href="/">Cancel</a>`);
    s.db.prepare('DELETE FROM bookmarks').run();
    has(await s.get('/'), `<div class=empty><span class=ei>${svg('bookmarks-simple')}</span><h3>Nothing saved yet</h3>`);
    has(await s.get('/tags'), `<div class=empty><span class=ei>${svg('tag')}</span><h3>No tags yet</h3>`);
  });

  await t.test('behaviour: import and copy labels change without destroying their icons', async () => {
    const imp = open(await s.get('/import')).window, d = imp.document;
    imp.fetch = async () => ({ ok: true, json: async () => ({ total: 5, fresh: 3, dupes: 2, tags: 4 }) });
    const f = d.getElementById('f');
    Object.defineProperty(f, 'files', { value: [new imp.File(['x'], 'x.html')] });
    f.dispatchEvent(new imp.Event('change'));
    await tick();
    assert.equal(d.getElementById('go-t').textContent, 'Import 3 bookmarks');
    assert.ok(d.querySelector('#go svg use[href="#i-download-simple"]'), 'icon survives');
    const b = open(await s.get('/bookmarklet')).window;
    Object.defineProperty(b.navigator, 'clipboard', { value: { writeText: async () => {} } });
    const btn = b.document.querySelector('[data-copy=code-std]');
    btn.click();
    await tick();
    assert.equal(btn.querySelector('.bl').textContent, 'Copied');
    assert.ok(btn.querySelector('svg use[href="#i-copy"]'), 'icon survives');
  });
});
