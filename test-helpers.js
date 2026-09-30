const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// Must be set before server.js loads. Every test file runs in its own process, so each gets its own DB.
process.env.MARKS_DB = path.join(os.tmpdir(), `marks-test-${process.pid}-${Date.now()}.db`);
const server = require('./server');

const para = 'Zanzibarfluff is the unique word in this readable article paragraph, repeated so Readability keeps it. ';
const ARTICLE = `<html><head><title>Fluff Article</title><meta name="description" content="About fluff">
<meta property="og:image" content="http://img.test/x.png"><link rel="icon" href="/fav.png"></head>
<body><nav>menu</nav><article><h1>Fluff Article</h1>${`<p>${para.repeat(6)}</p>`.repeat(4)}</article></body></html>`;

async function setup(t, routes = {}) {
  const state = { flipStatus: 200 };
  const site = http.createServer((req, res) => {
    if (routes[req.url]) return routes[req.url](req, res);
    if (req.url === '/article') return res.writeHead(200, { 'content-type': 'text/html' }).end(ARTICLE);
    if (req.url === '/flip') return res.writeHead(state.flipStatus, { 'content-type': 'text/html' }).end('<title>Flip</title>');
    if (req.url === '/plain') return res.writeHead(200, { 'content-type': 'text/plain' }).end('just text');
    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  const srv = server.app.listen(0, '127.0.0.1');
  t.after(() => { site.closeAllConnections(); srv.closeAllConnections(); site.close(); srv.close(); server.db.close(); });
  await Promise.all([new Promise(r => site.once('listening', r)), new Promise(r => srv.once('listening', r))]);
  const base = `http://127.0.0.1:${srv.address().port}`, fake = `http://127.0.0.1:${site.address().port}`;
  const postRaw = (p, body, headers = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  const post = async (p, body, headers) => { const r = await postRaw(p, body, headers); if (p === '/save') await server.settled(); return r; };
  const get = async p => (await fetch(base + p)).text();
  return { ...server, base, fake, post, postRaw, get, state };
}

module.exports = { setup, ARTICLE };
