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
 * Per-message tracking, not per-thread: banks reuse identical subject lines
 * for every alert, so Gmail's conversation view groups unrelated transactions
 * to the same recipient into ONE growing thread over time. A Gmail LABEL can
 * only be applied to a whole thread — so if we used "-label:Logged" in the
 * search (like an earlier version of this script did), a brand new message
 * appended to an already-labelled thread would be silently invisible to every
 * future run. Instead, which individual MESSAGES have already been sent to
 * api/ingest is tracked in PropertiesService (a small persistent store tied to
 * this script), keyed by each message's own id — independent of thread state.
 * The "Logged" label is still applied when every message in a thread is done,
 * but purely as a visual marker in Gmail; it plays no part in the skip logic.
 *
 * Unrecognized formats are deliberately left unmarked-processed so they're
 * retried automatically once that bank's parser is added, instead of being
 * silently lost. They also show up right in the app under "Couldn't read from
 * bank" so you don't have to check this script's execution log to notice —
 * you can add them by hand from there, or dismiss them.
 */

const INGEST_URL = "https://inandout-ten.vercel.app/api/ingest";
const INGEST_SECRET = "PASTE_THE_SAME_VALUE_AS_VERCEL_INGEST_SECRET";

// after: bounds this permanently, on every run (manual or scheduled) — without
// it, the very first run treats your ENTIRE Banking-labelled history as
// unprocessed, backfilling months of old real transactions in one go. Move
// this date forward if you ever want to skip past even more old mail; it
// never needs to move backward.
const QUERY = "label:Banking after:2026/09/01";
const DONE_LABEL = "Logged"; // cosmetic only now — see note above
const PROCESSED_PROP = "processedMessageIds";
const KEEP_DAYS = 180; // prune tracking older than this so it doesn't grow forever

function loadProcessed() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROCESSED_PROP);
  return raw ? JSON.parse(raw) : {}; // { messageId: isoDateString }
}

function saveProcessed(map) {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const pruned = {};
  for (const id in map) {
    if (new Date(map[id]).getTime() >= cutoff) pruned[id] = map[id];
  }
  PropertiesService.getScriptProperties().setProperty(PROCESSED_PROP, JSON.stringify(pruned));
}

function forwardBankAlerts() {
  const label = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  const processed = loadProcessed();
  const threads = GmailApp.search(QUERY, 0, 20);

  threads.forEach(thread => {
    const messages = thread.getMessages();
    let allDone = true;

    messages.forEach(msg => {
      const id = msg.getId();
      if (processed[id]) return; // this specific message was already handled

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
          allDone = false;
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
          allDone = false;
          return; // NOT marked processed — retried again next run
        }
        // successfully queued, or permanently ignored by design (login/OTP/
        // credit alert/etc) — this message is done either way
        processed[id] = msg.getDate().toISOString();
      } catch (e) {
        Logger.log("ingest error: " + e);
        allDone = false;
      }
    });

    if (allDone) thread.addLabel(label);
  });

  saveProcessed(processed);
}
