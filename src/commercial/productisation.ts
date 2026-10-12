import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import { aiJson } from "../services/ai";
import { buildMarketingCompetitorIntelligence, latestMarketingCompetitorIntelligence } from "./marketingIntelligence";

type ScoreDimension = {
  key: string;
  label: string;
  score: number | null;
  status: "scored" | "needs_data";
  confidence: number;
  why: string;
  improve: string;
};

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function safeJson(value: string | null | undefined, fallback: any) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function strList(value: unknown, max = 8): string[] {
  return Array.isArray(value) ? value.slice(0,max).map((x)=>String(x||"").trim()).filter(Boolean) : [];
}

async function saveDocument(env: Env, input: { leadId: string; opportunityId?: string | null; type: string; title: string; content: unknown }) {
  const documentId=id("doc");
  const now=isoNow();
  await env.DB.prepare(
    `INSERT INTO commercial_documents (document_id,lead_id,opportunity_id,document_type,title,content_json,status,version,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'draft',1,?,?)`
  ).bind(documentId,input.leadId,input.opportunityId||null,input.type,input.title,JSON.stringify(input.content),now,now).run();
  return documentId;
}

export function publicCommercialOffers() {
  return [
    {
      code:"growth_snapshot",
      name:"ClientMotive Growth Snapshot",
      positioning:"Find where your next growth is most likely to come from — and what to do next.",
      price:{currency:"GBP",from:1500,to:3000,unit:"project",label:"£1,500–£3,000"},
      for:"B2B companies that need a clear commercial diagnosis before committing to a larger programme.",
      includes:["Company and market intelligence","Full competitor and alternative landscape","Brand and marketing intelligence","ICP, target-account and buying-committee analysis","Signals, risks and opportunity hypotheses","Executive scorecard","90-day commercial action plan"],
      outcome:"A decision-ready view of where to compete, who to pursue, what to change and what to do next."
    },
    {
      code:"market_intelligence",
      name:"ClientMotive Growth Intelligence",
      positioning:"Know what changed, why it matters and where the next opportunity is.",
      price:{currency:"GBP",from:3000,to:7500,unit:"month",label:"From £3,000/month"},
      for:"Teams that need continuous competitor, market, account and marketing intelligence rather than a one-off report.",
      includes:["Competitor and positioning monitoring","Account and buyer-change signals","Marketing and message monitoring","Executive priority brief","Recommendation tracking","Experiment and outcome learning"],
      outcome:"Continuous decision support with alerts and prioritised commercial recommendations."
    },
    {
      code:"gtm_premium",
      name:"ClientMotive Managed Growth",
      positioning:"Intelligence becomes execution, measurement and learning.",
      price:{currency:"GBP",from:7500,to:20000,unit:"month",label:"From £7,500/month"},
      for:"Companies that want ClientMotive to help execute the growth plan as well as identify it.",
      includes:["Everything in Growth Intelligence","Campaign and outbound execution support","CRM and automation implementation","Content and positioning execution","GTM experimentation","Closed-loop commercial learning"],
      outcome:"A managed commercial-growth system that connects evidence, action and measurable outcomes."
    }
  ];
}

export async function ingestFirstPartyData(
  env: Env,
  input: { accountId: string; sourceType: string; periodStart?: string | null; periodEnd?: string | null; metrics?: Record<string,number>; dimensions?: Record<string,unknown>; provenance?: Record<string,unknown> }
) {
  const account=await env.DB.prepare("SELECT account_id FROM commercial_accounts WHERE account_id=?").bind(input.accountId).first();
  if(!account) throw new Error("account_not_found");
  const metrics:Record<string,number>={};
  for(const [key,value] of Object.entries(input.metrics||{})){
    if(Number.isFinite(value)) metrics[String(key).slice(0,80)]=Number(value);
  }
  const ingestionId=id("ingest");
  await env.DB.prepare(
    `INSERT INTO first_party_ingestions
     (ingestion_id,account_id,source_type,period_start,period_end,metrics_json,dimensions_json,provenance_json,status,ingested_at)
     VALUES (?,?,?,?,?,?,?,?,'accepted',?)`
  ).bind(
    ingestionId,input.accountId,String(input.sourceType||"manual").slice(0,80),
    input.periodStart||null,input.periodEnd||null,JSON.stringify(metrics),
    JSON.stringify(input.dimensions||{}),JSON.stringify(input.provenance||{}),isoNow()
  ).run();

  const map:Record<string,string>={
    conversion_rate:"marketing_conversion_rate",
    pipeline_value:"marketing_pipeline_value",
    revenue_influenced:"marketing_revenue_influenced",
    cac:"marketing_cac",
    cpl:"marketing_cpl",
    roas:"marketing_roas",
    branded_search:"brand_demand",
    churn_rate:"churn_rate",
    nps:"nps"
  };
  for(const [key,value] of Object.entries(metrics)){
    const metricName=map[key];
    if(!metricName) continue;
    await env.DB.prepare(
      "INSERT INTO account_metrics (metric_id,account_id,metric_name,numeric_value,metadata_json,occurred_at) VALUES (?,?,?,?,?,?)"
    ).bind(id("metric"),input.accountId,metricName,value,JSON.stringify({sourceType:input.sourceType,ingestionId}),input.periodEnd||isoNow()).run();
  }
  return {ingestionId,acceptedMetrics:Object.keys(metrics),note:"Stored as first-party evidence; no performance value is inferred when it is not supplied."};
}

