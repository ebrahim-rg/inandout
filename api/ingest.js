// Vercel serverless function -> receives forwarded bank alert emails (via a Gmail
// Apps Script, see gas/bank-forwarder.gs) -> parses them -> Upstash Redis "pending" queue.
//
// Auth: a separate shared secret (x-ingest-secret header), NOT the app PIN — this
// endpoint is hit by the email forwarder, not your phone. Set INGEST_SECRET in Vercel
// and paste the same value into the Apps Script.
//
// Nothing here ever touches the real "expenses" hash. Parsed transactions land in a
// pending queue that index.html surfaces for you to confirm or discard. An email we
// couldn't parse at all (retry:true — new bank, changed format, etc) lands in a
// separate "unparsed" queue instead, so it's visible in the app rather than only in
// the Apps Script execution log.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const INGEST_SECRET = process.env.INGEST_SECRET;
const PENDING_KEY = process.env.PENDING_KEY || "inandout:pending";
const UNPARSED_KEY = process.env.UNPARSED_KEY || "inandout:unparsed";

async function redis(command) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `Upstash ${r.status}`);
  return j.result;
}

const MONTHS = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

// Each parser returns:
//   null                          -> not this bank's format, try the next one
//   { skip: true, retry, reason } -> recognized, but nothing to queue
//       retry:false = by design (e.g. money received, not an expense) — Logged forever
//       retry:true  = recognized sender but this parser doesn't handle it yet —
//                      left unlabelled in Gmail so it's retried once handled
//   { skip: false, amount, date, time, recipient } -> queue it

// Meezan Bank debit alerts come in two body shapes:
//   "...Beneficiary Account : NAME-CHANNEL-xxxBANK..."
//   "...sent to NAME (ASAAN AC) (BANK AC on account..."
// Only debit ("money sent") alerts are expenses — credit/received alerts are ignored.
function parseMeezan(subject, body) {
  const isDebit = /Debit Transaction Alert/i.test(subject);
  const isCredit = /Credit Transaction Alert/i.test(subject);
  if (!isDebit && !isCredit) return null;

  if (isCredit) return { skip: true, retry: false, reason: "Meezan credit alert (money received, not an expense)" };

  const amountMatch = body.match(/PKR\s*([\d,]+\.\d{2})/i);
  if (!amountMatch) return { skip: true, retry: false, reason: "Meezan debit alert but no amount found" };

  const dateMatch = body.match(/Transaction Date\s*:\s*(\d{2})-([A-Za-z]{3})-(\d{4})/i);
  const timeMatch = body.match(/Transaction Time\s*:\s*(\d{2}:\d{2})/i);

  let recipient = "";
  let m = body.match(/Beneficiary Account\s*:\s*([^\n]+)/i);
  if (m) recipient = m[1].split(/[-.]/)[0].trim();
  else {
    m = body.match(/sent to\s+([^(\n]+)\(/i);
    if (m) recipient = m[1].trim();
  }

  return {
    skip: false,
    amount: parseFloat(amountMatch[1].replace(/,/g, "")),
    date: dateMatch ? `${dateMatch[3]}-${MONTHS[dateMatch[2]] || "01"}-${dateMatch[1]}` : "",
    time: timeMatch ? timeMatch[1] : "",
    recipient,
  };
}

// Meezan foreign card purchases (subject differs from the domestic debit alert).
// Uses "PKR Amount" (the converted total before extra fees) rather than
// "Original Transaction Amount" (pre-conversion, in the original currency's PKR
// equivalent) — close enough for a household tracker; the international fee
// components on top of it are small and editable by hand during review anyway.
function parseMeezanIntl(subject, body) {
  if (!/International E-Commerce Transaction Alert/i.test(subject)) return null;

  const flat = body.replace(/\s+/g, " ").trim();
  const dtM = flat.match(/Transaction Date Time:\s*(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}:\d{2})/i);
  const merchM = flat.match(/Merchant Name\/Country:\s*(.+?)\s+Original Transaction Amount:/i);
  const amtM = flat.match(/PKR Amount:\s*PKR\s*([\d,]+\.\d{2})/i);

  if (!dtM || !amtM) {
    return { skip: true, retry: true, reason: "International E-Commerce alert but body format not recognized" };
  }

  return {
    skip: false,
    amount: parseFloat(amtM[1].replace(/,/g, "")),
    date: `${dtM[3]}-${MONTHS[dtM[2]] || "01"}-${dtM[1]}`,
    time: dtM[4],
    recipient: merchM ? merchM[1].trim() : "",
  };
}

// HabibMetro sends TWO emails per transaction, both subject "HabibMetro Fund
// Transfer" — a short SMS-style one and a detailed one — but both carry the same
// Tx ID / Transaction ID, which we use as the dedup key (see makeId) so they
// collapse into a single pending item instead of showing up twice.
function parseHabibMetro(subject, body) {
  if (!/HabibMetro Fund Transfer/i.test(subject)) return null;

  // HabibMetro's plain-text body wraps key values in literal *asterisks* (kept
  // bold markdown) and hard-wraps mid-phrase (e.g. "from" and "your" split
  // across a line break) — normalize before matching against either shape.
  const flat = body.replace(/\*/g, "").replace(/\s+/g, " ").trim();

  // Detailed form:
  //   "... PKR 100000.000 has been sent to NAME Meezan Bank from your HMB
  //    Account *0677. Transaction ID: MPBL... Date & Time: 2026-09-03 14:03:35.44 ..."
  let m = flat.match(/PKR\s*([\d,]+\.?\d*)\s+has been sent to\s+(.+?)\s+from your HMB Account/i);
  if (m) {
    const txid = (flat.match(/Transaction ID:\s*(\S+)/i) || [])[1] || "";
    const dt = flat.match(/Date\s*&\s*Time:\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})/i);
    return {
      skip: false,
      amount: parseFloat(m[1].replace(/,/g, "")),
      date: dt ? `${dt[1]}-${dt[2]}-${dt[3]}` : "",
      time: dt ? dt[4] : "",
      recipient: m[2].trim(),
      txid,
    };
  }

  // Short form:
  //   "PKR 900.00 sent to NAME from your HMB A/C *0677 on 02-Sep-2026 15:11 via RAAST Tx ID MPBL..."
  m = flat.match(/PKR\s*([\d,]+\.?\d*)\s+sent to\s+(.+?)\s+from your HMB A\/C.*?\bon\s+(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}:\d{2})\s+via RAAST Tx ID\s+(\S+)/i);
  if (m) {
    return {
      skip: false,
      amount: parseFloat(m[1].replace(/,/g, "")),
      date: `${m[5]}-${MONTHS[m[4]] || "01"}-${m[3]}`,
      time: m[6],
      recipient: m[2].trim(),
      txid: m[7].replace(/\.$/, ""),
    };
  }

  // IBFT form (no beneficiary name, just account number + title):
  //   "Funds of PKR 3000.000 have been transferred to A/C 6-99-3-29308-714-131228
  //    (Title:UNSA ARIF) on 2026-08-25 15:08:02.217. via IBFT"
  m = flat.match(/Funds of PKR\s*([\d,]+\.?\d*)\s+have been transferred to\s+A\/C\s+([\d-]+)\s*\(Title:\s*([^)]+)\)\s+on\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})/i);
  if (m) {
    return {
      skip: false,
      amount: parseFloat(m[1].replace(/,/g, "")),
      date: `${m[4]}-${m[5]}-${m[6]}`,
      time: m[7],
      recipient: `${m[3].trim()} (A/C ${m[2]})`,
      txid: "", // not present in this alert — falls back to date|time|amount|recipient dedup key
    };
  }

  return { skip: true, retry: true, reason: "HabibMetro Fund Transfer but body format not recognized" };
}

