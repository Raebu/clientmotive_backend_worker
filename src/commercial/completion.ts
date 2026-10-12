import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import { aiJson } from "../services/ai";

const clamp=(n:number)=>Math.max(0,Math.min(100,Math.round(n)));
const safeJson=(v:string|null|undefined,f:any)=>{try{return v?JSON.parse(v):f;}catch{return f;}};
const list=(v:unknown,max=20)=>Array.isArray(v)?v.slice(0,max).map(x=>String(x||"").trim()).filter(Boolean):[];

export const FIRST_PARTY_CONNECTOR_CONTRACTS = {
  ga4:{category:"analytics",metrics:["sessions","users","conversions","conversion_rate","engaged_sessions","revenue"],records:["landing_page","channel","campaign"]},
  google_search_console:{category:"search",metrics:["clicks","impressions","ctr","average_position","branded_search"],records:["query","page","country","device"]},
  google_ads:{category:"paid_media",metrics:["spend","clicks","impressions","conversions","conversion_value","cpl","cac","roas"],records:["campaign","ad_group","keyword","creative"]},
  linkedin_ads:{category:"paid_media",metrics:["spend","clicks","impressions","leads","conversions","cpl","cac","roas"],records:["campaign","creative","audience"]},
  meta_ads:{category:"paid_media",metrics:["spend","clicks","impressions","leads","conversions","cpl","cac","roas"],records:["campaign","ad_set","creative"]},
  hubspot:{category:"crm",metrics:["pipeline_value","revenue_influenced","win_rate","sales_cycle_days"],records:["contact","company","deal","activity","campaign"]},
  salesforce:{category:"crm",metrics:["pipeline_value","revenue_influenced","win_rate","sales_cycle_days"],records:["lead","contact","account","opportunity","activity"]},
  email_marketing:{category:"lifecycle",metrics:["delivered","opens","clicks","replies","conversions","unsubscribe_rate"],records:["campaign","sequence","message"]},
  call_transcript:{category:"customer_voice",metrics:[],records:["call","meeting","objection","commitment"]},
  win_loss:{category:"commercial_outcome",metrics:["deal_value","sales_cycle_days"],records:["win","loss","reason","competitor"]},
  customer_feedback:{category:"customer_voice",metrics:["nps","csat"],records:["survey","review","interview","support_theme"]},
  pricing:{category:"commercial",metrics:["list_price","discount","contract_value","gross_margin"],records:["product","package","quote"]},
  proposal:{category:"commercial",metrics:["proposal_value"],records:["proposal","scope","decision"]},
  campaign_history:{category:"marketing",metrics:["spend","leads","meetings","opportunities","pipeline_value","revenue_influenced"],records:["campaign","audience","message","channel"]}
} as const;

export function connectorContracts(){return FIRST_PARTY_CONNECTOR_CONTRACTS;}

