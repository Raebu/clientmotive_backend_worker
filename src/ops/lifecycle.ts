import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import { aiJson } from "../services/ai";
import { searchMany } from "../services/search";

export async function upsertProcurementProfile(env:Env,input:{
  accountId:string;securityReview?:boolean;dpaRequired?:boolean;insuranceRequired?:boolean;vendorPortal?:string|null;
  paymentTermsDays?:number|null;frameworkRequired?:boolean;requirements?:Record<string,unknown>;blockers?:string[];
}):Promise<void>{
  await env.DB.prepare(
    `INSERT INTO procurement_profiles (
      procurement_id,account_id,security_review,dpa_required,insurance_required,vendor_portal,payment_terms_days,
      framework_required,requirements_json,blockers_json,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET security_review=excluded.security_review,dpa_required=excluded.dpa_required,
      insurance_required=excluded.insurance_required,vendor_portal=excluded.vendor_portal,payment_terms_days=excluded.payment_terms_days,
      framework_required=excluded.framework_required,requirements_json=excluded.requirements_json,blockers_json=excluded.blockers_json,updated_at=excluded.updated_at`
  ).bind(id("proc"),input.accountId,input.securityReview?1:0,input.dpaRequired?1:0,input.insuranceRequired?1:0,input.vendorPortal || null,input.paymentTermsDays || null,input.frameworkRequired?1:0,JSON.stringify(input.requirements || {}),JSON.stringify(input.blockers || []),isoNow()).run();
}

export async function discoverTenders(env:Env,input:{tenantId?:string;query:string;limit?:number}):Promise<Record<string,unknown>[]>{
  const groups=await searchMany(env,[input.query+" tender procurement","site:find-tender.service.gov.uk "+input.query,"site:contracts-finder.service.gov.uk "+input.query],8);
  const evidence=groups.flatMap((g)=>g.results.map((r)=>({query:g.query,title:r.title,url:r.url,snippet:r.snippet})));
  const result=await aiJson<{tenders:Array<{externalId:string|null;title:string;buyer:string|null;sourceUrl:string;deadline:string|null;valueEstimate:number|null;fitScore:number;effortScore:number;competitionScore:number;reason:string}>}>(
    env,
    "You triage public procurement opportunities. Only include tenders clearly present in supplied evidence. Do not invent deadlines or values.",
    `QUERY: ${input.query}\nEVIDENCE: ${JSON.stringify(evidence)}\nReturn {"tenders":[...]} with externalId|null,title,buyer|null,sourceUrl,deadline|null,valueEstimate|null,fitScore 0-100,effortScore 0-100,competitionScore 0-100,reason.`,
    {tenders:[]},
    1500
  );
  const tenantId=input.tenantId || "tenant_clientmotive";
  const saved=[] as Record<string,unknown>[];
  for(const tender of result.tenders.slice(0,Math.max(1,Math.min(30,input.limit || 15)))){
    if(!tender.sourceUrl) continue;
    const external=tender.externalId || tender.sourceUrl;
    const existing=await env.DB.prepare("SELECT tender_id FROM tender_opportunities WHERE tenant_id=? AND external_id=? LIMIT 1").bind(tenantId,external).first<{tender_id:string}>();
    const tenderId=existing?.tender_id || id("tender");
    if(existing){
      await env.DB.prepare(
        "UPDATE tender_opportunities SET title=?,buyer=?,source_url=?,deadline=?,value_estimate=?,fit_score=?,effort_score=?,competition_score=?,evidence_json=?,updated_at=? WHERE tender_id=?"
      ).bind(tender.title,tender.buyer || null,tender.sourceUrl,tender.deadline || null,tender.valueEstimate || null,tender.fitScore,tender.effortScore,tender.competitionScore,JSON.stringify([tender.sourceUrl]),isoNow(),tenderId).run();
    }else{
      await env.DB.prepare(
        `INSERT INTO tender_opportunities (
          tender_id,tenant_id,external_id,title,buyer,source_url,deadline,value_estimate,fit_score,effort_score,competition_score,status,evidence_json,metadata_json,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'discovered',?,'{}',?,?)`
      ).bind(tenderId,tenantId,external,tender.title,tender.buyer || null,tender.sourceUrl,tender.deadline || null,tender.valueEstimate || null,tender.fitScore,tender.effortScore,tender.competitionScore,JSON.stringify([tender.sourceUrl]),isoNow(),isoNow()).run();
    }
    saved.push({tenderId,...tender});
  }
  return saved;
}

