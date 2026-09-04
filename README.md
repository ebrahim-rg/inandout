# House Expenses

Shared joint expense logbook for Ebrahim & Qadr — one running record of what the house spent, not a split/settle-up tool. One HTML file + one serverless function, backed by Upstash Redis. Works on phones, no build step.



## Files

```
index.html            # the whole app (UI + logic)
api/expenses.js       # Vercel serverless fn -> Upstash Redis
api/ingest.js         # receives forwarded bank alert emails -> "pending" queue
api/pending.js        # app reads/confirms/discards the pending queue
gas/bank-forwarder.gs # Gmail Apps Script that forwards bank alerts to api/ingest.js
package.json          # only exists so Vercel treats api/*.js as ESM
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
  - `APP_PIN` = your chosen PIN (optional — the API falls back to the default hardcoded in `api/expenses.js` if unset)
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

Shared PIN keypad on open. It's stored after the first correct entry, so you each type it once per device. The API also checks it (`x-pin` header) — so the data can't be read by hitting `/api/expenses` directly.

To change it, edit the `PIN` constant in `index.html` **and** set `APP_PIN` to the same value in Vercel. Long-press (or right-click) the "House Expenses" title to lock the app again.

This is a convenience lock, not real security — the PIN is visible in the page source to anyone determined enough. Fine for keeping a household logbook private from casual eyes.

## Auto-import from bank alerts (optional)

Bank debit-alert emails can be auto-forwarded into the app as a "pending" queue —
they never post straight into your real expenses, you just confirm or discard
each one from a card that appears when you open the app.

**1. Vercel**

- Settings → Environment Variables → add `INGEST_SECRET` (any long random string —
  this guards `/api/ingest`, it's separate from the app PIN). Redeploy after adding it.

**2. Gmail**

- Open `gas/bank-forwarder.gs` in this repo, go to https://script.google.com → New
  project, and paste its contents in.
- Fill in `INGEST_SECRET` in the script to match the Vercel value exactly.
- Run `forwardBankAlerts` once and grant Gmail access when prompted.
- Triggers (clock icon, left sidebar) → Add Trigger → `forwardBankAlerts`,
  time-driven, every 5 minutes.

New debit alerts get parsed (amount, date, recipient) and show up in the app under
**"New from bank"** within a few minutes. Tap **Review** to fill in who paid and
the category (amount/date are pre-filled, both editable) and save it as a real
expense, or **✕** to discard ones that aren't house expenses (transfers, etc).
Credit/"received" alerts are ignored — only money going out counts.

The parser in `api/ingest.js` is written against Meezan Bank's current alert
wording (`PKR X sent ...`, `Transaction Date`, `Transaction Time`, `Beneficiary
Account`/`sent to ...`). If the bank changes its email template, or you're on a
different bank, that regex will need adjusting.

## Reset everything

In the Upstash console → Data Browser → delete the `expenses` key (and `inandout:pending` if you're using bank auto-import).
