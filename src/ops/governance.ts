import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import type { ModelRoute, Role } from "./types";

const ROLE_SCOPES:Record<Role,string[]>={
  admin:["*"],
  analyst:["read:commercial","write:research","write:content","read:contacts"],
  sales:["read:commercial","write:opportunities","read:contacts","write:communications"],
  account_manager:["read:commercial","write:accounts","write:delivery","read:contacts"],
  client:["read:client_portal"],
  partner:["read:partner_portal","write:referrals"],
  api:["api"]
};

export async function createTenant(env:Env,input:{name:string;slug:string;plan?:string;settings?:Record<string,unknown>}):Promise<string>{
  const tenantId=id("tenant");
  const now=isoNow();
  await env.DB.prepare(
    "INSERT INTO tenants (tenant_id,name,slug,status,plan,settings_json,created_at,updated_at) VALUES (?,?,?,'active',?,?,?,?)"
  ).bind(tenantId,input.name,input.slug.toLowerCase().replace(/[^a-z0-9-]/g,"-"),input.plan || "client",JSON.stringify(input.settings || {}),now,now).run();
  return tenantId;
}

export async function upsertTenantMember(env:Env,input:{tenantId:string;subjectId:string;subjectType?:string;roles:Role[];scopes?:string[]}):Promise<string>{
  const existing=await env.DB.prepare("SELECT member_id FROM tenant_members WHERE tenant_id=? AND subject_id=? LIMIT 1")
    .bind(input.tenantId,input.subjectId).first<{member_id:string}>();
  const now=isoNow();
  if(existing){
    await env.DB.prepare("UPDATE tenant_members SET subject_type=?,roles_json=?,scopes_json=?,status='active',updated_at=? WHERE member_id=?")
      .bind(input.subjectType || "user",JSON.stringify(input.roles),JSON.stringify(input.scopes || []),now,existing.member_id).run();
    return existing.member_id;
  }
  const memberId=id("member");
  await env.DB.prepare(
    "INSERT INTO tenant_members (member_id,tenant_id,subject_id,subject_type,roles_json,scopes_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?)"
  ).bind(memberId,input.tenantId,input.subjectId,input.subjectType || "user",JSON.stringify(input.roles),JSON.stringify(input.scopes || []),now,now).run();
  return memberId;
}

export async function authorizeTenant(env:Env,input:{tenantId:string;subjectId:string;scope:string}):Promise<boolean>{
  const member=await env.DB.prepare("SELECT roles_json,scopes_json,status FROM tenant_members WHERE tenant_id=? AND subject_id=? LIMIT 1")
    .bind(input.tenantId,input.subjectId).first<any>();
  if(!member || member.status!=="active") return false;
  const roles=JSON.parse(member.roles_json || "[]") as Role[];
  const explicit=JSON.parse(member.scopes_json || "[]") as string[];
  const scopes=new Set([...explicit,...roles.flatMap((role)=>ROLE_SCOPES[role] || [])]);
  return scopes.has("*") || scopes.has(input.scope);
}

export async function createHumanTask(env:Env,input:{
  tenantId?:string;taskType:string;entityType?:string|null;entityId?:string|null;title:string;reason:string;
  priority?:"low"|"normal"|"high"|"urgent";assignedTo?:string|null;payload?:Record<string,unknown>;dueAt?:string|null;
}):Promise<string>{
  const taskId=id("task");
  await env.DB.prepare(
    `INSERT INTO human_tasks (
      task_id,tenant_id,task_type,entity_type,entity_id,title,reason,priority,status,assigned_to,payload_json,due_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,'open',?,?,?,?)`
  ).bind(taskId,input.tenantId || "tenant_clientmotive",input.taskType,input.entityType || null,input.entityId || null,input.title,input.reason,input.priority || "normal",input.assignedTo || null,JSON.stringify(input.payload || {}),input.dueAt || null,isoNow()).run();
  return taskId;
}

