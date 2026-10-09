import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import { aiJson } from "../services/ai";
import { searchMany, discoverCompanyPages } from "../services/search";
import { addEnrichmentFact } from "./crm";

export async function enrichCompanyWaterfall(env:Env,input:{accountId:string;domain?:string|null;companyName:string}):Promise<Record<string,unknown>>{
  const account=await env.DB.prepare("SELECT * FROM commercial_accounts WHERE account_id=?").bind(input.accountId).first<any>();
  if(!account) throw new Error("account_not_found");
  const domain=input.domain || account.domain;
  const facts:string[]=[];
  if(domain){
    const pages=await discoverCompanyPages(env,domain);
    if(pages.length){
      await addEnrichmentFact(env,{entityType:"account",entityId:input.accountId,fieldName:"website_evidence",value:pages.slice(0,5).map((p)=>({url:p.url,title:p.title})),sourceName:"company_website",sourceUrl:pages[0]?.url,confidence:85,ttlDays:60});
      facts.push("company_website");
    }
  }
  const groups=await searchMany(env,[`"${input.companyName}" company`,`"${input.companyName}" hiring news`,`"${input.companyName}" leadership`],5);
  const searchEvidence=groups.flatMap((g)=>g.results.map((r)=>({query:g.query,url:r.url,title:r.title,snippet:r.snippet})));
  if(searchEvidence.length){
    await addEnrichmentFact(env,{entityType:"account",entityId:input.accountId,fieldName:"search_evidence",value:searchEvidence.slice(0,20),sourceName:"web_search",sourceUrl:searchEvidence[0]?.url,confidence:60,ttlDays:21});
    facts.push("web_search");
  }

  let external:unknown=null;
  if(env.ENRICHMENT_API_URL && env.ENRICHMENT_API_KEY && domain){
    try{
      const url=new URL(env.ENRICHMENT_API_URL);
      url.searchParams.set("domain",domain);
      const response=await fetch(url,{headers:{authorization:"Bearer "+env.ENRICHMENT_API_KEY,accept:"application/json"},signal:AbortSignal.timeout(8000)});
      if(response.ok){
        external=await response.json();
        await addEnrichmentFact(env,{entityType:"account",entityId:input.accountId,fieldName:"provider_enrichment",value:external,sourceName:"configured_enrichment_provider",confidence:65,ttlDays:30});
        facts.push("configured_enrichment_provider");
      }
    }catch{}
  }
  return {accountId:input.accountId,sourcesUsed:facts,externalProviderConfigured:Boolean(env.ENRICHMENT_API_URL && env.ENRICHMENT_API_KEY),external};
}

export async function buildAttribution(env:Env,input:{tenantId?:string;opportunityId:string;model?:"first_touch"|"last_touch"|"linear"|"position_based"}):Promise<Record<string,unknown>>{
  const tenantId=input.tenantId || "tenant_clientmotive";
  const model=input.model || "linear";
  const touches=await env.DB.prepare(
    "SELECT * FROM attribution_touches WHERE tenant_id=? AND opportunity_id=? ORDER BY occurred_at"
  ).bind(tenantId,input.opportunityId).all<any>();
  const revenue=await env.DB.prepare(
    `SELECT COALESCE(SUM(amount),0) AS revenue FROM billing_events
     WHERE tenant_id=? AND opportunity_id=? AND event_type IN ('payment_succeeded','invoice_paid')`
  ).bind(tenantId,input.opportunityId).first<{revenue:number}>();
  const total=Number(revenue?.revenue || 0);
  const rows=touches.results;
  const weights=rows.map((_,index)=>{
    if(model==="first_touch") return index===0?1:0;
    if(model==="last_touch") return index===rows.length-1?1:0;
    if(model==="position_based"){
      if(rows.length===1) return 1;
      if(index===0 || index===rows.length-1) return 0.4;
      return rows.length>2?0.2/(rows.length-2):0;
    }
    return rows.length?1/rows.length:0;
  });
  const attributed=rows.map((row,index)=>({...row,weight:weights[index],attributedRevenue:Math.round(total*(weights[index] || 0)*100)/100}));
  const result={model,totalRevenue:total,touches:attributed};
  await env.DB.prepare(
    "INSERT INTO attribution_snapshots (attribution_id,tenant_id,opportunity_id,model,result_json,generated_at) VALUES (?,?,?,?,?,?)"
  ).bind(id("attr"),tenantId,input.opportunityId,model,JSON.stringify(result),isoNow()).run();
  return result;
}

