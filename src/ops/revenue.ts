import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import type { DealRisk, ForecastResult, MarginAssessment } from "./types";

const clamp=(n:number)=>Math.max(0,Math.min(100,Math.round(n)));

export function calculateForecast(input:{
  periodStart:string;periodEnd:string;targetRevenue?:number|null;
  opportunities:Array<{value:number;probability:number;stage:string}>;
  committedRevenue?:number;historicalWinRate?:number;averageDealValue?:number;
  proposalToWinRate?:number;meetingToProposalRate?:number;qualifiedToMeetingRate?:number;
}):ForecastResult{
  const weighted=input.opportunities.reduce((sum,opp)=>sum+Math.max(0,opp.value)*clamp(opp.probability)/100,0);
  const committed=(input.committedRevenue || 0)+input.opportunities.filter((opp)=>["won","contracted","active"].includes(opp.stage)).reduce((sum,opp)=>sum+Math.max(0,opp.value),0);
  const expected=weighted+Math.max(0,input.committedRevenue || 0);
  const target=input.targetRevenue ?? null;
  const gap=target===null?null:Math.max(0,target-expected);
  const avg=Math.max(1,input.averageDealValue || 1);
  const win=Math.max(0.01,Math.min(1,(input.historicalWinRate || 25)/100));
  const p2w=Math.max(0.01,Math.min(1,(input.proposalToWinRate || 35)/100));
  const m2p=Math.max(0.01,Math.min(1,(input.meetingToProposalRate || 50)/100));
  const q2m=Math.max(0.01,Math.min(1,(input.qualifiedToMeetingRate || 40)/100));
  const wins=gap===null?null:Math.ceil(gap/avg);
  const proposals=wins===null?null:Math.ceil(wins/p2w);
  const meetings=proposals===null?null:Math.ceil(proposals/m2p);
  const qualified=meetings===null?null:Math.ceil(meetings/q2m);
  return {
    periodStart:input.periodStart,periodEnd:input.periodEnd,weightedPipeline:Math.round(weighted*100)/100,
    committedRevenue:Math.round(committed*100)/100,expectedRevenue:Math.round(expected*100)/100,targetRevenue:target,
    revenueGap:gap===null?null:Math.round(gap*100)/100,requiredWins:wins,requiredProposals:proposals,requiredMeetings:meetings,
    requiredQualifiedOpportunities:qualified
  };
}

export async function generateRevenueForecast(env:Env,input:{tenantId?:string;periodStart:string;periodEnd:string}):Promise<ForecastResult>{
  const tenantId=input.tenantId || "tenant_clientmotive";
  const [target,opps,wonStats,stageStats,billing]=await Promise.all([
    env.DB.prepare("SELECT * FROM revenue_targets WHERE tenant_id=? AND period_start<=? AND period_end>=? ORDER BY created_at DESC LIMIT 1")
      .bind(tenantId,input.periodEnd,input.periodStart).first<any>(),
    env.DB.prepare(
      `SELECT COALESCE(value_estimate,0) AS value,probability,stage FROM opportunities
       WHERE tenant_id=? AND stage NOT IN ('lost','closed')`
    ).bind(tenantId).all<any>(),
    env.DB.prepare(
      `SELECT AVG(oo.value) AS avg_value,
       SUM(CASE WHEN oo.outcome_type='won' THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN oo.outcome_type IN ('won','lost') THEN 1 ELSE 0 END) AS decisions
       FROM opportunity_outcomes oo JOIN opportunities o ON o.opportunity_id=oo.opportunity_id
       WHERE o.tenant_id=?`
    ).bind(tenantId).first<any>(),
    env.DB.prepare(
      `SELECT
       SUM(CASE WHEN outcome_type='proposal' THEN 1 ELSE 0 END) AS proposals,
       SUM(CASE WHEN outcome_type='meeting' THEN 1 ELSE 0 END) AS meetings,
       SUM(CASE WHEN outcome_type='won' THEN 1 ELSE 0 END) AS wins
       FROM opportunity_outcomes oo JOIN opportunities o ON o.opportunity_id=oo.opportunity_id
       WHERE o.tenant_id=?`
    ).bind(tenantId).first<any>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount),0) AS committed FROM billing_events
       WHERE tenant_id=? AND event_type IN ('payment_succeeded','invoice_paid')
       AND occurred_at>=? AND occurred_at<=?`
    ).bind(tenantId,input.periodStart,input.periodEnd).first<{committed:number}>()
  ]);
  const historicalWinRate=Number(wonStats?.decisions || 0)>=3?Number(wonStats.wins || 0)/Number(wonStats.decisions)*100:25;
  const p2w=Number(stageStats?.proposals || 0)>=3?Number(stageStats?.wins || 0)/Number(stageStats.proposals)*100:35;
  const m2p=Number(stageStats?.meetings || 0)>=3?Number(stageStats.proposals || 0)/Number(stageStats.meetings)*100:50;
  const result=calculateForecast({
    periodStart:input.periodStart,periodEnd:input.periodEnd,targetRevenue:target?Number(target.target_revenue):null,
    opportunities:opps.results.map((row)=>({value:Number(row.value || 0),probability:Number(row.probability || 0),stage:String(row.stage)})),
    committedRevenue:Number(billing?.committed || 0),historicalWinRate,averageDealValue:Number(wonStats?.avg_value || 1),proposalToWinRate:p2w
  });
  await env.DB.prepare(
    `INSERT INTO revenue_forecasts (
      forecast_id,tenant_id,period_start,period_end,weighted_pipeline,committed_revenue,expected_revenue,
      target_revenue,revenue_gap,assumptions_json,generated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id("forecast"),tenantId,input.periodStart,input.periodEnd,result.weightedPipeline,result.committedRevenue,result.expectedRevenue,result.targetRevenue,result.revenueGap,JSON.stringify({historicalWinRate,averageDealValue:Number(wonStats?.avg_value || 0),proposalToWinRate:p2w}),isoNow()).run();
  return result;
}

