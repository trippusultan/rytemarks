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

const PORT = +process.env.PORT || 4040; // PORT=4141 lets a preview run beside your real instance
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
const MAX_HTML = 5 * 1024 * 1024; // read at most 5 MB of a page; the rest is never downloaded
async function readCapped(res, max) {
  const chunks = [];
  let n = 0;
  for await (const c of res.body) {
    chunks.push(c);
    if ((n += c.length) > max) break; // leaving the loop cancels the stream
  }
  return Buffer.concat(chunks);
}
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
    if (!/html/.test(res.headers.get('content-type') || '')) { await res.body?.cancel(); return out; }
    const html = decodeHtml(await readCapped(res, MAX_HTML), res.headers.get('content-type'));
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
// Save answers immediately; the page fetch fills in details afterwards. A title the user already typed is kept,
// and no HTTP status (network failure) leaves archived_at NULL so the Archive button can retry it.
// Every write is keyed on id AND url (ids are reused after a delete) and never blanks something already stored.
const enrichStmt = db.prepare(`UPDATE bookmarks SET
  title = CASE WHEN title = '' THEN coalesce(nullif(?, ''), ?) ELSE title END,
  description = coalesce(nullif(?, ''), description), image = coalesce(nullif(?, ''), image),
  favicon = coalesce(nullif(?, ''), favicon), text = coalesce(nullif(?, ''), text),
  status = ?, checked_at = ?, archived_at = ? WHERE id = ? AND url = ?`);
const placeholderTitle = db.prepare("UPDATE bookmarks SET title = ? WHERE id = ? AND url = ? AND title = ''");
async function enrich(id, url) {
  const m = await scrape(url);
  if (m.status == null) return void placeholderTitle.run(domain(url), id, url); // network failure: change nothing else
  enrichStmt.run(m.title, domain(url), m.description, m.image, m.favicon, m.text, m.status, now(), now(), id, url);
}
const inflight = new Set();
const MAX_INFLIGHT = 10;
const enrichInBackground = (id, url) => {
  if (inflight.size >= MAX_INFLIGHT) return; // stays pending (archived_at NULL); the Archive button picks it up
  const p = enrich(id, url).catch(console.error).finally(() => inflight.delete(p));
  inflight.add(p);
};
const settled = () => Promise.all([...inflight]);
const setTags = db.transaction((id, tags) => {
  db.prepare('DELETE FROM bookmark_tags WHERE bookmark_id=?').run(id);
  for (const t of tags) db.prepare('INSERT INTO bookmark_tags VALUES(?,?)').run(id, t);
});
const renameTag = db.transaction((from, to) => {
  if (from === to) return;
  db.prepare('UPDATE OR IGNORE bookmark_tags SET tag = ? WHERE tag = ?').run(to, from);
  db.prepare('DELETE FROM bookmark_tags WHERE tag = ?').run(from); // rows that already had `to`
});
const FLASH = { deleted: 'Bookmark deleted.', restored: 'Bookmark restored.', saved: 'Saved.', exists: 'That page was saved again, so there was nothing to restore.' };
const UNDO_MS = 5 * 60 * 1000;
const undo = { item: null }; // ponytail: one level, in memory, lost on restart; add a deleted_at column for more
const restoreStmt = db.prepare(`INSERT OR IGNORE INTO bookmarks(id,url,title,description,image,favicon,note,text,saved_at,status,checked_at,archived_at)
  VALUES(@id,@url,@title,@description,@image,@favicon,@note,@text,@saved_at,@status,@checked_at,@archived_at)`);
