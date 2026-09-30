const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, bare } = require('./test-helpers');

const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, p) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * p + parseInt(b.slice(i, i + 2), 16) * (1 - p)).toString(16).padStart(2, '0')).join('');
const vars = block => Object.fromEntries([...block.matchAll(/--([\w-]+):(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));

test('glow: hero stats, ambient light, glass, type scale, grain', async t => {
  const s = await setup(t);
  const now = Math.floor(Date.now() / 1000), day = 86400;
  const ins = s.db.prepare('INSERT INTO bookmarks(url,title,saved_at,status) VALUES (?,?,?,?)');
  ins.run('https://a.test', 'A recent', now - 60, null);
  ins.run('https://b.test', 'B inside window', now - 7 * day + 120, null);
  ins.run('https://c.test', 'C just outside', now - 7 * day - 120, null);
  ins.run('https://d.test', 'D old', now - 40 * day, 404);
  s.db.prepare("INSERT INTO bookmark_tags VALUES (1, 'x'), (2, 'x'), (2, 'y')").run();
  const html = await s.get('/');
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];

  await t.test('hero: a display heading over four live stat tiles with real numbers', () => {
    assert.match(bare(html), /<section class=hero aria-label="Library overview"><h1>Your library<\/h1><div class=stats><a class=tile style="--i:0" href="\/"><span class=ti><\/span><b class=big>4<\/b><span>Saved<\/span><\/a><div class=tile style="--i:1"><span class=ti><\/span><b class=big>2<\/b><span>This week<\/span><\/div><a class=tile style="--i:2" href="\/tags"><span class=ti><\/span><b class=big>2<\/b><span>Tags<\/span><\/a><a class="tile bad" style="--i:3" href="\/\?dead=1"><span class=ti><\/span><b class=big>1<\/b><span>Dead links<\/span><\/a><\/div><\/section>/);
  });

  await t.test('hero: hidden when filtering, searching, viewing dead links, or when the archive is empty', async () => {
    for (const p of ['/?q=recent', '/?tag=x', '/?dead=1']) assert.doesNotMatch(await s.get(p), /class=hero/, p);
    s.db.prepare('DELETE FROM bookmarks').run();
    const empty = await s.get('/');
    assert.doesNotMatch(empty, /class=hero/);
    assert.match(empty, /Nothing saved yet/);
  });

  await t.test('CSS: ambient light is fixed, click-through, behind everything, one accent hue', () => {
    assert.match(css, /body::before\{[^}]*position:fixed[^}]*z-index:-1[^}]*pointer-events:none[^}]*radial-gradient/);
    assert.match(css, /--glow:\d+%/);
    assert.ok((css.match(/radial-gradient\([^)]*var\(--acc\) var\(--glow\)/g) || []).length >= 2, 'built from the accent only');
    assert.doesNotMatch(css, /radial-gradient\([^)]*#[0-9a-f]{6}/i, 'no second hue');
  });

  await t.test('CSS: grain is a faint, fixed, click-through overlay made locally', () => {
    assert.match(css, /body::after\{[^}]*position:fixed[^}]*pointer-events:none[^}]*opacity:var\(--grain\)[^}]*feTurbulence/);
    const grains = [...css.matchAll(/--grain:(\.\d+)/g)].map(m => +m[1]);
    assert.ok(grains.length === 2 && grains.every(g => g > 0 && g <= 0.08), grains.join(','));
  });

  await t.test('CSS: glass on header, panels, toast and palette; cards translucent without blur; solid fallback', () => {
    for (const sel of ['\\.side', '\\.toast', '#palette']) assert.match(css, new RegExp(`${sel}\\{[^}]*backdrop-filter:blur`), sel);
    const card = /\.card\{[^}]*\}/.exec(css)[0];
    assert.match(card, /background:color-mix\(in srgb,var\(--surface\) 78%,transparent\)/);
    assert.doesNotMatch(card, /backdrop-filter/, 'no blur on up to 100 cards');
    assert.match(css, /@media\(prefers-reduced-transparency:reduce\)\{[^@]*\.card,\.side,\.toast,#palette\{[^}]*backdrop-filter:none/);
    assert.match(css, /\.card\{[^}]*inset 0 1px 0 color-mix/);
  });

  await t.test('CSS: text stays readable over the glow and the glass, in both themes', () => {
    const light = vars(/:root\{([^}]*)\}/.exec(css)[1]);
    const dark = vars(/prefers-color-scheme:dark\)\{:root\{([^}]*)\}/.exec(css)[1]);
    const glows = [...css.matchAll(/--glow:(\d+)%/g)].map(m => +m[1] / 100); // light, dark
    const cardPct = +/\.card\{[^}]*color-mix\(in srgb,var\(--surface\) (\d+)%/.exec(css)[1] / 100;
    [light, dark].forEach((p, i) => {
      const page = mix(p.acc, p.bg, glows[i]);          // worst case: full glow behind the page
      const card = mix(p.surface, page, cardPct);       // translucent card over it
      for (const bg of [page, card]) {
        assert.ok(contrast(p.fg, bg) >= 7, 'body text');
        assert.ok(contrast(p.mut, bg) >= 4.5, 'muted text');
        assert.ok(contrast(p.acc, bg) >= 4.5, 'accent text');
        assert.ok(contrast(p.bad, bg) >= 4.5, 'warning text');
      }
    });
  });

  await t.test('CSS: bolder type scale and a phone layout for the tiles', () => {
    assert.match(css, /h1\{[^}]*font-size:clamp\(1\.9rem,4\.4vw,3rem\)[^}]*letter-spacing:-\.02em/);
    assert.match(css, /\.card \.t\{[^}]*font-size:1\.06rem/);
    assert.match(css, /\.card\.feat \.t\{[^}]*font-size:1\.4rem/);
    assert.match(css, /\.big\{[^}]*font-family:var\(--mono\)/);
    assert.match(css, /\.stats\{[^}]*grid-template-columns:repeat\(4,1fr\)/);
    assert.ok(css.lastIndexOf('@media(max-width:640px){.stats{grid-template-columns:repeat(2,1fr)}}') > css.indexOf('.stats{'), 'two by two on phones');
  });
});
