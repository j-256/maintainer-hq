CREATE TABLE secret_reviews (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_token_id TEXT,
  member_revision INTEGER NOT NULL CHECK (member_revision > 0),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  request_hash TEXT NOT NULL,
  captured_json TEXT NOT NULL CHECK (json_valid(captured_json)),
  draft_fingerprint TEXT NOT NULL,
  fingerprint TEXT,
  input_hash TEXT,
  stage TEXT NOT NULL CHECK (stage IN ('awaiting-input','reviewed','accepted','cancelled')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  input_expires_at TEXT NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id)
) STRICT;
CREATE INDEX secret_reviews_history ON secret_reviews(workspace_id,created_at DESC,id);
CREATE INDEX secret_reviews_expiry ON secret_reviews(input_expires_at,workspace_id,id);

CREATE TRIGGER push_secret_reviews_insert AFTER INSERT ON secret_reviews
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TRIGGER push_secret_reviews_update AFTER UPDATE ON secret_reviews
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TABLE secret_payloads (
  workspace_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  destination_index INTEGER NOT NULL CHECK (destination_index >= 0),
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (workspace_id,review_id,destination_index),
  FOREIGN KEY (workspace_id,review_id) REFERENCES secret_reviews(workspace_id,id) ON DELETE CASCADE
) STRICT;

CREATE TABLE secret_review_repositories (
  workspace_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id,review_id,repository_id),
  FOREIGN KEY (workspace_id,review_id) REFERENCES secret_reviews(workspace_id,id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER push_secret_payloads_delete AFTER DELETE ON secret_payloads
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
