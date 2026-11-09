ALTER TABLE github_app_registrations ADD COLUMN grants_revision INTEGER NOT NULL DEFAULT 0 CHECK (grants_revision >= 0);

CREATE TABLE github_app_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  registration_id TEXT NOT NULL REFERENCES github_app_registrations(id),
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  expires_at TEXT,
  write_id TEXT NOT NULL
) STRICT;
CREATE INDEX github_app_grants_workspace ON github_app_grants(workspace_id,id);
CREATE INDEX github_app_grants_registration ON github_app_grants(registration_id,workspace_id,id);

CREATE TABLE github_app_grant_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issuing_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_subject TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  write_id TEXT
) STRICT;
CREATE INDEX github_app_grant_reviews_workspace ON github_app_grant_reviews(workspace_id,expires_at);

CREATE TABLE github_app_credential_references (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES github_app_grants(id),
  PRIMARY KEY(workspace_id,reference_id),
  UNIQUE(grant_id)
) STRICT;

CREATE TABLE github_app_connection_requests (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_subject TEXT NOT NULL,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
) STRICT;

CREATE TRIGGER push_github_app_grant_insert AFTER INSERT ON github_app_grants
BEGIN
  UPDATE github_app_registrations SET grants_revision=grants_revision+1 WHERE id=NEW.registration_id;
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;
CREATE TRIGGER push_github_app_grant_update AFTER UPDATE ON github_app_grants
BEGIN
  UPDATE github_app_registrations SET grants_revision=grants_revision+1 WHERE id IN (OLD.registration_id,NEW.registration_id);
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;
CREATE TRIGGER push_github_app_offer_insert AFTER INSERT ON github_app_grant_reviews
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;