export async function harvestVoiceOfCustomer(env:Env,input:{tenantId?:string;segment?:string|null;limit?:number}):Promise<Record<string,unknown>>{
  const tenantId=input.tenantId || "tenant_clientmotive";
  const communications=await env.DB.prepare(
    `SELECT ce.communication_id,ce.body_text,a.segment
     FROM communication_events ce
     LEFT JOIN commercial_accounts a ON a.account_id=ce.account_id
     WHERE ce.tenant_id=? AND ce.direction='inbound' AND ce.body_text IS NOT NULL
       ${input.segment?"AND a.segment=?":""}
     ORDER BY ce.occurred_at DESC LIMIT ?`
  ).bind(...(input.segment?[tenantId,input.segment,Math.max(10,Math.min(200,input.limit || 100))]:[tenantId,Math.max(10,Math.min(200,input.limit || 100))])).all<any>();
  const safe=communications.results.map((r)=>({id:r.communication_id,text:String(r.body_text).slice(0,1500),segment:r.segment}));
  const patterns=await aiJson<{patterns:Array<{patternType:string;phrase:string;frequency:number;evidenceIds:string[]}>}>(
    env,
    "You identify recurring voice-of-customer language in B2B communications. Do not expose names, email addresses or unique private details. Use short paraphrased patterns, not verbatim sensitive quotes.",
    `SEGMENT: ${input.segment || "all"}\nCOMMUNICATIONS: ${JSON.stringify(safe)}\nReturn {"patterns":[{"patternType":"problem|outcome|objection|buying_language","phrase":"","frequency":1,"evidenceIds":[]}]}.`,
    {patterns:[]},
    1400
  );
  for(const pattern of patterns.patterns.slice(0,30)){
    const existing=await env.DB.prepare(
      "SELECT pattern_id FROM voice_patterns WHERE tenant_id=? AND segment IS ? AND pattern_type=? AND phrase=? LIMIT 1"
    ).bind(tenantId,input.segment || null,pattern.patternType,pattern.phrase).first<{pattern_id:string}>();
    if(existing){
      await env.DB.prepare("UPDATE voice_patterns SET frequency=?,evidence_ids_json=?,updated_at=? WHERE pattern_id=?")
        .bind(pattern.frequency,JSON.stringify(pattern.evidenceIds || []),isoNow(),existing.pattern_id).run();
    }else{
      await env.DB.prepare(
        "INSERT INTO voice_patterns (pattern_id,tenant_id,segment,pattern_type,phrase,frequency,evidence_ids_json,publication_safe,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)"
      ).bind(id("voice"),tenantId,input.segment || null,pattern.patternType,pattern.phrase,Math.max(1,pattern.frequency || 1),JSON.stringify(pattern.evidenceIds || []),isoNow(),isoNow()).run();
    }
  }
  return {sampleSize:safe.length,patterns:patterns.patterns,publicationSafe:false};
}

