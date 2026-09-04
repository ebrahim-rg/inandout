// Vercel serverless function -> read/resolve the "pending" queue of auto-detected
// bank transactions (populated by api/ingest.js).
//
// Auth: the same app PIN as api/expenses.js (x-pin header) — this one is called
// from index.html, not the email forwarder.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const PIN = process.env.APP_PIN || "0101";

const PENDING_KEY = process.env.PENDING_KEY || "inandout:pending";
const EXPENSES_KEY = process.env.EXPENSES_KEY || "inandout:expenses";

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

  const parseBody = () =>
    typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

  try {
    // ---- list pending items ----
    if (req.method === "GET") {
      const flat = (await redis(["HGETALL", PENDING_KEY])) || [];
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

    // ---- confirm: write the reviewed item into real expenses, then drop it from pending ----
    if (req.method === "POST") {
      const b = parseBody();
      if (!b.id) return res.status(400).json({ error: "id required" });

      const clean = {
        id: String(b.id).slice(0, 40),
        amount: Number(b.amount) || 0,
        item: String(b.item || "").slice(0, 200),
        payer: String(b.payer || "").slice(0, 60),
        category: String(b.category || "").slice(0, 60),
        date: String(b.date || "").slice(0, 10),
        note: String(b.note || "").slice(0, 1000),
        ts: Number(b.ts) || Date.now(),
      };

      await redis(["HSET", EXPENSES_KEY, clean.id, JSON.stringify(clean)]);
      await redis(["HDEL", PENDING_KEY, clean.id]);
      return res.status(200).json({ ok: true, item: clean });
    }

    // ---- discard a pending item without adding it as an expense ----
    if (req.method === "DELETE") {
      const b = parseBody();
      if (!b.id) return res.status(400).json({ error: "id required" });
      await redis(["HDEL", PENDING_KEY, String(b.id)]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