export function assessMargin(input:{expectedRevenue:number;deliveryCost?:number;externalCost?:number;expectedHours?:number}):MarginAssessment{
  const revenue=Math.max(0,input.expectedRevenue);
  const delivery=Math.max(0,input.deliveryCost || 0);
  const external=Math.max(0,input.externalCost || 0);
  const profit=revenue-delivery-external;
  const margin=revenue>0?profit/revenue*100:null;
  const hours=Math.max(0,input.expectedHours || 0);
  const contribution=clamp((margin===null?0:margin)*0.7+(hours===0?20:Math.max(0,30-hours/10)));
  return {expectedRevenue:revenue,deliveryCost:delivery,externalCost:external,grossProfit:profit,marginPercent:margin===null?null:Math.round(margin*10)/10,expectedHours:hours,contributionScore:contribution};
}

export async function saveOpportunityEconomics(env:Env,opportunityId:string,input:{expectedRevenue:number;deliveryCost?:number;externalCost?:number;expectedHours?:number}):Promise<MarginAssessment>{
  const result=assessMargin(input);
  await env.DB.prepare(
    `INSERT INTO opportunity_economics (
      opportunity_id,expected_revenue,expected_delivery_cost,expected_external_cost,expected_hours,expected_margin,contribution_score,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(opportunity_id) DO UPDATE SET expected_revenue=excluded.expected_revenue,
      expected_delivery_cost=excluded.expected_delivery_cost,expected_external_cost=excluded.expected_external_cost,
      expected_hours=excluded.expected_hours,expected_margin=excluded.expected_margin,contribution_score=excluded.contribution_score,updated_at=excluded.updated_at`
  ).bind(opportunityId,result.expectedRevenue,result.deliveryCost,result.externalCost,result.expectedHours,result.marginPercent,result.contributionScore,isoNow()).run();
  return result;
}

export async function capacityAwarePriorities(env:Env,input:{tenantId?:string;periodStart:string;periodEnd:string;limit?:number}):Promise<Record<string,unknown>>{
  const tenantId=input.tenantId || "tenant_clientmotive";
  const [capacity,opps]=await Promise.all([
    env.DB.prepare(
      "SELECT SUM(capacity_units) AS capacity,SUM(committed_units) AS committed FROM capacity_periods WHERE tenant_id=? AND period_start<=? AND period_end>=?"
    ).bind(tenantId,input.periodEnd,input.periodStart).first<any>(),
    env.DB.prepare(
      `SELECT o.opportunity_id,o.name,o.stage,o.probability,COALESCE(e.expected_revenue,o.value_estimate,0) AS revenue,
       COALESCE(e.expected_hours,0) AS hours,COALESCE(e.contribution_score,50) AS contribution_score,
       a.name AS account_name
       FROM opportunities o JOIN commercial_accounts a ON a.account_id=o.account_id
       LEFT JOIN opportunity_economics e ON e.opportunity_id=o.opportunity_id
       WHERE o.tenant_id=? AND o.stage NOT IN ('won','lost','closed')
       ORDER BY contribution_score DESC,o.probability DESC LIMIT 200`
    ).bind(tenantId).all<any>()
  ]);
  const available=Math.max(0,Number(capacity?.capacity || 0)-Number(capacity?.committed || 0));
  let used=0;
  const chosen=[] as any[];
  for(const row of opps.results){
    const hours=Math.max(0,Number(row.hours || 0));
    if(hours>0 && used+hours>available) continue;
    if(chosen.length>=Math.max(1,Math.min(50,input.limit || 10))) break;
    used+=hours;
    chosen.push({...row,priorityReason:"Highest expected contribution that fits current delivery capacity."});
  }
  return {availableCapacity:available,selectedCapacity:used,opportunities:chosen};
}

