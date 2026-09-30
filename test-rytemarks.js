const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('rytemarks: name, logo files, equal bars, terminal font', async t => {
  const s = await setup(t);
  s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES ('https://a.test','A',1)").run();
  const html = await s.get('/');
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];

  await t.test('the app is called rytemarks: title, bookmarklet, footer chip, success page', async () => {
    assert.match(html, /<title>rytemarks<\/title>/);
    assert.match(html, /Save to rytemarks<\/a>/);
    assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, ''), /(?<![a-z])marks(?![a-z])/i, 'no bare "marks" left in the page');
    const bl = await s.get('/bookmarklet');
    assert.match(bl, /saves it to rytemarks\./);
    assert.match(bl, /\+ Save to rytemarks<\/a>/);
    assert.match(bl, /\+ Save to rytemarks \(simple\)<\/a>/);
    const done = await (await s.post('/b/1', new URLSearchParams({ note: '', done: '1' }))).text();
    assert.match(done, /<a href="\/">Open rytemarks<\/a>/);
  });

  await t.test('header shows the supplied logo (mark + wordmark, named for screen readers); footer credit has no logo', () => {
    assert.match(html, /<a href="\/" class=brand><img class=logo-mark src="\/rytemarks-mark\.png" alt="" width=17 height=34><img class=logo-word src="\/rytemarks-wordmark\.png" alt="rytemarks" width=125 height=24><\/a>/);
    assert.match(html, /<link rel=icon type="image\/png" href="\/favicon\.png">/);
    assert.doesNotMatch(html, /class=wordmark|class=mark /);
  });

  await t.test('logo files are served from public/ only', async () => {
    for (const f of ['/rytemarks-mark.png', '/rytemarks-wordmark.png', '/favicon.png']) {
      const r = await fetch(s.base + f);
      assert.equal(r.status, 200, f);
      assert.equal(r.headers.get('content-type'), 'image/png', f);
      assert.equal(Buffer.from(await r.arrayBuffer()).subarray(1, 4).toString(), 'PNG', f);
    }
    for (const f of ['/server.js', '/package.json', '/marks.db', '/public/favicon.png']) assert.equal((await fetch(s.base + f)).status, 404, f);
  });

  await t.test('CSS: slate logo sits on a light chip in the dark theme, plain on light', () => {
    assert.match(css, /\.brand\{[^}]*height:/);
    assert.match(css, /\.logo-mark\{[^}]*height:34px/);
    assert.match(css, /@media\(prefers-color-scheme:dark\)\{[^@]*\.brand\{[^}]*background:#f3f6f7/);
  });

  await t.test('CSS: search and add bars are one height, on desktop and on phones', () => {
    assert.match(css, /\.bar2 \.field,\.bar2 \.add\{[^}]*height:3rem/);
    assert.match(css, /\.bar2 \.field input,\.bar2 \.add input\{[^}]*height:100%[^}]*padding:0/);
    assert.match(css, /\.bar2 \.add button\{[^}]*align-self:stretch/);
    assert.doesNotMatch(css, /@media\(max-width:640px\)\{[^@]*\.bar2 \.(field|add)\{[^}]*height:/, 'phones keep the same height');
  });

  await t.test('CSS: terminal font everywhere: one local monospace stack, no sans or serif files', () => {
    assert.match(css, /--mono:"Cascadia Mono","Cascadia Code","JetBrains Mono","SF Mono",ui-monospace,Menlo,Consolas,"Liberation Mono",monospace/);
    assert.match(css, /--ui:var\(--mono\)/);
    assert.match(css, /body\{[^}]*font:14px\/1\.6 var\(--ui\)/);
    assert.doesNotMatch(css, /Segoe UI|system-ui|sans-serif|var\(--sans\)/);
    assert.doesNotMatch(css, /@import|@font-face|url\(\s*['"]?https?:/i);
    assert.doesNotMatch(css, /letter-spacing:-\.0[3-9]/, 'monospace is already tight: no heavy negative tracking');
    assert.match(css, /input,textarea\{font:inherit/);
    assert.match(css, /button\{font:inherit/);
  });
});
