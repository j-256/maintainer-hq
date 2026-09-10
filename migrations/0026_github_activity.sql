-- References survive receipt retention without changing historical events
ALTER TABLE activity ADD COLUMN github_source_id TEXT;
ALTER TABLE activity ADD COLUMN github_refresh_id TEXT;
ALTER TABLE activity ADD COLUMN github_source_name TEXT;

-- NULL means change comparison was not recorded, not that nothing changed
ALTER TABLE github_refresh_items ADD COLUMN changes_json TEXT
  CHECK (changes_json IS NULL OR (json_valid(changes_json) AND json_type(changes_json) = 'array'));
