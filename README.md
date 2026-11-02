# echo

AI chat interface — frontend + Cloudflare Worker proxy to Reflection Beam.

- Routes (hash routing): home, chat app, dashboard, docs.
- Chat sends `POST /api/chat` to the Worker, which forwards to
  `https://api.reflection.ai/openai/v1/chat/completions` with model
  `Beam-1.0-501B-A23B`. If the proxy is unavailable, the page falls back
  to its built-in simulated replies.
- The provider key lives ONLY in the `REFLECTION_API_KEY` Worker secret —
  never in the repo or frontend.

Deploy:

```
wrangler deploy
```

Set the provider key (once per Worker):

```
wrangler secret put REFLECTION_API_KEY
```

Local preview of the static files: open `public/index.html` in a browser
(the chat proxy only works on the deployed Worker).

Local backend (optional, for live Beam replies without deploying):

```
REFLECTION_API_KEY=... node server.js
```

Serves `public/` at http://localhost:5173 and proxies `/api/chat` to
Reflection Beam (model Beam-1.0-501B-A23B). Env: `REFLECTION_API_KEY`
(required), `REFLECTION_API_BASE` (optional, default
`https://api.reflection.ai`), `PORT` (optional, default 5173). Set the key
in the environment when running, or put it in a `.env` file in the
repo root — server.js loads it (simple KEY=VALUE parser, no
dependency; pre-set environment wins). Never commit a real key.

## $WIF payments & holding tier

`$WIF` (World is Flat, ERC-20 on Robinhood Chain, contract
`0x5173b8ea6923c2d40267890d45c46a3480954773`) is a third payment option
next to USDC/USDG:

- Credits are granted at the token's live market rate (CoinGecko,
  60s cache): $1 of $WIF = $1 of credits, 1:1 parity with the stablecoins.
  Payments are verified with the same ERC-20 `Transfer`-log check to the
  treasury; the transaction marker TTL is 30 days like the other tokens.
- **Holding tier**: keeping ≥ 10,000 $WIF in the connected wallet raises
  the free daily allowance from 2 to 10 credits/day while the tokens
  stay held. The balance is checked via `balanceOf` on a public RPC and
  cached for 24h (`tier:<wallet>` KV), re-checked after every top-up.
  Burn order: free daily (+tier) first, then purchased bonus credits.

$WIF is optional — the free daily credits and USDC/USDG top-ups stay
available to everyone.

## Public API (OpenAI-compatible)

Create API keys in the dashboard (`#/dashboard`, wallet must be connected).
Keys are stored in the `KEYS` KV namespace, shown in full once at creation
(max 10 per wallet), and revoke from the same card.

Endpoint:

```
POST https://echo.0xjustshrimp.workers.dev/v1/chat/completions
GET  https://echo.0xjustshrimp.workers.dev/v1/models
Authorization: Bearer ek_<40 hex>
```

`/v1/chat/completions` follows the OpenAI request/response shape
(`messages`, `usage`, `choices[]`). Multi-turn API requests: assistant
messages without `reasoning_content` are dropped (provider requirement —
fresh conversations always work). Both `stream:false` (default, single
JSON) and `stream:true` (SSE pass-through with `stream_options.include_usage`)
are supported.

Billing: requests bill the key owner's wallet quota — the free daily
2 credits (2M tokens) first, then purchased bonus credits, exactly like
chat in the app. CORS is open, so browser clients work too.

Revocation is eventually consistent (KV): a revoked key can keep working
for up to ~60s globally before the delete propagates to all edges.
