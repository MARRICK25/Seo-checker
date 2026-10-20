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
  const nameRe = (stems.length ? stems : words).map((w) => `(^|[^a-z])${w}`).join('.*');
  const tags = [];
  for (const w of words) for (const [re, tag] of TAGS) if (re.test(w) && !tags.some((t) => t[1] === tag[1])) tags.push(tag);
  return { nameRe, tags };
}

export async function findAreaOsm(location) {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', location);
  u.searchParams.set('format', 'json');
  u.searchParams.set('limit', '1');
  u.searchParams.set('countrycodes', 'us');
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`The free map service answered ${r.status}. Try again in a minute.`);
  const p = (await r.json())[0];
  if (!p) throw new Error(`Couldn't find a place called "${location}". Try adding the state, like "Hamilton NJ".`);
  const [s, n, w, e] = p.boundingbox.map(Number);
  return {
    label: p.display_name.split(',').slice(0, 3).join(',').trim(),
    box: { s, w, n, e },
    // Overpass area ids are the relation id plus 3600000000.
    areaId: p.osm_type === 'relation' ? 3600000000 + Number(p.osm_id) : null,
  };
}

function overpassQuery({ nameRe, tags }, area) {
  const scope = area.areaId ? '(area.a)' : `(${area.box.s},${area.box.w},${area.box.n},${area.box.e})`;
  const safe = nameRe.replace(/["\\]/g, '');
  const parts = [`nwr["name"~"${safe}",i]${scope};`, ...tags.map(([k, v]) => `nwr["${k}"="${v}"]["name"]${scope};`)];
  return `[out:json][timeout:50];${area.areaId ? `area(id:${area.areaId})->.a;` : ''}(${parts.join('')});out center tags 3000;`;
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

export async function searchOsm(service, area) {
  const q = overpassQuery(serviceFilters(service), area);
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(55000),
      });
      if (!r.ok) throw new Error(`The free map service answered ${r.status}.`);
      const data = await r.json();
      const seen = new Set();
      return (data.elements || []).filter((el) => looksLikeBusiness(el.tags || {})).map(toBusiness)
        .filter((b) => (seen.has(b.name.toLowerCase()) ? false : seen.add(b.name.toLowerCase())));
    } catch (e) { lastErr = e; }
  }
  throw new Error((lastErr?.name === 'TimeoutError' ? 'The free map service took too long. ' : (lastErr?.message || '') + ' ') + 'Try a smaller area, like a county or town.');
}
