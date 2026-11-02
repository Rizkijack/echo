/**
 * Tinybird Definitions — echo analytics (plan "C — hybrid")
 *
 * Datasources ingest data from the Cloudflare Worker via the Events API
 * (worker.js tbSendEvent(), plain fetch — no SDK at runtime). This file is
 * the SCHEMA source of truth deployed by the TS SDK pipeline (deploy to a
 * Tinybird **Forward** workspace on host api.us-east.tinybird.co — set
 * TINYBIRD_TOKEN / set baseUrl accordingly in tinybird.config.json).
 */

import {
  defineDatasource,
  defineEndpoint,
  Tinybird,
  node,
  t,
  engine,
  type InferRow,
} from "@tinybirdco/sdk";

// ============================================================================
// Datasources
// ============================================================================

/** chat_events — one row per chat turn (app chat + /v1 API). */
export const chatEvents = defineDatasource("chat_events", {
  description: "Every chat turn (app chat + /v1 API); 1 row = 1 request.",
  schema: {
    timestamp: t.dateTime(),
    id_type: t.string().lowCardinality(),
    wallet: t.string().nullable(),
    tokens: t.uint64(),
    model: t.string().lowCardinality(),
    source: t.string().lowCardinality(),
  },
  engine: engine.mergeTree({
    sortingKey: ["timestamp", "tokens"],
  }),
});

export type ChatEventsRow = InferRow<typeof chatEvents>;

/** topup_events — verified on-chain top-ups; 1 row = 1 payment granted. */
export const topupEvents = defineDatasource("topup_events", {
  description:
    "Verified on-chain top-ups (USDC/USDG/$WIF); 1 row = 1 granted payment.",
  schema: {
    timestamp: t.dateTime(),
    wallet: t.string(),
    chain: t.string().lowCardinality(),
    token: t.string().lowCardinality(),
    usd: t.float32(),
    credits: t.uint32(),
    tokens_granted: t.uint64(),
    tx_marker: t.string(),
  },
  engine: engine.mergeTree({
    sortingKey: ["timestamp", "wallet"],
  }),
});

export type TopupEventsRow = InferRow<typeof topupEvents>;

/** tier_events — $WIF holder snapshot (≤1×/day per wallet + after top-ups). */
export const tierEvents = defineDatasource("tier_events", {
  description:
    "$WIF holding tier snapshot when the 24h cache refreshes.",
  schema: {
    timestamp: t.dateTime(),
    wallet: t.string(),
    holder: t.bool(),
    wif_balance: t.uint64(),
  },
  engine: engine.mergeTree({
    sortingKey: ["timestamp", "wallet"],
  }),
});

export type TierEventsRow = InferRow<typeof tierEvents>;

/** api_key_events — /v1 usage per API key (poly masked, never raw). */
export const apiKeyEvents = defineDatasource("api_key_events", {
  description: "/v1 API usage per key; ces key_masked is masked, never raw.",
  schema: {
    timestamp: t.dateTime(),
    wallet: t.string(),
    key_masked: t.string(),
    tokens: t.uint64(),
  },
  engine: engine.mergeTree({
    sortingKey: ["timestamp", "wallet"],
  }),
});

export type ApiKeyEventsRow = InferRow<typeof apiKeyEvents>;

// ============================================================================
// Endpoints
// ============================================================================

/** chat_stats_per_day — chats/wallets/tokens per day per source. */
export const chatStatsPerDay = defineEndpoint("chat_stats_per_day", {
  description: "Chats, unique wallets and tokens per day per source.",
  nodes: [
    node({
      name: "chat_per_day",
      sql: `
        SELECT
          toStartOfDay(timestamp) AS day,
          source,
          count() AS chats,
          uniq(wallet) AS unique_wallets,
          sum(tokens) AS tokens
        FROM chat_events
        GROUP BY day, source
        ORDER BY day DESC
      `,
    }),
  ],
  output: {
    day: t.dateTime(),
    source: t.string().lowCardinality(),
    chats: t.uint64(),
    unique_wallets: t.uint64(),
    tokens: t.uint64(),
  },
});

/** topup_stats_per_day — payments/usd/credits per day per chain+token. */
export const topupStatsPerDay = defineEndpoint("topup_stats_per_day", {
  description: "Payments, USD and credits per day per chain and token.",
  nodes: [
    node({
      name: "topup_per_day",
      sql: `
        SELECT
          toStartOfDay(timestamp) AS day,
          chain,
          token,
          count() AS payments,
          round(sum(usd), 2) AS usd,
          sum(credits) AS credits
        FROM topup_events
        GROUP BY day, chain, token
        ORDER BY day DESC
      `,
    }),
  ],
  output: {
    day: t.dateTime(),
    chain: t.string().lowCardinality(),
    token: t.string().lowCardinality(),
    payments: t.uint64(),
    usd: t.float32(),
    credits: t.uint32(),
  },
});

// ============================================================================
// Client (tooling-side typed client — NOT used by the worker)
// ============================================================================

export const tinybird = new Tinybird({
  datasources: {
    chatEvents,
    topupEvents,
    tierEvents,
    apiKeyEvents,
  },
  pipes: {
    chatStatsPerDay,
    topupStatsPerDay,
  },
});
