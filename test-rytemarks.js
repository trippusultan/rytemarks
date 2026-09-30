const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('rytemarks: name, logo, equal bars, terminal font', async t => {
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

  await t.test('logo is the vector tally mark plus a text wordmark "rytemarks": no image files, no static file serving', async () => {
    assert.match(html, /<a href="\/" class=brand><svg class=mark [^>]*aria-hidden=true[^>]*>[\s\S]*?<\/svg><span class=wordmark>rytemarks<\/span><\/a>/);
    assert.doesNotMatch(/<header>[\s\S]*?<\/header>/.exec(html)[0], /<img /); // cards do carry <img> favicons, so look at the header only
    assert.doesNotMatch(html, /logo-mark|logo-word|favicon\.png/);
    for (const f of ['/rytemarks-mark.png', '/rytemarks-wordmark.png', '/favicon.png', '/server.js', '/marks.db']) assert.equal((await fetch(s.base + f)).status, 404, f);
  });

  await t.test('CSS: the wordmark uses the terminal font and the mark takes the text colour on both themes', () => {
    assert.match(css, /\.wordmark\{[^}]*font-family:var\(--ui\)[^}]*letter-spacing:-\.02em/);
    assert.match(css, /\.mark\{display:block\}/);
    assert.doesNotMatch(css, /\.logo-|\.brand\{[^}]*background/);
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
