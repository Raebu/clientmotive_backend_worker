# Website integration

The backend is separate from `Raebu/clientmotivewebsite`.

## 1. Anonymous IDs

The website should generate:
- `visitor_id`: stable first-party random ID, e.g. `vis_<uuid>`
- `session_id`: new random ID per browsing session, e.g. `ses_<uuid>`

Do not use browser fingerprinting.

## 2. Event batching

Send at most 25 events in one request:

`POST /v1/events`

Body:

```json
{
  "events": [
    {
      "visitorId": "vis_...",
      "sessionId": "ses_...",
      "eventType": "results_view",
      "path": "/results/",
      "properties": {},
      "occurredAt": "2026-10-09T11:00:00.000Z"
    }
  ]
}
```

Recommended events:
- page_view
- services_view
- who_we_help_view
- industry_page_view
- approach_view
- results_view
- contact_view
- cta_click
- return_visit
- brief_started
- brief_step_completed
- brief_reviewed
- brief_submitted

Do not send free-text form answers as behavioural events.

## 3. Adaptive CTA lookup

`GET /v1/context?visitor_id=vis_...`

Example response:

```json
{
  "visitorId": "vis_...",
  "intentScore": 68,
  "stage": "high_intent",
  "recommendedCta": {
    "label": "Build your growth brief",
    "href": "/contact/",
    "reason": "Multiple evaluation signals indicate high buying intent."
  },
  "strongestSignals": ["contact_view on /contact/"]
}
```

The website should treat this as a recommendation, not as permission to hide important information.

## 4. Signed lead intake

The website Worker should send the completed form server-to-server.

`POST /v1/leads/intake`

Compute:
`hex(HMAC-SHA256(WEBSITE_SHARED_SECRET, exactRawJsonBody))`

Send it as:
`X-ClientMotive-Signature`

The website should also provide its own stable `idempotencyKey`.

The backend returns:
- lead ID
- research job ID
- one-time prospect token
- prospect snapshot path

Store the prospect token only in the prospect's browser/session or return it in a secure post-submit link. Never put it in analytics.

## 5. Prospect research status

`GET /v1/prospect/{lead_id}/snapshot?token={prospectToken}`

This endpoint exposes:
- research status
- client-safe company summary once complete
- client-safe market snapshot once complete

It does **not** expose:
- internal lead score
- tier
- internal sales recommendations
- raw evidence
- other leads

## 6. Admin API

Use:
`Authorization: Bearer ADMIN_API_TOKEN`

- `GET /v1/leads/{lead_id}`
- `POST /v1/leads/{lead_id}/research`

These endpoints must never be called directly from browser code.
