const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

const until = async (fn, ms = 3000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 20));
  }
};

test('background fetch races', async t => {
  let releaseSlow, releaseA, releaseB;
  const gateSlow = new Promise(r => { releaseSlow = r; });
  const gateA = new Promise(r => { releaseA = r; });
  const gateB = new Promise(r => { releaseB = r; });
  const html = '<html><head><title>Slow Page</title></head><body></body></html>';
  const s = await setup(t, {
    '/slow': async (req, res) => { await gateSlow; res.writeHead(200, { 'content-type': 'text/html' }).end(html); },
    '/dropA': async (req, res) => { await gateA; req.socket.destroy(); },
    '/dropB': async (req, res) => { await gateB; req.socket.destroy(); },
  });
  const row = p => s.db.prepare('SELECT * FROM bookmarks WHERE url = ?').get(p);

  await t.test('a fetch for a deleted bookmark never writes onto a new one that reused its id', async () => {
    await s.postRaw('/save', new URLSearchParams({ url: s.fake + '/slow' }));
    const { id } = row(s.fake + '/slow');
    await s.postRaw(`/b/${id}/delete`, new URLSearchParams({}));
    await s.postRaw('/save', new URLSearchParams({ url: s.fake + '/article' }));
    assert.equal(row(s.fake + '/article').id, id); // id reused
    await until(() => row(s.fake + '/article').text.includes('Zanzibarfluff'));
    releaseSlow();
    await s.settled();
    const b = row(s.fake + '/article');
    assert.equal(b.title, 'Fluff Article');
    assert.match(b.text, /Zanzibarfluff/);
  });

  await t.test('a failed background fetch does not wipe text an Archive run already stored', async () => {
    await s.postRaw('/save', new URLSearchParams({ url: s.fake + '/dropA' }));
    s.db.prepare("UPDATE bookmarks SET text = 'archived text', archived_at = 1 WHERE url = ?").run(s.fake + '/dropA');
    releaseA();
    await s.settled();
    const b = row(s.fake + '/dropA');
    assert.equal(b.text, 'archived text');
    assert.equal(b.archived_at, 1);
    assert.equal(b.title, '127.0.0.1'); // placeholder title still applied
  });

  await t.test('an Archive run that fails does not wipe text a background fetch stored meanwhile', async () => {
    s.db.prepare('DELETE FROM bookmarks').run();
    s.db.prepare("INSERT INTO bookmarks(url,title,saved_at) VALUES (?, 'B', 1)").run(s.fake + '/dropB');
    const archiving = s.archiveMissing(); // lists /dropB as pending, then waits on its fetch
    await new Promise(r => setTimeout(r, 100));
    s.db.prepare("UPDATE bookmarks SET text = 'kept', archived_at = 5 WHERE url = ?").run(s.fake + '/dropB');
    releaseB();
    await archiving;
    const b = row(s.fake + '/dropB');
    assert.equal(b.text, 'kept');
    assert.equal(b.archived_at, 5);
  });
});
