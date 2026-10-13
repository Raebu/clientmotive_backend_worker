import type { Env, ScoreBreakdown } from "../types";
import type { LeadRow } from "../db";
import { id, isoNow } from "../lib/ids";
import { renderProspectTeaserPdf } from "../commercial/reportRenderer";

async function record(env: Env, leadId: string, channel: string, status: string, providerId: string | null, error: string | null) {
  await env.DB.prepare(
    "INSERT INTO notifications (notification_id, lead_id, channel, status, provider_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id("note"), leadId, channel, status, providerId, error, isoNow()).run();
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  try { return value ? JSON.parse(String(value)) as T : fallback; } catch { return fallback; }
};


function bytesToBase64(bytes: Uint8Array): string {
  let out="";
  const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk) out += String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));
  return btoa(out);
}

const esc = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

export async function notifyLeadReady(
  env: Env,
  lead: LeadRow,
  score: ScoreBreakdown,
  executiveSummary: string
): Promise<void> {
  const subject = `ClientMotive ${score.tier}-tier lead: ${lead.company} (${score.overall}/100)`;

  const [profile, competitors, channels, buyers, accounts, dossier, actions] = await Promise.all([
    env.DB.prepare("SELECT * FROM company_profiles WHERE lead_id=?").bind(lead.lead_id).first<any>(),
    env.DB.prepare("SELECT * FROM competitors WHERE lead_id=? LIMIT 10").bind(lead.lead_id).all<any>(),
    env.DB.prepare("SELECT * FROM channel_recommendations WHERE lead_id=? LIMIT 8").bind(lead.lead_id).all<any>(),
    env.DB.prepare("SELECT * FROM buyer_roles WHERE lead_id=? LIMIT 7").bind(lead.lead_id).all<any>(),
    env.DB.prepare("SELECT * FROM target_accounts WHERE lead_id=? LIMIT 20").bind(lead.lead_id).all<any>(),
    env.DB.prepare("SELECT dossier_json, prospect_snapshot_json FROM dossiers WHERE lead_id=?").bind(lead.lead_id).first<any>(),
    env.DB.prepare("SELECT action_text,owner,priority,reason FROM next_actions WHERE lead_id=? AND status='open' LIMIT 10").bind(lead.lead_id).all<any>()
  ]);

  const dossierJson = parseJson<any>(dossier?.dossier_json, {});
  const snapshot = parseJson<any>(dossier?.prospect_snapshot_json, {});
  const lines: string[] = [
    subject, "",
    "ClientMotive research is complete.", "",
    "CONTACT",
    `${lead.name} <${lead.email}>`,
    "Company: " + lead.company,
    "Website: " + (lead.website || lead.domain || "not supplied"),
    "Lead ID: " + lead.lead_id, "",
    "SCORE",
    `Overall: ${score.overall}/100 (${score.tier}-tier)`,
    `Fit: ${score.fit} | Intent: ${score.intent} | Need: ${score.need} | Timing: ${score.timing} | Commercial potential: ${score.commercialPotential} | Access: ${score.access}`, "",
    "EXECUTIVE SUMMARY",
    dossierJson.executiveSummary || executiveSummary || "", "",
    "OPPORTUNITY THESIS",
    dossierJson.opportunityThesis || "", "",
    "PROSPECT SNAPSHOT",
    snapshot.headline || ""
  ];

  for (const item of snapshot.observations || []) lines.push("- " + item);
  lines.push("", "COMPANY PROFILE", profile?.summary || "");
  for (const item of parseJson<string[]>(profile?.offers_json, [])) lines.push("- Offer: " + item);
  for (const item of parseJson<string[]>(profile?.industries_json, [])) lines.push("- Industry: " + item);
  for (const item of parseJson<string[]>(profile?.geographies_json, [])) lines.push("- Geography: " + item);

  lines.push("", "COMPETITORS");
  for (const row of competitors.results) {
    lines.push(`- ${row.name}: ${row.summary || ""}`);
    if (row.differentiation_opportunity) lines.push("  Opportunity: " + row.differentiation_opportunity);
  }

  lines.push("", "BUYING COMMITTEE");
  for (const row of buyers.results) {
    lines.push(`- ${row.role} (${row.role_type}): ${row.pain || ""}`);
    if (row.trigger_text) lines.push("  Trigger: " + row.trigger_text);
    if (row.message_angle) lines.push("  Message angle: " + row.message_angle);
  }

  lines.push("", "CHANNELS");
  for (const row of channels.results) {
    lines.push(`- ${row.channel} [${row.priority}]: ${row.why_text || row.role_text || ""}`);
    if (row.first_experiment) lines.push("  First experiment: " + row.first_experiment);
  }

  lines.push("", "TARGET ACCOUNTS");
  for (const row of accounts.results) lines.push(`- ${row.company}: ${row.rationale || ""}`);

  lines.push("", "NEXT ACTIONS");
  for (const row of actions.results) lines.push(`- [${row.priority}] ${row.action_text} — ${row.reason || ""}`);

  lines.push("", "ORIGINAL BRIEF", "Offer:", lead.offer, "", "Market:", lead.market, "", "Problem:", lead.problem, "", "Outcome:", lead.outcome);

  const text = lines.join("\n");

  const list = (items: string[]) => items.length ? "<ul>" + items.map(x=>`<li>${esc(x)}</li>`).join("") + "</ul>" : "<p>None generated.</p>";
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:900px;margin:auto;color:#10203f;line-height:1.5">
    <h1>${esc(subject)}</h1>
    <p><strong>Research complete.</strong></p>
    <h2>Lead</h2><p>${esc(lead.name)} &lt;${esc(lead.email)}&gt;<br>${esc(lead.company)}<br>${esc(lead.website || lead.domain || "not supplied")}<br><small>${esc(lead.lead_id)}</small></p>
    <h2>Score</h2><p><strong>${score.overall}/100 · ${esc(score.tier)}-tier</strong><br>Fit ${score.fit} · Intent ${score.intent} · Need ${score.need} · Timing ${score.timing} · Commercial potential ${score.commercialPotential} · Access ${score.access}</p>
    <h2>Executive summary</h2><p>${esc(dossierJson.executiveSummary || executiveSummary || "")}</p>
    <h2>Opportunity thesis</h2><p>${esc(dossierJson.opportunityThesis || "")}</p>
    <h2>Prospect snapshot</h2><p><strong>${esc(snapshot.headline || "")}</strong></p>${list((snapshot.observations || []).map((x:any)=>String(x)))}
    <h2>Company profile</h2><p>${esc(profile?.summary || "")}</p>
    <h2>Competitors</h2>${list(competitors.results.map((r:any)=>`${r.name}: ${r.summary || ""}${r.differentiation_opportunity ? " — Opportunity: " + r.differentiation_opportunity : ""}`))}
    <h2>Buying committee</h2>${list(buyers.results.map((r:any)=>`${r.role} (${r.role_type}): ${r.pain || ""}${r.trigger_text ? " — Trigger: " + r.trigger_text : ""}${r.message_angle ? " — Message angle: " + r.message_angle : ""}`))}
    <h2>Channels</h2>${list(channels.results.map((r:any)=>`${r.channel} [${r.priority}]: ${r.why_text || r.role_text || ""}${r.first_experiment ? " — First experiment: " + r.first_experiment : ""}`))}
    <h2>Target accounts</h2>${list(accounts.results.map((r:any)=>`${r.company}: ${r.rationale || ""}`))}
    <h2>Next actions</h2>${list(actions.results.map((r:any)=>`[${r.priority}] ${r.action_text} — ${r.reason || ""}`))}
    <h2>Original brief</h2>
    <h3>Offer</h3><p>${esc(lead.offer)}</p>
    <h3>Market</h3><p>${esc(lead.market)}</p>
    <h3>Problem</h3><p>${esc(lead.problem)}</p>
    <h3>Outcome</h3><p>${esc(lead.outcome)}</p>
  </div>`;

  if (env.RESEND_API_KEY && env.ALERT_EMAIL_TO) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: "Bearer " + env.RESEND_API_KEY,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          from: env.ALERT_EMAIL_FROM || "ClientMotive Intelligence <clientmotive@clientmotive.com>",
          to: [env.ALERT_EMAIL_TO],
          reply_to: lead.email,
          subject,
          text,
          html
        })
      });
      const body = await response.json().catch(() => ({})) as { id?: string };
      await record(env, lead.lead_id, "email", response.ok ? "sent" : "failed", body.id || null, response.ok ? null : "resend_" + response.status);
    } catch (error) {
      await record(env, lead.lead_id, "email", "failed", null, String(error).slice(0, 500));
    }
  }

  if (env.RESEND_API_KEY && lead.email) {
    try {
      const teaserPdf=await renderProspectTeaserPdf({
        company:lead.company,
        headline:snapshot.headline || dossierJson.executiveSummary || null,
        observations:Array.isArray(snapshot.observations)?snapshot.observations.slice(0,3):[],
        competitor:competitors.results[0] ? {
          name:competitors.results[0].name,
          summary:competitors.results[0].summary,
          differentiationOpportunity:competitors.results[0].differentiation_opportunity
        } : null,
        buyer:buyers.results[0] ? {
          role:buyers.results[0].role,
          pain:buyers.results[0].pain,
          trigger:buyers.results[0].trigger_text,
          messageAngle:buyers.results[0].message_angle
        } : null,
        channel:channels.results[0] ? {
          channel:channels.results[0].channel,
          why:channels.results[0].why_text || channels.results[0].role_text,
          firstExperiment:channels.results[0].first_experiment
        } : null
      });
      const firstName=String(lead.name||"").trim().split(/\\s+/)[0] || "there";
      const customerSubject=`Your ClientMotive growth signal is ready - ${lead.company}`;
      const customerText=[
        `Hi ${firstName},`,
        "",
        "Your initial ClientMotive growth signal is ready.",
        "",
        "We have attached a focused first-look report. It gives you several useful signals from the research without replacing the deeper decision-ready work in the full Growth Snapshot.",
        "",
        "If the initial signal is useful, the full Growth Snapshot expands this into the complete market, competitor, buyer, target-account, evidence and 90-day action view.",
        "",
        "Full Growth Snapshot: £1,500-£3,000",
        "https://www.clientmotive.com/offers/",
        "",
        "Regards,",
        "ClientMotive"
      ].join("\\n");
      const customerHtml=`<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:auto;color:#0b1736;line-height:1.6">
        <p style="font-size:13px;font-weight:700;color:#0064f0;letter-spacing:.08em;text-transform:uppercase">ClientMotive</p>
        <h1 style="font-size:30px;line-height:1.15;margin:18px 0">Your growth signal is ready.</h1>
        <p>Hi ${esc(firstName)},</p>
        <p>We have attached a focused first-look report based on your brief and the evidence collected so far.</p>
        <p>It is designed to be genuinely useful now, while keeping the deeper market, competitor, buyer, target-account and action analysis for the full Growth Snapshot.</p>
        <div style="margin:28px 0;padding:22px;background:#f4f7fb;border-radius:14px">
          <strong>Want the complete decision-ready view?</strong><br>
          Full ClientMotive Growth Snapshot · £1,500-£3,000
        </div>
        <p><a href="https://www.clientmotive.com/offers/" style="display:inline-block;background:#0668f7;color:white;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:999px">Explore the full Growth Snapshot →</a></p>
        <p style="margin-top:30px">Regards,<br><strong>ClientMotive</strong></p>
      </div>`;
      const response=await fetch("https://api.resend.com/emails",{
        method:"POST",
        headers:{authorization:"Bearer "+env.RESEND_API_KEY,"content-type":"application/json"},
        body:JSON.stringify({
          from:env.ALERT_EMAIL_FROM || "ClientMotive <clientmotive@clientmotive.com>",
          to:[lead.email],
          reply_to:env.ALERT_EMAIL_TO || "contact@clientmotive.com",
          subject:customerSubject,
          text:customerText,
          html:customerHtml,
          attachments:[{filename:"ClientMotive-Growth-Signal.pdf",content:bytesToBase64(teaserPdf)}]
        })
      });
      const body=await response.json().catch(()=>({})) as {id?:string};
      await record(env,lead.lead_id,"prospect_email",response.ok?"sent":"failed",body.id||null,response.ok?null:"resend_"+response.status);
    } catch(error) {
      await record(env,lead.lead_id,"prospect_email","failed",null,String(error).slice(0,500));
    }
  }

  if (env.SLACK_WEBHOOK_URL && score.tier === "A") {
    try {
      const response = await fetch(env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `*${subject}*\n${dossierJson.executiveSummary || executiveSummary}\n${lead.name} — ${lead.email}\nLead ID: ${lead.lead_id}`
        })
      });
      await record(env, lead.lead_id, "slack", response.ok ? "sent" : "failed", null, response.ok ? null : "slack_" + response.status);
    } catch (error) {
      await record(env, lead.lead_id, "slack", "failed", null, String(error).slice(0, 500));
    }
  }
}