export async function recordAgreement(env:Env,input:{tenantId?:string;opportunityId?:string|null;accountId:string;provider?:string|null;externalId?:string|null;title:string;status:string;signedAt?:string|null;contentHash?:string|null;metadata?:Record<string,unknown>}):Promise<string>{
  const existing=input.externalId?await env.DB.prepare("SELECT agreement_id FROM agreements WHERE provider=? AND external_id=? LIMIT 1").bind(input.provider || "generic",input.externalId).first<{agreement_id:string}>():null;
  const now=isoNow();
  if(existing){
    await env.DB.prepare("UPDATE agreements SET status=?,signed_at=?,metadata_json=?,updated_at=? WHERE agreement_id=?")
      .bind(input.status,input.signedAt || null,JSON.stringify(input.metadata || {}),now,existing.agreement_id).run();
    return existing.agreement_id;
  }
  const agreementId=id("agreement");
  await env.DB.prepare(
    `INSERT INTO agreements (
      agreement_id,tenant_id,opportunity_id,account_id,provider,external_id,title,status,signed_at,content_hash,metadata_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(agreementId,input.tenantId || "tenant_clientmotive",input.opportunityId || null,input.accountId,input.provider || null,input.externalId || null,input.title,input.status,input.signedAt || null,input.contentHash || null,JSON.stringify(input.metadata || {}),now,now).run();
  return agreementId;
}

export async function recordBillingEvent(env:Env,input:{tenantId?:string;accountId?:string|null;opportunityId?:string|null;provider:string;externalId?:string|null;eventType:string;amount?:number|null;currency?:string;status?:string|null;occurredAt?:string;metadata?:Record<string,unknown>}):Promise<string>{
  if(input.externalId){
    const existing=await env.DB.prepare("SELECT billing_event_id FROM billing_events WHERE provider=? AND external_id=? LIMIT 1").bind(input.provider,input.externalId).first<{billing_event_id:string}>();
    if(existing) return existing.billing_event_id;
  }
  const eventId=id("bill");
  await env.DB.prepare(
    `INSERT INTO billing_events (
      billing_event_id,tenant_id,account_id,opportunity_id,provider,external_id,event_type,amount,currency,status,occurred_at,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(eventId,input.tenantId || "tenant_clientmotive",input.accountId || null,input.opportunityId || null,input.provider,input.externalId || null,input.eventType,input.amount || null,input.currency || "GBP",input.status || null,input.occurredAt || isoNow(),JSON.stringify(input.metadata || {})).run();
  return eventId;
}

export async function startOnboarding(env:Env,input:{tenantId?:string;accountId:string;opportunityId?:string|null;communicationCadence?:string;checklist?:unknown[];kpis?:unknown[]}):Promise<string>{
  const onboardingId=id("onboard");
  const now=isoNow();
  const checklist=input.checklist || [
    {item:"Confirm commercial objectives and success measures",status:"open"},
    {item:"Confirm ICP/buyer scope and exclusions",status:"open"},
    {item:"Confirm data access, consent and communication boundaries",status:"open"},
    {item:"Create account/watchlist portfolio",status:"open"},
    {item:"Schedule first intelligence/delivery review",status:"open"}
  ];
  await env.DB.prepare(
    `INSERT INTO onboarding_plans (
      onboarding_id,tenant_id,account_id,opportunity_id,status,checklist_json,kpis_json,communication_cadence,started_at,created_at,updated_at
    ) VALUES (?,?,?,?,'active',?,?,?,?,?,?)`
  ).bind(onboardingId,input.tenantId || "tenant_clientmotive",input.accountId,input.opportunityId || null,JSON.stringify(checklist),JSON.stringify(input.kpis || []),input.communicationCadence || "monthly",now,now,now).run();
  return onboardingId;
}

export async function addDeliveryMilestone(env:Env,input:{tenantId?:string;accountId:string;opportunityId?:string|null;milestoneType:string;title:string;dueAt?:string|null;metadata?:Record<string,unknown>}):Promise<string>{
  const milestoneId=id("mile");
  const now=isoNow();
  await env.DB.prepare(
    `INSERT INTO delivery_milestones (
      milestone_id,tenant_id,account_id,opportunity_id,milestone_type,title,due_at,status,metadata_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,'planned',?,?,?)`
  ).bind(milestoneId,input.tenantId || "tenant_clientmotive",input.accountId,input.opportunityId || null,input.milestoneType,input.title,input.dueAt || null,JSON.stringify(input.metadata || {}),now,now).run();
  return milestoneId;
}

export async function completeMilestone(env:Env,milestoneId:string,qualityScore?:number):Promise<void>{
  await env.DB.prepare("UPDATE delivery_milestones SET status='complete',completed_at=?,quality_score=?,updated_at=? WHERE milestone_id=?")
    .bind(isoNow(),qualityScore===undefined?null:Math.max(0,Math.min(100,qualityScore)),isoNow(),milestoneId).run();
}

export async function timeToValue(env:Env,accountId:string):Promise<Record<string,unknown>>{
  const [agreement,onboarding,firstResearch,firstCampaign,firstMeeting,firstRevenue]=await Promise.all([
    env.DB.prepare("SELECT COALESCE(signed_at,created_at) AS start FROM agreements WHERE account_id=? AND status IN ('signed','active') ORDER BY COALESCE(signed_at,created_at) LIMIT 1").bind(accountId).first<{start:string}>(),
    env.DB.prepare("SELECT started_at FROM onboarding_plans WHERE account_id=? ORDER BY created_at LIMIT 1").bind(accountId).first<{started_at:string}>(),
    env.DB.prepare("SELECT completed_at FROM delivery_milestones WHERE account_id=? AND milestone_type='research' AND status='complete' ORDER BY completed_at LIMIT 1").bind(accountId).first<{completed_at:string}>(),
    env.DB.prepare("SELECT completed_at FROM delivery_milestones WHERE account_id=? AND milestone_type='campaign_live' AND status='complete' ORDER BY completed_at LIMIT 1").bind(accountId).first<{completed_at:string}>(),
    env.DB.prepare("SELECT oo.occurred_at FROM opportunity_outcomes oo JOIN opportunities o ON o.opportunity_id=oo.opportunity_id WHERE o.account_id=? AND oo.outcome_type='meeting' ORDER BY oo.occurred_at LIMIT 1").bind(accountId).first<{occurred_at:string}>(),
    env.DB.prepare("SELECT occurred_at FROM billing_events WHERE account_id=? AND event_type IN ('payment_succeeded','invoice_paid') ORDER BY occurred_at LIMIT 1").bind(accountId).first<{occurred_at:string}>()
  ]);
  const start=agreement?.start || onboarding?.started_at || null;
  const days=(date?:string|null)=>start&&date?Math.max(0,Math.round((new Date(date).getTime()-new Date(start).getTime())/86_400_000)):null;
  return {startAt:start,daysToFirstResearch:days(firstResearch?.completed_at),daysToCampaignLive:days(firstCampaign?.completed_at),daysToFirstMeeting:days(firstMeeting?.occurred_at),daysToFirstRealisedRevenue:days(firstRevenue?.occurred_at)};
}

export async function customerSuccessState(env:Env,accountId:string):Promise<Record<string,unknown>>{
  const [health,contacts,signals]=await Promise.all([
    env.DB.prepare("SELECT * FROM client_health WHERE account_id=?").bind(accountId).first<any>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM contact_roles WHERE account_id=? AND role_type IN ('champion','economic_buyer')").bind(accountId).first<{count:number}>(),
    env.DB.prepare("SELECT signal_type FROM commercial_signals WHERE account_id=? AND captured_at>=datetime('now','-45 days')").bind(accountId).all<{signal_type:string}>()
  ]);
  const sponsorLost=signals.results.some((r)=>r.signal_type==="buyer_change") && Number(contacts?.count || 0)===0;
  const healthScore=Number(health?.health_score || 50);
  const expansion=Number(health?.expansion_score || 50);
  const state=sponsorLost?"sponsor_lost":healthScore<45?"weak_outcomes":healthScore>=65&&expansion>=70?"healthy_expanding":healthScore>=65?"healthy_flat":"weak_engagement";
  const playbook=await env.DB.prepare("SELECT * FROM customer_success_playbooks WHERE health_state=? AND active=1 LIMIT 1").bind(state).first<any>();
  return {state,health:health || null,actions:playbook?JSON.parse(playbook.actions_json || "[]"):[]};
}

export async function refreshPartnerEconomics(env:Env,partnerId:string):Promise<Record<string,unknown>>{
  const partner=await env.DB.prepare("SELECT * FROM partner_candidates WHERE partner_id=?").bind(partnerId).first<any>();
  if(!partner) throw new Error("partner_not_found");
  const referrals=await env.DB.prepare("SELECT * FROM referrals WHERE referrer_id=?").bind(partnerId).all<any>();
  let meetings=0,wins=0,revenue=0;
  for(const referral of referrals.results){
    if(!referral.referred_account_id) continue;
    const stats=await env.DB.prepare(
      `SELECT
       SUM(CASE WHEN oo.outcome_type='meeting' THEN 1 ELSE 0 END) AS meetings,
       SUM(CASE WHEN oo.outcome_type='won' THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN oo.outcome_type='won' THEN COALESCE(oo.value,0) ELSE 0 END) AS revenue
       FROM opportunity_outcomes oo JOIN opportunities o ON o.opportunity_id=oo.opportunity_id
       WHERE o.account_id=?`
    ).bind(referral.referred_account_id).first<any>();
    meetings+=Number(stats?.meetings || 0);wins+=Number(stats?.wins || 0);revenue+=Number(stats?.revenue || 0);
  }
  const score=Math.max(0,Math.min(100,Math.round(30+Math.min(25,referrals.results.length*3)+Math.min(20,meetings*4)+Math.min(25,wins*8))));
  await env.DB.prepare(
    `INSERT INTO partner_performance (partner_id,introductions,meetings,wins,attributed_revenue,estimated_margin,score,updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(partner_id) DO UPDATE SET introductions=excluded.introductions,meetings=excluded.meetings,wins=excluded.wins,
       attributed_revenue=excluded.attributed_revenue,estimated_margin=excluded.estimated_margin,score=excluded.score,updated_at=excluded.updated_at`
  ).bind(partnerId,referrals.results.length,meetings,wins,revenue,0,score,isoNow()).run();
  return {partnerId,introductions:referrals.results.length,meetings,wins,attributedRevenue:revenue,score};
}
