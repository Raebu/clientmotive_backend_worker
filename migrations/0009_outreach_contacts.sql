CREATE TABLE IF NOT EXISTS outreach_people (
  person_key TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  apollo_person_id TEXT NOT NULL,
  full_name TEXT,
  title TEXT,
  linkedin_url TEXT,
  work_email TEXT,
  email_domain TEXT,
  email_source TEXT,
  email_status TEXT,
  safe_to_send INTEGER NOT NULL DEFAULT 0,
  verification_provider TEXT,
  verification_json TEXT,
  contact_allowed INTEGER,
  contact_reason TEXT,
  contact_id TEXT,
  enrichment_status TEXT NOT NULL DEFAULT 'research_only',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(candidate_id, apollo_person_id),
  FOREIGN KEY (candidate_id) REFERENCES outreach_candidates(candidate_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outreach_people_candidate ON outreach_people(candidate_id, enrichment_status);
CREATE INDEX IF NOT EXISTS idx_outreach_people_email ON outreach_people(work_email);

ALTER TABLE outreach_candidates ADD COLUMN selected_person_key TEXT;
ALTER TABLE outreach_candidates ADD COLUMN external_message_id TEXT;
ALTER TABLE outreach_candidates ADD COLUMN send_error TEXT;