export async function ingestFirstPartyBundle(env:Env,input:{
  accountId:string;sourceType:string;periodStart?:string|null;periodEnd?:string|null;
  metrics?:Record<string,number>;records?:Array<{recordType:string;externalId?:string|null;data:Record<string,unknown>;occurredAt?:string|null}>;
  provenance?:Record<string,unknown>
}){
  const contract=(FIRST_PARTY_CONNECTOR_CONTRACTS as any)[input.sourceType];
  if(!contract) throw new Error("unsupported_source_type");
  const account=await env.DB.prepare("SELECT account_id FROM commercial_accounts WHERE account_id=?").bind(input.accountId).first();
  if(!account) throw new Error("account_not_found");
  const acceptedMetrics:Record<string,number>={};
  for(const [key,value] of Object.entries(input.metrics||{})){
    if(!contract.metrics.includes(key)) continue;
    if(Number.isFinite(value)) acceptedMetrics[key]=Number(value);
  }
  const ingestionId=id("ingest");
  await env.DB.prepare(
    `INSERT INTO first_party_ingestions
      (ingestion_id,account_id,source_type,period_start,period_end,metrics_json,dimensions_json,provenance_json,status,ingested_at)
     VALUES (?,?,?,?,?,?,?,?,'accepted',?)`
  ).bind(ingestionId,input.accountId,input.sourceType,input.periodStart||null,input.periodEnd||null,JSON.stringify(acceptedMetrics),"{}",JSON.stringify(input.provenance||{}),isoNow()).run();

  const records=(input.records||[]).slice(0,500).filter(r=>contract.records.includes(r.recordType));
  if(records.length){
    await env.DB.batch(records.map(r=>env.DB.prepare(
      `INSERT INTO first_party_records
       (record_id,account_id,source_type,record_type,external_id,record_json,provenance_json,occurred_at,ingested_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(id("fpr"),input.accountId,input.sourceType,r.recordType,r.externalId||null,JSON.stringify(r.data||{}),JSON.stringify(input.provenance||{}),r.occurredAt||null,isoNow())));
  }

  const metricMap:Record<string,string>={
    conversion_rate:"marketing_conversion_rate",pipeline_value:"marketing_pipeline_value",revenue_influenced:"marketing_revenue_influenced",
    cac:"marketing_cac",cpl:"marketing_cpl",roas:"marketing_roas",branded_search:"brand_demand",nps:"nps",csat:"csat",
    win_rate:"win_rate",sales_cycle_days:"sales_cycle_days",gross_margin:"gross_margin"
  };
  for(const [key,value] of Object.entries(acceptedMetrics)){
    const metricName=metricMap[key]; if(!metricName) continue;
    await env.DB.prepare("INSERT INTO account_metrics (metric_id,account_id,metric_name,numeric_value,metadata_json,occurred_at) VALUES (?,?,?,?,?,?)")
      .bind(id("metric"),input.accountId,metricName,value,JSON.stringify({sourceType:input.sourceType,ingestionId}),input.periodEnd||isoNow()).run();
  }
  return {ingestionId,sourceType:input.sourceType,acceptedMetrics:Object.keys(acceptedMetrics),acceptedRecords:records.length};
}

export async function buildOpportunityScenario(env:Env,input:{
  leadId?:string|null;accountId?:string|null;
  assumptions?:{addressableAccounts?:number|null;contractValueLow?:number|null;contractValueHigh?:number|null;conversionLow?:number|null;conversionHigh?:number|null;costOfInactionMonthly?:number|null}
}){
  let leadId=input.leadId||null,accountId=input.accountId||null;
  if(!accountId&&leadId){
    const a=await env.DB.prepare("SELECT account_id FROM commercial_accounts WHERE lead_id=? LIMIT 1").bind(leadId).first<any>();accountId=a?.account_id||null;
  }
  if(!leadId&&accountId){
    const a=await env.DB.prepare("SELECT lead_id FROM commercial_accounts WHERE account_id=?").bind(accountId).first<any>();leadId=a?.lead_id||null;
  }
  if(!leadId&&!accountId) throw new Error("lead_or_account_required");
  const [targets,won,metrics]=await Promise.all([
    leadId?env.DB.prepare("SELECT COUNT(*) AS count FROM target_accounts WHERE lead_id=?").bind(leadId).first<any>():null,
    env.DB.prepare(`SELECT oo.value FROM opportunity_outcomes oo JOIN opportunities o ON o.opportunity_id=oo.opportunity_id
      WHERE oo.outcome_type='won' AND oo.value IS NOT NULL ORDER BY oo.occurred_at DESC LIMIT 50`).all<any>(),
    accountId?env.DB.prepare("SELECT metric_name,numeric_value FROM account_metrics WHERE account_id=? ORDER BY occurred_at DESC").bind(accountId).all<any>():null
  ]);
  const a=input.assumptions||{};
  const values=won.results.map((r:any)=>Number(r.value)).filter((v:number)=>Number.isFinite(v)&&v>0).sort((x:number,y:number)=>x-y);
  const median=values.length?values[Math.floor(values.length/2)]!:null;
  const observedMetrics=new Map<string,number>();
  for(const row of metrics?.results||[]) if(!observedMetrics.has(row.metric_name)) observedMetrics.set(row.metric_name,Number(row.numeric_value));
  const addressable=a.addressableAccounts??(Number(targets?.count||0)>0?Number(targets.count):null);
  const lowValue=a.contractValueLow??(median?median*0.7:null);
  const highValue=a.contractValueHigh??(median?median*1.3:null);
  const observedWin=observedMetrics.get("win_rate");
  const lowConv=a.conversionLow??(observedWin!==undefined?Math.max(0,observedWin*0.7):null);
  const highConv=a.conversionHigh??(observedWin!==undefined?Math.min(100,observedWin*1.3):null);
  const missing=[
    addressable===null?"addressable account count":null,
    lowValue===null||highValue===null?"contract value range":null,
    lowConv===null||highConv===null?"conversion/win-rate range":null
  ].filter(Boolean);
  const scenario:any={
    status:missing.length?"needs_data":"modelled",
    currency:"GBP",
    inputs:{addressableAccounts:addressable,contractValueLow:lowValue,contractValueHigh:highValue,conversionLow:lowConv,conversionHigh:highConv,costOfInactionMonthly:a.costOfInactionMonthly??null},
    missingInputs:missing,
    assumptions:[
      a.addressableAccounts!==undefined?"Addressable-account count supplied as an assumption.":Number(targets?.count||0)>0?"Addressable-account count uses currently researched target accounts.":null,
      a.contractValueLow!==undefined||a.contractValueHigh!==undefined?"Contract values supplied as assumptions.":median?"Contract-value range is anchored to median recorded won-deal value.":null,
      a.conversionLow!==undefined||a.conversionHigh!==undefined?"Conversion range supplied as an assumption.":observedWin!==undefined?"Conversion range is anchored to stored first-party win-rate data.":null
    ].filter(Boolean),
    generatedAt:isoNow()
  };
  if(!missing.length){
    const lo=Number(addressable)*Number(lowConv)/100*Number(lowValue);
    const hi=Number(addressable)*Number(highConv)/100*Number(highValue);
    const base=Number(addressable)*((Number(lowConv)+Number(highConv))/2)/100*((Number(lowValue)+Number(highValue))/2);
    scenario.pipelineScenario={low:Math.round(lo),base:Math.round(base),high:Math.round(hi)};
    if(a.costOfInactionMonthly!==undefined&&a.costOfInactionMonthly!==null){
      scenario.costOfInaction={monthly:Number(a.costOfInactionMonthly),ninetyDays:Number(a.costOfInactionMonthly)*3,annual:Number(a.costOfInactionMonthly)*12,source:"user_supplied_assumption"};
    }
  }
  const confidence=clamp((missing.length?35:65)+(values.length>=5?10:0)+(observedWin!==undefined?10:0));
  scenario.confidence=confidence;
  const scenarioId=id("scenario");
  await env.DB.prepare(
    "INSERT INTO commercial_opportunity_scenarios (scenario_id,lead_id,account_id,scenario_json,assumptions_json,evidence_json,confidence,created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(scenarioId,leadId,accountId,JSON.stringify(scenario),JSON.stringify(a),JSON.stringify([]),confidence,isoNow()).run();
  return {scenarioId,...scenario};
}

const ALLOWED_CHANGE_TYPES=new Set([
  "pricing_change","positioning_change","homepage_message_change","product_launch","partnership_change","funding_change",
  "hiring_change","leadership_change","review_reputation_change","content_seo_change","brand_visual_change","offer_packaging_change","market_category_change"
]);

export async function classifyLatestIntelligenceChanges(env:Env,accountId:string){
  const account=await env.DB.prepare("SELECT account_id,domain,name FROM commercial_accounts WHERE account_id=?").bind(accountId).first<any>();
  if(!account?.domain) throw new Error("account_domain_required");
  const rows=await env.DB.prepare("SELECT * FROM marketing_intelligence_reports WHERE domain=? ORDER BY created_at DESC LIMIT 2").bind(account.domain).all<any>();
  if(rows.results.length<2) return {classified:0,reason:"needs_two_reports"};
  const [after,before]=rows.results;
  const beforeReport=safeJson(before.report_json,{});
  const afterReport=safeJson(after.report_json,{});
  const analysis=await aiJson<any>(
    env,
    "Compare two evidence-led marketing/competitor reports. Identify only material changes supported by the supplied report content. Never invent events. Ignore wording-only differences.",
    `COMPANY: ${account.name}
OLDER REPORT: ${JSON.stringify(beforeReport).slice(0,24000)}
NEWER REPORT: ${JSON.stringify(afterReport).slice(0,24000)}
Return {changes:[{type,title,detail,confidence,evidenceUrls[]}]} where type is one of pricing_change, positioning_change, homepage_message_change, product_launch, partnership_change, funding_change, hiring_change, leadership_change, review_reputation_change, content_seo_change, brand_visual_change, offer_packaging_change, market_category_change. Max 8.`,
    {changes:[]},
    1800
  );
  const changes=(Array.isArray(analysis.changes)?analysis.changes:[]).filter((c:any)=>ALLOWED_CHANGE_TYPES.has(String(c.type))).slice(0,8);
  let created=0;
  for(const c of changes){
    const duplicate=await env.DB.prepare(
      "SELECT change_id FROM intelligence_change_events WHERE account_id=? AND change_type=? AND title=? AND detected_at>=datetime('now','-7 days') LIMIT 1"
    ).bind(accountId,String(c.type),String(c.title||"")).first();
    if(duplicate) continue;
    await env.DB.prepare(
      `INSERT INTO intelligence_change_events
       (change_id,account_id,domain,change_type,title,detail,before_json,after_json,evidence_json,confidence,status,detected_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'new',?)`
    ).bind(id("change"),accountId,account.domain,String(c.type),String(c.title||"Commercial change").slice(0,240),String(c.detail||"").slice(0,1800),
      JSON.stringify({reportId:before.report_id}),JSON.stringify({reportId:after.report_id}),JSON.stringify(list(c.evidenceUrls,20)),clamp(Number(c.confidence||50)),isoNow()).run();
    created++;
  }
  return {classified:created,changes};
}

export async function setAlertPreference(env:Env,input:{
  accountId?:string|null;channel:"dashboard"|"email"|"slack";destination?:string|null;signalTypes?:string[];minimumConfidence?:number;cadence?:string;enabled?:boolean;consent?:Record<string,unknown>
}){
  if(input.channel==="email"&&input.consent?.alerts!==true) throw new Error("alert_consent_required");
  const preferenceId=id("alertpref"),now=isoNow();
  await env.DB.prepare(
    `INSERT INTO alert_preferences
     (preference_id,account_id,channel,destination,signal_types_json,minimum_confidence,cadence,enabled,consent_json,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(preferenceId,input.accountId||null,input.channel,input.destination||null,JSON.stringify(input.signalTypes||[]),clamp(input.minimumConfidence??60),
    input.cadence||"immediate",input.enabled===false?0:1,JSON.stringify(input.consent||{}),now,now).run();
  return {preferenceId};
}

async function sendEmail(env:Env,to:string,subject:string,text:string){
  if(!env.RESEND_API_KEY) return {ok:false,error:"resend_not_configured"};
  const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{authorization:"Bearer "+env.RESEND_API_KEY,"content-type":"application/json"},
    body:JSON.stringify({from:env.ALERT_EMAIL_FROM||"ClientMotive Intelligence <clientmotive@clientmotive.com>",to:[to],subject,text})});
  const body=await response.json().catch(()=>({})) as any;
  return {ok:response.ok,id:body.id||null,error:response.ok?null:"resend_"+response.status};
}

export async function deliverPendingAlerts(env:Env,limit=30){
  const changes=await env.DB.prepare(
    `SELECT c.*,a.name AS account_name FROM intelligence_change_events c
     LEFT JOIN commercial_accounts a ON a.account_id=c.account_id
     WHERE c.status='new' ORDER BY c.detected_at LIMIT ?`
  ).bind(Math.max(1,Math.min(100,limit))).all<any>();
  let queued=0,sent=0;
  for(const change of changes.results){
    const prefs=await env.DB.prepare(
      "SELECT * FROM alert_preferences WHERE enabled=1 AND (account_id IS NULL OR account_id=?) AND minimum_confidence<=?"
    ).bind(change.account_id,Number(change.confidence||0)).all<any>();
    for(const pref of prefs.results){
      const allowed=safeJson(pref.signal_types_json,[]) as string[];
      if(allowed.length&&!allowed.includes(change.change_type)) continue;
      const existing=await env.DB.prepare("SELECT delivery_id FROM alert_deliveries WHERE preference_id=? AND source_type='intelligence_change' AND source_id=?")
        .bind(pref.preference_id,change.change_id).first();
      if(existing) continue;
      const deliveryId=id("alert");
      await env.DB.prepare(
        "INSERT INTO alert_deliveries (delivery_id,preference_id,account_id,source_type,source_id,channel,destination,status,created_at) VALUES (?,?,?,?,?,?,?,'queued',?)"
      ).bind(deliveryId,pref.preference_id,change.account_id,"intelligence_change",change.change_id,pref.channel,pref.destination||null,isoNow()).run();
      queued++;
      let result:any={ok:true,id:null,error:null};
      const text=[change.account_name||change.domain,change.title,change.detail,"Confidence: "+change.confidence+"%"].join("\n\n");
      if(pref.channel==="email"&&pref.destination) result=await sendEmail(env,pref.destination,"ClientMotive alert: "+change.title,text);
      else if(pref.channel==="slack"&&pref.destination){
        const response=await fetch(pref.destination,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text})});
        result={ok:response.ok,id:null,error:response.ok?null:"slack_"+response.status};
      }
      await env.DB.prepare("UPDATE alert_deliveries SET status=?,provider_id=?,error=?,sent_at=? WHERE delivery_id=?")
        .bind(result.ok?"sent":"failed",result.id||null,result.error||null,result.ok?isoNow():null,deliveryId).run();
      if(result.ok) sent++;
    }
    await env.DB.prepare("UPDATE intelligence_change_events SET status='alerted' WHERE change_id=?").bind(change.change_id).run();
  }
  return {changes:changes.results.length,queued,sent};
}

