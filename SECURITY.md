# Security

rytemarks is a **single-user app that runs on your own machine**. Its security model is "reachable only by you, on localhost", not "safe to put on the internet". Please read the model below before deploying it anywhere unusual.

## Model

- **Localhost only.** The server binds to `127.0.0.1` and rejects any request whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]` (a guard against DNS rebinding).
- **No accounts, no login.** Anyone who can reach the port can read and change everything. Do **not** expose it with port forwarding, `0.0.0.0`, a tunnel or a reverse proxy without adding your own authentication in front of it.
- **Cross-site requests.** Every `POST` whose `Origin` is another site is refused. `/save` (used by the save button, which runs on any page you visit) does its own check: it needs either the secret key carried by the save button (a 36-hex-character token stored beside the database in `marks.db.token`, compared in constant time) or a request from the app's own pages. `GET /save` needs the key too, so a web page cannot open it and make the server fetch URLs.
- **The server fetches the URLs you save** (title, description, article text) and re-checks them weekly. That is the feature, and it means the server can reach anything your machine can reach, including your local network. Only save links you are happy to have fetched.
- **Saved page text is untrusted.** It is stored as plain text, escaped on output, and CSV exports neutralise leading `= + - @` so spreadsheets do not run titles as formulas.
- **Your data is not encrypted.** The whole archive is one SQLite file (`marks.db`) and backups are plain copies of it. Protect the folder with your operating system's permissions or disk encryption.
- **No telemetry, no third-party requests** from the app itself (fonts are local, icons are inline). Favicons of saved sites are loaded by your browser from those sites.

## Supported versions

Only the latest commit on `main` is supported.

## Reporting a vulnerability

Please report it privately rather than in a public issue: use **Security → Report a vulnerability** on the GitHub repository (private vulnerability reporting). Include what you did, what you expected, what happened, and the version or commit. You will get a reply as soon as the maintainer can, and a fix and credit (if you want it) once it is confirmed.

Things that are working as designed and are not vulnerabilities on their own: no login screen, the server being able to fetch local addresses you asked it to save, and the unencrypted database file.