export function detectDealRisks(input:{
  stage:string;probability:number;lastActivityAt?:string|null;nextAction?:string|null;contactRoles:string[];
  contactCount:number;procurementBlockers?:string[];hasEconomicBuyer:boolean;hasChampion:boolean;
}):DealRisk[]{
  const risks:DealRisk[]=[];
  const days=input.lastActivityAt?Math.floor((Date.now()-new Date(input.lastActivityAt).getTime())/86_400_000):999;
  if(days>21) risks.push({type:"stalled",severity:75,rationale:"No meaningful activity for more than 21 days.",action:"Research for a new reason to engage or close the opportunity rather than sending a generic bump."});
  if(!input.nextAction) risks.push({type:"no_next_step",severity:70,rationale:"No explicit next action is recorded.",action:"Agree and record a concrete next step with an owner and date."});
  if(!input.hasEconomicBuyer && ["proposal","qualified","negotiation"].includes(input.stage)) risks.push({type:"no_economic_buyer",severity:80,rationale:"The opportunity is advanced without a known economic buyer.",action:"Identify whether an economic buyer needs to be involved before further commitment."});
  if(input.contactCount<=1 && ["proposal","qualified","negotiation"].includes(input.stage)) risks.push({type:"single_threaded",severity:72,rationale:"The relationship depends on one known contact.",action:"Consider appropriate multi-threading across the buying committee."});
  if(!input.hasChampion && input.probability>=50) risks.push({type:"no_champion",severity:65,rationale:"Probability is high but no clear internal champion is recorded.",action:"Validate who will carry the case internally."});
  if((input.procurementBlockers || []).length) risks.push({type:"procurement",severity:78,rationale:"Procurement blockers are recorded.",action:"Resolve procurement/security/vendor requirements before relying on the forecast."});
  return risks;
}

export async function refreshDealRisks(env:Env,opportunityId:string):Promise<DealRisk[]>{
  const [opp,roles,proc]=await Promise.all([
    env.DB.prepare("SELECT * FROM opportunities WHERE opportunity_id=?").bind(opportunityId).first<any>(),
    env.DB.prepare(
      `SELECT cr.role_type,COUNT(DISTINCT cr.contact_id) AS count
       FROM contact_roles cr JOIN opportunities o ON o.account_id=cr.account_id
       WHERE o.opportunity_id=? GROUP BY cr.role_type`
    ).bind(opportunityId).all<any>(),
    env.DB.prepare(
      `SELECT p.blockers_json FROM procurement_profiles p JOIN opportunities o ON o.account_id=p.account_id
       WHERE o.opportunity_id=? LIMIT 1`
    ).bind(opportunityId).first<{blockers_json:string}>()
  ]);
  if(!opp) throw new Error("opportunity_not_found");
  const roleMap=new Map(roles.results.map((row)=>[row.role_type,Number(row.count)]));
  const total=[...roleMap.values()].reduce((sum,n)=>sum+n,0);
  const risks=detectDealRisks({
    stage:opp.stage,probability:Number(opp.probability || 0),lastActivityAt:opp.last_activity_at,nextAction:opp.next_action,
    contactRoles:[...roleMap.keys()],contactCount:total,hasEconomicBuyer:(roleMap.get("economic_buyer") || 0)>0,
    hasChampion:(roleMap.get("champion") || 0)>0,procurementBlockers:proc?JSON.parse(proc.blockers_json || "[]"):[]
  });
  await env.DB.prepare("DELETE FROM deal_risks WHERE opportunity_id=? AND status='open'").bind(opportunityId).run();
  if(risks.length) await env.DB.batch(risks.map((risk)=>env.DB.prepare(
    "INSERT INTO deal_risks (risk_id,opportunity_id,risk_type,severity,rationale,recommended_action,status,detected_at) VALUES (?,?,?,?,?,?,'open',?)"
  ).bind(id("risk"),opportunityId,risk.type,risk.severity,risk.rationale,risk.action,isoNow())));
  return risks;
}

