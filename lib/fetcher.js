// Safe HTTP fetching: follows redirects by hand so we can record the chain
// and refuse to talk to private/internal addresses (SSRF protection).
import dns from 'node:dns/promises';
import net from 'node:net';

const UA =
  'Mozilla/5.0 (compatible; FreeSEOChecker/1.0; +https://vercel.com) Chrome/124 Safari/537.36';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

export async function assertPublicHost(hostname) {
  if (process.env.ALLOW_PRIVATE === '1') return; // local testing only
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('That address is not allowed.');
  }
  const addrs = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('That address resolves to a private network and is not allowed.');
  }
}

export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Please enter a URL.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https URLs are supported.');
  return u;
}

/**
 * Fetch a URL, following up to 10 redirects manually.
 * Returns { url, status, headers, body, chain, timeMs, bytes } — body is text
 * (capped at maxBytes) unless opts.method === 'HEAD'.
 */
export async function safeFetch(url, opts = {}) {
  const { method = 'GET', timeout = 12000, maxBytes = 3_000_000, follow = true } = opts;
  const chain = [];
  let current = new URL(url);
  const start = Date.now();
  for (let hop = 0; hop < 10; hop++) {
    await assertPublicHost(current.hostname);
    const res = await fetch(current, {
      method,
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      signal: AbortSignal.timeout(timeout),
    });
    const loc = res.headers.get('location');
    if (follow && res.status >= 300 && res.status < 400 && loc) {
      chain.push({ url: current.href, status: res.status });
      res.body?.cancel?.();
      current = new URL(loc, current);
      continue;
    }
    const firstByteMs = Date.now() - start;
    let body = '';
    let bytes = 0;
    if (method !== 'HEAD' && res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes <= maxBytes) chunks.push(value);
        else { reader.cancel(); break; }
      }
      body = Buffer.concat(chunks).toString('utf8');
    }
    return {
      url: current.href,
      status: res.status,
      headers: res.headers,
      body,
      bytes,
      chain,
      firstByteMs,
      timeMs: Date.now() - start,
    };
  }
  throw new Error('Too many redirects.');
}

/** Like safeFetch but never throws; returns null on failure. */
export async function tryFetch(url, opts) {
  try {
    return await safeFetch(url, opts);
  } catch {
    return null;
  }
}
