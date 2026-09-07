// Vercel serverless function -> manages your recipient -> category rules
// (the "Known recipients" settings sheet in the app). Read by api/classify.js
// so matched recipients skip the Gemini call entirely.
//
// Auth: the same app PIN as everything else the app itself calls (x-pin header).

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const PIN = process.env.APP_PIN || "0101";

const KNOWN_KEY = process.env.KNOWN_KEY || "inandout:known";
const PENDING_KEY = process.env.PENDING_KEY || "inandout:pending";

// Must exactly match the CATEGORIES array at the top of index.html's <script> block.
const CATEGORIES = ["Groceries", "Utilities", "Rent", "Home", "Eating out", "Transport", "Health", "Help/Staff", "Other"];

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

async function getHash(key) {
  const flat = (await redis(["HGETALL", key])) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    try {
      out.push(JSON.parse(flat[i + 1]));
    } catch {
      /* skip malformed row */
    }
  }
  return out;
}

function uid() {
  return "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Re-tag any currently pending item whose recipient matches this rule, right
// now -- rather than waiting for the next scheduled classify.js run. Unlike
// that scheduled run, this overrides an existing (possibly wrong) suggestion,
// since you just told the app the correct answer.
async function retagPending(pattern, category) {
  const p = pattern.toLowerCase();
  const items = await getHash(PENDING_KEY);
  let count = 0;
  for (const item of items) {
    if ((item.recipient || "").toLowerCase().includes(p)) {
      item.suggestedCategory = category;
      await redis(["HSET", PENDING_KEY, item.id, JSON.stringify(item)]);
      count++;
    }
  }
  return count;
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
    if (req.method === "GET") {
      const rules = await getHash(KNOWN_KEY);
      return res.status(200).json(rules);
    }

    if (req.method === "POST") {
      const b = parseBody();
      const pattern = String(b.pattern || "").trim().slice(0, 100);
      const category = String(b.category || "");
      if (!pattern) return res.status(400).json({ error: "pattern required" });
      if (!CATEGORIES.includes(category)) return res.status(400).json({ error: "invalid category" });

      const rule = { id: uid(), pattern, category };
      await redis(["HSET", KNOWN_KEY, rule.id, JSON.stringify(rule)]);
      const retagged = await retagPending(pattern, category);
      return res.status(200).json({ ok: true, rule, retagged });
    }

    if (req.method === "DELETE") {
      const b = parseBody();
      if (!b.id) return res.status(400).json({ error: "id required" });
      await redis(["HDEL", KNOWN_KEY, String(b.id)]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
