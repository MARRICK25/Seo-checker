// GET /api/speed?url=...&strategy=mobile|desktop
// Wraps Google PageSpeed Insights (free). Set PSI_API_KEY in Vercel for a
// reliable quota; without a key Google's shared quota often returns 429.
import { normalizeUrl } from '../lib/fetcher.js';

const METRICS = {
  'first-contentful-paint': 'First Contentful Paint',
  'largest-contentful-paint': 'Largest Contentful Paint',
  'total-blocking-time': 'Total Blocking Time',
  'cumulative-layout-shift': 'Cumulative Layout Shift',
  'speed-index': 'Speed Index',
};

export default async function handler(req, res) {
  const params = new URL(req.url, 'http://x').searchParams;
  res.setHeader('Content-Type', 'application/json');
  try {
    const url = normalizeUrl(params.get('url')).href;
    const strategy = params.get('strategy') === 'desktop' ? 'desktop' : 'mobile';
    const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    api.searchParams.set('url', url);
    api.searchParams.set('strategy', strategy);
    for (const c of ['performance', 'seo', 'accessibility', 'best-practices']) api.searchParams.append('category', c);
    if (process.env.PSI_API_KEY) api.searchParams.set('key', process.env.PSI_API_KEY);

    const r = await fetch(api, { signal: AbortSignal.timeout(55000) });
    const data = await r.json();
    if (!r.ok) {
      const quota = r.status === 429;
      throw new Error(quota
        ? 'Google PageSpeed quota reached. Add a free PSI_API_KEY in Vercel settings (see README).'
        : data.error?.message || `PageSpeed returned ${r.status}`);
    }
    const lh = data.lighthouseResult;
    const audits = lh.audits;
    const opportunities = Object.values(audits)
      .filter((a) => a.details?.type === 'opportunity' && a.score !== null && a.score < 0.9)
      .sort((a, b) => (b.details.overallSavingsMs || 0) - (a.details.overallSavingsMs || 0))
      .slice(0, 8)
      .map((a) => ({ title: a.title, savings: a.displayValue || '' }));
    const field = data.loadingExperience?.metrics;
    res.statusCode = 200;
    res.end(JSON.stringify({
      strategy,
      scores: Object.fromEntries(Object.entries(lh.categories).map(([k, v]) => [k, Math.round(v.score * 100)])),
      metrics: Object.entries(METRICS).map(([id, label]) => ({
        label, value: audits[id]?.displayValue, score: audits[id]?.score,
      })),
      field: field ? {
        overall: data.loadingExperience.overall_category,
        lcp: field.LARGEST_CONTENTFUL_PAINT_MS?.percentile,
        inp: field.INTERACTION_TO_NEXT_PAINT?.percentile,
        cls: field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile,
      } : null,
      opportunities,
      screenshot: audits['final-screenshot']?.details?.data || null,
    }));
  } catch (err) {
    res.statusCode = 200; // the page shows the message; 200 keeps it readable everywhere
    res.end(JSON.stringify({ error: err.name === 'TimeoutError' ? 'PageSpeed took too long.' : err.message }));
  }
}
