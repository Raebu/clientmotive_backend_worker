import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";
import { hashValue, timingSafeEqual } from "../lib/security";
import { aiJson } from "../services/ai";
import { generateCommercialDocument } from "../commercial/convert";
import { createHumanTask } from "./governance";

export async function offerPerformance(env:Env,tenantId="tenant_clientmotive"):Promise<Record<string,unknown>>{
  const rows=await env.DB.prepare(
    `SELECT op.product_code,p.name,
      COUNT(DISTINCT op.opportunity_id) AS opportunities,
      SUM(CASE WHEN oo.outcome_type='won' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN oo.outcome_type='lost' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN oo.outcome_type='won' THEN COALESCE(oo.value,0) ELSE 0 END) AS won_value,
      AVG(oe.expected_margin) AS expected_margin
     FROM opportunity_products op
     JOIN commercial_products p ON p.product_code=op.product_code
     JOIN opportunities o ON o.opportunity_id=op.opportunity_id
     LEFT JOIN opportunity_outcomes oo ON oo.opportunity_id=op.opportunity_id
     LEFT JOIN opportunity_economics oe ON oe.opportunity_id=op.opportunity_id
     WHERE o.tenant_id=?
     GROUP BY op.product_code,p.name ORDER BY won_value DESC`
  ).bind(tenantId).all<any>();
  return {products:rows.results.map((row)=>({...row,winRate:Number(row.wins || 0)+Number(row.losses || 0)>=3?Math.round(Number(row.wins || 0)/(Number(row.wins || 0)+Number(row.losses || 0))*1000)/10:null}))};
}

export async function recommendPackage(env:Env,input:{opportunityId:string}):Promise<Record<string,unknown>>{
  const [opp,lead,products,score]=await Promise.all([
    env.DB.prepare("SELECT * FROM opportunities WHERE opportunity_id=?").bind(input.opportunityId).first<any>(),
    env.DB.prepare("SELECT l.* FROM leads l JOIN opportunities o ON o.lead_id=l.lead_id WHERE o.opportunity_id=?").bind(input.opportunityId).first<any>(),
    env.DB.prepare("SELECT * FROM commercial_products WHERE active=1 ORDER BY category").all<any>(),
    env.DB.prepare("SELECT ls.* FROM lead_scores ls JOIN opportunities o ON o.lead_id=ls.lead_id WHERE o.opportunity_id=?").bind(input.opportunityId).first<any>()
  ]);
  if(!opp) throw new Error("opportunity_not_found");
  const fallback={recommendations:[{productCode:"outbound_audit",fitScore:60,rationale:"Start with diagnosis before scaling execution."}],doNotUpsellReason:null};
  const result=await aiJson<{recommendations:Array<{productCode:string;fitScore:number;rationale:string}>;doNotUpsellReason:string|null}>(
    env,
    "You recommend ClientMotive packaging based on need and fit, not price maximisation. Never recommend a service that the context does not justify.",
    `OPPORTUNITY: ${JSON.stringify(opp)}\nLEAD: ${JSON.stringify(lead || {})}\nSCORE: ${JSON.stringify(score || {})}\nPRODUCTS: ${JSON.stringify(products.results)}\nReturn recommendations[{productCode,fitScore,rationale}], doNotUpsellReason|null.`,
    fallback,
    900
  );
  await env.DB.prepare("DELETE FROM opportunity_products WHERE opportunity_id=?").bind(input.opportunityId).run();
  if(result.recommendations.length){
    await env.DB.batch(result.recommendations.slice(0,5).map((item)=>env.DB.prepare(
      "INSERT INTO opportunity_products (opportunity_id,product_code,fit_score,rationale,selected,created_at,updated_at) VALUES (?,?,?,?,0,?,?)"
    ).bind(input.opportunityId,item.productCode,Math.max(0,Math.min(100,item.fitScore)),item.rationale,isoNow(),isoNow())));
  }
  return result;
}

export async function createSelfServiceOrder(env:Env,input:{tenantId?:string;accountId?:string|null;email:string;productCode:string;amount?:number|null;currency?:string;metadata?:Record<string,unknown>}):Promise<string>{
  const product=await env.DB.prepare("SELECT product_code FROM commercial_products WHERE product_code=? AND active=1").bind(input.productCode).first();
  if(!product) throw new Error("product_not_available");
  const orderId=id("order");
  const now=isoNow();
  await env.DB.prepare(
    `INSERT INTO self_service_orders (
      order_id,tenant_id,account_id,email,product_code,status,amount,currency,metadata_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,'created',?,?,?, ?,?)`
  ).bind(orderId,input.tenantId || "tenant_clientmotive",input.accountId || null,input.email.toLowerCase(),input.productCode,input.amount || null,input.currency || "GBP",JSON.stringify(input.metadata || {}),now,now).run();
  return orderId;
}

