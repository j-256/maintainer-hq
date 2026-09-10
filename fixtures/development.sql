INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES ('development', 'Development', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR IGNORE INTO members (workspace_id, subject, display_name, role) VALUES ('development', 'development-owner', 'Local maintainer', 'owner');
INSERT OR IGNORE INTO projects (id, workspace_id, name, description, updated_at, write_id) VALUES ('development-default', 'development', 'Development', 'Default project for local development', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'development-seed');
