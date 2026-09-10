CREATE TABLE secret_operations (
  workspace_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  lease_id TEXT,
  lease_expires_at TEXT,
  PRIMARY KEY (workspace_id,review_id),
  FOREIGN KEY (workspace_id,review_id) REFERENCES secret_reviews(workspace_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX secret_operations_leases ON secret_operations(workspace_id,lease_expires_at);

CREATE TABLE secret_receipts (
  workspace_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  destination_index INTEGER NOT NULL CHECK (destination_index >= 0),
  phase TEXT NOT NULL CHECK (phase IN ('pending','preparing','submitted','finished')),
  write_status TEXT NOT NULL CHECK (write_status IN ('not-sent','accepted','rejected','indeterminate')),
  reason TEXT,
  observation_status TEXT NOT NULL CHECK (observation_status IN ('unknown','present','absent','unavailable')),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  observed_at TEXT,
  submitted_at TEXT,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  write_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id,review_id,destination_index),
  FOREIGN KEY (workspace_id,review_id) REFERENCES secret_operations(workspace_id,review_id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER push_secret_operations_insert AFTER INSERT ON secret_operations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
CREATE TRIGGER push_secret_operations_update AFTER UPDATE ON secret_operations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
CREATE TRIGGER push_secret_receipts_insert AFTER INSERT ON secret_receipts
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
CREATE TRIGGER push_secret_receipts_update AFTER UPDATE ON secret_receipts
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
