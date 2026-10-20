// Free business search from OpenStreetMap: no key, no card.
// Nominatim turns "New Jersey" into an area; Overpass lists the businesses in it
// whose name or trade tag matches the service. There is no 60-result cap, so one
// search covers the whole area. OSM has no star ratings or review counts, and it
// misses some small businesses that only exist on Google.
const UA = 'SiteHealthCheck-BusinessFinder/1.0 (small-business website audits)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

const STOP = new Set('a an and the of in near around for my best local top company companies contractor contractors service services business businesses shop shops specialist specialists pro pros expert experts'.split(' '));

// Trade words mapped to the tag OSM uses for that trade.
const TAGS = [
  [/^roof/, ['craft', 'roofer']], [/^plumb/, ['craft', 'plumber']], [/^electric/, ['craft', 'electrician']],
  [/^(hvac|heating|cooling|air)/, ['craft', 'hvac']], [/^paint/, ['craft', 'painter']], [/^carpent/, ['craft', 'carpenter']],
  [/^(landscap|lawn|garden)/, ['craft', 'gardener']], [/^(dent)/, ['amenity', 'dentist']], [/^restaurant/, ['amenity', 'restaurant']],
  [/^(cafe|coffee)/, ['amenity', 'cafe']], [/^(salon|hair|barber)/, ['shop', 'hairdresser']], [/^(auto|mechanic|car)/, ['shop', 'car_repair']],
  [/^(lawyer|attorney|law)/, ['office', 'lawyer']], [/^account/, ['office', 'accountant']], [/^(gym|fitness)/, ['leisure', 'fitness_centre']],
  [/^baker/, ['shop', 'bakery']], [/^(real|realtor)/, ['office', 'estate_agent']], [/^insur/, ['office', 'insurance']],
  [/^chiropract/, ['healthcare', 'chiropractor']], [/^vet/, ['amenity', 'veterinary']], [/^florist/, ['shop', 'florist']],
];

function stem(w) {
  return w.replace(/(ing|ers|er|ists|ist|s)$/, '') || w;
}

export function serviceFilters(service) {
  const words = service.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
  if (!words.length) throw new Error('Name the kind of business, like "Roofing contractors in New Jersey".');
  const stems = words.map(stem).filter((w) => w.length >= 3);
  // Case-sensitive patterns are far faster on the map server than case-insensitive ones,
  // so match "Roof", "roof" and "ROOF" explicitly, using the longest word.
  const w = (stems.length ? stems : words).sort((a, b) => b.length - a.length)[0];
  const nameRe = `[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}|${w.toUpperCase()}`;
  const tags = [];
  for (const w of words) for (const [re, tag] of TAGS) if (re.test(w) && !tags.some((t) => t[1] === tag[1])) tags.push(tag);
  return { nameRe, tags };
}

export async function findAreaOsm(location) {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', location);
  u.searchParams.set('format', 'json');
  u.searchParams.set('limit', '5');
  u.searchParams.set('countrycodes', 'us');
  // Only towns, counties and states, not a shop or street that shares the name.
  u.searchParams.set('featureType', 'settlement');
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`The free map service answered ${r.status}. Try again in a minute.`);
  const results = await r.json();
  const p = results.find((x) => x.osm_type === 'relation') || results[0];
  if (!p) throw new Error(`Couldn't find a place called "${location}". Try adding the state, like "Hamilton NJ".`);
  const [s, n, w, e] = p.boundingbox.map(Number);
  return {
    label: p.display_name.split(',').slice(0, 3).join(',').trim(),
    box: { s, w, n, e },
    // Overpass area ids are the relation id plus 3600000000.
    areaId: p.osm_type === 'relation' ? 3600000000 + Number(p.osm_id) : null,
  };
}

// Map sections are searched one box at a time, which keeps each query quick.
export const TILE_DEG = 0.3;
export function tileBox({ s, w, n, e }) {
  const rows = Math.max(1, Math.ceil((n - s) / TILE_DEG)), cols = Math.max(1, Math.ceil((e - w) / TILE_DEG));
  const out = [];
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    out.push({ s: s + ((n - s) * i) / rows, n: s + ((n - s) * (i + 1)) / rows, w: w + ((e - w) * j) / cols, e: w + ((e - w) * (j + 1)) / cols });
  }
  return out;
}

