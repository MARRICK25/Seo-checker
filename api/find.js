// The business finder.
//   GET  /api/find                -> past searches
//   GET  /api/find?key=...        -> one search and every business it found
//   POST /api/find {query}        -> search the next few areas, remembering
//                                    what was already covered and found
//   POST /api/find {action:'update', id, siteScore?, mark?} -> save a site score or your note
// Uses Google Maps when PLACES_API_KEY is set (ratings, reviews, best coverage),
// otherwise free OpenStreetMap data (no key or card, no ratings).
import { findArea, searchBox, splitBox, MIN_BOX_DEG } from '../lib/places.js';
import { findAreaOsm, searchOsm, nominatimTerms, searchNominatim } from '../lib/osm.js';
import { getJSON, setJSON, hGetMany, hSetMany } from '../lib/store.js';

const REQUEST_BUDGET = 15; // Google requests per click (one area costs 1-3)
const OSM_CALLS_PER_CLICK = 30; // free-map lookups per click (about one per second)
const MARKS = ['', 'interested', 'contacted', 'skip'];

function parseQuery(q) {
  const m = String(q || '').trim().match(/^(.+?)\s+(?:in|near|around)\s+(.+)$/i);
  if (!m) throw new Error('Describe the service and the place, like "Roofing contractors in New Jersey".');
  return { service: m[1].trim(), location: m[2].trim() };
}
const keyOf = (q) => q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/ /g, '-');

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function summary(s) {
  const done = s.cells.filter((c) => c.state !== 'todo');
  return {
    key: s.key, query: s.query, area: s.areaLabel,
    areasSearched: done.length,
    areasLeft: s.cells.filter((c) => c.state === 'todo').length,
    total: s.ids.length,
    finished: !s.cells.some((c) => c.state === 'todo'),
    towns: [...new Set([...(s.osmTowns || []), ...done.map((c) => c.label)].filter(Boolean))],
    source: s.source || 'google',
    updatedAt: s.updatedAt,
  };
}

async function businessesFor(s) {
  const map = await hGetMany('biz', s.ids);
  return s.ids.map((id) => map[id]).filter(Boolean);
}

// Businesses you found yourself, saved as a list that works like a search.
async function addByHand(listName, rows) {
  const query = String(listName || 'My list').trim().slice(0, 80) || 'My list';
  const key = 'list-' + keyOf(query);
  if (!Array.isArray(rows) || !rows.length) throw new Error('Paste at least one business, one per line.');
  const now = new Date().toISOString();
  const found = new Map();
  for (const r of rows.slice(0, 300)) {
    const name = String(r.name || '').trim().slice(0, 120);
    if (!name) continue;
    let website = String(r.website || '').trim();
    if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
    let host = '';
    try { host = website ? new URL(website).hostname.replace(/^www\./, '') : ''; } catch { website = ''; }
    const town = String(r.town || '').trim().slice(0, 60);
    const id = 'hand:' + (host || keyOf(name + ' ' + town));
    const rating = r.rating === '' || r.rating == null || isNaN(r.rating) ? null : Math.max(0, Math.min(5, Number(r.rating)));
    found.set(id, {
      id, name, town, website, rating,
      reviews: r.reviews === '' || r.reviews == null || isNaN(r.reviews) ? null : Math.max(0, Math.round(Number(r.reviews))),
      phone: String(r.phone || '').trim().slice(0, 30), type: '', address: town, open: true, source: 'hand',
      maps: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([name, town].filter(Boolean).join(' ')),
    });
  }
  if (!found.size) throw new Error('Each line needs at least a business name.');
  let s = (await getJSON('search:' + key)) || { key, query, source: 'hand', areaLabel: 'Added by hand', cells: [], ids: [], createdAt: now };
  const ids = [...found.keys()];
  const known = await hGetMany('biz', ids);
  const fresh = {};
  const refreshed = {};
  for (const [id, b] of found) {
    if (known[id]) refreshed[id] = { ...known[id], ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== null && v !== '')) };
    else fresh[id] = { ...b, firstSeen: now, firstSearch: query };
  }
  await hSetMany('biz', { ...refreshed, ...fresh });
  const inList = new Set(s.ids);
  for (const id of ids) if (!inList.has(id)) s.ids.push(id); // a business you add by hand always shows in the list you added it to
  s.updatedAt = now;
  await setJSON('search:' + key, s);
  const list = (await getJSON('searches')) || [];
  const entry = summary(s);
  await setJSON('searches', [entry, ...list.filter((x) => x.key !== key)].slice(0, 50));
  return { search: entry, newIds: Object.keys(fresh), alreadySeen: ids.length - Object.keys(fresh).length, businesses: await businessesFor(s) };
}

