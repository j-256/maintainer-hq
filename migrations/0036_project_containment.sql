CREATE TABLE project_containment_migration_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;

INSERT INTO project_containment_migration_guard(valid)
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM repositories WHERE project_id IS NULL)
  OR EXISTS (SELECT 1 FROM hook_associations WHERE project_id IS NULL)
  OR EXISTS (SELECT 1 FROM monitor_project_associations WHERE project_id IS NULL)
  OR EXISTS (SELECT 1 FROM secret_project_associations WHERE project_id IS NULL)
THEN 0 ELSE 1 END;

DROP TABLE project_containment_migration_guard;

ALTER TABLE metadata_imports ADD COLUMN project_count INTEGER NOT NULL DEFAULT 0 CHECK (project_count >= 0);

CREATE TRIGGER repositories_project_required_insert BEFORE INSERT ON repositories
WHEN NEW.project_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'Repository project is required');
END;

CREATE TRIGGER repositories_project_required_update BEFORE UPDATE OF project_id ON repositories
WHEN NEW.project_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'Repository project is required');
END;

CREATE TRIGGER hook_project_required_insert BEFORE INSERT ON hook_associations
WHEN NEW.project_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'Hook primary project is required');
END;

CREATE TRIGGER hook_project_required_update BEFORE UPDATE OF project_id ON hook_associations
WHEN NEW.project_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'Hook primary project is required');
END;

CREATE TRIGGER monitor_project_required_insert BEFORE INSERT ON monitor_project_associations
WHEN NEW.project_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'Monitor primary project is required');
END;

CREATE TRIGGER monitor_project_required_update BEFORE UPDATE OF project_id ON monitor_project_associations
WHEN NEW.project_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'Monitor primary project is required');
END;

CREATE TRIGGER secret_project_required_insert BEFORE INSERT ON secret_project_associations
WHEN NEW.project_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'Secret resource primary project is required');
END;

CREATE TRIGGER secret_project_required_update BEFORE UPDATE OF project_id ON secret_project_associations
WHEN NEW.project_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'Secret resource primary project is required');
END;
