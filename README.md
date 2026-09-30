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

Saving a URL already in the archive just opens it for editing. Pages that block the server's fetch, or aren't HTML, are still saved (URL as title, no text).

## Using it

- **Search**: FTS5 over title, note and archived article text (Readability extract). Words are prefix-matched, all must match. Combine with the tag filter in the sidebar; results are newest first.
- **Link check**: every Sunday 03:00 (only while the server is running) each link is re-fetched and 404/410s get a red `404` badge, which clears if the link recovers. Timeouts and DNS errors are ignored as transient.
- **Import**: `/import`, any Netscape bookmarks HTML (Raindrop, Chrome, Firefox). Takes `TAGS`, `ADD_DATE` and `<DD>` notes; folders are ignored, non-http(s) links are dropped, existing URLs are skipped. Imports don't fetch page text, so they're searchable by title/note only.
- **Export**: `/export?format=json` (everything, including page text) or `/export?format=csv` (no page text, since cells that large break spreadsheets; risky leading `= + - @` are prefixed with `'`).
