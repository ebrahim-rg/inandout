// Vercel serverless function -> receives forwarded bank alert emails (via a Gmail
// Apps Script, see gas/bank-forwarder.gs) -> parses them -> Upstash Redis "pending" queue.
//
// Auth: a separate shared secret (x-ingest-secret header), NOT the app PIN — this
// endpoint is hit by the email forwarder, not your phone. Set INGEST_SECRET in Vercel
// and paste the same value into the Apps Script.
//
// Nothing here ever touches the real "expenses" hash. Parsed transactions land in a
// pending queue that index.html surfaces for you to confirm or discard.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const INGEST_SECRET = process.env.INGEST_SECRET;
const PENDING_KEY = process.env.PENDING_KEY || "inandout:pending";

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

// HabibMetro's body format isn't wired up yet — needs a real (redacted) sample
// email to know the field layout. Recognized but deliberately left unhandled so
// the Apps Script keeps retrying it instead of marking it "Logged" and losing it.
function parseHabibMetro(subject) {
  if (!/HabibMetro Fund Transfer/i.test(subject)) return null;
  return { skip: true, retry: true, reason: "HabibMetro parser not implemented yet" };
}

function parseBankEmail(subject, body) {
  return (
    parseMeezan(subject, body) ||
    parseHabibMetro(subject, body) ||
    { skip: true, retry: true, reason: "unrecognized sender/subject" }
  );
}

// Deterministic id from the transaction's own fields, so re-forwarding the same
// email twice (e.g. a re-run of the Apps Script) overwrites rather than duplicates.
function makeId(p) {
  const raw = `${p.date}|${p.time}|${p.amount}|${p.recipient}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0;
  return "e" + Math.abs(h).toString(36);
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

    const parsed = parseBankEmail(subject, body);
    if (parsed.skip) {
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
    return res.status(200).json({ ok: true, item });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
