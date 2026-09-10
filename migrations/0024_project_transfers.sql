-- Stable identities keep historical attribution independent of workspace location
CREATE UNIQUE INDEX repositories_global_identity ON repositories(id);

CREATE TABLE departed_resource_context (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('project','repository')),
  resource_id TEXT NOT NULL,
  name TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  moved_at TEXT NOT NULL,
  transfer_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id,kind,resource_id)
) STRICT;

CREATE TABLE project_transfer_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  destination_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  actor_subject TEXT NOT NULL,
  actor_token_id TEXT,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT,
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  write_id TEXT,
  CHECK (workspace_id <> destination_workspace_id),
  CHECK ((applied_at IS NULL AND receipt_json IS NULL) OR (applied_at IS NOT NULL AND receipt_json IS NOT NULL))
) STRICT;
CREATE INDEX project_transfer_pending ON project_transfer_reviews(workspace_id,actor_subject,expires_at) WHERE applied_at IS NULL;
CREATE INDEX project_transfer_history ON project_transfer_reviews(workspace_id,project_id,created_at DESC,id);
CREATE INDEX project_transfer_destination ON project_transfer_reviews(destination_workspace_id,project_id,created_at DESC,id);

CREATE TABLE activity_repository_links_stable (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id,event_id,repository_id),
  FOREIGN KEY (workspace_id,event_id) REFERENCES activity(workspace_id,id) ON DELETE CASCADE
) STRICT;
INSERT INTO activity_repository_links_stable SELECT * FROM activity_repository_links;
DROP TABLE activity_repository_links;
ALTER TABLE activity_repository_links_stable RENAME TO activity_repository_links;
CREATE INDEX activity_repository_events ON activity_repository_links(workspace_id,repository_id,event_id);

CREATE TABLE github_refresh_items_stable (
  workspace_id TEXT NOT NULL,
  refresh_id TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until TEXT,
  observed_at TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  summary TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id,refresh_id,repository_id),
  FOREIGN KEY (workspace_id,refresh_id) REFERENCES github_refreshes(workspace_id,id) ON DELETE CASCADE
) STRICT;
INSERT INTO github_refresh_items_stable SELECT * FROM github_refresh_items;
DROP TABLE github_refresh_items;
ALTER TABLE github_refresh_items_stable RENAME TO github_refresh_items;
CREATE INDEX github_refresh_work ON github_refresh_items(status,updated_at,lease_until);

CREATE TRIGGER activity_repository_scope BEFORE INSERT ON activity_repository_links
WHEN NOT EXISTS (SELECT 1 FROM repositories WHERE workspace_id=NEW.workspace_id AND id=NEW.repository_id)
  AND NOT EXISTS (SELECT 1 FROM departed_resource_context WHERE workspace_id=NEW.workspace_id AND kind='repository' AND resource_id=NEW.repository_id)
BEGIN
  SELECT RAISE(ABORT,'Repository activity attribution must match current or historical workspace context');
END;

DROP TRIGGER activity_project_scope;
CREATE TRIGGER activity_project_scope BEFORE INSERT ON activity_project_links
WHEN NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id=NEW.workspace_id AND id=NEW.project_id)
  AND NOT EXISTS (SELECT 1 FROM departed_resource_context WHERE workspace_id=NEW.workspace_id AND kind='project' AND resource_id=NEW.project_id)
BEGIN
  SELECT RAISE(ABORT,'Project activity attribution must match current or historical workspace context');
END;

CREATE TRIGGER github_refresh_repository_scope BEFORE INSERT ON github_refresh_items
WHEN NOT EXISTS (SELECT 1 FROM repositories WHERE workspace_id=NEW.workspace_id AND id=NEW.repository_id)
BEGIN
  SELECT RAISE(ABORT,'New GitHub refresh items require current workspace enrollment');
END;

CREATE TRIGGER push_activity_repository_links_insert AFTER INSERT ON activity_repository_links
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_activity_repository_links_update AFTER UPDATE ON activity_repository_links
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_activity_repository_links_delete AFTER DELETE ON activity_repository_links
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(OLD.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_github_refresh_items_insert AFTER INSERT ON github_refresh_items
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,4)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|4;
END;

CREATE TRIGGER push_github_refresh_items_update AFTER UPDATE ON github_refresh_items
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,4)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|4;
END;

CREATE TRIGGER push_github_refresh_items_delete AFTER DELETE ON github_refresh_items
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(OLD.workspace_id,1,4)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|4;
END;

-- The ordinary update trigger publishes the destination record
CREATE TRIGGER sync_projects_workspace_move AFTER UPDATE OF workspace_id ON projects
WHEN OLD.workspace_id <> NEW.workspace_id
BEGIN
  INSERT INTO workspace_sync_clock(workspace_id,cursor) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes(workspace_id,collection,record_key,cursor)
    VALUES(OLD.workspace_id,'projects',OLD.id,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id))
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(OLD.workspace_id,1,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

-- The ordinary update trigger publishes the destination record
CREATE TRIGGER sync_repositories_workspace_move AFTER UPDATE OF workspace_id ON repositories
WHEN OLD.workspace_id <> NEW.workspace_id
BEGIN
  INSERT INTO workspace_sync_clock(workspace_id,cursor) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes(workspace_id,collection,record_key,cursor)
    VALUES(OLD.workspace_id,'repositories',OLD.id,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id))
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(OLD.workspace_id,1,65)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|65;
END;

-- Transfer reviews use structural revisions, not the observation or Activity clock
CREATE TABLE workspace_transfer_clock (
  workspace_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0)
) STRICT;
INSERT INTO workspace_transfer_clock SELECT id,1 FROM workspaces;

