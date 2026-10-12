import type { Env } from "../types";
import { id, isoNow, normalizeDomain } from "../lib/ids";
import { aiJson } from "../services/ai";
import { upsertContact, verifyEmailIfConfigured, addEnrichmentFact } from "./crm";
import { enrichCompanyWaterfall } from "./intelligence";

export type CrmOperatingMode = "observe" | "assist" | "managed" | "autonomous";
export type CrmProvider = "hubspot" | "salesforce" | "pipedrive" | "dynamics" | "zoho" | "freshsales" | "bridge";

type Connection = {
  connection_id:string; tenant_id:string; provider:CrmProvider; label:string; operating_mode:CrmOperatingMode;
  status:string; external_org_id:string|null; base_url:string|null; credential_ciphertext:string|null; credential_iv:string|null;
  field_mapping_json:string; policy_json:string; last_pull_at:string|null; last_push_at:string|null;
};

type NormalAccount = { externalId:string; name:string; domain:string|null; industry?:string|null; employeeCount?:number|null; city?:string|null; country?:string|null; updatedAt?:string|null; raw:Record<string,unknown> };
type NormalContact = { externalId:string; accountExternalId?:string|null; fullName:string; email?:string|null; phone?:string|null; title?:string|null; department?:string|null; linkedinUrl?:string|null; updatedAt?:string|null; raw:Record<string,unknown> };

const clamp=(n:number)=>Math.max(0,Math.min(100,Math.round(n)));
const safeJson=(v:string|null|undefined,f:any)=>{try{return v?JSON.parse(v):f;}catch{return f;}};
const clean=(v:unknown,max=500)=>String(v||"").replace(/\s+/g," ").trim().slice(0,max);
const normName=(v:string)=>v.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const genericEmail=(v:string)=>/^(info|hello|contact|sales|admin|office|support|enquiries|enquiry|team|mail)@/i.test(v);

function policy(conn:Connection){
  const raw=safeJson(conn.policy_json,{});
  return {
    autoUpdateExisting: raw.autoUpdateExisting !== false,
    autoCreateMissingContacts: raw.autoCreateMissingContacts === true,
    allowPaidContactEnrichment: raw.allowPaidContactEnrichment === true,
    minWriteConfidence: clamp(Number(raw.minWriteConfidence ?? 85)),
    staleDays: Math.max(30,Math.min(730,Number(raw.staleDays ?? 180))),
    maxRecordsPerRun: Math.max(50,Math.min(10000,Number(raw.maxRecordsPerRun ?? 3000))),
    writeFields: Array.isArray(raw.writeFields)?raw.writeFields:["name","domain","industry","employeeCount","city","country","title","department","email","phone","linkedinUrl"],
    protectedFields: Array.isArray(raw.protectedFields)?raw.protectedFields:[],
    discoverMissingStakeholders: raw.discoverMissingStakeholders !== false,
    verifyWorkEmail: raw.verifyWorkEmail !== false
  };
}

async function cryptoKey(env:Env){
  if(!env.CRM_CREDENTIAL_ENCRYPTION_KEY) throw new Error("crm_encryption_key_not_configured");
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(env.CRM_CREDENTIAL_ENCRYPTION_KEY));
  return crypto.subtle.importKey("raw",digest,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
async function encryptCredentials(env:Env,value:Record<string,unknown>){
  const iv=crypto.getRandomValues(new Uint8Array(12)); const key=await cryptoKey(env);
  const out=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(JSON.stringify(value)));
  const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes));
  return {ciphertext:b64(new Uint8Array(out)),iv:b64(iv)};
}
async function decryptCredentials(env:Env,conn:Connection):Promise<Record<string,string>>{
  if(!conn.credential_ciphertext||!conn.credential_iv) return {};
  const from=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const key=await cryptoKey(env);
  const clear=await crypto.subtle.decrypt({name:"AES-GCM",iv:from(conn.credential_iv)},key,from(conn.credential_ciphertext));
  return JSON.parse(new TextDecoder().decode(clear));
}

export function crmProviderCapabilities(){
  return {
    hubspot:{nativePull:true,nativeWrite:true,entities:["companies","contacts"]},
    salesforce:{nativePull:true,nativeWrite:true,entities:["accounts","contacts"]},
    pipedrive:{nativePull:true,nativeWrite:true,entities:["organizations","persons"]},
    dynamics:{nativePull:true,nativeWrite:true,entities:["accounts","contacts"]},
    zoho:{nativePull:true,nativeWrite:true,entities:["Accounts","Contacts"]},
    freshsales:{nativePull:false,nativeWrite:false,bridgeSupported:true,entities:["accounts","contacts"]},
    bridge:{nativePull:false,nativeWrite:true,bridgeSupported:true,entities:["accounts","contacts"]}
  };
}

export async function createCrmConnection(env:Env,input:{
  tenantId?:string;provider:CrmProvider;label:string;operatingMode?:CrmOperatingMode;externalOrgId?:string|null;baseUrl?:string|null;
  credentials?:Record<string,unknown>;fieldMapping?:Record<string,unknown>;policy?:Record<string,unknown>
}){
  const allowedProviders=new Set(["hubspot","salesforce","pipedrive","dynamics","zoho","freshsales","bridge"]);
  const modes=new Set(["observe","assist","managed","autonomous"]);
  if(!allowedProviders.has(input.provider)) throw new Error("unsupported_crm_provider");
  const mode=(input.operatingMode||"observe") as CrmOperatingMode;
  if(!modes.has(mode)) throw new Error("invalid_operating_mode");
  const connectionId=id("crmconn"),now=isoNow();
  let encrypted:{ciphertext:string;iv:string}|null=null;
  if(input.credentials&&Object.keys(input.credentials).length) encrypted=await encryptCredentials(env,input.credentials);
  await env.DB.prepare(
    `INSERT INTO crm_connections
     (connection_id,tenant_id,provider,label,operating_mode,status,external_org_id,base_url,credential_ciphertext,credential_iv,field_mapping_json,policy_json,created_at,updated_at)
     VALUES (?,?,?,?,?,'active',?,?,?,?,?,?,?,?)`
  ).bind(connectionId,input.tenantId||"tenant_clientmotive",input.provider,clean(input.label,160),mode,input.externalOrgId||null,input.baseUrl||null,
    encrypted?.ciphertext||null,encrypted?.iv||null,JSON.stringify(input.fieldMapping||{}),JSON.stringify(input.policy||{}),now,now).run();
  return {connectionId,provider:input.provider,operatingMode:mode,status:"active"};
}

export async function updateCrmConnection(env:Env,connectionId:string,input:{
  operatingMode?:CrmOperatingMode;status?:string;baseUrl?:string|null;credentials?:Record<string,unknown>;fieldMapping?:Record<string,unknown>;policy?:Record<string,unknown>
}){
  const conn=await getConnection(env,connectionId);
  let cipher=conn.credential_ciphertext,iv=conn.credential_iv;
  if(input.credentials){const encrypted=await encryptCredentials(env,input.credentials);cipher=encrypted.ciphertext;iv=encrypted.iv;}
  await env.DB.prepare(
    `UPDATE crm_connections SET operating_mode=?,status=?,base_url=?,credential_ciphertext=?,credential_iv=?,
     field_mapping_json=?,policy_json=?,updated_at=? WHERE connection_id=?`
  ).bind(input.operatingMode||conn.operating_mode,input.status||conn.status,input.baseUrl===undefined?conn.base_url:input.baseUrl,cipher,iv,
    input.fieldMapping?JSON.stringify(input.fieldMapping):conn.field_mapping_json,input.policy?JSON.stringify(input.policy):conn.policy_json,isoNow(),connectionId).run();
  return {connectionId,operatingMode:input.operatingMode||conn.operating_mode,status:input.status||conn.status};
}

