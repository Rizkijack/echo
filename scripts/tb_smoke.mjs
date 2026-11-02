#!/usr/bin/env node
// Tinybird smoke test — posts one synthetic row per datasource.
// Usage: node scripts/tb_smoke.mjs <token> [host]
//   host optional, default https://api.tinybird.co
const token = process.argv[2];
const host = String(process.argv[3] || "https://api.tinybird.co").replace(/\/+$/, "");
if (!token) {
  console.error("usage: node scripts/tb_smoke.mjs <TINYBIRD_TOKEN> [host]");
  process.exit(1);
}
const now = new Date().toISOString();
const rows = {
  chat_events: { timestamp: now, id_type: "wallet", wallet: "0x0000000000000000000000000000000000000000", tokens: 1, model: "smoke", source: "api" },
  topup_events: { timestamp: now, wallet: "0x0000000000000000000000000000000000000000", chain: "smoke", token: "USDG", usd: 0.5, credits: 5, tokens_granted: 5000000, tx_marker: "t:smoke:0" },
  tier_events: { timestamp: now, wallet: "0x0000000000000000000000000000000000000000", holder: false, wif_balance: 0 },
  api_key_events: { timestamp: now, wallet: "0x0000000000000000000000000000000000000000", key_masked: "ek_0000…0000", tokens: 1 },
};
for (const [name, row] of Object.entries(rows)) {
  const r = await fetch(`${host}/v0/events?name=${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson" },
    body: JSON.stringify(row),
  });
  const ok = r.ok;
  console.log(name, ok ? "OK" : r.status + " " + (await r.text()).slice(0, 160));
}
