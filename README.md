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
in the environment when running; server.js does not read `.env` files
itself. Never commit a real key.
