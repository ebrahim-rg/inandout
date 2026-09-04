/*
 * Gmail Apps Script — forwards bank alert emails to the app's /api/ingest
 * endpoint, where they land in a "pending" queue for review inside the app
 * (never written straight into your real expense list).
 *
 * Scope: only emails already under your "Banking" Gmail label are ever
 * touched — nothing else in your inbox is read or searched.
 *
 * Setup:
 *   1. https://script.google.com -> New project -> paste this whole file in,
 *      replacing the default Code.gs content.
 *   2. Fill in INGEST_URL and INGEST_SECRET below (the secret must match the
 *      INGEST_SECRET env var set in Vercel).
 *   3. Run > forwardBankAlerts once, and grant it Gmail access when prompted.
 *   4. Left sidebar -> Triggers (clock icon) -> Add Trigger:
 *        Function: forwardBankAlerts
 *        Event source: Time-driven
 *        Type: Minutes timer, every 5 minutes
 *   5. Done — new alerts get picked up within 5 minutes and show up in the
 *      app as "New from bank" for you to confirm or discard.
 *
 * Each processed email gets labelled "Logged" so it's not re-sent on the next
 * run — except a bank/format api/ingest.js doesn't recognize yet, which is
 * deliberately left unlabelled so it gets retried automatically once that
 * bank's parser is added, instead of silently getting lost. Unrecognized ones
 * also show up right in the app under "Couldn't read from bank" so you don't
 * have to check this script's execution log to notice — you can add them by
 * hand from there, or dismiss them.
 */

const INGEST_URL = "https://inandout-ten.vercel.app/api/ingest";
const INGEST_SECRET = "PASTE_THE_SAME_VALUE_AS_VERCEL_INGEST_SECRET";

// after: bounds this permanently, on every run (manual or scheduled) — without
// it, the very first run treats your ENTIRE Banking-labelled history as
// unprocessed (nothing was "Logged" yet), backfilling months of old real
// transactions in one go. Move this date forward if you ever want to skip
// past even more old mail; it never needs to move backward.
const QUERY = "label:Banking -label:Logged after:2026/09/01";
const DONE_LABEL = "Logged";

function forwardBankAlerts() {
  const label = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  const threads = GmailApp.search(QUERY, 0, 20);

  threads.forEach(thread => {
    const messages = thread.getMessages();
    let shouldLabel = true; // false = leave unlabelled so it's retried next run

    messages.forEach(msg => {
      const payload = {
        subject: msg.getSubject(),
        body: msg.getPlainBody(),
        from: msg.getFrom(),
      };
      try {
        const resp = UrlFetchApp.fetch(INGEST_URL, {
          method: "post",
          contentType: "application/json",
          headers: { "x-ingest-secret": INGEST_SECRET },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
        });
        if (resp.getResponseCode() >= 300) {
          Logger.log("ingest failed (%s): %s", resp.getResponseCode(), resp.getContentText());
          shouldLabel = false;
          return;
        }
        const json = JSON.parse(resp.getContentText() || "{}");
        if (json.skipped && json.retry) {
          Logger.log(
            "not handled yet, will retry later: %s | from: %s | subject: %s",
            json.reason, msg.getFrom(), msg.getSubject()
          );
          // always log a snippet for anything not yet handled, so a brand new
          // subject/format from a bank shows its own body here on the next run
          // instead of needing another manual copy-paste from the user
          Logger.log("body snippet: %s", payload.body.slice(0, 500));
          shouldLabel = false;
        }
      } catch (e) {
        Logger.log("ingest error: " + e);
        shouldLabel = false;
      }
    });

    if (shouldLabel) thread.addLabel(label);
  });
}
