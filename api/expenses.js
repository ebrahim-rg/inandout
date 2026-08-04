// Vercel serverless function -> Upstash Redis (REST)
// Env vars required (Vercel > Project > Settings > Environment Variables):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//
// Data model: one Redis HASH called "expenses", field = expense id, value = JSON string.
// Item-level writes mean two phones can add/edit at the same time without clobbering
// each other (unlike storing the whole list in a single key).

// Vercel's Upstash integration injects KV_REST_API_URL / KV_REST_API_TOKEN.
// Upstash's own console calls them UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
// Accept either, so it works however the database was linked.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const PIN = process.env.APP_PIN || "0101"; // must match PIN in index.html

// Namespaced so this app can share a Redis database with other projects
// without their keys colliding with ours.
const KEY = process.env.EXPENSES_KEY || "inandout:expenses";

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
    return res
      .status(500)
      .json({
        error:
          "No Redis credentials. Expected KV_REST_API_URL + KV_REST_API_TOKEN " +
          "(Vercel Upstash integration) or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.",
      });
  }

  // ---- shared PIN gate ----
  if (String(req.headers["x-pin"] || "") !== PIN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const parseBody = () =>
    typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

  try {
    // ---- read all ----
    if (req.method === "GET") {
      const flat = (await redis(["HGETALL", KEY])) || [];
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

    // ---- create / update one ----
    if (req.method === "POST" || req.method === "PUT") {
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

      await redis(["HSET", KEY, clean.id, JSON.stringify(clean)]);
      return res.status(200).json({ ok: true, item: clean });
    }

    // ---- delete one ----
    if (req.method === "DELETE") {
      const b = parseBody();
      if (!b.id) return res.status(400).json({ error: "id required" });
      await redis(["HDEL", KEY, String(b.id)]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