export async function updateSelfServiceOrder(env:Env,orderId:string,input:{status:string;billingExternalId?:string|null;researchJobId?:string|null;deliveryDocumentId?:string|null}):Promise<void>{
  await env.DB.prepare(
    `UPDATE self_service_orders SET status=?,billing_external_id=COALESCE(?,billing_external_id),
      research_job_id=COALESCE(?,research_job_id),delivery_document_id=COALESCE(?,delivery_document_id),updated_at=? WHERE order_id=?`
  ).bind(input.status,input.billingExternalId || null,input.researchJobId || null,input.deliveryDocumentId || null,isoNow(),orderId).run();
}

export async function issuePartnerPortalToken(env:Env,partnerId:string,expiresInDays=90):Promise<{token:string;tokenId:string;expiresAt:string}>{
  const token="cmpart_"+crypto.randomUUID().replaceAll("-","")+crypto.randomUUID().replaceAll("-","");
  const tokenId=id("parttok");
  const expiresAt=new Date(Date.now()+Math.max(1,Math.min(365,expiresInDays))*86_400_000).toISOString();
  await env.DB.prepare("INSERT INTO partner_portal_tokens (token_id,partner_id,token_hash,status,expires_at,created_at) VALUES (?,?,?,'active',?,?)")
    .bind(tokenId,partnerId,await hashValue(token),expiresAt,isoNow()).run();
  return {token,tokenId,expiresAt};
}

export async function partnerPortal(env:Env,partnerId:string,token:string):Promise<Record<string,unknown>>{
  const hash=await hashValue(token);
  const access=await env.DB.prepare("SELECT * FROM partner_portal_tokens WHERE partner_id=? AND token_hash=? AND status='active' LIMIT 1")
    .bind(partnerId,hash).first<any>();
  if(!access || !timingSafeEqual(access.token_hash,hash) || (access.expires_at && new Date(access.expires_at).getTime()<Date.now())) throw new Error("unauthorized");
  await env.DB.prepare("UPDATE partner_portal_tokens SET last_used_at=? WHERE token_id=?").bind(isoNow(),access.token_id).run();
  const [partner,referrals,performance]=await Promise.all([
    env.DB.prepare("SELECT partner_id,name,website,partner_type,status FROM partner_candidates WHERE partner_id=?").bind(partnerId).first<any>(),
    env.DB.prepare("SELECT referral_id,referred_name,status,attributed_value,created_at,updated_at FROM referrals WHERE referrer_id=? ORDER BY created_at DESC LIMIT 100").bind(partnerId).all<any>(),
    env.DB.prepare("SELECT * FROM partner_performance WHERE partner_id=?").bind(partnerId).first<any>()
  ]);
  return {partner,referrals:referrals.results,performance:performance || null};
}

export async function creditBalance(env:Env,input:{tenantId?:string;clientId?:string|null;accountId?:string|null}):Promise<number>{
  const tenantId=input.tenantId || "tenant_clientmotive";
  const row=await env.DB.prepare(
    `SELECT COALESCE(SUM(credits),0) AS balance FROM credit_ledger
     WHERE tenant_id=? AND (? IS NULL OR client_id=?) AND (? IS NULL OR account_id=?)`
  ).bind(tenantId,input.clientId || null,input.clientId || null,input.accountId || null,input.accountId || null).first<{balance:number}>();
  return Number(row?.balance || 0);
}

