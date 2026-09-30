const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hsl = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const M = Math.max(r, g, b), m = Math.min(r, g, b), l = (M + m) / 2, d = M - m;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : M === r ? ((g - b) / d) % 6 : M === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100 };
};
const vars = block => Object.fromEntries([...block.matchAll(/--([\w-]+):(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));

test('design rules', async t => {
  const s = await setup(t);
  const html = await s.get('/');
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const light = vars(/:root\{([^}]*)\}/.exec(css)[1]);
  const dark = vars(/prefers-color-scheme:dark\)\{:root\{([^}]*)\}/.exec(css)[1]);

  for (const [name, p] of [['light', light], ['dark', dark]]) {
    await t.test(`${name} theme is readable (WCAG AA) and uses one on-accent colour`, () => {
      assert.ok(p['on-acc'], 'defines --on-acc');
      assert.ok(contrast(p.fg, p.bg) >= 7, 'body text');
      assert.ok(contrast(p.mut, p.bg) >= 4.5, 'muted text');
      assert.ok(contrast(p.acc, p.bg) >= 4.5, 'accent used as link text');
      assert.ok(contrast(p['on-acc'], p.acc) >= 4.5, 'text on accent buttons');
      assert.ok(contrast(p.bad, p.bg) >= 4.5, 'warning colour');
    });
  }

  await t.test('one desaturated accent, same hue family in both themes', () => {
    const [a, b] = [hsl(light.acc), hsl(dark.acc)];
    assert.ok(a.s < 60 && b.s < 60, `saturation ${a.s.toFixed(0)}/${b.s.toFixed(0)}`);
    assert.ok(Math.abs(a.h - b.h) < 20, `hue ${a.h.toFixed(0)} vs ${b.h.toFixed(0)}`);
    assert.doesNotMatch(css, /#2f6fed|#7aa2ff/i, 'old blue is gone');
    assert.doesNotMatch(css, /#fd0/i, 'no second (yellow) accent');
  });

  await t.test('local fonts only: a named system stack, no font files or third-party CSS', () => {
    assert.match(css, /Segoe UI Variable/);
    assert.match(css, /system-ui/);
    assert.doesNotMatch(css, /@import|@font-face|url\(\s*['"]?https?:/i);
    assert.doesNotMatch(html, /<link[^>]+href="https?:/i);
  });

  await t.test('weight hierarchy beyond regular and bold', () => {
    assert.match(css, /li\.b>div>a:first-child\{font-weight:500\}/); // list titles only, not the first tag in the meta line
    assert.match(css, /font-weight:\s*600/); // headings, labels
    assert.match(css, /letter-spacing:\s*-\.\d+em/); // tighter heading tracking
  });

  await t.test('inline favicon, so browsers stop requesting /favicon.ico', () => {
    assert.match(html, /<link rel=icon href="data:image\/svg\+xml,/);
  });

  await t.test('meta description and theme-color that match the palette', () => {
    assert.match(html, /<meta name=description content="[^"]+">/);
    assert.match(html, new RegExp(`<meta name=theme-color content="${light.bg}" media="\\(prefers-color-scheme: light\\)">`));
    assert.match(html, new RegExp(`<meta name=theme-color content="${dark.bg}" media="\\(prefers-color-scheme: dark\\)">`));
  });

  await t.test('landmarks and a skip link that comes first', () => {
    assert.equal((html.match(/<main[ >]/g) || []).length, 1, 'exactly one <main>');
    assert.match(html, /<main id=main>/);
    assert.ok(html.indexOf('class=skip') < html.indexOf('<header>'), 'skip link before header');
    assert.match(html, /<a class=skip href="#main">Skip to content<\/a>/);
    assert.match(html, /<form action="\/" role=search>/);
    assert.match(html, /<aside aria-label="Tags and status">/);
    assert.match(css, /\.skip:focus\{/);
  });

  await t.test('pressed feedback and transitions, switched off for reduced motion', () => {
    assert.match(css, /transition:[^;}]*\.15s/);
    assert.match(css, /button:active[^{]*\{[^}]*scale\(\.98\)/);
    assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{[^@]*transition:none/);
  });

  await t.test('type polish: balanced headings, tabular numerals', () => {
    assert.match(css, /text-wrap:balance/);
    assert.match(css, /font-variant-numeric:tabular-nums/);
  });

  await t.test('unknown URLs get a branded 404 with a way back', async () => {
    const res = await fetch(s.base + '/nope/%3Cscript%3Ealert(1)%3C/script%3E');
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.match(body, /Page not found/);
    assert.match(body, /<a href="\/">/);
    assert.doesNotMatch(body, /<script>alert/);
    const post = await s.post('/nope', '');
    assert.equal(post.status, 404);
  });
});
