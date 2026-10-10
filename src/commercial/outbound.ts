import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import { discoverTargetAccounts, nextBestAccounts } from "./acquisition";
import { nextBestMessage } from "./convert";
import {
  discoverDecisionMakers,
  enrichDecisionMaker,
  sendApprovedOutreachCandidate
} from "./contactDiscovery";

export async function stageAutonomousProspecting(
  env: Env,
  input: { market: string; offer: string; limit?: number }
): Promise<Array<Record<string, unknown>>> {
  await discoverTargetAccounts(env, input);
  const ranked = await nextBestAccounts(env, Math.max(5, Math.min(50, input.limit || 15)));
  const staged: Array<Record<string, unknown>> = [];

  for (const account of ranked) {
    const existing = await env.DB.prepare(
      "SELECT candidate_id FROM outreach_candidates WHERE account_id=? AND status IN ('ready_for_review','approved','sent') LIMIT 1"
    ).bind(account.accountId).first();
    if (existing) continue;
    const message = await nextBestMessage(env, account.accountId);
    if (!message.draft || !message.reasonForContact) continue;
    const signal = await env.DB.prepare(
      "SELECT signal_id FROM commercial_signals WHERE account_id=? ORDER BY captured_at DESC LIMIT 1"
    ).bind(account.accountId).first<{ signal_id: string }>();
    const candidateId = id("outreach");
    await env.DB.prepare(
      `INSERT INTO outreach_candidates (
        candidate_id, account_id, trigger_signal_id, rationale, message_json,
        status, approval_policy, created_at
      ) VALUES (?, ?, ?, ?, ?, 'ready_for_review', 'human', ?)`
    ).bind(candidateId, account.accountId, signal?.signal_id || null, message.reasonForContact, JSON.stringify(message), isoNow()).run();
    let people: Record<string, unknown>[] = [];
    try {
      const discovery = await discoverDecisionMakers(env, candidateId, 5);
      people = discovery.people;
    } catch (error) {
      people = [{ error: String(error) }];
    }
    staged.push({ candidateId, accountId: account.accountId, account: account.name, score: account.score, message, people });
  }
  return staged;
}

export async function outreachQueue(env: Env, limit = 50): Promise<Array<Record<string, unknown>>> {
  const rows = await env.DB.prepare(
    `SELECT oc.*, a.name AS account_name, a.domain, s.title AS trigger_title, s.source_url AS trigger_source,
       p.person_key,p.apollo_person_id,p.full_name AS contact_name,p.title AS contact_title,p.linkedin_url,
       p.work_email,p.email_status,p.safe_to_send,p.verification_provider,p.contact_allowed,p.contact_reason,p.enrichment_status,
       (SELECT COUNT(*) FROM outreach_people px WHERE px.candidate_id=oc.candidate_id) AS people_count
     FROM outreach_candidates oc
     JOIN commercial_accounts a ON a.account_id=oc.account_id
     LEFT JOIN commercial_signals s ON s.signal_id=oc.trigger_signal_id
     LEFT JOIN outreach_people p ON p.person_key=oc.selected_person_key
     WHERE oc.status IN ('ready_for_review','approved')
     ORDER BY CASE oc.status WHEN 'approved' THEN 1 ELSE 2 END, oc.created_at DESC LIMIT ?`
  ).bind(Math.max(1, Math.min(200, limit))).all<any>();
  return rows.results.map((row) => ({ ...row, message: JSON.parse(row.message_json || "{}") }));
}

export async function updateOutreachCandidate(
  env: Env,
  candidateId: string,
  status: "approved" | "rejected" | "sent" | "paused"
): Promise<void> {
  const now = isoNow();
  await env.DB.prepare(
    `UPDATE outreach_candidates
     SET status=?, approved_at=CASE WHEN ?='approved' THEN ? ELSE approved_at END,
         sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END
     WHERE candidate_id=?`
  ).bind(status, status, now, status, now, candidateId).run();
}

export async function createCampaignHypothesis(
  env: Env,
  input: { accountId?: string | null; opportunityId?: string | null; segment?: string | null; triggerType?: string | null; buyerRole?: string | null; channel: string; angle: string; cta: string }
): Promise<string> {
  const hypothesisId = id("hyp");
  await env.DB.prepare(
    `INSERT INTO campaign_hypotheses (
      hypothesis_id, account_id, opportunity_id, segment, trigger_type, buyer_role,
      channel, angle, cta, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
  ).bind(
    hypothesisId, input.accountId || null, input.opportunityId || null, input.segment || null,
    input.triggerType || null, input.buyerRole || null, input.channel, input.angle, input.cta, isoNow()
  ).run();
  return hypothesisId;
}

export async function recordCampaignEvent(
  env: Env,
  input: { hypothesisId: string; eventType: string; numericValue?: number | null; metadata?: Record<string, unknown> }
): Promise<string> {
  const eventId = id("cevt");
  await env.DB.prepare(
    "INSERT INTO campaign_events (event_id,hypothesis_id,event_type,numeric_value,metadata_json,occurred_at) VALUES (?,?,?,?,?,?)"
  ).bind(eventId, input.hypothesisId, input.eventType, input.numericValue || null, JSON.stringify(input.metadata || {}), isoNow()).run();
  return eventId;
}

export async function hypothesisPerformance(env: Env, limit = 100): Promise<Array<Record<string, unknown>>> {
  const rows = await env.DB.prepare(
    `SELECT h.hypothesis_id,h.segment,h.trigger_type,h.buyer_role,h.channel,h.angle,h.cta,
       COUNT(e.event_id) AS event_count,
       SUM(CASE WHEN e.event_type IN ('positive_reply','meeting','proposal','won') THEN 1 ELSE 0 END) AS positive_events,
       SUM(CASE WHEN e.event_type='won' THEN 1 ELSE 0 END) AS wins
     FROM campaign_hypotheses h
     LEFT JOIN campaign_events e ON e.hypothesis_id=h.hypothesis_id
     GROUP BY h.hypothesis_id
     ORDER BY wins DESC, positive_events DESC, event_count DESC LIMIT ?`
  ).bind(Math.max(1, Math.min(500, limit))).all<any>();
  return rows.results;
}


export async function prepareOutreachContact(
  env: Env,
  candidateId: string,
  input: { personKey?: string | null; enrich?: boolean }
): Promise<Record<string, unknown>> {
  const discovered = await discoverDecisionMakers(env, candidateId, 8);
  if (!input.enrich) return discovered;
  return enrichDecisionMaker(env, candidateId, input.personKey || discovered.selectedPersonKey || null);
}

export async function sendOutreachCandidate(env: Env, candidateId: string): Promise<Record<string, unknown>> {
  return sendApprovedOutreachCandidate(env, candidateId);
}
