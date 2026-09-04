/*
 * Gmail Apps Script — forwards Meezan Bank debit-alert emails to the app's
 * /api/ingest endpoint, where they land in a "pending" queue for review inside
 * the app (never written straight into your real expense list).
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
 *   5. Done — new debit alerts get picked up within 5 minutes and show up in
 *      the app as "New from bank" for you to confirm or discard.
 */

const INGEST_URL = "https://inandout-ten.vercel.app/api/ingest";
const INGEST_SECRET = "PASTE_THE_SAME_VALUE_AS_VERCEL_INGEST_SECRET";

// Narrow this further with e.g. 'from:(alerts@meezanbank.com)' once you've
// confirmed the sender address (open a bank email -> ⋮ -> "Show original").
const QUERY = 'subject:"Transaction Alert" -label:bank-forwarded';
const DONE_LABEL = "bank-forwarded";

function forwardBankAlerts() {
  const label = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  const threads = GmailApp.search(QUERY, 0, 20);

  threads.forEach(thread => {
    const messages = thread.getMessages();
    let allOk = true;

    messages.forEach(msg => {
      const payload = {
        subject: msg.getSubject(),
        body: msg.getPlainBody(),
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
          allOk = false;
        }
      } catch (e) {
        Logger.log("ingest error: " + e);
        allOk = false;
      }
    });

    // only mark done if every message in the thread posted successfully,
    // so a transient failure gets retried on the next run instead of being lost
    if (allOk) thread.addLabel(label);
  });
}
