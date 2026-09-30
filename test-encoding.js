const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./test-helpers');

const html = (head) => Buffer.from(`<html><head>${head}<title>Café menu</title></head><body></body></html>`, 'latin1');
const send = (type, body) => (req, res) => res.writeHead(200, { 'content-type': type }).end(body);

test('page encodings', async t => {
  const s = await setup(t, {
    '/header': send('text/html; charset=iso-8859-1', html('')),
    '/meta': send('text/html', html('<meta charset="windows-1252">')),
    '/utf8': send('text/html', Buffer.from('<html><head><title>Café menu</title></head></html>', 'utf8')),
  });
  for (const p of ['/header', '/meta', '/utf8']) {
    await t.test(p, async () => {
      await s.post('/save', new URLSearchParams({ url: s.fake + p }));
      const row = s.db.prepare('SELECT title FROM bookmarks WHERE url = ?').get(s.fake + p);
      assert.equal(row.title, 'Café menu');
    });
  }
});
