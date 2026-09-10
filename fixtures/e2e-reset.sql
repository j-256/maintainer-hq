-- Run only against the isolated browser-test database
DELETE FROM project_transfer_reviews WHERE workspace_id IN ('transfer-source','transfer-destination','transfer-empty') OR destination_workspace_id IN ('transfer-source','transfer-destination','transfer-empty');
DELETE FROM user_preferences WHERE subject = 'development-owner';
DELETE FROM workspaces WHERE id = 'development';
DELETE FROM workspaces WHERE id = 'expectations-test';
DELETE FROM workspaces WHERE id = 'organization-test';
DELETE FROM workspaces WHERE id = 'import-test';
DELETE FROM workspaces WHERE id = 'activity-test';
DELETE FROM workspaces WHERE id = 'polling-test';
DELETE FROM workspaces WHERE id = 'inventory-test';
DELETE FROM workspaces WHERE id = 'projects-test';
DELETE FROM workspaces WHERE id = 'transfer-source';
DELETE FROM workspaces WHERE id = 'transfer-destination';
DELETE FROM workspaces WHERE id = 'transfer-empty';
