import type { Env } from "../types";
import { getLeadBundle } from "../db";
import { id, isoNow } from "../lib/ids";
import { aiJson } from "../services/ai";
import { searchWeb } from "../services/search";
import { addSignal, ensureCommercialAccountFromLead } from "./acquisition";
import type { CommercialDocumentDraft, NextBestMessage } from "./types";

export async function createOpportunityFromLead(env: Env, leadId: string): Promise<string> {
  const accountId = await ensureCommercialAccountFromLead(env, leadId);
  const lead = await env.DB.prepare("SELECT * FROM leads WHERE lead_id = ?").bind(leadId).first<any>();
  if (!lead) throw new Error("lead_not_found");
  const existing = await env.DB.prepare(
    "SELECT opportunity_id FROM opportunities WHERE lead_id = ? AND stage NOT IN ('won','lost','closed') LIMIT 1"
  ).bind(leadId).first<{ opportunity_id: string }>();
  if (existing) return existing.opportunity_id;
  const opportunityId = id("opp");
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO opportunities (
      opportunity_id, account_id, lead_id, name, stage, probability, source, current_problem,
      next_action, next_action_at, last_activity_at, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'qualified', 35, 'inbound_growth_brief', ?, ?, ?, ?, '{}', ?, ?)`
  ).bind(
    opportunityId,
    accountId,
    leadId,
    lead.company + " — ClientMotive opportunity",
    lead.problem,
    "Review the evidence-backed dossier and decide the most useful next conversation.",
    now,
    now,
    now,
    now
  ).run();
  return opportunityId;
}

export async function nextBestMessage(env: Env, accountId: string): Promise<NextBestMessage> {
  const [account, signals, opportunity] = await Promise.all([
    env.DB.prepare("SELECT * FROM commercial_accounts WHERE account_id = ?").bind(accountId).first<any>(),
    env.DB.prepare("SELECT * FROM commercial_signals WHERE account_id = ? ORDER BY captured_at DESC LIMIT 12").bind(accountId).all<any>(),
    env.DB.prepare("SELECT * FROM opportunities WHERE account_id = ? AND stage NOT IN ('won','lost','closed') ORDER BY updated_at DESC LIMIT 1").bind(accountId).first<any>()
  ]);
  if (!account) throw new Error("account_not_found");
  const evidence = signals.results.filter((row) => row.source_url).map((row) => row.source_url);
  const strongest = signals.results[0];
  const fallback: NextBestMessage = {
    reasonForContact: strongest ? strongest.title : "No current trigger is strong enough to justify proactive contact.",
    evidence,
    likelyPain: opportunity?.current_problem || "Unknown until further research.",
    objectionRisk: "Avoid contacting without a current, verifiable reason.",
    ask: "A low-friction conversation only if the current context is relevant.",
    draft: strongest
      ? `I noticed ${strongest.title.toLowerCase()}. I may be wrong about the significance, but it looked relevant to the commercial work around ${account.name}. Would it be useful to compare notes?`
      : ""
  };
  return aiJson<NextBestMessage>(
    env,
    "You are ClientMotive's evidence-led outreach strategist. Write a concise next-best-message recommendation. Never pretend to know a person's private priorities. Do not use fake familiarity or generic compliments.",
    `ACCOUNT: ${JSON.stringify(account)}\nOPEN OPPORTUNITY: ${JSON.stringify(opportunity || {})}\nVERIFIED SIGNALS: ${JSON.stringify(signals.results)}\nReturn reasonForContact, evidence[], likelyPain, objectionRisk, ask, draft. If there is no defensible reason for contact, return an empty draft and recommend more research.`,
    fallback
  );
}

async function saveDocument(
  env: Env,
  input: { leadId?: string | null; opportunityId?: string | null; documentType: string; title: string; content: unknown }
): Promise<string> {
  const documentId = id("doc");
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO commercial_documents (
      document_id, lead_id, opportunity_id, document_type, title, content_json, status, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)`
  ).bind(
    documentId,
    input.leadId || null,
    input.opportunityId || null,
    input.documentType,
    input.title,
    JSON.stringify(input.content),
    now,
    now
  ).run();
  return documentId;
}

