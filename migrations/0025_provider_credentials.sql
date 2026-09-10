CREATE TABLE provider_credentials (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('github-actions','cloudflare-workers')),
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  identity TEXT NOT NULL,
  key_id TEXT,
  nonce TEXT,
  ciphertext TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  write_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id,id),
  CHECK ((retired_at IS NULL AND key_id IS NOT NULL AND nonce IS NOT NULL AND ciphertext IS NOT NULL)
    OR (retired_at IS NOT NULL AND key_id IS NULL AND nonce IS NULL AND ciphertext IS NULL))
) STRICT;

CREATE INDEX provider_credentials_history ON provider_credentials(workspace_id,retired_at,updated_at DESC,id DESC);
CREATE INDEX secret_reviews_credential_scope ON secret_reviews(workspace_id,expires_at);

CREATE TRIGGER push_provider_credentials_insert AFTER INSERT ON provider_credentials
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_provider_credentials_update AFTER UPDATE ON provider_credentials
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_provider_credentials_delete AFTER DELETE ON provider_credentials
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;
