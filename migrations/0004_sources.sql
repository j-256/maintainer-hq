ALTER TABLE connections ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE connections ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
ALTER TABLE connections ADD COLUMN freshness_minutes INTEGER NOT NULL DEFAULT 15 CHECK (freshness_minutes BETWEEN 5 AND 1440);
ALTER TABLE connections ADD COLUMN write_id TEXT;
ALTER TABLE credentials ADD COLUMN write_id TEXT;

CREATE TABLE source_repositories (
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, source_id, repository_id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, repository_id) REFERENCES repositories(workspace_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE publisher_reports (
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, source_id, report_id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX publisher_report_receipt ON publisher_reports (workspace_id, source_id, received_at);
