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

// ---------- top-up crypto (pembayaran live) ----------
// Treasury menerima stablecoin langsung; worker memverifikasi tx lewat
// public RPC chain (tanpa pihak ketiga). Bonus credit ke wallet pembayar,
// tidak kedaluwarsa, dipakai setelah kuota gratis harian habis.
const TOPUP_TREASURY = "0x7fc2fbaa14ead97fd9ce150b9d6b8f811d222e1e";
const USD_PER_CREDIT = 0.10; // 10 credit = 1 USD
const MIN_PURCHASE_USD = 0.5;
const TOPUP_TX_TTL = 30 * 24 * 60 * 60; // marker anti double-claim
const TOPUP_CHAINS = {
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    rpc: "https://mainnet.base.org",
    tokens: {
      usdc: { name: "USDC", decimals: 6, contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
    },
  },
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com/",
    tokens: {
      usdg: { name: "USDG", decimals: 6, contract: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" },
    },
  },
};
const TOPUP_PACKAGES = [
  { credits: 50, usd: 5 },
  { credits: 100, usd: 10 },
  { credits: 250, usd: 25 },
];

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
function cleanMessages(input, keepSystem) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const m of input) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content.slice(0, 4000) });
    } else if (keepSystem && m.role === "system") {
      out.push({ role: "system", content: m.content.slice(0, 4000) });
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

// ---------- bonus credit (purchased, non-expiring) ----------
// KV key c:<wallet> = { bonus: tokens }. Bonus hanya untuli wallet
// (identitas IP tidak bisa layanan top-up).
function bonusKey(wallet) {
  return `c:${wallet}`;
}
async function readBonus(env, wallet) {
  if (!env.CREDITS || !wallet) return { bonus: 0, enforced: false };
  let rec;
  try {
    rec = await env.CREDITS.get(bonusKey(wallet), "json");
  } catch {
    rec = null;
  }
  return {
    bonus: rec && Number(rec.bonus) > 0 ? Number(rec.bonus) : 0,
    enforced: true,
  };
}
async function grantBonus(env, wallet, tokens) {
  if (!env.CREDITS || !wallet || tokens <= 0) return;
  const prev = await readBonus(env, wallet);
  const next = { bonus: prev.bonus + tokens };
  try {
    await env.CREDITS.put(bonusKey(wallet), JSON.stringify(next));
  } catch {
    // best-effort
  }
}
// Potong bonus sebesar overflow pemakaian di atas kuota gratis harian.
async function spendBonusTokens(env, wallet, tokens) {
  if (!env.CREDITS || !wallet || tokens <= 0) return;
  const prev = await readBonus(env, wallet);
  const next = { bonus: Math.max(0, prev.bonus - tokens) };
  try {
    await env.CREDITS.put(bonusKey(wallet), JSON.stringify(next));
  } catch {
    // best-effort
  }
}

async function handleCredits(request, env) {
  const id = await userIdentity(request);
  const usage = await readUsage(env, id);
  const wallet = walletIdentity(request);
  const bonusRec = wallet ? await readBonus(env, wallet) : { bonus: 0, enforced: false };
  const bonus = bonusRec.bonus;
  return jsonResponse(
    {
      id_type: id.slice(0, 2) === "w:" ? "wallet" : "ip",
      date: utcDay(),
      credits_limit: DAILY_CREDIT_LIMIT / TOKENS_PER_CREDIT, // gratis harian: 2
      tokens_limit: DAILY_CREDIT_LIMIT,
      tokens_used: usage.tokens,
      chats: usage.chats,
      credits_used: usage.tokens / TOKENS_PER_CREDIT,
      bonus_credits: bonus / TOKENS_PER_CREDIT,
      bonus_tokens: bonus,
      effective_limit: (DAILY_CREDIT_LIMIT + bonus) / TOKENS_PER_CREDIT,
      enforced: usage.enforced,
    },
    200
  );
}

// ---------- chat history (KV, hanya wallet) ----------
// Conv tersimpan full di localStorage browser; endpoint ini menyinkronkan
// salinan wallet (portable antar device). Cap pragmatis agar KV murah:
// 40 message terakhir, 8K karakter/message; 1 conv <= 512 KB; index per
// wallet maksimal 50 entri.
const HIST_MSG_LIMIT = 40;
const HIST_CHAR_LIMIT = 8000;
const HIST_CONV_MAX_BYTES = 512 * 1024;
const HIST_INDEX_LIMIT = 50;

function walletIdentity(request) {
  const wallet = (request.headers.get("x-echo-wallet") || "").trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(wallet)) return wallet;
  return null;
}

