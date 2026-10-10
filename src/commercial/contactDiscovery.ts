import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import { canContact, ingestCommunication, upsertContact, verifyEmailIfConfigured } from "../ops/crm";

const SENIORITIES = ["owner","founder","c_suite","partner","vp","head","director"];

function cleanDomain(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0] || "";
}

async function candidateContext(env: Env, candidateId: string): Promise<any> {
  const row = await env.DB.prepare(
    `SELECT oc.*,a.name AS account_name,a.domain
     FROM outreach_candidates oc
     JOIN commercial_accounts a ON a.account_id=oc.account_id
     WHERE oc.candidate_id=? LIMIT 1`
  ).bind(candidateId).first<any>();
  if (!row) throw new Error("outreach_candidate_not_found");
  return row;
}

export async function discoverDecisionMakers(
  env: Env,
  candidateId: string,
  limit = 5
): Promise<{ configured: boolean; people: Record<string, unknown>[]; selectedPersonKey: string | null }> {
  const context = await candidateContext(env, candidateId);
  const domain = cleanDomain(context.domain);
  if (!env.APOLLO_API_KEY || !domain) return { configured: Boolean(env.APOLLO_API_KEY), people: [], selectedPersonKey: context.selected_person_key || null };

  const url = new URL("https://api.apollo.io/api/v1/mixed_people/api_search");
  url.searchParams.append("q_organization_domains_list[]", domain);
  for (const seniority of SENIORITIES) url.searchParams.append("person_seniorities[]", seniority);
  url.searchParams.set("page", "1");
  url.searchParams.set("per_page", String(Math.max(1, Math.min(10, limit))));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": env.APOLLO_API_KEY
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("apollo_people_search_" + response.status);
  const payload = await response.json() as any;
  const people = Array.isArray(payload?.people) ? payload.people : Array.isArray(payload?.contacts) ? payload.contacts : [];
  const stored: Record<string, unknown>[] = [];
  let selectedPersonKey: string | null = context.selected_person_key || null;

  for (const person of people.slice(0, Math.max(1, Math.min(10, limit)))) {
    const apolloPersonId = String(person.id || person.person_id || "").trim();
    if (!apolloPersonId) continue;
    const fullName = String(person.name || [person.first_name, person.last_name].filter(Boolean).join(" ") || "").trim().slice(0,160);
    const title = String(person.title || "").trim().slice(0,180);
    const linkedinUrl = String(person.linkedin_url || "").trim().slice(0,500) || null;
    const existing = await env.DB.prepare(
      "SELECT person_key FROM outreach_people WHERE candidate_id=? AND apollo_person_id=? LIMIT 1"
    ).bind(candidateId, apolloPersonId).first<{person_key:string}>();
    const personKey = existing?.person_key || id("operson");
    const now = isoNow();
    await env.DB.prepare(
      `INSERT INTO outreach_people (
        person_key,candidate_id,account_id,apollo_person_id,full_name,title,linkedin_url,
        enrichment_status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,'research_only',?,?)
      ON CONFLICT(candidate_id,apollo_person_id) DO UPDATE SET
        full_name=excluded.full_name,title=excluded.title,linkedin_url=excluded.linkedin_url,updated_at=excluded.updated_at`
    ).bind(personKey,candidateId,context.account_id,apolloPersonId,fullName,title,linkedinUrl,now,now).run();
    if (!selectedPersonKey) selectedPersonKey = personKey;
    stored.push({ personKey, apolloPersonId, fullName, title, linkedinUrl, enrichmentStatus: "research_only" });
  }

  if (selectedPersonKey) {
    await env.DB.prepare(
      `UPDATE outreach_candidates SET selected_person_key=?,
        buyer_role=COALESCE(buyer_role,(SELECT title FROM outreach_people WHERE person_key=?))
       WHERE candidate_id=?`
    ).bind(selectedPersonKey,selectedPersonKey,candidateId).run();
  }
  return { configured: true, people: stored, selectedPersonKey };
}

