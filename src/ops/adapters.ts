import type { Env } from "../types";
import { hmacSha256, timingSafeEqual } from "../lib/security";
import { ingestCommunication, upsertContact } from "./crm";
import { recordBillingEvent, recordAgreement } from "./lifecycle";
import { updateProviderHealth } from "./governance";

async function verifySecret(request:Request,raw:string,secret?:string):Promise<boolean>{
  if(!secret) return false;
  const signature=request.headers.get("x-clientmotive-signature") || request.headers.get("x-webhook-signature") || "";
  const expected=await hmacSha256(secret,raw);
  return timingSafeEqual(signature.toLowerCase(),expected.toLowerCase());
}

export async function ingestInboxWebhook(env:Env,request:Request):Promise<Record<string,unknown>>{
  const raw=await request.text();
  if(!(await verifySecret(request,raw,env.INBOX_WEBHOOK_SECRET || env.INTEGRATION_SHARED_SECRET))) throw new Error("unauthorized");
  const body=JSON.parse(raw) as any;
  const contactId=body.contact?await upsertContact(env,{
    accountId:body.accountId || null,fullName:String(body.contact.name || body.contact.email || "Unknown contact"),
    email:body.contact.email || null,title:body.contact.title || null,source:body.provider || "inbox"
  }):null;
  const result=await ingestCommunication(env,{
    provider:String(body.provider || "generic_inbox"),externalId:body.externalId || null,direction:body.direction==="outbound"?"outbound":"inbound",
    channel:String(body.channel || "email"),accountId:body.accountId || null,contactId,opportunityId:body.opportunityId || null,
    subject:body.subject || null,bodyText:body.bodyText || null,occurredAt:body.occurredAt,metadata:body.metadata || {}
  });
  await updateProviderHealth(env,{provider:String(body.provider || "generic_inbox"),ok:true});
  return result;
}

export async function ingestCrmWebhook(env:Env,request:Request):Promise<Record<string,unknown>>{
  const raw=await request.text();
  if(!(await verifySecret(request,raw,env.CRM_WEBHOOK_SECRET || env.INTEGRATION_SHARED_SECRET))) throw new Error("unauthorized");
  const body=JSON.parse(raw) as any;
  if(body.type==="contact"){
    const contactId=await upsertContact(env,{
      accountId:body.accountId || null,fullName:String(body.fullName || body.email || "CRM contact"),email:body.email || null,phone:body.phone || null,
      title:body.title || null,department:body.department || null,linkedinUrl:body.linkedinUrl || null,source:body.provider || "crm",metadata:body.metadata || {}
    });
    await updateProviderHealth(env,{provider:String(body.provider || "crm"),ok:true});
    return {contactId};
  }
  if(body.type==="activity"){
    const result=await ingestCommunication(env,{
      provider:String(body.provider || "crm"),externalId:body.externalId || null,direction:body.direction || "inbound",channel:body.channel || "crm_activity",
      accountId:body.accountId || null,contactId:body.contactId || null,opportunityId:body.opportunityId || null,subject:body.subject || null,
      bodyText:body.bodyText || body.note || null,occurredAt:body.occurredAt,metadata:body.metadata || {}
    });
    await updateProviderHealth(env,{provider:String(body.provider || "crm"),ok:true});
    return result;
  }
  return {ignored:true};
}

export async function ingestBillingWebhook(env:Env,request:Request):Promise<Record<string,unknown>>{
  const raw=await request.text();
  if(!(await verifySecret(request,raw,env.BILLING_WEBHOOK_SECRET || env.INTEGRATION_SHARED_SECRET))) throw new Error("unauthorized");
  const body=JSON.parse(raw) as any;
  const billingEventId=await recordBillingEvent(env,{
    accountId:body.accountId || null,opportunityId:body.opportunityId || null,provider:String(body.provider || env.BILLING_PROVIDER || "generic"),
    externalId:body.externalId || null,eventType:String(body.eventType || "unknown"),amount:body.amount===undefined?null:Number(body.amount),
    currency:body.currency || "GBP",status:body.status || null,occurredAt:body.occurredAt,metadata:body.metadata || {}
  });
  await updateProviderHealth(env,{provider:String(body.provider || "billing"),ok:true});
  return {billingEventId};
}

export async function ingestEsignWebhook(env:Env,request:Request):Promise<Record<string,unknown>>{
  const raw=await request.text();
  if(!(await verifySecret(request,raw,env.ESIGN_WEBHOOK_SECRET || env.INTEGRATION_SHARED_SECRET))) throw new Error("unauthorized");
  const body=JSON.parse(raw) as any;
  const agreementId=await recordAgreement(env,{
    accountId:String(body.accountId),opportunityId:body.opportunityId || null,provider:String(body.provider || env.ESIGN_PROVIDER || "generic"),
    externalId:body.externalId || null,title:String(body.title || "Agreement"),status:String(body.status || "unknown"),signedAt:body.signedAt || null,
    contentHash:body.contentHash || null,metadata:body.metadata || {}
  });
  await updateProviderHealth(env,{provider:String(body.provider || "esign"),ok:true});
  return {agreementId};
}
