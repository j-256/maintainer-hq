PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  PRIMARY KEY (workspace_id, subject)
) STRICT;

CREATE TABLE projects (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, name)
) STRICT;

CREATE TABLE repositories (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL,
  project_id TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('maintained', 'watchlist', 'reference')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived')),
  expectations_json TEXT NOT NULL CHECK (json_valid(expectations_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, full_name),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
) STRICT;

CREATE TABLE connections (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'hookrelay', 'endpoint-monitor', 'local')),
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(configuration_json)),
  credential_ref TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  PRIMARY KEY (workspace_id, id)
) STRICT;

CREATE TABLE observations (
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('repository', 'hook', 'monitor', 'publisher')),
  resource_id TEXT NOT NULL,
  name TEXT NOT NULL,
  health TEXT NOT NULL CHECK (health IN ('healthy', 'warning', 'critical', 'unknown')),
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, source_id, resource_type, resource_id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_subject TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  resource_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX activity_workspace_time ON activity (workspace_id, created_at DESC, id DESC);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  source_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (workspace_id, source_id) REFERENCES connections(workspace_id, id)
) STRICT;

CREATE TABLE action_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_subject TEXT NOT NULL,
  kind TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT
) STRICT;

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id TEXT UNIQUE REFERENCES action_plans(id),
  actor_subject TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'indeterminate')),
  summary TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
