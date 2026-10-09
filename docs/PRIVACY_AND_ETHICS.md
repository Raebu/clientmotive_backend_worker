# Privacy and behavioural design boundaries

The intent engine is designed to improve relevance without covert surveillance.

## Collected before identification

Allowed:
- random first-party visitor/session IDs
- page path
- high-level event type
- timestamp
- referring domain
- small structured event properties
- Cloudflare country code when available

Not stored:
- raw IP address
- browser fingerprint
- typed-but-not-submitted form content
- mouse trails
- keystroke recordings
- inferred protected characteristics

## Identity linking

An anonymous visitor/session is linked to a named lead only after the person submits the growth brief.

Do not build a workflow that emails or identifies abandoned anonymous visitors without a separate lawful basis and clear notice.

## Behavioural design principles

Use:
- continuity ("Continue your growth brief")
- relevance
- reduced cognitive load
- transparent progress
- evidence
- clear next steps
- useful reciprocity (prospect snapshot)

Do not use:
- fake scarcity
- false urgency
- fabricated social proof
- disguised advertising
- forced continuity
- deceptive button hierarchy
- dark patterns that make declining harder than proceeding

## AI output

AI output must remain subordinate to evidence.

The research pipeline instructs models not to invent:
- companies
- competitors
- target accounts
- statistics
- sources
- client results

Any high-value or externally used dossier should receive human review.
