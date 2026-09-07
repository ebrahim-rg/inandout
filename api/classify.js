// Vercel serverless function -> classifies pending bank transactions using
// Google's Gemini API (free tier, gemini-3.5-flash-lite) -> writes a suggested
// category + a short item title back onto each pending item, for pre-filling
// during Review in the app. Never writes to the real expenses hash directly.
//
// Auth: triggered by Vercel Cron (see vercel.json), which automatically sends
// "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set as an env var.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const PENDING_KEY = process.env.PENDING_KEY || "inandout:pending";

// Must exactly match the CATEGORIES array at the top of index.html's <script> block.
const CATEGORIES = ["Groceries", "Utilities", "Rent", "Home", "Eating out", "Transport", "Health", "Help/Staff", "Other"];

// ---- Known recipients — edit this freely, nothing else needs to change ----
// Checked BEFORE the model, and wins outright: no reason to ask an LLM to guess
// something you already know for certain. Key is matched as a case-insensitive
// substring against the parsed recipient string, so partial names are fine.
const KNOWN_RECIPIENTS = {
  // "yousuf": { category: "Help/Staff", item: "Yousuf (house help)" },
};

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

function matchKnown(recipient) {
  const r = (recipient || "").toLowerCase().trim();
  if (!r) return null;
  for (const [key, val] of Object.entries(KNOWN_RECIPIENTS)) {
    if (r.includes(key.toLowerCase())) return val;
  }
  return null;
}

function buildRequest(items) {
  const system =
    "You are categorizing household bank transactions for a Pakistani couple's shared " +
    "expense tracker. For each transaction, pick exactly one category from the fixed " +
    "list, and write a short 3-6 word title suitable as an expense description. " +
    "Recipient strings may be personal names, shop/merchant names, or mobile wallet " +
    "channels (JazzCash, EasyPaisa, NayaPay) common in Pakistan. A personal name with " +
    "no business indicator is usually an informal transfer -- use Help/Staff if it " +
    "reads like household staff (guard, driver, cook, cleaner, gardener, maid), " +
    "otherwise Other.";

  const userText =
    "Classify these transactions:\n" +
    JSON.stringify(items.map(x => ({ id: x.id, recipient: x.recipient || "", amount: x.amount })));

  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            category: { type: "string", enum: CATEGORIES },
            item: { type: "string" },
          },
          required: ["id", "category", "item"],
        },
      },
    },
  };
}

async function callGemini(items) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRequest(items)),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `Gemini ${r.status}`);
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content");
  return JSON.parse(text);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: "No Redis credentials." });
  }
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured." });
  }
  if (CRON_SECRET && req.headers["authorization"] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const flat = (await redis(["HGETALL", PENDING_KEY])) || [];
    const items = [];
    for (let i = 0; i < flat.length; i += 2) {
      try {
        items.push(JSON.parse(flat[i + 1]));
      } catch {
        /* skip malformed row */
      }
    }

    const unclassified = items.filter(x => !x.suggestedCategory);
    if (!unclassified.length) {
      return res.status(200).json({ ok: true, classified: 0, byKnown: 0, byModel: 0 });
    }

    let byKnown = 0;
    let byModel = 0;
    const stillUnknown = [];

    for (const item of unclassified) {
      const known = matchKnown(item.recipient);
      if (known) {
        item.suggestedCategory = known.category;
        item.suggestedItem = known.item;
        await redis(["HSET", PENDING_KEY, item.id, JSON.stringify(item)]);
        byKnown++;
      } else {
        stillUnknown.push(item);
      }
    }

    if (stillUnknown.length) {
      const results = await callGemini(stillUnknown);
      const byId = Object.fromEntries(stillUnknown.map(x => [x.id, x]));
      for (const r of results) {
        const item = byId[r.id];
        if (!item) continue; // stale/unrecognized id, ignore
        if (!CATEGORIES.includes(r.category)) continue; // defensive; schema should already guarantee this
        item.suggestedCategory = r.category;
        item.suggestedItem = String(r.item || "").slice(0, 200);
        await redis(["HSET", PENDING_KEY, item.id, JSON.stringify(item)]);
        byModel++;
      }
    }

    return res.status(200).json({ ok: true, classified: byKnown + byModel, byKnown, byModel });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