const withOk = (path, key) => { const u = new URL(path, 'http://x'); u.searchParams.set('ok', key); return u.pathname + u.search; };
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
  const upd = db.prepare(`UPDATE bookmarks SET
    title = CASE WHEN title IN ('', ?) THEN coalesce(nullif(?, ''), title) ELSE title END, text = ?, description = coalesce(nullif(?, ''), description),
    image = coalesce(nullif(?, ''), image), favicon = coalesce(nullif(?, ''), favicon),
    status = coalesce(?, status), checked_at = coalesce(?, checked_at), archived_at = ?
    WHERE id = ? AND url = ? AND archived_at IS NULL AND text = ''`); // still pending: never overwrite a concurrent save's result
  let n = 0;
  for (const { id, url } of db.prepare("SELECT id, url FROM bookmarks WHERE archived_at IS NULL AND text = ''").all()) {
    const m = await scrape(url);
    const r = upd.run(domain(url), m.title, m.text, m.description, m.image, m.favicon, m.status, m.status && now(), m.status && now(), id, url); // no HTTP status = network failure: leave pending for a retry
    if (r.changes && m.text) n++;
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
const jobsHtml = () => busy ? h`<span>${busy} running…</span>`
  : h`<form method=post action="/check" class=inline><button>Check links now</button></form>${pending() > 0 && h`<form method=post action="/archive" class=inline><button>Archive ${pending()} pages</button></form>`}`;

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
const ago = (t, at = now()) => {
  const s = at - t;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return date(t);
};
// Only local paths. Judged after the URL parser has normalised it (dot segments, tabs/newlines, backslashes,
// %2e), the same way the browser and withOk() will, so "/.//evil.test" cannot slip through as "//evil.test".
const safeBack = s => {
  try {
    const u = new URL(String(s || '/'), 'http://x');
    return u.host === 'x' && !u.pathname.startsWith('//') ? u.pathname + u.search : '/';
  } catch { return '/'; }
};

// The address travels in the link (a GET that opens a tab), not in a form body: some browsers open a form's
// target=_blank as a bare GET and drop the POST body. /save then auto-submits the real POST itself.
const BOOKMARKLET = `javascript:(function(){var u='http://localhost:${PORT}/save?url='+encodeURIComponent(location.href);if(!window.open(u))location=u})()`;
const BOOKMARKLET_GET = `javascript:location='http://localhost:${PORT}/save?url='+encodeURIComponent(location.href)`;
const FAV_FALLBACK = `data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"%3E%3Ccircle cx="8" cy="8" r="6" fill="none" stroke="%23999" stroke-width="1.5"/%3E%3Cpath d="M2 8h12M8 2c3 3 3 9 0 12M8 2c-3 3-3 9 0 12" stroke="%23999" fill="none"/%3E%3C/svg%3E`;
const CSS = `:root{color-scheme:light dark;--r:8px;--sans:"Segoe UI Variable Text","Segoe UI Variable","SF Pro Text",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace;--bg:#f3f6f7;--surface:#fbfcfc;--fg:#0d1a1f;--mut:#52626a;--line:#d9e2e5;--acc:#147863;--on-acc:#ffffff;--chip:#e4edef;--hover:#e9f0f2;--bad:#b3361c;--glow:6%;--grain:.05}
@media(prefers-color-scheme:dark){:root{--bg:#0a1013;--surface:#111a1e;--fg:#e7f0f2;--mut:#8fa2a9;--line:#223037;--acc:#3fe0bd;--on-acc:#03211a;--chip:#19252a;--hover:#152127;--bad:#ff8b6e;--glow:18%;--grain:.06}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 var(--sans);min-height:100dvh;display:flex;flex-direction:column}
[hidden]{display:none!important}
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(60rem 38rem at 88% -8%,color-mix(in srgb,var(--acc) var(--glow),transparent),transparent 62%),radial-gradient(44rem 30rem at -8% 22%,color-mix(in srgb,var(--acc) var(--glow),transparent),transparent 58%)}
body::after{content:"";position:fixed;inset:0;z-index:50;pointer-events:none;opacity:var(--grain);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
h1{margin:.2rem 0 1rem;font-size:clamp(2.2rem,5vw,3.4rem);font-weight:750;letter-spacing:-.05em;line-height:1;text-wrap:balance}
h2,h3{font-weight:700;letter-spacing:-.03em;line-height:1.15;text-wrap:balance}
h2{font-size:clamp(1.5rem,3.2vw,2rem)}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
header{position:sticky;top:0;z-index:20;display:flex;gap:1rem;align-items:center;flex-wrap:wrap;padding:.7rem max(1.25rem,calc((100vw - 1200px)/2));background:color-mix(in srgb,var(--bg) 78%,transparent);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);border-bottom:1px solid var(--line)}
@media(prefers-reduced-transparency:reduce){header{background:var(--bg);backdrop-filter:none;-webkit-backdrop-filter:none}}
main{width:100%;flex:1;max-width:1200px;margin:0 auto;padding:1.25rem 1.25rem 2.5rem}
footer{max-width:1200px;width:100%;margin:0 auto;padding:1.5rem 1.25rem 2.5rem;border-top:1px solid var(--line);color:var(--mut);font-size:13px;display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:1.5rem 2rem;align-items:start}footer a{color:inherit}
@media(max-width:700px){footer{grid-template-columns:1fr}}
.fz h3{margin:0 0 .6rem;font-size:13px;color:var(--fg);letter-spacing:-.01em}.fz p{margin:0 0 .35rem}
.about a{color:var(--acc);font-weight:500}
.fl,.jobs{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.25rem}.jobs{gap:.5rem}
.drag{padding:.25rem .6rem;border:1px dashed var(--line);border-radius:var(--r);color:var(--fg);cursor:grab}
.drag:hover{border-color:var(--acc);color:var(--acc);text-decoration:none}
.brand{display:flex;align-items:center;gap:.55rem;color:var(--fg)}.brand:hover{text-decoration:none}
.mark{display:block}
.wordmark{font-family:var(--sans);font-size:1.5rem;font-weight:750;letter-spacing:-.045em;line-height:1}
.tagline{font-weight:650;font-size:1.15rem;letter-spacing:-.02em;color:var(--acc);margin:.25rem 0 .75rem}
header nav{display:flex;gap:.15rem;align-items:center}
header nav a{padding:.4rem .75rem;border-radius:var(--r);color:var(--mut);font-weight:500;white-space:nowrap}
header nav a:hover{background:var(--hover);color:var(--fg);text-decoration:none}
header nav a[aria-current=page]{color:var(--fg);background:var(--chip);box-shadow:inset 0 -2px 0 var(--acc)}
@media(max-width:640px){header nav{order:3;width:100%;overflow-x:auto}}
header form{flex:1;display:flex;gap:.5rem;min-width:14rem;align-items:center}
@media(max-width:640px){header{position:static}header form{min-width:0}}
.field{display:flex;flex:1;align-items:center;gap:.4rem;padding-right:.4rem;background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}
.field:focus-within{outline:2px solid var(--acc);outline-offset:2px}
.field input{flex:1;border:0;background:transparent;outline:none}
.kbd{background:var(--chip);color:var(--mut);border:1px solid var(--line);padding:.1rem .45rem;font:11px var(--mono);font-weight:500;white-space:nowrap}
input,textarea{font:inherit;padding:.5rem .7rem;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);color:var(--fg)}
button{font:inherit;padding:.5rem .85rem;border:1px solid var(--acc);border-radius:var(--r);background:var(--acc);color:var(--on-acc);font-weight:600;cursor:pointer}button:hover{filter:brightness(1.08)}
.layout{display:grid;grid-template-columns:1fr 13rem;gap:2rem;align-items:start}
@media(max-width:700px){.layout{grid-template-columns:1fr}}
ul{list-style:none;padding:0;margin:0}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:1rem;min-height:2rem;margin:.25rem 0 .9rem}.toolbar p{margin:0}
.seg{display:flex;gap:.25rem}
.vt{background:transparent;color:var(--mut);border-color:var(--line);padding:.25rem .65rem;font-size:13px;font-weight:500}
.vt[aria-pressed=true]{background:var(--chip);color:var(--fg)}
.bento{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));grid-auto-flow:dense;grid-auto-rows:minmax(132px,auto);gap:14px}
.card{position:relative;display:flex;flex-direction:column;gap:.5rem;padding:1rem;background:color-mix(in srgb,var(--surface) 78%,transparent);border:1px solid var(--line);border-radius:var(--r);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--fg) 8%,transparent);animation:rise .5s cubic-bezier(.16,1,.3,1) backwards;animation-delay:calc(var(--i)*40ms)}
.card.feat{grid-column:span 2}
.card.tall{grid-row:span 2}
@media(max-width:640px){.bento{grid-template-columns:1fr}.card.feat{grid-column:auto}.card.tall{grid-row:auto}}
.card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--acc) 45%,var(--line));box-shadow:inset 0 1px 0 color-mix(in srgb,var(--fg) 8%,transparent),0 10px 28px color-mix(in srgb,var(--acc) 12%,transparent)}
.card:focus-within{border-color:var(--acc)}
.top{display:flex;align-items:center;gap:.5rem;min-width:0}
.fav{width:16px;height:16px;flex:none;border-radius:var(--r)}
.dom,.when{font-family:var(--mono);font-size:12px;color:var(--mut)}
.dom{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .t{font-weight:650;font-size:1.06rem;letter-spacing:-.015em;line-height:1.3;color:var(--fg);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card .t:hover{color:var(--acc);text-decoration:none}
.card.feat .t{font-size:1.4rem;letter-spacing:-.03em;-webkit-line-clamp:4}
.note{margin:0;color:var(--mut);font-size:13px;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.foot{margin-top:auto;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;font-size:12px}
.foot .edit{margin-left:auto;color:var(--mut)}
.tg{background:var(--chip);color:var(--acc);border-radius:var(--r);padding:.05rem .5rem;font-size:12px;font-weight:500}
html[data-view=list] .bento{display:block}
html[data-view=list] .card{flex-direction:row;flex-wrap:wrap;align-items:center;gap:.9rem;padding:.6rem .4rem;background:transparent;border-width:0 0 1px;border-radius:0;box-shadow:none;animation:none}
html[data-view=list] .card .top{width:11rem}
html[data-view=list] .card .t{flex:1;-webkit-line-clamp:1}
html[data-view=list] .card .note{display:none}
html[data-view=list] .card.feat .t{font-size:1.06rem;letter-spacing:-.015em}
html[data-view=list] .card .foot{margin:0}
@media(max-width:640px){html[data-view=list] .card .top{width:100%}html[data-view=list] .card .t{flex-basis:100%;-webkit-line-clamp:2}html[data-view=list] .card .foot{width:100%}}
.meta{color:var(--mut);font-size:13px}.meta a{color:inherit}.meta a:hover{color:var(--acc)}
.dead{color:var(--bad);font-weight:600;font-size:12px}
aside{position:sticky;top:5rem;max-height:calc(100vh - 6rem);overflow:auto;display:flex;flex-direction:column;gap:.75rem;font-size:13px}
@media(max-width:700px){aside{position:static;max-height:none}}
.side{background:color-mix(in srgb,var(--surface) 78%,transparent);backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);border:1px solid var(--line);border-radius:var(--r);padding:.9rem;box-shadow:inset 0 1px 0 color-mix(in srgb,var(--fg) 8%,transparent)}
.side h3{display:flex;justify-content:space-between;align-items:baseline;margin:0 0 .65rem;font-size:13px;letter-spacing:-.01em}
.n{font:12px var(--mono);color:var(--mut);font-weight:500}
.cloud{display:flex;flex-wrap:wrap;gap:.35rem}
.tc{display:inline-flex;align-items:center;gap:.4rem;max-width:100%;overflow-wrap:anywhere;padding:.2rem .55rem;border-radius:var(--r);background:var(--chip);color:var(--fg);font-size:12.5px;font-weight:500}
.tc:hover{box-shadow:inset 0 0 0 1px var(--acc);text-decoration:none}
.tc .n{font-size:11px}
.tc.on{background:var(--acc);color:var(--on-acc)}.tc.on .n{color:inherit}
.more{display:inline-block;margin-top:.75rem;color:var(--mut)}.more:hover{color:var(--acc)}
.stat{display:flex;justify-content:space-between;align-items:center;color:var(--fg)}.stat:hover{text-decoration:none;color:var(--acc)}
.badge{font:600 11px var(--mono);padding:.05rem .5rem;border-radius:var(--r);background:var(--chip);color:var(--mut)}
.badge.bad{background:color-mix(in srgb,var(--bad) 12%,transparent);color:var(--bad)}
label{display:block;margin:.9rem 0 .25rem;font-weight:600;font-size:13px}
form.edit input[type=text],textarea{width:100%}
.add{display:flex;align-items:center;gap:.5rem;margin-bottom:1rem;padding:.25rem .25rem .25rem .9rem;background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}
.add:focus-within{outline:2px solid var(--acc);outline-offset:2px}
.add input{flex:1;padding:.55rem 0;border:0;background:transparent;outline:none}
.sr{position:absolute;width:1px;height:1px;margin:0;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
mark{background:color-mix(in srgb,var(--acc) 28%,transparent);color:inherit;border-radius:var(--r);padding:0 .1rem}
form.inline{display:inline}form.inline button{padding:.2rem .65rem;font-size:13px;font-weight:500;background:transparent;color:var(--fg);border-color:var(--line)}
form.inline button:hover{border-color:var(--acc);color:var(--acc);filter:none}
.flash{background:var(--chip);border-left:3px solid var(--acc);padding:.5rem .75rem;border-radius:var(--r)}
.chips{display:flex;flex-wrap:wrap;gap:.35rem;margin:.5rem 0}
.chip{background:var(--chip);color:var(--fg);border-color:transparent;border-radius:var(--r);padding:.15rem .65rem;font-size:13px;font-weight:500}
.chip.on{background:var(--acc);color:var(--on-acc)}
.empty{border:1px dashed var(--line);border-radius:var(--r);padding:1rem 1.5rem;color:var(--mut)}.empty h3{color:var(--fg);margin-top:0}
form[action$="/delete"] button{background:transparent;color:var(--bad);border-color:var(--bad)}
.meta,aside{font-variant-numeric:tabular-nums}
#palette{width:min(560px,92vw);margin:12vh auto 0;padding:0;background:color-mix(in srgb,var(--surface) 86%,transparent);backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);color:var(--fg);border:1px solid var(--line);border-radius:var(--r);box-shadow:0 24px 60px color-mix(in srgb,var(--fg) 25%,transparent)}
#palette::backdrop{background:color-mix(in srgb,var(--bg) 55%,transparent);backdrop-filter:blur(3px)}
#pal-q{width:100%;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:.95rem 1rem;font-size:16px;background:transparent;outline:none}
#pal-list{max-height:50vh;overflow:auto;padding:.35rem}
#pal-list a{display:block;padding:.55rem .75rem;color:var(--fg);border-radius:var(--r)}
#pal-list a[aria-selected=true]{background:var(--hover);box-shadow:inset 3px 0 0 var(--acc);text-decoration:none}
.toast{position:fixed;left:50%;bottom:1.25rem;z-index:40;display:flex;align-items:center;gap:.6rem;width:max-content;max-width:calc(100vw - 2rem);padding:.6rem .9rem;background:color-mix(in srgb,var(--surface) 86%,transparent);backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);color:var(--fg);border:1px solid var(--line);border-radius:var(--r);box-shadow:0 12px 32px color-mix(in srgb,var(--acc) 16%,transparent),0 2px 6px color-mix(in srgb,var(--fg) 10%,transparent);transform:translateX(-50%);animation:toast 4.5s cubic-bezier(.16,1,.3,1) forwards}
.toast.keep{animation:toast-in .35s cubic-bezier(.16,1,.3,1) backwards}
.tick{color:var(--acc);font-weight:700}
@keyframes toast{0%{opacity:0;transform:translate(-50%,12px)}8%,86%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;transform:translate(-50%,6px);visibility:hidden}}
@keyframes toast-in{from{opacity:0;transform:translate(-50%,12px)}}
.hero{margin:.5rem 0 1.6rem}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem}
@media(max-width:640px){.stats{grid-template-columns:repeat(2,1fr)}}
.tile{display:flex;flex-direction:column;gap:.4rem;padding:.9rem 1rem;background:color-mix(in srgb,var(--surface) 78%,transparent);border:1px solid var(--line);border-radius:var(--r);color:var(--fg);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--fg) 8%,transparent);animation:rise .5s cubic-bezier(.16,1,.3,1) backwards;animation-delay:calc(var(--i)*60ms)}
.tile span{color:var(--mut);font-size:13px}
.big{font-family:var(--mono);font-size:2rem;font-weight:600;letter-spacing:-.04em;line-height:1}
a.tile:hover{border-color:color-mix(in srgb,var(--acc) 45%,var(--line));text-decoration:none;transform:translateY(-2px)}
.tile.bad .big{color:var(--bad)}
@media(prefers-reduced-transparency:reduce){.card,.side,.toast,#palette{background:var(--surface);backdrop-filter:none;-webkit-backdrop-filter:none}}
.ph{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:1rem 2rem;margin:.25rem 0 1.5rem}
.ph h1{margin:0;font-size:clamp(1.9rem,4vw,2.6rem);overflow-wrap:anywhere}
.lede{margin:.5rem 0 0;max-width:62ch;color:var(--mut)}
.lede a{color:inherit;text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere}
.act{display:flex;align-items:center;gap:.5rem}
.sg{padding:.25rem .65rem;border:1px solid var(--line);border-radius:var(--r);color:var(--mut);font-size:13px;font-weight:500}
.sg:hover{color:var(--fg);text-decoration:none}.sg.on{background:var(--chip);color:var(--fg)}
.tfilter{margin:0 0 1rem}.tfilter input{width:min(22rem,100%)}
.tagcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;align-items:start}
.tagcard{display:flex;flex-direction:column;gap:.75rem;padding:1rem;background:color-mix(in srgb,var(--surface) 78%,transparent);border:1px solid var(--line);border-radius:var(--r);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--fg) 8%,transparent);animation:rise .5s cubic-bezier(.16,1,.3,1) backwards;animation-delay:calc(var(--i)*30ms)}
.tagcard .count{display:flex;align-items:baseline;gap:.4rem}.tagcard .count span{color:var(--mut);font-size:13px}
.tg.lg{align-self:flex-start;padding:.15rem .6rem;font-size:15px}
summary{cursor:pointer;list-style:none;color:var(--mut);font-size:13px}summary::-webkit-details-marker{display:none}
summary:hover{color:var(--acc)}details[open]>summary{color:var(--fg)}
summary::before{content:"›";display:inline-block;width:1em;transition:transform .15s}
details[open]>summary::before{transform:rotate(90deg)}
.hint{margin:.4rem 0;color:var(--mut);font-size:12.5px}
.tedit form{display:grid;gap:.25rem;margin-top:.6rem}.tedit form label{margin:.2rem 0 0}.tedit form button{justify-self:start}
details.del{margin-top:.75rem;padding-top:.75rem;border-top:1px solid var(--line)}
.drop{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.35rem;min-height:11rem;padding:1.5rem;text-align:center;background:color-mix(in srgb,var(--surface) 78%,transparent);border:1px dashed var(--line);border-radius:var(--r);cursor:pointer}
.drop input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
.drop:hover,.drop.over{border-color:var(--acc)}.drop:focus-within{outline:2px solid var(--acc);outline-offset:2px}
.drop.busy{opacity:.6;pointer-events:none}
.drop-t{font-weight:650;font-size:1.1rem;letter-spacing:-.02em}.drop-s{color:var(--mut)}
.panel{margin-top:1rem;padding:1.1rem;background:color-mix(in srgb,var(--surface) 78%,transparent);border:1px solid var(--line);border-radius:var(--r);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--fg) 8%,transparent)}
.panel h2{margin:0 0 .25rem}
.stats3{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem;margin:.75rem 0}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem}
.err{margin-top:1rem;color:var(--bad)}
.btn{display:inline-block;padding:.5rem .85rem;border-radius:var(--r);background:var(--acc);color:var(--on-acc);font-weight:600}.btn:hover{text-decoration:none;filter:brightness(1.08)}
.ghost{background:transparent;color:var(--fg);border-color:var(--line);font-weight:500}.ghost:hover{border-color:var(--acc);color:var(--acc);filter:none}
.howto{margin-top:1.5rem}.howto ul{margin:.6rem 0 0;padding-left:1.1rem;list-style:disc}.howto li{margin:.35rem 0;color:var(--mut)}.howto textarea{width:100%;margin-top:.6rem}
.steps{counter-reset:s;display:grid;gap:1rem;margin:0 0 1.5rem;padding:0;list-style:none}
.steps li{counter-increment:s;display:grid;grid-template-columns:2rem 1fr;gap:.35rem .9rem;align-items:start}
.steps li::before{content:counter(s);grid-row:1 / span 2;display:grid;place-items:center;width:2rem;height:2rem;border-radius:var(--r);background:var(--chip);font:600 13px var(--mono)}
.stepact{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem}
.dragbtn{display:inline-block;padding:.5rem .9rem;border:1px dashed var(--acc);border-radius:var(--r);color:var(--acc);font-weight:600;cursor:grab}
.dragbtn:hover{text-decoration:none;background:var(--chip)}
.edit-layout{display:grid;grid-template-columns:minmax(0,1fr) 20rem;gap:2rem;align-items:start}
@media(max-width:820px){.edit-layout{grid-template-columns:1fr}}
.dcard dl{display:grid;gap:.7rem;margin:.8rem 0 0}.dcard dt{color:var(--mut);font-size:12px}.dcard dd{margin:0;overflow-wrap:anywhere}
.msg{max-width:36rem}.msg-search{display:flex;gap:.5rem;margin:1rem 0}.msg-search input{flex:1}.links{display:flex;gap:1.25rem}
@keyframes rise{from{opacity:0;transform:translateY(10px)}}
button,.chip,a,.card{transition:background-color .15s,color .15s,border-color .15s,box-shadow .2s,transform .2s cubic-bezier(.16,1,.3,1)}
button:active,.chip:active{transform:scale(.98)}
.card:active{transform:scale(.995)}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}button:active,.chip:active,.card:hover,.card:active{transform:none}}
.skip{position:absolute;left:-999px;top:0}.skip:focus{left:.75rem;top:.75rem;background:var(--acc);color:var(--on-acc);padding:.4rem .7rem;border-radius:var(--r);z-index:30}`;
// The brand mark (docs/brand/brand-board.html is the design source): four ink tally strokes and a moss ribbon,
// so it reads as a hand tally and as a bookmark ribbon at once. Ink follows the text colour, the ribbon the accent.
const MARK_SVG = `<svg class=mark viewBox="0 0 44 32" width=26 height=19 aria-hidden=true focusable=false><path d="M5 5v22M13 5v22M21 5v22M29 5v22" fill=none stroke=currentColor stroke-width=4 stroke-linecap=round /><path d="M34 3h8v26l-4-4-4 4z" fill="var(--acc)" /></svg>`;
const FAVICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23147863'/%3E%3Cpath d='M8 8v16M13 8v16M18 8v16' stroke='%23fff' stroke-width='3' stroke-linecap='round'/%3E%3Cpath d='M22 6h5v20l-2.5-3-2.5 3z' fill='%23fff'/%3E%3C/svg%3E`;

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// Shared header block for every sub page: a large tight title, one plain sentence, an optional primary action.
const pageHead = (title, lede, action) => h`<div class=ph><div><h1>${title}</h1>${lede && h`<p class=lede>${lede}</p>`}</div>${action && h`<div class=act>${action}</div>`}</div>`;
const messagePage = (res, status, title, body) => res.status(status).send(page(title, h`${pageHead(title)}<div class=msg>${body}<form action="/" role=search class=msg-search><label class=sr for=msg-q>Search your bookmarks</label><input id=msg-q type=search name=q placeholder="Search bookmarks"><button>Search</button></form><p class=links><a href="/">Back to your bookmarks</a><a href="/tags">Tags</a></p></div>`));
const NAV = [['home', '/', 'Bookmarks'], ['tags', '/tags', 'Tags'], ['import', '/import', 'Import']];
const navHtml = cur => h`<nav aria-label="Primary">${NAV.map(([k, href, label]) => h`<a href="${href}"${k === cur ? raw(' aria-current=page') : ''}>${label}</a>`)}</nav>`;
const paletteTags = () => JSON.stringify(allTags().map(t => t.tag)).replace(/</g, '\\u003c').replace(/'/g, '\\u0027').replace(/&/g, '\\u0026');
const page = (title, body, { q = '', tag = '', cur = '' } = {}) => `<!doctype html><html lang=en><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<meta name=description content="Your personal bookmark archive: saved pages, tags, notes and full-text search on your own machine.">
<meta name=theme-color content="#f3f6f7" media="(prefers-color-scheme: light)"><meta name=theme-color content="#0a1013" media="(prefers-color-scheme: dark)">
<script>try{document.documentElement.dataset.view=localStorage.getItem('marks-view')==='list'?'list':'cards'}catch(e){document.documentElement.dataset.view='cards'}</script>
<link rel=icon href="${FAVICON}"><style>${CSS}</style>
${h`<a class=skip href="#main">Skip to content</a><header><a href="/" class=brand>${raw(MARK_SVG)}<span class=wordmark>marks</span></a>
<form action="/" role=search><div class=field><input type=search name=q value="${q}" placeholder="Search bookmarks" aria-label="Search title, note and page text">${tag && h`<input type=hidden name=tag value="${tag}">`}<button type=button class=kbd id=open-palette aria-label="Open command palette">Ctrl K</button></div><button class=sr>Search</button></form>${navHtml(cur)}</header>
<main id=main>${body}</main>
<footer><div class=fz><h3>Tools</h3><div class=fl><a class=drag href="${raw(esc(BOOKMARKLET))}" title="Drag this to your bookmarks bar">+ Save to marks</a><a href="/bookmarklet">Install help</a><a href="/import">Import</a><a href="/export?format=json">Export JSON</a><a href="/export?format=csv">Export CSV</a></div></div>
<div class=fz><h3>Maintenance</h3><div class=jobs>${jobsHtml()}</div></div>
<div class="fz about"><h3>About</h3><p>Made by <a href="https://github.com/trippusultan" rel="noopener noreferrer">@trippusultan</a></p><p>Built on Node.js, Express, SQLite, Mozilla Readability, metascraper and jsdom.</p></div></footer>
<dialog id=palette aria-label="Command palette"><input id=pal-q type=text placeholder="Search, jump to a tag, or paste a URL to save" autocomplete=off aria-label="Command palette"><ul id=pal-list role=listbox></ul><form id=pal-save method=post action="/save" hidden><input type=hidden name=url></form></dialog>
<script>(()=>{
const T=${raw(paletteTags())},doc=document,root=doc.documentElement,dlg=doc.getElementById('palette'),q=doc.getElementById('pal-q'),list=doc.getElementById('pal-list'),saveForm=doc.getElementById('pal-save'),openBtn=doc.getElementById('open-palette');
const ACTIONS=[['Import bookmarks','/import'],['Manage tags','/tags'],['Dead links','/?dead=1'],['Save button (bookmarklet)','/bookmarklet'],['Export JSON','/export?format=json'],['Export CSV','/export?format=csv'],['Home','/']];
if(openBtn&&/Mac|iPhone|iPad/.test(navigator.platform||''))openBtn.textContent='⌘ K';
const isOpen=()=>dlg.open||dlg.hasAttribute('open');
const isUrl=v=>{if(v.includes(' '))return false;try{const u=new URL(v.startsWith('http://')||v.startsWith('https://')?v:'https://'+v);return u.hostname.includes('.')}catch(e){return false}};
let items=[],sel=0;
const build=v=>{const t=v.trim(),s=t.toLowerCase(),out=[];
  if(t&&isUrl(t))out.push({l:'Save '+t,save:t});
  if(t)out.push({l:'Search for "'+t+'"',h:'/?q='+encodeURIComponent(t)});
  for(const [l,h] of ACTIONS)if(!s||l.toLowerCase().includes(s))out.push({l,h});
  for(const g of T)if(!s||g.includes(s))out.push({l:'#'+g,h:'/?tag='+encodeURIComponent(g)});
  return out.slice(0,12)};
const save=u=>{saveForm.elements.url.value=u;saveForm.requestSubmit()};
const render=()=>list.replaceChildren(...items.map((it,i)=>{const li=doc.createElement('li'),a=doc.createElement('a');a.textContent=it.l;a.setAttribute('href',it.h||'#');a.tabIndex=-1;if(i===sel)a.setAttribute('aria-selected','true');a.addEventListener('click',e=>{if(it.save){e.preventDefault();save(it.save)}});li.append(a);return li}));
const update=()=>{items=build(q.value);sel=0;render()};
const open=()=>{if(dlg.showModal){if(!dlg.open)dlg.showModal()}else dlg.setAttribute('open','');q.value='';update();q.focus()};
q.addEventListener('input',update);
q.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'){e.preventDefault();sel=(sel+1)%Math.max(items.length,1);render()}
  else if(e.key==='ArrowUp'){e.preventDefault();sel=(sel-1+items.length)%Math.max(items.length,1);render()}
  else if(e.key==='Enter'){e.preventDefault();list.querySelector('[aria-selected=true]')?.click()}});
dlg.addEventListener('click',e=>{if(e.target===dlg&&dlg.close)dlg.close()});
if(openBtn)openBtn.addEventListener('click',open);
doc.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();open();return}
  const tag=e.target.tagName;
  if(isOpen()||tag==='INPUT'||tag==='TEXTAREA'||e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.key==='/'){e.preventDefault();doc.querySelector('input[name=q]').focus();return}
  const cards=[...doc.querySelectorAll('.card a.t')],i=cards.indexOf(doc.activeElement);
  if(e.key==='j'){e.preventDefault();cards[Math.min(i+1,cards.length-1)]?.focus()}
  else if(e.key==='k'){e.preventDefault();cards[Math.max(i-1,0)]?.focus()}
  else if(e.key==='e'&&i>=0){e.preventDefault();cards[i].closest('.card').querySelector('a.edit')?.click()}});
