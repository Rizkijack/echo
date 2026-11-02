# tinybird/ — analytics workspace (grpc-free, CLI management)

Workspace files for the echo analytics layer (plan "C — hybrid": KV stays
OLTP, Tinybird stores analytics). The worker ships rows with plain
`fetch()` to the Events API — no SDKs at runtime.

## Datasources
| Datasource | Emitted by (worker) | What |
|---|---|---|
| `chat_events` | app chat + /v1 API | one row per chat turn: tokens, wallet, source |
| `topup_events` | topup-verify | one row per granted payment (usd, credits) |
| `tier_events` | tier cache refresh | $WIF holder snapshot (≤1×/day per wallet) |
| `api_key_events` | /v1 billing | per-key usage (key masked) |

## Setup (owner, once)
```
pip install tinybird-cli    # or pipx
tb auth                     # paste workspace token
tb info                     # sanity
tb push tinybird/*.datasource
tb push tinybird/*.pipe
```

## Worker secrets (owner, once)
```
wrangler secret put TINYBIRD_TOKEN    # workspace admin/write token
wrangler secret put TINYBIRD_HOST     # optional: only if workspace is NOT
                                      # on https://api.tinybird.co (e.g.
                                      # https://api.eu-central-1.aws.tinybird.co)
```
Without `TINYBIRD_TOKEN` the worker simply never sends events (no-op;
everything else works unchanged).

## Verify after pushing
```
tb sql "select count() from chat_events"
curl -s "https://echo.0xjustshrimp.workers.dev/api/chat" -H ... # produce 1 event
tb sql "select count() from chat_events"   # should be 1 row higher
tb pipe data chat_events recent            # sanity look
```
Pipes (JSON endpoints once pushed): `chat_stats_per_day`, `topup_stats_per_day`
(read via `/v0/pipes/<name>.json?token=…` — Phase 3 wiring planned once the
first real data lands).
