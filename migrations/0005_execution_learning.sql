CREATE TABLE IF NOT EXISTS outreach_candidates (
  candidate_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  trigger_signal_id TEXT,
  buyer_role TEXT,
  rationale TEXT NOT NULL,
  message_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready_for_review',
  approval_policy TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL,
  approved_at TEXT,
  sent_at TEXT,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE,
  FOREIGN KEY (trigger_signal_id) REFERENCES commercial_signals(signal_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS campaign_hypotheses (
  hypothesis_id TEXT PRIMARY KEY,
  account_id TEXT,
  opportunity_id TEXT,
  segment TEXT,
  trigger_type TEXT,
  buyer_role TEXT,
  channel TEXT NOT NULL,
  angle TEXT NOT NULL,
  cta TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  ended_at TEXT,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(opportunity_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS campaign_events (
  event_id TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  numeric_value REAL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (hypothesis_id) REFERENCES campaign_hypotheses(hypothesis_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_metrics (
  metric_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  numeric_value REAL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES commercial_accounts(account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS watch_notifications (
  notification_id TEXT PRIMARY KEY,
  watchlist_id TEXT NOT NULL,
  recipient TEXT,
  signal_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (watchlist_id) REFERENCES watchlists(watchlist_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach_candidates(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hypotheses_account ON campaign_hypotheses(account_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_events_hypothesis ON campaign_events(hypothesis_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_metrics_account ON account_metrics(account_id, occurred_at DESC);
