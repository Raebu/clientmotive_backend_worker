import type { Env } from "../types";
import { createHumanTask } from "./governance";
import { generateRevenueForecast, refreshDealRisks, revenueConcentration } from "./revenue";
import { customerSuccessState } from "./lifecycle";
import { scoreEvidenceQuality } from "./intelligence";

export async function runRevenueOperationsAutomation(env:Env):Promise<Record<string,unknown>>{
  const openOpps=await env.DB.prepare(
    "SELECT opportunity_id FROM opportunities WHERE stage NOT IN ('won','lost','closed') ORDER BY updated_at DESC LIMIT 30"
  ).all<{opportunity_id:string}>();
  let riskCount=0;
  for(const row of openOpps.results){
    const risks=await refreshDealRisks(env,row.opportunity_id);
    riskCount+=risks.length;
    const severe=risks.filter((risk)=>risk.severity>=75);
    if(severe.length){
      const existing=await env.DB.prepare(
        "SELECT task_id FROM human_tasks WHERE entity_type='opportunity' AND entity_id=? AND task_type='deal_risk' AND status='open' LIMIT 1"
      ).bind(row.opportunity_id).first();
      if(!existing){
        await createHumanTask(env,{taskType:"deal_risk",entityType:"opportunity",entityId:row.opportunity_id,title:"Review high-risk opportunity",reason:severe.map((r)=>r.rationale).join(" "),priority:"high",payload:{risks:severe}});
      }
    }
  }

  const accounts=await env.DB.prepare(
    "SELECT account_id FROM commercial_accounts WHERE status='active' ORDER BY updated_at DESC LIMIT 25"
  ).all<{account_id:string}>();
  let successAlerts=0;
  for(const row of accounts.results){
    const state=await customerSuccessState(env,row.account_id);
    if(["weak_outcomes","weak_engagement","sponsor_lost"].includes(String(state.state))){
      const existing=await env.DB.prepare(
        "SELECT task_id FROM human_tasks WHERE entity_type='account' AND entity_id=? AND task_type='customer_success' AND status='open' LIMIT 1"
      ).bind(row.account_id).first();
      if(!existing){
        await createHumanTask(env,{taskType:"customer_success",entityType:"account",entityId:row.account_id,title:"Client success intervention",reason:"Account state: "+String(state.state),priority:"high",payload:state});
        successAlerts+=1;
      }
    }
    try{await scoreEvidenceQuality(env,{entityType:"account",entityId:row.account_id,evidenceType:"commercial_profile"});}catch{}
  }

  const now=new Date();
  const periodStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString();
  const periodEnd=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,0,23,59,59)).toISOString();
  let forecast:Record<string,unknown>|null=null;
  try{
    forecast=await generateRevenueForecast(env,{periodStart,periodEnd}) as unknown as Record<string,unknown>;
    if(Number(forecast.revenueGap || 0)>0){
      const existing=await env.DB.prepare(
        "SELECT task_id FROM human_tasks WHERE task_type='revenue_gap' AND status='open' AND created_at>=datetime('now','start of month') LIMIT 1"
      ).first();
      if(!existing){
        await createHumanTask(env,{taskType:"revenue_gap",entityType:"tenant",entityId:"tenant_clientmotive",title:"Revenue gap requires pipeline action",reason:"Current forecast is below the configured revenue target.",priority:"high",payload:forecast});
      }
    }
  }catch{}

  const concentration=await revenueConcentration(env);
  return {openOpportunitiesReviewed:openOpps.results.length,risksDetected:riskCount,customerSuccessAlerts:successAlerts,forecast,revenueConcentration:concentration};
}
