CREATE UNIQUE INDEX projects_stable_identity ON projects (id);

ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE projects ADD COLUMN write_id TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','archived'));
ALTER TABLE projects ADD COLUMN importance TEXT NOT NULL DEFAULT 'standard' CHECK (importance IN ('standard','high','critical'));
ALTER TABLE projects ADD COLUMN importance_note TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN portfolio_json TEXT NOT NULL DEFAULT '{"status":"undecided","reason":"","url":null,"reviewDate":null}' CHECK (json_valid(portfolio_json));

UPDATE projects SET updated_at=COALESCE(
  (SELECT strftime('%Y-%m-%dT%H:%M:%fZ',MIN(a.created_at)) FROM activity a WHERE a.workspace_id=projects.workspace_id AND a.resource_id=projects.id AND a.type='project.created'),
  (SELECT strftime('%Y-%m-%dT%H:%M:%fZ',w.created_at) FROM workspaces w WHERE w.id=projects.workspace_id),
  '1970-01-01T00:00:00.000Z'
);
