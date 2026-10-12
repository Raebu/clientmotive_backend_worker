PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS crm_connections (
  connection_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  operating_mode TEXT NOT NULL DEFAULT 'observe',
  status TEXT NOT NULL DEFAULT 'active',
  external_org_id TEXT,
  base_url TEXT,
  credential_ciphertext TEXT,
  credential_iv TEXT,
  field_mapping_json TEXT NOT NULL DEFAULT '{}',
  policy_json TEXT NOT NULL DEFAULT '{}',
  last_pull_at TEXT,
  last_push_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_record_links (
  link_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  local_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_updated_at TEXT,
  last_seen_at TEXT NOT NULL,
  sync_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(connection_id,entity_type,external_id),
  UNIQUE(connection_id,entity_type,local_id),
  FOREIGN KEY (connection_id) REFERENCES crm_connections(connection_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS crm_change_proposals (
  proposal_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  account_id TEXT,
  contact_id TEXT,
  entity_type TEXT NOT NULL,
  action_type TEXT NOT NULL,
  external_id TEXT,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER NOT NULL DEFAULT 50,
  reason TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'proposed',
  requires_approval INTEGER NOT NULL DEFAULT 1,
  approved_by TEXT,
  approved_at TEXT,
  executed_at TEXT,
  execution_result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES crm_connections(connection_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(contact_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS crm_audit_runs (
  audit_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  audit_json TEXT NOT NULL,
  issue_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  stale_count INTEGER NOT NULL DEFAULT 0,
  missing_stakeholder_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES crm_connections(connection_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS crm_enrichment_runs (
  run_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  account_id TEXT,
  run_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  summary_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (connection_id) REFERENCES crm_connections(connection_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS crm_change_audit (
  audit_entry_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  proposal_id TEXT,
  entity_type TEXT NOT NULL,
  local_id TEXT,
  external_id TEXT,
  action_type TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  source_json TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER,
  reason TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES crm_connections(connection_id) ON DELETE CASCADE,
  FOREIGN KEY (proposal_id) REFERENCES crm_change_proposals(proposal_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS crm_stakeholder_gaps (
  gap_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role_type TEXT NOT NULL,
  role_label TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  candidate_json TEXT,
  confidence INTEGER NOT NULL DEFAULT 50,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id,account_id,role_type),
  FOREIGN KEY (connection_id) REFERENCES crm_connections(connection_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crm_connections_tenant ON crm_connections(tenant_id,status,provider);
CREATE INDEX IF NOT EXISTS idx_crm_links_local ON crm_record_links(connection_id,entity_type,local_id);
CREATE INDEX IF NOT EXISTS idx_crm_proposals_status ON crm_change_proposals(connection_id,status,risk_level,confidence DESC);
CREATE INDEX IF NOT EXISTS idx_crm_audit_connection ON crm_audit_runs(connection_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_change_audit_connection ON crm_change_audit(connection_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_gaps_account ON crm_stakeholder_gaps(connection_id,account_id,status);
