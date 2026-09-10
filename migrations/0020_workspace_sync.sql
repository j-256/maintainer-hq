-- A coalesced key journal, separate from notification revisions and private payloads
CREATE TABLE workspace_sync_clock (
  workspace_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL CHECK (cursor > 0)
) STRICT;
CREATE TABLE workspace_changes (
  workspace_id TEXT NOT NULL,
  collection TEXT NOT NULL CHECK (collection IN ('projects','repositories','observations','connections','goals')),
  record_key TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,collection,record_key)
) STRICT;
CREATE INDEX workspace_changes_cursor ON workspace_changes(workspace_id,cursor);
CREATE TABLE workspace_sync_retention (
  workspace_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  floor INTEGER NOT NULL,
  PRIMARY KEY (workspace_id,collection)
) STRICT;

CREATE TRIGGER sync_retention_insert AFTER INSERT ON workspace_changes
BEGIN
  INSERT INTO workspace_sync_retention (workspace_id,collection,floor)
    SELECT workspace_id,collection,MAX(cursor) FROM workspace_changes
    WHERE workspace_id=NEW.workspace_id AND cursor<=NEW.cursor-4096 GROUP BY collection
    ON CONFLICT(workspace_id,collection) DO UPDATE SET floor=MAX(floor,excluded.floor);
  DELETE FROM workspace_changes WHERE workspace_id=NEW.workspace_id AND cursor<=NEW.cursor-4096;
END;

CREATE TRIGGER sync_retention_update AFTER UPDATE ON workspace_changes
BEGIN
  INSERT INTO workspace_sync_retention (workspace_id,collection,floor)
    SELECT workspace_id,collection,MAX(cursor) FROM workspace_changes
    WHERE workspace_id=NEW.workspace_id AND cursor<=NEW.cursor-4096 GROUP BY collection
    ON CONFLICT(workspace_id,collection) DO UPDATE SET floor=MAX(floor,excluded.floor);
  DELETE FROM workspace_changes WHERE workspace_id=NEW.workspace_id AND cursor<=NEW.cursor-4096;
END;

CREATE TRIGGER sync_projects_insert AFTER INSERT ON projects
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'projects',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_projects_update AFTER UPDATE ON projects
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'projects',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_projects_delete AFTER DELETE ON projects
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'projects',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT OLD.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_repositories_insert AFTER INSERT ON repositories
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'repositories',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_repositories_update AFTER UPDATE ON repositories
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'repositories',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_repositories_delete AFTER DELETE ON repositories
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'repositories',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT OLD.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_observations_insert AFTER INSERT ON observations
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'observations',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT json_array(NEW.source_id,NEW.resource_type,NEW.resource_id) AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_observations_update AFTER UPDATE ON observations
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'observations',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT json_array(NEW.source_id,NEW.resource_type,NEW.resource_id) AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_observations_delete AFTER DELETE ON observations
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'observations',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT json_array(OLD.source_id,OLD.resource_type,OLD.resource_id) AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_connections_insert AFTER INSERT ON connections
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_connections_update AFTER UPDATE ON connections
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_connections_delete AFTER DELETE ON connections
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT OLD.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_goals_insert AFTER INSERT ON goals
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'goals',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_goals_update AFTER UPDATE ON goals
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'goals',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_goals_delete AFTER DELETE ON goals
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'goals',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT OLD.id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_source_repositories_insert AFTER INSERT ON source_repositories
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.source_id AS record_key WHERE NEW.source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'observations',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT json_array(source_id,resource_type,resource_id) AS record_key FROM observations WHERE workspace_id=NEW.workspace_id AND source_id=NEW.source_id AND resource_id=NEW.repository_id) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_github_refreshes_insert AFTER INSERT ON github_refreshes
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.source_id AS record_key WHERE NEW.source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_credentials_insert AFTER INSERT ON credentials
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.source_id AS record_key WHERE NEW.source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_members_insert AFTER INSERT ON members
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT source_id AS record_key FROM credentials WHERE workspace_id=NEW.workspace_id AND owner_subject=NEW.subject AND source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_source_repositories_update AFTER UPDATE ON source_repositories
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.source_id AS record_key WHERE NEW.source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'observations',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT json_array(source_id,resource_type,resource_id) AS record_key FROM observations WHERE workspace_id=NEW.workspace_id AND source_id=OLD.source_id AND resource_id=OLD.repository_id) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'observations',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT json_array(source_id,resource_type,resource_id) AS record_key FROM observations WHERE workspace_id=NEW.workspace_id AND source_id=NEW.source_id AND resource_id=NEW.repository_id) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT OLD.source_id AS record_key) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_github_refreshes_update AFTER UPDATE ON github_refreshes
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.source_id AS record_key WHERE NEW.source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_credentials_update AFTER UPDATE ON credentials
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT NEW.source_id AS record_key WHERE NEW.source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT OLD.source_id AS record_key WHERE OLD.source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_members_update AFTER UPDATE ON members
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT source_id AS record_key FROM credentials WHERE workspace_id=NEW.workspace_id AND owner_subject=NEW.subject AND source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_source_repositories_delete AFTER DELETE ON source_repositories
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT OLD.source_id AS record_key WHERE OLD.source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'observations',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT json_array(source_id,resource_type,resource_id) AS record_key FROM observations WHERE workspace_id=OLD.workspace_id AND source_id=OLD.source_id AND resource_id=OLD.repository_id) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_github_refreshes_delete AFTER DELETE ON github_refreshes
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT OLD.source_id AS record_key WHERE OLD.source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_credentials_delete AFTER DELETE ON credentials
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT OLD.source_id AS record_key WHERE OLD.source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_members_delete AFTER DELETE ON members
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT source_id AS record_key FROM credentials WHERE workspace_id=OLD.workspace_id AND owner_subject=OLD.subject AND source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER sync_connection_provider AFTER UPDATE OF provider ON connections
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'observations',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT json_array(source_id,resource_type,resource_id) AS record_key FROM observations WHERE workspace_id=NEW.workspace_id AND source_id=NEW.id) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