export async function evidenceViewer(env:Env,input:{entityType:"account"|"lead"|"recommendation";entityId:string}){
  let accountId:string|null=null,leadId:string|null=null;
  if(input.entityType==="account"){
    accountId=input.entityId;
    const a=await env.DB.prepare("SELECT lead_id FROM commercial_accounts WHERE account_id=?").bind(accountId).first<any>();leadId=a?.lead_id||null;
  }else if(input.entityType==="lead"){
    leadId=input.entityId;
    const a=await env.DB.prepare("SELECT account_id FROM commercial_accounts WHERE lead_id=? LIMIT 1").bind(leadId).first<any>();accountId=a?.account_id||null;
  }
  const entries:any[]=[];
  if(input.entityType==="recommendation"){
    const r=await env.DB.prepare("SELECT * FROM commercial_recommendations WHERE recommendation_id=?").bind(input.entityId).first<any>();
    if(!r) throw new Error("recommendation_not_found");
    for(const url of list(safeJson(r.evidence_json,[]),50)) entries.push({classification:"recommendation_evidence",title:r.recommendation_text,url,capturedAt:r.created_at,confidence:r.confidence,source:"recommendation"});
    accountId=r.account_id||null;leadId=r.lead_id||null;
  }
  if(accountId){
    const [signals,changes]=await Promise.all([
      env.DB.prepare("SELECT * FROM commercial_signals WHERE account_id=? AND source_url IS NOT NULL ORDER BY captured_at DESC LIMIT 80").bind(accountId).all<any>(),
      env.DB.prepare("SELECT * FROM intelligence_change_events WHERE account_id=? ORDER BY detected_at DESC LIMIT 40").bind(accountId).all<any>()
    ]);
    for(const s of signals.results) entries.push({classification:"signal",title:s.title,url:s.source_url,capturedAt:s.captured_at,confidence:s.confidence,source:s.signal_type});
    for(const c of changes.results) for(const url of list(safeJson(c.evidence_json,[]),20)) entries.push({classification:"observed_change",title:c.title,url,capturedAt:c.detected_at,confidence:c.confidence,source:c.change_type});
  }
  if(leadId){
    const reports=await env.DB.prepare("SELECT * FROM marketing_intelligence_reports WHERE lead_id=? ORDER BY created_at DESC LIMIT 3").bind(leadId).all<any>();
    for(const r of reports.results) for(const url of list(safeJson(r.evidence_json,[]),80)) entries.push({classification:"research_evidence",title:"Marketing / competitor evidence",url,capturedAt:r.created_at,confidence:r.confidence,source:"marketing_competitor"});
  }
  const now=Date.now();
  const dedup=new Map<string,any>();
  for(const e of entries){
    if(!e.url||dedup.has(e.url)) continue;
    const age=Math.max(0,Math.floor((now-new Date(e.capturedAt||isoNow()).getTime())/86400000));
    dedup.set(e.url,{...e,freshnessDays:age,freshness:age<=30?"fresh":age<=90?"aging":"stale"});
  }
  return {entityType:input.entityType,entityId:input.entityId,evidence:[...dedup.values()].slice(0,150),generatedAt:isoNow()};
}

