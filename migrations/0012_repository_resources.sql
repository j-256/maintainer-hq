CREATE TABLE repository_resource_associations (
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hook', 'monitor')),
  connection_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  write_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind, connection_id, resource_key),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE repository_resource_links (
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind, connection_id, resource_key, repository_id),
  FOREIGN KEY (workspace_id, kind, connection_id, resource_key)
    REFERENCES repository_resource_associations(workspace_id, kind, connection_id, resource_key) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX repository_resources_page ON repository_resource_links
  (workspace_id, repository_id, kind, connection_id, resource_key);

CREATE UNIQUE INDEX activity_workspace_identity ON activity (workspace_id, id);
CREATE TABLE activity_repository_links (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, event_id, repository_id),
  FOREIGN KEY (workspace_id, event_id) REFERENCES activity(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX activity_repository_events ON activity_repository_links (workspace_id, repository_id, event_id);
