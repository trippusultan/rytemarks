// urls.js: one canonical form per page, so the same article saved from a newsletter and from a tweet is one bookmark.
// Conservative on purpose: only known tracking params, a bare "#", and trailing slashes. A #fragment is part of the page
// (Mega and Excalidraw keep their key there, Gmail its thread id, docs their heading), so it is never dropped.
const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|ref_src)$/i;

function normalizeUrl(href) {
  const u = new URL(href); // also lowercases the host and drops default ports
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  if (!u.hash) u.hash = ''; // an empty fragment reads as '' but leaves a trailing "#" in href; setting it clears that
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.href;
}

module.exports = { normalizeUrl };