export async function buildCommercialScorecard(env: Env, input:{leadId?:string|null;accountId?:string|null}) {
  let leadId=input.leadId||null;
  let accountId=input.accountId||null;
  if(!leadId && accountId){
    const a=await env.DB.prepare("SELECT lead_id FROM commercial_accounts WHERE account_id=?").bind(accountId).first<any>();
    leadId=a?.lead_id||null;
  }
  if(!accountId && leadId){
    const a=await env.DB.prepare("SELECT account_id FROM commercial_accounts WHERE lead_id=? LIMIT 1").bind(leadId).first<any>();
    accountId=a?.account_id||null;
  }
  if(!leadId && !accountId) throw new Error("lead_or_account_required");

  const [leadScore,buyers,targets,signals,report,firstParty] = await Promise.all([
    leadId?env.DB.prepare("SELECT * FROM lead_scores WHERE lead_id=?").bind(leadId).first<any>():null,
    leadId?env.DB.prepare("SELECT COUNT(*) AS count FROM buyer_roles WHERE lead_id=?").bind(leadId).first<any>():null,
    leadId?env.DB.prepare("SELECT COUNT(*) AS count FROM target_accounts WHERE lead_id=?").bind(leadId).first<any>():null,
    accountId?env.DB.prepare("SELECT COUNT(*) AS count, AVG(confidence) AS confidence FROM commercial_signals WHERE account_id=? AND captured_at>=datetime('now','-90 days')").bind(accountId).first<any>():null,
    leadId?latestMarketingCompetitorIntelligence(env,{leadId}):null,
    accountId?env.DB.prepare("SELECT metrics_json FROM first_party_ingestions WHERE account_id=? ORDER BY ingested_at DESC LIMIT 20").bind(accountId).all<any>():null
  ]);

  const firstMetrics:Record<string,number>={};
  for(const row of firstParty?.results||[]){
    const metrics=safeJson(row.metrics_json,{});
    for(const [k,v] of Object.entries(metrics)) if(firstMetrics[k]===undefined && Number.isFinite(Number(v))) firstMetrics[k]=Number(v);
  }
  const comp=(report?.report as any)?.competitiveLandscape||{};
  const opps=strList((report?.report as any)?.opportunities,10);
  const white=strList(comp.whiteSpace,10);
  const buyerCount=Number(buyers?.count||0);
  const targetCount=Number(targets?.count||0);
  const signalCount=Number(signals?.count||0);

  const marketingHasData=["conversion_rate","pipeline_value","revenue_influenced","cac","cpl","roas"].some((k)=>firstMetrics[k]!==undefined);
  const dimensions:ScoreDimension[]=[
    {key:"market_opportunity",label:"Market Opportunity",score:clamp(40+Math.min(25,opps.length*7)+Math.min(20,targetCount*2)+(report?10:0)),status:"scored",confidence:report?.confidence||45,why:opps.length?opps.length+" opportunity hypotheses are supported by the current research.":"Opportunity evidence is still limited.",improve:"Validate addressable segments, buying triggers and target-account economics."},
    {key:"competitive_position",label:"Competitive Position",score:clamp(38+Math.min(24,white.length*8)+(report?Math.min(25,report.confidence/4):0)),status:"scored",confidence:report?.confidence||35,why:white.length?white.length+" potential white-space positions require validation.":"No strong white-space position is yet evidenced.",improve:"Deepen competitor proof, buyer alternatives and differentiation testing."},
    {key:"icp_clarity",label:"ICP Clarity",score:clamp(30+Math.min(35,targetCount*3)+Math.min(25,buyerCount*5)),status:"scored",confidence:leadScore?Number(leadScore.fit||50):45,why:targetCount+" target accounts and "+buyerCount+" buying roles are currently mapped.",improve:"Test exclusions, triggers and fit criteria against real wins and losses."},
    {key:"buyer_access",label:"Buyer Access",score:clamp(25+buyerCount*9+Math.min(20,signalCount*3)),status:"scored",confidence:leadScore?Number(leadScore.access||45):40,why:"Based on mapped buying roles and recent account signals, not assumed personal intent.",improve:"Validate actual stakeholders, influence and contactability on priority accounts."},
    {key:"commercial_timing",label:"Commercial Timing",score:clamp(leadScore?Number(leadScore.timing||45):35+Math.min(35,signalCount*5)),status:"scored",confidence:Math.round(Number(signals?.confidence||45)),why:signalCount?signalCount+" recent signals contribute to the timing view.":"Few recent signals support urgency.",improve:"Monitor leadership, hiring, product, funding, regulation and supplier-change signals."},
    marketingHasData
      ? {key:"marketing_effectiveness",label:"Marketing Effectiveness",score:null,status:"needs_data",confidence:70,why:"First-party marketing metrics are connected, but effectiveness needs a metric-specific benchmark and objective rather than a synthetic vanity score.",improve:"Use connected conversion, pipeline, CAC/CPL/ROAS and lifecycle data against agreed targets."}
      : {key:"marketing_effectiveness",label:"Marketing Effectiveness",score:null,status:"needs_data",confidence:100,why:"Public marketing observations cannot prove campaign or funnel performance.",improve:"Connect analytics, CRM, paid media, email and campaign data."},
    {key:"evidence_confidence",label:"Evidence Confidence",score:clamp(report?.confidence||35),status:"scored",confidence:100,why:report?"The current marketing/competitor report records "+report.evidenceCoverage+" evidence coverage.":"A full marketing/competitor report has not yet been generated.",improve:"Increase first-party data, corroboration and freshness of sources."},
    {key:"execution_readiness",label:"Execution Readiness",score:clamp(leadScore?Number(leadScore.overall||45):40),status:"scored",confidence:leadScore?75:40,why:"Combines current research readiness with the existing commercial qualification signal.",improve:"Turn top recommendations into owned experiments and record outcomes."}
  ];

  const payload={leadId,accountId,dimensions,generatedAt:isoNow(),rule:"A missing private metric stays unscored rather than being inferred from public evidence."};
  await env.DB.prepare(
    "INSERT INTO commercial_scorecards (scorecard_id,lead_id,account_id,scorecard_json,evidence_json,generated_at) VALUES (?,?,?,?,?,?)"
  ).bind(id("scorecard"),leadId,accountId,JSON.stringify(payload),JSON.stringify(report?.evidence||[]),isoNow()).run();
  return payload;
}

