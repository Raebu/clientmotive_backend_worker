# ClientMotive Commercial OS

The Commercial OS extends the original lead-research backend into a system that can acquire, qualify, convert, expand and learn from commercial opportunities.

## Five engines

### Acquire
- first-party visitor intent and adaptive CTA
- partial-form value preview
- free diagnostics/calculators
- autonomous target-account discovery
- trigger/watchlist monitoring
- autonomous outbound staging
- programmatic industry playbooks
- problem-led newsletter subscriptions

### Intelligence
- company/competitor/channel/buyer research
- account watchlists
- buyer-change and hiring/expansion signals
- market opportunity maps
- next-best-account ranking
- relationship/knowledge graph
- partner discovery
- referral suggestions
- client intelligence portfolios

### Convert
- next-best-message
- opportunity creation from inbound briefs
- market-entry, ICP, competitive positioning, outbound readiness and campaign-architecture deliverables
- scope and proposal drafts
- meeting preparation and follow-up
- stalled-opportunity rescue
- problem-led nurture

### Expand
- recurring ClientMotive Intelligence subscriptions
- client portal data feed
- account health and renewal-risk scoring
- expansion readiness
- referral attribution
- configurable cross-business/partner routing
- recurring account-watch alerts with explicit consent

### Learn
- objections
- won/lost outcomes
- pricing intelligence
- campaign hypotheses/events
- commercial experiments
- content intelligence
- qualitative search-demand mining
- LinkedIn/newsletter/article brief generation
- benchmark reports
- commercial knowledge graph

## 48-feature implementation matrix

| # | Capability | Backend status | Primary implementation |
|---|---|---|---|
| 1 | Visitor-to-opportunity engine | Built | `services/intent.ts`, `/v1/context` |
| 2 | Instant value while form is completed | Built API; website UI wiring pending | `commercial/diagnostics.ts`, `POST /v1/value-preview` |
| 3 | Free Growth Snapshot | Built | existing research dossier + prospect snapshot |
| 4 | Interactive diagnostics/calculators | Built | `POST /v1/diagnostics` |
| 5 | Programmatic industry pages | Built content API; website rendering pending | industry playbooks |
| 6 | Trigger-based account discovery | Built | watchlists/signals + autonomous discovery |
| 7 | Autonomous ClientMotive prospecting | Built staging pipeline | `commercial/outbound.ts` |
| 8 | Account watchlists | Built | watchlists + daily scan |
| 9 | Competitor monitoring service | Built core | competitor watchlists + signals |
| 10 | Market Opportunity Maps | Built | commercial accounts + portfolio/map APIs |
| 11 | Buyer-change monitoring | Built core | signal classifier/watchlists |
| 12 | Relationship graph | Built | knowledge nodes/edges |
| 13 | Referral opportunity engine | Built | graph referral suggestions + referral records |
| 14 | Partner/channel engine | Built | partner discovery |
| 15 | Market-entry reports | Built | commercial document generator |
| 16 | Competitive positioning workshops | Built backend deliverable | competitive-positioning document |
| 17 | ICP development product | Built | product catalogue + ICP document |
| 18 | Outbound readiness audit | Built | diagnostic + paid deliverable |
| 19 | Campaign architecture service | Built | campaign-architecture document |
| 20 | Managed intelligence subscription | Built backend | products, subscriptions, portfolios |
| 21 | Revenue intelligence dashboard | Built API; frontend pending | admin/client dashboard endpoints |
| 22 | Next-best-account engine | Built | account ranking |
| 23 | Next-best-message engine | Built | evidence-led message recommendations |
| 24 | Objection intelligence | Built | objections table + content learning |
| 25 | Win/loss intelligence | Built | outcomes + benchmarks |
| 26 | Pricing intelligence | Built; only activates meaningfully with enough won data | historical pricing analysis |
| 27 | Automatic scope generation | Built draft | commercial documents |
| 28 | Proposal generation | Built draft | commercial documents |
| 29 | Meeting preparation | Built | meeting brief |
| 30 | Meeting follow-up | Built | notes/transcript analysis |
| 31 | Opportunity rescue | Built + scheduled | stale opportunity research |
| 32 | Nurture by problem | Built + scheduled; sending requires explicit consent | nurture enrollments |
| 33 | Content intelligence | Built | content insights/assets |
| 34 | Search-demand mining | Built qualitative; paid volume data intentionally optional | search-demand endpoint |
| 35 | LinkedIn authority engine | Built draft generator; publishing approval required | content assets |
| 36 | Original benchmark reports | Built; publication held until sample/privacy review | benchmark reports |
| 37 | Commercial newsletter | Built | subscribers, content assets, Resend delivery |
| 38 | Free account watch | Built; explicit opt-in required for alerts | prospect watchlists |
| 39 | Referral programme | Built backend | referral codes/attribution |
| 40 | White-label intelligence | Built API-key/scopes layer | api_clients |
| 41 | Research API | Built initial diagnostic/account-discovery scopes | /v1/api/* |
| 42 | ClientMotive Intelligence product tier | Built product catalogue | seeded products |
| 43 | Outcome-based expansion triggers | Built | client health + expansion signals |
| 44 | Client health/renewal engine | Built | metrics + daily health scoring |
| 45 | Commercial experiments engine | Built | experiments + campaign hypotheses/events |
| 46 | Internal opportunity marketplace | Built configurable routing | routing destinations/suggestions |
| 47 | Cross-business intelligence | Built configurable routing layer | routing destinations |
| 48 | Commercial knowledge graph | Built | knowledge nodes/edges |

## Important meaning of “built”

“Built” means the repository contains the data model, business logic and API/scheduled workflow.

It does **not** mean every capability is live in production yet.

Still required before live operation:
1. provision D1 and Queues
2. deploy the Worker
3. configure mandatory secrets
4. connect the public website to intent/value-preview/lead-intake endpoints
5. configure search/Resend providers where desired
6. configure internal routing destinations
7. build optional dashboard/diagnostic/industry-page frontend views

## Automation boundaries

The system can autonomously:
- research
- monitor
- score
- prioritise
- draft
- generate alerts
- stage outreach candidates
- generate client-safe intelligence

Human approval remains the default for:
- outbound sending from autonomous prospect discovery
- externally binding proposals/scopes/pricing
- publishing benchmark claims
- cross-business routing
- public editorial publishing

This is intentional. The goal is high automation without fabricating evidence, creating spam or making commercial commitments without review.
