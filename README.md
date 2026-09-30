# marks

Personal bookmark manager. Node + Express + better-sqlite3, server-rendered, one SQLite file, localhost only. No accounts, no telemetry.

## Run

```
npm install
npm start          # http://localhost:4040
npm test
```

Binds to `127.0.0.1:4040` and rejects requests whose `Host` isn't localhost (DNS-rebinding guard) or whose `Origin` is a foreign site (except `/save`, which the bookmarklet needs).

## Where the data is

`marks.db` in this folder (override with `MARKS_DB=/path/to/file.db`). That single file is the whole archive: bookmarks, tags, notes, archived page text, and the search index. Back it up by copying it while the server is idle (it uses the default rollback journal, so there is no `-wal` sidecar to forget).

## Install the bookmarklet

Open http://localhost:4040/bookmarklet. Drag the link to your bookmarks bar, or copy the code from the box into a new bookmark's URL field. If the standard button misbehaves (popups or form posts blocked), use the simple variant. You can also paste any URL into the box on the home page.

Saving is instant: the server stores the URL right away and fetches the page in the background. In the tab that opens, add tags and press Save and the tab closes itself. Saving a URL already in the archive just opens it for editing. Pages that block the server's fetch, or aren't HTML, are still saved (URL as title, no text).

## Using it

- **Search**: FTS5 over title, note and archived article text (Readability extract). Words are prefix-matched, all must match. Combine with the tag filter in the sidebar; results are newest first.
- **Link check**: every Sunday 03:00 (only while the server is running) each link is re-fetched and 404/410s get a red `404` badge, which clears if the link recovers. Timeouts and DNS errors are ignored as transient. Press **Check links now** in the footer to run it on demand; **Dead links (N)** in the sidebar lists the flagged ones.
- **Import**: `/import`, any Netscape bookmarks HTML (Raindrop, Chrome, Firefox). Takes `TAGS`, `ADD_DATE` and `<DD>` notes; folders are ignored, non-http(s) links are dropped, existing URLs are skipped. Imports start without page text; press **Archive N pages** in the footer to fetch it in the background (one attempt per page).
- **Undo**: deleting a bookmark shows an Undo button on the next page (one level, 5 minutes, held in memory).
- **Export**: `/export?format=json` (everything, including page text) or `/export?format=csv` (no page text, since cells that large break spreadsheets; risky leading `= + - @` are prefixed with `'`).

## Backups and auto-start

`npm run backup` writes `backups/marks-<date>.db` (safe while the server runs; to restore, copy it over `marks.db` with the server stopped). Double-click `start-hidden.vbs` to run marks without a console window, and put a shortcut to it in `shell:startup` (Win+R) so the bookmarklet and the weekly link check always have a server to talk to.

## Brand

The look is defined in `docs/brand/brand-board.html` (open it in a browser): light editorial, paper / ink / moss, a tally-mark logo (four strokes and a ribbon), a local serif for the name and headings, system sans for everything else, light first with dark following the system. The app's header mark, favicon and palette use the same paths and hex values; `test-brand.js` keeps the two in sync.

## Look and shortcuts

Cool slate neutrals with one mint-teal accent, a heavy local sans (no font files), monospace for domains, dates and counts, 8px corners, light and dark following your system. The home page opens with a "Your library" hero and four live stat tiles (saved, this week, tags, dead links; shown only on the unfiltered first page), with soft accent light behind the page, glass panels and a faint grain (all off or solid under reduced transparency and reduced motion). Below it is a bento grid (the newest bookmark is featured, cards with notes are taller) with a Cards / List toggle that your browser remembers. Motion is CSS only and switches off under reduced motion.

- `Ctrl`/`Cmd` + `K`: command palette (search, jump to a tag, open Import or Tags, or paste a URL to save it)
- `/`: focus the search box
- `j` / `k`: move through bookmarks, `Enter` opens, `e` edits
