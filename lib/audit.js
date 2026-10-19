// The on-page audit. Fetches the page plus a few side resources
// (robots.txt, sitemap, a missing page, the http:// and www variants, DNS)
// and runs every check against them.
import * as cheerio from 'cheerio';
import dns from 'node:dns/promises';
import { safeFetch, tryFetch, normalizeUrl } from './fetcher.js';
import { runExtraChecks } from './extra-checks.js';

const CATEGORIES = {
  seo: 'Search basics',
  content: 'Content',
  local: 'Local business',
  speed: 'Speed',
  security: 'Security',
  mobile: 'Mobile',
  advanced: 'Advanced',
};

// Status points used for the score; "info" checks don't count.
const POINTS = { pass: 1, warn: 0.5, fail: 0 };

const STOPWORDS = new Set(
  ('a an and are as at be but by for from has have i in is it its of on or our that the this to was we were ' +
    'will with you your us can all more not do if so get they them their about out up any what when how who ' +
    'which also than then there here been into over just like one new may our more call contact home page ' +
    'us me my no yes am pm').split(' ')
);

function check(list, c) {
  list.push({ weight: 1, details: [], ...c });
}

function textOf($, el) {
  return $(el).text().replace(/\s+/g, ' ').trim();
}

export async function runAudit(rawUrl) {
  const target = normalizeUrl(rawUrl);
  const page = await safeFetch(target.href);
  if (!page.headers.get('content-type')?.includes('html')) {
    throw new Error(`That URL returned ${page.headers.get('content-type') || 'no content type'}, not an HTML page.`);
  }
  const final = new URL(page.url);
  const origin = final.origin;
  const $ = cheerio.load(page.body);
  const checks = [];

  // Side requests run in parallel.
  const bareHost = final.hostname.replace(/^www\./, '');
  const altHost = final.hostname.startsWith('www.') ? bareHost : 'www.' + bareHost;
  const [robots, notFound, httpVariant, altVariant, spf, dmarc] = await Promise.all([
    tryFetch(origin + '/robots.txt', { timeout: 8000, maxBytes: 200_000 }),
    tryFetch(origin + '/this-page-should-not-exist-' + Date.now().toString(36), { timeout: 8000, maxBytes: 300_000 }),
    tryFetch(`http://${final.host}${final.pathname}`, { timeout: 8000, follow: true, maxBytes: 50_000 }),
    tryFetch(`${final.protocol}//${altHost}/`, { timeout: 8000, follow: true, maxBytes: 50_000 }),
    dns.resolveTxt(bareHost).catch(() => null),
    dns.resolveTxt('_dmarc.' + bareHost).catch(() => null),
  ]);

  // Sitemap: from robots.txt, else /sitemap.xml, else /sitemap_index.xml
  const robotsOk = robots && robots.status === 200 && !/<html/i.test(robots.body.slice(0, 500));
  const sitemapUrls = robotsOk
    ? [...robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1])
    : [];
  let sitemap = null;
  for (const u of [...sitemapUrls, origin + '/sitemap.xml', origin + '/sitemap_index.xml', origin + '/wp-sitemap.xml']) {
    const r = await tryFetch(u, { timeout: 8000, maxBytes: 2_000_000 });
    if (r && r.status === 200 && /<(urlset|sitemapindex)/i.test(r.body)) {
      sitemap = { url: r.url, count: (r.body.match(/<loc>/gi) || []).length };
      break;
    }
  }

  // ---------- Search basics ----------
  const title = textOf($, $('head title').first());
  if (!title) {
    check(checks, { id: 'title', cat: 'seo', weight: 3, status: 'fail', title: 'Page title',
      summary: 'The page has no <title> tag.',
      fix: 'Add a unique title of 30–60 characters that names the main service and the town, e.g. "Roof Repair in Hamilton, NJ | Company Name".' });
  } else {
    const len = title.length;
    const ok = len >= 30 && len <= 60;
    check(checks, { id: 'title', cat: 'seo', weight: 3, status: ok ? 'pass' : len < 10 || len > 75 ? 'fail' : 'warn',
      title: 'Page title',
      summary: `"${title}" (${len} characters). ${ok ? 'Good length.' : len < 30 ? 'A bit short; there is room for more keywords.' : 'Google will likely cut this off around 60 characters.'}`,
      fix: ok ? '' : 'Aim for 30–60 characters: main service + location + brand.' });
  }

  const desc = ($('meta[name="description" i]').attr('content') || '').trim();
  if (!desc) {
    check(checks, { id: 'description', cat: 'seo', weight: 3, status: 'fail', title: 'Meta description',
      summary: 'No meta description. Google will invent one from page text.',
      fix: 'Add <meta name="description"> of 120–160 characters with the service, area and a reason to click (free estimate, 24/7, etc.).' });
  } else {
    const len = desc.length;
    const ok = len >= 70 && len <= 160;
    check(checks, { id: 'description', cat: 'seo', weight: 3, status: ok ? 'pass' : 'warn', title: 'Meta description',
      summary: `"${desc}" (${len} characters). ${ok ? 'Good length.' : len < 70 ? 'Short; add a benefit or call to action.' : 'Likely to be truncated in results.'}`,
      fix: ok ? '' : 'Aim for 120–160 characters.' });
  }

  check(checks, { id: 'serp', cat: 'seo', status: 'info', title: 'Google result preview',
    summary: 'Roughly how this page could appear in search results.',
    preview: { title: title || final.hostname, url: final.href, description: desc || textOf($, 'body').slice(0, 155) } });

  const h1s = $('h1').map((i, el) => textOf($, el)).get().filter(Boolean);
  const headingCounts = Object.fromEntries(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((h) => [h, $(h).length]));
  check(checks, { id: 'h1', cat: 'seo', weight: 2,
    status: h1s.length === 1 ? 'pass' : h1s.length === 0 ? 'fail' : 'warn', title: 'Main heading (H1)',
    summary: h1s.length === 0 ? 'No H1 heading found.' : h1s.length === 1 ? `One H1: "${h1s[0]}"` : `${h1s.length} H1 headings found; one is clearer.`,
    details: h1s.slice(0, 10),
    fix: h1s.length === 1 ? '' : 'Use exactly one H1 that says what the business does and where.' });

  const subheads = headingCounts.h2 + headingCounts.h3;
  check(checks, { id: 'headings', cat: 'seo', status: subheads >= 2 ? 'pass' : 'warn', title: 'Heading structure',
    summary: Object.entries(headingCounts).map(([k, v]) => `${k.toUpperCase()}: ${v}`).join(' · '),
    details: $('h2').map((i, el) => 'H2: ' + textOf($, el)).get().slice(0, 15),
    fix: subheads >= 2 ? '' : 'Break the page into sections with H2/H3 headings that describe each service.' });

  const imgs = $('img');
  const noAlt = imgs.filter((i, el) => !($(el).attr('alt') || '').trim() && $(el).attr('role') !== 'presentation');
  check(checks, { id: 'alt', cat: 'seo', weight: 2,
    status: imgs.length === 0 || noAlt.length === 0 ? 'pass' : noAlt.length / imgs.length > 0.3 ? 'fail' : 'warn',
    title: 'Image alt text',
    summary: imgs.length === 0 ? 'No <img> tags on the page.' : `${imgs.length - noAlt.length} of ${imgs.length} images have alt text.`,
    details: noAlt.map((i, el) => $(el).attr('src') || $(el).attr('data-src') || '(no src)').get().slice(0, 15),
    fix: noAlt.length ? 'Describe each image in its alt attribute, e.g. alt="New asphalt shingle roof in Trenton NJ".' : '' });

  const canonical = $('link[rel="canonical" i]').attr('href');
  check(checks, { id: 'canonical', cat: 'seo', status: canonical ? 'pass' : 'warn', title: 'Canonical tag',
    summary: canonical ? `Canonical points to ${canonical}` : 'No canonical tag.',
    fix: canonical ? '' : 'Add <link rel="canonical" href="(this page\'s preferred URL)"> to avoid duplicate-content confusion.' });

  const robotsMeta = ($('meta[name="robots" i]').attr('content') || '').toLowerCase();
  const xRobots = (page.headers.get('x-robots-tag') || '').toLowerCase();
  const noindex = robotsMeta.includes('noindex') || xRobots.includes('noindex');
  check(checks, { id: 'noindex', cat: 'seo', weight: 3, status: noindex ? 'fail' : 'pass', title: 'Indexable by Google',
    summary: noindex ? 'The page tells search engines NOT to index it (noindex).' : 'No noindex directive; search engines may index this page.',
    fix: noindex ? 'Remove "noindex" from the robots meta tag / X-Robots-Tag header unless this is intentional.' : '' });

  let robotsBlocked = false;
  if (robotsOk) {
    // Very small parser: look at the "User-agent: *" group for "Disallow: /"
    const groups = robots.body.split(/\n(?=\s*user-agent:)/i);
    for (const g of groups) {
      if (/user-agent:\s*\*/i.test(g) && /^\s*disallow:\s*\/\s*$/im.test(g)) robotsBlocked = true;
    }
  }
  check(checks, { id: 'robots', cat: 'seo', weight: 2,
    status: !robotsOk ? 'warn' : robotsBlocked ? 'fail' : 'pass', title: 'robots.txt',
    summary: !robotsOk ? 'No robots.txt file found.' : robotsBlocked ? 'robots.txt blocks all crawlers from the whole site!' : 'robots.txt found and allows crawling.',
    details: robotsOk ? robots.body.split('\n').slice(0, 20) : [],
    fix: !robotsOk ? 'Add a /robots.txt that allows crawling and lists the sitemap.' : robotsBlocked ? 'Remove "Disallow: /" for User-agent: *.' : '' });

  check(checks, { id: 'sitemap', cat: 'seo', weight: 2, status: sitemap ? 'pass' : 'warn', title: 'XML sitemap',
    summary: sitemap ? `Found ${sitemap.url} with ${sitemap.count} URLs.` : 'No XML sitemap found (checked robots.txt, /sitemap.xml, /sitemap_index.xml).',
    fix: sitemap ? '' : 'Create a sitemap.xml, reference it in robots.txt and submit it in Google Search Console.' });

  const og = {
    title: $('meta[property="og:title"]').attr('content'),
    description: $('meta[property="og:description"]').attr('content'),
    image: $('meta[property="og:image"]').attr('content'),
  };
  const ogCount = Object.values(og).filter(Boolean).length;
  const twitter = $('meta[name="twitter:card"]').attr('content');
  check(checks, { id: 'social-meta', cat: 'seo', status: ogCount === 3 ? 'pass' : ogCount ? 'warn' : 'fail',
    title: 'Social sharing tags',
    summary: `Open Graph: ${ogCount}/3 (title, description, image)${twitter ? ` · Twitter card: ${twitter}` : ' · no Twitter card'}.`,
    details: Object.entries(og).map(([k, v]) => `og:${k}: ${v || '(missing)'}`),
    fix: ogCount === 3 ? '' : 'Add og:title, og:description and og:image so links look good when shared on Facebook, texts, etc.' });

  const jsonLd = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const walk = (o) => {
        if (Array.isArray(o)) return o.forEach(walk);
        if (o && typeof o === 'object') {
          if (o['@type']) jsonLd.push([].concat(o['@type']).join(', '));
          if (o['@graph']) walk(o['@graph']);
        }
      };
      walk(data);
    } catch { jsonLd.push('(invalid JSON-LD block)'); }
  });
  const microdata = $('[itemtype]').length;
  check(checks, { id: 'schema', cat: 'seo', weight: 2, status: jsonLd.length || microdata ? 'pass' : 'warn',
    title: 'Structured data (schema.org)',
    summary: jsonLd.length ? `JSON-LD types: ${[...new Set(jsonLd)].join(', ')}` : microdata ? `${microdata} microdata items.` : 'No structured data found.',
    fix: jsonLd.length || microdata ? '' : 'Add LocalBusiness (or RoofingContractor, Plumber, etc.) JSON-LD with name, address, phone, hours and service area.' });

  const favicon = $('link[rel~="icon" i], link[rel="shortcut icon" i], link[rel="apple-touch-icon" i]').length;
  check(checks, { id: 'favicon', cat: 'seo', weight: 0.5, status: favicon ? 'pass' : 'warn', title: 'Favicon',
    summary: favicon ? 'Favicon declared.' : 'No favicon link tag found.',
    fix: favicon ? '' : 'Add a favicon; it shows next to the site in mobile search results.' });

  const lang = $('html').attr('lang');
  check(checks, { id: 'lang', cat: 'seo', weight: 0.5, status: lang ? 'pass' : 'warn', title: 'Language declared',
    summary: lang ? `<html lang="${lang}">` : 'The <html> tag has no lang attribute.',
    fix: lang ? '' : 'Add lang="en" to the <html> tag.' });

  const path = final.pathname + final.search;
  const urlOk = path.length < 100 && !/[A-Z_]|\?.*=.*&.*=/.test(path);
  check(checks, { id: 'url', cat: 'seo', weight: 0.5, status: urlOk ? 'pass' : 'warn', title: 'Friendly URL',
    summary: urlOk ? `${final.href} is short and readable.` : `${final.href} could be cleaner.`,
    fix: urlOk ? '' : 'Use short, lowercase, hyphenated URLs without many query parameters.' });

  const notFoundOk = notFound && notFound.status === 404;
  check(checks, { id: '404', cat: 'seo', status: notFoundOk ? 'pass' : 'warn', title: 'Custom 404 page',
    summary: !notFound ? 'Could not test a missing page.' : notFoundOk ? 'Missing pages correctly return a 404 status.' : `A made-up URL returned status ${notFound.status} instead of 404.`,
    fix: notFoundOk ? '' : 'Make missing pages return HTTP 404 (with a helpful page linking back home), not 200 or a redirect.' });

  // ---------- Content ----------
  const $body = cheerio.load(page.body);
  $body('script, style, noscript, svg, template').remove();
  const bodyText = textOf($body, $body('body'));
  const words = bodyText.toLowerCase().match(/[a-z][a-z'-]{1,}/g) || [];
  check(checks, { id: 'wordcount', cat: 'content', weight: 2,
    status: words.length >= 500 ? 'pass' : words.length >= 250 ? 'warn' : 'fail', title: 'Amount of text',
    summary: `${words.length} words of visible text.`,
    fix: words.length >= 500 ? '' : 'Thin pages rank poorly. Add useful text: services, areas served, process, FAQs, reviews.' });

  const freq = {};
  for (const w of words) if (w.length > 2 && !STOPWORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
  const bigrams = {};
  for (let i = 0; i < words.length - 1; i++) {
    const [a, b] = [words[i], words[i + 1]];
    if (a.length > 2 && b.length > 2 && !STOPWORDS.has(a) && !STOPWORDS.has(b)) bigrams[a + ' ' + b] = (bigrams[a + ' ' + b] || 0) + 1;
  }
  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topPhrases = Object.entries(bigrams).filter((e) => e[1] > 1).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const titleDesc = (title + ' ' + desc).toLowerCase();
  const inMeta = topWords.slice(0, 5).filter(([w]) => titleDesc.includes(w));
  check(checks, { id: 'keywords', cat: 'content', weight: 2,
    status: inMeta.length >= 2 ? 'pass' : inMeta.length === 1 ? 'warn' : 'fail', title: 'Keyword consistency',
    summary: `Most used words: ${topWords.slice(0, 5).map(([w, n]) => `${w} (${n})`).join(', ') || 'none'}. ${inMeta.length} of the top 5 appear in the title or description.`,
    details: [
      'Top words: ' + topWords.map(([w, n]) => `${w} ${n}`).join(', '),
      'Top phrases: ' + (topPhrases.map(([w, n]) => `"${w}" ${n}`).join(', ') || 'none'),
    ],
    fix: inMeta.length >= 2 ? '' : 'Make sure the title and description use the same main words the page is about (service + town).' });

  const links = $('a[href]').map((i, el) => $(el).attr('href')).get();
  let internal = 0, external = 0, nofollow = 0, empty = 0;
  for (const h of links) {
    if (!h || h === '#' || h.startsWith('javascript:')) { empty++; continue; }
    if (/^(mailto|tel|sms):/i.test(h)) continue;
    try { new URL(h, final).hostname.replace(/^www\./, '') === bareHost ? internal++ : external++; } catch { empty++; }
  }
  $('a[rel~="nofollow"]').each(() => { nofollow++; });
  check(checks, { id: 'links', cat: 'content', status: internal >= 3 ? 'pass' : 'warn', title: 'Links',
    summary: `${internal} internal, ${external} external, ${nofollow} nofollow, ${empty} empty/placeholder links.`,
    fix: internal >= 3 ? '' : 'Link to your service, about and contact pages so Google can find and rank them.' });

  // Plain-text e-mail addresses (spam harvesting)
  const emails = [...new Set(bodyText.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [])];
  check(checks, { id: 'emails', cat: 'content', weight: 0.5, status: emails.length ? 'warn' : 'pass', title: 'Exposed email addresses',
    summary: emails.length ? `Plain-text email found: ${emails.slice(0, 3).join(', ')}` : 'No plain-text email addresses in the page text.',
    fix: emails.length ? 'Plain emails attract spam bots; a contact form is safer.' : '' });

  // ---------- Local business ----------
  const tel = $('a[href^="tel:" i]').length;
  const phoneText = /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/.test(bodyText);
  check(checks, { id: 'phone', cat: 'local', weight: 2, status: tel ? 'pass' : phoneText ? 'warn' : 'fail', title: 'Tap-to-call phone',
    summary: tel ? `${tel} clickable phone link(s).` : phoneText ? 'A phone number is shown but is not a tap-to-call link.' : 'No phone number found.',
    fix: tel ? '' : 'Wrap the phone number in <a href="tel:+1..."> so mobile visitors can call in one tap.' });

  const forms = $('form').length;
  check(checks, { id: 'form', cat: 'local', weight: 1.5, status: forms ? 'pass' : 'warn', title: 'Contact / quote form',
    summary: forms ? `${forms} form(s) on the page.` : 'No form on this page.',
    fix: forms ? '' : 'Add a short "Get a free estimate" form; many visitors won\'t call.' });

  const localSchema = jsonLd.some((t) => /LocalBusiness|Contractor|Roofing|Plumber|Electrician|HVAC|HomeAndConstruction|Dentist|Restaurant|Store|Service|Organization/i.test(t));
  check(checks, { id: 'local-schema', cat: 'local', weight: 1.5, status: localSchema ? 'pass' : 'warn', title: 'Business schema',
    summary: localSchema ? 'LocalBusiness/Organization structured data found.' : 'No LocalBusiness structured data.',
    fix: localSchema ? '' : 'Add LocalBusiness JSON-LD so Google can show hours, phone and address in results.' });

  const address = /\b\d{2,5}\s+\w+(\s\w+)*\s(st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|way|pike|hwy|highway|ct|court)\b/i.test(bodyText) ||
    /\b[A-Z]{2}\s\d{5}\b/.test(textOf($body, $body('body')));
  const map = $('iframe[src*="google.com/maps"], iframe[src*="maps.google"], a[href*="maps.google"], a[href*="goo.gl/maps"], a[href*="maps.app.goo.gl"]').length;
  check(checks, { id: 'nap', cat: 'local', status: address ? 'pass' : 'warn', title: 'Address / service area',
    summary: `${address ? 'A street address or ZIP is visible.' : 'No street address or ZIP found in the text.'} ${map ? 'Map link/embed present.' : 'No Google Maps link.'}`,
    fix: address ? '' : 'Show the business address (or towns served) in the footer; it helps local rankings.' });

  const reviews = /review|testimonial|★|stars?\b|rated/i.test(bodyText);
  check(checks, { id: 'reviews', cat: 'local', weight: 0.5, status: reviews ? 'pass' : 'warn', title: 'Reviews / social proof',
    summary: reviews ? 'Reviews or testimonials are mentioned.' : 'No reviews or testimonials found.',
    fix: reviews ? '' : 'Show a few real customer reviews (with names/towns) near the top of the page.' });

  // ---------- Speed (from the HTML itself; Lighthouse lab data comes from /api/speed) ----------
  const kb = page.bytes / 1024;
  check(checks, { id: 'html-size', cat: 'speed', status: kb < 100 ? 'pass' : kb < 300 ? 'warn' : 'fail', title: 'HTML size',
    summary: `${kb.toFixed(1)} KB of HTML.`,
    fix: kb < 100 ? '' : 'Large HTML slows the first paint; remove inline bloat, page-builder markup or embedded data.' });

  const enc = page.headers.get('content-encoding');
  check(checks, { id: 'compression', cat: 'speed', weight: 1.5, status: enc ? 'pass' : 'fail', title: 'Compression',
    summary: enc ? `HTML is served with ${enc} compression.` : 'HTML is not compressed.',
    fix: enc ? '' : 'Turn on gzip or Brotli compression on the server/host.' });

  check(checks, { id: 'response-time', cat: 'speed', weight: 1.5,
    status: page.firstByteMs < 800 ? 'pass' : page.firstByteMs < 1800 ? 'warn' : 'fail', title: 'Server response time',
    summary: `First response in ${page.firstByteMs} ms, full HTML in ${page.timeMs} ms (measured from the checker's server).`,
    fix: page.firstByteMs < 800 ? '' : 'Slow server. Consider caching, a faster host or a CDN.' });

  const redirects = page.chain.length;
  check(checks, { id: 'redirects', cat: 'speed', weight: 0.5, status: redirects <= 1 ? 'pass' : 'warn', title: 'Redirect chain',
    summary: redirects ? `${redirects} redirect(s): ${[...page.chain.map((c) => `${c.url} (${c.status})`), final.href].join(' → ')}` : 'No redirects.',
    fix: redirects <= 1 ? '' : 'Link directly to the final URL; each redirect adds a round trip.' });

  const scripts = $('script[src]').length;
  const styles = $('link[rel="stylesheet" i]').length;
  const blocking = $('head script[src]').filter((i, el) => !$(el).is('[async],[defer],[type="module"]')).length;
  check(checks, { id: 'requests', cat: 'speed', status: scripts + styles <= 20 ? 'pass' : scripts + styles <= 40 ? 'warn' : 'fail',
    title: 'Page resources',
    summary: `${scripts} external scripts, ${styles} stylesheets, ${imgs.length} images.`,
    fix: scripts + styles <= 20 ? '' : 'Too many files; remove unused plugins and combine CSS/JS.' });

  check(checks, { id: 'render-blocking', cat: 'speed', status: blocking === 0 ? 'pass' : blocking <= 2 ? 'warn' : 'fail',
    title: 'Render-blocking scripts',
    summary: blocking ? `${blocking} script(s) in <head> without async/defer.` : 'No render-blocking scripts in <head>.',
    details: $('head script[src]').filter((i, el) => !$(el).is('[async],[defer],[type="module"]')).map((i, el) => $(el).attr('src')).get().slice(0, 10),
    fix: blocking ? 'Add defer to scripts in <head> (or move them to the end of <body>).' : '' });

  const imgSrcs = imgs.map((i, el) => $(el).attr('src') || $(el).attr('data-src') || '').get();
  const modern = imgSrcs.filter((s) => /\.(webp|avif|svg)(\?|$)/i.test(s)).length + $('picture source[type="image/webp"], picture source[type="image/avif"]').length;
  const lazy = imgs.filter((i, el) => $(el).attr('loading') === 'lazy' || $(el).attr('data-src')).length;
  check(checks, { id: 'images', cat: 'speed', status: imgs.length === 0 || modern / imgs.length >= 0.5 ? 'pass' : 'warn', title: 'Image formats & lazy loading',
    summary: imgs.length ? `${modern} of ${imgs.length} images use WebP/AVIF/SVG; ${lazy} are lazy-loaded.` : 'No images.',
    fix: imgs.length && modern / imgs.length < 0.5 ? 'Convert photos to WebP/AVIF and add loading="lazy" to images below the fold.' : '' });

  const domNodes = $('*').length;
  check(checks, { id: 'dom', cat: 'speed', weight: 0.5, status: domNodes < 1500 ? 'pass' : domNodes < 3000 ? 'warn' : 'fail', title: 'DOM size',
    summary: `${domNodes} HTML elements.`,
    fix: domNodes < 1500 ? '' : 'A very large DOM slows rendering; simplify page-builder nesting.' });

  const cache = page.headers.get('cache-control');
  check(checks, { id: 'cdn', cat: 'speed', status: 'info', title: 'Hosting / CDN',
    summary: [
      page.headers.get('server') && `Server: ${page.headers.get('server')}`,
      page.headers.get('cf-ray') && 'Cloudflare CDN',
      page.headers.get('x-vercel-id') && 'Vercel',
      page.headers.get('x-amz-cf-id') && 'Amazon CloudFront',
      page.headers.get('x-served-by') && `Served by ${page.headers.get('x-served-by')}`,
      cache && `Cache-Control: ${cache}`,
    ].filter(Boolean).join(' · ') || 'No hosting details exposed.' });

  // ---------- Security ----------
  const https = final.protocol === 'https:';
  check(checks, { id: 'https', cat: 'security', weight: 3, status: https ? 'pass' : 'fail', title: 'HTTPS',
    summary: https ? 'The page is served over HTTPS.' : 'The page is NOT served over HTTPS; browsers show "Not secure".',
    fix: https ? '' : 'Install a free SSL certificate (Let\'s Encrypt / host panel) and redirect all http traffic to https.' });

  const httpRedirects = httpVariant && httpVariant.url.startsWith('https://');
  check(checks, { id: 'http-redirect', cat: 'security', weight: 1.5, status: httpRedirects ? 'pass' : 'fail', title: 'HTTP → HTTPS redirect',
    summary: !httpVariant ? 'The http:// version did not respond.' : httpRedirects ? 'http:// visitors are sent to https://.' : 'http:// does not redirect to https://.',
    fix: httpRedirects ? '' : 'Redirect every http:// request to https:// with a 301.' });

  const altSame = altVariant && new URL(altVariant.url).hostname === final.hostname;
  check(checks, { id: 'www', cat: 'security', status: altSame ? 'pass' : 'warn', title: 'www / non-www',
    summary: !altVariant ? `${altHost} did not respond.` : altSame ? `${altHost} redirects to ${final.hostname}.` : `${altHost} and ${final.hostname} both serve pages without redirecting to one version.`,
    fix: altSame ? '' : `Pick one version and 301-redirect ${altHost} to it (and make sure ${altHost} works at all).` });

  const mixed = https
    ? $('img[src^="http:"], script[src^="http:"], link[href^="http:"][rel="stylesheet" i], iframe[src^="http:"], source[src^="http:"]').map((i, el) => $(el).attr('src') || $(el).attr('href')).get()
    : [];
  check(checks, { id: 'mixed', cat: 'security', weight: 1.5, status: mixed.length ? 'fail' : 'pass', title: 'Mixed content',
    summary: mixed.length ? `${mixed.length} resource(s) loaded over insecure http://.` : 'No insecure resources on the page.',
    details: mixed.slice(0, 10), fix: mixed.length ? 'Change those URLs to https://.' : '' });

  const hsts = page.headers.get('strict-transport-security');
  const secHeaders = ['x-content-type-options', 'x-frame-options', 'content-security-policy', 'referrer-policy'].filter((h) => page.headers.get(h));
  check(checks, { id: 'headers', cat: 'security', status: hsts && secHeaders.length >= 2 ? 'pass' : hsts || secHeaders.length ? 'warn' : 'fail',
    title: 'Security headers',
    summary: `HSTS: ${hsts ? 'yes' : 'no'} · Other: ${secHeaders.join(', ') || 'none'}.`,
    fix: hsts && secHeaders.length >= 2 ? '' : 'Add Strict-Transport-Security, X-Content-Type-Options: nosniff and X-Frame-Options/CSP at the host or CDN.' });

  const unsafeBlank = $('a[target="_blank"]').filter((i, el) => !/noopener|noreferrer/.test($(el).attr('rel') || '')).length;
  check(checks, { id: 'blank', cat: 'security', weight: 0.5, status: unsafeBlank ? 'warn' : 'pass', title: 'Safe external links',
    summary: unsafeBlank ? `${unsafeBlank} target="_blank" link(s) without rel="noopener".` : 'All new-tab links are safe.',
    fix: unsafeBlank ? 'Add rel="noopener" to links that open in a new tab.' : '' });

  const server = page.headers.get('server') || '';
  const powered = page.headers.get('x-powered-by') || '';
  const leaks = /\d/.test(server) || powered;
  check(checks, { id: 'signature', cat: 'security', weight: 0.5, status: leaks ? 'warn' : 'pass', title: 'Server signature',
    summary: leaks ? `Server reveals software versions: ${[server, powered].filter(Boolean).join(' / ')}` : 'No software versions exposed in headers.',
    fix: leaks ? 'Hide version numbers in Server / X-Powered-By headers.' : '' });

  const spfRec = spf?.map((r) => r.join('')).find((r) => r.startsWith('v=spf1'));
  const dmarcRec = dmarc?.map((r) => r.join('')).find((r) => r.startsWith('v=DMARC1'));
  check(checks, { id: 'email-auth', cat: 'security', status: spfRec && dmarcRec ? 'pass' : spfRec || dmarcRec ? 'warn' : 'fail',
    title: 'Email authentication (SPF / DMARC)',
    summary: `SPF: ${spfRec || 'missing'} · DMARC: ${dmarcRec || 'missing'}`,
    fix: spfRec && dmarcRec ? '' : 'Add SPF and DMARC DNS records so the business\'s emails (estimates, invoices) don\'t land in spam.' });

  // ---------- Mobile ----------
  const viewport = $('meta[name="viewport" i]').attr('content') || '';
  check(checks, { id: 'viewport', cat: 'mobile', weight: 3, status: /width=device-width/.test(viewport) ? 'pass' : 'fail', title: 'Mobile viewport',
    summary: viewport ? `viewport: ${viewport}` : 'No viewport meta tag; the page will look zoomed-out on phones.',
    fix: /width=device-width/.test(viewport) ? '' : 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' });

  const inlineCss = $('style').text();
  const media = /@media/i.test(inlineCss) || $('link[rel="stylesheet" i][media]').length > 0 || styles > 0;
  check(checks, { id: 'responsive', cat: 'mobile', status: /@media/i.test(inlineCss) ? 'pass' : media ? 'info' : 'warn', weight: 1,
    title: 'Responsive CSS',
    summary: /@media/i.test(inlineCss) ? 'Media queries found in the page CSS.' : styles ? 'Uses external stylesheets (see the mobile screenshot to confirm the layout).' : 'No media queries found.',
    fix: media ? '' : 'Use media queries so the layout adapts to small screens.' });

  if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(viewport)) {
    check(checks, { id: 'zoom', cat: 'mobile', weight: 0.5, status: 'warn', title: 'Pinch zoom',
      summary: 'The viewport disables zooming, which hurts accessibility.',
      fix: 'Remove user-scalable=no / maximum-scale=1.' });
  }

  // ---------- Advanced ----------
  const analytics = [
    /googletagmanager\.com\/gtag|google-analytics\.com|gtag\(/.test(page.body) && 'Google Analytics',
    /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/.test(page.body) && 'Google Tag Manager',
    /connect\.facebook\.net|fbq\(/.test(page.body) && 'Meta Pixel',
    /plausible\.io|static\.cloudflareinsights|clarity\.ms|hotjar/.test(page.body) && 'Other analytics',
  ].filter(Boolean);
  check(checks, { id: 'analytics', cat: 'advanced', status: analytics.length ? 'pass' : 'warn', title: 'Analytics',
    summary: analytics.length ? `Detected: ${analytics.join(', ')}` : 'No analytics found; the owner can\'t see how many visitors become leads.',
    fix: analytics.length ? '' : 'Install Google Analytics 4 (free) and set up a conversion for calls/form submissions.' });

  const doctype = /^\s*<!doctype html>/i.test(page.body);
  const charset = $('meta[charset]').length || /charset=utf-8/i.test(page.headers.get('content-type') || '');
  check(checks, { id: 'doctype', cat: 'advanced', weight: 0.5, status: doctype && charset ? 'pass' : 'warn', title: 'Doctype & charset',
    summary: `${doctype ? 'HTML5 doctype' : 'Missing/old doctype'} · ${charset ? 'charset declared' : 'no charset declared'}.`,
    fix: doctype && charset ? '' : 'Start with <!DOCTYPE html> and <meta charset="utf-8">.' });

  const deprecated = ['font', 'center', 'marquee', 'frame', 'frameset', 'big', 'strike', 'tt', 'blink'].filter((t) => $(t).length);
  check(checks, { id: 'deprecated', cat: 'advanced', weight: 0.5, status: deprecated.length ? 'warn' : 'pass', title: 'Outdated HTML tags',
    summary: deprecated.length ? `Uses deprecated tags: ${deprecated.map((t) => `<${t}>`).join(', ')}` : 'No deprecated HTML tags.',
    fix: deprecated.length ? 'A sign of a very old site; replace these with CSS.' : '' });

  const inlineStyles = $('[style]').length;
  check(checks, { id: 'inline-css', cat: 'advanced', weight: 0.5, status: inlineStyles < 30 ? 'pass' : 'warn', title: 'Inline styles',
    summary: `${inlineStyles} elements with style="" attributes.`,
    fix: inlineStyles < 30 ? '' : 'Move inline styles into a stylesheet to keep pages lean and consistent.' });

  const metaRefresh = $('meta[http-equiv="refresh" i]').length;
  check(checks, { id: 'meta-refresh', cat: 'advanced', weight: 0.5, status: metaRefresh ? 'warn' : 'pass', title: 'Meta refresh',
    summary: metaRefresh ? 'The page uses a meta refresh redirect.' : 'No meta refresh.',
    fix: metaRefresh ? 'Use a server-side 301 redirect instead.' : '' });

  const generator = $('meta[name="generator" i]').attr('content');
  const platform = generator ||
    (/wp-includes|wp-json|wp-content\/(themes|plugins)/.test(page.body) && 'WordPress') ||
    (/static\.wixstatic|wix\.com/.test(page.body) && 'Wix') ||
    (/squarespace/.test(page.body) && 'Squarespace') ||
    (/godaddy|img1\.wsimg\.com/.test(page.body) && 'GoDaddy Website Builder') ||
    (/cdn\.shopify/.test(page.body) && 'Shopify') ||
    (/weebly/.test(page.body) && 'Weebly') || null;
  const ga = page.body.match(/G-[A-Z0-9]{6,}/);
  check(checks, { id: 'platform', cat: 'advanced', status: 'info', title: 'Site platform',
    summary: platform ? `Built with ${platform}.` : 'Platform not detected (possibly hand-coded or a custom build).',
    details: ga ? [`GA4 ID: ${ga[0]}`] : [] });

  await runExtraChecks($, final, page, (c) => check(checks, c));

  return summarize(checks, { url: final.href, requested: target.href, status: page.status });
}

function summarize(checks, meta) {
  const scored = checks.filter((c) => c.status in POINTS && c.weight > 0);
  const total = scored.reduce((s, c) => s + c.weight, 0);
  const got = scored.reduce((s, c) => s + c.weight * POINTS[c.status], 0);
  const byCat = {};
  for (const [key, label] of Object.entries(CATEGORIES)) {
    const cs = scored.filter((c) => c.cat === key);
    const t = cs.reduce((s, c) => s + c.weight, 0);
    byCat[key] = { label, score: t ? Math.round((100 * cs.reduce((s, c) => s + c.weight * POINTS[c.status], 0)) / t) : null };
  }
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) counts[c.status]++;
  return {
    ...meta,
    checkedAt: new Date().toISOString(),
    score: Math.round((100 * got) / total),
    counts,
    categories: byCat,
    checks,
  };
}
