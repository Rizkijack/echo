# echo

AI chat interface — single-page frontend + small local Node proxy.

- Frontend: hash routes — home, chat app, dashboard, docs; i18n in 6 languages. Demo replies are simulated locally in the browser by default.
- Online mode: toggled in the dashboard (Settings & API). Posts to `/api/chat`; model Beam-1.0-501B-A23B via Reflection AI (`https://api.reflection.ai/openai/v1`). API key stays server-side. Mandatory `reasoning_content` is stored and echoed back on every assistant turn; history is trimmed client-side.

Run: `node server.js` → http://localhost:5173 (or open `index.html` for demo-only; static serving also fine).

Env: `REFLECTION_API_KEY` (required for /api/chat), `REFLECTION_API_BASE` (optional, default `https://api.reflection.ai`), `PORT` (optional, default 5173).