CREATE TRIGGER transfer_clock_workspaces_insert AFTER INSERT ON workspaces
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_workspaces_update AFTER UPDATE ON workspaces
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_workspaces_delete AFTER DELETE ON workspaces
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_members_insert AFTER INSERT ON members
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_members_update AFTER UPDATE ON members
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_members_delete AFTER DELETE ON members
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_invitations_insert AFTER INSERT ON invitations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_invitations_update AFTER UPDATE ON invitations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_invitations_delete AFTER DELETE ON invitations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_credentials_insert AFTER INSERT ON credentials
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_credentials_update AFTER UPDATE ON credentials
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_credentials_delete AFTER DELETE ON credentials
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_projects_insert AFTER INSERT ON projects
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_projects_update AFTER UPDATE ON projects
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_projects_delete AFTER DELETE ON projects
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_repositories_insert AFTER INSERT ON repositories
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_repositories_update AFTER UPDATE ON repositories
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_repositories_delete AFTER DELETE ON repositories
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_connections_insert AFTER INSERT ON connections
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_connections_update AFTER UPDATE OF name,provider,configuration_json,credential_ref,revision,enabled,freshness_minutes ON connections
WHEN OLD.name IS NOT NEW.name OR OLD.provider IS NOT NEW.provider OR OLD.configuration_json IS NOT NEW.configuration_json OR OLD.credential_ref IS NOT NEW.credential_ref OR OLD.revision IS NOT NEW.revision OR OLD.enabled IS NOT NEW.enabled OR OLD.freshness_minutes IS NOT NEW.freshness_minutes
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_connections_delete AFTER DELETE ON connections
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_source_repositories_insert AFTER INSERT ON source_repositories
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_source_repositories_update AFTER UPDATE ON source_repositories
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_source_repositories_delete AFTER DELETE ON source_repositories
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_hook_associations_insert AFTER INSERT ON hook_associations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_hook_associations_update AFTER UPDATE ON hook_associations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_hook_associations_delete AFTER DELETE ON hook_associations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_monitor_project_associations_insert AFTER INSERT ON monitor_project_associations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_monitor_project_associations_update AFTER UPDATE ON monitor_project_associations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_monitor_project_associations_delete AFTER DELETE ON monitor_project_associations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_project_associations_insert AFTER INSERT ON secret_project_associations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_project_associations_update AFTER UPDATE ON secret_project_associations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_project_associations_delete AFTER DELETE ON secret_project_associations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_repository_resource_associations_insert AFTER INSERT ON repository_resource_associations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_repository_resource_associations_update AFTER UPDATE ON repository_resource_associations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_repository_resource_associations_delete AFTER DELETE ON repository_resource_associations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_repository_resource_links_insert AFTER INSERT ON repository_resource_links
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_repository_resource_links_update AFTER UPDATE ON repository_resource_links
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_repository_resource_links_delete AFTER DELETE ON repository_resource_links
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_connections_insert AFTER INSERT ON secret_connections
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_connections_update AFTER UPDATE ON secret_connections
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_connections_delete AFTER DELETE ON secret_connections
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_action_plans_insert AFTER INSERT ON action_plans
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_action_plans_update AFTER UPDATE ON action_plans
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_action_plans_delete AFTER DELETE ON action_plans
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_operations_insert AFTER INSERT ON operations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_operations_update AFTER UPDATE ON operations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_operations_delete AFTER DELETE ON operations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_github_refreshes_insert AFTER INSERT ON github_refreshes
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_github_refreshes_update AFTER UPDATE OF status ON github_refreshes
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_github_refreshes_delete AFTER DELETE ON github_refreshes
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_github_refresh_items_insert AFTER INSERT ON github_refresh_items
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_github_refresh_items_update AFTER UPDATE OF status ON github_refresh_items
WHEN OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_github_refresh_items_delete AFTER DELETE ON github_refresh_items
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_reviews_insert AFTER INSERT ON secret_reviews
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_reviews_update AFTER UPDATE ON secret_reviews
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_reviews_delete AFTER DELETE ON secret_reviews
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_review_repositories_insert AFTER INSERT ON secret_review_repositories
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_review_repositories_update AFTER UPDATE ON secret_review_repositories
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_review_repositories_delete AFTER DELETE ON secret_review_repositories
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_payloads_insert AFTER INSERT ON secret_payloads
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_payloads_update AFTER UPDATE ON secret_payloads
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_payloads_delete AFTER DELETE ON secret_payloads
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_operations_insert AFTER INSERT ON secret_operations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_operations_update AFTER UPDATE ON secret_operations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_operations_delete AFTER DELETE ON secret_operations
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_receipts_insert AFTER INSERT ON secret_receipts
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_receipts_update AFTER UPDATE ON secret_receipts
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_receipts_delete AFTER DELETE ON secret_receipts
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_cleanup_reviews_insert AFTER INSERT ON secret_cleanup_reviews
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_cleanup_reviews_update AFTER UPDATE ON secret_cleanup_reviews
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_cleanup_reviews_delete AFTER DELETE ON secret_cleanup_reviews
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_recovery_links_insert AFTER INSERT ON secret_recovery_links
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_recovery_links_update AFTER UPDATE ON secret_recovery_links
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
  INSERT INTO workspace_transfer_clock(workspace_id,revision) SELECT OLD.workspace_id,1 WHERE OLD.workspace_id<>NEW.workspace_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER transfer_clock_secret_recovery_links_delete AFTER DELETE ON secret_recovery_links
BEGIN
  INSERT INTO workspace_transfer_clock(workspace_id,revision) VALUES(OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
