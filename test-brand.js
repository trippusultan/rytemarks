const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./test-helpers');

const RIBBON = 'M34 3h8v26l-4-4-4 4z';
const STROKES = 'M5 5v22M13 5v22M21 5v22M29 5v22';

test('brand: logo files, palette, tagline', async t => {
  const s = await setup(t);
  const html = await s.get('/');
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const board = fs.readFileSync(path.join(__dirname, 'docs', 'brand', 'brand-board.html'), 'utf8');

  await t.test('header carries the rytemarks logo files; no serif anywhere', () => {
    assert.match(html, /<a href="\/" class=brand><img class=logo-mark src="\/rytemarks-mark\.png"/);
    assert.match(html, /<img class=logo-word src="\/rytemarks-wordmark\.png" alt="rytemarks"/);
    assert.doesNotMatch(css, /(?<!sans-)serif/, 'no serif anywhere');
  });

  await t.test('the favicon is the mark on a light chip, and the supplied originals are kept as the source', () => {
    assert.match(html, /<link rel=icon type="image\/png" href="\/favicon\.png">/);
    for (const f of ['rytemarks-mark.png', 'rytemarks-wordmark.png']) assert.ok(fs.existsSync(path.join(__dirname, 'docs', 'brand', 'logo', f)), f);
  });

  await t.test('empty state says the tagline', async () => {
    assert.match(html, /<p class=tagline>Keep your place\.<\/p>/);
  });

  await t.test('brand board is self-contained and uses the app\'s mark, palette and tagline', () => {
    assert.ok(board.includes(STROKES) && board.includes(RIBBON), 'same mark paths as the app');
    for (const hex of ['#f3f6f7', '#0d1a1f', '#147863', '#0a1013', '#3fe0bd']) assert.ok(board.toLowerCase().includes(hex), hex);
    assert.match(board.replace(/<[^>]+>/g, ''), /Keep your place\./); // visible text; the board colours "place." with <em>
    assert.match(board, /Segoe UI Variable/);
    assert.doesNotMatch(board, /Iowan Old Style|Georgia/, 'the board no longer uses a serif');
    assert.doesNotMatch(board, /(src|href)="https?:|@import|url\(\s*['"]?https?:/i, 'no external resources');
  });
});
