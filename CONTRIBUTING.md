# Contributing

Thanks for wanting to help. rytemarks is deliberately small: one Express server file, one SQLite file, no build step. Changes that keep it that way are the easiest to merge.

## Run it

```
git clone https://github.com/trippusultan/rytemarks.git
cd rytemarks
npm ci
npm start          # http://localhost:4040
```

Use a scratch database while developing so you never touch your real bookmarks:

```
MARKS_DB=/tmp/dev.db MARKS_BACKUPS=/tmp/dev-backups PORT=4141 npm start
```

On Windows (PowerShell): `$env:MARKS_DB="$env:TEMP\dev.db"; $env:PORT="4141"; npm start`.

## Test it

```
npm test           # node --test, about 20 seconds
```

- Every `test-*.js` file runs in its own process with its own temporary database (`test-helpers.js` sets `MARKS_DB` before the server loads). Tests never need the network: a small fake site is started for anything that fetches pages.
- Write the failing test first, watch it fail for the right reason, then make it pass. Bug fixes get a test that reproduces the bug.
- Tests run on Windows and Linux in CI; please avoid platform-specific paths and shell commands in tests.

## Conventions

- **Node 22, CommonJS**, 2-space indent (see `.editorconfig`). No build step, no TypeScript.
- **No new runtime dependency** unless there is no reasonable alternative; say why in the pull request.
- **Server-rendered HTML** through the `h` tagged template, which escapes by default. `raw()` is only for markup you wrote yourself. Keep page scripts tiny and dependency-free.
- **Look and feel:** colours and spacing come from the CSS variables at the top of the stylesheet in `server.js`; the only corner radius is `var(--r)`; fonts are local system fonts. `docs/brand/brand-board.html` is the design reference.
- **Icons** are [Phosphor](https://phosphoricons.com) (MIT) inlined from `icons.js`. To add one, copy its inner SVG markup from `@phosphor-icons/core` (regular weight) into `icons.js` under the existing licence header; a test checks that every icon the pages use is defined.
- **Data safety first:** anything that rewrites or deletes rows needs a backup step or a dry run, and a test for what it must not touch.

## Pull requests

1. Open an issue first for anything big; small fixes can go straight to a pull request.
2. Keep one change per pull request, with tests, and update the README if behaviour changes.
3. CI must be green (Node 22 on Ubuntu and Windows).

By contributing you agree your work is released under the project's [ISC licence](LICENSE).
