// Repository hygiene: what a stranger sees on GitHub. No server needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const exists = f => fs.existsSync(path.join(root, f));

test('github-ready repository', async t => {
  await t.test('LICENSE is ISC with a copyright line', () => {
    const l = read('LICENSE');
    assert.match(l, /^ISC License/);
    assert.match(l, /Copyright \(c\) 2026 trippusultan/);
    assert.match(l, /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/);
  });

  await t.test('package.json describes the project honestly', () => {
    const p = JSON.parse(read('package.json'));
    assert.equal(p.name, 'rytemarks');
    assert.equal(p.license, 'ISC');
    assert.equal(p.private, true, 'a real boolean: this is an app, not an npm package');
    assert.equal(p.author, 'trippusultan');
    assert.equal(p.engines.node, '>=22');
    assert.match(p.description, /bookmark/i);
    assert.notEqual(p.description, 'Personal bookmark manager');
    assert.equal(p.repository.url, 'git+https://github.com/trippusultan/rytemarks.git');
    assert.equal(p.bugs.url, 'https://github.com/trippusultan/rytemarks/issues');
    assert.equal(p.homepage, 'https://github.com/trippusultan/rytemarks#readme');
    assert.ok(p.keywords.includes('bookmarks') && p.keywords.includes('self-hosted'));
    const lock = JSON.parse(read('package-lock.json'));
    assert.equal(lock.name, 'rytemarks');
    assert.equal(lock.packages[''].name, 'rytemarks');
  });

  await t.test('README has the sections a newcomer looks for, with real screenshots and working relative links', () => {
    const r = read('README.md');
    for (const h of ['## Features', '## Quick start', '## Configuration', '## Install the save button', '## Your data, backups and restore', '## Keyboard shortcuts', '## Security model', '## Development', '## Credits', '## Licence'])
      assert.ok(r.includes('\n' + h + '\n'), 'missing section ' + h);
    assert.match(r, /\[!\[CI\]\(https:\/\/github\.com\/trippusultan\/rytemarks\/actions\/workflows\/ci\.yml\/badge\.svg\)\]/);
    assert.match(r, /\[!\[Licence: ISC\]/);
    for (const v of ['PORT', 'MARKS_DB', 'MARKS_BACKUPS']) assert.match(r, new RegExp('\\| `' + v + '` \\|'), v + ' documented in the config table');
    assert.doesNotMatch(r, /folders are ignored/, 'folders became tags');
    for (const shot of ['home-dark.png', 'home-light.png', 'home-phone.png']) {
      assert.ok(r.includes('docs/screenshots/' + shot), shot + ' shown in the README');
      const buf = fs.readFileSync(path.join(root, 'docs', 'screenshots', shot));
      assert.equal(buf.subarray(1, 4).toString(), 'PNG', shot);
      assert.ok(buf.length > 10000, shot + ' is a real image');
    }
    // every relative link and image in the README points at a file that exists
    for (const [, target] of r.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) assert.ok(exists(target.split('#')[0]), 'broken link: ' + target);
  });

  await t.test('CI runs the tests on Node 22 on Windows and Linux', () => {
    const c = read('.github/workflows/ci.yml');
    assert.match(c, /node-version:\s*22/);
    assert.match(c, /windows-latest/);
    assert.match(c, /ubuntu-latest/);
    assert.match(c, /npm ci/);
    assert.match(c, /npm test/);
    assert.match(c, /pull_request/);
  });

  await t.test('community files exist and say something useful', () => {
    assert.match(read('SECURITY.md'), /## Reporting a vulnerability/);
    assert.match(read('SECURITY.md'), /localhost/);
    assert.match(read('CONTRIBUTING.md'), /npm test/);
    assert.match(read('.gitattributes'), /^\* text=auto/m);
    assert.match(read('.gitattributes'), /\*\.png binary/);
    assert.match(read('.editorconfig'), /^root = true/m);
  });

  await t.test('.gitignore keeps the owner\'s data, keys and tool scratch out of the repo', () => {
    const g = read('.gitignore').split(/\r?\n/);
    for (const line of ['node_modules/', 'marks.db*', '*.db', '*.db-journal', '*.token', 'backups/', '.env', '.superpowers/', '.DS_Store', 'Thumbs.db'])
      assert.ok(g.includes(line), 'missing ignore rule: ' + line);
  });

  await t.test('no personal mailbox address or home-directory path is left in the repository files', () => {
    // .git exists in a published clone (it records where the clone came from); docs/superpowers (design history) is not published
    const skip = new Set(['node_modules', 'backups', '.superpowers', 'superpowers', '.git']);
    const hits = [];
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(e.name) || /\.(png|db|db-journal|token)$/.test(e.name) || e.name === 'test-repo.js' || e.name === 'package-lock.json') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        const text = fs.readFileSync(full, 'utf8');
        for (const [name, re] of [['personal email', /[\w.+-]+@(?:gmail|outlook|hotmail|yahoo|icloud)\.com/i], ['home path', /C:[\\/]Users[\\/]/i], ['unix home path', /\/(?:home|Users)\/\w+\//]])
          if (re.test(text)) hits.push(`${path.relative(root, full)}: ${name}`);
      }
    };
    walk(root);
    assert.deepEqual(hits, []);
  });
});
