# Cost model — free first

The backend is deliberately designed around Cloudflare's free allowances and optional external providers.

Current public limits/pricing should be re-checked before production rollout.

## Cloudflare Workers

Workers Free currently includes 100,000 requests/day.

The public event API should batch events rather than send one request for every tiny interaction.

## D1

Workers Free currently includes:
- 5 million rows read/day
- 100,000 rows written/day
- 5 GB account storage
- 500 MB maximum per free D1 database

D1 free-tier query limits are enforced daily, so indexes matter. The migration creates indexes for visitor/time and lead/stage lookups.

## Queues

Workers Free currently includes 10,000 queue operations/day with 24-hour retention.

A message normally costs a write + read + delete operation. The eight-stage research pipeline therefore remains inexpensive at normal consultancy lead volumes.

## Workers AI

Workers AI currently includes 10,000 neurons/day at no charge.

The system:
- does not require AI for ingestion or scoring
- only calls AI during research stages
- uses a free-plan-compatible model by default
- provides conservative fallback output if AI is unavailable

## Search

### Tavily
Current free plan: 1,000 API credits/month with no card required.

Default configuration caps all research at 12 search queries per lead.

### Brave Search
Current Search plan includes $5 monthly free credit, approximately 1,000 Search requests at published pricing, but requires payment details for account verification.

Use only one provider at a time unless there is a specific research reason.

## Browser rendering

Not required for v1.

Cloudflare Browser Rendering currently includes 10 minutes/day on Workers Free. It can be added later only for sites that cannot be usefully fetched without JavaScript.

## Vector search

Not required for v1.

Vectorize has a free allowance, but adding embeddings before there is enough historical lead/win-loss data would add complexity without improving decisions.

Introduce Vectorize later for:
- similar won-deal retrieval
- objection pattern retrieval
- matching new leads to historical dossiers

## Expected v1 infrastructure cost

At low/normal consultancy lead volumes:
- Cloudflare Worker: £0 expected
- D1: £0 expected
- Queues: £0 expected
- Workers AI: £0 while within daily allocation
- Tavily: £0 within monthly free credits
- Resend: depends on the existing account/allowance

The first likely paid pressure point is web search or AI volume, not D1.