async function runSearch(query) {
  const { service, location } = parseQuery(query);
  const key = keyOf(query);
  const source = process.env.PLACES_API_KEY ? 'google' : 'osm';
  let s = await getJSON('search:' + key);
  if (s && (s.source || 'google') !== source) s = { ...s, source, cells: [{ box: s.cells[0].box, state: 'todo' }] }; // source changed: search again, keep what was found
  if (!s) {
    const area = source === 'google' ? await findArea(location) : await findAreaOsm(location);
    s = { key, query, service, location, source, areaLabel: area.label, areaId: area.areaId, cells: [{ box: area.box, state: 'todo' }], ids: [], createdAt: new Date().toISOString() };
  }

  let budget = REQUEST_BUDGET;
  const found = new Map();
  if (source === 'osm') {
    // Free map: name search per box. A box with 40 results (the most Nominatim
    // returns) is split in four for the next run, like the Google search.
    const terms = nominatimTerms(s.service);
    let calls = OSM_CALLS_PER_CLICK;
    while (calls >= terms.length) {
      const cell = s.cells.find((c) => c.state === 'todo');
      if (!cell) break;
      let full = false;
      const list = [];
      for (const t of terms) {
        const r = await searchNominatim(t, cell.box);
        calls--;
        list.push(...r.businesses);
        full ||= r.full;
      }
      for (const b of list) found.set(b.id, b);
      const towns = list.map((b) => b.town).filter(Boolean);
      cell.label = towns.sort((x, y) => towns.filter((t) => t === y).length - towns.filter((t) => t === x).length)[0] || '';
      cell.found = list.length;
      if (full && cell.box.n - cell.box.s > MIN_BOX_DEG) {
        cell.state = 'split';
        s.cells.push(...splitBox(cell.box).map((box) => ({ box, state: 'todo' })));
      } else cell.state = 'done';
    }
    budget = 0;
  }
  while (budget >= 3) {
    const cell = s.cells.find((c) => c.state === 'todo');
    if (!cell) break;
    const r = await searchBox(s.service, cell.box);
    budget -= r.requests;
    for (const b of r.businesses) found.set(b.id, b);
    const towns = r.businesses.map((b) => b.town).filter(Boolean);
    cell.label = towns.sort((a, b) => towns.filter((t) => t === b).length - towns.filter((t) => t === a).length)[0] || '';
    cell.found = r.businesses.length;
    if (r.full && cell.box.n - cell.box.s > MIN_BOX_DEG) {
      cell.state = 'split';
      s.cells.push(...splitBox(cell.box).map((box) => ({ box, state: 'todo' })));
    } else {
      cell.state = 'done';
    }
  }

  // "New" means never seen in any earlier search, not just this one.
  const ids = [...found.keys()];
  const known = await hGetMany('biz', ids);
  const now = new Date().toISOString();
  const fresh = {};
  const refreshed = {};
  for (const [id, b] of found) {
    if (known[id]) refreshed[id] = { ...known[id], ...b }; // keep score and mark, update rating etc.
    else fresh[id] = { ...b, firstSeen: now, firstSearch: query };
  }
  await hSetMany('biz', { ...refreshed, ...fresh });
  const inSearch = new Set(s.ids);
  for (const id of ids) if (!inSearch.has(id) && !known[id]) s.ids.push(id);
  // Businesses first found by another search are remembered there, not repeated here.
  s.updatedAt = now;
  await setJSON('search:' + key, s);

  const list = (await getJSON('searches')) || [];
  const entry = summary(s);
  await setJSON('searches', [entry, ...list.filter((x) => x.key !== key)].slice(0, 50));

  return { search: entry, newIds: Object.keys(fresh), alreadySeen: ids.length - Object.keys(fresh).length, businesses: await businessesFor(s) };
}

