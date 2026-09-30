const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, p) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * p + parseInt(b.slice(i, i + 2), 16) * (1 - p)).toString(16).padStart(2, '0')).join('');
const vars = block => Object.fromEntries([...block.matchAll(/--([\w-]+):(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));

test('scrollbar: themed, slim, accent on hover, Firefox fallback', async t => {
  const s = await setup(t);
  const css = /<style>([\s\S]*?)<\/style>/.exec(await s.get('/'))[1];

  await t.test('one thumb colour token, derived from the muted text colour so both themes follow it', () => {
    assert.match(css, /--sb:color-mix\(in srgb,var\(--mut\) 75%,transparent\)/);
    assert.equal((css.match(/--sb:/g) || []).length, 1, 'defined once, on :root');
  });

  await t.test('WebKit/Blink: 10px bar, transparent track, inset rounded thumb, accent on hover', () => {
    assert.match(css, /::-webkit-scrollbar\{width:10px;height:10px\}/);
    assert.match(css, /::-webkit-scrollbar-track\{background:transparent\}/);
    assert.match(css, /::-webkit-scrollbar-thumb\{[^}]*background:var\(--sb\)[^}]*border:2px solid transparent[^}]*background-clip:content-box[^}]*border-radius:var\(--r\)/);
    assert.match(css, /::-webkit-scrollbar-thumb:hover\{[^}]*background:var\(--acc\)[^}]*background-clip:content-box/);
    assert.match(css, /::-webkit-scrollbar-corner\{background:transparent\}/);
  });

  await t.test('Firefox and any engine without ::-webkit-scrollbar get the standard thin bar; Chrome keeps the WebKit rules (so hover still works)', () => {
    assert.match(css, /@supports not selector\(::-webkit-scrollbar\)\{\*\{scrollbar-width:thin;scrollbar-color:var\(--sb\) transparent\}\}/);
    assert.doesNotMatch(css.replace(/@supports not selector[^\n]*\n/, ''), /scrollbar-color|scrollbar-width/, 'the standard properties must not apply in Chrome, or they switch the WebKit rules off');
  });

  await t.test('the thumb stays visible: at least 3:1 against the page background in light and dark', () => {
    const light = vars(/:root\{([^}]*)\}/.exec(css)[1]);
    const dark = vars(/prefers-color-scheme:dark\)\{:root\{([^}]*)\}/.exec(css)[1]);
    for (const [name, p] of [['light', light], ['dark', dark]]) {
      const thumb = mix(p.mut, p.bg, 0.75);
      assert.ok(contrast(thumb, p.bg) >= 3, `${name}: ${contrast(thumb, p.bg).toFixed(2)}:1`);
      assert.ok(contrast(thumb, p.surface) >= 3, `${name} on surface: ${contrast(thumb, p.surface).toFixed(2)}:1`);
    }
  });
});
