// Checks that need extra network requests beyond the page itself:
// broken links, CSS/JS minification, HTTP/2 support and Google Safe Browsing.
import tls from 'node:tls';
import { tryFetch, assertPublicHost } from './fetcher.js';

// Run async jobs with a concurrency limit.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const n = i++;
      out[n] = await fn(items[n]);
    }
  }));
  return out;
}

async function linkStatus(url) {
  let r = await tryFetch(url, { method: 'HEAD', timeout: 5000 });
  // Many servers reject HEAD; retry with a small GET.
  if (!r || r.status === 405 || r.status === 403 || r.status === 501) {
    r = await tryFetch(url, { timeout: 5000, maxBytes: 20_000 });
  }
  return r ? r.status : 0;
}

async function brokenLinks($, final, add) {
  const seen = new Set();
  $('a[href]').each((i, el) => {
    const h = $(el).attr('href');
    if (!h || h.startsWith('#') || /^(mailto|tel|sms|javascript):/i.test(h)) return;
    try {
      const u = new URL(h, final);
      u.hash = '';
      if (/^https?:$/.test(u.protocol)) seen.add(u.href);
    } catch { /* malformed hrefs are ignored */ }
  });
  const links = [...seen].slice(0, 40);
  const statuses = await pool(links, 15, linkStatus);
  // Social sites (Facebook, LinkedIn, Yelp...) often block bots with 403/429/999, so those
  // count as "couldn't verify", not broken.
  const broken = [], unverified = [];
  links.forEach((u, n) => {
    const s = statuses[n];
    if (s === 404 || s === 410 || s >= 500) broken.push(`${s}  ${u}`);
    else if (s >= 400 || s === 0) unverified.push(`${s || 'no response'}  ${u}`);
  });
  add({ id: 'broken-links', cat: 'content', weight: 1.5,
    status: broken.length === 0 ? 'pass' : broken.length <= 2 ? 'warn' : 'fail', title: 'Broken links',
    summary: `Tested ${links.length} link(s)${seen.size > links.length ? ` (first ${links.length} of ${seen.size})` : ''}: ${broken.length} broken${unverified.length ? `, ${unverified.length} couldn't be verified` : ''}.`,
    details: [...broken, ...unverified.map((u) => u + '  (check by hand)')].slice(0, 20),
    fix: broken.length ? 'Fix or remove links that lead to missing pages; they frustrate visitors and waste Google\'s crawl.' : '' });
}

function looksMinified(text) {
  if (text.length < 2000) return true; // too small to matter
  const lines = text.split('\n');
  const avgLine = text.length / lines.length;
  const ws = (text.match(/\s/g) || []).length / text.length;
  return avgLine > 200 || ws < 0.12;
}

async function minification($, final, add) {
  const assets = [
    ...$('link[rel="stylesheet" i][href]').map((i, el) => ({ type: 'CSS', href: $(el).attr('href') })).get(),
    ...$('script[src]').map((i, el) => ({ type: 'JS', href: $(el).attr('src') })).get(),
  ].map((a) => { try { return { ...a, url: new URL(a.href, final).href }; } catch { return null; } })
    .filter(Boolean).slice(0, 12);
  if (!assets.length) {
    add({ id: 'minify', cat: 'speed', status: 'pass', title: 'CSS & JS minification', summary: 'No external CSS or JS files to check.' });
    return;
  }
  const results = await pool(assets, 6, async (a) => {
    const r = await tryFetch(a.url, { timeout: 8000, maxBytes: 1_500_000 });
    if (!r || r.status !== 200) return null;
    return { ...a, kb: r.bytes / 1024, min: looksMinified(r.body), gz: !!r.headers.get('content-encoding') };
  });
  const ok = results.filter(Boolean);
  const notMin = ok.filter((a) => !a.min);
  const notGz = ok.filter((a) => !a.gz && a.kb > 5);
  const totalKb = ok.reduce((s, a) => s + a.kb, 0);
  add({ id: 'minify', cat: 'speed', weight: 1,
    status: notMin.length === 0 && notGz.length === 0 ? 'pass' : notMin.length > 2 ? 'fail' : 'warn',
    title: 'CSS & JS minification',
    summary: `Checked ${ok.length} file(s), ${totalKb.toFixed(0)} KB total: ${notMin.length} not minified, ${notGz.length} not compressed.`,
    details: [
      ...notMin.map((a) => `Not minified (${a.type}, ${a.kb.toFixed(0)} KB): ${a.url}`),
      ...notGz.map((a) => `Not compressed (${a.type}, ${a.kb.toFixed(0)} KB): ${a.url}`),
    ].slice(0, 15),
    fix: notMin.length || notGz.length ? 'Minify CSS/JS (most caching plugins do this in one click) and serve them with gzip/Brotli.' : '' });
}

