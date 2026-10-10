# Product roadmap

## Built in v1

- first-party anonymous intent engine
- adaptive CTA recommendation
- signed/idempotent lead intake
- permanent lead/account record
- company-site research
- optional web search
- competitive analysis
- channel recommendation
- buyer committee / ICP map
- evidence-backed target-account discovery
- fit × intent × need scoring
- internal opportunity dossier
- prospect-facing market snapshot
- next-best-action records
- email/Slack notification hooks
- daily anonymous-event retention cleanup

## Next — close the feedback loop

1. **Website wiring**
   - add event batching and adaptive CTA rendering to the public website
   - forward the existing secure growth brief to this backend after acceptance
   - surface the prospect snapshot after submission

2. **Outcome tracking**
   - meeting booked
   - proposal sent
   - won/lost
   - value
   - loss reason
   - time to close

3. **CRM adapter**
   - start with HubSpot when configured
   - retain D1 as the canonical research/evidence store

4. **Enrichment adapters**
   - Companies House for UK entities
   - optional people/contact enrichment provider
   - job-change/hiring signals where terms and lawful basis permit

5. **Evidence quality**
   - source confidence score
   - freshness score
   - contradiction detection
   - automatic flag for human verification

6. **Prospect value preview**
   - dynamic "what we are checking" state after submission
   - market snapshot with verified competitors, buyer groups and channel hypotheses
   - no internal score/tier shown externally

## Later — only after enough real outcome data

- calibration of scoring weights against closed-won/lost outcomes
- similar-deal retrieval using Vectorize
- account-level content recommendations
- experiment framework for CTA/copy variants
- automated proposal/scoping draft
- controlled outreach generation from the verified dossier

Do not introduce these before outcome data exists merely to make the architecture look more "AI".