async function getConnection(env:Env,connectionId:string):Promise<Connection>{
  const row=await env.DB.prepare("SELECT * FROM crm_connections WHERE connection_id=?").bind(connectionId).first<Connection>();
  if(!row) throw new Error("crm_connection_not_found");
  return row;
}

export async function crmConnections(env:Env,tenantId="tenant_clientmotive"){
  const rows=await env.DB.prepare(
    "SELECT connection_id,tenant_id,provider,label,operating_mode,status,external_org_id,base_url,field_mapping_json,policy_json,last_pull_at,last_push_at,created_at,updated_at FROM crm_connections WHERE tenant_id=? ORDER BY created_at DESC"
  ).bind(tenantId).all<any>();
  return rows.results.map(r=>({...r,fieldMapping:safeJson(r.field_mapping_json,{}),policy:safeJson(r.policy_json,{})}));
}

async function providerFetch(env:Env,conn:Connection,resource:"accounts"|"contacts",maxRecords:number):Promise<{records:any[];cursor:string|null}>{
  const cred=await decryptCredentials(env,conn);
  if(conn.provider==="hubspot"){
    const object=resource==="accounts"?"companies":"contacts";
    const props=resource==="accounts"?"name,domain,industry,numberofemployees,city,country,hs_lastmodifieddate":"firstname,lastname,email,phone,jobtitle,hs_lastmodifieddate,associatedcompanyid";
    const records:any[]=[]; let after:string|undefined;
    while(records.length<maxRecords){
      const url=new URL("https://api.hubapi.com/crm/v3/objects/"+object);
      url.searchParams.set("limit","100");url.searchParams.set("properties",props);if(after)url.searchParams.set("after",after);
      const token=cred.accessToken||env.HUBSPOT_ACCESS_TOKEN; if(!token) throw new Error("hubspot_credentials_missing");
      const response=await fetch(url,{headers:{authorization:"Bearer "+token,accept:"application/json"},signal:AbortSignal.timeout(20000)});
      if(!response.ok) throw new Error("hubspot_pull_"+response.status);
      const body=await response.json() as any;records.push(...(body.results||[]));
      after=body?.paging?.next?.after;if(!after)break;
    }
    return {records:records.slice(0,maxRecords),cursor:after||null};
  }
  if(conn.provider==="salesforce"){
    const base=conn.base_url||cred.instanceUrl;if(!base||!cred.accessToken)throw new Error("salesforce_credentials_missing");
    const soql=resource==="accounts"?
      "SELECT Id,Name,Website,Industry,NumberOfEmployees,BillingCity,BillingCountry,LastModifiedDate FROM Account ORDER BY LastModifiedDate DESC":
      "SELECT Id,AccountId,Name,Email,Phone,Title,Department,LastModifiedDate FROM Contact ORDER BY LastModifiedDate DESC";
    let url=base.replace(/\/$/,"")+"/services/data/v61.0/query?q="+encodeURIComponent(soql),records:any[]=[];
    while(url&&records.length<maxRecords){
      const response=await fetch(url,{headers:{authorization:"Bearer "+cred.accessToken,accept:"application/json"},signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error("salesforce_pull_"+response.status);
      const body=await response.json() as any;records.push(...(body.records||[]));url=body.nextRecordsUrl?base.replace(/\/$/,"")+body.nextRecordsUrl:"";
    }
    return {records:records.slice(0,maxRecords),cursor:url||null};
  }
  if(conn.provider==="pipedrive"){
    const base=(conn.base_url||"https://api.pipedrive.com").replace(/\/$/,"");const token=cred.apiToken;if(!token)throw new Error("pipedrive_credentials_missing");
    const endpoint=resource==="accounts"?"/v1/organizations":"/v1/persons";let start=0,records:any[]=[];
    while(records.length<maxRecords){
      const url=new URL(base+endpoint);url.searchParams.set("api_token",token);url.searchParams.set("start",String(start));url.searchParams.set("limit","500");
      const response=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error("pipedrive_pull_"+response.status);
      const body=await response.json() as any;records.push(...(body.data||[]));const more=body?.additional_data?.pagination?.more_items_in_collection;if(!more)break;start=Number(body.additional_data.pagination.next_start||start+500);
    }
    return {records:records.slice(0,maxRecords),cursor:String(start)};
  }
  if(conn.provider==="dynamics"){
    const base=(conn.base_url||cred.baseUrl||"").replace(/\/$/,"");if(!base||!cred.accessToken)throw new Error("dynamics_credentials_missing");
    let url=base+"/api/data/v9.2/"+(resource==="accounts"?"accounts?$select=accountid,name,websiteurl,industrycode,numberofemployees,address1_city,address1_country,modifiedon":"contacts?$select=contactid,_parentcustomerid_value,fullname,emailaddress1,telephone1,jobtitle,modifiedon");
    const records:any[]=[];
    while(url&&records.length<maxRecords){
      const response=await fetch(url,{headers:{authorization:"Bearer "+cred.accessToken,accept:"application/json"},signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error("dynamics_pull_"+response.status);
      const body=await response.json() as any;records.push(...(body.value||[]));url=body["@odata.nextLink"]||"";
    }
    return {records:records.slice(0,maxRecords),cursor:url||null};
  }
  if(conn.provider==="zoho"){
    const base=(conn.base_url||cred.apiDomain||"https://www.zohoapis.eu").replace(/\/$/,"");if(!cred.accessToken)throw new Error("zoho_credentials_missing");
    const module=resource==="accounts"?"Accounts":"Contacts";let page=1,records:any[]=[];
    while(records.length<maxRecords){
      const url=new URL(base+"/crm/v6/"+module);url.searchParams.set("page",String(page));url.searchParams.set("per_page","200");
      const response=await fetch(url,{headers:{authorization:"Zoho-oauthtoken "+cred.accessToken,accept:"application/json"},signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error("zoho_pull_"+response.status);
      const body=await response.json() as any;records.push(...(body.data||[]));if(!body?.info?.more_records)break;page++;
    }
    return {records:records.slice(0,maxRecords),cursor:String(page)};
  }
  throw new Error("provider_requires_bridge_import");
}

function normalizeAccounts(provider:CrmProvider,records:any[]):NormalAccount[]{
  return records.map((r:any)=>{
    if(provider==="hubspot"){const p=r.properties||{};return {externalId:String(r.id),name:clean(p.name,200),domain:normalizeDomain(p.domain)||null,industry:p.industry||null,employeeCount:Number(p.numberofemployees)||null,city:p.city||null,country:p.country||null,updatedAt:p.hs_lastmodifieddate||r.updatedAt||null,raw:r};}
    if(provider==="salesforce")return {externalId:String(r.Id),name:clean(r.Name,200),domain:normalizeDomain(r.Website)||null,industry:r.Industry||null,employeeCount:Number(r.NumberOfEmployees)||null,city:r.BillingCity||null,country:r.BillingCountry||null,updatedAt:r.LastModifiedDate||null,raw:r};
    if(provider==="pipedrive"){const website=Array.isArray(r.website)?r.website[0]?.value:r.website;return {externalId:String(r.id),name:clean(r.name,200),domain:normalizeDomain(website)||null,industry:null,employeeCount:null,city:null,country:null,updatedAt:r.update_time||null,raw:r};}
    if(provider==="dynamics")return {externalId:String(r.accountid),name:clean(r.name,200),domain:normalizeDomain(r.websiteurl)||null,industry:r.industrycode?String(r.industrycode):null,employeeCount:Number(r.numberofemployees)||null,city:r.address1_city||null,country:r.address1_country||null,updatedAt:r.modifiedon||null,raw:r};
    if(provider==="zoho")return {externalId:String(r.id),name:clean(r.Account_Name,200),domain:normalizeDomain(r.Website)||null,industry:r.Industry||null,employeeCount:Number(r.Employees)||null,city:r.Billing_City||null,country:r.Billing_Country||null,updatedAt:r.Modified_Time||null,raw:r};
    return {externalId:String(r.id||r.externalId),name:clean(r.name,200),domain:normalizeDomain(r.domain||r.website)||null,industry:r.industry||null,employeeCount:Number(r.employeeCount)||null,city:r.city||null,country:r.country||null,updatedAt:r.updatedAt||null,raw:r};
  }).filter(x=>x.externalId&&x.name);
}
function normalizeContacts(provider:CrmProvider,records:any[]):NormalContact[]{
  return records.map((r:any)=>{
    if(provider==="hubspot"){const p=r.properties||{};return {externalId:String(r.id),accountExternalId:p.associatedcompanyid||null,fullName:clean([p.firstname,p.lastname].filter(Boolean).join(" "),180),email:clean(p.email,180).toLowerCase()||null,phone:clean(p.phone,80)||null,title:clean(p.jobtitle,180)||null,updatedAt:p.hs_lastmodifieddate||r.updatedAt||null,raw:r};}
    if(provider==="salesforce")return {externalId:String(r.Id),accountExternalId:r.AccountId||null,fullName:clean(r.Name,180),email:clean(r.Email,180).toLowerCase()||null,phone:clean(r.Phone,80)||null,title:clean(r.Title,180)||null,department:clean(r.Department,160)||null,updatedAt:r.LastModifiedDate||null,raw:r};
    if(provider==="pipedrive")return {externalId:String(r.id),accountExternalId:r.org_id?.value?String(r.org_id.value):r.org_id?String(r.org_id):null,fullName:clean(r.name,180),email:clean(Array.isArray(r.email)?r.email[0]?.value:r.email,180).toLowerCase()||null,phone:clean(Array.isArray(r.phone)?r.phone[0]?.value:r.phone,80)||null,title:clean(r.job_title||r.title,180)||null,updatedAt:r.update_time||null,raw:r};
    if(provider==="dynamics")return {externalId:String(r.contactid),accountExternalId:r._parentcustomerid_value||null,fullName:clean(r.fullname,180),email:clean(r.emailaddress1,180).toLowerCase()||null,phone:clean(r.telephone1,80)||null,title:clean(r.jobtitle,180)||null,updatedAt:r.modifiedon||null,raw:r};
    if(provider==="zoho")return {externalId:String(r.id),accountExternalId:r.Account_Name?.id||null,fullName:clean(r.Full_Name||[r.First_Name,r.Last_Name].filter(Boolean).join(" "),180),email:clean(r.Email,180).toLowerCase()||null,phone:clean(r.Phone,80)||null,title:clean(r.Title,180)||null,department:clean(r.Department,160)||null,updatedAt:r.Modified_Time||null,raw:r};
    return {externalId:String(r.id||r.externalId),accountExternalId:r.accountExternalId||null,fullName:clean(r.fullName||r.name,180),email:clean(r.email,180).toLowerCase()||null,phone:clean(r.phone,80)||null,title:clean(r.title,180)||null,department:clean(r.department,160)||null,linkedinUrl:clean(r.linkedinUrl,500)||null,updatedAt:r.updatedAt||null,raw:r};
  }).filter(x=>x.externalId&&x.fullName);
}

async function linkRecord(env:Env,conn:Connection,entityType:string,localId:string,externalId:string,externalUpdatedAt?:string|null,metadata:Record<string,unknown>={}){
  const now=isoNow();
  await env.DB.prepare(
    `INSERT INTO crm_record_links (link_id,connection_id,entity_type,local_id,external_id,external_updated_at,last_seen_at,metadata_json)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(connection_id,entity_type,external_id) DO UPDATE SET local_id=excluded.local_id,external_updated_at=excluded.external_updated_at,last_seen_at=excluded.last_seen_at,metadata_json=excluded.metadata_json`
  ).bind(id("crmlink"),conn.connection_id,entityType,localId,externalId,externalUpdatedAt||null,now,JSON.stringify(metadata)).run();
}

async function importAccounts(env:Env,conn:Connection,records:NormalAccount[]){
  let created=0,linked=0;
  for(const record of records){
    let local:any=null;
    if(record.domain)local=await env.DB.prepare("SELECT * FROM commercial_accounts WHERE tenant_id=? AND lower(domain)=lower(?) LIMIT 1").bind(conn.tenant_id,record.domain).first<any>();
    if(!local)local=await env.DB.prepare("SELECT * FROM commercial_accounts WHERE tenant_id=? AND lower(name)=lower(?) LIMIT 1").bind(conn.tenant_id,record.name).first<any>();
    let accountId=local?.account_id;
    if(!accountId){
      accountId=id("account");const now=isoNow();
      await env.DB.prepare(
        `INSERT INTO commercial_accounts (account_id,name,domain,segment,lifecycle_stage,tier,status,source,metadata_json,created_at,updated_at)
         VALUES (?,?,?,?,'prospect',3,'active',?,?,?,?)`
      ).bind(accountId,record.name,record.domain,record.industry||null,"crm:"+conn.provider,JSON.stringify({crmImport:true,city:record.city,country:record.country,employeeCount:record.employeeCount}),now,now).run();created++;
    }else linked++;
    await linkRecord(env,conn,"account",accountId,record.externalId,record.updatedAt,{provider:conn.provider});
  }
  return {created,linked};
}
async function importContacts(env:Env,conn:Connection,records:NormalContact[]){
  let created=0,linked=0;
  for(const record of records){
    let accountId:string|null=null;
    if(record.accountExternalId){
      const link=await env.DB.prepare("SELECT local_id FROM crm_record_links WHERE connection_id=? AND entity_type='account' AND external_id=?").bind(conn.connection_id,record.accountExternalId).first<{local_id:string}>();
      accountId=link?.local_id||null;
    }
    let existing:any=null;
    if(record.email)existing=await env.DB.prepare("SELECT contact_id FROM contacts WHERE tenant_id=? AND lower(email)=lower(?) LIMIT 1").bind(conn.tenant_id,record.email).first<any>();
    let contactId=existing?.contact_id;
    if(!contactId){
      contactId=await upsertContact(env,{tenantId:conn.tenant_id,accountId,fullName:record.fullName,email:record.email||null,phone:record.phone||null,title:record.title||null,department:record.department||null,linkedinUrl:record.linkedinUrl||null,source:"crm:"+conn.provider,confidence:95,metadata:{crmImport:true}});created++;
    }else linked++;
    await linkRecord(env,conn,"contact",contactId,record.externalId,record.updatedAt,{provider:conn.provider});
  }
  return {created,linked};
}

export async function importCrmSnapshot(env:Env,connectionId:string,input:{accounts?:any[];contacts?:any[]}){
  const conn=await getConnection(env,connectionId);
  const accounts=normalizeAccounts(conn.provider,input.accounts||[]),contacts=normalizeContacts(conn.provider,input.contacts||[]);
  const a=await importAccounts(env,conn,accounts),c=await importContacts(env,conn,contacts);
  await env.DB.prepare("UPDATE crm_connections SET last_pull_at=?,updated_at=? WHERE connection_id=?").bind(isoNow(),isoNow(),connectionId).run();
  return {connectionId,accounts:{received:accounts.length,...a},contacts:{received:contacts.length,...c}};
}

export async function pullCrmConnection(env:Env,connectionId:string){
  const conn=await getConnection(env,connectionId);if(conn.status!=="active")throw new Error("crm_connection_inactive");
  const p=policy(conn);
  const [accounts,contacts]=await Promise.all([providerFetch(env,conn,"accounts",p.maxRecordsPerRun),providerFetch(env,conn,"contacts",p.maxRecordsPerRun)]);
  const imported=await importCrmSnapshot(env,connectionId,{accounts:accounts.records,contacts:contacts.records});
  return {...imported,cursors:{accounts:accounts.cursor,contacts:contacts.cursor}};
}

async function propose(env:Env,conn:Connection,input:{
  accountId?:string|null;contactId?:string|null;entityType:"account"|"contact";actionType:string;externalId?:string|null;
  before?:Record<string,unknown>;after:Record<string,unknown>;evidence?:string[];confidence:number;reason:string;riskLevel?:"low"|"medium"|"high";requiresApproval?:boolean
}){
  const duplicate=await env.DB.prepare(
    `SELECT proposal_id FROM crm_change_proposals WHERE connection_id=? AND entity_type=? AND action_type=? AND COALESCE(contact_id,'')=COALESCE(?,'') AND COALESCE(account_id,'')=COALESCE(?,'') AND status IN ('proposed','approved') LIMIT 1`
  ).bind(conn.connection_id,input.entityType,input.actionType,input.contactId||null,input.accountId||null).first<any>();
  if(duplicate)return duplicate.proposal_id;
  const proposalId=id("crmprop"),now=isoNow();
  await env.DB.prepare(
    `INSERT INTO crm_change_proposals
     (proposal_id,connection_id,account_id,contact_id,entity_type,action_type,external_id,before_json,after_json,evidence_json,confidence,reason,risk_level,status,requires_approval,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'proposed',?,?,?)`
  ).bind(proposalId,conn.connection_id,input.accountId||null,input.contactId||null,input.entityType,input.actionType,input.externalId||null,
    JSON.stringify(input.before||{}),JSON.stringify(input.after),JSON.stringify(input.evidence||[]),clamp(input.confidence),input.reason,input.riskLevel||"low",input.requiresApproval===false?0:1,now,now).run();
  return proposalId;
}

function expectedRoles(rows:any[]){
  if(rows.length)return rows.map(r=>({roleType:r.role_type||"influencer",label:r.role,titleVariants:safeJson(r.title_variants_json,[])}));
  return [
    {roleType:"economic_buyer",label:"Economic buyer",titleVariants:["CFO","Chief Financial Officer","Finance Director","Managing Director","CEO"]},
    {roleType:"champion",label:"Operational champion",titleVariants:["Head","Director","Manager"]},
    {roleType:"influencer",label:"Technical / functional evaluator",titleVariants:["CTO","CIO","Head of IT","Head of Technology","Director"]},
    {roleType:"blocker",label:"Procurement / risk gatekeeper",titleVariants:["Procurement","Legal","Security","Risk","Compliance"]}
  ];
}
function titleMatches(title:string,variants:string[]){const t=title.toLowerCase();return variants.some(v=>t.includes(String(v).toLowerCase()));}

export async function detectStakeholderGaps(env:Env,connectionId:string,accountId?:string|null){
  const conn=await getConnection(env,connectionId);
  const accounts=accountId?[await env.DB.prepare("SELECT * FROM commercial_accounts WHERE account_id=?").bind(accountId).first<any>()]:
    (await env.DB.prepare("SELECT * FROM commercial_accounts WHERE tenant_id=? AND status='active' ORDER BY updated_at DESC LIMIT 500").bind(conn.tenant_id).all<any>()).results;
  let gaps=0;
  for(const account of accounts.filter(Boolean)){
    const [contacts,buyers]=await Promise.all([
      env.DB.prepare("SELECT * FROM contacts WHERE account_id=?").bind(account.account_id).all<any>(),
      account.lead_id?env.DB.prepare("SELECT * FROM buyer_roles WHERE lead_id=?").bind(account.lead_id).all<any>():Promise.resolve({results:[]} as any)
    ]);
    for(const role of expectedRoles(buyers.results)){
      const covered=contacts.results.some((c:any)=>titleMatches(String(c.title||""),role.titleVariants));
      if(covered)continue;
      await env.DB.prepare(
        `INSERT INTO crm_stakeholder_gaps (gap_id,connection_id,account_id,role_type,role_label,rationale,status,confidence,evidence_json,created_at,updated_at)
         VALUES (?,?,?,?,?,?,'open',?,?,?,?)
         ON CONFLICT(connection_id,account_id,role_type) DO UPDATE SET rationale=excluded.rationale,confidence=excluded.confidence,updated_at=excluded.updated_at,status=CASE WHEN crm_stakeholder_gaps.status='resolved' THEN 'resolved' ELSE 'open' END`
      ).bind(id("crmgap"),connectionId,account.account_id,role.roleType,role.label,
        "No current CRM contact title matches the expected "+role.label+" role for this buying committee.",buyers.results.length?80:55,JSON.stringify([]),isoNow(),isoNow()).run();gaps++;
    }
  }
  return {connectionId,accountsChecked:accounts.filter(Boolean).length,gaps};
}

async function discoverApolloPeople(env:Env,domain:string,roleLabel:string,limit=5){
  if(!env.APOLLO_API_KEY)return {configured:false,people:[] as any[]};
  const url=new URL("https://api.apollo.io/api/v1/mixed_people/api_search");url.searchParams.append("q_organization_domains_list[]",domain);
  url.searchParams.set("page","1");url.searchParams.set("per_page",String(Math.max(1,Math.min(10,limit))));
  const terms=roleLabel.toLowerCase();
  if(terms.includes("economic"))["owner","founder","c_suite","partner","vp"].forEach(x=>url.searchParams.append("person_seniorities[]",x));
  else ["c_suite","vp","head","director","manager"].forEach(x=>url.searchParams.append("person_seniorities[]",x));
  const response=await fetch(url,{method:"POST",headers:{accept:"application/json","content-type":"application/json","x-api-key":env.APOLLO_API_KEY},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error("apollo_people_search_"+response.status);
  const body=await response.json() as any;return {configured:true,people:(body.people||body.contacts||[]).slice(0,limit)};
}

async function enrichApolloPerson(env:Env,domain:string,apolloId:string){
  if(!env.APOLLO_API_KEY)return null;
  const url=new URL("https://api.apollo.io/api/v1/people/match");url.searchParams.set("id",apolloId);url.searchParams.set("domain",domain);
  url.searchParams.set("reveal_personal_emails","false");url.searchParams.set("reveal_phone_number","false");url.searchParams.set("run_waterfall_email","false");url.searchParams.set("run_waterfall_phone","false");
  const response=await fetch(url,{method:"POST",headers:{accept:"application/json","content-type":"application/json","x-api-key":env.APOLLO_API_KEY},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error("apollo_person_match_"+response.status);const body=await response.json() as any;return body.person||body.contact||null;
}

export async function researchStakeholderGaps(env:Env,connectionId:string,limit=25){
  const conn=await getConnection(env,connectionId),p=policy(conn);
  const gaps=await env.DB.prepare(
    `SELECT g.*,a.name AS account_name,a.domain FROM crm_stakeholder_gaps g JOIN commercial_accounts a ON a.account_id=g.account_id
     WHERE g.connection_id=? AND g.status='open' AND a.domain IS NOT NULL ORDER BY g.confidence DESC,g.created_at LIMIT ?`
  ).bind(connectionId,Math.max(1,Math.min(100,limit))).all<any>();
  let candidates=0,proposals=0;
  for(const gap of gaps.results){
    const domain=normalizeDomain(gap.domain);if(!domain)continue;
    const found=await discoverApolloPeople(env,domain,gap.role_label,5);
    const existing=await env.DB.prepare("SELECT lower(full_name) AS n,email,title FROM contacts WHERE account_id=?").bind(gap.account_id).all<any>();
    const seen=new Set(existing.results.map((c:any)=>normName(c.n||"")));
    const person=(found.people||[]).find((x:any)=>!seen.has(normName(String(x.name||[x.first_name,x.last_name].filter(Boolean).join(" ")))) && titleMatches(String(x.title||""),expectedRoles([]).find(r=>r.roleType===gap.role_type)?.titleVariants||[gap.role_label]));
    if(!person)continue;candidates++;
    let candidate:any={apolloPersonId:String(person.id||person.person_id||""),fullName:clean(person.name||[person.first_name,person.last_name].filter(Boolean).join(" "),180),title:clean(person.title,180),linkedinUrl:clean(person.linkedin_url,500)||null,status:"research_only"};
    if(p.allowPaidContactEnrichment&&candidate.apolloPersonId){
      const enriched=await enrichApolloPerson(env,domain,candidate.apolloPersonId);
      if(enriched){
        const email=clean(enriched.email,180).toLowerCase();const emailDomain=normalizeDomain(email.split("@")[1]||"");
        const corporate=Boolean(email&&emailDomain&&(emailDomain===domain||emailDomain.endsWith("."+domain)));
        let verification:any=null,safe=false;
        if(corporate&&p.verifyWorkEmail){verification=await verifyEmailIfConfigured(env,email);const s=String(verification.status||"").toLowerCase();safe=(verification.safeToSend===true||(["valid","deliverable"].includes(s)&&Number(verification.riskScore??50)<35));}
        candidate={...candidate,fullName:clean(enriched.name||candidate.fullName,180),title:clean(enriched.title||candidate.title,180),linkedinUrl:clean(enriched.linkedin_url||candidate.linkedinUrl,500)||null,email:corporate?email:null,corporateEmail:corporate,emailVerification:verification,verified:safe};
      }
    }
    await env.DB.prepare("UPDATE crm_stakeholder_gaps SET candidate_json=?,updated_at=? WHERE gap_id=?").bind(JSON.stringify(candidate),isoNow(),gap.gap_id).run();
    const confidence=candidate.verified?95:70;
    const requiresApproval=!(["managed","autonomous"].includes(conn.operating_mode)&&candidate.verified&&p.autoCreateMissingContacts&&confidence>=p.minWriteConfidence);
    await propose(env,conn,{accountId:gap.account_id,entityType:"contact",actionType:"create_missing_stakeholder",after:{...candidate,roleType:gap.role_type,roleLabel:gap.role_label},evidence:candidate.linkedinUrl?[candidate.linkedinUrl]:[],confidence,reason:"Missing "+gap.role_label+" identified in the CRM buying committee.",riskLevel:candidate.verified?"low":"medium",requiresApproval});proposals++;
  }
  return {connectionId,gapsChecked:gaps.results.length,candidates,proposals};
}

export async function auditCrmConnection(env:Env,connectionId:string){
  const conn=await getConnection(env,connectionId),p=policy(conn);
  const [accountLinks,contactLinks]=await Promise.all([
    env.DB.prepare(`SELECT l.*,a.* FROM crm_record_links l JOIN commercial_accounts a ON a.account_id=l.local_id WHERE l.connection_id=? AND l.entity_type='account'`).bind(connectionId).all<any>(),
    env.DB.prepare(`SELECT l.*,c.* FROM crm_record_links l JOIN contacts c ON c.contact_id=l.local_id WHERE l.connection_id=? AND l.entity_type='contact'`).bind(connectionId).all<any>()
  ]);
  const issues:any[]=[],duplicates:any[]=[];const now=Date.now();
  const domainMap=new Map<string,any[]>(),emailMap=new Map<string,any[]>();
  for(const a of accountLinks.results){
    if(!a.domain)issues.push({type:"missing_domain",entity:"account",id:a.account_id,name:a.name,severity:"medium"});
    else{const d=String(a.domain).toLowerCase();domainMap.set(d,[...(domainMap.get(d)||[]),a]);}
    const stamp=a.external_updated_at||a.updated_at;if(stamp&&now-new Date(stamp).getTime()>p.staleDays*86400000)issues.push({type:"stale_account",entity:"account",id:a.account_id,name:a.name,severity:"low"});
  }
  for(const c of contactLinks.results){
    if(!c.email)issues.push({type:"missing_email",entity:"contact",id:c.contact_id,name:c.full_name,severity:"medium"});
    else{const e=String(c.email).toLowerCase();emailMap.set(e,[...(emailMap.get(e)||[]),c]);if(genericEmail(e))issues.push({type:"generic_email",entity:"contact",id:c.contact_id,name:c.full_name,severity:"low"});}
    if(!c.title)issues.push({type:"missing_title",entity:"contact",id:c.contact_id,name:c.full_name,severity:"medium"});
    const stamp=c.external_updated_at||c.updated_at;if(stamp&&now-new Date(stamp).getTime()>p.staleDays*86400000)issues.push({type:"stale_contact",entity:"contact",id:c.contact_id,name:c.full_name,severity:"low"});
  }
  for(const [domain,rows] of domainMap)if(rows.length>1)duplicates.push({entity:"account",key:domain,records:rows.map(x=>({id:x.account_id,externalId:x.external_id,name:x.name}))});
  for(const [email,rows] of emailMap)if(rows.length>1)duplicates.push({entity:"contact",key:email,records:rows.map(x=>({id:x.contact_id,externalId:x.external_id,name:x.full_name}))});
  const gapResult=await detectStakeholderGaps(env,connectionId);
  const openGaps=await env.DB.prepare("SELECT COUNT(*) AS count FROM crm_stakeholder_gaps WHERE connection_id=? AND status='open'").bind(connectionId).first<any>();
  const report={
    connection:{connectionId,provider:conn.provider,mode:conn.operating_mode},
    totals:{accounts:accountLinks.results.length,contacts:contactLinks.results.length},
    health:{
      accountsWithDomain:accountLinks.results.filter((x:any)=>x.domain).length,
      contactsWithEmail:contactLinks.results.filter((x:any)=>x.email).length,
      contactsWithTitle:contactLinks.results.filter((x:any)=>x.title).length
    },
    issues,duplicates,stakeholderGaps:Number(openGaps?.count||0),
    rule:"Duplicates are never automatically merged. Missing contacts are never created externally without mode/policy approval and a verified professional identity."
  };
  const auditId=id("crmaudit");
  await env.DB.prepare(
    "INSERT INTO crm_audit_runs (audit_id,connection_id,audit_json,issue_count,duplicate_count,stale_count,missing_stakeholder_count,created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(auditId,connectionId,JSON.stringify(report),issues.length,duplicates.length,issues.filter(x=>x.type.startsWith("stale_")).length,Number(openGaps?.count||0),isoNow()).run();
  return {auditId,...report,gapDetection:gapResult};
}

export async function enrichCrmAccounts(env:Env,connectionId:string,limit=50){
  const conn=await getConnection(env,connectionId),p=policy(conn),runId=id("crmenrich"),started=isoNow();
  await env.DB.prepare("INSERT INTO crm_enrichment_runs (run_id,connection_id,run_type,status,started_at) VALUES (?,?,'account_enrichment','running',?)").bind(runId,connectionId,started).run();
  const rows=await env.DB.prepare(
    `SELECT a.*,l.external_id FROM commercial_accounts a JOIN crm_record_links l ON l.local_id=a.account_id AND l.entity_type='account'
     WHERE l.connection_id=? ORDER BY a.updated_at ASC LIMIT ?`
  ).bind(connectionId,Math.max(1,Math.min(500,limit))).all<any>();
  let researched=0,proposals=0;
  for(const account of rows.results){
    if(!account.domain)continue;
    try{await enrichCompanyWaterfall(env,{accountId:account.account_id,domain:account.domain});researched++;}catch{}
    const facts=await env.DB.prepare(
      `SELECT field_name,field_value_json,source_name,source_url,confidence,observed_at FROM enrichment_facts
       WHERE entity_type='account' AND entity_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY confidence DESC,observed_at DESC`
    ).bind(account.account_id,isoNow()).all<any>();
    const best=new Map<string,any>();for(const fact of facts.results)if(!best.has(fact.field_name))best.set(fact.field_name,fact);
    const after:any={};
    for(const [field,fact] of best){if(!p.writeFields.includes(field)||p.protectedFields.includes(field))continue;const value=safeJson(fact.field_value_json,null);if(value!==null&&value!==undefined&&value!=="")after[field]=value;}
    if(Object.keys(after).length){
      const confidence=Math.min(...[...best.values()].filter((f:any)=>Object.prototype.hasOwnProperty.call(after,f.field_name)).map((f:any)=>Number(f.confidence||50)));
      const canAuto=["assist","managed","autonomous"].includes(conn.operating_mode)&&p.autoUpdateExisting&&confidence>=p.minWriteConfidence;
      await propose(env,conn,{accountId:account.account_id,entityType:"account",actionType:"update_enrichment",externalId:account.external_id,before:{name:account.name,domain:account.domain,segment:account.segment},after,evidence:[...best.values()].map((f:any)=>f.source_url).filter(Boolean),confidence,reason:"Higher-confidence enrichment is available for the CRM account.",requiresApproval:!canAuto});proposals++;
    }
  }
  await env.DB.prepare("UPDATE crm_enrichment_runs SET status='complete',summary_json=?,completed_at=? WHERE run_id=?").bind(JSON.stringify({researched,proposals}),isoNow(),runId).run();
  if(["managed","autonomous"].includes(conn.operating_mode)||conn.operating_mode==="assist")await executeEligibleProposals(env,connectionId,100,"policy");
  return {runId,accountsConsidered:rows.results.length,researched,proposals};
}

function providerFields(conn:Connection,entity:"account"|"contact",data:any){
  const mapping=safeJson(conn.field_mapping_json,{});
  const custom=mapping?.[entity]||{};
  const out:any={};
  for(const [k,v] of Object.entries(data)){out[custom[k]||k]=v;}
  return out;
}

async function providerWrite(env:Env,conn:Connection,proposal:any){
  const cred=await decryptCredentials(env,conn),after=safeJson(proposal.after_json,{});
  if(conn.provider==="hubspot"){
    const token=cred.accessToken||env.HUBSPOT_ACCESS_TOKEN;if(!token)throw new Error("hubspot_credentials_missing");
    const object=proposal.entity_type==="account"?"companies":"contacts";
    const props:any={};const mapped=providerFields(conn,proposal.entity_type,after);
    const defaults:any=proposal.entity_type==="account"?{name:"name",domain:"domain",industry:"industry",employeeCount:"numberofemployees",city:"city",country:"country"}:
      {email:"email",phone:"phone",title:"jobtitle",department:"department",linkedinUrl:"hs_linkedin_url"};
    for(const [key,val] of Object.entries(mapped)){const target=(safeJson(conn.field_mapping_json,{})?.[proposal.entity_type]?.[key])||defaults[key]||key;props[target]=val;}
    const isCreate=proposal.action_type==="create_missing_stakeholder"||!proposal.external_id;
    const url="https://api.hubapi.com/crm/v3/objects/"+object+(isCreate?"":"/"+encodeURIComponent(proposal.external_id));
    const response=await fetch(url,{method:isCreate?"POST":"PATCH",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({properties:props}),signal:AbortSignal.timeout(20000)});
    const body=await response.json().catch(()=>({})) as any;if(!response.ok)throw new Error("hubspot_write_"+response.status);
    return {externalId:String(body.id||proposal.external_id||""),providerResponse:{id:body.id||null}};
  }
  if(conn.provider==="salesforce"){
    const base=conn.base_url||cred.instanceUrl;if(!base||!cred.accessToken)throw new Error("salesforce_credentials_missing");
    const object=proposal.entity_type==="account"?"Account":"Contact";const isCreate=proposal.action_type==="create_missing_stakeholder"||!proposal.external_id;
    const defaults:any=proposal.entity_type==="account"?{name:"Name",domain:"Website",industry:"Industry",employeeCount:"NumberOfEmployees",city:"BillingCity",country:"BillingCountry"}:{email:"Email",phone:"Phone",title:"Title",department:"Department"};
    const body:any={};for(const [k,v] of Object.entries(after)){body[(safeJson(conn.field_mapping_json,{})?.[proposal.entity_type]?.[k])||defaults[k]||k]=v;}
    const url=base.replace(/\/$/,"")+"/services/data/v61.0/sobjects/"+object+(isCreate?"":"/"+encodeURIComponent(proposal.external_id));
    const response=await fetch(url,{method:isCreate?"POST":"PATCH",headers:{authorization:"Bearer "+cred.accessToken,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const result=await response.json().catch(()=>({})) as any;if(!response.ok)throw new Error("salesforce_write_"+response.status);
    return {externalId:String(result.id||proposal.external_id||""),providerResponse:{id:result.id||null}};
  }
  if(conn.provider==="pipedrive"){
    const base=(conn.base_url||"https://api.pipedrive.com").replace(/\/$/,"");if(!cred.apiToken)throw new Error("pipedrive_credentials_missing");
    const object=proposal.entity_type==="account"?"organizations":"persons",isCreate=proposal.action_type==="create_missing_stakeholder"||!proposal.external_id;
    const defaults:any=proposal.entity_type==="account"?{name:"name",domain:"website"}:{fullName:"name",email:"email",phone:"phone",title:"job_title"};
    const body:any={};for(const [k,v] of Object.entries(after)){body[(safeJson(conn.field_mapping_json,{})?.[proposal.entity_type]?.[k])||defaults[k]||k]=v;}
    const url=new URL(base+"/v1/"+object+(isCreate?"":"/"+proposal.external_id));url.searchParams.set("api_token",cred.apiToken);
    const response=await fetch(url,{method:isCreate?"POST":"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const result=await response.json().catch(()=>({})) as any;if(!response.ok||result.success===false)throw new Error("pipedrive_write_"+response.status);
    return {externalId:String(result?.data?.id||proposal.external_id||""),providerResponse:{id:result?.data?.id||null}};
  }
  if(conn.provider==="dynamics"){
    const base=(conn.base_url||cred.baseUrl||"").replace(/\/$/,"");if(!base||!cred.accessToken)throw new Error("dynamics_credentials_missing");
    const object=proposal.entity_type==="account"?"accounts":"contacts",isCreate=proposal.action_type==="create_missing_stakeholder"||!proposal.external_id;
    const defaults:any=proposal.entity_type==="account"?{name:"name",domain:"websiteurl",employeeCount:"numberofemployees",city:"address1_city",country:"address1_country"}:{fullName:"fullname",email:"emailaddress1",phone:"telephone1",title:"jobtitle"};
    const body:any={};for(const [k,v] of Object.entries(after)){body[(safeJson(conn.field_mapping_json,{})?.[proposal.entity_type]?.[k])||defaults[k]||k]=v;}
    const url=base+"/api/data/v9.2/"+object+(isCreate?"":"("+proposal.external_id+")");
    const response=await fetch(url,{method:isCreate?"POST":"PATCH",headers:{authorization:"Bearer "+cred.accessToken,"content-type":"application/json","OData-Version":"4.0"},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error("dynamics_write_"+response.status);const entity=response.headers.get("OData-EntityId")||"";
    return {externalId:proposal.external_id||entity.match(/\(([^)]+)\)/)?.[1]||"",providerResponse:{}};
  }
  if(conn.provider==="zoho"){
    const base=(conn.base_url||cred.apiDomain||"https://www.zohoapis.eu").replace(/\/$/,"");if(!cred.accessToken)throw new Error("zoho_credentials_missing");
    const module=proposal.entity_type==="account"?"Accounts":"Contacts",isCreate=proposal.action_type==="create_missing_stakeholder"||!proposal.external_id;
    const defaults:any=proposal.entity_type==="account"?{name:"Account_Name",domain:"Website",industry:"Industry",employeeCount:"Employees",city:"Billing_City",country:"Billing_Country"}:{fullName:"Full_Name",email:"Email",phone:"Phone",title:"Title",department:"Department"};
    const body:any={};for(const [k,v] of Object.entries(after)){body[(safeJson(conn.field_mapping_json,{})?.[proposal.entity_type]?.[k])||defaults[k]||k]=v;}if(!isCreate)body.id=proposal.external_id;
    const response=await fetch(base+"/crm/v6/"+module,{method:isCreate?"POST":"PUT",headers:{authorization:"Zoho-oauthtoken "+cred.accessToken,"content-type":"application/json"},body:JSON.stringify({data:[body]}),signal:AbortSignal.timeout(20000)});
    const result=await response.json().catch(()=>({})) as any;if(!response.ok)throw new Error("zoho_write_"+response.status);
    return {externalId:String(result?.data?.[0]?.details?.id||proposal.external_id||""),providerResponse:{id:result?.data?.[0]?.details?.id||null}};
  }
  if(conn.provider==="bridge"||conn.provider==="freshsales"){
    if(!conn.base_url||!cred.sharedSecret)throw new Error("crm_bridge_credentials_missing");
    const body=JSON.stringify({connectionId:conn.connection_id,entityType:proposal.entity_type,actionType:proposal.action_type,externalId:proposal.external_id||null,data:after});
    const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(cred.sharedSecret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body));const hex=[...new Uint8Array(sig)].map(x=>x.toString(16).padStart(2,"0")).join("");
    const response=await fetch(conn.base_url,{method:"POST",headers:{"content-type":"application/json","x-clientmotive-signature":hex},body,signal:AbortSignal.timeout(20000)});
    const result=await response.json().catch(()=>({})) as any;if(!response.ok)throw new Error("crm_bridge_write_"+response.status);
    return {externalId:String(result.externalId||proposal.external_id||""),providerResponse:result};
  }
  throw new Error("unsupported_crm_write_provider");
}

async function materialiseMissingContact(env:Env,conn:Connection,proposal:any){
  const after=safeJson(proposal.after_json,{});
  if(!after.verified||!after.email)throw new Error("missing_contact_not_verified");
  const account=await env.DB.prepare("SELECT domain FROM commercial_accounts WHERE account_id=?").bind(proposal.account_id).first<any>();
  const domain=normalizeDomain(account?.domain),emailDomain=normalizeDomain(String(after.email).split("@")[1]||"");
  if(!domain||!(emailDomain===domain||emailDomain.endsWith("."+domain)))throw new Error("contact_email_not_corporate_domain");
  const contactId=await upsertContact(env,{tenantId:conn.tenant_id,accountId:proposal.account_id,fullName:after.fullName,email:after.email,title:after.title||null,linkedinUrl:after.linkedinUrl||null,source:"clientmotive_crm_enrichment",confidence:proposal.confidence,metadata:{roleType:after.roleType,crmProposalId:proposal.proposal_id}});
  proposal.contact_id=contactId;
  return contactId;
}

export async function executeCrmProposal(env:Env,proposalId:string,actor="clientmotive"){
  const proposal=await env.DB.prepare("SELECT * FROM crm_change_proposals WHERE proposal_id=?").bind(proposalId).first<any>();if(!proposal)throw new Error("crm_proposal_not_found");
  const conn=await getConnection(env,proposal.connection_id),p=policy(conn);
  if(proposal.status==="executed")return {proposalId,status:"executed",result:safeJson(proposal.execution_result_json,{})};
  const approved=proposal.requires_approval===0||proposal.status==="approved";if(!approved)throw new Error("crm_proposal_approval_required");
  if(proposal.risk_level==="high")throw new Error("high_risk_crm_change_requires_manual_process");
  let contactId=proposal.contact_id;
  if(proposal.action_type==="create_missing_stakeholder")contactId=await materialiseMissingContact(env,conn,proposal);
  const result=await providerWrite(env,conn,{...proposal,contact_id:contactId});
  if(result.externalId){
    const localId=proposal.entity_type==="account"?proposal.account_id:contactId;
    if(localId)await linkRecord(env,conn,proposal.entity_type,localId,result.externalId,null,{createdBy:"clientmotive"});
  }
  await env.DB.prepare("UPDATE crm_change_proposals SET status='executed',contact_id=COALESCE(?,contact_id),executed_at=?,execution_result_json=?,updated_at=? WHERE proposal_id=?")
    .bind(contactId||null,isoNow(),JSON.stringify(result),isoNow(),proposalId).run();
  await env.DB.prepare(
    "INSERT INTO crm_change_audit (audit_entry_id,connection_id,proposal_id,entity_type,local_id,external_id,action_type,before_json,after_json,source_json,confidence,reason,actor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(id("crmauditentry"),conn.connection_id,proposalId,proposal.entity_type,proposal.entity_type==="account"?proposal.account_id:contactId,result.externalId||proposal.external_id||null,
    proposal.action_type,proposal.before_json,proposal.after_json,proposal.evidence_json,proposal.confidence,proposal.reason,actor,isoNow()).run();
  await env.DB.prepare("UPDATE crm_connections SET last_push_at=?,updated_at=? WHERE connection_id=?").bind(isoNow(),isoNow(),conn.connection_id).run();
  return {proposalId,status:"executed",result};
}

export async function approveCrmProposal(env:Env,proposalId:string,approvedBy:string){
  const row=await env.DB.prepare("SELECT * FROM crm_change_proposals WHERE proposal_id=?").bind(proposalId).first<any>();if(!row)throw new Error("crm_proposal_not_found");
  if(row.risk_level==="high"&&row.action_type.includes("merge"))return {proposalId,status:"manual_review_required"};
  await env.DB.prepare("UPDATE crm_change_proposals SET status='approved',approved_by=?,approved_at=?,updated_at=? WHERE proposal_id=?").bind(approvedBy,isoNow(),isoNow(),proposalId).run();
  return {proposalId,status:"approved"};
}

export async function executeEligibleProposals(env:Env,connectionId:string,limit=100,actor="policy"){
  const conn=await getConnection(env,connectionId),p=policy(conn);
  const rows=await env.DB.prepare(
    `SELECT * FROM crm_change_proposals WHERE connection_id=? AND status IN ('proposed','approved') AND risk_level='low'
     ORDER BY confidence DESC,created_at LIMIT ?`
  ).bind(connectionId,Math.max(1,Math.min(500,limit))).all<any>();
  const results:any[]=[];
  for(const row of rows.results){
    const autoAllowed=row.requires_approval===0 ||
      (row.action_type==="update_enrichment"&&["assist","managed","autonomous"].includes(conn.operating_mode)&&p.autoUpdateExisting&&Number(row.confidence)>=p.minWriteConfidence) ||
      (row.action_type==="create_missing_stakeholder"&&["managed","autonomous"].includes(conn.operating_mode)&&p.autoCreateMissingContacts&&Number(row.confidence)>=p.minWriteConfidence);
    if(!autoAllowed&&row.status!=="approved")continue;
    try{results.push(await executeCrmProposal(env,row.proposal_id,actor));}catch(error){results.push({proposalId:row.proposal_id,status:"failed",error:String(error)});}
  }
  return {connectionId,considered:rows.results.length,executed:results.filter(x=>x.status==="executed").length,results};
}

export async function crmProposals(env:Env,connectionId:string,status?:string|null){
  const rows=status?await env.DB.prepare("SELECT * FROM crm_change_proposals WHERE connection_id=? AND status=? ORDER BY confidence DESC,created_at DESC LIMIT 500").bind(connectionId,status).all<any>():
    await env.DB.prepare("SELECT * FROM crm_change_proposals WHERE connection_id=? ORDER BY created_at DESC LIMIT 500").bind(connectionId).all<any>();
  return rows.results.map(r=>({...r,before:safeJson(r.before_json,{}),after:safeJson(r.after_json,{}),evidence:safeJson(r.evidence_json,[])}));
}

export async function crmAuditTrail(env:Env,connectionId:string,limit=200){
  const rows=await env.DB.prepare("SELECT * FROM crm_change_audit WHERE connection_id=? ORDER BY created_at DESC LIMIT ?").bind(connectionId,Math.max(1,Math.min(1000,limit))).all<any>();
  return rows.results.map(r=>({...r,before:safeJson(r.before_json,{}),after:safeJson(r.after_json,{}),sources:safeJson(r.source_json,[])}));
}

export async function runCrmIntelligenceCycle(env:Env,connectionId:string){
  const conn=await getConnection(env,connectionId),runId=id("crmenrich"),started=isoNow();
  await env.DB.prepare("INSERT INTO crm_enrichment_runs (run_id,connection_id,run_type,status,started_at) VALUES (?,?,'full_cycle','running',?)").bind(runId,connectionId,started).run();
  const output:any={connectionId,mode:conn.operating_mode};
  try{output.pull=await pullCrmConnection(env,connectionId);}catch(error){output.pull={skipped:true,reason:String(error)};}
  output.audit=await auditCrmConnection(env,connectionId);
  output.companyEnrichment=await enrichCrmAccounts(env,connectionId,50);
  output.gaps=await researchStakeholderGaps(env,connectionId,30);
  output.execution=await executeEligibleProposals(env,connectionId,100,"crm_cycle_policy");
  await env.DB.prepare("UPDATE crm_enrichment_runs SET status='complete',summary_json=?,completed_at=? WHERE run_id=?").bind(JSON.stringify(output),isoNow(),runId).run();
  return {runId,...output};
}

export async function crmIntelligenceSummary(env:Env,connectionId:string){
  const conn=await getConnection(env,connectionId);
  const [counts,lastAudit,gaps,proposals,audit]=await Promise.all([
    env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM crm_record_links WHERE connection_id=? AND entity_type='account') accounts,
      (SELECT COUNT(*) FROM crm_record_links WHERE connection_id=? AND entity_type='contact') contacts`).bind(connectionId,connectionId).first<any>(),
    env.DB.prepare("SELECT * FROM crm_audit_runs WHERE connection_id=? ORDER BY created_at DESC LIMIT 1").bind(connectionId).first<any>(),
    env.DB.prepare("SELECT status,COUNT(*) AS count FROM crm_stakeholder_gaps WHERE connection_id=? GROUP BY status").bind(connectionId).all<any>(),
    env.DB.prepare("SELECT status,action_type,COUNT(*) AS count FROM crm_change_proposals WHERE connection_id=? GROUP BY status,action_type").bind(connectionId).all<any>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM crm_change_audit WHERE connection_id=?").bind(connectionId).first<any>()
  ]);
  return {
    connection:{id:conn.connection_id,provider:conn.provider,label:conn.label,mode:conn.operating_mode,status:conn.status,lastPullAt:conn.last_pull_at,lastPushAt:conn.last_push_at},
    records:{accounts:Number(counts?.accounts||0),contacts:Number(counts?.contacts||0)},
    lastAudit:lastAudit?{...safeJson(lastAudit.audit_json,{}),auditId:lastAudit.audit_id,createdAt:lastAudit.created_at}:null,
    stakeholderGaps:gaps.results,proposals:proposals.results,executedChanges:Number(audit?.count||0)
  };
}