export async function createStructuredExperiment(env:Env,input:{
  name:string;dimension:string;hypothesis:string;variants:Record<string,unknown>;audience:string;channel:string;primaryMetric:string;successCriteria:string;plannedDays:number
}){
  const experimentId=id("exp"),now=isoNow();
  await env.DB.prepare(
    `INSERT INTO commercial_experiments
     (experiment_id,name,dimension,hypothesis,variant_json,status,created_at,updated_at,audience,channel,primary_metric,success_criteria,planned_days,learning_json)
     VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?,?,'{}')`
  ).bind(experimentId,input.name,input.dimension,input.hypothesis,JSON.stringify(input.variants),now,now,input.audience,input.channel,input.primaryMetric,input.successCriteria,Math.max(1,Math.min(365,input.plannedDays))).run();
  return {experimentId};
}

export async function synthesiseCommercialLearning(env:Env){
  const [experiments,recommendations]=await Promise.all([
    env.DB.prepare(`SELECT e.*,COUNT(r.result_id) AS result_count,
      AVG(CASE WHEN r.numeric_value IS NOT NULL THEN r.numeric_value END) AS avg_numeric
      FROM commercial_experiments e LEFT JOIN experiment_results r ON r.experiment_id=e.experiment_id
      GROUP BY e.experiment_id HAVING result_count>0 ORDER BY e.updated_at DESC LIMIT 100`).all<any>(),
    env.DB.prepare(`SELECT r.category,r.status,COUNT(o.outcome_id) AS outcomes,COUNT(DISTINCT r.recommendation_id) AS recommendations
      FROM commercial_recommendations r LEFT JOIN recommendation_outcomes o ON o.recommendation_id=r.recommendation_id
      GROUP BY r.category,r.status HAVING outcomes>0`).all<any>()
  ]);
  const synthesis=await aiJson<any>(
    env,
    "Synthesize cautious commercial learnings from completed/observed experiments and recommendation outcomes. Do not infer causality from small samples. Label weak patterns as provisional.",
    `EXPERIMENTS: ${JSON.stringify(experiments.results)}
RECOMMENDATION OUTCOMES: ${JSON.stringify(recommendations.results)}
Return {learnings:[{dimension,patternKey,summary,sampleSize,confidence,implication,status}]} max 15. status should be provisional unless sampleSize>=5.`,
    {learnings:[]},
    2000
  );
  const learnings=(Array.isArray(synthesis.learnings)?synthesis.learnings:[]).slice(0,15);
  for(const l of learnings){
    const now=isoNow(),sample=Math.max(0,Number(l.sampleSize||0)),confidence=clamp(Number(l.confidence||Math.min(70,sample*10)));
    await env.DB.prepare(
      `INSERT INTO commercial_learnings
       (learning_id,dimension,segment,pattern_key,learning_json,sample_size,confidence,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id,dimension,segment,pattern_key) DO UPDATE SET
        learning_json=excluded.learning_json,sample_size=excluded.sample_size,confidence=excluded.confidence,status=excluded.status,updated_at=excluded.updated_at`
    ).bind(id("learn"),String(l.dimension||"general"),null,String(l.patternKey||"pattern").slice(0,180),JSON.stringify(l),sample,confidence,sample>=5?"observed":"provisional",now,now).run();
  }
  return {sourceExperiments:experiments.results.length,sourceRecommendationGroups:recommendations.results.length,learnings};
}

