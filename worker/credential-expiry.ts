const PERMANENT_READER_SQL = `c.expires_at IS NULL
  AND c.automation_profile = 'reader'
  AND c.source_id IS NULL AND c.reporter_id IS NULL
  AND json_type(c.scopes_json) = 'array'
  AND json_array_length(c.scopes_json) = 1
  AND json_extract(c.scopes_json, '$[0]') = 'read'`;

export function credentialIsCurrentSql(nowSql: string, checkWallClock = false) {
  return `((${PERMANENT_READER_SQL}) OR (
    julianday(c.expires_at) > julianday(${nowSql})
    ${checkWallClock ? "AND julianday(c.expires_at) > julianday('now')" : ""}
  ))`;
}
