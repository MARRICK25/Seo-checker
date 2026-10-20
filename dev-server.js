// Local preview without the Vercel CLI: `npm install && npm run dev`
import http from 'node:http';
import fs from 'node:fs';
import audit from './api/audit.js';
import speed from './api/speed.js';
import find from './api/find.js';

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url.startsWith('/api/audit')) return audit(req, res);
  if (req.url.startsWith('/api/speed')) return speed(req, res);
  if (req.url.startsWith('/api/find')) return find(req, res);
  const page = req.url.startsWith('/find') ? 'find.html' : 'index.html';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  fs.createReadStream(new URL('./public/' + page, import.meta.url)).pipe(res);
}).listen(port, () => console.log(`SEO checker on http://localhost:${port}`));
