# rytemarks

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

## Importing, folders and restoring

Import takes a browser bookmarks export (`.html`) or rytemarks' own JSON export. Folder names in a browser export become tags ("Bookmarks bar", "Other bookmarks" and similar root folders are ignored). To restore from a backup export: stop the server, move `marks.db` aside, start it (it creates an empty one), open Import and choose a file from Export JSON. Bookmarks, tags, notes and archived page text come back; links you already have are skipped.

## Cleaning up duplicates

URLs are normalised when you save or import: tracking parameters (`utm_*`, `fbclid`, `gclid` and friends), empty `#fragments` and trailing slashes are dropped, so the same page saved twice is one bookmark (single-page-app `#/route` fragments are kept). For bookmarks saved before that, `npm run dedupe` shows what would merge (a dry run); `npm run dedupe -- --apply` first writes `backups/marks-before-dedupe-<time>.db`, then merges each group into its oldest bookmark (notes joined, tags combined, longest page text kept).

## Backups and auto-start

`npm run backup` writes `backups/marks-<date>.db` (safe while the server runs; to restore, copy it over `marks.db` with the server stopped). Double-click `start-hidden.vbs` to run rytemarks without a console window, and put a shortcut to it in `shell:startup` (Win+R) so the bookmarklet and the weekly link check always have a server to talk to.

The server also writes a dated backup to `backups/` at start-up (if today's is missing) and every day at 02:15 while it runs, keeping the newest 14 (other files in that folder are never touched). The home page Status panel shows the date of the last one. To restore, stop the server and copy a `marks-YYYY-MM-DD.db` over `marks.db`.

## Brand

The logo is a tally mark (four strokes and a ribbon) drawn as inline SVG, next to a "rytemarks" wordmark set in the terminal font; the favicon is the same mark. On the dark theme the strokes take the text colour, so nothing else is needed. `docs/brand/brand-board.html` holds the palette and tagline, and `test-brand.js` keeps the mark and palette in sync with the app. A PNG logo and wordmark were tried and dropped; the supplied files are kept in `docs/brand/logo/` and in git history (commit fcf255e). The database file is still `marks.db`.

## Look and shortcuts

Cool slate neutrals with one mint-teal accent, a local terminal-style monospace stack (Cascadia Mono, JetBrains Mono, SF Mono, Menlo, Consolas; no font files), monospace for domains, dates and counts, 8px corners, light and dark following your system. The home page opens with a "Your library" hero and four live stat tiles (saved, this week, tags, dead links; shown only on the unfiltered first page), with soft accent light behind the page, glass panels and a faint grain (all off or solid under reduced transparency and reduced motion). Below it is a bento grid (the newest bookmark is featured, cards with notes are taller) with a Cards / List toggle that your browser remembers. Motion is CSS only and switches off under reduced motion. Scrollbars are themed too: a slim rounded slate thumb that turns mint on hover (Chrome, Edge, Safari), or the standard thin bar in Firefox.

Navigation is an icon + label top bar with the links centred and a filled Add button on the right. On phones the header is just the centred logo and the links move to a bottom tab bar (Bookmarks, Tags, Import); adding on a phone is the "Paste a URL" field on the home page. There is no search button in the header: search is the field on the home page, or the palette below. The footer is one slim bar with the credit and tool links. Check links and Archive pages live in the Status panel on the home page.

Icons are [Phosphor Icons](https://phosphoricons.com) (regular weight, MIT licence). The twenty in use are copied into `icons.js` (licence text included) and served as one inline sprite, so there is no network request and no runtime dependency.

- `Ctrl`/`Cmd` + `K`: command palette (search, jump to a tag, open Import or Tags, or paste a URL to save it)
- `/`: focus the search box (opens the palette on pages without one)
- `j` / `k`: move through bookmarks, `Enter` opens, `e` edits