const vt=[...doc.querySelectorAll('.vt')];
const sync=()=>vt.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===root.dataset.view)));
vt.forEach(b=>b.addEventListener('click',()=>{root.dataset.view=b.dataset.view;try{localStorage.setItem('marks-view',b.dataset.view)}catch(e){}sync()}));
sync();
})()</script>`.s}`;

// ---------- app ----------
const app = express();
app.set('etag', false);
app.use((req, res, next) => {
  // Blocks DNS rebinding (Host) and cross-site form posts (Origin). /save is exempt: the bookmarklet posts from any site.
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return res.status(403).send('bad host');
  const o = req.headers.origin;
  if (req.method === 'POST' && req.path !== '/save' && o && o !== `http://${req.headers.host}`) return res.status(403).send('cross-origin');
  // not "no-referrer": that makes browsers send "Origin: null" on our own form posts and the check above rejects them
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const tags = parseTags(req.query.tag), tag = tags.join(',');
  const pg = Math.max(1, parseInt(req.query.page) || 1), fq = ftsQuery(q), dead = req.query.dead === '1';
  const where = [], args = [];
  if (fq) { where.push('b.id IN (SELECT rowid FROM fts WHERE fts MATCH ?)'); args.push(fq); }
  for (const t of tags) { where.push('EXISTS (SELECT 1 FROM bookmark_tags t WHERE t.bookmark_id = b.id AND t.tag = ?)'); args.push(t); }
  if (dead) where.push('b.status IN (404, 410)');
  const rows = db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.saved_at DESC, b.id DESC LIMIT ? OFFSET ?`)
    .all(...args, PAGE + 1, (pg - 1) * PAGE).map(withTags);
  const total = db.prepare(`SELECT count(*) n FROM bookmarks b ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...args).n;
  const filtered = !!(q || tag || dead), empty = !filtered && total === 0;
  const ok = Object.hasOwn(FLASH, req.query.ok) ? FLASH[req.query.ok] : '';
  const keepToast = req.query.ok === 'deleted' && undo.item && Date.now() - undo.item.at < UNDO_MS; // Undo stays until you navigate
  const backParam = qs({ back: req.originalUrl === '/' ? '' : req.originalUrl });
  const more = rows.length > PAGE && rows.pop();
  if (fq && rows.length) { // \x01/\x02 mark hits; page text is escaped before they become <mark>
    const snip = new Map(db.prepare(`SELECT rowid, snippet(fts, -1, char(1), char(2), '…', 20) s FROM fts
      WHERE fts MATCH ? AND rowid IN (${rows.map(() => '?').join(',')})`).all(fq, ...rows.map(r => r.id)).map(r => [r.rowid, r.s]));
    for (const b of rows) b.snippet = snip.get(b.id);
  }
  const toggle = t => (tags.includes(t) ? tags.filter(x => x !== t) : [...tags, t]).join(',');
  const item = (b, i) => h`<li class="card${i === 0 && pg === 1 ? ' feat' : ''}${b.note || b.snippet ? ' tall' : ''}" style="--i:${Math.min(i, 14)}">
    <div class=top><img class=fav src="${b.favicon || new URL(b.url).origin + '/favicon.ico'}" alt="" loading=lazy referrerpolicy=no-referrer onerror="${raw(esc(`this.onerror=null;this.src='${FAV_FALLBACK}'`))}"><span class=dom>${domain(b.url)}</span>${isDead(b.status) && h`<span class=dead title="HTTP ${b.status} at last check">404</span>`}</div>
    <a class="t" href="${b.url}">${b.title || b.url}</a>
    ${b.snippet && h`<p class=note>${raw(esc(b.snippet).replace(/\x01/g, '<mark>').replace(/\x02/g, '</mark>'))}</p>`}
    ${b.note && h`<p class=note>${b.note}</p>`}
    <div class=foot>${b.tags.map(t => h`<a class=tg href="/${qs({ tag: t })}">#${t}</a>`)}<span class=when title="${date(b.saved_at)}">${ago(b.saved_at)}</span><a class=edit href="/b/${b.id}${backParam}">edit</a></div></li>`;
  const tagList = allTags(), deadCount = db.prepare('SELECT count(*) n FROM bookmarks WHERE status IN (404, 410)').get().n;
  const showHero = !filtered && !empty && pg === 1;
  const weekCount = showHero ? db.prepare('SELECT count(*) n FROM bookmarks WHERE saved_at >= ?').get(now() - 7 * 86400).n : 0;
  res.send(page('marks', h`${showHero && h`<section class=hero aria-label="Library overview"><h1>Your library</h1><div class=stats><a class=tile style="--i:0" href="/"><b class=big>${total}</b><span>Saved</span></a><div class=tile style="--i:1"><b class=big>${weekCount}</b><span>This week</span></div><a class=tile style="--i:2" href="/tags"><b class=big>${tagList.length}</b><span>Tags</span></a><a class="tile${deadCount ? ' bad' : ''}" style="--i:3" href="/?dead=1"><b class=big>${deadCount}</b><span>Dead links</span></a></div></section>`}<div class=layout>
    <section><form method=post action="/save" class=add><label class=sr for=add-url>Web address to save</label><input id=add-url type=text name=url inputmode=url autocomplete=off placeholder="Paste a URL to save" required><button>Save</button></form>
    ${ok && h`<div class="toast${keepToast ? ' keep' : ''}" role=status><span class=tick>✓</span>${ok}${keepToast && h` <form method=post action="/undo" class=inline><button>Undo</button></form>`}</div>`}
    <div class=toolbar>${filtered ? h`<p class=meta>${total} ${total === 1 ? 'bookmark' : 'bookmarks'}${q && h` matching “${q}”`}${tag && h` tagged ${tags.map(t => '#' + t).join(', ')}`}${dead && ' that look dead'} · <a href="/">clear</a></p>` : h`<p class=meta>${total} ${total === 1 ? 'bookmark' : 'bookmarks'}</p>`}
      <div class=seg role=group aria-label="View"><button type=button class=vt data-view=cards aria-pressed=true>Cards</button><button type=button class=vt data-view=list aria-pressed=false>List</button></div></div>
    <ul class=bento>${rows.map(item)}</ul>
    ${empty && h`<div class=empty><h3>Nothing saved yet</h3><p class=tagline>Keep your place.</p><ol><li>Drag the save button to your bookmarks bar (<a href="/bookmarklet">how</a>) and click it on any page.</li><li>Or paste a URL in the box above.</li><li>Or <a href="/import">import</a> a bookmarks export.</li></ol></div>`}
    ${!empty && !rows.length && h`<p class=meta>No matches. Try fewer words or <a href="/">clear the filter</a>.</p>`}
    ${pg > 1 && h`<a href="/${qs({ q, tag, dead: dead && '1', page: pg - 1 })}">← newer</a> `}${more && h`<a href="/${qs({ q, tag, dead: dead && '1', page: pg + 1 })}">older →</a>`}</section>
    <aside aria-label="Tags and status"><section class=side><h3>Tags <span class=n>${tagList.length}</span></h3>${tagList.length ? h`<div class=cloud>${tagList.map(t => h`<a href="/${qs({ q, tag: toggle(t.tag), dead: dead && '1' })}" class="tc${tags.includes(t.tag) ? ' on' : ''}">#${t.tag} <span class=n>${t.n}</span></a>`)}</div>` : h`<p class=meta>No tags yet. Add some when you save a page.</p>`}<a class=more href="/tags">Manage tags</a></section><section class=side><h3>Status</h3><a class="stat" href="/?dead=1"><span>Dead links</span><span class="badge${deadCount ? ' bad' : ''}">${deadCount}</span></a></section></aside></div>`, { q, tag, cur: 'home' }));
});

