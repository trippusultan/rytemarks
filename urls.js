// urls.js: one canonical form per page, so the same article saved from a newsletter and from a tweet is one bookmark.
// Conservative on purpose: only known tracking params, only empty-meaning fragments, only trailing slashes.
const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|ref_src)$/i;

function normalizeUrl(href) {
  const u = new URL(href); // also lowercases the host and drops default ports
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  if (!/^#[/!]/.test(u.hash)) u.hash = ''; // "#/route" and "#!/x" are real pages in single-page apps; "#top" is not
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.href;
}

module.exports = { normalizeUrl };
