ALTER TABLE members ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE members ADD COLUMN write_id TEXT;

CREATE TABLE member_generations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  next_revision INTEGER NOT NULL CHECK (next_revision > 1),
  PRIMARY KEY (workspace_id, subject)
) STRICT;

CREATE TABLE installation_setup (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  setup_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  write_id TEXT NOT NULL
) STRICT;

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  inviter_subject TEXT NOT NULL,
  inviter_token_id TEXT,
  duration_days INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'revoked', 'expired')),
  accepted_subject TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  write_id TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX invitations_pending_email ON invitations (workspace_id, email) WHERE state = 'pending';
CREATE INDEX invitations_recipient ON invitations (email, state, expires_at);
CREATE INDEX invitations_workspace ON invitations (workspace_id, created_at DESC);
