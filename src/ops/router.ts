import type { Env } from "../types";
import { error, json, corsHeaders } from "../lib/http";
import { id, isoNow } from "../lib/ids";
import { verifyAdmin } from "../lib/security";
import { cfg } from "../config";
import {
  addEnrichmentFact,
  addPermission,
  addSuppression,
  canContact,
  freshnessReport,
  ingestCommunication,
  recordDeliverability,
  setContactRole,
  upsertContact,
  verifyEmailIfConfigured
} from "./crm";
import {
  authorizeTenant,
  createHumanTask,
  createTenant,
  explanation,
  exportTenant,
  recordDecision,
  recordModelEvaluation,
  routeModel,
  systemHealth,
  upsertTenantMember
} from "./governance";
import {
  capacityAwarePriorities,
  generateRevenueForecast,
  lookalikeProfile,
  negativeIcp,
  refreshDealRisks,
  revenueConcentration,
  saveOpportunityEconomics,
  multiThreadingRecommendations
} from "./revenue";
import {
  addDeliveryMilestone,
  completeMilestone,
  customerSuccessState,
  discoverTenders,
  recordAgreement,
  recordBillingEvent,
  refreshPartnerEconomics,
  startOnboarding,
  timeToValue,
  upsertProcurementProfile
} from "./lifecycle";
import {
  buildAttribution,
  channelUnitEconomics,
  enrichCompanyWaterfall,
  generateBattlecard,
  harvestVoiceOfCustomer,
  predictCommercialTrigger,
  scoreEvidenceQuality,
  territoryWhitespace
} from "./intelligence";
import {
  addCredits,
  churnLessons,
  consumeCredits,
  createSelfServiceOrder,
  creditBalance,
  issuePartnerPortalToken,
  offerPerformance,
  partnerPortal,
  recommendPackage,
  recordChurnReview,
  updateSelfServiceOrder
} from "./product";
import {
  ingestBillingWebhook,
  ingestCrmWebhook,
  ingestEsignWebhook,
  ingestInboxWebhook
} from "./adapters";
import { crmDelta, syncStates, updateSyncState } from "./sync";

async function parseJson(request:Request,maxBytes=150_000):Promise<any>{
  const raw=await request.text();
  if(new TextEncoder().encode(raw).byteLength>maxBytes) throw new Error("payload_too_large");
  return JSON.parse(raw);
}

function tenantHeaders(request:Request){
  return {
    tenantId:request.headers.get("x-tenant-id") || "tenant_clientmotive",
    subjectId:request.headers.get("x-subject-id") || ""
  };
}

async function authorize(request:Request,env:Env,scope:string):Promise<boolean>{
  if(verifyAdmin(request,env)) return true;
  const {tenantId,subjectId}=tenantHeaders(request);
  if(!subjectId) return false;
  return authorizeTenant(env,{tenantId,subjectId,scope});
}

async function requireOps(request:Request,env:Env,scope:string):Promise<Response|null>{
  return await authorize(request,env,scope)?null:error("Unauthorized.",401,"unauthorized");
}

function browserOrigin(request:Request,env:Env):boolean{
  return request.headers.get("origin")===cfg(env).publicOrigin;
}

