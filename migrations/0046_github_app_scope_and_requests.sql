ALTER TABLE github_app_authority ADD COLUMN last_reconcile_attempt_at TEXT;

CREATE VIEW github_app_source_repositories AS
  SELECT s.workspace_id,s.source_id,r.id AS repository_id,json_extract(repo.value,'$.id') AS provider_repository_id,s.registration_id,s.installation_id
  FROM github_app_sources s JOIN github_app_grants g ON g.id=s.grant_id JOIN json_each(g.metadata_json,'$.repositories') repo
  JOIN source_repositories sr ON sr.workspace_id=s.workspace_id AND sr.source_id=s.source_id
  JOIN repositories r ON r.workspace_id=sr.workspace_id AND r.id=sr.repository_id AND lower(r.full_name)=lower(json_extract(repo.value,'$.fullName'));

DROP TRIGGER expire_github_app_authority;
CREATE TRIGGER expire_github_app_authority AFTER UPDATE ON github_app_authority
WHEN NEW.generation<>OLD.generation AND NOT(OLD.state='unknown' AND OLD.observed_at IS NULL AND OLD.invalidated_at IS NULL AND NEW.state='allowed')
BEGIN
  UPDATE observations SET expires_at=min(expires_at,COALESCE(NEW.invalidated_at,NEW.observed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    WHERE resource_type='repository' AND (workspace_id,source_id,resource_id) IN (SELECT workspace_id,source_id,repository_id FROM github_app_source_repositories WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id AND provider_repository_id=NEW.repository_id);
  UPDATE github_work_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id,repository_id) IN (SELECT workspace_id,source_id,repository_id FROM github_app_source_repositories WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id AND provider_repository_id=NEW.repository_id);
  UPDATE github_release_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id,repository_id) IN (SELECT workspace_id,source_id,repository_id FROM github_app_source_repositories WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id AND provider_repository_id=NEW.repository_id);
  UPDATE github_dependency_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id,repository_id) IN (SELECT workspace_id,source_id,repository_id FROM github_app_source_repositories WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id AND provider_repository_id=NEW.repository_id);
  UPDATE github_dependabot_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id,repository_id) IN (SELECT workspace_id,source_id,repository_id FROM github_app_source_repositories WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id AND provider_repository_id=NEW.repository_id);
  UPDATE github_discovery_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id);
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics)
    SELECT DISTINCT workspace_id,1,5 FROM github_app_sources WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|5;
END;


ALTER TABLE github_app_connection_requests ADD COLUMN state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','resolved','cancelled'));
ALTER TABLE github_app_connection_requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE github_app_connection_requests ADD COLUMN expires_at TEXT;
ALTER TABLE github_app_connection_requests ADD COLUMN closed_at TEXT;
ALTER TABLE github_app_connection_requests ADD COLUMN closed_by TEXT;
ALTER TABLE github_app_connection_requests ADD COLUMN grant_id TEXT;
UPDATE github_app_connection_requests SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+7 days');
CREATE INDEX github_app_requests_queue ON github_app_connection_requests(state,created_at,id,workspace_id);
CREATE TRIGGER push_github_app_request_update AFTER UPDATE ON github_app_connection_requests
BEGIN
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics) VALUES(NEW.workspace_id,1,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|1;
END;
