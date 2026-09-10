CREATE TABLE hook_reviews (
  plan_id TEXT PRIMARY KEY REFERENCES action_plans(id) ON DELETE CASCADE,
  provider_review_json TEXT CHECK (provider_review_json IS NULL OR json_valid(provider_review_json))
) STRICT;

CREATE TABLE hook_associations (
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  subscription TEXT NOT NULL,
  project_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  write_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, connection_id, subscription),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
) STRICT;

CREATE INDEX hook_review_scope ON action_plans(workspace_id, actor_subject, kind, expires_at)
  WHERE applied_at IS NULL;
CREATE INDEX hook_operation_history ON operations(workspace_id, kind, created_at DESC, id DESC);
