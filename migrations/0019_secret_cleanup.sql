CREATE TABLE secret_cleanup_reviews (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  distribution_review_id TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_token_id TEXT,
  member_revision INTEGER NOT NULL CHECK (member_revision > 0),
  request_hash TEXT NOT NULL,
  captured_json TEXT NOT NULL CHECK (json_valid(captured_json)),
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('reviewed','preparing','submitted','finished')),
  write_status TEXT NOT NULL CHECK (write_status IN ('not-sent','accepted','rejected','indeterminate')),
  reason TEXT,
  observation_status TEXT NOT NULL CHECK (observation_status IN ('unknown','present','absent','unavailable')),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  observed_at TEXT,
  submitted_at TEXT,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  lease_id TEXT,
  lease_expires_at TEXT,
  write_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,distribution_review_id) REFERENCES secret_reviews(workspace_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX secret_cleanup_history ON secret_cleanup_reviews(workspace_id,distribution_review_id,created_at DESC,id);

CREATE TRIGGER push_secret_cleanup_insert AFTER INSERT ON secret_cleanup_reviews
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
CREATE TRIGGER push_secret_cleanup_update AFTER UPDATE ON secret_cleanup_reviews
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