// GET /api/find?check=Roofers in Trenton NJ -> runs one search step by step without saving, to see what fails.
async function checkSearch(query, only) {
  const out = { source: process.env.PLACES_API_KEY ? 'google' : 'osm', steps: [] };
  const step = async (name, fn) => {
    const t = Date.now();
    try { const r = await fn(); out.steps.push({ name, ok: true, ms: Date.now() - t }); return r; }
    catch (e) { out.steps.push({ name, ok: false, ms: Date.now() - t, error: e.message }); throw e; }
  };
  try {
    const { service, location } = await step('read query', async () => parseQuery(query));
    const area = await step('find area', () => (out.source === 'google' ? findArea(location) : findAreaOsm(location)));
    out.area = area;
    if (only === 'area') return out;
    if (only === 'names') {
      const terms = nominatimTerms(service);
      out.terms = terms;
      const res = await step('name search', () => searchNominatim(terms[0], area.box));
      out.count = res.businesses.length; out.full = res.full;
      out.sample = res.businesses.slice(0, 8).map((b) => `${b.name} (${b.town || '?'}) ${b.website || 'no website'} ${b.phone}`);
      return out;
    }
    const list = await step('find businesses', async () => (out.source === 'google' ? (await searchBox(service, area.box)).businesses : searchOsm(service, area)));
    out.count = list.length;
    out.sample = list.slice(0, 5).map((b) => `${b.name} (${b.town || '?'}) ${b.website || 'no website'}`);
  } catch {}
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };

  const pw = process.env.APP_PASSWORD;
  if (pw && req.headers['x-app-password'] !== pw) return send(401, { error: 'Enter the app password.', needPassword: true });

  try {
    if (req.method === 'GET') {
      const params = new URL(req.url, 'http://x').searchParams;
      if (params.get('check')) return send(200, await checkSearch(params.get('check'), params.get('only')));
      const key = params.get('key');
      if (!key) return send(200, { searches: (await getJSON('searches')) || [] });
      const s = await getJSON('search:' + key);
      if (!s) return send(404, { error: 'That search is not saved.' });
      return send(200, { search: summary(s), newIds: [], businesses: await businessesFor(s) });
    }
    if (req.method !== 'POST') return send(405, { error: 'Use GET or POST.' });

    const body = await readBody(req);
    if (body.action === 'add') return send(200, await addByHand(body.list, body.businesses));
    if (body.action === 'update') {
      const cur = (await hGetMany('biz', [String(body.id)]))[body.id];
      if (!cur) return send(404, { error: 'Business not found.' });
      if ('siteScore' in body) cur.siteScore = body.siteScore === null ? null : Math.max(0, Math.min(100, Number(body.siteScore) || 0));
      if ('siteError' in body) cur.siteError = String(body.siteError || '').slice(0, 300);
      if ('mark' in body && MARKS.includes(body.mark)) cur.mark = body.mark;
      await hSetMany('biz', { [cur.id]: cur });
      return send(200, { business: cur });
    }
    return send(200, await runSearch(body.query));
  } catch (err) {
    send(400, { error: err.name === 'TimeoutError' ? 'Google took too long to answer. Try again.' : err.message });
  }
}
