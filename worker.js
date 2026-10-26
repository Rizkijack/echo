// echo Worker: serves the static site (Workers Static Assets) and proxies
// /api/chat to Reflection Beam. The provider key lives ONLY in the
// REFLECTION_API_KEY Worker secret — never in the repo or frontend.
//
// Daily credit quota: every user (wallet address via x-echo-wallet header,
// otherwise SHA-256 of IP) gets 2 credits/day where 1 credit = 1,000,000
// tokens. Usage per UTC day is tracked in the CREDITS KV namespace;
// keys are auto-expiring (2-day TTL) so the quota resets daily and old
// keys clean up themselves.
const UPSTREAM = "https://api.reflection.ai/openai/v1/chat/completions";
const MODEL = "Beam-1.0-501B-A23B";
const SYSTEM_PROMPT = "You are echo, a helpful AI assistant.";
const TOKENS_PER_CREDIT = 1_000_000;
const DAILY_CREDIT_LIMIT = 2 * TOKENS_PER_CREDIT; // 2 credit = 2 juta token/hari

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

// Beam is a reasoning model: every earlier assistant message MUST carry the
// reasoning_content returned with it, or the provider rejects the request
// (400 missing_required_parameter). Assistant turns without one (pre-fix
// chats, simulated fallbacks) are dropped so the conversation can recover
// instead of failing forever.
function cleanMessages(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const m of input) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content.slice(0, 4000) });
    } else if (
      m.role === "assistant" &&
      typeof m.reasoning_content === "string" &&
      m.reasoning_content
    ) {
      out.push({
        role: "assistant",
        content: m.content.slice(0, 4000),
        reasoning_content: m.reasoning_content,
      });
    }
  }
  return out.slice(-20);
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- identitas + kuota harian (KV) ----------
function utcDay() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

async function userIdentity(request) {
  // Wallet address valid = identitas kuat. Selain itu: hash IP (bukan PII
  // mentah). Header x-echo-wallet hanya di-format-check; spoofing alamat
  // artinya menukar kuota, bukan free-limit — signature (SIWE) bisa jadi
  // hardening lanjutan.
  const wallet = (request.headers.get("x-echo-wallet") || "").trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(wallet)) return "w:" + wallet;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("echo-quota:" + ip)
  );
  const hex = [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "i:" + hex;
}

function quotaKey(id) {
  return `q:${id}:${utcDay()}`;
}

// KV juga dipakai untuk /api/credits; guard env.CREDITS supaya local
// preview (node server.js / tanpa binding) tetap jalan tanpa kuota.
async function readUsage(env, id) {
  if (!env.CREDITS) return { tokens: 0, chats: 0, enforced: false };
  let rec;
  try {
    rec = await env.CREDITS.get(quotaKey(id), "json");
  } catch {
    rec = null;
  }
  const r = rec && typeof rec === "object" ? rec : {};
  return {
    tokens: Number(r.tokens) || 0,
    chats: Number(r.chats) || 0,
    enforced: true,
  };
}

async function addUsage(env, id, tokens) {
  if (!env.CREDITS) return;
  const prev = await readUsage(env, id);
  const next = { tokens: prev.tokens + tokens, chats: prev.chats + 1 };
  try {
    await env.CREDITS.put(quotaKey(id), JSON.stringify(next), {
      expirationTtl: 2 * 24 * 60 * 60, // cleanup otomatis, kuota reset via tanggal di key
    });
  } catch {
    // best-effort: jangan gagalkan reply karena KV down
  }
}

async function handleCredits(request, env) {
  const id = await userIdentity(request);
  const usage = await readUsage(env, id);
  return jsonResponse(
    {
      id_type: id.slice(0, 2) === "w:" ? "wallet" : "ip",
      date: utcDay(),
      credits_limit: DAILY_CREDIT_LIMIT / TOKENS_PER_CREDIT, // 2
      tokens_limit: DAILY_CREDIT_LIMIT,
      tokens_used: usage.tokens,
      chats: usage.chats,
      credits_used: usage.tokens / TOKENS_PER_CREDIT,
      enforced: usage.enforced,
    },
    200
  );
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
  // Kuota harian: cek sebelum memanggil provider.
  const uid = await userIdentity(request);
  const prevUsage = await readUsage(env, uid);
  if (prevUsage.enforced && prevUsage.tokens >= DAILY_CREDIT_LIMIT) {
    return jsonResponse(
      {
        error:
          "Daily credit limit reached (2 credits = 2 million tokens). Connect a wallet or top up on the dashboard.",
        code: "credit_exhausted",
        tokens_used: prevUsage.tokens,
        tokens_limit: DAILY_CREDIT_LIMIT,
      },
      402
    );
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
  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
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
  } catch {
    return jsonResponse({ error: "Provider error" }, 502);
  }
  if (!upstream.ok) {
    return jsonResponse({ error: "Provider error" }, 502);
  }
  let data;
  try {
    data = await upstream.json();
  } catch {
    return jsonResponse({ error: "Provider error" }, 502);
  }
  // Pemakaian token = field usage resmi provider; fallback estimasi kasar
  // karakter/4 kalau field tidak ada, jadi kuota tetap dicoret.
  const usageTokens =
    data && data.usage && Number(data.usage.total_tokens)
      ? Number(data.usage.total_tokens)
      : Math.ceil((JSON.stringify(data).length || 0) / 4);
  await addUsage(env, uid, usageTokens);
  const msg =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message
      : null;
  const reply = msg ? msg.content : "";
  if (typeof reply !== "string" || !reply) {
    return jsonResponse({ error: "Empty provider reply" }, 502);
  }
  const resp = { reply };
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
    resp.reasoning_content = msg.reasoning_content;
  }
  return jsonResponse(resp, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat") {
      return handleChat(request, env);
    }
    if (url.pathname === "/api/credits") {
      return handleCredits(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
