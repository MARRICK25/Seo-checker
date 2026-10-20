# Site Health Check: a free SEO audit tool

Live at https://seo-checker-beryl-omega.vercel.app

A small web app that audits any web page and gives a 0–100 score, failed checks,
warnings, and a plain-English "how to fix" for each one. It covers the core of
what paid audit sites (like seositecheckup.com's free page audit) check, with
original code and wording, plus a **Local business** section aimed at the
small-business prospects we pitch.

## What it checks (about 55 checks)

| Section | Checks |
|---|---|
| Search basics | title, meta description, Google result preview, H1, heading structure, image alt text, canonical, noindex, robots.txt, XML sitemap, Open Graph / Twitter tags, schema.org data, favicon, lang, friendly URL, real 404 status |
| Content | broken links (up to 40 per page), word count, top keywords and phrases vs title/description, internal/external links, exposed email addresses |
| Local business | tap-to-call phone link, contact/quote form, LocalBusiness schema, address/ZIP and map link, reviews/testimonials |
| Speed | HTML size, gzip/Brotli, server response time, redirect chain, number of scripts/styles, render-blocking scripts, CSS/JS minification and compression, HTTP/2 (and HTTP/3 hint), WebP/AVIF and lazy loading, DOM size, host/CDN |
| Speed (Google) | Lighthouse mobile scores for Performance, SEO, Accessibility and Best practices; FCP, LCP, TBT, CLS, Speed Index; real-visitor Chrome data when Google has it; top speed fixes; phone screenshot |
| Security | Google Safe Browsing (malware/phishing flags, needs the free key), HTTPS, http→https redirect, www/non-www consistency, mixed content, HSTS and security headers, unsafe new-tab links, server version leaks, SPF/DMARC email records |
| Mobile | viewport tag, responsive CSS, pinch-zoom not disabled |
| Advanced | analytics/Tag Manager/Meta Pixel, doctype & charset, deprecated tags, inline styles, meta refresh, platform detection (WordPress, Wix, GoDaddy, etc.) |

The score weights the checks that matter most (title, description, HTTPS,
viewport, noindex) more heavily. A pass earns full points, a warning half, a fail none.

Report extras: **Print / save PDF** (clean print layout to send to a prospect),
**Copy top issues** (a short text summary to paste into an email), and shareable
links (`https://your-app.vercel.app/?url=dhroof.com` runs the check on open).

## Find businesses (`/find.html`)

Type a service and a place, like "Roofing contractors in New Jersey". The app:

1. Gets the businesses from OpenStreetMap through its Nominatim name search (free) or Google Maps (if `PLACES_API_KEY` is set). Google returns at most 60 per search, so big areas
   are split into map sections: a section that comes back full is cut into four smaller ones.
   Each click searches the next few sections (up to 15 Google requests, about 15 seconds).
2. Runs this app's site check on every website it finds (three at a time) and saves the score.
3. Ranks them. **Strong fit** means 4.3+ stars, 15+ reviews and a site score under 75.
   **No website** with good reviews is also a strong lead. Fit is a starting guess.
4. Remembers everything. Running the same search again continues with the sections not searched yet,
   and businesses found in any earlier search are counted as "already seen" instead of shown as new.
   Your notes (Interested, Contacted, Skip) and the scores are saved too. Download CSV exports the list.

### Setup (once)

1. **Business list source.** With no setup it uses free OpenStreetMap data: no key, no card. That data has
   no star ratings or review counts and misses some small businesses, so fit is based on the website alone
   (click a name to open its Google reviews). Each click searches up to 30 map boxes (about 30 seconds);
   click "Search the next areas" to continue a big area. **Optional, better data:** Google Maps (ratings, reviews, more businesses). Create a Google
   Cloud project, enable **"Places API (New)"** (Google requires a regular credit or debit card on billing, not a
   prepaid card), create an API key, and add it in Vercel as `PLACES_API_KEY`. When that's set, the finder
   switches to Google automatically. Set a daily quota cap under Places API (New) → Quotas to avoid surprise charges.
2. **Give it memory.** In Vercel open the project → **Storage** → **Create / Connect** → **Upstash for Redis**
   (free plan) → connect it to this project. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
   Redeploy (or push any commit to GitHub, which redeploys automatically). Without it the finder shows "Memory is not set up yet". Locally it saves to `.data/memory.json` instead.
3. **Recommended: add a password.** Add `APP_PASSWORD` in Vercel → Settings → Environment Variables and redeploy.
   Otherwise anyone who finds the link could use your Google allowance and see your lead list.

## Not included (needs paid data)

These features on paid SEO sites depend on large commercial datasets, so they are left out:
backlinks and toxic links, keyword rankings and position tracking, keyword
research/difficulty, organic traffic estimates, competitor comparisons, and
"AI/LLM visibility" tracking. Uptime monitoring and whole-site crawls are possible
for free but are bigger projects; ask if you want them.

## Deploy to Vercel

1. Put this `seo-checker` folder in its own GitHub repo (or drag the folder into
   Vercel with `npx vercel` from inside it).
2. In Vercel: **Add New → Project**, import the repo. Framework preset: **Other**.
   Leave build settings empty. Vercel serves `public/` and turns `api/*.js` into functions.
3. **Recommended:** add a free Google PageSpeed key so the speed section never
   hits Google's shared quota:
   - Go to <https://developers.google.com/speed/docs/insights/v5/get-started> → **Get a Key**
     (free, uses a Google account; no billing needed).
   - In Vercel: **Project → Settings → Environment Variables**, add `PSI_API_KEY` = your key, then redeploy.
   - The same key also powers the Safe Browsing check if you enable the **Safe Browsing API** for it in
     Google Cloud Console (APIs & Services → Library → "Safe Browsing API" → Enable). Or use a separate
     key as `SAFE_BROWSING_KEY`. Without either, that check just shows "not checked".
4. Open the site and enter a URL.

The functions are set to run for up to 60 seconds (`vercel.json`), which fits the
Hobby (free) plan. Google's speed test usually takes 15–40 seconds; the rest of
the report shows first and the speed panel fills in when Google answers.

## Run locally

```
npm install
npm run dev        # http://localhost:3000
```

## Files

- `public/index.html` is the whole front end (no build step).
- `api/audit.js` is the endpoint `GET /api/audit?url=...`, which returns the JSON report.
- `public/find.html` is the business finder page.
- `api/find.js` is the finder endpoint (search, saved searches, notes); `lib/places.js` talks to Google Maps and splits areas; `lib/osm.js` is the free OpenStreetMap search; `lib/store.js` is the memory (Upstash Redis, or a local file).
- `api/speed.js` is the endpoint `GET /api/speed?url=...&strategy=mobile|desktop`, a PageSpeed Insights wrapper.
- `lib/extra-checks.js` holds broken links, minification, HTTP/2 and Safe Browsing (they make extra requests).
- `lib/audit.js` holds all the other checks. Each one is a `check(...)` call, so adding one is a few lines.
- `lib/fetcher.js` handles fetching with redirect tracking and blocks private or internal
  addresses so the tool can't be used to probe networks.

## Notes

- Checks run against the single URL you enter (usually the homepage), not the whole site.
- Some sites block automated requests (Cloudflare "are you human" pages). Those will show
  as errors or odd results; Google's speed test usually still works for them.
- The "Server response time" is measured from Vercel's data center, not the visitor's phone.
- Links to Facebook, LinkedIn, Yelp and similar sites often block automated checks; those are listed as
  "check by hand" rather than counted as broken.
