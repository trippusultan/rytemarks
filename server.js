const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const metascraper = require('metascraper')([
  require('metascraper-title')(),
  require('metascraper-description')(),
  require('metascraper-image')(),
]);

const PORT = 4040;
const PAGE = 100;
const UA = 'Mozilla/5.0 (compatible; marks personal bookmark archiver)';

// One file, default rollback journal (no -wal sidecar), so copying it while idle is a valid backup.
const db = new Database(process.env.MARKS_DB || path.join(__dirname, 'marks.db'));
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS bookmarks(
  id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
  favicon TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
  saved_at INTEGER NOT NULL, status INTEGER, checked_at INTEGER);
CREATE INDEX IF NOT EXISTS bm_saved ON bookmarks(saved_at DESC);
CREATE TABLE IF NOT EXISTS bookmark_tags(
  bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE, tag TEXT NOT NULL,
  PRIMARY KEY(bookmark_id, tag));
CREATE INDEX IF NOT EXISTS tags_tag ON bookmark_tags(tag);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, note, text, content='bookmarks', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS bm_ai AFTER INSERT ON bookmarks BEGIN
  INSERT INTO fts(rowid, title, note, text) VALUES (new.id, new.title, new.note, new.text); END;
CREATE TRIGGER IF NOT EXISTS bm_ad AFTER DELETE ON bookmarks BEGIN
  INSERT INTO fts(fts, rowid, title, note, text) VALUES ('delete', old.id, old.title, old.note, old.text); END;
CREATE TRIGGER IF NOT EXISTS bm_au AFTER UPDATE OF title, note, text ON bookmarks BEGIN
  INSERT INTO fts(fts, rowid, title, note, text) VALUES ('delete', old.id, old.title, old.note, old.text);
  INSERT INTO fts(rowid, title, note, text) VALUES (new.id, new.title, new.note, new.text); END;