const badUrl = (res, given) => messagePage(res, 400, "Couldn't save that", given
  ? h`<p>“${String(given).slice(0, 200)}” is not an http(s) web address.</p>`
  : h`<p>No web address arrived. If you clicked the save bookmark, your browser dropped it: <a href="/bookmarklet">install the newer bookmark</a>, or paste the address on the <a href="/">home page</a>.</p>`);

app.get('/save', (req, res) => {
  const url = cleanUrl(req.query.url);
  if (!url) return badUrl(res, req.query.url);
  res.send(page('Save', h`<h2>Saving…</h2><p class=meta>${url}</p>
    <form id=f method=post action="/save"><input type=hidden name=url value="${url}"><button>Save</button> <a href="/">Cancel</a></form>
    <script>document.getElementById('f').submit()</script>`));
});

app.get('/bookmarklet', (req, res) => res.send(page('Bookmarklet', h`${pageHead('Save button', 'One click on any page saves it to marks. The server must be running when you click.')}
<ol class=steps><li><b>Show your bookmarks bar.</b> Press Ctrl+Shift+B (Cmd+Shift+B on a Mac) in Chrome, Edge or Firefox.</li>
<li><b>Drag this button onto the bar.</b><span class=stepact><a class=dragbtn href="${raw(esc(BOOKMARKLET))}">+ Save to marks</a><button type=button class=ghost data-copy=code-std>Copy code</button></span></li>
<li><b>Click it on any page.</b> A new tab opens on the edit screen: add tags and press Save.</li></ol>
<details class=howto><summary>Show the code</summary><textarea id=code-std readonly rows=6 onclick="this.select()">${BOOKMARKLET}</textarea></details>
<h3>If the button is blocked</h3><p class=meta>Some sites block pop-ups. This variant works in the same tab; drag it the same way.</p>
<p class=stepact><a class=dragbtn href="${raw(esc(BOOKMARKLET_GET))}">+ Save to marks (simple)</a><button type=button class=ghost data-copy=code-get>Copy code</button></p>
<details class=howto><summary>Show the simple code</summary><textarea id=code-get readonly rows=3 onclick="this.select()">${BOOKMARKLET_GET}</textarea></details>
<p class=meta>Have an older save bookmark that says "No web address arrived"? Delete it and install this one.</p>
<script>document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{const ta=document.getElementById(b.dataset.copy);try{await navigator.clipboard.writeText(ta.value)}catch(e){const d=ta.closest('details');if(d)d.open=true;ta.select();document.execCommand('copy')}const t=b.textContent;b.textContent='Copied';setTimeout(()=>{b.textContent=t},1600)}))</script>`)));