// HabibMetro's IBFT rail sends the transfer confirmation under a DIFFERENT
// subject ("Fund Transfer Acknowledgement") than the "HabibMetro Fund Transfer"
// email for the same transfer, and neither shares an id with the other — so an
// IBFT transfer will show up as two separate pending items. Discard whichever
// duplicate shows up second; not worth the complexity of correlating them.
function parseHabibMetroAck(subject, body) {
  if (!/Fund Transfer Acknowledgement/i.test(subject)) return null;

  const flat = body.replace(/\*/g, "").replace(/\s+/g, " ").trim();
  const amtM = flat.match(/Amount Transferred\s*:\s*PKR\s*([\d,]+\.?\d*)/i);
  const dtM = flat.match(/Date\s*&\s*Time\s*:\s*([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{2}:\d{2})/i);
  const toM = flat.match(/To Account Title\s*:\s*(.+?)\s+Thank you/i);
  const reqM = flat.match(/Request#\s*:\s*(\S+)/i);

  if (!amtM || !dtM) {
    return { skip: true, retry: true, reason: "Fund Transfer Acknowledgement but body format not recognized" };
  }

  return {
    skip: false,
    amount: parseFloat(amtM[1].replace(/,/g, "")),
    date: `${dtM[3]}-${MONTHS[dtM[1]] || "01"}-${String(dtM[2]).padStart(2, "0")}`,
    time: dtM[4],
    recipient: toM ? toM[1].trim() : "",
    txid: reqM ? `hmreq:${reqM[1]}` : "",
  };
}

// HBL credit card BILL payments (paying off the card balance through the app),
// not individual card purchases. If HBL also alerts on each purchase
// separately, logging this too would double-count — no such alert seen yet,
// so it's wired up; discard it during review if it turns out to be a dupe.
function parseHBL(subject, body) {
  if (!/HBL Mobile\s*\|\s*Credit Card Payment/i.test(subject)) return null;

  const flat = body.replace(/\s+/g, " ").trim();
  const m = flat.match(/CreditCard Bill Payment of PKR\s*([\d,]+\.?\d*)\s+for Card #\s*(\S+)\s+has been made successfully through HBL Mobile on\s+(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}:\d{2})/i);

  if (!m) {
    return { skip: true, retry: true, reason: "HBL Credit Card Payment but body format not recognized" };
  }

  const last4 = (m[2].match(/(\d{4})$/) || [])[1] || m[2];
  return {
    skip: false,
    amount: parseFloat(m[1].replace(/,/g, "")),
    date: `${m[5]}-${MONTHS[m[4]] || "01"}-${m[3]}`,
    time: m[6],
    recipient: `HBL Credit Card Bill (••${last4})`,
    txid: "",
  };
}

// Login / session / OTP / account-management notifications aren't
// transactions — ignore permanently rather than retrying forever. Matches
// "Login Alert", "Log In Alert", "| Login", "One-Time password to confirm
// your operation", "Domestic Payee Deletion Alert", etc.
const NOISE_SUBJECT_PATTERNS = [/log\s?in/i, /one-time password/i, /\botp\b/i, /payee (addition|deletion)/i];
function isNoiseSubject(subject) {
  return NOISE_SUBJECT_PATTERNS.some(re => re.test(subject || ""));
}

function parseBankEmail(subject, body) {
  if (isNoiseSubject(subject)) {
    return { skip: true, retry: false, reason: "login/OTP/session notification, not a transaction" };
  }
  return (
    parseMeezan(subject, body) ||
    parseMeezanIntl(subject, body) ||
    parseHabibMetro(subject, body) ||
    parseHabibMetroAck(subject, body) ||
    parseHBL(subject, body) ||
    { skip: true, retry: true, reason: "unrecognized sender/subject" }
  );
}

// Deterministic id from the transaction's own fields, so re-forwarding the same
// email twice (e.g. a re-run of the Apps Script) overwrites rather than duplicates.
// Prefer the bank's own transaction id when we have one (HabibMetro sends two
// emails per transfer with the same Tx ID — this collapses them into one item).
function makeId(p) {
  const raw = p.txid ? `txid:${p.txid}` : `${p.date}|${p.time}|${p.amount}|${p.recipient}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0;
  return "e" + Math.abs(h).toString(36);
}

// Deterministic id for an unparsed email too, so the same still-unhandled
// email (re-forwarded every 5 minutes until its parser exists or it's
// discarded) overwrites its own entry instead of piling up duplicates.
function makeUnparsedId(from, subject, body) {
  const raw = `${from}|${subject}|${body.slice(0, 200)}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0;
  return "u" + Math.abs(h).toString(36);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: "No Redis credentials." });
  }
  if (!INGEST_SECRET) {
    return res.status(500).json({ error: "INGEST_SECRET not configured on the server." });
  }
  if (String(req.headers["x-ingest-secret"] || "") !== INGEST_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const subject = String(b.subject || "").slice(0, 200);
    const body = String(b.body || "").slice(0, 5000);
    const from = String(b.from || "").slice(0, 200);

    const parsed = parseBankEmail(subject, body);
    const unparsedId = makeUnparsedId(from, subject, body);

    if (parsed.skip) {
      if (parsed.retry) {
        // genuinely unhandled (new bank, changed format, etc) — surface it in
        // the app instead of only the Apps Script log
        await redis([
          "HSET",
          UNPARSED_KEY,
          unparsedId,
          JSON.stringify({
            id: unparsedId,
            subject,
            from,
            snippet: body.slice(0, 400),
            reason: parsed.reason,
            ts: Date.now(),
          }),
        ]);
      } else {
        // by-design permanent ignore (login/OTP/credit alert/etc) — clear any
        // stale unparsed entry from before this became a recognized noise pattern
        await redis(["HDEL", UNPARSED_KEY, unparsedId]);
      }
      return res.status(200).json({ ok: true, skipped: true, retry: parsed.retry, reason: parsed.reason });
    }

    const id = makeId(parsed);
    const item = {
      id,
      amount: parsed.amount,
      date: parsed.date,
      recipient: parsed.recipient,
      subject,
      ts: Date.now(),
    };

    await redis(["HSET", PENDING_KEY, id, JSON.stringify(item)]);
    // clear any stale unparsed entry for this same email (e.g. a parser was
    // just added for a format that used to fail)
    await redis(["HDEL", UNPARSED_KEY, unparsedId]);
    return res.status(200).json({ ok: true, item });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
