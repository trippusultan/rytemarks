const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./test-helpers');

const RIBBON = 'M34 3h8v26l-4-4-4 4z';
const STROKES = 'M5 5v22M13 5v22M21 5v22M29 5v22';

test('brand: light editorial, tally mark, serif wordmark', async t => {
  const s = await setup(t);
  const html = await s.get('/');
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const board = fs.readFileSync(path.join(__dirname, 'docs', 'brand', 'brand-board.html'), 'utf8');

  await t.test('header carries the tally mark and a serif wordmark', () => {
    assert.match(html, /<a href="\/" class=brand><svg class=mark [^>]*aria-hidden=true/);
    assert.ok(html.includes(STROKES) && html.includes(RIBBON), 'mark paths');
    assert.match(html, /<span class=wordmark>marks<\/span>/);
    assert.match(css, /--serif:[^;}]*Iowan Old Style[^;}]*Georgia[^;}]*serif/);
    assert.match(css, /\.wordmark\{[^}]*font-family:var\(--serif\)/);
    assert.match(css, /h2,h3\{[^}]*font-family:var\(--serif\)/);
  });

  await t.test('the favicon is the same mark', () => {
    const icon = decodeURIComponent(/<link rel=icon href="([^"]+)"/.exec(html)[1]);
    assert.ok(icon.includes('M22 6h5v20l-2.5-3-2.5 3z'), 'ribbon in favicon');
  });

  await t.test('empty state says the tagline', async () => {
    assert.match(html, /<p class=tagline>Keep your place\.<\/p>/);
  });

  await t.test('brand board is self-contained and uses the app\'s mark, palette and tagline', () => {
    assert.ok(board.includes(STROKES) && board.includes(RIBBON), 'same mark paths as the app');
    for (const hex of ['#fbfaf7', '#1d1d1a', '#2f6f5e', '#131412', '#6fbfa6']) assert.ok(board.toLowerCase().includes(hex), hex);
    assert.match(board.replace(/<[^>]+>/g, ''), /Keep your place\./); // visible text; the board colours "place." with <em>
    assert.match(board, /Iowan Old Style/);
    assert.doesNotMatch(board, /(src|href)="https?:|@import|url\(\s*['"]?https?:/i, 'no external resources');
  });
});
