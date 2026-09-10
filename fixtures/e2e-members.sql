INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('development','synthetic-member','Synthetic member','viewer');
INSERT INTO workspaces (id,name,created_at) VALUES ('expectations-test','Synthetic expectations workspace','2026-01-01T00:00:00.000Z');
INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('expectations-test','development-owner','Local maintainer','owner');
INSERT INTO workspaces (id,name,created_at) VALUES ('organization-test','Synthetic organization workspace','2026-01-01T00:00:00.000Z');
INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('organization-test','development-owner','Local maintainer','owner');
INSERT INTO workspaces (id,name,created_at) VALUES ('import-test','Synthetic import workspace','2026-01-01T00:00:00.000Z');
INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('import-test','development-owner','Local maintainer','owner');
INSERT INTO workspaces (id,name,created_at) VALUES ('activity-test','Synthetic journal workspace','2026-01-01T00:00:00.000Z');
INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('activity-test','development-owner','Local maintainer','owner');
INSERT INTO workspaces (id,name,created_at) VALUES ('polling-test','Synthetic polling workspace','2026-01-01T00:00:00.000Z');
INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('polling-test','development-owner','Local maintainer','owner');
INSERT INTO workspaces (id,name,created_at) VALUES ('inventory-test','Synthetic inventory workspace','2026-01-01T00:00:00.000Z');
INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('inventory-test','development-owner','Local maintainer','owner');
INSERT INTO workspaces (id,name,created_at) VALUES ('projects-test','Synthetic projects workspace','2026-01-01T00:00:00.000Z');
INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('projects-test','development-owner','Local maintainer','owner');
INSERT INTO workspaces (id,name,created_at) VALUES ('transfer-source','Transfer source','2026-01-01T00:00:00.000Z'),('transfer-destination','Transfer destination','2026-01-01T00:00:00.000Z'),('transfer-empty','Empty transfer workspace','2026-01-01T00:00:00.000Z');
INSERT INTO members (workspace_id,subject,display_name,role) VALUES ('transfer-source','development-owner','Local maintainer','owner'),('transfer-destination','development-owner','Local maintainer','owner'),('transfer-empty','development-owner','Local maintainer','owner'),('transfer-source','source-only','Source reader','viewer'),('transfer-destination','destination-only','Destination reader','viewer');
INSERT INTO projects (id,workspace_id,name,description,updated_at,write_id) VALUES
  ('expectations-default','expectations-test','Existing work','Synthetic project','2026-01-01T00:00:00.000Z','e2e-seed'),
  ('organization-default','organization-test','Existing work','Synthetic project','2026-01-01T00:00:00.000Z','e2e-seed'),
  ('activity-default','activity-test','Existing work','Synthetic project','2026-01-01T00:00:00.000Z','e2e-seed'),
  ('polling-default','polling-test','Existing work','Synthetic project','2026-01-01T00:00:00.000Z','e2e-seed'),
  ('inventory-default','inventory-test','Existing work','Synthetic project','2026-01-01T00:00:00.000Z','e2e-seed');
