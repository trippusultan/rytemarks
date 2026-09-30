const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup } = require('./test-helpers');

test('friendlier list', async t => {
  const s = await setup(t);
  const nowS = Math.floor(Date.now() / 1000);

  await t.test('empty archive shows onboarding, not "Nothing here"', async () => {
    const html = await s.get('/');
    assert.match(html, /Nothing saved yet/);
    assert.match(html, /href="\/bookmarklet"/);
  });

  s.db.prepare('INSERT INTO bookmarks(url,title,saved_at) VALUES (?,?,?),(?,?,?)').run('https://a.test', 'Alpha page', nowS - 30, 'https://b.test', 'Beta page', nowS - 3 * 86400);
  s.db.prepare("INSERT INTO bookmark_tags VALUES (1, 'a')").run();

  await t.test('ago()', () => {
    const { ago } = require('./server');
    assert.equal(ago(1000, 1030), 'just now');
    assert.equal(ago(1000, 1120), '2m ago');
    assert.equal(ago(1000, 8200), '2h ago');
    assert.equal(ago(1000, 1000 + 3 * 86400), '3d ago');
    assert.equal(ago(1000, 1000 + 8 * 86400), '1970-01-01');
    assert.equal(ago(2000, 1000), 'just now');
  });

  await t.test('relative dates, result count, no-match hint', async () => {
    const html = await s.get('/');
    assert.match(html, />just now</);
    assert.match(html, />3d ago</);
    assert.match(await s.get('/?q=alpha'), /1 bookmark matching “alpha”/);
    assert.match(await s.get('/?q=zzzzqq'), /No matches/);
    assert.doesNotMatch(await s.get('/'), /Nothing saved yet/);
  });

  await t.test('edit links remember the list you came from', async () => {
    assert.match(await s.get('/?tag=a'), /href="\/b\/1\?back=%2F%3Ftag%3Da"/);
  });

  await t.test('back is honoured only for local paths', async () => {
    const loc = async back => (await s.post('/b/1', new URLSearchParams({ title: '', tags: 'a', note: '', back }))).headers.get('location');
    assert.match(await loc('/?tag=a'), /^\/\?tag=a(&ok=saved)?$/); // Task 4 appends ok=saved
    for (const bad of ['//evil.test', '/\\evil.test', 'https://evil.test', 'javascript:alert(1)', '']) assert.match(await loc(bad), /^\/(\?ok=saved)?$/, bad);
  });

  await t.test('"/" focuses search unless you are typing in a field', async () => {
    const { window } = new JSDOM(await s.get('/'), { runScripts: 'dangerously' });
    const d = window.document, q = d.querySelector('input[name=q]'), add = d.querySelector('.add input');
    d.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
    assert.equal(d.activeElement, q);
    add.focus();
    add.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
    assert.equal(d.activeElement, add);
  });
});
