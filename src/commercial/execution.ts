import type { Env } from "../types";
import { isoNow } from "../lib/ids";
import { createStructuredExperiment } from "./completion";
import { buildGrowthSnapshotV2, scanIntelligenceChanges } from "./productisation";
import { generateCommercialDocument } from "./convert";
import { prepareOutreachContact } from "./outbound";

function safeJson(value:string|null|undefined,fallback:any){try{return value?JSON.parse(value):fallback;}catch{return fallback;}}

export async function executeApprovedRecommendation(env:Env,executionId:string){
  const execution=await env.DB.prepare(
    `SELECT e.*,r.lead_id,r.account_id,r.opportunity_id,r.status AS recommendation_status
     FROM recommendation_executions e
     JOIN commercial_recommendations r ON r.recommendation_id=e.recommendation_id
     WHERE e.execution_id=?`
  ).bind(executionId).first<any>();
  if(!execution) throw new Error("execution_not_found");
  if(!execution.approved_by || !["approved","prepared"].includes(execution.status)) throw new Error("approval_required");

  const payload=safeJson(execution.payload_json,{});
  let result:any={};
  if(execution.action_type==="create_experiment"){
    result=await createStructuredExperiment(env,{
      name:String(payload.name||"Recommendation experiment"),
      dimension:String(payload.dimension||"commercial"),
      hypothesis:String(payload.hypothesis||"Test whether the approved recommendation improves the stated commercial outcome."),
      variants:payload.variants&&typeof payload.variants==="object"?payload.variants:{control:{},test:{}},
      audience:String(payload.audience||"Defined target audience"),
      channel:String(payload.channel||"unspecified"),
      primaryMetric:String(payload.primaryMetric||"qualified_outcome"),
      successCriteria:String(payload.successCriteria||"Agree a measurable success criterion before activation."),
      plannedDays:Number(payload.plannedDays||30)
    });
  }else if(execution.action_type==="scan_account"){
    const accountId=String(payload.accountId||execution.account_id||"");
    if(!accountId) throw new Error("account_id_required");
    result=await scanIntelligenceChanges(env,{accountId});
  }else if(execution.action_type==="generate_growth_snapshot"){
    const leadId=String(payload.leadId||execution.lead_id||"");
    if(!leadId) throw new Error("lead_id_required");
    result=await buildGrowthSnapshotV2(env,{leadId,opportunityId:execution.opportunity_id||null});
  }else if(execution.action_type==="generate_document"){
    const leadId=String(payload.leadId||execution.lead_id||"");
    if(!leadId) throw new Error("lead_id_required");
    const allowed=new Set(["scope","proposal","campaign_architecture","market_entry","icp_sprint","competitive_positioning","outbound_readiness","intelligence_brief"]);
    const type=String(payload.type||"intelligence_brief");
    if(!allowed.has(type)) throw new Error("unsupported_document_type");
    result=await generateCommercialDocument(env,{type:type as any,leadId,opportunityId:execution.opportunity_id||null});
  }else if(execution.action_type==="create_human_task"){
    const taskId="task_"+crypto.randomUUID().replaceAll("-","");
    await env.DB.prepare(
      `INSERT INTO human_tasks
       (task_id,task_type,entity_type,entity_id,title,reason,priority,status,assigned_to,payload_json,due_at,created_at)
       VALUES (?,?,?,?,?,?,?,'open',?,?,?,?)`
    ).bind(taskId,String(payload.taskType||"recommendation"),"recommendation",execution.recommendation_id,
      String(payload.title||"Review approved recommendation"),String(payload.reason||"Human action is required to complete this recommendation."),
      String(payload.priority||"normal"),payload.assignedTo||null,JSON.stringify(payload),payload.dueAt||null,isoNow()).run();
    result={taskId};
  }else if(execution.action_type==="prepare_outreach"){
    const candidateId=String(payload.candidateId||"");
    if(!candidateId) throw new Error("candidate_id_required");
    result=await prepareOutreachContact(env,candidateId,{personKey:payload.personKey?String(payload.personKey):null,enrich:payload.enrich===true});
    result={...result,sendPerformed:false,humanApprovalStillRequired:true};
  }else{
    throw new Error("unsupported_execution_action");
  }

  await env.DB.prepare("UPDATE recommendation_executions SET status='executed',result_json=?,executed_at=? WHERE execution_id=?")
    .bind(JSON.stringify(result),isoNow(),executionId).run();
  await env.DB.prepare("UPDATE commercial_recommendations SET status='in_progress',updated_at=? WHERE recommendation_id=? AND status IN ('recommended','accepted')")
    .bind(isoNow(),execution.recommendation_id).run();
  return {executionId,status:"executed",result};
}