export async function generateBattlecard(env:Env,input:{competitorId:string;accountId?:string|null;tenantId?:string}):Promise<Record<string,unknown>>{
  const competitor=await env.DB.prepare("SELECT * FROM competitors WHERE competitor_id=?").bind(input.competitorId).first<any>();
  if(!competitor) throw new Error("competitor_not_found");
  const sources=JSON.parse(competitor.source_urls_json || "[]") as string[];
  const evidence=await env.DB.prepare(
    "SELECT source_url,source_title,snippet FROM research_evidence WHERE lead_id=? AND source_url IN ("+sources.map(()=>"?").join(",")+") LIMIT 30"
  ).bind(competitor.lead_id,...sources).all<any>().catch(()=>({results:[]} as any));
  const fallback={
    competitor:competitor.name,
    whereTheyMayBeStronger:[],
    whereClientMotiveOrClientMayDiffer:[],
    questionsToAsk:[],
    claimsToAvoid:["Do not claim superiority without evidence."],
    likelyObjections:[],
    evidence:sources
  };
  const card=await aiJson<Record<string,unknown>>(
    env,
    "You create evidence-led competitive battlecards. Be fair about competitor strengths. Never fabricate pricing, weaknesses or customer claims.",
    `COMPETITOR RECORD: ${JSON.stringify(competitor)}\nEVIDENCE: ${JSON.stringify(evidence.results)}\nReturn competitor, whereTheyMayBeStronger[], whereClientMotiveOrClientMayDiffer[], questionsToAsk[], claimsToAvoid[], likelyObjections[], evidence[].`,
    fallback,
    1400
  );
  const tenantId=input.tenantId || "tenant_clientmotive";
  const existing=await env.DB.prepare("SELECT battlecard_id FROM battlecards WHERE tenant_id=? AND competitor_id=? AND account_id IS ? LIMIT 1")
    .bind(tenantId,input.competitorId,input.accountId || null).first<{battlecard_id:string}>();
  const cardId=existing?.battlecard_id || id("battle");
  if(existing){
    await env.DB.prepare("UPDATE battlecards SET content_json=?,evidence_json=?,confidence=?,updated_at=? WHERE battlecard_id=?")
      .bind(JSON.stringify(card),JSON.stringify(sources),65,isoNow(),cardId).run();
  }else{
    await env.DB.prepare(
      "INSERT INTO battlecards (battlecard_id,tenant_id,competitor_id,account_id,content_json,evidence_json,confidence,generated_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).bind(cardId,tenantId,input.competitorId,input.accountId || null,JSON.stringify(card),JSON.stringify(sources),65,isoNow(),isoNow()).run();
  }
  return {battlecardId:cardId,...card};
}

export async function predictCommercialTrigger(env:Env,accountId:string):Promise<Record<string,unknown>>{
  const [account,signals,facts]=await Promise.all([
    env.DB.prepare("SELECT * FROM commercial_accounts WHERE account_id=?").bind(accountId).first<any>(),
    env.DB.prepare("SELECT * FROM commercial_signals WHERE account_id=? ORDER BY captured_at DESC LIMIT 30").bind(accountId).all<any>(),
    env.DB.prepare("SELECT field_name,field_value_json,source_url,observed_at FROM enrichment_facts WHERE entity_type='account' AND entity_id=? AND status='active' ORDER BY observed_at DESC LIMIT 30").bind(accountId).all<any>()
  ]);
  if(!account) throw new Error("account_not_found");
  const prediction=await aiJson<Record<string,unknown>>(
    env,
    "You generate cautious commercial-event hypotheses from public signals. A prediction is not a fact. Never claim an event will happen; explain the evidence and uncertainty.",
    `ACCOUNT: ${JSON.stringify(account)}\nRECENT SIGNALS: ${JSON.stringify(signals.results)}\nFACTS: ${JSON.stringify(facts.results)}\nReturn hypothesis, confidence 0-100, predictedWindow, evidence[], whatWouldConfirm[].`,
    {hypothesis:"No sufficiently strong emerging commercial event is visible.",confidence:20,predictedWindow:null,evidence:[],whatWouldConfirm:[]},
    1000
  );
  const predictionId=id("predict");
  await env.DB.prepare(
    "INSERT INTO trigger_predictions (prediction_id,tenant_id,account_id,hypothesis,confidence,evidence_json,status,predicted_window,created_at,expires_at) VALUES (?,?,?,?,?,?,'hypothesis',?,?,?)"
  ).bind(predictionId,account.tenant_id || "tenant_clientmotive",accountId,String(prediction.hypothesis || ""),Math.max(0,Math.min(100,Number(prediction.confidence || 20))),JSON.stringify(prediction.evidence || []),prediction.predictedWindow || null,isoNow(),new Date(Date.now()+30*86_400_000).toISOString()).run();
  return {predictionId,...prediction,status:"hypothesis"};
}

export async function scoreEvidenceQuality(env:Env,input:{tenantId?:string;entityType:string;entityId:string;evidenceType:string}):Promise<Record<string,unknown>>{
  const tenantId=input.tenantId || "tenant_clientmotive";
  const facts=await env.DB.prepare(
    "SELECT confidence,observed_at,expires_at,source_name,source_url FROM enrichment_facts WHERE tenant_id=? AND entity_type=? AND entity_id=? AND status='active'"
  ).bind(tenantId,input.entityType,input.entityId).all<any>();
  const conflicts=await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM fact_conflicts WHERE tenant_id=? AND entity_type=? AND entity_id=? AND status='open'"
  ).bind(tenantId,input.entityType,input.entityId).first<{count:number}>();
  const now=Date.now();
  const freshness=facts.results.length?Math.round(facts.results.reduce((sum,row)=>{
    if(row.expires_at && new Date(row.expires_at).getTime()<now) return sum+10;
    const days=Math.max(0,(now-new Date(row.observed_at).getTime())/86_400_000);
    return sum+Math.max(20,100-days*2);
  },0)/facts.results.length):0;
  const sourceQuality=facts.results.length?Math.round(facts.results.reduce((sum,row)=>sum+Number(row.confidence || 50),0)/facts.results.length):0;
  const distinctSources=new Set(facts.results.map((row)=>row.source_name)).size;
  const corroboration=Math.min(100,distinctSources*25);
  const contradictionCount=Number(conflicts?.count || 0);
  const overall=Math.max(0,Math.min(100,Math.round(freshness*0.3+sourceQuality*0.35+corroboration*0.25-Math.min(30,contradictionCount*10)+10)));
  const result={freshnessScore:freshness,sourceQualityScore:sourceQuality,corroborationScore:corroboration,contradictionCount,overallConfidence:overall};
  await env.DB.prepare(
    `INSERT INTO evidence_quality (
      quality_id,tenant_id,entity_type,entity_id,evidence_type,freshness_score,source_quality_score,
      corroboration_score,contradiction_count,overall_confidence,details_json,scored_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,entity_type,entity_id,evidence_type) DO UPDATE SET
      freshness_score=excluded.freshness_score,source_quality_score=excluded.source_quality_score,
      corroboration_score=excluded.corroboration_score,contradiction_count=excluded.contradiction_count,
      overall_confidence=excluded.overall_confidence,details_json=excluded.details_json,scored_at=excluded.scored_at`
  ).bind(id("quality"),tenantId,input.entityType,input.entityId,input.evidenceType,freshness,sourceQuality,corroboration,contradictionCount,overall,JSON.stringify({factCount:facts.results.length,distinctSources}),isoNow()).run();
  return result;
}