function sanitizeHistoryMessages(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const m of input.slice(-HIST_MSG_LIMIT)) {
    if (!m) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = typeof m.content === "string" ? m.content.slice(0, HIST_CHAR_LIMIT) : "";
    if (!content) continue;
    const rec = { role, content };
    if (role === "assistant" && typeof m.reasoning_content === "string" && m.reasoning_content) {
      rec.reasoning_content = m.reasoning_content.slice(0, 4000);
    }
    out.push(rec);
  }
  return out;
}

async function readHistoryIndex(env, wallet) {
  const idx = await env.HISTORY.get(`h:${wallet}:__idx`, "json");
  return Array.isArray(idx) ? idx : [];
}

async function writeHistoryIndex(env, wallet, idx) {
  const cap = idx.slice(0, HIST_INDEX_LIMIT);
  await env.HISTORY.put(`h:${wallet}:__idx`, JSON.stringify(cap));
}

// ---------- stats global (counter agregat, section Numbers home) ----------
async function bumpGlobalStats(env, tokens) {
  if (!env.CREDITS) return;
  let cur;
  try {
    cur = await env.CREDITS.get("g:stats", "json");
  } catch {
    cur = null;
  }
  const s = cur && typeof cur === "object" ? cur : { chats: 0, tokens: 0 };
  try {
    await env.CREDITS.put(
      "g:stats",
      JSON.stringify({
        chats: (Number(s.chats) || 0) + 1,
        tokens: (Number(s.tokens) || 0) + tokens,
      })
    );
  } catch {
    // best-effort
  }
}

async function handleStats(request, env) {
  if (!env.CREDITS) return jsonResponse({ enforced: false }, 503);
  let s;
  try {
    s = await env.CREDITS.get("g:stats", "json");
  } catch {
    s = null;
  }
  s = s && typeof s === "object" ? s : { chats: 0, tokens: 0 };
  const chats = Number(s.chats) || 0;
  const tokens = Number(s.tokens) || 0;
  return jsonResponse(
    {
      chats_total: chats,
      tokens_total: tokens,
      avg_tokens_per_chat: chats ? Math.round(tokens / chats) : 0,
      models_live: 1,
      live_since: "2026-10-26",
      enforced: true,
    },
    200
  );
}

// ---------- top-up crypto ----------
async function handleTopupConfig(request, env) {
  if (!env.CREDITS) return jsonResponse({ error: "Storage not configured" }, 503);
  return jsonResponse(
    {
      treasury: TOPUP_TREASURY,
      usd_per_credit: USD_PER_CREDIT,
      tokens_per_credit: TOKENS_PER_CREDIT,
      min_purchase_usd: MIN_PURCHASE_USD,
      packages: TOPUP_PACKAGES,
      chains: TOPUP_CHAINS,
    },
    200
  );
}

function hexToNumberSafe(hex) {
  try {
    return /^0x[0-9a-fA-F]+$/.test(hex) ? BigInt(hex) : null;
  } catch {
    return null;
  }
}

async function rpcCall(rpc, method, params) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  let j;
  try {
    j = await res.json();
  } catch {
    return { error: "bad rpc response" };
  }
  return j.error ? { error: j.error.message || "rpc error" } : { result: j.result };
}

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function padAddress(addr) {
  return "0x" + addr.toLowerCase().slice(2).padStart(64, "0");
}