function alpn(host, port = 443) {
  return new Promise((resolve) => {
    // Only the negotiated protocol is read; no data is exchanged, so the
    // certificate isn't validated here (the HTTPS check covers that).
    const sock = tls.connect({ host, port, servername: host, ALPNProtocols: ['h2', 'http/1.1'], rejectUnauthorized: false });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(6000, () => done(null));
    sock.once('secureConnect', () => done(sock.alpnProtocol || 'http/1.1'));
    sock.once('error', () => done(null));
  });
}

async function http2(final, page, add) {
  if (final.protocol !== 'https:') {
    add({ id: 'http2', cat: 'speed', weight: 1, status: 'fail', title: 'HTTP/2', summary: 'HTTP/2 needs HTTPS, which this site doesn\'t use.',
      fix: 'Move the site to HTTPS; modern hosts then turn on HTTP/2 automatically.' });
    return;
  }
  await assertPublicHost(final.hostname);
  const proto = await alpn(final.hostname, final.port || 443);
  const h3 = /h3/.test(page.headers.get('alt-svc') || '');
  add({ id: 'http2', cat: 'speed', weight: 1,
    status: proto === 'h2' ? 'pass' : proto ? 'warn' : 'info', title: 'HTTP/2',
    summary: proto === 'h2' ? `Server supports HTTP/2${h3 ? ' and advertises HTTP/3' : ''}.` : proto ? 'Server only speaks HTTP/1.1.' : 'Could not determine the protocol.',
    fix: proto && proto !== 'h2' ? 'HTTP/2 loads many files in parallel. Ask the host to enable it, or put the site behind a CDN like Cloudflare (free).' : '' });
}

async function safeBrowsing(final, add) {
  const key = process.env.SAFE_BROWSING_KEY || process.env.PSI_API_KEY;
  if (!key) {
    add({ id: 'safe-browsing', cat: 'security', status: 'info', title: 'Google Safe Browsing',
      summary: 'Not checked: add a free Google API key in Vercel (see README) to check for malware/phishing flags.' });
    return;
  }
  try {
    const r = await fetch('https://safebrowsing.googleapis.com/v4/threatMatches:find?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        client: { clientId: 'site-health-check', clientVersion: '1.0' },
        threatInfo: {
          threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: [{ url: final.href }, { url: final.origin + '/' }],
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || r.status);
    const hits = data.matches || [];
    add({ id: 'safe-browsing', cat: 'security', weight: 3, status: hits.length ? 'fail' : 'pass', title: 'Google Safe Browsing',
      summary: hits.length ? `Google flags this site: ${[...new Set(hits.map((h) => h.threatType))].join(', ')}.` : 'Not on Google\'s malware/phishing lists.',
      fix: hits.length ? 'Urgent: the site is likely hacked. Clean it, then request a review in Google Search Console > Security issues.' : '' });
  } catch (e) {
    add({ id: 'safe-browsing', cat: 'security', status: 'info', title: 'Google Safe Browsing',
      summary: `Check failed: ${e.message}. If using PSI_API_KEY, enable the Safe Browsing API for that key.` });
  }
}

export async function runExtraChecks($, final, page, add) {
  await Promise.all([
    brokenLinks($, final, add),
    minification($, final, add),
    http2(final, page, add).catch(() => add({ id: 'http2', cat: 'speed', status: 'info', title: 'HTTP/2', summary: 'Could not test.' })),
    safeBrowsing(final, add),
  ]);
}