export async function recommendationExecutionHistory(env:Env,recommendationId:string){
  const rows=await env.DB.prepare("SELECT * FROM recommendation_executions WHERE recommendation_id=? ORDER BY created_at DESC").bind(recommendationId).all<any>();
  return rows.results.map(r=>({...r,payload:safeJson(r.payload_json,{}),result:safeJson(r.result_json,null)}));
}

export async function prepareRecommendationExecution(env:Env,recommendationId:string,input:{actionType:string;payload?:Record<string,unknown>;approvedBy?:string|null}){
  const rec=await env.DB.prepare("SELECT * FROM commercial_recommendations WHERE recommendation_id=?").bind(recommendationId).first<any>();
  if(!rec) throw new Error("recommendation_not_found");
  const allowed=new Set(["create_experiment","scan_account","generate_growth_snapshot","generate_document","create_human_task","prepare_outreach"]);
  if(!allowed.has(input.actionType)) throw new Error("unsupported_execution_action");
  const executionId=id("recexec");
  await env.DB.prepare(
    "INSERT INTO recommendation_executions (execution_id,recommendation_id,action_type,payload_json,status,approved_by,created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(executionId,recommendationId,input.actionType,JSON.stringify(input.payload||{}),input.approvedBy?"approved":"prepared",input.approvedBy||null,isoNow()).run();
  return {executionId,status:input.approvedBy?"approved":"prepared",externalActionAllowed:false};
}
