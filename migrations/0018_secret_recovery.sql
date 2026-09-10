CREATE TABLE secret_recovery_links (
  workspace_id TEXT NOT NULL,
  parent_review_id TEXT NOT NULL,
  parent_destination_index INTEGER NOT NULL,
  child_review_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id,parent_review_id,parent_destination_index),
  UNIQUE (workspace_id,child_review_id),
  FOREIGN KEY (workspace_id,parent_review_id,parent_destination_index) REFERENCES secret_receipts(workspace_id,review_id,destination_index) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,child_review_id) REFERENCES secret_reviews(workspace_id,id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER push_secret_recovery_insert AFTER INSERT ON secret_recovery_links
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
CREATE TRIGGER push_secret_recovery_delete AFTER DELETE ON secret_recovery_links
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;
