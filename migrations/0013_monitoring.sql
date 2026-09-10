CREATE TABLE monitoring_reviews (
  plan_id TEXT PRIMARY KEY REFERENCES action_plans(id) ON DELETE CASCADE,
  provider_review_json TEXT CHECK (provider_review_json IS NULL OR json_valid(provider_review_json))
) STRICT;
