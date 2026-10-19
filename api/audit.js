// GET /api/audit?url=example.com  ->  JSON report of on-page checks
import { runAudit } from '../lib/audit.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x').searchParams.get('url');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const report = await runAudit(url);
    res.statusCode = 200;
    res.end(JSON.stringify(report));
  } catch (err) {
    res.statusCode = 400;
    const msg = err.name === 'TimeoutError' ? 'The site took too long to respond.' : err.cause?.code === 'ENOTFOUND' ? 'That domain could not be found.' : err.message;
    res.end(JSON.stringify({ error: msg || 'Could not audit that URL.', blocked: !!err.blocked }));
  }
}