export async function enrichDecisionMaker(
  env: Env,
  candidateId: string,
  requestedPersonKey: string | null
): Promise<Record<string, unknown>> {
  if (!env.APOLLO_API_KEY) return { configured: false, status: "apollo_not_configured" };
  const context = await candidateContext(env, candidateId);
  const personKey = requestedPersonKey || context.selected_person_key;
  if (!personKey) return { configured: true, status: "no_person_selected" };

  const person = await env.DB.prepare(
    "SELECT * FROM outreach_people WHERE person_key=? AND candidate_id=? LIMIT 1"
  ).bind(personKey,candidateId).first<any>();
  if (!person) throw new Error("outreach_person_not_found");

  const domain = cleanDomain(context.domain);
  const url = new URL("https://api.apollo.io/api/v1/people/match");
  url.searchParams.set("id", person.apollo_person_id);
  if (domain) url.searchParams.set("domain", domain);
  url.searchParams.set("reveal_personal_emails", "false");
  url.searchParams.set("reveal_phone_number", "false");
  url.searchParams.set("run_waterfall_email", "false");
  url.searchParams.set("run_waterfall_phone", "false");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": env.APOLLO_API_KEY
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error("apollo_people_match_" + response.status);
  const payload = await response.json() as any;
  const enriched = payload?.person || payload?.contact || {};
  const rawEmail = String(enriched.email || "").trim().toLowerCase();
  const email = rawEmail && !rawEmail.includes("email_not_unlocked@") ? rawEmail : "";
  const emailDomain = cleanDomain(email.split("@")[1] || "");
  const corporateMatch = Boolean(email && domain && (emailDomain === domain || emailDomain.endsWith("." + domain)));

  if (!corporateMatch) {
    await env.DB.prepare(
      `UPDATE outreach_people SET work_email=NULL,email_domain=NULL,email_source='apollo',
       email_status='no_corporate_email',safe_to_send=0,contact_allowed=0,
       contact_reason='Apollo did not return a corporate-domain work email.',enrichment_status='blocked',updated_at=?
       WHERE person_key=?`
    ).bind(isoNow(),personKey).run();
    return { configured: true, status: "no_corporate_email", personKey, corporateMatch: false };
  }

  const verification = await verifyEmailIfConfigured(env, email);
  const verificationStatus = String(verification.status || "unknown").toLowerCase();
  const riskScore = Number(verification.riskScore ?? 50);
  const safeFromProvider = verification.safeToSend === true || verification.safeToSend === "true";
  const safeToSend = safeFromProvider || (["valid","deliverable"].includes(verificationStatus) && riskScore < 35);
  const contact = await canContact(env,{email,channel:"email",purpose:"business_development"});
  const allowed = contact.allowed && safeToSend;

  const contactId = allowed ? await upsertContact(env,{
    accountId: context.account_id,
    fullName: String(enriched.name || person.full_name || "").slice(0,160),
    email,
    source: "apollo",
    confidence: String(payload?.match_confidence || "").toLowerCase()==="high"?95:75
  }) : null;

  await env.DB.prepare(
    `UPDATE outreach_people SET full_name=?,title=?,linkedin_url=?,work_email=?,email_domain=?,email_source='apollo',
      email_status=?,safe_to_send=?,verification_provider=?,verification_json=?,contact_allowed=?,contact_reason=?,
      contact_id=?,enrichment_status=?,updated_at=? WHERE person_key=?`
  ).bind(
    String(enriched.name || person.full_name || "").slice(0,160),
    String(enriched.title || person.title || "").slice(0,180),
    String(enriched.linkedin_url || person.linkedin_url || "").slice(0,500) || null,
    email,emailDomain,verificationStatus,allowed?1:0,String(verification.provider || "none"),
    JSON.stringify(verification),contact.allowed?1:0,String(contact.reason || ""),contactId,
    allowed?"verified":"blocked",isoNow(),personKey
  ).run();
  await env.DB.prepare("UPDATE outreach_candidates SET selected_person_key=?,buyer_role=? WHERE candidate_id=?")
    .bind(personKey,String(enriched.title || person.title || "").slice(0,180),candidateId).run();

  return {
    configured: true,
    status: allowed ? "verified" : "blocked",
    personKey,
    person: { name: enriched.name || person.full_name, title: enriched.title || person.title, linkedinUrl: enriched.linkedin_url || person.linkedin_url },
    email,
    corporateMatch,
    verification,
    contactDecision: contact
  };
}

export async function sendApprovedOutreachCandidate(env: Env, candidateId: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    `SELECT oc.*,a.name AS account_name,p.person_key,p.full_name,p.title,p.work_email,p.safe_to_send,p.contact_allowed,p.contact_id
     FROM outreach_candidates oc
     JOIN commercial_accounts a ON a.account_id=oc.account_id
     LEFT JOIN outreach_people p ON p.person_key=oc.selected_person_key
     WHERE oc.candidate_id=? LIMIT 1`
  ).bind(candidateId).first<any>();
  if (!row) throw new Error("outreach_candidate_not_found");
  if (row.status!=="approved") return { sent:false, status:"not_approved" };
  if (!row.work_email || Number(row.safe_to_send)!==1 || Number(row.contact_allowed)!==1) {
    return { sent:false, status:"contact_not_sendable" };
  }
  if (!env.RESEND_API_KEY) return { sent:false, status:"resend_not_configured" };

  const policy = await canContact(env,{email:row.work_email,channel:"email",purpose:"business_development"});
  if (!policy.allowed) return { sent:false, status:"suppressed", reason:policy.reason };

  const message = JSON.parse(row.message_json || "{}") as any;
  const draft = String(message.draft || "").trim();
  if (!draft) return { sent:false, status:"empty_message" };
  const subject = String(message.subject || ("A quick thought for " + row.account_name)).slice(0,180);

  const response = await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{authorization:"Bearer "+env.RESEND_API_KEY,"content-type":"application/json"},
    body:JSON.stringify({
      from:env.OUTBOUND_FROM || env.ALERT_EMAIL_FROM || "ClientMotive <clientmotive@clientmotive.com>",
      to:[row.work_email],
      reply_to:env.OUTBOUND_REPLY_TO || "contact@clientmotive.com",
      subject,
      text:draft
    }),
    signal:AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(()=>({})) as any;
  if (!response.ok) {
    await env.DB.prepare("UPDATE outreach_candidates SET send_error=? WHERE candidate_id=?")
      .bind("resend_"+response.status,candidateId).run();
    return { sent:false, status:"provider_error", providerStatus:response.status };
  }

  await env.DB.prepare(
    "UPDATE outreach_candidates SET status='sent',sent_at=?,external_message_id=?,send_error=NULL WHERE candidate_id=?"
  ).bind(isoNow(),String(payload.id || ""),candidateId).run();

  await ingestCommunication(env,{
    provider:"resend",
    externalId:String(payload.id || "") || null,
    direction:"outbound",
    channel:"email",
    accountId:row.account_id,
    contactId:row.contact_id || null,
    subject,
    bodyText:draft,
    metadata:{candidateId,reasonForContact:message.reasonForContact || null}
  });

  return { sent:true, status:"sent", id:payload.id || null, email:row.work_email };
}
