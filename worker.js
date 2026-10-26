// echo Worker: serves the static site (Workers Static Assets) and proxies
// /api/chat to Reflection Beam. The provider key lives ONLY in the
// REFLECTION_API_KEY Worker secret — never in the repo or frontend.
const UPSTREAM = "https://api.reflection.ai/openai/v1/chat/completions";
const MODEL = "Beam-1.0-501B-A23B";
const SYSTEM_PROMPT = "You are echo, a helpful AI assistant.";

// Best-effort per-IP rate limit (per-isolate memory; not shared across edge nodes).
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

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleChat(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  const key = env.REFLECTION_API_KEY;
  if (!key) {
    return jsonResponse({ error: "AI proxy not configured" }, 503);
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(ip)) {
    return jsonResponse({ error: "Too many requests, try again shortly" }, 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const messages = cleanMessages(body && body.messages);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return jsonResponse({ error: "A user message is required" }, 400);
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
    return jsonResponse({ error: "Provider error" }, 502);
  }
  const data = await upstream.json();
  const reply =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  if (typeof reply !== "string" || !reply) {
    return jsonResponse({ error: "Empty provider reply" }, 502);
  }
  return jsonResponse({ reply }, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat") {
      return handleChat(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
