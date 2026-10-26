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
