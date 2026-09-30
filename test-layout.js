const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('layout: three-zone header, centred column, centred footer, roomier phone navbar', async t => {
  const s = await setup(t);
  s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES ('https://a.test','A',1)").run();
  const html = await s.get('/');
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const phoneAt = css.lastIndexOf('@media(max-width:640px){.topnav{display:none}');
  const phone = css.slice(phoneAt, css.indexOf('\n', phoneAt));

  await t.test('header: brand, then nav, then actions; a 1fr auto 1fr grid keeps the nav on the page centre', () => {
    assert.match(html, /<header><a href="\/" class=brand>.*?<\/a><nav aria-label="Primary" class=topnav>.*?<\/nav><div class=hactions>/);
    assert.match(css, /header\{[^}]*display:grid[^}]*grid-template-columns:1fr auto 1fr[^}]*min-height:68px/);
    assert.match(css, /\.brand\{[^}]*justify-self:start/);
    assert.match(css, /\.hactions\{[^}]*justify-self:end/);
    assert.doesNotMatch(css, /\.topnav\{[^}]*margin-right:auto/, 'nav no longer hugs the logo');
    assert.match(css, /\.topnav a\{[^}]*padding:\.5rem \.9rem/);
    assert.match(css, /\.topnav a\[aria-current=page\]\{[^}]*box-shadow:inset 0 -3px 0 var\(--acc\)/);
  });

  await t.test('no search button in the header on any page; only Add stays on the right', async () => {
    for (const p of ['/', '/tags', '/import', '/bookmarklet', '/nope']) {
      const page = await s.get(p);
      const header = /<header>[\s\S]*?<\/header>/.exec(page)[0];
      assert.doesNotMatch(header, /magnifying-glass|open-palette|searchbtn|Search/, p);
      assert.match(header, /<div class=hactions><a class="btn addbtn" href="\/#add-url">.*<\/a><\/div><\/header>/, p);
      assert.doesNotMatch(page, /class=kbd|Ctrl K/, p);
    }
    assert.doesNotMatch(css, /\.searchbtn|\.kbd\{/);
  });

  await t.test('one centred 1120px column for header, page and footer', () => {
    assert.doesNotMatch(css, /1200px/);
    assert.match(css, /header\{[^}]*padding:\.9rem max\(1\.25rem,calc\(\(100vw - 1120px\)\/2 \+ 1\.25rem\)\)/); // the logo lines up with the page content, not the column edge
    assert.match(css, /main\{[^}]*max-width:1120px[^}]*margin:0 auto/);
    assert.match(css, /footer\{[^}]*max-width:1120px[^}]*margin:0 auto/);
  });

  await t.test('the hero heading and its stat tiles are centred; the grid and sidebar keep their reading alignment', () => {
    assert.match(css, /\.hero\{[^}]*text-align:center/);
    assert.match(css, /\.tile\{[^}]*align-items:center[^}]*text-align:center/);
    assert.doesNotMatch(css, /\.card\{[^}]*text-align:center/);
    assert.doesNotMatch(css, /aside\{[^}]*text-align:center/);
  });

  await t.test('footer: everything centred in one stack with generous padding', () => {
    assert.match(css, /footer\{[^}]*padding:2\.5rem 1\.25rem 3\.5rem[^}]*align-items:center[^}]*text-align:center/);
    assert.match(css, /\.fbar\{[^}]*flex-direction:column[^}]*justify-content:center/);
    assert.match(css, /\.fl2\{[^}]*justify-content:center/);
    assert.match(css, /\.fr2\{[^}]*justify-content:center[^}]*gap:\.6rem 1\.4rem/);
  });

  await t.test('phone: the header is just the centred logo (no actions), links live in the tab bar', () => {
    assert.ok(phoneAt > css.indexOf('.tabbar{display:none}') && phoneAt > css.indexOf('header{position:sticky') && phoneAt > css.indexOf('.brand{'), 'phone block comes after the base rules');
    assert.match(phone, /header\{[^}]*grid-template-columns:1fr[;}][^}]*justify-items:center[^}]*padding:\.6rem 1rem/);
    assert.match(phone, /\.brand\{[^}]*justify-self:center/);
    assert.match(phone, /\.hactions\{display:none\}/);
  });

  await t.test('phone tab bar: three tabs (no Add), taller, pill on the current tab, page and toast clear it', () => {
    assert.match(phone, /\.tabbar\{[^}]*grid-template-columns:repeat\(3,1fr\)[^}]*min-height:60px[^}]*calc\(\.4rem \+ env\(safe-area-inset-bottom\)\)/);
    assert.doesNotMatch(css, /tabadd/);
    assert.match(phone, /body\{[^}]*padding-bottom:5rem/);
    assert.match(phone, /\.toast\{[^}]*bottom:calc\(5\.25rem \+ env\(safe-area-inset-bottom\)\)/);
    assert.match(css, /\.tabbar a\[aria-current=page\]\{[^}]*background:color-mix\(in srgb,var\(--acc\) 9%,transparent\)/); // small enough tint that acc text keeps 4.5:1
    assert.match(css, /\.tabbar \.ic\{font-size:1\.5em\}/);
  });
});