-- Credential cooldowns affect source projections without exposing their credential hashes
CREATE TRIGGER sync_cooldowns_insert AFTER INSERT ON github_cooldowns
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor)
    SELECT DISTINCT workspace_id,1 FROM github_refreshes WHERE credential_hash=NEW.credential_hash
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT DISTINCT j.workspace_id,'connections',j.source_id,c.cursor FROM github_refreshes j
    JOIN workspace_sync_clock c ON c.workspace_id=j.workspace_id WHERE j.credential_hash=NEW.credential_hash
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics)
    SELECT DISTINCT workspace_id,1,4 FROM github_refreshes WHERE credential_hash=NEW.credential_hash
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|4;
END;

CREATE TRIGGER sync_cooldowns_update AFTER UPDATE ON github_cooldowns
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor)
    SELECT DISTINCT workspace_id,1 FROM github_refreshes WHERE credential_hash=NEW.credential_hash
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT DISTINCT j.workspace_id,'connections',j.source_id,c.cursor FROM github_refreshes j
    JOIN workspace_sync_clock c ON c.workspace_id=j.workspace_id WHERE j.credential_hash=NEW.credential_hash
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics)
    SELECT DISTINCT workspace_id,1,4 FROM github_refreshes WHERE credential_hash=NEW.credential_hash
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|4;
END;

CREATE TRIGGER sync_cooldowns_delete AFTER DELETE ON github_cooldowns
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor)
    SELECT DISTINCT workspace_id,1 FROM github_refreshes WHERE credential_hash=OLD.credential_hash
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT DISTINCT j.workspace_id,'connections',j.source_id,c.cursor FROM github_refreshes j
    JOIN workspace_sync_clock c ON c.workspace_id=j.workspace_id WHERE j.credential_hash=OLD.credential_hash
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics)
    SELECT DISTINCT workspace_id,1,4 FROM github_refreshes WHERE credential_hash=OLD.credential_hash
    ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|4;
END;

CREATE TRIGGER sync_workspace_deleted AFTER DELETE ON workspaces
BEGIN
  DELETE FROM workspace_changes WHERE workspace_id=OLD.id;
  DELETE FROM workspace_sync_retention WHERE workspace_id=OLD.id;
  DELETE FROM workspace_sync_clock WHERE workspace_id=OLD.id;
END;