export async function multiThreadingRecommendations(env:Env,opportunityId:string):Promise<Record<string,unknown>>{
  const [opp,contacts,buyers]=await Promise.all([
    env.DB.prepare("SELECT * FROM opportunities WHERE opportunity_id=?").bind(opportunityId).first<any>(),
    env.DB.prepare(
      `SELECT c.contact_id,c.full_name,c.title,cr.role_type FROM contacts c
       JOIN contact_roles cr ON cr.contact_id=c.contact_id
       JOIN opportunities o ON o.account_id=cr.account_id
       WHERE o.opportunity_id=?`
    ).bind(opportunityId).all<any>(),
    env.DB.prepare(
      `SELECT br.role,br.role_type,br.title_variants_json FROM buyer_roles br
       WHERE br.lead_id=(SELECT lead_id FROM opportunities WHERE opportunity_id=?)`
    ).bind(opportunityId).all<any>()
  ]);
  if(!opp) throw new Error("opportunity_not_found");
  const existing=new Set(contacts.results.map((row)=>row.role_type));
  const missing=buyers.results.filter((row)=>!existing.has(row.role_type)).map((row)=>({
    roleType:row.role_type,role:row.role,titleVariants:JSON.parse(row.title_variants_json || "[]"),
    reason:"This role appears in the buyer map but is not represented in the known contact set."
  }));
  return {knownContacts:contacts.results,missingRoles:missing,guardrail:"Do not add people merely to increase thread count; involve roles only when relevant to the buying process."};
}

export async function revenueConcentration(env:Env,tenantId="tenant_clientmotive"):Promise<Record<string,unknown>>{
  const rows=await env.DB.prepare(
    `SELECT a.account_id,a.name,COALESCE(SUM(be.amount),0) AS revenue
     FROM commercial_accounts a LEFT JOIN billing_events be ON be.account_id=a.account_id AND be.event_type IN ('payment_succeeded','invoice_paid')
     WHERE a.tenant_id=? GROUP BY a.account_id ORDER BY revenue DESC`
  ).bind(tenantId).all<any>();
  const total=rows.results.reduce((sum,row)=>sum+Number(row.revenue || 0),0);
  return {
    totalRevenue:total,
    accounts:rows.results.map((row)=>({...row,sharePercent:total>0?Math.round(Number(row.revenue || 0)/total*1000)/10:0})),
    alerts:rows.results.filter((row)=>total>0 && Number(row.revenue || 0)/total>=0.35).map((row)=>row.name+" represents at least 35% of recorded revenue.")
  };
}

export async function negativeIcp(env:Env,tenantId="tenant_clientmotive"):Promise<Record<string,unknown>>{
  const rows=await env.DB.prepare(
    `SELECT a.segment,
      COUNT(DISTINCT CASE WHEN oo.outcome_type='lost' THEN o.opportunity_id END) AS losses,
      COUNT(DISTINCT CASE WHEN oo.outcome_type='won' THEN o.opportunity_id END) AS wins,
      AVG(ch.health_score) AS health,
      AVG(COALESCE(oe.expected_margin,0)) AS margin
     FROM commercial_accounts a
     LEFT JOIN opportunities o ON o.account_id=a.account_id
     LEFT JOIN opportunity_outcomes oo ON oo.opportunity_id=o.opportunity_id
     LEFT JOIN client_health ch ON ch.account_id=a.account_id
     LEFT JOIN opportunity_economics oe ON oe.opportunity_id=o.opportunity_id
     WHERE a.tenant_id=? AND a.segment IS NOT NULL GROUP BY a.segment`
  ).bind(tenantId).all<any>();
  return {
    segments:rows.results.map((row)=>{
      const wins=Number(row.wins || 0),losses=Number(row.losses || 0);
      const bad=losses>=3 && losses>wins*2 || (row.health!==null && Number(row.health)<45) || (row.margin!==null && Number(row.margin)<20);
      return {...row,negativeIcpCandidate:bad,reasons:[
        losses>=3 && losses>wins*2?"Losses substantially exceed wins.":null,
        row.health!==null && Number(row.health)<45?"Average client health is weak.":null,
        row.margin!==null && Number(row.margin)<20?"Expected margin is low.":null
      ].filter(Boolean)};
    })
  };
}

export async function lookalikeProfile(env:Env,tenantId="tenant_clientmotive"):Promise<Record<string,unknown>>{
  const won=await env.DB.prepare(
    `SELECT a.segment,a.tier,o.value_estimate,ls.tier AS lead_tier
     FROM opportunity_outcomes oo
     JOIN opportunities o ON o.opportunity_id=oo.opportunity_id
     JOIN commercial_accounts a ON a.account_id=o.account_id
     LEFT JOIN lead_scores ls ON ls.lead_id=o.lead_id
     WHERE a.tenant_id=? AND oo.outcome_type='won' LIMIT 500`
  ).bind(tenantId).all<any>();
  const segments=new Map<string,{count:number;value:number}>();
  for(const row of won.results){
    const key=row.segment || "unknown";
    const current=segments.get(key) || {count:0,value:0};
    current.count+=1;current.value+=Number(row.value_estimate || 0);segments.set(key,current);
  }
  return {sampleSize:won.results.length,segments:[...segments.entries()].map(([segment,data])=>({segment,wins:data.count,averageValue:data.count?data.value/data.count:0})).sort((a,b)=>b.wins-a.wins),note:"Use only after enough won outcomes exist; this is descriptive, not causal."};
}
