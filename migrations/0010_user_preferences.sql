CREATE TABLE user_preferences (
  subject TEXT PRIMARY KEY,
  preferences_json TEXT NOT NULL CHECK (json_valid(preferences_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
);
