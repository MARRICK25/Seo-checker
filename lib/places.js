// Google Places (New) Text Search, used by the business finder.
// One search returns at most 60 places (3 pages of 20), so big areas are
// covered as a grid of boxes: a box that comes back full is split in four
// and its quarters are searched on later runs.
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const BIZ_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.rating',
  'places.userRatingCount', 'places.websiteUri', 'places.nationalPhoneNumber',
  'places.googleMapsUri', 'places.businessStatus', 'places.primaryTypeDisplayName', 'nextPageToken',
].join(',');

export const MIN_BOX_DEG = 0.02; // about 2 km; boxes this small are not split further

function apiKey() {
  const key = process.env.PLACES_API_KEY;
  if (!key) throw new Error('No Google key found. Add PLACES_API_KEY in Vercel settings. See README.');
  return key;
}

async function searchText(body, fieldMask) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey(), 'X-Goog-FieldMask': fieldMask },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.error?.message || `Google answered ${r.status}`;
    if (r.status === 403 && /not been used|disabled|not authorized|API_KEY_SERVICE_BLOCKED/i.test(msg + JSON.stringify(data.error?.details || ''))) {
      throw new Error('Your Google key is not allowed to search businesses yet. Turn on "Places API (New)" for it in Google Cloud Console (see README), then try again.');
    }
    if (r.status === 429) throw new Error('Google search quota reached for now. Try again later.');
    throw new Error('Google business search failed: ' + msg);
  }
  return data;
}

// The map box for a place name such as "New Jersey" or "Hamilton NJ".
export async function findArea(location) {
  const data = await searchText({ textQuery: location, pageSize: 1 }, 'places.viewport,places.formattedAddress,places.displayName');
  const p = data.places?.[0];
  if (!p?.viewport) throw new Error(`Google couldn't find a place called "${location}". Try adding the state, like "Hamilton NJ".`);
  const { low, high } = p.viewport;
  return {
    label: p.formattedAddress || p.displayName?.text || location,
    box: { s: low.latitude, w: low.longitude, n: high.latitude, e: high.longitude },
  };
}

function townOf(address = '') {
  const parts = address.split(',').map((s) => s.trim());
  const i = parts.findIndex((s) => /^[A-Z]{2}( \d{5})?$/.test(s) || /^[A-Z]{2} \d{5}(-\d{4})?$/.test(s));
  return i > 0 ? parts[i - 1] : parts.length >= 3 ? parts[parts.length - 3] : '';
}

function toBusiness(p) {
  return {
    id: p.id,
    name: p.displayName?.text || 'Unnamed',
    type: p.primaryTypeDisplayName?.text || '',
    address: p.formattedAddress || '',
    town: townOf(p.formattedAddress),
    rating: p.rating ?? null,
    reviews: p.userRatingCount ?? 0,
    website: p.websiteUri || '',
    phone: p.nationalPhoneNumber || '',
    maps: p.googleMapsUri || '',
    open: !p.businessStatus || p.businessStatus === 'OPERATIONAL',
  };
}

// Every business in one box (up to 60). `full` means Google had more.
export async function searchBox(service, box) {
  const out = [];
  let pageToken;
  let pages = 0;
  do {
    const body = {
      textQuery: service,
      pageSize: 20,
      locationRestriction: { rectangle: { low: { latitude: box.s, longitude: box.w }, high: { latitude: box.n, longitude: box.e } } },
    };
    if (pageToken) body.pageToken = pageToken;
    const data = await searchText(body, BIZ_FIELDS);
    pages++;
    out.push(...(data.places || []).map(toBusiness));
    pageToken = data.nextPageToken;
  } while (pageToken && pages < 3);
  return { businesses: out, requests: pages, full: out.length >= 60 };
}

export function splitBox({ s, w, n, e }) {
  const mLat = (s + n) / 2, mLng = (w + e) / 2;
  return [
    { s: mLat, w, n, e: mLng }, { s: mLat, w: mLng, n, e },
    { s, w, n: mLat, e: mLng }, { s, w: mLng, n: mLat, e },
  ];
}
