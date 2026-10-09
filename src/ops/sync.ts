import type { Env } from "../types";
import { id, isoNow } from "../lib/ids";

export async function crmDelta(env:Env,input:{tenantId?:string;since?:string|null;limit?:number}):Promise<Record<string,unknown>>{
  const tenantId=input.tenantId || "tenant_clientmotive";
  const since=input.since || "1970-01-01T00:00:00.000Z";
  const limit=Math.max(1,Math.min(500,input.limit || 200));
  const [accounts,contacts,opportunities,communications]=await Promise.all([
    env.DB.prepare("SELECT * FROM commercial_accounts WHERE tenant_id=? AND updated_at>? ORDER BY updated_at LIMIT ?").bind(tenantId,since,limit).all<any>(),
    env.DB.prepare("SELECT * FROM contacts WHERE tenant_id=? AND updated_at>? ORDER BY updated_at LIMIT ?").bind(tenantId,since,limit).all<any>(),
    env.DB.prepare("SELECT * FROM opportunities WHERE tenant_id=? AND updated_at>? ORDER BY updated_at LIMIT ?").bind(tenantId,since,limit).all<any>(),
    env.DB.prepare("SELECT * FROM communication_events WHERE tenant_id=? AND created_at>? ORDER BY created_at LIMIT ?").bind(tenantId,since,limit).all<any>()
  ]);
  return {
    tenantId,since,
    generatedAt:isoNow(),
    accounts:accounts.results,
    contacts:contacts.results,
    opportunities:opportunities.results,
    communications:communications.results
  };
}

export async function updateSyncState(env:Env,input:{tenantId?:string;provider:string;resourceType:string;cursor?:string|null;status?:string;details?:Record<string,unknown>}):Promise<string>{
  const tenantId=input.tenantId || "tenant_clientmotive";
  const existing=await env.DB.prepare(
    "SELECT sync_id FROM provider_sync_state WHERE tenant_id=? AND provider=? AND resource_type=? LIMIT 1"
  ).bind(tenantId,input.provider,input.resourceType).first<{sync_id:string}>();
  const now=isoNow();
  if(existing){
    await env.DB.prepare(
      "UPDATE provider_sync_state SET cursor=?,last_synced_at=?,status=?,details_json=?,updated_at=? WHERE sync_id=?"
    ).bind(input.cursor || null,now,input.status || "ok",JSON.stringify(input.details || {}),now,existing.sync_id).run();
    return existing.sync_id;
  }
  const syncId=id("sync");
  await env.DB.prepare(
    "INSERT INTO provider_sync_state (sync_id,tenant_id,provider,resource_type,cursor,last_synced_at,status,details_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(syncId,tenantId,input.provider,input.resourceType,input.cursor || null,now,input.status || "ok",JSON.stringify(input.details || {}),now).run();
  return syncId;
}

export async function syncStates(env:Env,tenantId="tenant_clientmotive"):Promise<Record<string,unknown>[]>{
  const rows=await env.DB.prepare(
    "SELECT * FROM provider_sync_state WHERE tenant_id=? ORDER BY provider,resource_type"
  ).bind(tenantId).all<any>();
  return rows.results;
}
