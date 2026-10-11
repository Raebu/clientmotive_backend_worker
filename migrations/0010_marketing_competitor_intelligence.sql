PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS marketing_intelligence_reports (
  report_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  lead_id TEXT,
  domain TEXT NOT NULL,
  company_name TEXT,
  report_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  evidence_coverage TEXT NOT NULL DEFAULT 'limited',
  confidence INTEGER NOT NULL DEFAULT 40,
  status TEXT NOT NULL DEFAULT 'complete',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(lead_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS competitor_intelligence_profiles (
  profile_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'tenant_clientmotive',
  report_id TEXT NOT NULL,
  competitor_name TEXT NOT NULL,
  competitor_domain TEXT,
  competitor_type TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence INTEGER NOT NULL DEFAULT 40,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (report_id) REFERENCES marketing_intelligence_reports(report_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_marketing_intel_lead ON marketing_intelligence_reports(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_intel_domain ON marketing_intelligence_reports(domain, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_competitor_intel_report ON competitor_intelligence_profiles(report_id, competitor_type);
CREATE INDEX IF NOT EXISTS idx_competitor_intel_domain ON competitor_intelligence_profiles(competitor_domain, created_at DESC);