export async function createRecommendation(env:Env,input:{
  leadId?:string|null;accountId?:string|null;opportunityId?:string|null;category:string;recommendation:string;rationale:string;
  evidence?:string[];confidence?:number;priority?:"now"|"next"|"later";owner?:string|null;dueAt?:string|null
}){
  const recommendationId=id("rec");
  const now=isoNow();
  await env.DB.prepare(
    `INSERT INTO commercial_recommendations
     (recommendation_id,lead_id,account_id,opportunity_id,category,recommendation_text,rationale,evidence_json,confidence,priority,owner,due_at,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'recommended',?,?)`
  ).bind(
    recommendationId,input.leadId||null,input.accountId||null,input.opportunityId||null,
    input.category.slice(0,80),input.recommendation.slice(0,1600),input.rationale.slice(0,2400),
    JSON.stringify((input.evidence||[]).slice(0,30)),clamp(input.confidence??50),input.priority||"next",
    input.owner||null,input.dueAt||null,now,now
  ).run();
  return {recommendationId,status:"recommended"};
}

export async function recordRecommendationOutcome(env:Env,recommendationId:string,input:{
  outcomeType:string;numericValue?:number|null;details?:Record<string,unknown>;status?:"accepted"|"in_progress"|"completed"|"rejected"|"superseded"
}){
  const rec=await env.DB.prepare("SELECT * FROM commercial_recommendations WHERE recommendation_id=?").bind(recommendationId).first<any>();
  if(!rec) throw new Error("recommendation_not_found");
  const outcomeId=id("recout");
  await env.DB.prepare(
    "INSERT INTO recommendation_outcomes (outcome_id,recommendation_id,outcome_type,numeric_value,details_json,recorded_at) VALUES (?,?,?,?,?,?)"
  ).bind(outcomeId,recommendationId,input.outcomeType,input.numericValue??null,JSON.stringify(input.details||{}),isoNow()).run();
  if(input.status){
    await env.DB.prepare("UPDATE commercial_recommendations SET status=?,updated_at=? WHERE recommendation_id=?")
      .bind(input.status,isoNow(),recommendationId).run();
  }
  return {outcomeId,recommendationId,status:input.status||rec.status};
}

