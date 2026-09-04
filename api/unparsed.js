// Vercel serverless function -> read/discard the "unparsed" queue: bank alert
// emails api/ingest.js couldn't understand (new bank, changed format, etc).
//
// Auth: the same app PIN as api/expenses.js and api/pending.js (x-pin header) —
// this one is called from index.html, not the email forwarder.
//
// There's no "confirm" here like api/pending.js has — an unparsed item has no
// amount/date/recipient to prefill, so index.html just opens the normal blank
// add-expense sheet (with the raw snippet dropped into the notes field) and
// lets you type it in yourself. Saving that expense also discards this entry.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const PIN = process.env.APP_PIN || "0101";
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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: "No Redis credentials." });
  }
  if (String(req.headers["x-pin"] || "") !== PIN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    if (req.method === "GET") {
      const flat = (await redis(["HGETALL", UNPARSED_KEY])) || [];
      const out = [];
      for (let i = 0; i < flat.length; i += 2) {
        try {
          out.push(JSON.parse(flat[i + 1]));
        } catch {
          /* skip malformed row */
        }
      }
      return res.status(200).json(out);
    }

    if (req.method === "DELETE") {
      const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      if (!b.id) return res.status(400).json({ error: "id required" });
      await redis(["HDEL", UNPARSED_KEY, String(b.id)]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
