const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

test('dead-link view', async t => {
  const s = await setup(t);
  await s.post('/save', new URLSearchParams({ url: s.fake + '/article' }));
  await s.post('/save', new URLSearchParams({ url: s.fake + '/flip' }));
  s.state.flipStatus = 404;
  await s.checkLinks();

  const dead = await s.get('/?dead=1');
  assert.match(dead, /\/flip/);
  assert.doesNotMatch(dead, /\/article/);
  assert.match(await s.get('/'), /<a class="stat" href="\/\?dead=1"><span>Dead links<\/span><span class="badge bad">1<\/span><\/a>/);

  s.db.prepare('DELETE FROM bookmarks').run(); // so the background job started below has nothing to do
  assert.equal((await s.post('/check', '')).status, 303);
});
