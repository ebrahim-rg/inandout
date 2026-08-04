# House Expenses

Shared joint expense logbook for Ebrahim & Qadr — one running record of what the house spent, not a split/settle-up tool. One HTML file + one serverless function, backed by Upstash Redis. Works on phones, no build step.

**PIN: `0101`**

## Files

```
index.html          # the whole app (UI + logic)
api/expenses.js     # Vercel serverless fn -> Upstash Redis
package.json        # only exists so Vercel treats api/*.js as ESM
```

## Setup (~5 minutes)

**1. Upstash**

- Go to https://console.upstash.com → Create Database → Redis (free tier, pick a region near you).
- Open the database → **REST API** section → copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

**2. GitHub**

```bash
git init
git add .
git commit -m "house expenses"
git branch -M main
git remote add origin git@github.com:<you>/house-expenses.git
git push -u origin main
```

**3. Vercel**

- vercel.com → Add New → Project → import the repo.
- Framework preset: **Other**. No build command, no output directory.
- Settings → Environment Variables → add these (all environments):
  - `UPSTASH_REDIS_REST_URL`
  - `UPSTASH_REDIS_REST_TOKEN`
  - `APP_PIN` = `0101` (optional — the API defaults to `0101` if unset)
- Deploy. Open the URL on both phones → Share → **Add to Home Screen** for an app-like icon.

If you add the env vars *after* the first deploy, hit **Redeploy** so they get picked up.

## How it works

- Each expense is one field in a Redis hash (`expenses`), keyed by a random id.
- Writes are per-item, so both of you can add at the same time without overwriting each other.
- The app polls every 8s and on tab focus, so changes show up on the other phone within seconds.
- Everything is cached in `localStorage` — if the network drops, the app still opens and shows the last known list; it re-syncs when it's back. (Edits made while fully offline are local-only.)
- The Upstash token lives only in Vercel env vars, never in the browser.

## Things you can tweak

At the top of the `<script>` block in `index.html`:

```js
const PEOPLE     = ["Ebrahim", "Qadr"];
const CATEGORIES = ["Groceries","Utilities","Rent","Home","Eating out","Transport","Health","Help/Staff","Other"];
const POLL_MS    = 8000;
```

Currency is PKR via the `fmt()` helper — change `"Rs "` and the locale there if needed.

## PIN

Shared PIN keypad on open, default `0101`. It's stored after the first correct entry, so you each type it once per device. The API also checks it (`x-pin` header) — so the data can't be read by hitting `/api/expenses` directly.

To change it, edit `const PIN = "0101"` in `index.html` **and** set `APP_PIN` to the same value in Vercel. Long-press (or right-click) the "House Expenses" title to lock the app again.

This is a convenience lock, not real security — the PIN is visible in the page source to anyone determined enough. Fine for keeping a household logbook private from casual eyes.

## Reset everything

In the Upstash console → Data Browser → delete the `expenses` key.
