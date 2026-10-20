// The finder's memory: which areas each search has covered and every business
// already found. On Vercel it uses Upstash Redis (free, added from the Vercel
// Marketplace, which sets KV_REST_API_URL/TOKEN). Locally it falls back to a
// JSON file so `npm run dev` works with no setup.
import fs from 'node:fs/promises';

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const FILE = new URL('../.data/memory.json', import.meta.url);

export const storeKind = URL_ && TOKEN ? 'redis' : process.env.VERCEL ? 'none' : 'file';

async function redis(commands) {
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error(`Memory database answered ${r.status}.`);
  const out = await r.json();
  const bad = out.find((x) => x.error);
  if (bad) throw new Error('Memory database error: ' + bad.error);
  return out.map((x) => x.result);
}

// Local file: { kv: {key: value}, h: {hash: {field: value}} }
async function readFile() {
  try { return JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { return { kv: {}, h: {} }; }
}
async function writeFile(db) {
  await fs.mkdir(new URL('.', FILE), { recursive: true });
  const tmp = new URL('memory.json.tmp', FILE);
  await fs.writeFile(tmp, JSON.stringify(db));
  await fs.rename(tmp, FILE);
}
// One file operation at a time, so parallel requests don't overwrite each other.
let queue = Promise.resolve();
function locked(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function assertStore() {
  if (storeKind === 'none') {
    throw new Error('Memory is not set up yet. In Vercel open Storage, add "Upstash for Redis" (free) to this project, then redeploy. See README.');
  }
}

export async function getJSON(key) {
  assertStore();
  if (storeKind === 'redis') {
    const [v] = await redis([['GET', key]]);
    return v ? JSON.parse(v) : null;
  }
  return (await readFile()).kv[key] ?? null;
}

export async function setJSON(key, value) {
  assertStore();
  if (storeKind === 'redis') return void (await redis([['SET', key, JSON.stringify(value)]]));
  await locked(async () => {
    const db = await readFile();
    db.kv[key] = value;
    await writeFile(db);
  });
}

// Hash of JSON values, e.g. every business by Google place id.
export async function hGetMany(hash, fields) {
  assertStore();
  if (!fields.length) return {};
  if (storeKind === 'redis') {
    const [vals] = await redis([['HMGET', hash, ...fields]]);
    return Object.fromEntries(fields.map((f, i) => [f, vals[i] ? JSON.parse(vals[i]) : null]));
  }
  const h = (await readFile()).h[hash] || {};
  return Object.fromEntries(fields.map((f) => [f, h[f] ?? null]));
}

export async function hSetMany(hash, obj) {
  assertStore();
  const entries = Object.entries(obj);
  if (!entries.length) return;
  if (storeKind === 'redis') {
    return void (await redis([['HSET', hash, ...entries.flatMap(([k, v]) => [k, JSON.stringify(v)])]]));
  }
  await locked(async () => {
    const db = await readFile();
    db.h[hash] = { ...(db.h[hash] || {}), ...obj };
    await writeFile(db);
  });
}
