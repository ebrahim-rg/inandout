# House Expenses

Shared joint expense logbook for Ebrahim & Qadr — one running record of what the house spent, not a split/settle-up tool. One HTML file + one serverless function, backed by Upstash Redis. Works on phones, no build step.



## Files

```
index.html            # the whole app (UI + logic)
api/expenses.js       # Vercel serverless fn -> Upstash Redis
api/ingest.js         # receives forwarded bank alert emails -> "pending"/"unparsed" queues
api/pending.js        # app reads/confirms/discards the pending queue
api/unparsed.js       # app reads/dismisses emails the parser couldn't understand
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

Bank alert emails can be auto-forwarded into the app as a "pending" queue —
they never post straight into your real expenses, you just confirm or discard
each one from a card that appears when you open the app.

**Scope**: the Gmail script only ever looks at emails already under your
**Banking** label — nothing else in your inbox is searched or read.

**1. Vercel**

- Settings → Environment Variables → add `INGEST_SECRET` (any long random string —
  this guards `/api/ingest`, it's separate from the app PIN). Redeploy after adding it.

**2. Gmail**

- Make sure every bank alert email carries your **Banking** label (as they already do).
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

Which individual **messages** have already been forwarded is tracked in the
script's own storage (`PropertiesService`), not by the Gmail label — banks
reuse identical subject lines for every alert, so Gmail groups unrelated
transactions to the same recipient into one growing thread over time, and a
label can only mark a whole thread, not a single message inside it. The
**Logged** label you'll see in Gmail is just a visual "this thread has no
unprocessed messages left" marker; it isn't what decides whether something
gets (re-)sent. A message from a bank/format `api/ingest.js` doesn't recognize
yet is deliberately left untracked instead — it'll keep showing up each run
until that bank's parser is added, rather than silently disappearing. It also
shows up in the app itself under **"Couldn't read from bank"** (amber,
separate from the normal pending queue) with the subject, sender, and a
snippet of the raw email — tap **Add manually** to open the normal
add-expense sheet with that snippet dropped into the notes field so you can
type in the amount/date yourself, or **✕** to dismiss it. Once a bank's format
is added to the parser, that entry clears itself out automatically on the
next run.

**Banks currently parsed:**
- **Meezan Bank** — domestic debit/credit alerts (`Debit Transaction Alert` /
  `Credit Transaction Alert`) and foreign card purchases
  (`International E-Commerce Transaction Alert`).
- **HabibMetro** — RAAST transfers (`HabibMetro Fund Transfer`, sent as two
  emails sharing one Transaction ID, collapsed into a single pending item) and
  IBFT transfers (`HabibMetro Fund Transfer` + a separate
  `Fund Transfer Acknowledgement` email for the *same* transfer — these two
  don't share an id, so an IBFT transfer currently shows up as **two** pending
  cards; just discard the duplicate).
- **HBL** — credit card bill payments (`HBL Mobile | Credit Card Payment`).
  This is the bill payment, not individual card purchases — if HBL ever starts
  alerting on those separately too, logging both would double-count.

**Permanently ignored** (not transactions, never queued): login/session
alerts, OTP emails, and payee add/delete notifications, across all of the
above banks.

If a bank changes its email wording, or you add another bank, the fix is in
`api/ingest.js` — add a new `parseX(subject, body)` function following the same
`{skip, retry, reason}` / `{skip:false, amount, date, time, recipient}` shape as
`parseMeezan`, and chain it into `parseBankEmail`.

### Adding a second person's emails (e.g. your spouse)

Apps Script only has access to the Gmail account it's created inside — it can't
reach into anyone else's inbox. So there's no "add an email address" setting;
each person who wants their bank alerts auto-forwarded needs their **own**
Apps Script project, set up in **their own** Google account, following the
same steps as above:

1. Have them label their own bank alert emails **Banking** in their own Gmail
   (same idea as yours — everything under that label is what gets searched).
2. They sign into **their own** Google account at https://script.google.com →
   New project → paste in `gas/bank-forwarder.gs` (same file, unmodified).
3. Fill in the **same** `INGEST_URL` and the **same** `INGEST_SECRET` you used
   for your own script — both scripts talk to the same `/api/ingest` endpoint,
   so there's nothing new to set up on the Vercel/Upstash side.
4. Run `forwardBankAlerts` once (grants Gmail access on their account), then
   add the same time-driven trigger (every 5 minutes) as before.

Both of your scripts feed the same shared pending queue in the app — right now
there's no indication in a pending card of *whose* email it came from, so
you'll both see everything in "New from bank" and pick the right payer
yourselves during review (which you're already doing manually today). A
natural next step, when you're ready, is adding a `person` field to the
Apps Script payload (e.g. `"Ebrahim"` vs `"Qadr"`) so `api/ingest.js` can
pre-fill the payer on each pending item instead of leaving it to guess/default.

## Reset everything

In the Upstash console → Data Browser → delete the `expenses` key (and `inandout:pending` if you're using bank auto-import).