async function handleTopupVerify(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  if (!env.CREDITS) return jsonResponse({ error: "Storage not configured" }, 503);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(ip)) {
    return jsonResponse({ error: "Too many requests, try again shortly" }, 429);
  }
  const claimWallet = walletIdentity(request); // dari header x-echo-wallet
  if (!claimWallet) {
    return jsonResponse({ error: "Connect a wallet to top up" }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const chain = TOPUP_CHAINS[String(body.chain || "").toLowerCase()];
  const token = chain && chain.tokens[String(body.token || "").toLowerCase()];
  const txHash = String(body.txHash || "");
  if (!chain || !token) {
    return jsonResponse({ error: "Unknown chain/token" }, 400);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return jsonResponse({ error: "Invalid transaction hash" }, 400);
  }
  const marker = `t:${chain.key}:${txHash.toLowerCase()}`;
  let claimed;
  try {
    claimed = await env.CREDITS.get(marker);
  } catch {
    claimed = null;
  }
  if (claimed) {
    return jsonResponse({ error: "Transaction already claimed", code: "already_claimed" }, 409);
  }

  const receipt = await rpcCall(chain.rpc, "eth_getTransactionReceipt", [txHash]);
  if (receipt.error) {
    return jsonResponse({ error: "Verification RPC failed", detail: receipt.error }, 502);
  }
  if (!receipt.result) {
    return jsonResponse({ error: "Transaction not found yet — it may still be pending", code: "pending" }, 404);
  }
  const rc = receipt.result;
  if (String(rc.status).toLowerCase() !== "0x1") {
    return jsonResponse({ error: "Transaction failed on-chain" }, 400);
  }
  const logs = Array.isArray(rc.logs) ? rc.logs : [];
  const transfer = logs.find(
    (l) =>
      String(l.address).toLowerCase() === token.contract &&
      Array.isArray(l.topics) &&
      (l.topics[0] || "").toLowerCase() === ERC20_TRANSFER_TOPIC &&
      (l.topics[2] || "").toLowerCase() === padAddress(TOPUP_TREASURY)
  );
  if (!transfer) {
    return jsonResponse(
      { error: "No transfer to the echo treasury in this transaction", code: "not_a_payment" },
      400
    );
  }
  const logFrom = "0x" + ((transfer.topics[1] || "").slice(-40) || "");
  if (logFrom.toLowerCase() !== claimWallet) {
    return jsonResponse(
      {
        error:
          "Payment wallet mismatch — this write should be paid from the wallet connected here, and the credits go to the paying wallet.",
        code: "wallet_mismatch",
        payer: logFrom,
      },
      400
    );
  }
  const units = hexToNumberSafe(transfer.data || "0x0");
  if (units === null || units <= 0n) {
    return jsonResponse({ error: "No transfer amount found", code: "no_amount" }, 400);
  }
  const usd = Number(units) / Math.pow(10, token.decimals);
  if (usd < MIN_PURCHASE_USD) {
    return jsonResponse(
      { error: `Minimum purchase is $${MIN_PURCHASE_USD.toFixed(2)}`, code: "too_small", usd },
      400
    );
  }
  const credits = Math.floor(usd / USD_PER_CREDIT); // 10 credits per USD
  const tokensGranted = credits * TOKENS_PER_CREDIT;
  await grantBonus(env, claimWallet, tokensGranted);
  await env.CREDITS.put(
    marker,
    JSON.stringify({ wallet: claimWallet, credits, tokensGranted, at: Date.now() }),
    { expirationTtl: TOPUP_TX_TTL }
  );
  return jsonResponse(
    {
      ok: true,
      wallet: claimWallet,
      usd,
      credits,
      tokens: tokensGranted,
      token: token.name,
      chain: chain.name,
    },
    200
  );
}

async function handleHistoryList(request, env) {
  const wallet = walletIdentity(request);
  if (!wallet) return jsonResponse({ error: "Connect a wallet to sync history" }, 401);
  if (!env.HISTORY) return jsonResponse({ error: "History storage not configured" }, 503);
  return jsonResponse({ items: await readHistoryIndex(env, wallet) }, 200);
}

async function handleHistoryGet(request, env, convId) {
  const wallet = walletIdentity(request);
  if (!wallet) return jsonResponse({ error: "Connect a wallet to sync history" }, 401);
  if (!env.HISTORY) return jsonResponse({ error: "History storage not configured" }, 503);
  const conv = await env.HISTORY.get(`h:${wallet}:${convId}`, "json");
  if (!conv) return jsonResponse({ error: "Conversation not found" }, 404);
  return jsonResponse(conv, 200);
}

async function handleHistoryPut(request, env, convId) {
  const wallet = walletIdentity(request);
  if (!wallet) return jsonResponse({ error: "Connect a wallet to sync history" }, 401);
  if (!env.HISTORY) return jsonResponse({ error: "History storage not configured" }, 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const conv = {
    id: convId,
    title: typeof body.title === "string" ? body.title.slice(0, 80) : "Conversation",
    model: typeof body.model === "string" ? body.model.slice(0, 40) : "Beam",
    createdAt: Number(body.createdAt) || Date.now(),
    updatedAt: Date.now(),
    messages: sanitizeHistoryMessages(body.messages),
  };
  if (!conv.messages.length) return jsonResponse({ error: "Empty conversation" }, 400);
  const payload = JSON.stringify(conv);
  if (payload.length > HIST_CONV_MAX_BYTES) {
    return jsonResponse({ error: "Conversation too large to sync", code: "too_large" }, 413);
  }
  await env.HISTORY.put(`h:${wallet}:${convId}`, payload);
  // Upsert index (meta ringkas, terbaru di atas)
  const idx = (await readHistoryIndex(env, wallet)).filter((e) => e && e.id !== convId);
  idx.unshift({
    id: conv.id,
    title: conv.title,
    model: conv.model,
    updatedAt: conv.updatedAt,
    count: conv.messages.length,
  });
  await writeHistoryIndex(env, wallet, idx);
  return jsonResponse({ ok: true }, 200);
}

async function handleHistoryDelete(request, env, convId, url) {
  const wallet = walletIdentity(request);
  if (!wallet) return jsonResponse({ error: "Connect a wallet to sync history" }, 401);
  if (!env.HISTORY) return jsonResponse({ error: "History storage not configured" }, 503);
  const idx = await readHistoryIndex(env, wallet);
  if (url.searchParams.get("all") === "1") {
    for (const e of idx) {
      if (e && e.id) await env.HISTORY.delete(`h:${wallet}:${e.id}`);
    }
    await env.HISTORY.delete(`h:${wallet}:__idx`);
    return jsonResponse({ ok: true, mode: "all" }, 200);
  }
  await env.HISTORY.delete(`h:${wallet}:${convId}`);
  const kept = idx.filter((e) => e && e.id !== convId);
  await writeHistoryIndex(env, wallet, kept);
  return jsonResponse({ ok: true }, 200);
}

// ---------- API keys (OpenAI-compatible public API) ----------
// Key milik wallet: blob keys:<wallet> = {keys:[{k,n,c,u}]} (cap 10) +
// lookup O(1) k:<key> = {w: wallet}. Pemakaian lewat /v1 memotong kuota
// wallet (w:<wallet>) yang sama dengan app chat: free harian dulu, lalu bonus.
const KEYS_PER_WALLET = 10;

function keysIndexKey(wallet) {
  return "keys:" + wallet;
}
function keyLookupKey(key) {
  return "k:" + key;
}
function genApiKey() {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return "ek_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function readKeysIndex(env, wallet) {
  let rec;
  try {
    rec = await env.KEYS.get(keysIndexKey(wallet), "json");
  } catch {
    rec = null;
  }
  return Array.isArray(rec && rec.keys) ? rec.keys : [];
}

function maskedKey(key) {
  return key.slice(0, 7) + "…" + key.slice(-4);
}

async function handleKeys(request, env) {
  if (!env.KEYS) return jsonResponse({ error: "Key storage not configured" }, 503);
  const wallet = walletIdentity(request);
  if (!wallet) return jsonResponse({ error: "Connect a wallet in the app first" }, 401);
  const keys = await readKeysIndex(env, wallet);
  if (request.method === "GET") {
    return jsonResponse(
      {
        keys: keys.map(({ k, n, c, u }) => ({
          key_masked: maskedKey(k),
          name: n,
          created: c,
          last_used: u || null,
        })),
      },
      200
    );
  }
  if (request.method === "POST") {
    if (keys.length >= KEYS_PER_WALLET) {
      return jsonResponse({ error: "Key limit reached (" + KEYS_PER_WALLET + "). Revoke one first." }, 400);
    }
    let name = "";
    try {
      const b = await request.json();
      name = String((b && b.name) || "").trim().slice(0, 40);
    } catch {
      // name kosong cukup
    }
    const key = genApiKey();
    const c = new Date().toISOString().slice(0, 10);
    keys.push({ k: key, n: name, c, u: c });
    try {
      await env.KEYS.put(keysIndexKey(wallet), JSON.stringify({ keys }));
      await env.KEYS.put(keyLookupKey(key), JSON.stringify({ w: wallet }));
    } catch {
      return jsonResponse({ error: "Key storage write failed" }, 503);
    }
    return jsonResponse({ key, name, created: c }, 201);
  }
  if (request.method === "DELETE") {
    let target = "";
    try {
      const b = await request.json();
      target = String((b && b.key) || "");
    } catch {
      target = "";
    }
    const i = keys.findIndex((e) => e.k === target || maskedKey(e.k) === target);
    if (i < 0) return jsonResponse({ error: "Key not found" }, 404);
    keys.splice(i, 1);
    try {
      await env.KEYS.put(keysIndexKey(wallet), JSON.stringify({ keys }));
      await env.KEYS.delete(keyLookupKey(target));
    } catch {
      return jsonResponse({ error: "Key storage write failed" }, 503);
    }
    return jsonResponse({ ok: true }, 200);
  }
  return jsonResponse({ error: "Method not allowed" }, 405);
}

// ---------- /v1 OpenAI-compatible endpoint ----------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function withCors(resp) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) resp.headers.set(k, v);
  return resp;
}

function openAIError(message, status) {
  return jsonResponse(
    { error: { message, type: "invalid_request_error", code: "echo_api" } },
    status
  );
}

async function loadApiKeyBearer(request, env) {
  // return {wallet, key} | null
  const auth = (request.headers.get("Authorization") || "").trim();
  if (!auth.startsWith("Bearer ")) return null;
  const key = auth.slice(7).trim();
  if (!key) return null;
  let rec;
  try {
    rec = await env.KEYS.get(keyLookupKey(key), "json");
  } catch {
    rec = null;
  }
  const wallet = rec && typeof rec.w === "string" && /^0x[0-9a-f]{40}$/.test(rec.w) ? rec.w : null;
  return wallet ? { wallet, key } : null;
}

async function handleV1Models() {
  return jsonResponse(
    {
      object: "list",
      data: [{ id: "beam", object: "model", created: 1767897600, owned_by: "echo" }],
    },
    200
  );
}

// Pembukuan bersama untuk /v1 (JSON & SSE): usage harian, stats global,
// last_used key, dan burn bonus untuk overflow di atas kuota gratis.
async function billV1Usage(env, uid, wallet, apiKey, prevUsage, usageTokens) {
  await addUsage(env, uid, usageTokens);
  await bumpGlobalStats(env, usageTokens);
  // last_used best-effort (satu KV write per request)
  try {
    await env.KEYS.put(keyLookupKey(apiKey), JSON.stringify({
      w: wallet, u: new Date().toISOString().slice(0, 10),
    }));
  } catch { /* best-effort */ }
  const overflowPrev = Math.max(0, prevUsage.tokens - DAILY_CREDIT_LIMIT);
  const overflowNow = Math.max(0, prevUsage.tokens + usageTokens - DAILY_CREDIT_LIMIT);
  if (overflowNow > overflowPrev) {
    await spendBonusTokens(env, wallet, overflowNow - overflowPrev);
  }
}

async function handleV1Chat(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204, headers: { "Content-Type": "text/plain" } }));
  }
  if (request.method !== "POST") return openAIError("Only POST is supported", 405);
  if (!env.KEYS) return openAIError("Key storage not configured", 503);
  if (!env.REFLECTION_API_KEY) return openAIError("echo API is not configured", 503);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(ip)) return openAIError("Too many requests, try again shortly", 429);
  const auth = await loadApiKeyBearer(request, env);
  if (!auth) {
    return openAIError("Invalid API key. Create one on the dashboard and send it as `Authorization: Bearer ek_…`.", 401);
  }
  const wallet = auth.wallet;
  const uid = "w:" + wallet;
  const prevUsage = await readUsage(env, uid);
  const bonusRec = await readBonus(env, wallet);
  const totalLimit = DAILY_CREDIT_LIMIT + bonusRec.bonus;
  if (prevUsage.enforced && prevUsage.tokens >= totalLimit) {
    return openAIError("Credit balance exhausted. Top up with crypto on the dashboard.", 402);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return openAIError("Request body must be JSON", 400);
  }
  const wantStream = !!(body && body.stream);
  const messages = cleanMessages(body && body.messages, true);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return openAIError("messages must end with a user message", 400);
  }
  const upstreamBody = { model: MODEL, messages };
  if (wantStream) {
    upstreamBody.stream = true;
    upstreamBody.stream_options = { include_usage: true };
  }
  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.REFLECTION_API_KEY}` },
      body: JSON.stringify(upstreamBody),
    });
  } catch {
    return openAIError("Provider error", 502);
  }
  if (!upstream.ok) return openAIError("Provider error", 502);
  // Mode streaming (agent CLI memakai SSE default): pipa upstream SSE
  // apa adanya ke client, parse event sambil lewat untuk hitung usage
  // (chunk usage terakhir dari stream_options; fallback estimasi char/4).
  if (wantStream) {
    if (!upstream.body) return openAIError("Provider error", 502);
    let finalUsage = 0;
    let estimateChars = 0;
    let tail = "";
    const dec = new TextDecoder();
    // Pembukuan harus kelar walau response stream sudah selesai di client:
    // runtime bisa dibekukan begitu stream close → waitUntil menahan alive.
    let resolveBill;
    const billDone = new Promise((res) => { resolveBill = res; });
    ctx.waitUntil(billDone);
    const stream = new ReadableStream({
      async start(controller) {
        let accrual = 0;
        const settle = async () => {
          if (accrual++) return; // sekali saja
          const usageTokens = finalUsage || Math.ceil(estimateChars / 4);
          try {
            if (usageTokens > 0) {
              await billV1Usage(env, uid, wallet, auth.key, prevUsage, usageTokens);
            }
          } catch { /* best-effort */ }
          resolveBill();
        };
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
            tail += dec.decode(value, { stream: true });
            let idx;
            while ((idx = tail.indexOf("\n")) >= 0) {
              const line = tail.slice(0, idx).replace(/\r$/, "");
              tail = tail.slice(idx + 1);
              if (line.slice(0, 5) !== "data:") continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const j = JSON.parse(payload);
                if (j && j.usage && Number(j.usage.total_tokens)) {
                  finalUsage = Number(j.usage.total_tokens);
                } else if (
                  j && j.choices && j.choices[0] && j.choices[0].delta &&
                  typeof j.choices[0].delta.content === "string"
                ) {
                  estimateChars += j.choices[0].delta.content.length;
                }
              } catch { /* chunk malformed: lewati */ }
            }
          }
          controller.close();
        } catch {
          controller.close(); // client abort / pipeline putus: tetap buku seadanya
        } finally {
          await settle();
        }
      },
    });
    return withCors(new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    }));
  }
  let data;
  try {
    data = await upstream.json();
  } catch {
    return openAIError("Provider error", 502);
  }
  if (!data || !Array.isArray(data.choices) || !data.choices.length) {
    return openAIError("Empty provider reply", 502);
  }
  const usageTokens =
    data && data.usage && Number(data.usage.total_tokens)
      ? Number(data.usage.total_tokens)
      : Math.ceil((JSON.stringify(data).length || 0) / 4);
  await billV1Usage(env, uid, wallet, auth.key, prevUsage, usageTokens);
  return withCors(jsonResponse(data, 200));
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
  // Kuota: gratis harian + bonus purchased (wallet). Bonus dipotong hanya
  // dari overflow di atas kuota gratis — burn order: free dulu, lalu bonus.
  const uid = await userIdentity(request);
  const prevUsage = await readUsage(env, uid);
  const wallet = walletIdentity(request);
  const bonusRec = wallet ? await readBonus(env, wallet) : { bonus: 0, enforced: false };
  const totalLimit = DAILY_CREDIT_LIMIT + bonusRec.bonus;
  if (prevUsage.enforced && prevUsage.tokens >= totalLimit) {
    const withWallet = !!wallet;
    return jsonResponse(
      {
        error: withWallet
          ? "Credit balance exhausted. Top up on the dashboard to continue."
          : "Daily credit limit reached (2 credits = 2 million tokens). Connect a wallet or top up on the dashboard.",
        code: "credit_exhausted",
        tokens_used: prevUsage.tokens,
        tokens_limit: totalLimit,
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
  await bumpGlobalStats(env, usageTokens);
  // Bonus dipotong sebesar delta melewati kuota gratis (incremental —
  // overflow dari request sebelumnya sudah dibayar dan tidak dihitung ulang).
  const overflowPrev = Math.max(0, prevUsage.tokens - DAILY_CREDIT_LIMIT);
  const overflowNow = Math.max(0, prevUsage.tokens + usageTokens - DAILY_CREDIT_LIMIT);
  if (overflowNow > overflowPrev) {
    await spendBonusTokens(env, wallet, overflowNow - overflowPrev);
  }
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat") {
      return handleChat(request, env);
    }
    if (url.pathname === "/api/credits") {
      return handleCredits(request, env);
    }
    if (url.pathname === "/api/topup/config" && request.method === "GET") {
      return handleTopupConfig(request, env);
    }
    if (url.pathname === "/api/topup/verify") {
      return handleTopupVerify(request, env);
    }
    if (url.pathname === "/api/stats" && request.method === "GET") {
      return handleStats(request, env);
    }
    if (url.pathname === "/api/keys") {
      return handleKeys(request, env);
    }
    if (url.pathname === "/v1/chat/completions") {
      return withCors(await handleV1Chat(request, env, ctx));
    }
    if (url.pathname === "/v1/models" && (request.method === "GET" || request.method === "OPTIONS")) {
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }
      return withCors(await handleV1Models());
    }
    const hMatch = url.pathname.match(/^\/api\/history(?:\/([A-Za-z0-9-]+))?$/);
    if (hMatch) {
      const convId = hMatch[1] || null;
      if (request.method === "GET") {
        return convId
          ? handleHistoryGet(request, env, convId)
          : handleHistoryList(request, env);
      }
      if (request.method === "PUT" && convId) {
        return handleHistoryPut(request, env, convId);
      }
      if (request.method === "DELETE") {
        return handleHistoryDelete(request, env, convId, url);
      }
      return jsonResponse({ error: "Method not allowed" }, 405);
    }
    return env.ASSETS.fetch(request);
  },
};