app.post('/save', (req, res) => {
  const url = cleanUrl(req.body?.url);
  if (!url) return badUrl(res, req.body?.url);
  const r = insertBm.run({ url, title: '', description: '', image: '', favicon: '', note: '', text: '', saved_at: now(), status: null, checked_at: null, archived_at: null });
  const id = db.prepare('SELECT id FROM bookmarks WHERE url = ?').get(url).id;
  if (r.changes) enrichInBackground(id, url);
  res.redirect(303, `/b/${id}?${r.changes ? 'new' : 'dup'}=1`);
});

app.get('/b/:id', (req, res) => {
  const b = withTags(db.prepare(`${SELECT} WHERE b.id=?`).get(+req.params.id));
  if (!b) return messagePage(res, 404, 'Bookmark not found', h`<p class=meta>That bookmark does not exist, or it was deleted.</p>`);
  const tags = JSON.stringify(allTags().map(t => t.tag)).replace(/</g, '\\u003c');
  const back = safeBack(req.query.back);
  const st = b.status;
  const check = st == null ? 'Not checked yet' : h`<span class="badge${isDead(st) ? ' bad' : ''}">HTTP ${st}</span>`;
  res.send(page(b.title || b.url, h`${pageHead(b.title || b.url, h`<a href="${b.url}" rel="noopener noreferrer">${b.url}</a>`)}
    <div class=edit-layout><div class=col-main>
    ${req.query.new && h`<p class=flash role=status>Saved ✓ ${!b.archived_at && 'Fetching the page in the background: add tags now.'}</p>`}
    ${req.query.dup && h`<p class=flash role=status>Already saved: edit it below.</p>`}
    <form class=edit method=post action="/b/${b.id}">${req.query.new && h`<input type=hidden name=done value=1>`}<input type=hidden name=back value="${back}">
    <label for=title>Title</label><input type=text id=title name=title value="${b.title}" placeholder="${domain(b.url)}">
    <label for=tags>Tags (comma separated)</label><input type=text id=tags name=tags value="${b.tags.join(', ')}" autocomplete=off list=tl autofocus><datalist id=tl></datalist>
    <div class=chips>${allTags().slice(0, 12).map(t => h`<button type=button class=chip data-t="${t.tag}">#${t.tag}</button>`)}</div>
    <label for=note>Note</label><textarea id=note name=note rows=5>${b.note}</textarea>
    <p><button>Save</button> <a href="${back}">Cancel</a></p></form>
    <form method=post action="/b/${b.id}/delete"><input type=hidden name=back value="${back}"><button>Delete</button></form></div>
    <aside class="side dcard" aria-label="Bookmark details"><div class=top><img class=fav src="${b.favicon || new URL(b.url).origin + '/favicon.ico'}" alt="" loading=lazy referrerpolicy=no-referrer onerror="${raw(esc(`this.onerror=null;this.src='${FAV_FALLBACK}'`))}"><span class=dom>${domain(b.url)}</span></div>
    <dl><dt>Description</dt><dd>${b.description || 'None captured yet'}</dd><dt>Saved</dt><dd>${ago(b.saved_at)} <span class=meta>(${date(b.saved_at)})</span></dd><dt>Last check</dt><dd>${check}</dd><dt>Page text</dt><dd>${b.text ? 'Archived' : b.archived_at ? 'Nothing readable found' : 'Not archived yet'}</dd></dl></aside></div>
    <script>
    // Native datalist, but options are rebuilt for the tag after the last comma.
    const T=${raw(tags)},inp=document.getElementById('tags'),dl=document.getElementById('tl');
    inp.addEventListener('input',()=>{
      const i=inp.value.lastIndexOf(','),head=inp.value.slice(0,i+1),rest=inp.value.slice(i+1),
        word=rest.trim().toLowerCase(),lead=rest.match(/^\\s*/)[0],have=inp.value.split(',').map(s=>s.trim().toLowerCase());
      dl.replaceChildren(...(word?T.filter(t=>t.startsWith(word)&&!have.slice(0,-1).includes(t)).slice(0,8):[])
        .map(t=>Object.assign(document.createElement('option'),{value:head+lead+t})));
    });
    const chips=[...document.querySelectorAll('.chip')],note=document.getElementById('note');
    const list=()=>inp.value.split(',').map(s=>s.trim()).filter(Boolean);
    const sync=()=>{const on=list().map(s=>s.toLowerCase());chips.forEach(c=>c.classList.toggle('on',on.includes(c.dataset.t)))};
    chips.forEach(c=>c.addEventListener('click',()=>{
      const cur=list(),i=cur.map(s=>s.toLowerCase()).indexOf(c.dataset.t);
      if(i<0)cur.push(c.dataset.t);else cur.splice(i,1);
      inp.value=cur.length?cur.join(', ')+', ':'';inp.focus();sync();
    }));
    inp.addEventListener('input',sync);sync();
    note.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))e.target.form.requestSubmit()});
    </script>`));
});

app.post('/b/:id', (req, res) => {
  if (typeof req.body?.note !== 'string') return res.sendStatus(400); // empty POST (body is {} or undefined): never treat it as "clear the note"
  const id = +req.params.id;
  const r = db.prepare('UPDATE bookmarks SET title = coalesce(nullif(?, \'\'), title), note = ? WHERE id = ?')
    .run(String(req.body.title || '').trim(), String(req.body.note || '').trim(), id);
  if (!r.changes) return res.sendStatus(404);
  setTags(id, parseTags(req.body.tags));
  if (req.body.done) return res.send(page('Saved', h`<p>Saved ✓ You can close this tab.</p><p><a href="/">Open marks</a></p><script>window.close()</script>`));
  res.redirect(303, withOk(safeBack(req.body?.back), 'saved'));
});

app.post('/b/:id/delete', (req, res) => {
  const id = +req.params.id;
  const b = withTags(db.prepare(`${SELECT} WHERE b.id=?`).get(id));
  if (b) { undo.item = { b, at: Date.now() }; db.prepare('DELETE FROM bookmarks WHERE id=?').run(id); }
  res.redirect(303, withOk(safeBack(req.body?.back), 'deleted'));
});

app.post('/undo', (req, res) => {
  const u = undo.item;
  undo.item = null;
  if (!u || Date.now() - u.at >= UNDO_MS) return res.redirect(303, '/');
  if (db.prepare('SELECT 1 FROM bookmarks WHERE url = ?').get(u.b.url)) return res.redirect(303, withOk('/', 'exists'));
  const idTaken = db.prepare('SELECT 1 FROM bookmarks WHERE id = ?').get(u.b.id); // ids are reused after deletes
  const r = restoreStmt.run({ ...u.b, id: idTaken ? null : u.b.id });
  setTags(r.lastInsertRowid, u.b.tags);
  res.redirect(303, '/?ok=restored');
});

app.get('/import', (req, res) => res.send(page('Import', h`${pageHead('Import bookmarks', 'Bring in a bookmarks export from Chrome, Firefox, Safari or Raindrop. Links you already have are skipped, and nothing is written until you confirm.')}
<div class=import>
<label class=drop id=drop for=f><input type=file id=f accept=".html,.htm"><span class=drop-t>Drop your bookmarks file here</span><span class=drop-s>or choose a file (.html)</span></label>
<p id=err class=err role=alert hidden></p>
<div id=preview class=panel hidden aria-live=polite><h2>Ready to import</h2><p class=meta>File: <b id=p-file></b></p><div class=stats3><div class=tile><b class=big id=p-new>0</b><span>new</span></div><div class=tile><b class=big id=p-dupe>0</b><span>already saved</span></div><div class=tile><b class=big id=p-tags>0</b><span>tags found</span></div></div><p id=p-none class=meta hidden>Everything in this file is already in your library.</p><div class=row><button id=go type=button>Import</button><button id=again type=button class=ghost>Choose another file</button></div></div>
<div id=result class=panel hidden role=status><h2>Imported</h2><div class=stats3><div class=tile><b class=big id=r-added>0</b><span>added</span></div><div class=tile><b class=big id=r-skipped>0</b><span>skipped, already saved</span></div></div><p class=meta>Page text isn't fetched during import. Archive the pages in the background to make imported bookmarks searchable by their content.</p><div class=row><a class=btn href="/">View bookmarks</a><form method=post action="/archive" class=inline><button>Archive pages now</button></form></div></div>
<details class=howto><summary>How do I export my bookmarks?</summary><ul><li><b>Chrome:</b> open chrome://bookmarks, use the menu at the top right, then Export bookmarks.</li><li><b>Firefox:</b> press Ctrl+Shift+O, then Import and Backup, then Export Bookmarks to HTML.</li><li><b>Safari:</b> File, then Export, then Bookmarks.</li><li><b>Raindrop.io:</b> open Settings, choose Import and Export, then export as HTML.</li></ul></details>
</div>
<script>(()=>{
const $=id=>document.getElementById(id),f=$('f'),drop=$('drop'),prev=$('preview'),res=$('result'),err=$('err'),go=$('go');
let file=null;
const fail=m=>{err.textContent=m;err.hidden=false;prev.hidden=true;res.hidden=true};
const take=async x=>{
  file=x;err.hidden=true;res.hidden=true;drop.classList.add('busy');drop.setAttribute('aria-busy','true');
  try{
    const r=await fetch('/import?dry=1',{method:'POST',headers:{'content-type':'text/plain'},body:x});
    if(!r.ok)throw new Error('bad status');
    const d=await r.json();
    if(!d.total)return fail("That doesn't look like a bookmarks export: no web links were found.");
    $('p-file').textContent=x.name;$('p-new').textContent=d.fresh;$('p-dupe').textContent=d.dupes;$('p-tags').textContent=d.tags;
    go.disabled=d.fresh===0;go.textContent=d.fresh?'Import '+d.fresh+' bookmarks':'Nothing new to import';$('p-none').hidden=d.fresh!==0;prev.hidden=false;
  }catch(e){fail('Could not read that file. Choose an HTML bookmarks export.')}
  finally{drop.classList.remove('busy');drop.removeAttribute('aria-busy')}
};
f.addEventListener('change',()=>{if(f.files[0])take(f.files[0])});
['dragenter','dragover'].forEach(t=>drop.addEventListener(t,()=>drop.classList.add('over')));
['dragleave','drop'].forEach(t=>drop.addEventListener(t,()=>drop.classList.remove('over')));
go.addEventListener('click',async()=>{
  go.disabled=true;go.textContent='Importing…';
  try{
    const r=await fetch('/import',{method:'POST',headers:{'content-type':'text/plain'},body:file});
    if(!r.ok)throw new Error('bad status');
    const m=/Imported (\\d+) new of (\\d+)/.exec(await r.text());
    $('r-added').textContent=m[1];$('r-skipped').textContent=m[2]-m[1];prev.hidden=true;res.hidden=false;
  }catch(e){fail('The import failed and nothing was changed. Try again.')}
});
$('again').addEventListener('click',()=>{f.value='';prev.hidden=true;res.hidden=true;f.click()});
})()</script>`, { cur: 'import' })));

// Dry run: what an import would do, without writing anything. Repeats inside the file count as already saved.
const dryRun = items => {
  const urls = [...new Set(items.map(i => i.url))], have = new Set();
  for (let i = 0; i < urls.length; i += 500) {
    const chunk = urls.slice(i, i + 500);
    for (const r of db.prepare(`SELECT url FROM bookmarks WHERE url IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) have.add(r.url);
  }
  const seen = new Set(), tags = new Set();
  for (const it of items) { if (seen.has(it.url) || have.has(it.url)) continue; seen.add(it.url); it.tags.forEach(t => tags.add(t)); }
  return { total: items.length, fresh: seen.size, dupes: items.length - seen.size, tags: tags.size };
};

