// /api/chat — thin proxy from the echo site to Reflection Beam.
// Runs as a Vercel Serverless Function. The provider API key lives ONLY in
// the REFLECTION_API_KEY environment variable — never in the repo or frontend.
const UPSTREAM = "https://api.reflection.ai/openai/v1/chat/completions";
const MODEL = "Beam-1.0-501B-A23B";
const SYSTEM_PROMPT = "You are echo, a helpful AI assistant.";

// Best-effort per-IP rate limit (per-instance memory; Vercel functions are stateless).
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 30;
const hits = new Map(); // ip -> array of timestamps

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) return true;
  list.push(now);
  hits.set(ip, list);
  return false;
}

function cleanMessages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (m) =>
        m &&
        typeof m.content === "string" &&
        (m.role === "user" || m.role === "assistant")
    )
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const key = process.env.REFLECTION_API_KEY;
    if (!key) {
      return res.status(503).json({ error: "AI proxy not configured" });
    }
    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      (req.socket && req.socket.remoteAddress) ||
      "unknown";
    if (rateLimited(ip)) {
      return res.status(429).json({ error: "Too many requests, try again shortly" });
    }
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    const messages = cleanMessages(body && body.messages);
    if (!messages.length || messages[messages.length - 1].role !== "user") {
      return res.status(400).json({ error: "A user message is required" });
    }
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      }),
    });
    if (!upstream.ok) {
      return res.status(502).json({ error: "Provider error" });
    }
    const data = await upstream.json();
    const reply =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : "";
    if (typeof reply !== "string" || !reply) {
      return res.status(502).json({ error: "Empty provider reply" });
    }
    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: "Proxy failed" });
  }
};
