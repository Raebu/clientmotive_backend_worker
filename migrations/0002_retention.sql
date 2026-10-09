CREATE INDEX IF NOT EXISTS idx_visitor_events_occurred
  ON visitor_events(occurred_at);

CREATE INDEX IF NOT EXISTS idx_sessions_last_seen
  ON visitor_sessions(last_seen_at);

CREATE INDEX IF NOT EXISTS idx_audit_created
  ON audit_log(created_at);
