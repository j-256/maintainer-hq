CREATE TABLE github_app_registrations (
  id TEXT PRIMARY KEY,
  administrative_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  key_revision INTEGER NOT NULL CHECK (key_revision > 0),
  webhook_revision INTEGER CHECK (webhook_revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  write_id TEXT NOT NULL
) STRICT;

CREATE INDEX github_app_registrations_workspace ON github_app_registrations(administrative_workspace_id,id);

CREATE TABLE github_app_material (
  registration_id TEXT NOT NULL REFERENCES github_app_registrations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('private-key','webhook-secret')),
  material_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(registration_id,kind,revision)
) STRICT;

CREATE TABLE github_app_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_subject TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  write_id TEXT
) STRICT;

CREATE INDEX github_app_reviews_pending ON github_app_reviews(workspace_id,actor_subject,expires_at) WHERE applied_at IS NULL;

CREATE TABLE github_app_setup_revocations (
  permit_id TEXT NOT NULL,
  permit_revision INTEGER NOT NULL CHECK (permit_revision > 0),
  administrative_workspace_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY(permit_id,permit_revision)
) STRICT;

CREATE TABLE github_app_manifest_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_subject TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  state_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','conversion_claimed','complete','indeterminate','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  registration_id TEXT REFERENCES github_app_registrations(id) ON DELETE SET NULL,
  error_code TEXT
) STRICT;

CREATE INDEX github_app_manifest_attempts_owner ON github_app_manifest_attempts(workspace_id,actor_subject,created_at);

CREATE TRIGGER push_github_app_registration_insert AFTER INSERT ON github_app_registrations
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.administrative_workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_github_app_registration_update AFTER UPDATE ON github_app_registrations
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.administrative_workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;
