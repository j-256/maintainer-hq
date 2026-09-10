// Compare inside the accepting batch, before the prior observation is replaced
const different = (path: string) =>
  `json_extract(prior.details_json, '$.${path}') IS NOT json_extract(incoming.value, '$.details.${path}')`;
function checksDifferent(keys: string[], fields: string[]) {
  return `EXISTS (SELECT 1 FROM json_each(incoming.value, '$.details.github.checks') next
    LEFT JOIN json_each(prior.details_json, '$.github.checks') old
      ON json_extract(old.value, '$.key') = json_extract(next.value, '$.key')
    WHERE ${keys.length ? "json_extract(next.value, '$.key') IN (" + keys.map((key) => "'" + key + "'").join(",") + ") AND " : ""}
      (${fields.map((field) => `json_extract(old.value, '$.${field}') IS NOT json_extract(next.value, '$.${field}')`).join(" OR ")}))`;
}
const CATEGORIES = {
  visibility: different("visibility"),
  head:
    different("github.defaultBranch") + " OR " + different("github.headSha"),
  ci:
    different("ci") +
    " OR " +
    checksDifferent(["checks", "statuses"], ["state", "count"]),
  security:
    different("openFindings") +
    " OR " +
    checksDifferent(
      ["dependabot", "codeScanning", "secretScanning"],
      ["state", "count"],
    ),
  coverage:
    checksDifferent([], ["state"]) +
    ` OR EXISTS (
    SELECT 1 FROM json_each(incoming.value, '$.details.github.checks') next
    LEFT JOIN json_each(prior.details_json, '$.github.checks') old
      ON json_extract(old.value, '$.key') = json_extract(next.value, '$.key')
    WHERE json_extract(next.value, '$.state') != 'observed'
      AND json_extract(old.value, '$.summary') IS NOT json_extract(next.value, '$.summary'))`,
  assessment:
    "prior.health IS NOT json_extract(incoming.value, '$.health') OR prior.summary IS NOT json_extract(incoming.value, '$.summary')",
};

export const GITHUB_CHANGE_SQL = `(SELECT CASE
  WHEN prior.resource_id IS NULL THEN '["first"]'
  WHEN prior.observed_at > json_extract(incoming.value, '$.observedAt') THEN '[]'
  ELSE (SELECT json_group_array(value) FROM json_each(json_array(
    ${Object.entries(CATEGORIES)
      .map(
        ([label, predicate]) =>
          "CASE WHEN " + predicate + " THEN '" + label + "' END",
      )
      .join(", ")}
  )) WHERE value IS NOT NULL) END
  FROM (SELECT json(?) AS value) incoming
  LEFT JOIN observations prior ON prior.workspace_id = i.workspace_id
    AND prior.source_id = json_extract(incoming.value, '$.sourceId')
    AND prior.resource_type = 'repository' AND prior.resource_id = i.repository_id)`;
