CREATE TABLE github_app_authority (
  registration_id TEXT NOT NULL REFERENCES github_app_registrations(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  repository_id INTEGER NOT NULL CHECK (repository_id > 0),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('unknown','allowed','denied')),
  digest TEXT,
  registration_revision INTEGER,
  key_revision INTEGER,
  observation_json TEXT CHECK (observation_json IS NULL OR json_valid(observation_json)),
  observed_at TEXT,
  valid_until TEXT,
  write_id TEXT NOT NULL,
  PRIMARY KEY(registration_id,installation_id,repository_id)
) STRICT;
ALTER TABLE github_refreshes ADD COLUMN credential_kind TEXT NOT NULL DEFAULT 'token' CHECK (credential_kind IN ('token','app'));
ALTER TABLE github_refreshes ADD COLUMN quota_key TEXT;
ALTER TABLE github_refreshes ADD COLUMN actor_member_revision INTEGER CHECK (actor_member_revision IS NULL OR actor_member_revision>0);
ALTER TABLE github_refresh_items ADD COLUMN authority_json TEXT CHECK (authority_json IS NULL OR json_valid(authority_json));
