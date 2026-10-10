PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  plan TEXT NOT NULL DEFAULT 'internal',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_members (
  member_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'user',
  roles_json TEXT NOT NULL DEFAULT '[]',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, subject_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO tenants (tenant_id,name,slug,status,plan,settings_json,created_at,updated_at)
VALUES ('tenant_clientmotive','ClientMotive','clientmotive','active','internal','{}',datetime('now'),datetime('now'));

ALTER TABLE leads ADD COLUMN tenant_id TEXT DEFAULT 'tenant_clientmotive';
ALTER TABLE commercial_accounts ADD COLUMN tenant_id TEXT DEFAULT 'tenant_clientmotive';
ALTER TABLE opportunities ADD COLUMN tenant_id TEXT DEFAULT 'tenant_clientmotive';
ALTER TABLE api_clients ADD COLUMN tenant_id TEXT DEFAULT 'tenant_clientmotive';
ALTER TABLE account_portfolios ADD COLUMN tenant_id TEXT DEFAULT 'tenant_clientmotive';

CREATE TABLE IF NOT EXISTS contacts (
  contact_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT,
  lead_id TEXT,
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  title TEXT,
  department TEXT,
  linkedin_url TEXT,
  lifecycle_stage TEXT NOT NULL DEFAULT 'known',
  source TEXT,
  confidence INTEGER NOT NULL DEFAULT 50,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS contact_roles (
  contact_role_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role_type TEXT NOT NULL,
  relationship_strength INTEGER NOT NULL DEFAULT 50,
  is_primary INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(contact_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS communication_events (
  communication_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT,
  contact_id TEXT,
  opportunity_id TEXT,
  provider TEXT NOT NULL,
  external_id TEXT,
  direction TEXT NOT NULL,
  channel TEXT NOT NULL,
  subject TEXT,
  body_text TEXT,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  classification_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(provider, external_id),
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(contact_id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS contact_permissions (
  permission_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  contact_id TEXT,
  email TEXT,
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL,
  lawful_basis TEXT,
  status TEXT NOT NULL,
  source TEXT,
  notice_version TEXT,
  recorded_at TEXT NOT NULL,
  expires_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (contact_id) REFERENCES contacts(contact_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS suppression_entries (
  suppression_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  value_type TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'tenant',
  source TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(tenant_id, value_type, value_hash, scope)
);

CREATE TABLE IF NOT EXISTS deliverability_checks (
  check_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  email TEXT,
  domain TEXT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_score INTEGER NOT NULL DEFAULT 50,
  details_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS enrichment_facts (
  fact_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_value_json TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT,
  confidence INTEGER NOT NULL DEFAULT 50,
  observed_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fact_conflicts (
  conflict_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  fact_ids_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS attribution_touches (
  touch_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  visitor_id TEXT,
  lead_id TEXT,
  account_id TEXT,
  opportunity_id TEXT,
  touch_type TEXT NOT NULL,
  source TEXT,
  campaign TEXT,
  content TEXT,
  path TEXT,
  monetary_cost REAL NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS revenue_targets (
  target_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  target_revenue REAL NOT NULL,
  target_gross_margin REAL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revenue_forecasts (
  forecast_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  weighted_pipeline REAL NOT NULL DEFAULT 0,
  committed_revenue REAL NOT NULL DEFAULT 0,
  expected_revenue REAL NOT NULL DEFAULT 0,
  target_revenue REAL,
  revenue_gap REAL,
  assumptions_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capacity_periods (
  capacity_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  capacity_units REAL NOT NULL,
  committed_units REAL NOT NULL DEFAULT 0,
  unit_name TEXT NOT NULL DEFAULT 'delivery_days',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunity_economics (
  opportunity_id TEXT PRIMARY KEY,
  expected_revenue REAL,
  expected_delivery_cost REAL,
  expected_external_cost REAL,
  expected_hours REAL,
  expected_margin REAL,
  contribution_score INTEGER,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deal_risks (
  risk_id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  risk_type TEXT NOT NULL,
  severity INTEGER NOT NULL,
  rationale TEXT NOT NULL,
  recommended_action TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS procurement_profiles (
  procurement_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  security_review INTEGER NOT NULL DEFAULT 0,
  dpa_required INTEGER NOT NULL DEFAULT 0,
  insurance_required INTEGER NOT NULL DEFAULT 0,
  vendor_portal TEXT,
  payment_terms_days INTEGER,
  framework_required INTEGER NOT NULL DEFAULT 0,
  requirements_json TEXT NOT NULL DEFAULT '{}',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tender_opportunities (
  tender_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  external_id TEXT,
  title TEXT NOT NULL,
  buyer TEXT,
  source_url TEXT,
  deadline TEXT,
  value_estimate REAL,
  fit_score INTEGER NOT NULL DEFAULT 50,
  effort_score INTEGER NOT NULL DEFAULT 50,
  competition_score INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'discovered',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, external_id)
);

CREATE TABLE IF NOT EXISTS agreements (
  agreement_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  opportunity_id TEXT,
  account_id TEXT NOT NULL,
  provider TEXT,
  external_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  signed_at TEXT,
  content_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS billing_events (
  billing_event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT,
  opportunity_id TEXT,
  provider TEXT NOT NULL,
  external_id TEXT,
  event_type TEXT NOT NULL,
  amount REAL,
  currency TEXT DEFAULT 'GBP',
  status TEXT,
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(provider, external_id),
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS onboarding_plans (
  onboarding_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT NOT NULL,
  opportunity_id TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  checklist_json TEXT NOT NULL DEFAULT '[]',
  kpis_json TEXT NOT NULL DEFAULT '[]',
  communication_cadence TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS delivery_milestones (
  milestone_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT NOT NULL,
  opportunity_id TEXT,
  milestone_type TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at TEXT,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  quality_score INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS customer_success_playbooks (
  playbook_id TEXT PRIMARY KEY,
  health_state TEXT NOT NULL UNIQUE,
  actions_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS partner_performance (
  partner_id TEXT PRIMARY KEY,
  introductions INTEGER NOT NULL DEFAULT 0,
  meetings INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  attributed_revenue REAL NOT NULL DEFAULT 0,
  estimated_margin REAL NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 50,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (partner_id) REFERENCES partner_candidates(partner_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS human_tasks (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  task_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  assigned_to TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  due_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS decision_audit (
  decision_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  entity_type TEXT,
  entity_id TEXT,
  decision_type TEXT NOT NULL,
  recommendation_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER,
  decided_by TEXT,
  decision TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_budgets (
  budget_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  workflow TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT 'monthly',
  max_search_calls INTEGER,
  max_ai_calls INTEGER,
  max_cost REAL,
  spent_search_calls INTEGER NOT NULL DEFAULT 0,
  spent_ai_calls INTEGER NOT NULL DEFAULT 0,
  spent_cost REAL NOT NULL DEFAULT 0,
  resets_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, workflow)
);

CREATE TABLE IF NOT EXISTS model_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT,
  dataset_version TEXT,
  sample_size INTEGER NOT NULL DEFAULT 0,
  accuracy_score REAL,
  grounding_score REAL,
  usefulness_score REAL,
  cost_estimate REAL,
  latency_ms REAL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_success_at TEXT,
  last_failure_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  quota_remaining REAL,
  details_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_exports (
  export_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  export_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  object_count INTEGER NOT NULL DEFAULT 0,
  content_json TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_communications_account_time ON communication_events(account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_permissions_email ON contact_permissions(email, channel, purpose);
CREATE INDEX IF NOT EXISTS idx_suppressions_hash ON suppression_entries(value_hash);
CREATE INDEX IF NOT EXISTS idx_facts_entity_field ON enrichment_facts(entity_type, entity_id, field_name, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_attribution_opportunity ON attribution_touches(opportunity_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_forecasts_period ON revenue_forecasts(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_deal_risks_opportunity ON deal_risks(opportunity_id, status, severity DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_procurement_account_unique ON procurement_profiles(account_id);
CREATE INDEX IF NOT EXISTS idx_tenders_deadline ON tender_opportunities(status, deadline);
CREATE INDEX IF NOT EXISTS idx_billing_account_time ON billing_events(account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_milestones_account ON delivery_milestones(account_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_human_tasks_queue ON human_tasks(status, priority, due_at);
CREATE INDEX IF NOT EXISTS idx_decisions_entity ON decision_audit(entity_type, entity_id, created_at DESC);

INSERT OR IGNORE INTO customer_success_playbooks (playbook_id,health_state,actions_json,description,active,updated_at) VALUES
('cs_healthy_expanding','healthy_expanding','["Review expansion evidence","Confirm delivery quality","Propose only value-creating adjacent work"]','Healthy client with credible expansion signals.',1,datetime('now')),
('cs_healthy_flat','healthy_flat','["Reconfirm outcomes","Identify next commercial priority","Refresh intelligence portfolio"]','Healthy account without obvious expansion.',1,datetime('now')),
('cs_weak_engagement','weak_engagement','["Confirm executive sponsor","Reduce friction","Agree one next useful decision"]','Engagement has weakened.',1,datetime('now')),
('cs_weak_outcomes','weak_outcomes','["Stop expansion selling","Diagnose delivery/outcome gap","Agree recovery plan"]','Outcomes are weak and need recovery before renewal/expansion.',1,datetime('now')),
('cs_sponsor_lost','sponsor_lost','["Identify replacement sponsor","Re-establish value narrative","Multi-thread account carefully"]','Primary sponsor has left or disengaged.',1,datetime('now'));

INSERT OR IGNORE INTO workflow_budgets (budget_id,tenant_id,workflow,period,max_search_calls,max_ai_calls,max_cost,resets_at,updated_at) VALUES
('budget_research','tenant_clientmotive','lead_research','monthly',500,500,25,date('now','start of month','+1 month'),datetime('now')),
('budget_prospecting','tenant_clientmotive','autonomous_prospecting','monthly',300,300,15,date('now','start of month','+1 month'),datetime('now')),
('budget_content','tenant_clientmotive','content_intelligence','monthly',100,100,5,date('now','start of month','+1 month'),datetime('now'));