export async function addCredits(env:Env,input:{tenantId?:string;clientId?:string|null;accountId?:string|null;credits:number;eventType:string;capability?:string|null;referenceId?:string|null}):Promise<string>{
  const eventId=id("credit");
  await env.DB.prepare(
    "INSERT INTO credit_ledger (credit_event_id,tenant_id,client_id,account_id,event_type,credits,capability,reference_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(eventId,input.tenantId || "tenant_clientmotive",input.clientId || null,input.accountId || null,input.eventType,Math.trunc(input.credits),input.capability || null,input.referenceId || null,isoNow()).run();
  return eventId;
}

export async function consumeCredits(env:Env,input:{tenantId?:string;clientId?:string|null;accountId?:string|null;credits:number;capability:string;referenceId?:string|null}):Promise<{allowed:boolean;balance:number}>{
  const balance=await creditBalance(env,input);
  const needed=Math.max(1,Math.trunc(input.credits));
  if(balance<needed) return {allowed:false,balance};
  await addCredits(env,{...input,credits:-needed,eventType:"usage"});
  return {allowed:true,balance:balance-needed};
}

export async function recordChurnReview(env:Env,input:{tenantId?:string;accountId:string;opportunityId?:string|null;primaryReason:string;contributingFactors?:string[];preventability?:string|null;qualificationLessons?:string[];deliveryLessons?:string[]}):Promise<string>{
  const reviewId=id("churn");
  await env.DB.prepare(
    `INSERT INTO churn_reviews (
      churn_review_id,tenant_id,account_id,opportunity_id,primary_reason,contributing_factors_json,preventability,
      qualification_lessons_json,delivery_lessons_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(reviewId,input.tenantId || "tenant_clientmotive",input.accountId,input.opportunityId || null,input.primaryReason,JSON.stringify(input.contributingFactors || []),input.preventability || null,JSON.stringify(input.qualificationLessons || []),JSON.stringify(input.deliveryLessons || []),isoNow()).run();
  return reviewId;
}

export async function churnLessons(env:Env,tenantId="tenant_clientmotive"):Promise<Record<string,unknown>>{
  const rows=await env.DB.prepare(
    "SELECT primary_reason,preventability,qualification_lessons_json,delivery_lessons_json FROM churn_reviews WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200"
  ).bind(tenantId).all<any>();
  const counts=new Map<string,number>();
  for(const row of rows.results) counts.set(row.primary_reason,(counts.get(row.primary_reason) || 0)+1);
  return {
    sampleSize:rows.results.length,
    reasons:[...counts.entries()].map(([reason,count])=>({reason,count})).sort((a,b)=>b.count-a.count),
    qualificationLessons:rows.results.flatMap((r)=>JSON.parse(r.qualification_lessons_json || "[]")).slice(0,50),
    deliveryLessons:rows.results.flatMap((r)=>JSON.parse(r.delivery_lessons_json || "[]")).slice(0,50)
  };
}


export async function fulfilPaidSelfServiceOrders(env:Env,limit=20):Promise<{processed:number;fulfilled:number;needsReview:number}>{
  const rows=await env.DB.prepare(
    "SELECT * FROM self_service_orders WHERE status='paid' ORDER BY created_at LIMIT ?"
  ).bind(Math.max(1,Math.min(50,limit))).all<any>();
  let fulfilled=0,needsReview=0;
  const mapping:Record<string,"icp_sprint"|"competitive_positioning"|"outbound_readiness"|"campaign_architecture"|"intelligence_brief">={
    icp_sprint:"icp_sprint",
    competitive_sprint:"competitive_positioning",
    outbound_audit:"outbound_readiness",
    campaign_architecture:"campaign_architecture",
    market_intelligence:"intelligence_brief"
  };
  for(const order of rows.results){
    const metadata=JSON.parse(order.metadata_json || "{}") as Record<string,unknown>;
    const leadId=typeof metadata.leadId==="string"?metadata.leadId:null;
    const opportunityId=typeof metadata.opportunityId==="string"?metadata.opportunityId:null;
    const docType=mapping[order.product_code];
    if(leadId && docType){
      try{
        const result=await generateCommercialDocument(env,{type:docType,leadId,opportunityId});
        await updateSelfServiceOrder(env,order.order_id,{status:"fulfilled",deliveryDocumentId:result.documentId});
        fulfilled+=1;
        continue;
      }catch{}
    }
    await createHumanTask(env,{
      taskType:"self_service_fulfilment",
      entityType:"order",
      entityId:order.order_id,
      title:"Fulfil paid ClientMotive intelligence order",
      reason:"The order is paid but needs a human review or missing lead context before delivery.",
      priority:"high",
      payload:{productCode:order.product_code,email:order.email,metadata}
    });
    await updateSelfServiceOrder(env,order.order_id,{status:"needs_review"});
    needsReview+=1;
  }
  return {processed:rows.results.length,fulfilled,needsReview};
}
