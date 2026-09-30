const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setup } = require('./test-helpers');

test('polish', async t => {
  const s = await setup(t);
  s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES ('https://a.test','A',1)").run();

  await t.test('a broken favicon is replaced by the fallback icon', async () => {
    const { window } = new JSDOM(await s.get('/'), { runScripts: 'dangerously' });
    const img = window.document.querySelector('img.fav');
    img.dispatchEvent(new window.Event('error'));
    assert.match(img.src, /^data:image\/svg\+xml/);
  });

  await t.test('import page has next steps and no stale wording', async () => {
    const html = await s.get('/import');
    assert.match(html, /<div id=next hidden>/);
    assert.match(html, /Archive/);
    assert.doesNotMatch(html, /page text is not fetched/);
  });
});
