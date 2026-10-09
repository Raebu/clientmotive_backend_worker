PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS visitor_sessions (
  session_id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  landing_path TEXT NOT NULL,
  referrer_domain TEXT,
  country_code TEXT,
  device_class TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  submitted_lead_id TEXT
);

CREATE TABLE IF NOT EXISTS visitor_events (
  event_id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  path TEXT NOT NULL,
  properties_json TEXT NOT NULL DEFAULT '{}',
  intent_weight INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES visitor_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS leads (
  lead_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  visitor_id TEXT,
  session_id TEXT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_domain TEXT,
  company TEXT NOT NULL,
  website TEXT,
  domain TEXT,
  offer TEXT NOT NULL,
  market TEXT NOT NULL,
  problem TEXT NOT NULL,
  outcome TEXT NOT NULL,
  source_path TEXT,
  source TEXT,
  utm_json TEXT NOT NULL DEFAULT '{}',
  consent_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new',
  research_status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_jobs (
  job_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS research_evidence (
  evidence_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_title TEXT,
  source_type TEXT NOT NULL,
  query_text TEXT,
  snippet TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS company_profiles (
  lead_id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  domain TEXT,
  summary TEXT NOT NULL,
  offers_json TEXT NOT NULL DEFAULT '[]',
  industries_json TEXT NOT NULL DEFAULT '[]',
  geographies_json TEXT NOT NULL DEFAULT '[]',
  buyer_hints_json TEXT NOT NULL DEFAULT '[]',
  proof_points_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  sources_json TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS competitors (
  competitor_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  name TEXT NOT NULL,
  website TEXT,
  competitor_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  positioning TEXT NOT NULL,
  strengths_json TEXT NOT NULL DEFAULT '[]',
  weaknesses_json TEXT NOT NULL DEFAULT '[]',
  differentiation_opportunity TEXT NOT NULL,
  source_urls_json TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS buyer_roles (
  buyer_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  role TEXT NOT NULL,
  role_type TEXT NOT NULL,
  pain TEXT NOT NULL,
  trigger_text TEXT NOT NULL,
  message_angle TEXT NOT NULL,
  title_variants_json TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_recommendations (
  channel_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  priority TEXT NOT NULL,
  role_text TEXT NOT NULL,
  why_text TEXT NOT NULL,
  prerequisites_json TEXT NOT NULL DEFAULT '[]',
  first_experiment TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS target_accounts (
  account_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  company TEXT NOT NULL,
  website TEXT,
  rationale TEXT NOT NULL,
  triggers_json TEXT NOT NULL DEFAULT '[]',
  buyer_roles_json TEXT NOT NULL DEFAULT '[]',
  source_urls_json TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lead_scores (
  lead_id TEXT PRIMARY KEY,
  fit INTEGER NOT NULL,
  intent INTEGER NOT NULL,
  need INTEGER NOT NULL,
  timing INTEGER NOT NULL,
  commercial_potential INTEGER NOT NULL,
  access INTEGER NOT NULL,
  overall INTEGER NOT NULL,
  tier TEXT NOT NULL,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  scored_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dossiers (
  lead_id TEXT PRIMARY KEY,
  dossier_json TEXT NOT NULL,
  prospect_snapshot_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS next_actions (
  action_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  action_text TEXT NOT NULL,
  owner TEXT NOT NULL,
  priority TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  lead_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visitor_sessions_visitor_last_seen
  ON visitor_sessions(visitor_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_visitor_events_visitor_time
  ON visitor_events(visitor_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_visitor_events_session_time
  ON visitor_events(session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_leads_domain_created
  ON leads(domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_leads_status_created
  ON leads(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_jobs_lead_stage
  ON research_jobs(lead_id, stage);

CREATE INDEX IF NOT EXISTS idx_evidence_lead_stage
  ON research_evidence(lead_id, stage);

CREATE INDEX IF NOT EXISTS idx_competitors_lead
  ON competitors(lead_id);

CREATE INDEX IF NOT EXISTS idx_target_accounts_lead
  ON target_accounts(lead_id);