`);

if (!db.prepare("SELECT 1 FROM pragma_table_info('bookmarks') WHERE name = 'archived_at'").get())
  db.exec('ALTER TABLE bookmarks ADD COLUMN archived_at INTEGER'); // NULL = page text never fetched (imports)

const now = () => Math.floor(Date.now() / 1000);
const isDead = s => s === 404 || s === 410;
const parseTags = s => [...new Set(String(s || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean))];
const httpUrl = s => { try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } };
// Accepts "example.com/x" as well as full URLs; only http(s) survives.
const cleanUrl = s => {
  s = String(s || '').trim();
  return httpUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s);
};
const domain = url => new URL(url).hostname.replace(/^www\./, '');
// Quote every token so user input can never be an FTS5 syntax error; trailing * = prefix match.
const ftsQuery = q => (String(q).match(/[\p{L}\p{N}_]+/gu) || []).map(t => `"${t}"*`).join(' ');
const silent = () => ({ virtualConsole: new VirtualConsole() });

// ---------- scraping ----------
function decodeHtml(buf, contentType) {
  const label = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1]
    || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'))?.[1] || 'utf-8';
  try { return new TextDecoder(label).decode(buf); } catch { return buf.toString('utf8'); }
}
async function scrape(url) {
  const out = { title: '', description: '', image: '', favicon: '', text: '', status: null };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' } });
    out.status = res.status;
    if (!/html/.test(res.headers.get('content-type') || '')) return out;
    const html = decodeHtml(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type'));
    const meta = await metascraper({ html, url: res.url });
    const dom = new JSDOM(html, { url: res.url, ...silent() });
    const icon = dom.window.document.querySelector('link[rel~="icon" i]')?.getAttribute('href');
    out.favicon = (icon && httpUrl(new URL(icon, res.url))) || '';
    const article = new Readability(dom.window.document).parse(); // mutates the DOM: after favicon lookup
    out.text = (article?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500000);
    dom.window.close();
    out.title = meta.title || '';
    out.description = meta.description || '';
    out.image = meta.image || '';
  } catch { /* unreachable/blocked page: still save the bookmark with what we have */ }
  return out;
}

// ---------- data ----------
const insertBm = db.prepare(`INSERT OR IGNORE INTO bookmarks(url,title,description,image,favicon,note,text,saved_at,status,checked_at,archived_at)
  VALUES(@url,@title,@description,@image,@favicon,@note,@text,@saved_at,@status,@checked_at,@archived_at)`);
const setTags = db.transaction((id, tags) => {
  db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id=?').run(id);
  for (const t of tags) db.prepare('INSERT INTO bookmark_tags VALUES(?,?)').run(id, t);
});
const SELECT = `SELECT b.*, (SELECT group_concat(tag, ',') FROM bookmark_tags WHERE bookmark_id = b.id) AS tags FROM bookmarks b`;
const withTags = r => r && { ...r, tags: r.tags ? r.tags.split(',').sort() : [] };
const allTags = () => db.prepare('SELECT tag, count(*) n FROM bookmark_tags GROUP BY tag ORDER BY n DESC, tag').all();

// ponytail: sequential, network errors ignored (transient); parallelise if the archive gets huge
async function checkLinks() {
  const upd = db.prepare('UPDATE bookmarks SET status=?, checked_at=? WHERE id=?');
  let dead = 0;
  for (const { id, url } of db.prepare('SELECT id, url FROM bookmarks').all()) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': UA } });
      await r.body?.cancel();
      upd.run(r.status, now(), id);
      if (isDead(r.status)) dead++;
    } catch { /* leave last known status */ }
  }
  return dead;
}

// Fetch page text for bookmarks that never had it (imports). Every attempt is stamped, so a page that
// yields nothing (404, PDF, no article) is not retried forever. Keeps the user's title and note.
async function archiveMissing() {
  const upd = db.prepare(`UPDATE bookmarks SET text = ?, description = coalesce(nullif(?, ''), description),
    image = coalesce(nullif(?, ''), image), favicon = coalesce(nullif(?, ''), favicon),
    status = coalesce(?, status), checked_at = coalesce(?, checked_at), archived_at = ? WHERE id = ?`);
  let n = 0;
  for (const { id, url } of db.prepare("SELECT id, url FROM bookmarks WHERE archived_at IS NULL AND text = ''").all()) {
    const m = await scrape(url);
    upd.run(m.text, m.description, m.image, m.favicon, m.status, m.status && now(), now(), id);
    if (m.text) n++;
  }
  return n;
}
const pending = () => db.prepare("SELECT count(*) n FROM bookmarks WHERE archived_at IS NULL AND text = ''").get().n;

// One background job at a time (archive or link check); the footer shows which.
let busy = null;
const background = (name, fn) => {
  if (busy) return false;
  busy = name;
  fn().catch(console.error).finally(() => { busy = null; });
  return true;
};
const jobsHtml = () => busy ? h`· ${busy} running…`
  : h`${pending() > 0 && h`· <form method=post action="/archive" class=inline><button>Archive ${pending()} pages</button></form>`}`;

// Netscape export: <DT><A HREF ADD_DATE TAGS>title</A> [<DD>note]. Only http(s) links survive.
function parseNetscape(html) {
  const doc = new JSDOM(html, silent()).window.document;
  return [...doc.querySelectorAll('a[href]')].flatMap(a => {
    const url = httpUrl(a.getAttribute('href'));
    if (!url) return [];
    const dd = a.closest('dt')?.nextElementSibling;
    const d = +a.getAttribute('add_date') || now();
    return [{ url, title: a.textContent.trim(), tags: parseTags(a.getAttribute('tags')), saved_at: Math.floor(d > 1e11 ? d / 1000 : d), note: dd?.tagName === 'DD' ? dd.textContent.trim() : '' }];
  });
}
const importAll = db.transaction(items => {
  let added = 0;
  for (const it of items) {
    const r = insertBm.run({ description: '', image: '', favicon: '', text: '', status: null, checked_at: null, archived_at: null, ...it });
    if (r.changes) { setTags(r.lastInsertRowid, it.tags); added++; }
  }
  return added;
});

// ---------- html ----------
class Safe { constructor(s) { this.s = s; } }
const raw = s => new Safe(s);
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const render = v => v instanceof Safe ? v.s : Array.isArray(v) ? v.map(render).join('') : v == null || v === false ? '' : esc(v);
const h = (s, ...v) => new Safe(s.reduce((o, str, i) => o + str + (i < v.length ? render(v[i]) : ''), ''));
const qs = o => { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v && v !== 1)).toString(); return s ? '?' + s : ''; };
const date = t => new Date(t * 1000).toISOString().slice(0, 10);

const BOOKMARKLET = `javascript:(function(){var f=document.createElement('form');f.method='POST';f.action='http://localhost:${PORT}/save';f.target='_blank';var i=document.createElement('input');i.type='hidden';i.name='url';i.value=location.href;f.appendChild(i);document.body.appendChild(f);f.submit();f.remove()})()`;
const BOOKMARKLET_GET = `javascript:location='http://localhost:${PORT}/save?url='+encodeURIComponent(location.href)`;
const CSS = `:root{color-scheme:light dark;--mut:#777}
body{font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:0 auto;padding:1rem}
header{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem}
header form{flex:1;display:flex;gap:.5rem;min-width:14rem}header input{flex:1}
input,textarea,button{font:inherit;padding:.35rem .5rem}
.layout{display:grid;grid-template-columns:1fr 12rem;gap:1.5rem}
@media(max-width:700px){.layout{grid-template-columns:1fr}}
ul{list-style:none;padding:0;margin:0}
li.b{display:flex;gap:.7rem;padding:.6rem 0;border-bottom:1px solid #8884}
.fav{width:16px;height:16px;margin-top:.3rem;flex:none}
.meta{color:var(--mut);font-size:13px}.meta a{color:inherit}
.dead{color:#c33;font-weight:600;font-size:12px}
aside{max-height:80vh;overflow:auto;font-size:13px}aside li{padding:.1rem 0}
label{display:block;margin:.8rem 0 .2rem}
form.edit input[type=text],textarea{width:100%;box-sizing:border-box}
footer{margin-top:2rem;color:var(--mut);font-size:13px}footer a{color:inherit}
.add{display:flex;gap:.5rem;margin-bottom:1rem}.add input{flex:1}
form.inline{display:inline}form.inline button{padding:.1rem .4rem;font-size:13px}`;

const page = (title, body, { q = '', tag = '' } = {}) => `<!doctype html><html lang=en><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style>
${h`<header><a href="/"><b>marks</b></a>
<form action="/"><input type=search name=q value="${q}" placeholder="Search title, note, page text">${tag && h`<input type=hidden name=tag value="${tag}">`}<button>Search</button></form></header>
${body}
<footer><a href="${raw(esc(BOOKMARKLET))}">+ Save to marks</a> (drag to bookmarks bar, <a href="/bookmarklet">help</a>) ·
<a href="/import">Import</a> · Export <a href="/export?format=json">JSON</a> <a href="/export?format=csv">CSV</a> ${jobsHtml()}</footer>`.s}`;

// ---------- app ----------
const app = express();
app.set('etag', false);
app.use((req, res, next) => {
  // Blocks DNS rebinding (Host) and cross-site form posts (Origin). /save is exempt: the bookmarklet posts from any site.
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return res.status(403).send('bad host');
  const o = req.headers.origin;
  if (req.method === 'POST' && req.path !== '/save' && o && o !== `http://${req.headers.host}`) return res.status(403).send('cross-origin');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => {
  const q = String(req.query.q || '').trim(), tag = String(req.query.tag || '').trim().toLowerCase();
  const pg = Math.max(1, parseInt(req.query.page) || 1), fq = ftsQuery(q);
  const where = [], args = [];
  if (fq) { where.push('b.id IN (SELECT rowid FROM fts WHERE fts MATCH ?)'); args.push(fq); }
  if (tag) { where.push('EXISTS (SELECT 1 FROM bookmark_tags t WHERE t.bookmark_id = b.id AND t.tag = ?)'); args.push(tag); }
  const rows = db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.saved_at DESC, b.id DESC LIMIT ? OFFSET ?`)
    .all(...args, PAGE + 1, (pg - 1) * PAGE).map(withTags);
  const more = rows.length > PAGE && rows.pop();
  const item = b => h`<li class=b>
    <img class=fav src="${b.favicon || new URL(b.url).origin + '/favicon.ico'}" alt="" loading=lazy referrerpolicy=no-referrer onerror="this.style.visibility='hidden'">
    <div><a href="${b.url}">${b.title || b.url}</a> ${isDead(b.status) && h`<span class=dead title="HTTP ${b.status} at last check">404</span>`}
    <div class=meta>${domain(b.url)} · ${b.tags.map(t => h`<a href="/${qs({ tag: t })}">#${t}</a> `)}· ${date(b.saved_at)} · <a href="/b/${b.id}">edit</a></div>
    ${b.note && h`<div class=meta>${b.note}</div>`}</div></li>`;
  res.send(page('marks', h`<div class=layout>
    <main><form method=post action="/save" class=add><input type=text name=url placeholder="Paste a URL to save" required><button>Save</button></form>
    ${tag && h`<p class=meta>Tag <b>#${tag}</b> · <a href="/${qs({ q })}">clear</a></p>`}
    <ul>${rows.map(item)}</ul>${!rows.length && h`<p class=meta>Nothing here.</p>`}
    ${pg > 1 && h`<a href="/${qs({ q, tag, page: pg - 1 })}">← newer</a> `}${more && h`<a href="/${qs({ q, tag, page: pg + 1 })}">older →</a>`}</main>
    <aside><ul>${allTags().map(t => h`<li><a href="/${qs({ q, tag: t.tag })}">#${t.tag}</a> <span class=meta>${t.n}</span></li>`)}</ul></aside></div>`, { q, tag }));
});

app.get('/save', (req, res) => {
  const url = cleanUrl(req.query.url);
  if (!url) return res.status(400).send(page('Bad URL', h`<p>Only http(s) URLs can be saved.</p>`));
  res.send(page('Save', h`<h2>Save this page?</h2><p class=meta>${url}</p>
    <form method=post action="/save"><input type=hidden name=url value="${url}"><button>Save</button> <a href="/">Cancel</a></form>`));
});

app.get('/bookmarklet', (req, res) => res.send(page('Bookmarklet', h`<h2>Save button</h2>
  <p>Drag a link to your bookmarks bar (Ctrl+Shift+B shows it), or create a bookmark by hand and paste the code below as its URL. The server must be running when you click.</p>
  <h3>Standard (opens a new tab)</h3>
  <p><a href="${raw(esc(BOOKMARKLET))}">Save to marks</a></p>
  <textarea readonly rows=6 style="width:100%" onclick="this.select()">${BOOKMARKLET}</textarea>
  <h3>Fallback (same tab; use it when the standard one is blocked)</h3>
  <p><a href="${raw(esc(BOOKMARKLET_GET))}">Save to marks (simple)</a></p>
  <textarea readonly rows=3 style="width:100%" onclick="this.select()">${BOOKMARKLET_GET}</textarea>`)));

app.post('/save', async (req, res) => {
  const url = cleanUrl(req.body.url);
  if (!url) return res.status(400).send(page('Bad URL', h`<p>Only http(s) URLs can be saved.</p>`));
  if (!db.prepare('SELECT 1 FROM bookmarks WHERE url=?').get(url)) {
    const m = await scrape(url);
    insertBm.run({ ...m, url, title: m.title || domain(url), note: '', saved_at: now(), checked_at: m.status && now(), archived_at: now() });
  }
  res.redirect(303, `/b/${db.prepare('SELECT id FROM bookmarks WHERE url=?').get(url).id}`);
});

app.get('/b/:id', (req, res) => {
  const b = withTags(db.prepare(`${SELECT} WHERE b.id=?`).get(+req.params.id));
  if (!b) return res.status(404).send(page('Not found', h`<p>No such bookmark.</p>`));
  const tags = JSON.stringify(allTags().map(t => t.tag)).replace(/</g, '\\u003c');
  res.send(page(b.title, h`<h2><a href="${b.url}">${b.title}</a></h2><p class=meta>${b.url}</p>
    <form class=edit method=post action="/b/${b.id}">
    <label for=title>Title</label><input type=text id=title name=title value="${b.title}">
    <label for=tags>Tags (comma separated)</label><input type=text id=tags name=tags value="${b.tags.join(', ')}" autocomplete=off list=tl autofocus><datalist id=tl></datalist>
    <label for=note>Note</label><textarea id=note name=note rows=5>${b.note}</textarea>
    <p><button>Save</button> <a href="/">Cancel</a></p></form>
    <form method=post action="/b/${b.id}/delete" onsubmit="return confirm('Delete this bookmark?')"><button>Delete</button></form>
    <script>
    // Native datalist, but options are rebuilt for the tag after the last comma.
    const T=${raw(tags)},inp=document.getElementById('tags'),dl=document.getElementById('tl');
    inp.addEventListener('input',()=>{
      const i=inp.value.lastIndexOf(','),head=inp.value.slice(0,i+1),rest=inp.value.slice(i+1),
        word=rest.trim().toLowerCase(),lead=rest.match(/^\\s*/)[0],have=inp.value.split(',').map(s=>s.trim().toLowerCase());
      dl.replaceChildren(...(word?T.filter(t=>t.startsWith(word)&&!have.slice(0,-1).includes(t)).slice(0,8):[])
        .map(t=>Object.assign(document.createElement('option'),{value:head+lead+t})));
    });
    </script>`));
});

app.post('/b/:id', (req, res) => {
  const id = +req.params.id;
  const r = db.prepare('UPDATE bookmarks SET title = coalesce(nullif(?, \'\'), title), note = ? WHERE id = ?')
    .run(String(req.body.title || '').trim(), String(req.body.note || '').trim(), id);
  if (!r.changes) return res.sendStatus(404);
  setTags(id, parseTags(req.body.tags));
  res.redirect(303, '/');
});

app.post('/b/:id/delete', (req, res) => {
  db.prepare('DELETE FROM bookmarks WHERE id=?').run(+req.params.id);
  res.redirect(303, '/');
});

app.get('/import', (req, res) => res.send(page('Import', h`<h2>Import bookmarks</h2>
  <p>Netscape bookmarks HTML export (Raindrop, Chrome, Firefox, …). Existing URLs are skipped; page text is not fetched for imports.</p>
  <input type=file id=f accept=".html,.htm"><p id=out></p>
  <script>
  document.getElementById('f').onchange=async e=>{
    const out=document.getElementById('out');out.textContent='Importing…';
    const r=await fetch('/import',{method:'POST',headers:{'content-type':'text/plain'},body:e.target.files[0]});
    out.textContent=await r.text();
  };
  </script>`)));

app.post('/import', express.text({ type: '*/*', limit: '200mb' }), (req, res) => {
  const items = parseNetscape(typeof req.body === 'string' ? req.body : '');
  const added = importAll(items);
  res.type('text').send(`Imported ${added} new of ${items.length} http(s) links.`);
});

app.post('/archive', (req, res) => { background('archive', archiveMissing); res.redirect(303, '/'); });

const csvCell = v => {
  v = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; // spreadsheet formula injection: titles come from arbitrary websites
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
app.get('/export', (req, res) => {
  const rows = db.prepare(`${SELECT} ORDER BY b.saved_at DESC, b.id DESC`).all().map(withTags)
    .map(b => ({ url: b.url, title: b.title, description: b.description, image: b.image, favicon: b.favicon, note: b.note, tags: b.tags,
      saved_at: new Date(b.saved_at * 1000).toISOString(), status: b.status, text: b.text }));
  const stamp = new Date().toISOString().slice(0, 10);
  if (req.query.format === 'csv') { // page text omitted: cells that large break spreadsheets; JSON has it
    const cols = ['url', 'title', 'description', 'image', 'favicon', 'note', 'tags', 'saved_at', 'status'];
    res.attachment(`marks-${stamp}.csv`).type('csv').send([cols.join(','), ...rows.map(r => cols.map(c => csvCell(c === 'tags' ? r.tags.join(',') : r[c])).join(','))].join('\r\n') + '\r\n');
  } else res.attachment(`marks-${stamp}.json`).type('json').send(JSON.stringify(rows, null, 2));
});

module.exports = { app, db, checkLinks, archiveMissing, parseNetscape };

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => console.log(`marks: http://localhost:${PORT}  db: ${db.name}`));
  cron.schedule('0 3 * * 0', () => checkLinks().catch(console.error)); // Sundays 03:00, only while the server runs
}