app.post('/import', express.text({ type: '*/*', limit: '200mb' }), (req, res) => {
  const items = parseNetscape(typeof req.body === 'string' ? req.body : '');
  if (req.query.dry === '1') return res.json(dryRun(items));
  const added = importAll(items);
  res.type('text').send(`Imported ${added} new of ${items.length} http(s) links.`);
});

app.get('/tags', (req, res) => {
  const sort = req.query.sort === 'az' ? 'az' : 'used';
  const list = allTags();
  if (sort === 'az') list.sort((a, b) => a.tag.localeCompare(b.tag));
  const saved = db.prepare('SELECT count(*) n FROM bookmarks').get().n;
  const sg = (k, href, label) => h`<a class="sg${sort === k ? ' on' : ''}" href="${href}"${sort === k ? raw(' aria-current=true') : ''}>${label}</a>`;
  if (!list.length) return res.send(page('Tags', h`${pageHead('Tags', 'Nothing tagged yet.')}<div class=empty><h3>No tags yet</h3><p>Tags appear when you add them to a bookmark. Open any bookmark, type a tag (separate several with commas) and press Save.</p><a href="/">Back to your bookmarks</a></div>`, { cur: 'tags' }));
  res.send(page('Tags', h`${pageHead('Tags', `${plural(list.length, 'tag')} across ${plural(saved, 'bookmark')}. Rename a tag onto another to merge them; delete removes it from every bookmark.`, h`<div class=seg role=group aria-label="Sort tags">${sg('used', '/tags', 'Most used')}${sg('az', '/tags?sort=az', 'A to Z')}</div>`)}
<div class=tfilter><label class=sr for=tag-filter>Filter tags</label><input id=tag-filter type=search placeholder="Filter tags" autocomplete=off></div>
<ul class=tagcards>${list.map((t, i) => h`<li class=tagcard style="--i:${Math.min(i, 14)}" data-name="${t.tag}"><a class="tg lg" href="/${qs({ tag: t.tag })}">#${t.tag}</a><div class=count><b class=big>${t.n}</b><span>${t.n === 1 ? 'bookmark' : 'bookmarks'}</span></div><details class=tedit><summary>Edit</summary><form method=post action="/tags/rename"><input type=hidden name=from value="${t.tag}"><label for=rn-${i}>New name</label><input id=rn-${i} type=text name=to value="${t.tag}" autocomplete=off><p class=hint>Renaming onto an existing tag merges them. #${t.tag} is on ${plural(t.n, 'bookmark')}.</p><button>Rename</button></form><details class=del><summary>Delete tag</summary><p class=hint>Removes #${t.tag} from ${plural(t.n, 'bookmark')}. The bookmarks themselves stay.</p><form method=post action="/tags/delete"><input type=hidden name=tag value="${t.tag}"><button>Remove from ${plural(t.n, 'bookmark')}</button></form></details></details></li>`)}</ul>
<p id=tag-none class=meta hidden>No tags match that filter.</p>
<script>(()=>{const q=document.getElementById('tag-filter'),cards=[...document.querySelectorAll('.tagcard')],none=document.getElementById('tag-none');
q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase().replace(/^#/,'');let n=0;cards.forEach(c=>{const ok=!v||c.dataset.name.includes(v);c.hidden=!ok;if(ok)n++});none.hidden=n>0})})()</script>`, { cur: 'tags' }));
});

app.post('/tags/rename', (req, res) => {
  const to = parseTags(req.body.to)[0];
  if (!to) return messagePage(res, 400, 'Bad tag', h`<p>Give the new tag name.</p>`);
  renameTag(String(req.body.from), to);
  res.redirect(303, '/tags');
});

app.post('/tags/delete', (req, res) => {
  db.prepare('DELETE FROM bookmark_tags WHERE tag = ?').run(String(req.body.tag));
  res.redirect(303, '/tags');
});

app.post('/archive', (req, res) => { background('archive', archiveMissing); res.redirect(303, '/'); });
app.post('/check', (req, res) => { background('link check', checkLinks); res.redirect(303, '/'); });

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

app.use((req, res) => messagePage(res, 404, 'Page not found', h`<p class=meta>Nothing lives at ${req.path}.</p>`));

module.exports = { app, db, checkLinks, archiveMissing, parseNetscape, settled, ago, undo, safeBack };

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => console.log(`marks: http://localhost:${PORT}  db: ${db.name}`));
  cron.schedule('0 3 * * 0', () => checkLinks().catch(console.error)); // Sundays 03:00, only while the server runs
}
