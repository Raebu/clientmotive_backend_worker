# Revenue Operations Layer

This layer closes the gap between "we found an opportunity" and "cash was collected, value was delivered, the customer renewed, expanded or referred someone, and the system learned from the outcome."

## End-to-end commercial loop

```
anonymous attention
→ first-party intent
→ growth brief / diagnostic
→ lead + contact + account
→ research + evidence
→ opportunity
→ attribution
→ forecast / revenue-gap plan
→ buying committee / deal risk / procurement
→ scope / proposal / agreement
→ payment
→ onboarding
→ delivery milestones / time-to-value
→ client health
→ renewal / expansion / referral
→ churn or win learning
→ better ICP / offer / content / outreach
```

## Implementation matrix — additional revenue-operations capabilities

| # | Capability | Backend status | Implementation |
|---|---|---|---|
| 1 | Unified commercial inbox | Built provider-neutral adapter | `communication_events`, `POST /v1/integrations/inbox` |
| 2 | CRM synchronisation | Built bidirectional contract; provider OAuth wiring optional | CRM webhook + `/v1/ops/crm/delta` + sync cursors |
| 3 | Contact & buying-committee database | Built | `contacts`, `contact_roles` |
| 4 | Enrichment waterfall | Built | company site → search → Companies House → optional provider |
| 5 | Deliverability intelligence | Built adapter/gate | deliverability checks + optional verifier |
| 6 | Consent/suppression ledger | Built | permissions + hashed email/domain/phone suppression |
| 7 | Revenue attribution | Built | first-party touches linked to opportunity + attribution models |
| 8 | Revenue forecasting | Built deterministic | weighted/committed revenue |
| 9 | Revenue-gap autopilot | Built planning + human work queue | required wins/proposals/meetings/qualified opportunities |
| 10 | Acquisition-route unit economics | Built | cost/opportunity, cost/win, revenue/cost |
| 11 | Margin intelligence | Built | delivery/external cost, hours, gross margin/contribution |
| 12 | Capacity-aware selling | Built | prioritises high-contribution opportunities that fit capacity |
| 13 | Territory / whitespace engine | Built heuristic | coverage, wins and signal density by segment |
| 14 | Win-based lookalike learning | Built descriptive | won-deal segment/value profile |
| 15 | Negative ICP engine | Built | loss, health and margin warning segments |
| 16 | Deal-risk engine | Built | stale/no-next-step/no-economic-buyer/single-thread/procurement |
| 17 | Multi-threading recommendations | Built | compares known contacts with buyer-role map |
| 18 | Procurement intelligence | Built | vendor/security/DPA/payment/framework requirements |
| 19 | Tender/RFP discovery | Built | evidence-backed web search and scoring |
| 20 | Trigger prediction | Built as explicit hypothesis | never presented as fact |
| 21 | Conversation intelligence | Built | classification of inbox/CRM activity |
| 22 | Voice-of-customer library | Built | anonymised recurring problem/outcome/objection language |
| 23 | Competitive battlecards | Built | evidence-backed strengths/differences/questions/claims-to-avoid |
| 24 | Offer-performance intelligence | Built | opportunities/wins/value/margin by product |
| 25 | Dynamic packaging | Built | need-led service recommendation |
| 26 | Billing integration | Built provider-neutral signed webhook | realised revenue enters forecasting/attribution |
| 27 | Digital acceptance/e-sign | Built provider-neutral signed webhook | agreements + signed state |
| 28 | Customer onboarding engine | Built | signed + paid can create onboarding automatically |
| 29 | Time-to-value | Built | first research/campaign/meeting/realised revenue |
| 30 | Delivery quality engine | Built | milestones + quality scores |
| 31 | Customer-success playbooks | Built | health-state-specific interventions |
| 32 | Churn learning | Built | reason, preventability, qualification and delivery lessons |
| 33 | Revenue concentration alerts | Built | account share of realised revenue |
| 34 | Partner economics | Built | introductions/meetings/wins/revenue/score |
| 35 | Partner portal | Built tokenised API | referral status + performance |
| 36 | Self-serve paid intelligence | Built order/fulfilment workflow | payment adapter + auto/human fulfilment |
| 37 | API credits / usage | Built | credit ledger alongside API quotas |
| 38 | Multi-tenant architecture | Built | tenant IDs, membership and tenant-aware ops routes |
| 39 | Role-based access control | Built | admin/analyst/sales/account manager/client/partner/API roles |
| 40 | Human work queue | Built | deal risk, revenue gap, onboarding, fulfilment and approval tasks |
| 41 | Confidence/provenance | Built | field-level source, confidence and expiry |
| 42 | Research freshness | Built | expiry/staleness report |
| 43 | Contradiction detection | Built | conflicting facts retained and flagged |
| 44 | AI evaluation framework | Built storage/API | capability/model/prompt/dataset/quality/cost/latency |
| 45 | Cost-per-opportunity controls | Built | workflow search/AI budgets are enforced in provider calls |
| 46 | Automatic model routing | Built | deterministic first; cheap vs stronger model by complexity/budget |
| 47 | Failure/degraded-mode dashboard | Built | provider, failed jobs, stale watches, budgets, human tasks |
| 48 | Backup/export | Built JSON tenant export | portable accounts/contacts/opps/comms/signals/outcomes |
| 49 | Decision audit | Built | recommendation/evidence/confidence/approver/decision |
| 50 | "Why this?" explanations | Built | decisions + facts + signals + risks for an entity |

## External provider boundary

The repository deliberately does not assume a particular paid vendor.

Signed adapter endpoints exist for:
- inbox/email
- CRM
- billing
- e-signature

A provider can be connected by:
1. pushing its webhook/events into the adapter contract; or
2. using a small provider-specific bridge that signs the canonical payload.

This keeps the core system portable and cheap.

## What is automatic

Automatic:
- journey attribution
- research and evidence gathering
- forecast/revenue-gap calculation
- opportunity risk detection
- customer-health intervention tasks
- signed+paid onboarding creation
- self-service fulfilment when enough lead context exists
- workflow budget enforcement
- research freshness/confidence scoring

Human review remains required for:
- cold outbound sending
- binding price/contract terms
- tender submission
- public benchmark claims
- unresolved fact contradictions
- cross-business routing where a person/company is being handed to another entity

## Provider/live prerequisites

These capabilities are code-complete but need credentials/configuration before live provider activity:
- direct inbox/Gmail bridge
- CRM bridge (HubSpot/Salesforce/Pipedrive/etc.)
- billing provider
- e-sign provider
- optional email verification provider
- optional enrichment provider
- Companies House API key
- search provider
- Resend notifications

The backend works without them in degraded/provider-neutral mode.