function overpassQuery({ nameRe, tags }, area) {
  const f = (x) => x.toFixed(5);
  const scope = `(${f(area.box.s)},${f(area.box.w)},${f(area.box.n)},${f(area.box.e)})`;
  const safe = nameRe.replace(/["\\]/g, '');
  const parts = [`nwr["name"~"${safe}"]${scope};`, ...tags.map(([k, v]) => `nwr["${k}"="${v}"]["name"]${scope};`)];
  return `[out:json][timeout:60];(${parts.join('')});out tags 3000;`;
}

function toBusiness(el) {
  const t = el.tags || {};
  const town = t['addr:city'] || t['addr:town'] || t['addr:village'] || '';
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  let website = t.website || t['contact:website'] || t.url || '';
  if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
  return {
    id: `osm:${el.type[0]}${el.id}`,
    name: t.name,
    type: t.craft || t.shop || t.office || t.amenity || '',
    address: [street, town, [t['addr:state'], t['addr:postcode']].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    town,
    rating: null,
    reviews: null,
    website,
    phone: t.phone || t['contact:phone'] || '',
    // A Google Maps search, so the owner's reviews are one click away.
    maps: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([t.name, town || t['addr:state']].filter(Boolean).join(' ')),
    open: !t['disused:shop'] && !t.disused,
    source: 'osm',
  };
}

// Places like parks or streets can share a trade word ("Roof Garden"); keep things that look like businesses.
const looksLikeBusiness = (t) => t.name && (t.craft || t.shop || t.office || t.amenity || t.website || t['contact:website'] || t.phone || t['contact:phone'] || t['addr:street']) && !t.highway && !t.leisure?.match(/park|garden/);

export function osmQuery(service, area) {
  return overpassQuery(serviceFilters(service), area);
}

export function businessesFromElements(elements = []) {
  const seen = new Set();
  return elements.filter((el) => el && el.type && el.id && looksLikeBusiness(el.tags || {})).map(toBusiness)
    .filter((b) => (seen.has(b.name.toLowerCase()) ? false : seen.add(b.name.toLowerCase())));
}

// Server-side Overpass call (used by the search check). The finder page runs the
// same query from the visitor's browser instead, since Overpass often throttles
// cloud servers like Vercel's and big areas can take longer than Vercel allows.
export async function searchOsm(service, area) {
  const q = osmQuery(service, area);
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) throw new Error(`The free map service answered ${r.status}.`);
      const data = await r.json();
      return businessesFromElements(data.elements);
    } catch (e) { lastErr = e; }
  }
  throw new Error((lastErr?.name === 'TimeoutError' ? 'The free map service took too long. ' : (lastErr?.message || '') + ' ') + 'Try a smaller area, like a county or town.');
}

// Name search through Nominatim, the map's address-lookup server. It answers Vercel
// reliably (Overpass often doesn't) but returns at most 40 places per box, so big
// areas are split into smaller boxes, like the Google search.
export function nominatimTerms(service) {
  const words = service.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
  if (!words.length) throw new Error('Name the kind of business, like "Roofing contractors in New Jersey".');
  const terms = [words.join(' ')];
  for (const w of words) for (const [re, [, v]] of TAGS) if (re.test(w)) terms.push(v.replace(/_/g, ' '));
  return [...new Set(terms)];
}

let lastNominatim = 0;
export async function searchNominatim(term, box) {
  // Nominatim's rules allow about one request per second.
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  lastNominatim = Date.now();
  const u = new URL('https://nominatim.openstreetmap.org/search');
  for (const [k, v] of Object.entries({ q: term, format: 'jsonv2', limit: '40', bounded: '1', viewbox: `${box.w},${box.n},${box.e},${box.s}`, extratags: '1', addressdetails: '1', countrycodes: 'us', dedupe: '1' })) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 429) throw new Error('The free map service asked us to slow down. Wait a minute and try again.');
  if (!r.ok) throw new Error(`The free map service answered ${r.status}. Try again in a minute.`);
  const rows = await r.json();
  const elements = rows.map((x) => {
    const a = x.address || {};
    return {
      type: x.osm_type, id: x.osm_id,
      tags: {
        ...(x.extratags || {}), name: x.name || (x.display_name || '').split(',')[0], [x.category]: x.type,
        'addr:housenumber': a.house_number, 'addr:street': a.road, 'addr:city': a.city || a.town || a.village || a.hamlet || a.suburb,
        'addr:state': a.state, 'addr:postcode': a.postcode,
      },
    };
  });
  return { businesses: businessesFromElements(elements), full: rows.length >= 40 };
}
