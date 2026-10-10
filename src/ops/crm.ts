import type { Env } from "../types";
import { id, isoNow, normalizeDomain } from "../lib/ids";
import { hashValue } from "../lib/security";
import { aiJson } from "../services/ai";
import type { ContactDecision } from "./types";

export async function upsertContact(env: Env, input: {
  tenantId?: string;
  accountId?: string | null;
  leadId?: string | null;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  department?: string | null;
  linkedinUrl?: string | null;
  source?: string | null;
  confidence?: number;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const tenantId = input.tenantId || "tenant_clientmotive";
  const email = input.email?.trim().toLowerCase() || null;
  if (email) {
    const existing = await env.DB.prepare(
      "SELECT contact_id FROM contacts WHERE tenant_id=? AND email=? LIMIT 1"
    ).bind(tenantId, email).first<{ contact_id: string }>();
    if (existing) {
      await env.DB.prepare(
        `UPDATE contacts SET account_id=COALESCE(?,account_id),lead_id=COALESCE(?,lead_id),
         full_name=?,phone=COALESCE(?,phone),title=COALESCE(?,title),department=COALESCE(?,department),
         linkedin_url=COALESCE(?,linkedin_url),source=COALESCE(?,source),confidence=?,metadata_json=?,updated_at=?
         WHERE contact_id=?`
      ).bind(
        input.accountId || null,input.leadId || null,input.fullName,input.phone || null,
        input.title || null,input.department || null,input.linkedinUrl || null,input.source || null,
        Math.max(0,Math.min(100,input.confidence || 50)),JSON.stringify(input.metadata || {}),isoNow(),existing.contact_id
      ).run();
      return existing.contact_id;
    }
  }
  const contactId=id("contact");
  const now=isoNow();
  await env.DB.prepare(
    `INSERT INTO contacts (
      contact_id,tenant_id,account_id,lead_id,full_name,email,phone,title,department,linkedin_url,
      lifecycle_stage,source,confidence,metadata_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,'known',?,?,?,?,?)`
  ).bind(
    contactId,tenantId,input.accountId || null,input.leadId || null,input.fullName,email,input.phone || null,
    input.title || null,input.department || null,input.linkedinUrl || null,input.source || null,
    Math.max(0,Math.min(100,input.confidence || 50)),JSON.stringify(input.metadata || {}),now,now
  ).run();
  return contactId;
}

export async function setContactRole(env: Env, input: {
  contactId: string; accountId: string; roleType: string; relationshipStrength?: number;
  isPrimary?: boolean; sourceUrl?: string | null; evidence?: string[];
}): Promise<string> {
  const existing=await env.DB.prepare(
    "SELECT contact_role_id FROM contact_roles WHERE contact_id=? AND account_id=? AND role_type=? LIMIT 1"
  ).bind(input.contactId,input.accountId,input.roleType).first<{contact_role_id:string}>();
  const now=isoNow();
  if(existing){
    await env.DB.prepare(
      "UPDATE contact_roles SET relationship_strength=?,is_primary=?,source_url=?,evidence_json=?,updated_at=? WHERE contact_role_id=?"
    ).bind(Math.max(0,Math.min(100,input.relationshipStrength || 50)),input.isPrimary?1:0,input.sourceUrl || null,JSON.stringify(input.evidence || []),now,existing.contact_role_id).run();
    return existing.contact_role_id;
  }
  const roleId=id("crole");
  await env.DB.prepare(
    `INSERT INTO contact_roles (
      contact_role_id,contact_id,account_id,role_type,relationship_strength,is_primary,source_url,evidence_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(roleId,input.contactId,input.accountId,input.roleType,Math.max(0,Math.min(100,input.relationshipStrength || 50)),input.isPrimary?1:0,input.sourceUrl || null,JSON.stringify(input.evidence || []),now,now).run();
  return roleId;
}

export async function addPermission(env: Env,input:{
  tenantId?:string;contactId?:string|null;email?:string|null;channel:string;purpose:string;lawfulBasis?:string|null;
  status:"allowed"|"denied"|"objected"|"withdrawn"|"unknown";source?:string|null;noticeVersion?:string|null;expiresAt?:string|null;metadata?:Record<string,unknown>;
}):Promise<string>{
  const permissionId=id("perm");
  await env.DB.prepare(
    `INSERT INTO contact_permissions (
      permission_id,tenant_id,contact_id,email,channel,purpose,lawful_basis,status,source,notice_version,recorded_at,expires_at,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(permissionId,input.tenantId || "tenant_clientmotive",input.contactId || null,input.email?.toLowerCase() || null,input.channel,input.purpose,input.lawfulBasis || null,input.status,input.source || null,input.noticeVersion || null,isoNow(),input.expiresAt || null,JSON.stringify(input.metadata || {})).run();
  return permissionId;
}

export async function addSuppression(env:Env,input:{
  tenantId?:string;valueType:"email"|"domain"|"phone";value:string;reason:string;scope?:"tenant"|"global";source?:string|null;expiresAt?:string|null;metadata?:Record<string,unknown>;
}):Promise<string>{
  const tenantId=input.tenantId || "tenant_clientmotive";
  const normalized=input.valueType==="email"||input.valueType==="domain"?input.value.trim().toLowerCase():input.value.trim();
  const hash=await hashValue(normalized);
  const existing=await env.DB.prepare(
    "SELECT suppression_id FROM suppression_entries WHERE tenant_id=? AND value_type=? AND value_hash=? AND scope=? LIMIT 1"
  ).bind(tenantId,input.valueType,hash,input.scope || "tenant").first<{suppression_id:string}>();
  if(existing) return existing.suppression_id;
  const suppressionId=id("suppress");
  await env.DB.prepare(
    `INSERT INTO suppression_entries (
      suppression_id,tenant_id,value_type,value_hash,reason,scope,source,created_at,expires_at,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(suppressionId,tenantId,input.valueType,hash,input.reason,input.scope || "tenant",input.source || null,isoNow(),input.expiresAt || null,JSON.stringify(input.metadata || {})).run();
  return suppressionId;
}

export async function canContact(env:Env,input:{
  tenantId?:string;email:string;channel?:string;purpose?:string;
}):Promise<ContactDecision>{
  const tenantId=input.tenantId || "tenant_clientmotive";
  const email=input.email.trim().toLowerCase();
  const domain=normalizeDomain(email.split("@")[1] || "") || (email.split("@")[1] || "").toLowerCase();
  const [emailHash,domainHash]=await Promise.all([hashValue(email),hashValue(domain || "")]);
  const suppression=await env.DB.prepare(
    `SELECT reason FROM suppression_entries
     WHERE (tenant_id=? OR scope='global') AND (
       (value_type='email' AND value_hash=?) OR (value_type='domain' AND value_hash=?)
     ) AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`
  ).bind(tenantId,emailHash,domainHash,isoNow()).first<{reason:string}>();
  if(suppression) return {allowed:false,reason:"Suppression matched: "+suppression.reason,suppressionMatched:true,permissionStatus:null};

  const permission=await env.DB.prepare(
    `SELECT status FROM contact_permissions
     WHERE tenant_id=? AND email=? AND channel=? AND purpose=?
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY recorded_at DESC LIMIT 1`
  ).bind(tenantId,email,input.channel || "email",input.purpose || "business_development",isoNow()).first<{status:string}>();
  if(permission && ["denied","objected","withdrawn"].includes(permission.status)){
    return {allowed:false,reason:"Latest permission state is "+permission.status+".",suppressionMatched:false,permissionStatus:permission.status};
  }

  const delivery=await env.DB.prepare(
    `SELECT status,risk_score FROM deliverability_checks
     WHERE email=? AND expires_at > ? ORDER BY checked_at DESC LIMIT 1`
  ).bind(email,isoNow()).first<{status:string;risk_score:number}>();
  if(delivery && (delivery.status==="invalid" || Number(delivery.risk_score)>=85)){
    return {allowed:false,reason:"Deliverability risk is too high.",suppressionMatched:false,permissionStatus:permission?.status || null};
  }
  return {allowed:true,reason:permission?.status==="allowed"?"Explicit/recorded permission allows contact.":"No suppression or blocking permission state is recorded; lawful-basis review remains a policy decision.",suppressionMatched:false,permissionStatus:permission?.status || null};
}

export async function recordDeliverability(env:Env,input:{
  tenantId?:string;email?:string|null;domain?:string|null;provider:string;status:string;riskScore:number;details?:Record<string,unknown>;ttlDays?:number;
}):Promise<string>{
  const checkId=id("deliver");
  const expires=new Date(Date.now()+Math.max(1,Math.min(90,input.ttlDays || 14))*86_400_000).toISOString();
  await env.DB.prepare(
    "INSERT INTO deliverability_checks (check_id,tenant_id,email,domain,provider,status,risk_score,details_json,checked_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).bind(checkId,input.tenantId || "tenant_clientmotive",input.email?.toLowerCase() || null,input.domain?.toLowerCase() || null,input.provider,input.status,Math.max(0,Math.min(100,input.riskScore)),JSON.stringify(input.details || {}),isoNow(),expires).run();
  return checkId;
}

export async function verifyEmailIfConfigured(env:Env,email:string):Promise<Record<string,unknown>>{
  if(env.QUICKEMAILVERIFICATION_API_KEY){
    try{
      const url=new URL("https://api.quickemailverification.com/v1/verify");
      url.searchParams.set("email",email);
      url.searchParams.set("apikey",env.QUICKEMAILVERIFICATION_API_KEY);
      const response=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(12000)});
      if(response.ok){
        const data=await response.json() as any;
        const status=String(data.result || "unknown").toLowerCase();
        const safe=data.safe_to_send===true || data.safe_to_send==="true";
        const disposable=data.disposable===true || data.disposable==="true";
        const role=data.role===true || data.role==="true";
        const acceptAll=data.accept_all===true || data.accept_all==="true";
        const risk=status==="invalid" || disposable?95:
          safe && !role && !acceptAll?5:
          status==="valid" && !acceptAll?20:
          acceptAll?65:
          status==="unknown"?55:45;
        await recordDeliverability(env,{email,provider:"quickemailverification",status,riskScore:risk,details:data});
        if(status!=="unknown"){
          return {configured:true,provider:"quickemailverification",status,riskScore:risk,safeToSend:safe,role,acceptAll,disposable};
        }
      }else{
        const error="qev_"+response.status;
        if(!env.HUNTER_API_KEY) return {configured:true,provider:"quickemailverification",status:"unknown",riskScore:60,error};
      }
    }catch(error){
      if(!env.HUNTER_API_KEY) return {configured:true,provider:"quickemailverification",status:"unknown",riskScore:60,error:String(error)};
    }
  }
  if(env.HUNTER_API_KEY){
    try{
      const url=new URL("https://api.hunter.io/v2/email-verifier");
      url.searchParams.set("email",email);
      const response=await fetch(url,{
        headers:{"X-API-KEY":env.HUNTER_API_KEY,accept:"application/json"},
        signal:AbortSignal.timeout(25000)
      });
      if(response.status===202) return {configured:true,provider:"hunter",status:"pending",riskScore:50};
      if(!response.ok) return {configured:true,provider:"hunter",status:"unknown",riskScore:60,error:"hunter_"+response.status};
      const payload=await response.json() as any;
      const data=payload?.data || {};
      const status=String(data.status || "unknown").toLowerCase();
      const score=typeof data.score==="number"?Math.max(0,Math.min(100,data.score)):50;
      const risk=["invalid","blocked"].includes(status)?95:
        status==="valid"?Math.max(0,100-score):
        status==="accept_all"?65:
        status==="webmail"?35:50;
      await recordDeliverability(env,{email,provider:"hunter",status,riskScore:risk,details:data});
      return {configured:true,provider:"hunter",status,riskScore:risk,score};
    }catch(error){
      return {configured:true,provider:"hunter",status:"unknown",riskScore:60,error:String(error)};
    }
  }
  if(!env.EMAIL_VERIFICATION_API_URL || !env.EMAIL_VERIFICATION_API_KEY){
    return {configured:false,status:"unknown",riskScore:50};
  }
  try{
    const url=new URL(env.EMAIL_VERIFICATION_API_URL);
    url.searchParams.set("email",email);
    const response=await fetch(url,{headers:{authorization:"Bearer "+env.EMAIL_VERIFICATION_API_KEY,accept:"application/json"},signal:AbortSignal.timeout(8000)});
    if(!response.ok) return {configured:true,status:"unknown",riskScore:60,error:"provider_"+response.status};
    const data=await response.json() as any;
    const status=String(data.status || data.result || "unknown").toLowerCase();
    const risk=typeof data.risk_score==="number"?data.risk_score:(["invalid","undeliverable"].includes(status)?95:["valid","deliverable"].includes(status)?10:50);
    await recordDeliverability(env,{email,provider:"configured_email_verifier",status,riskScore:risk,details:data});
    return {configured:true,status,riskScore:risk};
  }catch(error){
    return {configured:true,status:"unknown",riskScore:60,error:String(error)};
  }
}

export async function ingestCommunication(env:Env,input:{
  tenantId?:string;provider:string;externalId?:string|null;direction:"inbound"|"outbound";channel:string;
  accountId?:string|null;contactId?:string|null;opportunityId?:string|null;subject?:string|null;bodyText?:string|null;
  occurredAt?:string;metadata?:Record<string,unknown>;
}):Promise<{communicationId:string;classification:Record<string,unknown>}>{
  if(input.externalId){
    const existing=await env.DB.prepare("SELECT communication_id,classification_json FROM communication_events WHERE provider=? AND external_id=? LIMIT 1")
      .bind(input.provider,input.externalId).first<{communication_id:string;classification_json:string}>();
    if(existing) return {communicationId:existing.communication_id,classification:JSON.parse(existing.classification_json || "{}")};
  }
  const body=(input.bodyText || "").slice(0,20_000);
  const fallback={
    sentiment:"unknown",intent:"unknown",objections:[],commitments:[],questions:[],urgencySignals:[],competitorsMentioned:[],nextAction:null
  };
  const classification=body?await aiJson<Record<string,unknown>>(
    env,
    "You classify B2B commercial communications. Extract only what the text supports. Do not infer protected characteristics or private facts.",
    `DIRECTION: ${input.direction}\nSUBJECT: ${input.subject || ""}\nBODY:\n${body}\nReturn sentiment, intent, objections[], commitments[], questions[], urgencySignals[], competitorsMentioned[], nextAction.`,
    fallback,
    800
  ):fallback;
  const communicationId=id("comm");
  await env.DB.prepare(
    `INSERT INTO communication_events (
      communication_id,tenant_id,account_id,contact_id,opportunity_id,provider,external_id,direction,channel,
      subject,body_text,occurred_at,metadata_json,classification_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    communicationId,input.tenantId || "tenant_clientmotive",input.accountId || null,input.contactId || null,input.opportunityId || null,
    input.provider,input.externalId || null,input.direction,input.channel,input.subject || null,body,input.occurredAt || isoNow(),
    JSON.stringify(input.metadata || {}),JSON.stringify(classification),isoNow()
  ).run();
  if(input.opportunityId){
    await env.DB.prepare("UPDATE opportunities SET last_activity_at=?,updated_at=? WHERE opportunity_id=?")
      .bind(input.occurredAt || isoNow(),isoNow(),input.opportunityId).run();
  }
  return {communicationId,classification};
}

export async function addEnrichmentFact(env:Env,input:{
  tenantId?:string;entityType:string;entityId:string;fieldName:string;value:unknown;sourceName:string;sourceUrl?:string|null;
  confidence?:number;observedAt?:string;ttlDays?:number;
}):Promise<string>{
  const factId=id("fact");
  const observed=input.observedAt || isoNow();
  const expires=input.ttlDays?new Date(new Date(observed).getTime()+Math.max(1,input.ttlDays)*86_400_000).toISOString():null;
  await env.DB.prepare(
    `INSERT INTO enrichment_facts (
      fact_id,tenant_id,entity_type,entity_id,field_name,field_value_json,source_name,source_url,
      confidence,observed_at,expires_at,status,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?)`
  ).bind(factId,input.tenantId || "tenant_clientmotive",input.entityType,input.entityId,input.fieldName,JSON.stringify(input.value),input.sourceName,input.sourceUrl || null,Math.max(0,Math.min(100,input.confidence || 50)),observed,expires,isoNow()).run();
  await detectFactConflict(env,input.entityType,input.entityId,input.fieldName,input.tenantId);
  return factId;
}

export async function detectFactConflict(env:Env,entityType:string,entityId:string,fieldName:string,tenantId="tenant_clientmotive"):Promise<string|null>{
  const facts=await env.DB.prepare(
    `SELECT fact_id,field_value_json,confidence,source_name FROM enrichment_facts
     WHERE tenant_id=? AND entity_type=? AND entity_id=? AND field_name=? AND status='active'
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY confidence DESC,observed_at DESC LIMIT 10`
  ).bind(tenantId,entityType,entityId,fieldName,isoNow()).all<any>();
  const values=new Set(facts.results.map((row)=>row.field_value_json));
  if(values.size<=1) return null;
  const open=await env.DB.prepare(
    "SELECT conflict_id FROM fact_conflicts WHERE tenant_id=? AND entity_type=? AND entity_id=? AND field_name=? AND status='open' LIMIT 1"
  ).bind(tenantId,entityType,entityId,fieldName).first<{conflict_id:string}>();
  if(open) return open.conflict_id;
  const conflictId=id("conflict");
  await env.DB.prepare(
    `INSERT INTO fact_conflicts (
      conflict_id,tenant_id,entity_type,entity_id,field_name,fact_ids_json,status,created_at
    ) VALUES (?,?,?,?,?,?,'open',?)`
  ).bind(conflictId,tenantId,entityType,entityId,fieldName,JSON.stringify(facts.results.map((row)=>row.fact_id)),isoNow()).run();
  return conflictId;
}

export async function freshnessReport(env:Env,entityType:string,entityId:string):Promise<Record<string,unknown>>{
  const rows=await env.DB.prepare(
    `SELECT field_name,MAX(observed_at) AS observed_at,MIN(expires_at) AS expires_at,MAX(confidence) AS confidence
     FROM enrichment_facts WHERE entity_type=? AND entity_id=? AND status='active'
     GROUP BY field_name ORDER BY field_name`
  ).bind(entityType,entityId).all<any>();
  const now=Date.now();
  return {
    entityType,entityId,
    fields:rows.results.map((row)=>({
      field:row.field_name,observedAt:row.observed_at,expiresAt:row.expires_at,confidence:row.confidence,
      stale:row.expires_at?new Date(row.expires_at).getTime()<now:false
    }))
  };
}