export async function generateBattlecard(env:Env,input:{competitorId:string;accountId?:string|null}){
  const competitor=await env.DB.prepare("SELECT * FROM competitors WHERE competitor_id=?").bind(input.competitorId).first<any>();
  if(!competitor) throw new Error("competitor_not_found");
  const deep=await env.DB.prepare(
    `SELECT cip.* FROM competitor_intelligence_profiles cip
     JOIN marketing_intelligence_reports mir ON mir.report_id=cip.report_id
     WHERE lower(cip.competitor_name)=lower(?) ORDER BY cip.created_at DESC LIMIT 1`
  ).bind(competitor.name).first<any>();
  const fallback={
    competitor:competitor.name,
    whereTheyAreStrong:strList(safeJson(competitor.strengths_json,[]),6),
    whereWeMayWin:strList(safeJson(competitor.weaknesses_json,[]),6),
    likelyBuyerObjections:[],
    responsePrinciples:["Use evidence, not negative claims about the competitor."],
    displacementAngle:competitor.differentiation_opportunity||"Validate why changing is better than staying with the current alternative.",
    proofRequired:[],
    doNotClaim:["Do not make unsupported feature, pricing or performance comparisons."]
  };
  const content=await aiJson<Record<string,unknown>>(
    env,
    "You build evidence-led B2B competitive battlecards. Never fabricate competitor weaknesses, prices or claims. Keep assertions traceable to supplied evidence and distinguish hypotheses.",
    `COMPETITOR RECORD: ${JSON.stringify(competitor)}\nDEEP PROFILE: ${deep?.profile_json||"{}"}\nReturn competitor, whereTheyAreStrong[], whereWeMayWin[], likelyBuyerObjections[], responsePrinciples[], displacementAngle, proofRequired[], doNotClaim[].`,
    fallback,
    1600
  );
  const now=isoNow();
  const existing=await env.DB.prepare("SELECT battlecard_id FROM battlecards WHERE competitor_id=? AND account_id IS ? LIMIT 1").bind(input.competitorId,input.accountId||null).first<any>();
  const battlecardId=existing?.battlecard_id||id("battle");
  if(existing){
    await env.DB.prepare("UPDATE battlecards SET content_json=?,evidence_json=?,confidence=?,generated_at=?,updated_at=? WHERE battlecard_id=?")
      .bind(JSON.stringify(content),competitor.source_urls_json||"[]",deep?Number(deep.confidence||50):45,now,now,battlecardId).run();
  }else{
    await env.DB.prepare(
      "INSERT INTO battlecards (battlecard_id,competitor_id,account_id,content_json,evidence_json,confidence,generated_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(battlecardId,input.competitorId,input.accountId||null,JSON.stringify(content),competitor.source_urls_json||"[]",deep?Number(deep.confidence||50):45,now,now).run();
  }
  return {battlecardId,content};
}

export async function buildGrowthSnapshotV2(env:Env,input:{leadId:string;opportunityId?:string|null}){
  const [lead,profile,competitors,buyers,targets,signals,report,scorecard] = await Promise.all([
    env.DB.prepare("SELECT * FROM leads WHERE lead_id=?").bind(input.leadId).first<any>(),
    env.DB.prepare("SELECT * FROM company_profiles WHERE lead_id=?").bind(input.leadId).first<any>(),
    env.DB.prepare("SELECT * FROM competitors WHERE lead_id=? LIMIT 10").bind(input.leadId).all<any>(),
    env.DB.prepare("SELECT * FROM buyer_roles WHERE lead_id=? LIMIT 8").bind(input.leadId).all<any>(),
    env.DB.prepare("SELECT * FROM target_accounts WHERE lead_id=? LIMIT 20").bind(input.leadId).all<any>(),
    env.DB.prepare(`SELECT s.* FROM commercial_signals s JOIN commercial_accounts a ON a.account_id=s.account_id WHERE a.lead_id=? ORDER BY captured_at DESC LIMIT 20`).bind(input.leadId).all<any>(),
    latestMarketingCompetitorIntelligence(env,{leadId:input.leadId}),
    buildCommercialScorecard(env,{leadId:input.leadId})
  ]);
  if(!lead) throw new Error("lead_not_found");

  const fallback={
    executiveSummary:lead.outcome||lead.problem,
    opportunitySummary:"The strongest opportunity should be validated against the supplied evidence before investment.",
    keyMarketFinding:(report?.report as any)?.executiveSummary||"Market evidence requires review.",
    competitorLandscape:(report?.report as any)?.competitiveLandscape||{},
    marketingFinding:(report?.report as any)?.company?.positioning||{},
    priorityAccounts:targets.results.slice(0,8).map((x:any)=>({company:x.company,rationale:x.rationale})),
    buyerMap:buyers.results.slice(0,7).map((x:any)=>({role:x.role,type:x.role_type,pain:x.pain,trigger:x.trigger_text})),
    signals:signals.results.slice(0,8).map((x:any)=>({title:x.title,detail:x.detail,sourceUrl:x.source_url,confidence:x.confidence})),
    opportunities:strList((report?.report as any)?.opportunities,8),
    risks:strList((report?.report as any)?.risks,8),
    ninetyDayPlan:[
      {phase:"0–30 days",objective:"Validate the highest-value opportunity and evidence gaps.",actions:["Confirm ICP and buyer ownership","Validate competitive position","Connect available first-party data"]},
      {phase:"31–60 days",objective:"Run focused commercial experiments.",actions:["Test one positioning/message hypothesis","Engage a tightly defined account set","Measure buyer and channel response"]},
      {phase:"61–90 days",objective:"Scale only what produced evidence.",actions:["Review experiment outcomes","Double down on validated segments/channels","Refresh priorities and monitoring"]}
    ],
    scorecard,
    evidenceAppendix:report?.evidence||[],
    assumptions:["Opportunity and financial scenarios are hypotheses unless supported by first-party commercial data."],
    humanDecisionRequired:true
  };

  const snapshot=await aiJson<Record<string,unknown>>(
    env,
    "You are ClientMotive's senior commercial strategist. Produce an executive Growth Snapshot that turns evidence into decisions. Keep market facts, hypotheses and recommendations distinct. Never invent TAM, revenue uplift, CAC, conversion rates, customer proof or competitor claims.",
    `BRIEF: ${JSON.stringify({company:lead.company,offer:lead.offer,market:lead.market,problem:lead.problem,outcome:lead.outcome})}
PROFILE: ${JSON.stringify(profile||{})}
MARKETING + COMPETITOR INTELLIGENCE: ${JSON.stringify(report?.report||{})}
COMPETITORS: ${JSON.stringify(competitors.results)}
BUYERS: ${JSON.stringify(buyers.results)}
TARGET ACCOUNTS: ${JSON.stringify(targets.results)}
RECENT SIGNALS: ${JSON.stringify(signals.results)}
SCORECARD: ${JSON.stringify(scorecard)}
Return executiveSummary, opportunitySummary, keyMarketFinding, competitorLandscape, marketingFinding, priorityAccounts[], buyerMap[], signals[], opportunities[], risks[], ninetyDayPlan[{phase,objective,actions[]}], scorecard, evidenceAppendix[], assumptions[], humanDecisionRequired=true.`,
    fallback,
    3600
  );
  snapshot.scorecard=scorecard;
  snapshot.humanDecisionRequired=true;
  const documentId=await saveDocument(env,{leadId:input.leadId,opportunityId:input.opportunityId,type:"growth_snapshot_v2",title:"ClientMotive Growth Snapshot — "+lead.company,content:snapshot});

  const account=await env.DB.prepare("SELECT account_id FROM commercial_accounts WHERE lead_id=? LIMIT 1").bind(input.leadId).first<any>();
  const recs=Array.isArray(snapshot.ninetyDayPlan)?snapshot.ninetyDayPlan.slice(0,3):[];
  for(const [idx,phase] of recs.entries()){
    const p=phase as any;
    await createRecommendation(env,{
      leadId:input.leadId,accountId:account?.account_id||null,opportunityId:input.opportunityId||null,
      category:"growth_snapshot",recommendation:String(p.objective||"Review next commercial priority"),
      rationale:"Generated from the Growth Snapshot 90-day plan and requires human approval before external action.",
      evidence:report?.evidence||[],confidence:report?.confidence||50,priority:idx===0?"now":idx===1?"next":"later",owner:"client"
    });
  }
  return {documentId,snapshot};
}

async function fingerprint(value:unknown){
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

export async function scanIntelligenceChanges(env:Env,input:{accountId:string}){
  const account=await env.DB.prepare("SELECT * FROM commercial_accounts WHERE account_id=?").bind(input.accountId).first<any>();
  if(!account?.domain) throw new Error("account_domain_required");
  const before=await latestMarketingCompetitorIntelligence(env,{domain:account.domain});
  const fresh=await buildMarketingCompetitorIntelligence(env,{domain:account.domain,companyName:account.name,leadId:account.lead_id||null});
  if(!before) return {accountId:account.account_id,changed:false,baselineCreated:true,reportId:fresh.reportId};

  const beforeShape={
    executiveSummary:(before.report as any).executiveSummary,
    positioning:(before.report as any).company?.positioning,
    competitors:(before.report as any).competitiveLandscape,
    opportunities:(before.report as any).opportunities,
    risks:(before.report as any).risks
  };
  const afterShape={
    executiveSummary:(fresh.report as any).executiveSummary,
    positioning:(fresh.report as any).company?.positioning,
    competitors:(fresh.report as any).competitiveLandscape,
    opportunities:(fresh.report as any).opportunities,
    risks:(fresh.report as any).risks
  };
  if(await fingerprint(beforeShape)===await fingerprint(afterShape)) return {accountId:account.account_id,changed:false,reportId:fresh.reportId};

  const diff=await aiJson<any>(
    env,
    "You compare two evidence-led commercial intelligence snapshots. Report only material changes. Never turn wording differences into fake market events.",
    `BEFORE: ${JSON.stringify(beforeShape)}\nAFTER: ${JSON.stringify(afterShape)}\nReturn {material:boolean,changes:[{type,title,detail,confidence,evidence[]}],executiveImplication}.`,
    {material:true,changes:[{type:"intelligence_refresh",title:"Commercial intelligence changed",detail:"The refreshed evidence produced a materially different intelligence view. Human review is required.",confidence:50,evidence:fresh.evidence.slice(0,8)}],executiveImplication:"Review the refreshed report before changing commercial action."},
    1400
  );
  if(diff.material===false) return {accountId:account.account_id,changed:false,reportId:fresh.reportId};

  const changes=Array.isArray(diff.changes)?diff.changes.slice(0,8):[];
  for(const change of changes){
    await env.DB.prepare(
      `INSERT INTO intelligence_change_events
       (change_id,account_id,domain,change_type,title,detail,before_json,after_json,evidence_json,confidence,status,detected_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'new',?)`
    ).bind(
      id("change"),account.account_id,account.domain,String(change.type||"intelligence_change").slice(0,80),
      String(change.title||"Commercial intelligence changed").slice(0,240),String(change.detail||"").slice(0,1800),
      JSON.stringify(beforeShape),JSON.stringify(afterShape),JSON.stringify(strList(change.evidence,20)),clamp(Number(change.confidence||50)),isoNow()
    ).run();
  }
  return {accountId:account.account_id,changed:true,changeCount:changes.length,executiveImplication:diff.executiveImplication||null,reportId:fresh.reportId};
}

export async function scanSubscribedIntelligence(env:Env,limit=3){
  const rows=await env.DB.prepare(
    `SELECT DISTINCT a.account_id FROM subscriptions s
     JOIN commercial_accounts a ON a.account_id=s.account_id
     WHERE s.status='active' AND s.product_code IN ('market_intelligence','gtm_premium') AND a.domain IS NOT NULL
     ORDER BY s.started_at LIMIT ?`
  ).bind(Math.max(1,Math.min(10,limit))).all<any>();
  const results:any[]=[];
  for(const row of rows.results){
    try{results.push(await scanIntelligenceChanges(env,{accountId:row.account_id}));}
    catch(error){results.push({accountId:row.account_id,error:String(error).slice(0,180)});}
  }
  return {checked:rows.results.length,results};
}

export async function executivePriorityDashboard(env:Env,input:{accountId?:string|null}={}){
  const accountClause=input.accountId?" AND account_id=?":"";
  const binds=input.accountId?[input.accountId]:[];
  const [changes,recommendations,signals,opportunities,experiments] = await Promise.all([
    env.DB.prepare(`SELECT * FROM intelligence_change_events WHERE status='new'${accountClause} ORDER BY detected_at DESC LIMIT 8`).bind(...binds).all<any>(),
    env.DB.prepare(`SELECT * FROM commercial_recommendations WHERE status IN ('recommended','accepted','in_progress')${accountClause} ORDER BY CASE priority WHEN 'now' THEN 1 WHEN 'next' THEN 2 ELSE 3 END, created_at DESC LIMIT 10`).bind(...binds).all<any>(),
    input.accountId
      ? env.DB.prepare("SELECT * FROM commercial_signals WHERE account_id=? ORDER BY captured_at DESC LIMIT 8").bind(input.accountId).all<any>()
      : env.DB.prepare("SELECT * FROM commercial_signals ORDER BY captured_at DESC LIMIT 8").all<any>(),
    input.accountId
      ? env.DB.prepare("SELECT * FROM opportunities WHERE account_id=? AND stage NOT IN ('won','lost','closed') ORDER BY probability DESC,value_estimate DESC LIMIT 8").bind(input.accountId).all<any>()
      : env.DB.prepare("SELECT * FROM opportunities WHERE stage NOT IN ('won','lost','closed') ORDER BY probability DESC,value_estimate DESC LIMIT 8").all<any>(),
    env.DB.prepare("SELECT * FROM commercial_experiments WHERE status IN ('draft','active') ORDER BY updated_at DESC LIMIT 8").all<any>()
  ]);
  return {
    whatChanged:changes.results,
    whatMatters:signals.results,
    opportunities:opportunities.results,
    whatToDoNext:recommendations.results,
    experiments:experiments.results,
    generatedAt:isoNow()
  };
}

export async function createBoardReadyExport(env:Env,input:{leadId:string;opportunityId?:string|null}){
  const latest=await env.DB.prepare(
    "SELECT document_id,title,content_json,updated_at FROM commercial_documents WHERE lead_id=? AND document_type='growth_snapshot_v2' ORDER BY updated_at DESC LIMIT 1"
  ).bind(input.leadId).first<any>();
  const built=latest||await (async()=>{
    const result=await buildGrowthSnapshotV2(env,input);
    return await env.DB.prepare("SELECT document_id,title,content_json,updated_at FROM commercial_documents WHERE document_id=?").bind(result.documentId).first<any>();
  })();
  const snapshot=safeJson(built.content_json,{});
  const content={
    formatVersion:1,
    title:built.title,
    executiveSummary:snapshot.executiveSummary||"",
    decisionPages:[
      {title:"Where the opportunity is",content:{opportunitySummary:snapshot.opportunitySummary,keyMarketFinding:snapshot.keyMarketFinding}},
      {title:"Competitive and marketing position",content:{competitorLandscape:snapshot.competitorLandscape,marketingFinding:snapshot.marketingFinding}},
      {title:"Who and when",content:{priorityAccounts:snapshot.priorityAccounts,buyerMap:snapshot.buyerMap,signals:snapshot.signals}},
      {title:"What to do next",content:{ninetyDayPlan:snapshot.ninetyDayPlan,scorecard:snapshot.scorecard}},
      {title:"Evidence and assumptions",content:{evidenceAppendix:snapshot.evidenceAppendix,assumptions:snapshot.assumptions}}
    ],
    note:"Structured export payload ready for PDF, presentation or document renderer. External publication remains human-approved."
  };
  const exportId=id("export");
  await env.DB.prepare(
    "INSERT INTO data_exports (export_id,export_type,status,object_count,content_json,created_by,created_at,completed_at,expires_at) VALUES (?,'board_growth_snapshot','complete',1,?,'clientmotive',?,?,?)"
  ).bind(exportId,JSON.stringify(content),isoNow(),isoNow(),new Date(Date.now()+30*86400000).toISOString()).run();
  return {exportId,content};
}
