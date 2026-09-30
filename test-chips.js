const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup } = require('./test-helpers');

test('tag chips and shortcuts', async t => {
  const s = await setup(t);
  s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES ('https://a.test','A',1),('https://b.test','B',2)").run();
  const put = (id, tag) => s.db.prepare('INSERT INTO bookmark_tags VALUES (?, ?)').run(id, tag);
  put(1, 'python'); put(2, 'python'); put(2, 'recipes');
  const load = async id => new JSDOM(await s.get(`/b/${id}`), { runScripts: 'dangerously' });

  await t.test('clicking a chip adds and removes its tag', async () => {
    const d = (await load(1)).window.document;
    const inp = d.getElementById('tags');
    const chip = [...d.querySelectorAll('.chip')].find(c => c.dataset.t === 'recipes');
    assert.equal(inp.value, 'python');
    chip.click();
    assert.equal(inp.value, 'python, recipes, ');
    assert.ok(chip.classList.contains('on'));
    chip.click();
    assert.equal(inp.value, 'python, ');
    assert.ok(!chip.classList.contains('on'));
  });

  await t.test('Ctrl+Enter in the note submits; plain Enter does not', async () => {
    const { document: d, KeyboardEvent } = (await load(1)).window;
    let submitted = 0;
    d.querySelector('form.edit').addEventListener('submit', e => { e.preventDefault(); submitted++; });
    const note = d.getElementById('note');
    note.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(submitted, 0);
    note.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    assert.equal(submitted, 1);
  });

  await t.test('a hostile tag name stays inert in chips', async () => {
    put(1, 'x"><img src=x onerror=alert(1)>');
    assert.doesNotMatch(await s.get('/b/1'), /<img src=x/);
  });
});