export async function generateCommercialDocument(
  env: Env,
  input: {
    type: "scope" | "proposal" | "campaign_architecture" | "market_entry" | "icp_sprint" | "competitive_positioning";
    leadId: string;
    opportunityId?: string | null;
  }
): Promise<{ documentId: string; draft: CommercialDocumentDraft }> {
  const bundle = await getLeadBundle(env, input.leadId);
  const lead = bundle.lead as any;
  const productContext =
    input.type === "scope" ? "Define a recommended scope, deliverables, assumptions and client inputs." :
    input.type === "proposal" ? "Prepare a proposal structure. Do not invent price, guarantees or case studies." :
    input.type === "campaign_architecture" ? "Define ICP, account selection, triggers, buyer roles, message hypotheses, channels and measurement." :
    input.type === "market_entry" ? "Assess market attractiveness, alternatives, buyer roles, routes to market, risks and a staged validation plan." :
    input.type === "icp_sprint" ? "Define ICP segments, exclusions, triggers, economic buyer, champion, users and initial target-account logic." :
    "Define competitive categories, positioning gaps, reasons to believe and evidence-led message territories.";

  const fallback: CommercialDocumentDraft = {
    title: input.type.replaceAll("_", " ") + " — " + (lead.company || "ClientMotive opportunity"),
    sections: [
      { heading: "Commercial context", body: lead.problem || "" },
      { heading: "Desired outcome", body: lead.outcome || "" },
      { heading: "Recommended next step", body: "Human-review the dossier and agree the narrowest useful scope before making commitments." }
    ],
    assumptions: ["Commercial terms, delivery dates and any performance commitments require human approval."],
    humanApprovalRequired: true
  };

  const draft = await aiJson<CommercialDocumentDraft>(
    env,
    "You are a senior ClientMotive commercial consultant. Draft decision-ready client work from verified stored context. Never invent prices, guarantees, testimonials, client proof or facts.",
    `DOCUMENT TYPE: ${input.type}\nTASK: ${productContext}\nLEAD BUNDLE: ${JSON.stringify(bundle)}\nReturn title, sections[{heading,body}], assumptions[], humanApprovalRequired=true.`,
    fallback,
    2200
  );
  draft.humanApprovalRequired = true;
  const documentId = await saveDocument(env, {
    leadId: input.leadId,
    opportunityId: input.opportunityId || null,
    documentType: input.type,
    title: draft.title,
    content: draft
  });
  return { documentId, draft };
}