export async function routeOps(request:Request,env:Env):Promise<Response|null>{
  const url=new URL(request.url);
  const path=url.pathname.replace(/\/+$/,"") || "/";

  if(path==="/v1/integrations/inbox" && request.method==="POST"){
    try{return json(await ingestInboxWebhook(env,request),202);}catch(e){return error(String(e).includes("unauthorized")?"Unauthorized.":"Integration failed.",String(e).includes("unauthorized")?401:422);}
  }
  if(path==="/v1/integrations/crm" && request.method==="POST"){
    try{return json(await ingestCrmWebhook(env,request),202);}catch(e){return error(String(e).includes("unauthorized")?"Unauthorized.":"Integration failed.",String(e).includes("unauthorized")?401:422);}
  }
  if(path==="/v1/integrations/billing" && request.method==="POST"){
    try{return json(await ingestBillingWebhook(env,request),202);}catch(e){return error(String(e).includes("unauthorized")?"Unauthorized.":"Integration failed.",String(e).includes("unauthorized")?401:422);}
  }
  if(path==="/v1/integrations/esign" && request.method==="POST"){
    try{return json(await ingestEsignWebhook(env,request),202);}catch(e){return error(String(e).includes("unauthorized")?"Unauthorized.":"Integration failed.",String(e).includes("unauthorized")?401:422);}
  }

  const partnerPortalMatch=path.match(/^\/v1\/partner\/([^/]+)\/dashboard$/);
  if(partnerPortalMatch && request.method==="GET"){
    try{return json(await partnerPortal(env,partnerPortalMatch[1]!,url.searchParams.get("token") || ""));}
    catch{return error("Unauthorized.",401,"unauthorized");}
  }

  if(path==="/v1/self-service/orders" && request.method==="POST"){
    if(!browserOrigin(request,env)) return error("Origin not allowed.",403,"origin_rejected");
    try{
      const body=await parseJson(request,30_000);
      const orderId=await createSelfServiceOrder(env,{
        email:String(body.email || ""),productCode:String(body.productCode || ""),amount:null,
        currency:body.currency || "GBP",metadata:body.metadata || {}
      });
      return json({orderId,status:"created",paymentRequired:true},201,corsHeaders(request.headers.get("origin"),cfg(env).publicOrigin));
    }catch{return error("Invalid order.",422);}
  }

  if(!path.startsWith("/v1/ops/")) return null;

  if(path==="/v1/ops/health" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await systemHealth(env));
  }

  if(path==="/v1/ops/tenants" && request.method==="POST"){
    const denied=await requireOps(request,env,"*"); if(denied) return denied;
    return json({tenantId:await createTenant(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/tenant-members" && request.method==="POST"){
    const denied=await requireOps(request,env,"*"); if(denied) return denied;
    return json({memberId:await upsertTenantMember(env,await parseJson(request))},201);
  }

  if(path==="/v1/ops/contacts" && request.method==="POST"){
    const denied=await requireOps(request,env,"read:contacts"); if(denied) return denied;
    return json({contactId:await upsertContact(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/contact-roles" && request.method==="POST"){
    const denied=await requireOps(request,env,"read:contacts"); if(denied) return denied;
    return json({contactRoleId:await setContactRole(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/permissions" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:communications"); if(denied) return denied;
    return json({permissionId:await addPermission(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/suppressions" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:communications"); if(denied) return denied;
    return json({suppressionId:await addSuppression(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/contact-check" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:communications"); if(denied) return denied;
    return json(await canContact(env,await parseJson(request)));
  }
  if(path==="/v1/ops/deliverability" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:communications"); if(denied) return denied;
    return json({checkId:await recordDeliverability(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/deliverability/verify" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:communications"); if(denied) return denied;
    const body=await parseJson(request);return json(await verifyEmailIfConfigured(env,String(body.email || "")));
  }
  if(path==="/v1/ops/communications" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:communications"); if(denied) return denied;
    return json(await ingestCommunication(env,await parseJson(request)),201);
  }

  if(path==="/v1/ops/enrichment/facts" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:research"); if(denied) return denied;
    return json({factId:await addEnrichmentFact(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/enrichment/company" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:research"); if(denied) return denied;
    return json(await enrichCompanyWaterfall(env,await parseJson(request)),202);
  }
  if(path==="/v1/ops/enrichment/freshness" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await freshnessReport(env,url.searchParams.get("type") || "account",url.searchParams.get("id") || ""));
  }
  if(path==="/v1/ops/evidence-quality" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:research"); if(denied) return denied;
    return json(await scoreEvidenceQuality(env,await parseJson(request)),201);
  }

  if(path==="/v1/ops/attribution" && request.method==="POST"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await buildAttribution(env,await parseJson(request)),201);
  }
  if(path==="/v1/ops/attribution/channel-economics" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await channelUnitEconomics(env,tenantHeaders(request).tenantId));
  }
  if(path==="/v1/ops/territory/whitespace" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await territoryWhitespace(env,tenantHeaders(request).tenantId));
  }
  if(path==="/v1/ops/revenue/forecast" && request.method==="POST"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await generateRevenueForecast(env,await parseJson(request)),201);
  }
  if(path==="/v1/ops/revenue/target" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:opportunities"); if(denied) return denied;
    const body=await parseJson(request);const targetId=id("target");const tenantId=body.tenantId || tenantHeaders(request).tenantId;
    await env.DB.prepare("INSERT INTO revenue_targets (target_id,tenant_id,period_start,period_end,target_revenue,target_gross_margin,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(targetId,tenantId,body.periodStart,body.periodEnd,Number(body.targetRevenue),body.targetGrossMargin===undefined?null:Number(body.targetGrossMargin),body.currency || "GBP",isoNow(),isoNow()).run();
    return json({targetId},201);
  }
  if(path==="/v1/ops/capacity" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:accounts"); if(denied) return denied;
    const body=await parseJson(request);const capacityId=id("capacity");const tenantId=body.tenantId || tenantHeaders(request).tenantId;
    await env.DB.prepare("INSERT INTO capacity_periods (capacity_id,tenant_id,period_start,period_end,capacity_units,committed_units,unit_name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(capacityId,tenantId,body.periodStart,body.periodEnd,Number(body.capacityUnits),Number(body.committedUnits || 0),body.unitName || "delivery_days",JSON.stringify(body.metadata || {}),isoNow(),isoNow()).run();
    return json({capacityId},201);
  }
  if(path==="/v1/ops/capacity/priorities" && request.method==="POST"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await capacityAwarePriorities(env,await parseJson(request)));
  }
  const economics=path.match(/^\/v1\/ops\/opportunities\/([^/]+)\/economics$/);
  if(economics && request.method==="POST"){
    const denied=await requireOps(request,env,"write:opportunities"); if(denied) return denied;
    return json(await saveOpportunityEconomics(env,economics[1]!,await parseJson(request)),201);
  }
  const risks=path.match(/^\/v1\/ops\/opportunities\/([^/]+)\/risks$/);
  if(risks && request.method==="POST"){
    const denied=await requireOps(request,env,"write:opportunities"); if(denied) return denied;
    return json({risks:await refreshDealRisks(env,risks[1]!)});
  }
  const threading=path.match(/^\/v1\/ops\/opportunities\/([^/]+)\/multi-threading$/);
  if(threading && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await multiThreadingRecommendations(env,threading[1]!));
  }
  if(path==="/v1/ops/revenue/concentration" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await revenueConcentration(env,tenantHeaders(request).tenantId));
  }
  if(path==="/v1/ops/icp/negative" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await negativeIcp(env,tenantHeaders(request).tenantId));
  }
  if(path==="/v1/ops/icp/lookalike" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await lookalikeProfile(env,tenantHeaders(request).tenantId));
  }

  const procurement=path.match(/^\/v1\/ops\/accounts\/([^/]+)\/procurement$/);
  if(procurement && request.method==="POST"){
    const denied=await requireOps(request,env,"write:accounts"); if(denied) return denied;
    const body=await parseJson(request);await upsertProcurementProfile(env,{accountId:procurement[1]!,...body});return json({ok:true},201);
  }
  if(path==="/v1/ops/tenders/discover" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:research"); if(denied) return denied;
    return json({tenders:await discoverTenders(env,await parseJson(request))},201);
  }

  if(path==="/v1/ops/agreements" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:opportunities"); if(denied) return denied;
    return json({agreementId:await recordAgreement(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/billing-events" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:opportunities"); if(denied) return denied;
    return json({billingEventId:await recordBillingEvent(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/onboarding" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:delivery"); if(denied) return denied;
    return json({onboardingId:await startOnboarding(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/milestones" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:delivery"); if(denied) return denied;
    return json({milestoneId:await addDeliveryMilestone(env,await parseJson(request))},201);
  }
  const milestoneComplete=path.match(/^\/v1\/ops\/milestones\/([^/]+)\/complete$/);
  if(milestoneComplete && request.method==="POST"){
    const denied=await requireOps(request,env,"write:delivery"); if(denied) return denied;
    const body=await parseJson(request);await completeMilestone(env,milestoneComplete[1]!,body.qualityScore);return json({ok:true});
  }
  const ttv=path.match(/^\/v1\/ops\/accounts\/([^/]+)\/time-to-value$/);
  if(ttv && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await timeToValue(env,ttv[1]!));
  }
  const success=path.match(/^\/v1\/ops\/accounts\/([^/]+)\/success-state$/);
  if(success && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await customerSuccessState(env,success[1]!));
  }
  const partnerEconomics=path.match(/^\/v1\/ops\/partners\/([^/]+)\/economics$/);
  if(partnerEconomics && request.method==="POST"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await refreshPartnerEconomics(env,partnerEconomics[1]!));
  }

  if(path==="/v1/ops/voc/harvest" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:research"); if(denied) return denied;
    return json(await harvestVoiceOfCustomer(env,await parseJson(request)),201);
  }
  if(path==="/v1/ops/battlecards" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:research"); if(denied) return denied;
    return json(await generateBattlecard(env,await parseJson(request)),201);
  }
  const prediction=path.match(/^\/v1\/ops\/accounts\/([^/]+)\/trigger-prediction$/);
  if(prediction && request.method==="POST"){
    const denied=await requireOps(request,env,"write:research"); if(denied) return denied;
    return json(await predictCommercialTrigger(env,prediction[1]!),201);
  }

  if(path==="/v1/ops/offers/performance" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await offerPerformance(env,tenantHeaders(request).tenantId));
  }
  const packageMatch=path.match(/^\/v1\/ops\/opportunities\/([^/]+)\/package$/);
  if(packageMatch && request.method==="POST"){
    const denied=await requireOps(request,env,"write:opportunities"); if(denied) return denied;
    return json(await recommendPackage(env,{opportunityId:packageMatch[1]!}),201);
  }
  const orderMatch=path.match(/^\/v1\/ops\/orders\/([^/]+)$/);
  if(orderMatch && request.method==="POST"){
    const denied=await requireOps(request,env,"write:opportunities"); if(denied) return denied;
    await updateSelfServiceOrder(env,orderMatch[1]!,await parseJson(request));return json({ok:true});
  }

  const partnerToken=path.match(/^\/v1\/ops\/partners\/([^/]+)\/portal-token$/);
  if(partnerToken && request.method==="POST"){
    const denied=await requireOps(request,env,"write:accounts"); if(denied) return denied;
    const body=await parseJson(request);return json(await issuePartnerPortalToken(env,partnerToken[1]!,Number(body.expiresInDays || 90)),201);
  }

  if(path==="/v1/ops/credits" && request.method==="POST"){
    const denied=await requireOps(request,env,"*"); if(denied) return denied;
    return json({creditEventId:await addCredits(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/credits/balance" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json({balance:await creditBalance(env,{tenantId:tenantHeaders(request).tenantId,clientId:url.searchParams.get("client_id"),accountId:url.searchParams.get("account_id")})});
  }
  if(path==="/v1/ops/credits/consume" && request.method==="POST"){
    const denied=await requireOps(request,env,"api"); if(denied) return denied;
    return json(await consumeCredits(env,await parseJson(request)));
  }

  if(path==="/v1/ops/churn" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:accounts"); if(denied) return denied;
    return json({churnReviewId:await recordChurnReview(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/churn/lessons" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await churnLessons(env,tenantHeaders(request).tenantId));
  }

  if(path==="/v1/ops/tasks" && request.method==="POST"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json({taskId:await createHumanTask(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/tasks" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    const rows=await env.DB.prepare("SELECT * FROM human_tasks WHERE tenant_id=? AND status='open' ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,due_at,created_at LIMIT 200")
      .bind(tenantHeaders(request).tenantId).all<any>();return json({tasks:rows.results});
  }
  const taskComplete=path.match(/^\/v1\/ops\/tasks\/([^/]+)\/complete$/);
  if(taskComplete && request.method==="POST"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    await env.DB.prepare("UPDATE human_tasks SET status='complete',completed_at=? WHERE task_id=?").bind(isoNow(),taskComplete[1]!).run();return json({ok:true});
  }

  if(path==="/v1/ops/decisions" && request.method==="POST"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json({decisionId:await recordDecision(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/explain" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await explanation(env,url.searchParams.get("type") || "",url.searchParams.get("id") || ""));
  }
  if(path==="/v1/ops/model-route" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:research"); if(denied) return denied;
    return json(routeModel(await parseJson(request)));
  }
  if(path==="/v1/ops/model-evaluations" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:research"); if(denied) return denied;
    return json({evaluationId:await recordModelEvaluation(env,await parseJson(request))},201);
  }
  if(path==="/v1/ops/crm/delta" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json(await crmDelta(env,{tenantId:tenantHeaders(request).tenantId,since:url.searchParams.get("since"),limit:Number(url.searchParams.get("limit") || "200")}));
  }
  if(path==="/v1/ops/sync-state" && request.method==="POST"){
    const denied=await requireOps(request,env,"write:accounts"); if(denied) return denied;
    return json({syncId:await updateSyncState(env,{tenantId:tenantHeaders(request).tenantId,...await parseJson(request)})},201);
  }
  if(path==="/v1/ops/sync-state" && request.method==="GET"){
    const denied=await requireOps(request,env,"read:commercial"); if(denied) return denied;
    return json({states:await syncStates(env,tenantHeaders(request).tenantId)});
  }
  if(path==="/v1/ops/export" && request.method==="POST"){
    const denied=await requireOps(request,env,"*"); if(denied) return denied;
    const headers=tenantHeaders(request);return json(await exportTenant(env,headers.tenantId,headers.subjectId || "admin"),201);
  }
  const exportMatch=path.match(/^\/v1\/ops\/exports\/([^/]+)$/);
  if(exportMatch && request.method==="GET"){
    const denied=await requireOps(request,env,"*"); if(denied) return denied;
    const row=await env.DB.prepare("SELECT export_id,status,object_count,content_json,created_at,expires_at FROM data_exports WHERE export_id=? AND tenant_id=?").bind(exportMatch[1]!,tenantHeaders(request).tenantId).first<any>();
    return row?json({...row,content:row.content_json?JSON.parse(row.content_json):null}):error("Not found.",404);
  }

  return null;
}
