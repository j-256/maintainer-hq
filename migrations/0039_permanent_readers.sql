-- Preserve credentials and their dependent notifications while allowing Reader-only null expiry

DROP TRIGGER push_credentials_delete;

DROP TRIGGER push_credentials_insert;

DROP TRIGGER push_credentials_update;

DROP TRIGGER sync_credentials_delete;

DROP TRIGGER sync_credentials_insert;

DROP TRIGGER sync_credentials_update;

DROP TRIGGER sync_members_delete;

DROP TRIGGER sync_members_insert;

DROP TRIGGER sync_members_update;

DROP TRIGGER transfer_clock_credentials_delete;

DROP TRIGGER transfer_clock_credentials_insert;

DROP TRIGGER transfer_clock_credentials_update;

CREATE TABLE credentials_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_subject TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  source_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  write_id TEXT,
  automation_profile TEXT CHECK (automation_profile IN ('reader', 'reporter')),
  reporter_id TEXT,
  FOREIGN KEY (workspace_id, source_id) REFERENCES connections(workspace_id, id),
  CHECK (expires_at IS NOT NULL OR COALESCE(
    automation_profile = 'reader' AND source_id IS NULL AND reporter_id IS NULL
    AND json_type(scopes_json) = 'array' AND json_array_length(scopes_json) = 1
    AND json_extract(scopes_json, '$[0]') = 'read', 0))
) STRICT;

INSERT INTO credentials_next (
  id, workspace_id, owner_subject, name, token_hash, scopes_json, source_id,
  created_at, expires_at, revoked_at, write_id, automation_profile, reporter_id
)
SELECT id, workspace_id, owner_subject, name, token_hash, scopes_json, source_id,
  created_at, expires_at, revoked_at, write_id, automation_profile, reporter_id
FROM credentials;

DROP TABLE credentials;
ALTER TABLE credentials_next RENAME TO credentials;
CREATE INDEX credentials_automation_workspace ON credentials (workspace_id, automation_profile, created_at DESC);

CREATE TRIGGER push_credentials_delete AFTER DELETE ON credentials
BEGIN
  INSERT INTO workspace_push_outbox (workspace_id,revision,pending_topics) VALUES (OLD.workspace_id,1,36)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1,pending_topics=pending_topics|36;
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

CREATE TRIGGER sync_credentials_delete AFTER DELETE ON credentials
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT OLD.source_id AS record_key WHERE OLD.source_id IS NOT NULL) WHERE 1
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

CREATE TRIGGER sync_members_delete AFTER DELETE ON members
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (OLD.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT OLD.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=OLD.workspace_id) FROM (SELECT source_id AS record_key FROM credentials WHERE workspace_id=OLD.workspace_id AND owner_subject=OLD.subject AND source_id IS NOT NULL) WHERE 1
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

CREATE TRIGGER sync_members_update AFTER UPDATE ON members
BEGIN
  INSERT INTO workspace_sync_clock (workspace_id,cursor) VALUES (NEW.workspace_id,1)
    ON CONFLICT(workspace_id) DO UPDATE SET cursor=cursor+1;
  INSERT INTO workspace_changes (workspace_id,collection,record_key,cursor)
    SELECT NEW.workspace_id,'connections',record_key,(SELECT cursor FROM workspace_sync_clock WHERE workspace_id=NEW.workspace_id) FROM (SELECT source_id AS record_key FROM credentials WHERE workspace_id=NEW.workspace_id AND owner_subject=NEW.subject AND source_id IS NOT NULL) WHERE 1
    ON CONFLICT(workspace_id,collection,record_key) DO UPDATE SET cursor=excluded.cursor;
END;

CREATE TRIGGER transfer_clock_credentials_delete AFTER DELETE ON credentials
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