export async function recordDecision(env:Env,input:{
  tenantId?:string;entityType?:string|null;entityId?:string|null;decisionType:string;recommendation?:unknown;evidence?:unknown[];
  confidence?:number|null;decidedBy?:string|null;decision?:string|null;
}):Promise<string>{
  const decisionId=id("decision");
  await env.DB.prepare(
    `INSERT INTO decision_audit (
      decision_id,tenant_id,entity_type,entity_id,decision_type,recommendation_json,evidence_json,
      confidence,decided_by,decision,created_at,decided_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(decisionId,input.tenantId || "tenant_clientmotive",input.entityType || null,input.entityId || null,input.decisionType,JSON.stringify(input.recommendation || {}),JSON.stringify(input.evidence || []),input.confidence || null,input.decidedBy || null,input.decision || null,isoNow(),input.decision?isoNow():null).run();
  return decisionId;
}

export async function explanation(env:Env,entityType:string,entityId:string):Promise<Record<string,unknown>>{
  const [decisions,facts,signals,risks]=await Promise.all([
    env.DB.prepare("SELECT * FROM decision_audit WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC LIMIT 20").bind(entityType,entityId).all<any>(),
    env.DB.prepare("SELECT * FROM enrichment_facts WHERE entity_type=? AND entity_id=? AND status='active' ORDER BY observed_at DESC LIMIT 30").bind(entityType,entityId).all<any>(),
    entityType==="account"?env.DB.prepare("SELECT * FROM commercial_signals WHERE account_id=? ORDER BY captured_at DESC LIMIT 20").bind(entityId).all<any>():Promise.resolve({results:[]} as any),
    entityType==="opportunity"?env.DB.prepare("SELECT * FROM deal_risks WHERE opportunity_id=? AND status='open' ORDER BY severity DESC").bind(entityId).all<any>():Promise.resolve({results:[]} as any)
  ]);
  return {entityType,entityId,decisions:decisions.results,facts:facts.results,signals:signals.results,risks:risks.results};
}

export function routeModel(input:{capability:string;complexity:number;requiresReasoning:boolean;deterministicPossible:boolean;budgetRemainingPercent:number;cheapModel?:string;strongModel?:string}):ModelRoute{
  if(input.deterministicPossible) return {model:"deterministic",mode:"deterministic",reason:"The task can be solved reliably without model inference.",estimatedRelativeCost:0};
  if(input.budgetRemainingPercent<=5) return {model:input.cheapModel || "@cf/zai-org/glm-4.7-flash",mode:"cheap_ai",reason:"Budget is nearly exhausted; use the cheapest acceptable model.",estimatedRelativeCost:1};
  if(input.requiresReasoning && input.complexity>=70) return {model:input.strongModel || "@cf/zai-org/glm-4.7-flash",mode:"strong_ai",reason:"Task requires higher reasoning effort.",estimatedRelativeCost:3};
  return {model:input.cheapModel || "@cf/zai-org/glm-4.7-flash",mode:"cheap_ai",reason:"Classification/synthesis can use the lower-cost model.",estimatedRelativeCost:1};
}

export async function reserveBudget(env:Env,input:{tenantId?:string;workflow:string;searchCalls?:number;aiCalls?:number;cost?:number}):Promise<{allowed:boolean;reason:string}>{
  const tenantId=input.tenantId || "tenant_clientmotive";
  const row=await env.DB.prepare("SELECT * FROM workflow_budgets WHERE tenant_id=? AND workflow=? LIMIT 1").bind(tenantId,input.workflow).first<any>();
  if(!row) return {allowed:true,reason:"No explicit budget configured."};
  if(row.resets_at && new Date(row.resets_at).getTime()<=Date.now()){
    const next=new Date();next.setUTCMonth(next.getUTCMonth()+1,1);next.setUTCHours(0,0,0,0);
    await env.DB.prepare("UPDATE workflow_budgets SET spent_search_calls=0,spent_ai_calls=0,spent_cost=0,resets_at=?,updated_at=? WHERE budget_id=?")
      .bind(next.toISOString(),isoNow(),row.budget_id).run();
    row.spent_search_calls=0;row.spent_ai_calls=0;row.spent_cost=0;
  }
  const searches=Number(row.spent_search_calls || 0)+Number(input.searchCalls || 0);
  const ai=Number(row.spent_ai_calls || 0)+Number(input.aiCalls || 0);
  const cost=Number(row.spent_cost || 0)+Number(input.cost || 0);
  if(row.max_search_calls!==null && searches>Number(row.max_search_calls)) return {allowed:false,reason:"Search-call budget exceeded."};
  if(row.max_ai_calls!==null && ai>Number(row.max_ai_calls)) return {allowed:false,reason:"AI-call budget exceeded."};
  if(row.max_cost!==null && cost>Number(row.max_cost)) return {allowed:false,reason:"Workflow cost budget exceeded."};
  await env.DB.prepare("UPDATE workflow_budgets SET spent_search_calls=?,spent_ai_calls=?,spent_cost=?,updated_at=? WHERE budget_id=?")
    .bind(searches,ai,cost,isoNow(),row.budget_id).run();
  return {allowed:true,reason:"Within configured workflow budget."};
}

export async function recordModelEvaluation(env:Env,input:{
  capability:string;model:string;promptVersion?:string|null;datasetVersion?:string|null;sampleSize?:number;
  accuracy?:number|null;grounding?:number|null;usefulness?:number|null;costEstimate?:number|null;latencyMs?:number|null;details?:Record<string,unknown>;
}):Promise<string>{
  const evaluationId=id("eval");
  await env.DB.prepare(
    `INSERT INTO model_evaluations (
      evaluation_id,capability,model,prompt_version,dataset_version,sample_size,accuracy_score,grounding_score,
      usefulness_score,cost_estimate,latency_ms,details_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(evaluationId,input.capability,input.model,input.promptVersion || null,input.datasetVersion || null,input.sampleSize || 0,input.accuracy || null,input.grounding || null,input.usefulness || null,input.costEstimate || null,input.latencyMs || null,JSON.stringify(input.details || {}),isoNow()).run();
  return evaluationId;
}

export async function updateProviderHealth(env:Env,input:{provider:string;ok:boolean;quotaRemaining?:number|null;details?:Record<string,unknown>}):Promise<void>{
  const now=isoNow();
  const existing=await env.DB.prepare("SELECT * FROM provider_health WHERE provider=?").bind(input.provider).first<any>();
  const failures=input.ok?0:Number(existing?.consecutive_failures || 0)+1;
  await env.DB.prepare(
    `INSERT INTO provider_health (provider,status,last_success_at,last_failure_at,consecutive_failures,quota_remaining,details_json,updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(provider) DO UPDATE SET
       status=excluded.status,last_success_at=COALESCE(excluded.last_success_at,provider_health.last_success_at),
       last_failure_at=COALESCE(excluded.last_failure_at,provider_health.last_failure_at),
       consecutive_failures=excluded.consecutive_failures,quota_remaining=excluded.quota_remaining,
       details_json=excluded.details_json,updated_at=excluded.updated_at`
  ).bind(input.provider,input.ok?"healthy":"degraded",input.ok?now:null,input.ok?null:now,failures,input.quotaRemaining || null,JSON.stringify(input.details || {}),now).run();
}

export async function systemHealth(env:Env):Promise<Record<string,unknown>>{
  const [providers,failedJobs,staleWatchlists,openTasks,budgets]=await Promise.all([
    env.DB.prepare("SELECT * FROM provider_health ORDER BY status DESC,updated_at DESC").all<any>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM research_jobs WHERE status='failed' AND updated_at >= datetime('now','-7 days')").first<{count:number}>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM watchlists WHERE status='active' AND next_check_at < datetime('now','-2 days')").first<{count:number}>(),
    env.DB.prepare("SELECT priority,COUNT(*) AS count FROM human_tasks WHERE status='open' GROUP BY priority").all<any>(),
    env.DB.prepare("SELECT workflow,max_search_calls,spent_search_calls,max_ai_calls,spent_ai_calls,max_cost,spent_cost,resets_at FROM workflow_budgets").all<any>()
  ]);
  return {providers:providers.results,failedResearchJobs:Number(failedJobs?.count || 0),staleWatchlists:Number(staleWatchlists?.count || 0),openHumanTasks:openTasks.results,budgets:budgets.results};
}

export async function exportTenant(env:Env,tenantId:string,createdBy:string):Promise<{exportId:string;objectCount:number}>{
  const exportId=id("export");
  const [accounts,contacts,opportunities,communications,signals,outcomes]=await Promise.all([
    env.DB.prepare("SELECT * FROM commercial_accounts WHERE tenant_id=?").bind(tenantId).all<any>(),
    env.DB.prepare("SELECT * FROM contacts WHERE tenant_id=?").bind(tenantId).all<any>(),
    env.DB.prepare("SELECT * FROM opportunities WHERE tenant_id=?").bind(tenantId).all<any>(),
    env.DB.prepare("SELECT * FROM communication_events WHERE tenant_id=?").bind(tenantId).all<any>(),
    env.DB.prepare("SELECT s.* FROM commercial_signals s JOIN commercial_accounts a ON a.account_id=s.account_id WHERE a.tenant_id=?").bind(tenantId).all<any>(),
    env.DB.prepare("SELECT oo.* FROM opportunity_outcomes oo JOIN opportunities o ON o.opportunity_id=oo.opportunity_id WHERE o.tenant_id=?").bind(tenantId).all<any>()
  ]);
  const content={accounts:accounts.results,contacts:contacts.results,opportunities:opportunities.results,communications:communications.results,signals:signals.results,outcomes:outcomes.results,exportedAt:isoNow()};
  const count=[accounts,contacts,opportunities,communications,signals,outcomes].reduce((sum,r)=>sum+r.results.length,0);
  const expires=new Date(Date.now()+7*86_400_000).toISOString();
  await env.DB.prepare(
    "INSERT INTO data_exports (export_id,tenant_id,export_type,status,object_count,content_json,created_by,created_at,completed_at,expires_at) VALUES (?,?,'full','complete',?,?,?,?,?,?)"
  ).bind(exportId,tenantId,count,JSON.stringify(content),createdBy,isoNow(),isoNow(),expires).run();
  return {exportId,objectCount:count};
}
