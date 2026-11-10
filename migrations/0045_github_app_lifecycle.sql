ALTER TABLE github_app_authority ADD COLUMN invalidated_at TEXT;
ALTER TABLE github_app_authority ADD COLUMN reconcile_after TEXT;

CREATE TABLE github_app_deliveries (
  app_id INTEGER NOT NULL,
  delivery_id TEXT NOT NULL,
  registration_id TEXT NOT NULL REFERENCES github_app_registrations(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  action TEXT NOT NULL,
  installation_id INTEGER,
  body_digest TEXT NOT NULL,
  received_at TEXT NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY(app_id,delivery_id)
) STRICT;
CREATE INDEX github_app_deliveries_retention ON github_app_deliveries(received_at);

CREATE VIEW github_app_sources AS
  SELECT c.workspace_id,c.id AS source_id,g.id AS grant_id,g.registration_id,g.installation_id
  FROM connections c JOIN github_app_credential_references ref ON ref.workspace_id=c.workspace_id AND ref.reference_id=c.credential_ref
  JOIN github_app_grants g ON g.id=ref.grant_id WHERE c.provider='github';

CREATE TRIGGER expire_github_app_authority AFTER UPDATE ON github_app_authority
WHEN NEW.generation<>OLD.generation
BEGIN
  UPDATE observations SET expires_at=min(expires_at,COALESCE(NEW.invalidated_at,NEW.observed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id);
  UPDATE github_work_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id);
  UPDATE github_release_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id);
  UPDATE github_dependency_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id);
  UPDATE github_dependabot_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id);
  UPDATE github_discovery_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id);
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics)
    SELECT DISTINCT workspace_id,1,5 FROM github_app_sources WHERE registration_id=NEW.registration_id AND installation_id=NEW.installation_id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|5;
END;

CREATE TRIGGER expire_github_app_grant AFTER UPDATE OF revision,state ON github_app_grants
WHEN NEW.revision<>OLD.revision OR NEW.state<>OLD.state
BEGIN
  UPDATE observations SET expires_at=min(expires_at,COALESCE(json_extract(NEW.metadata_json,'$.acceptedAt'),strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE grant_id=NEW.id);
  UPDATE github_work_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE grant_id=NEW.id);
  UPDATE github_release_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE grant_id=NEW.id);
  UPDATE github_dependency_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE grant_id=NEW.id);
  UPDATE github_dependabot_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE grant_id=NEW.id);
  UPDATE github_discovery_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE grant_id=NEW.id);
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics)
    SELECT DISTINCT workspace_id,1,5 FROM github_app_sources WHERE grant_id=NEW.id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|5;
END;

CREATE TRIGGER expire_github_app_registration AFTER UPDATE OF revision,key_revision ON github_app_registrations
WHEN NEW.revision<>OLD.revision OR NEW.key_revision<>OLD.key_revision
BEGIN
  UPDATE observations SET expires_at=min(expires_at,NEW.updated_at)
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.id);
  UPDATE github_work_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.id);
  UPDATE github_release_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.id);
  UPDATE github_dependency_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.id);
  UPDATE github_dependabot_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.id);
  UPDATE github_discovery_cache SET result_json=NULL,lease_id=NULL,lease_until=NULL
    WHERE (workspace_id,source_id) IN (SELECT workspace_id,source_id FROM github_app_sources WHERE registration_id=NEW.id);
  INSERT INTO workspace_push_outbox(workspace_id,revision,pending_topics)
    SELECT DISTINCT workspace_id,1,5 FROM github_app_sources WHERE registration_id=NEW.id
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|5;
END;

CREATE TRIGGER cap_github_app_observation_insert AFTER INSERT ON observations
WHEN EXISTS(SELECT 1 FROM github_app_sources s JOIN github_app_grants g ON g.id=s.grant_id
  WHERE s.workspace_id=NEW.workspace_id AND s.source_id=NEW.source_id AND g.expires_at IS NOT NULL AND g.expires_at<NEW.expires_at)
BEGIN
  UPDATE observations SET expires_at=(SELECT min(NEW.expires_at,g.expires_at) FROM github_app_sources s JOIN github_app_grants g ON g.id=s.grant_id
    WHERE s.workspace_id=NEW.workspace_id AND s.source_id=NEW.source_id)
    WHERE workspace_id=NEW.workspace_id AND source_id=NEW.source_id AND resource_type=NEW.resource_type AND resource_id=NEW.resource_id;
END;

CREATE TRIGGER cap_github_app_observation_update AFTER UPDATE OF expires_at ON observations
WHEN EXISTS(SELECT 1 FROM github_app_sources s JOIN github_app_grants g ON g.id=s.grant_id
  WHERE s.workspace_id=NEW.workspace_id AND s.source_id=NEW.source_id AND g.expires_at IS NOT NULL AND g.expires_at<NEW.expires_at)
BEGIN
  UPDATE observations SET expires_at=(SELECT min(NEW.expires_at,g.expires_at) FROM github_app_sources s JOIN github_app_grants g ON g.id=s.grant_id
    WHERE s.workspace_id=NEW.workspace_id AND s.source_id=NEW.source_id)
    WHERE workspace_id=NEW.workspace_id AND source_id=NEW.source_id AND resource_type=NEW.resource_type AND resource_id=NEW.resource_id;
END;

