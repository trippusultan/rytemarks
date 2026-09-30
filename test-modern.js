const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup, bare } = require('./test-helpers');

test('modern UI: bento, toggle, palette, keyboard, motion', async t => {
  const s = await setup(t);
  const now = Math.floor(Date.now() / 1000);
  const ins = s.db.prepare('INSERT INTO bookmarks(url,title,note,saved_at) VALUES (?,?,?,?)');
  ins.run('https://a.test/one', 'Alpha one', '', now - 10);
  ins.run('https://b.test/two', 'Beta two', 'has a note', now - 20);
  ins.run('https://c.test/three', 'Gamma three', '', now - 30);
  ins.run('https://d.test/four', 'Delta four', '', now - 40);
  s.db.prepare("INSERT INTO bookmark_tags VALUES (4, 'reading')").run();
  const html = await s.get('/');
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const open = (h = html, extra = {}) => new JSDOM(h, { runScripts: 'dangerously', url: 'http://localhost/', ...extra });
  const key = (win, target, k, o = {}) => target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));

  await t.test('bento cards: newest is featured, cards with notes are taller, index drives the stagger', () => {
    assert.match(html, /<ul class=bento>/);
    const cards = [...html.matchAll(/<li class="card([^"]*)" style="--i:(\d+)">/g)];
    assert.equal(cards.length, 4);
    assert.match(cards[0][1], /feat/);
    assert.doesNotMatch(cards[1][1], /feat/);
    assert.match(cards[1][1], /tall/);
    assert.deepEqual(cards.map(c => +c[2]), [0, 1, 2, 3]);
    assert.match(html, /<span class=dom>a\.test<\/span>/);
    assert.match(html, /<a class="t" href="https:\/\/a\.test\/one">Alpha one<\/a>/);
  });

  await t.test('cards / list toggle is remembered per browser', () => {
    assert.match(html, /<button type=button class=vt data-view=cards aria-pressed=true>Cards<\/button>/);
    const d = open().window.document;
    assert.equal(d.documentElement.dataset.view, 'cards');
    d.querySelector('.vt[data-view=list]').click();
    assert.equal(d.documentElement.dataset.view, 'list');
    assert.equal(d.querySelector('.vt[data-view=list]').getAttribute('aria-pressed'), 'true');
    assert.equal(d.querySelector('.vt[data-view=cards]').getAttribute('aria-pressed'), 'false');
    const again = open(html, { beforeParse: w => w.localStorage.setItem('marks-view', 'list') }).window.document;
    assert.equal(again.documentElement.dataset.view, 'list');
  });

  await t.test('Ctrl+K command palette: filters, searches, jumps to tags, saves a URL', () => {
    assert.match(html, /<a class=searchbtn id=open-palette href="\/" aria-label="Search bookmarks">/);
    const dom = open(), win = dom.window, d = win.document;
    const dlg = d.getElementById('palette'), inp = d.getElementById('pal-q');
    key(win, d, 'k', { ctrlKey: true });
    assert.ok(dlg.open || dlg.hasAttribute('open'), 'opens on Ctrl+K');
    const type = v => { inp.value = v; inp.dispatchEvent(new win.Event('input', { bubbles: true })); };
    const labels = () => [...d.querySelectorAll('#pal-list a')].map(a => a.textContent);
    type('imp');
    assert.ok(labels().includes('Import bookmarks'));
    type('read');
    assert.ok(labels().includes('#reading'));
    assert.equal(d.querySelector('#pal-list a[href="/?tag=reading"]')?.textContent, '#reading');
    type('hello world');
    assert.equal(d.querySelector('#pal-list a').getAttribute('href'), '/?q=hello%20world');
    let clicked = false;
    const first = d.querySelector('#pal-list a[aria-selected=true]');
    first.addEventListener('click', e => { e.preventDefault(); clicked = true; });
    key(win, inp, 'Enter');
    assert.ok(clicked, 'Enter activates the selected item');
    type('https://new.test/page');
    assert.match(d.querySelector('#pal-list a').textContent, /^Save /);
    let saved = null;
    const form = d.getElementById('pal-save');
    form.addEventListener('submit', e => { e.preventDefault(); saved = form.elements.url.value; });
    key(win, inp, 'Enter');
    assert.equal(saved, 'https://new.test/page');
    type('');
    key(win, inp, 'ArrowDown');
    assert.equal(d.querySelectorAll('#pal-list a[aria-selected=true]').length, 1);
  });

  await t.test('j/k move through cards, e edits, typing in a field is left alone', () => {
    const win = open().window, d = win.document;
    const links = [...d.querySelectorAll('.card a.t')];
    key(win, d.body, 'j'); assert.equal(d.activeElement, links[0]);
    key(win, d.body, 'j'); assert.equal(d.activeElement, links[1]);
    key(win, d.body, 'k'); assert.equal(d.activeElement, links[0]);
    let edited = false;
    d.activeElement.closest('.card').querySelector('a.edit').addEventListener('click', e => { e.preventDefault(); edited = true; });
    key(win, d.body, 'e');
    assert.ok(edited);
    const q = d.querySelector('input[name=q]'); q.focus();
    key(win, q, 'j');
    assert.equal(d.activeElement, q);
  });

  await t.test('sidebar: a tag cloud with counts, a status row, a manage link', () => {
    assert.match(html, /<aside aria-label="Tags and status"><section class=side>/);
    assert.match(html, /<h3>Tags <span class=n>1<\/span><\/h3>/);
    assert.match(html, /<div class=cloud><a href="\/\?tag=reading" class="tc">#reading <span class=n>1<\/span><\/a><\/div>/);
    assert.match(html, /<a class=more href="\/tags">Manage tags<\/a>/);
    assert.match(bare(html), /<section class=side><h3>Status<\/h3><a class="stat" href="\/\?dead=1"><span>Dead links<\/span><span class="badge">0<\/span><\/a><div class=jobs><form method=post action="\/check" class=inline><button>Check links now<\/button><\/form><form method=post action="\/archive" class=inline><button>Archive \d+ pages<\/button><\/form><\/div><\/section>/);
  });

  await t.test('CSS: sidebar panels, chips with active state, badge', () => {
    assert.match(css, /\.side\{[^}]*background:color-mix\(in srgb,var\(--surface\) 78%,transparent\)/);
    assert.match(css, /\.tc\.on\{[^}]*background:var\(--acc\)/);
    assert.match(css, /\.tc\{[^}]*max-width:100%[^}]*overflow-wrap:anywhere/); // a very long tag wraps inside the narrow panel
    assert.match(css, /\.badge\.bad\{[^}]*color:var\(--bad\)/);
    assert.match(css, /aside\{[^}]*flex-direction:column/);
    assert.ok(css.lastIndexOf('@media(max-width:700px){aside{position:static') > css.indexOf('aside{position:sticky'), 'phone override comes after the sticky rule');
  });

  await t.test('CSS: sticky translucent header with a solid fallback', () => {
    assert.match(css, /header\{[^}]*position:sticky[^}]*backdrop-filter:blur/);
    assert.match(css, /@media\(prefers-reduced-transparency:reduce\)\{header\{[^}]*backdrop-filter:none/);
  });

  await t.test('CSS: staggered rise animates only transform and opacity, and is off for reduced motion', () => {
    assert.match(css, /\.card\{[^}]*animation:rise[^}]*var\(--i\)/);
    const props = /@keyframes rise\{from\{([^}]*)\}\}/.exec(css)[1].split(';').filter(Boolean).map(p => p.split(':')[0]);
    assert.ok(props.every(p => ['opacity', 'transform'].includes(p)), props.join(','));
    assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{[^@]*animation:none/);
  });

  await t.test('CSS: the phone override for the featured card comes after the base span rule (single column)', () => {
    const base = css.indexOf('.card.feat{grid-column:span 2}');
    const phone = css.lastIndexOf('.card.feat{grid-column:auto}');
    assert.ok(base > -1 && phone > base, 'a later rule wins at equal specificity');
    assert.match(css, /@media\(max-width:640px\)\{[^@]*\.bento\{grid-template-columns:1fr\}/);
  });

  await t.test('CSS: list view stacks on phones so titles are not squeezed', () => {
    const rule = /@media\(max-width:640px\)\{html\[data-view=list\] \.card \.top\{width:100%\}html\[data-view=list\] \.card \.t\{flex-basis:100%;/.exec(css);
    assert.ok(rule, 'phone rule for list view exists');
    assert.ok(css.indexOf(rule[0]) > css.indexOf('html[data-view=list] .card .t{flex:1'), 'and comes after the base list rules');
  });

  await t.test('CSS: one radius system, mono for meta, heavy terminal wordmark', () => {
    assert.match(css, /--r:8px/);
    const radii = [...css.matchAll(/border-radius:([^;}]+)/g)].map(m => m[1]);
    assert.ok(radii.length > 5 && radii.every(r => r === 'var(--r)' || r === '0'), radii.join(' | '));
    assert.match(css, /\.dom[^{]*\{[^}]*font-family:var\(--mono\)/);
    assert.match(css, /\.wordmark\{[^}]*font-weight:\s*7\d0/);
  });
});
