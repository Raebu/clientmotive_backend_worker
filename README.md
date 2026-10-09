# ClientMotive Revenue Intelligence Engine

A free-first Cloudflare backend that turns ClientMotive website intent and growth-brief submissions into researched, evidence-backed sales opportunities.

## What it does

Before a visitor submits:
- records small first-party intent events
- classifies the journey as discovering → exploring → evaluating → high intent → brief started
- recommends the next useful CTA
- never stores raw IP addresses or browser fingerprints

After a visitor submits:
- creates a permanent lead/account record
- links the prior anonymous journey
- researches the company and its public website
- discovers competitors and alternatives when a search provider is configured
- recommends likely acquisition channels
- maps the likely buying committee / ICP
- discovers evidence-backed target accounts
- scores **fit, intent, need, timing, commercial potential and access separately**
- generates an internal opportunity dossier
- generates a smaller prospect-safe market snapshot
- creates next-best-action records
- optionally alerts by email/Slack

## Free-first stack

- Cloudflare Workers
- Cloudflare D1
- Cloudflare Queues
- Cloudflare Workers AI
- Tavily free tier by default for optional web search
- Brave Search as an optional alternative
- Resend/Slack only when their secrets are configured

The pipeline still operates in a conservative degraded mode if AI or web search is unavailable.

## Repository map

- `src/index.ts` — Worker entry point, Queue consumer and retention cron
- `src/router.ts` — public/admin API
- `src/services/intent.ts` — visitor intent and adaptive CTA engine
- `src/services/research.ts` — asynchronous research pipeline
- `src/services/search.ts` — direct website fetch + Tavily/Brave adapters
- `src/services/ai.ts` — grounded Workers AI JSON adapter
- `src/services/scoring.ts` — transparent multi-dimensional lead scoring
- `migrations/` — D1 schema
- `docs/` — architecture, website contract, privacy, cost model and roadmap

## API

Public website:
- `POST /v1/events`
- `GET /v1/context?visitor_id=...`

Signed website Worker:
- `POST /v1/leads/intake`

Prospect-safe:
- `GET /v1/prospect/{lead_id}/snapshot?token=...`

Admin:
- `GET /v1/leads/{lead_id}`
- `POST /v1/leads/{lead_id}/research`

Operations:
- `GET /health`
- `GET /v1/capabilities`

See `docs/WEBSITE_INTEGRATION.md` for payloads and signing.

## Cloudflare setup

1. Copy `wrangler.example.jsonc` to `wrangler.jsonc`.
2. Create D1:
   `npx wrangler d1 create clientmotive-revenue-intelligence`
3. Put the returned database ID in `wrangler.jsonc`.
4. Create queues:
   - `npx wrangler queues create clientmotive-research`
   - `npx wrangler queues create clientmotive-research-dlq`
5. Apply migrations:
   `npx wrangler d1 migrations apply clientmotive-revenue-intelligence --remote`
6. Set mandatory secrets:
   - `npx wrangler secret put WEBSITE_SHARED_SECRET`
   - `npx wrangler secret put ADMIN_API_TOKEN`
7. For web research, set one optional provider:
   - `npx wrangler secret put TAVILY_API_KEY`
   - or `npx wrangler secret put BRAVE_SEARCH_API_KEY`
8. Optional notifications:
   - `RESEND_API_KEY`
   - `ALERT_EMAIL_TO`
   - `SLACK_WEBHOOK_URL`
9. Deploy:
   `npx wrangler deploy`

Do not commit `wrangler.jsonc` or `.dev.vars`; both are ignored.

## Local validation

```
npm install
npm run typecheck
npm test
npx wrangler deploy --dry-run --config wrangler.ci.jsonc
```

## Website wiring

The public website is intentionally a separate repository. The backend contract is documented in `docs/WEBSITE_INTEGRATION.md`.

The current ClientMotive contact Worker should eventually:
1. keep its existing bot/spam checks
2. accept the growth brief
3. HMAC-sign the exact JSON body
4. forward the accepted brief to `/v1/leads/intake`
5. retain the returned prospect token client-side
6. show the prospect-safe research snapshot as it becomes available

## Design principles

- evidence before claims
- no invented competitors, companies, statistics or URLs
- fit and intent remain separate dimensions
- no covert deanonymisation
- no raw-IP persistence
- no email retargeting of anonymous abandoners
- no fake urgency or dark patterns
- human review for high-value external decisions

## Current status

v0.1 is an implementation-ready backend. Cloudflare resources and production secrets still need to be created/bound before production deployment.

See:
- `docs/ARCHITECTURE.md`
- `docs/COST_MODEL.md`
- `docs/PRIVACY_AND_ETHICS.md`
- `docs/ROADMAP.md`