export async function prepareMeeting(
  env: Env,
  input: { leadId: string; opportunityId?: string | null; scheduledAt?: string | null; attendees?: string[] }
): Promise<{ meetingId: string; brief: Record<string, unknown> }> {
  const bundle = await getLeadBundle(env, input.leadId);
  const lead = bundle.lead as any;
  const brief = await aiJson<Record<string, unknown>>(
    env,
    "You prepare one-page B2B sales-call briefs. Separate known facts from questions. Never infer private facts about attendees.",
    `LEAD/RESEARCH: ${JSON.stringify(bundle)}\nATTENDEES: ${JSON.stringify(input.attendees || [])}\nReturn JSON with objectives[], knownContext[], questions[], risks[], evidenceToReference[], avoid[].`,
    {
      objectives: ["Understand whether the stated problem is commercially important enough to act on."],
      knownContext: [lead.problem, lead.outcome].filter(Boolean),
      questions: ["What has changed that makes this important now?", "What would make an engagement worthwhile?"],
      risks: ["Do not treat research hypotheses as facts."],
      evidenceToReference: [],
      avoid: ["Unsupported promises"]
    }
  );
  const meetingId = id("meeting");
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO meetings (
      meeting_id, opportunity_id, lead_id, scheduled_at, attendees_json, brief_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?)`
  ).bind(meetingId, input.opportunityId || null, input.leadId, input.scheduledAt || null, JSON.stringify(input.attendees || []), JSON.stringify(brief), now, now).run();
  return { meetingId, brief };
}

export async function followUpMeeting(
  env: Env,
  meetingId: string,
  input: { notes?: string; transcript?: string }
): Promise<Record<string, unknown>> {
  const meeting = await env.DB.prepare("SELECT * FROM meetings WHERE meeting_id = ?").bind(meetingId).first<any>();
  if (!meeting) throw new Error("meeting_not_found");
  const source = [input.notes || "", input.transcript || ""].join("\n").slice(0, 40_000);
  const followup = await aiJson<Record<string, unknown>>(
    env,
    "You analyse a commercial meeting. Extract commitments and uncertainties faithfully. Draft external follow-up for human approval; do not add promises that were not made.",
    `MEETING SOURCE:\n${source}\nPRE-MEETING BRIEF:\n${meeting.brief_json || "{}"}\nReturn summary, commitments[], openQuestions[], objections[], nextSteps[], followupDraft, opportunityUpdate{stage,probability,nextAction}.`,
    {
      summary: "Meeting notes captured for human review.",
      commitments: [],
      openQuestions: [],
      objections: [],
      nextSteps: [],
      followupDraft: "",
      opportunityUpdate: {}
    },
    1800
  );
  await env.DB.prepare(
    "UPDATE meetings SET notes_text = ?, transcript_text = ?, followup_json = ?, status = 'completed', updated_at = ? WHERE meeting_id = ?"
  ).bind(input.notes || null, input.transcript || null, JSON.stringify(followup), isoNow(), meetingId).run();
  return followup;
}

export async function rescueStaleOpportunities(env: Env, staleDays = 21, limit = 20): Promise<number> {
  const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT o.*, a.domain, a.name AS account_name
     FROM opportunities o JOIN commercial_accounts a ON a.account_id = o.account_id
     WHERE o.stage NOT IN ('won','lost','closed') AND COALESCE(o.last_activity_at, o.created_at) < ?
     ORDER BY COALESCE(o.value_estimate,0) DESC LIMIT ?`
  ).bind(cutoff, Math.max(1, Math.min(50, limit))).all<any>();
  let changed = 0;
  for (const row of rows.results) {
    let reason = "Opportunity is stale; research for a meaningful change before re-engaging.";
    if (row.domain) {
      try {
        const results = await searchWeb(env, `"${row.account_name}" ${row.domain} hiring expansion launch partnership news`, 4);
        if (results[0]) {
          reason = "New public context may justify re-engagement: " + results[0].title;
          await addSignal(env, {
            accountId: row.account_id,
            signalType: "opportunity_rescue",
            title: results[0].title,
            detail: results[0].snippet,
            sourceUrl: results[0].url,
            confidence: 55
          });
        }
      } catch {}
    }
    await env.DB.prepare(
      "UPDATE opportunities SET next_action = ?, next_action_at = ?, updated_at = ? WHERE opportunity_id = ?"
    ).bind(reason, isoNow(), isoNow(), row.opportunity_id).run();
    changed += 1;
  }
  return changed;
}

export async function enrollProblemNurture(
  env: Env,
  input: { leadId?: string | null; accountId?: string | null; problemCategory: string; consent?: Record<string, unknown> }
): Promise<string> {
  const enrollmentId = id("nurture");
  const now = isoNow();
  const next = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO nurture_enrollments (
      enrollment_id, lead_id, account_id, problem_category, status, next_touch_at,
      content_json, consent_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, '[]', ?, ?, ?)`
  ).bind(enrollmentId, input.leadId || null, input.accountId || null, input.problemCategory, next, JSON.stringify(input.consent || {}), now, now).run();
  return enrollmentId;
}
