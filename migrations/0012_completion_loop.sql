PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS first_party_records (
  record_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  record_type TEXT NOT NULL,
  external_id TEXT,
  record_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT,
  ingested_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commercial_opportunity_scenarios (
  scenario_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  lead_id TEXT,
  account_id TEXT,
  scenario_json TEXT NOT NULL,
  assumptions_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER NOT NULL DEFAULT 40,
  created_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS alert_preferences (
  preference_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT,
  channel TEXT NOT NULL,
  destination TEXT,
  signal_types_json TEXT NOT NULL DEFAULT '[]',
  minimum_confidence INTEGER NOT NULL DEFAULT 60,
  cadence TEXT NOT NULL DEFAULT 'immediate',
  enabled INTEGER NOT NULL DEFAULT 1,
  consent_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_deliveries (
  delivery_id TEXT PRIMARY KEY,
  preference_id TEXT,
  account_id TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  destination TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE(preference_id, source_type, source_id),
  FOREIGN KEY (preference_id) REFERENCES alert_preferences(preference_id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS commercial_learnings (
  learning_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  dimension TEXT NOT NULL,
  segment TEXT,
  pattern_key TEXT NOT NULL,
  learning_json TEXT NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  confidence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'observed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, dimension, segment, pattern_key)
);

CREATE TABLE IF NOT EXISTS recommendation_executions (
  execution_id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'prepared',
  result_json TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  executed_at TEXT,
  FOREIGN KEY (recommendation_id) REFERENCES commercial_recommendations(recommendation_id) ON DELETE CASCADE
);

ALTER TABLE commercial_experiments ADD COLUMN audience TEXT;
ALTER TABLE commercial_experiments ADD COLUMN channel TEXT;
ALTER TABLE commercial_experiments ADD COLUMN primary_metric TEXT;
ALTER TABLE commercial_experiments ADD COLUMN success_criteria TEXT;
ALTER TABLE commercial_experiments ADD COLUMN planned_days INTEGER;
ALTER TABLE commercial_experiments ADD COLUMN learning_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_first_party_records_account_source ON first_party_records(account_id,source_type,record_type,ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_scenarios_lead_time ON commercial_opportunity_scenarios(lead_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_preferences_account ON alert_preferences(account_id,enabled,channel);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_status ON alert_deliveries(status,created_at);
CREATE INDEX IF NOT EXISTS idx_commercial_learnings_dimension ON commercial_learnings(dimension,segment,confidence DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_executions_rec ON recommendation_executions(recommendation_id,created_at DESC);


CREATE TABLE IF NOT EXISTS proof_candidates (
  proof_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  account_id TEXT,
  opportunity_id TEXT,
  title TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  client_approved INTEGER NOT NULL DEFAULT 0,
  publication_approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_proof_candidates_status ON proof_candidates(status,client_approved,publication_approved,created_at DESC);
