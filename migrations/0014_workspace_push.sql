CREATE TABLE workspace_push_outbox (
  workspace_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  pending_topics INTEGER NOT NULL CHECK (pending_topics BETWEEN 0 AND 255)
) STRICT;
CREATE INDEX workspace_push_pending ON workspace_push_outbox(workspace_id) WHERE pending_topics <> 0;

CREATE TRIGGER push_projects_insert AFTER INSERT ON projects
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_projects_update AFTER UPDATE ON projects
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_projects_delete AFTER DELETE ON projects
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_repositories_insert AFTER INSERT ON repositories
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,65)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|65;
END;

CREATE TRIGGER push_repositories_update AFTER UPDATE ON repositories
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,65)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|65;
END;

CREATE TRIGGER push_repositories_delete AFTER DELETE ON repositories
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,65)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|65;
END;

CREATE TRIGGER push_connections_insert AFTER INSERT ON connections
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,29)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|29;
END;

CREATE TRIGGER push_connections_update AFTER UPDATE ON connections
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,29)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|29;
END;

CREATE TRIGGER push_connections_delete AFTER DELETE ON connections
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,29)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|29;
END;

CREATE TRIGGER push_observations_insert AFTER INSERT ON observations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_observations_update AFTER UPDATE ON observations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_observations_delete AFTER DELETE ON observations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_activity_insert AFTER INSERT ON activity
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_activity_update AFTER UPDATE ON activity
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_activity_delete AFTER DELETE ON activity
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_goals_insert AFTER INSERT ON goals
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_goals_update AFTER UPDATE ON goals
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_goals_delete AFTER DELETE ON goals
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_credentials_insert AFTER INSERT ON credentials
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,36)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|36;
END;

CREATE TRIGGER push_credentials_update AFTER UPDATE ON credentials
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,36)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|36;
END;

CREATE TRIGGER push_credentials_delete AFTER DELETE ON credentials
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,36)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|36;
END;

CREATE TRIGGER push_source_repositories_insert AFTER INSERT ON source_repositories
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,5)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|5;
END;

CREATE TRIGGER push_source_repositories_update AFTER UPDATE ON source_repositories
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,5)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|5;
END;

CREATE TRIGGER push_source_repositories_delete AFTER DELETE ON source_repositories
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,5)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|5;
END;

CREATE TRIGGER push_publisher_reports_insert AFTER INSERT ON publisher_reports
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,4)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|4;
END;

CREATE TRIGGER push_publisher_reports_update AFTER UPDATE ON publisher_reports
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,4)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|4;
END;

CREATE TRIGGER push_publisher_reports_delete AFTER DELETE ON publisher_reports
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,4)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|4;
END;

CREATE TRIGGER push_github_refreshes_insert AFTER INSERT ON github_refreshes
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,5)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|5;
END;

CREATE TRIGGER push_github_refreshes_update AFTER UPDATE ON github_refreshes
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,5)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|5;
END;

CREATE TRIGGER push_github_refreshes_delete AFTER DELETE ON github_refreshes
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,5)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|5;
END;

CREATE TRIGGER push_github_refresh_items_insert AFTER INSERT ON github_refresh_items
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,4)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|4;
END;

CREATE TRIGGER push_github_refresh_items_update AFTER UPDATE ON github_refresh_items
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,4)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|4;
END;

CREATE TRIGGER push_github_refresh_items_delete AFTER DELETE ON github_refresh_items
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,4)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|4;
END;

CREATE TRIGGER push_members_insert AFTER INSERT ON members
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,32)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|32;
END;

CREATE TRIGGER push_members_update AFTER UPDATE ON members
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,32)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|32;
END;

CREATE TRIGGER push_members_delete AFTER DELETE ON members
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,32)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|32;
END;

CREATE TRIGGER push_invitations_insert AFTER INSERT ON invitations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,32)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|32;
END;

CREATE TRIGGER push_invitations_update AFTER UPDATE ON invitations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,32)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|32;
END;

CREATE TRIGGER push_invitations_delete AFTER DELETE ON invitations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,32)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|32;
END;

CREATE TRIGGER push_repository_resource_associations_insert AFTER INSERT ON repository_resource_associations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,64)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|64;
END;

CREATE TRIGGER push_repository_resource_associations_update AFTER UPDATE ON repository_resource_associations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,64)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|64;
END;

CREATE TRIGGER push_repository_resource_associations_delete AFTER DELETE ON repository_resource_associations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,64)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|64;
END;

CREATE TRIGGER push_repository_resource_links_insert AFTER INSERT ON repository_resource_links
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,64)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|64;
END;

CREATE TRIGGER push_repository_resource_links_update AFTER UPDATE ON repository_resource_links
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,64)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|64;
END;

CREATE TRIGGER push_repository_resource_links_delete AFTER DELETE ON repository_resource_links
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,64)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|64;
END;

CREATE TRIGGER push_activity_repository_links_insert AFTER INSERT ON activity_repository_links
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_activity_repository_links_update AFTER UPDATE ON activity_repository_links
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_activity_repository_links_delete AFTER DELETE ON activity_repository_links
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,2)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|2;
END;

CREATE TRIGGER push_action_plans_insert AFTER INSERT ON action_plans
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TRIGGER push_action_plans_update AFTER UPDATE ON action_plans
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TRIGGER push_action_plans_delete AFTER DELETE ON action_plans
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TRIGGER push_operations_insert AFTER INSERT ON operations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TRIGGER push_operations_update AFTER UPDATE ON operations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TRIGGER push_operations_delete AFTER DELETE ON operations
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TRIGGER push_metadata_imports_insert AFTER INSERT ON metadata_imports
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_metadata_imports_update AFTER UPDATE ON metadata_imports
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_metadata_imports_delete AFTER DELETE ON metadata_imports
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;

CREATE TRIGGER push_workspaces_insert AFTER INSERT ON workspaces
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.id,1,33)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|33;
END;

CREATE TRIGGER push_workspaces_update AFTER UPDATE ON workspaces
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (NEW.id,1,33)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|33;
END;

CREATE TRIGGER push_workspaces_delete AFTER DELETE ON workspaces
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.id,1,33)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|33;
END;

CREATE TRIGGER push_hook_reviews_insert AFTER INSERT ON hook_reviews
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES ((SELECT workspace_id FROM action_plans WHERE id=NEW.plan_id),1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TRIGGER push_hook_reviews_update AFTER UPDATE ON hook_reviews
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES ((SELECT workspace_id FROM action_plans WHERE id=NEW.plan_id),1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TRIGGER push_monitoring_reviews_insert AFTER INSERT ON monitoring_reviews
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES ((SELECT workspace_id FROM action_plans WHERE id=NEW.plan_id),1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TRIGGER push_monitoring_reviews_update AFTER UPDATE ON monitoring_reviews
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES ((SELECT workspace_id FROM action_plans WHERE id=NEW.plan_id),1,128)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|128;
END;

CREATE TRIGGER push_preferences_insert AFTER INSERT ON user_preferences
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics)
  SELECT workspace_id,1,32 FROM members WHERE subject=NEW.subject
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|32;
END;

CREATE TRIGGER push_preferences_update AFTER UPDATE ON user_preferences
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics)
  SELECT workspace_id,1,32 FROM members WHERE subject=NEW.subject
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|32;
END;

CREATE TRIGGER push_preferences_delete AFTER DELETE ON user_preferences
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics)
  SELECT workspace_id,1,32 FROM members WHERE subject=OLD.subject
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|32;
END;
