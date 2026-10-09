# Architecture

ClientMotive Backend Worker is a Cloudflare-native revenue-intelligence engine.

## Flow

1. **Anonymous first-party intent**
   - The website sends small event batches to `POST /v1/events`.
   - D1 stores a client-generated visitor ID and session ID, page path, event type, timestamp and a small JSON properties object.
   - Raw IP addresses are never persisted.
   - `GET /v1/context?visitor_id=...` returns a deterministic stage, intent score and recommended CTA.

2. **Lead intake**
   - The website submits the completed growth brief to `POST /v1/leads/intake`.
   - Intake must be HMAC-signed using `WEBSITE_SHARED_SECRET`.
   - The API creates a permanent lead/account record, links the anonymous session if present, returns a one-time prospect snapshot token and enqueues research.

3. **Asynchronous research**
   - Cloudflare Queues processes:
     1. company profile
     2. competitive landscape
     3. market/channel recommendations
     4. buyer committee / ICP
     5. target-account discovery
     6. fit × intent × need scoring
     7. opportunity dossier
     8. notification
   - Every stage is persisted independently, so a retry does not require repeating the whole pipeline.

4. **Evidence first**
   - Direct website pages are fetched before paid/limited web search.
   - Search results are stored as evidence with source URL, snippet, query and capture timestamp.
   - AI prompts are explicitly instructed not to invent facts, companies, statistics or URLs.
   - Named competitors and target accounts should only be produced when supplied evidence supports them.

5. **Two outputs**
   - **Internal opportunity dossier:** full research, score dimensions, competitors, buyers, channels, target accounts and next best actions.
   - **Prospect snapshot:** deliberately smaller, safe client-facing observations without internal scoring.

## Storage

D1 tables separate:
- anonymous sessions and intent events
- original lead brief
- research jobs and evidence
- company profile
- competitors
- buyer roles
- channel recommendations
- target accounts
- score dimensions
- dossier
- next actions
- notification/audit history

The original prospect brief is never overwritten by AI output.

## Search strategy

Search is optional.

Priority:
1. direct company website fetch — no provider cost
2. Tavily when `TAVILY_API_KEY` exists
3. Brave Search when `BRAVE_SEARCH_API_KEY` exists

`MAX_SEARCHES_PER_LEAD` creates a hard research budget. Default: 12.

## AI strategy

Workers AI is optional. If no `AI` binding exists, the pipeline still stores the lead, intent, direct website evidence, deterministic score and conservative fallback dossier.

Default model in the example config:
`@cf/zai-org/glm-4.7-flash`

This avoids designing the product so that a paid frontier model is required for every lead.

## Adaptive website behaviour

The backend returns one of:
- discovering
- exploring
- evaluating
- high_intent
- brief_started
- submitted

The website can use this to change **the next useful action**, not to create fake urgency.

Examples:
- discovering → Explore our approach
- evaluating → See how we measure the work
- high intent → Build your growth brief
- brief started → Continue your growth brief
- submitted → Do not ask for the brief again

The engine intentionally avoids covert fingerprinting, raw-IP storage, keystroke capture and manipulative countdowns.
