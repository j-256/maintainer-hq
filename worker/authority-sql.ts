const INLINE_GUARD_VALUES = 32;
type SqlGuard = { sql: string; values: unknown[] };

// Group fixed server-owned predicates while leaving room for a caller's own D1 parameters
export function combineSqlGuards(guards: SqlGuard[]): SqlGuard {
  if (!guards.length) return { sql: "1", values: [] };
  if (
    guards.reduce((total, guard) => total + guard.values.length, 0) <=
    INLINE_GUARD_VALUES
  )
    return {
      sql: guards.map((guard) => `(${guard.sql})`).join(" AND "),
      values: guards.flatMap((guard) => guard.values),
    };
  const groups = new Map<string, unknown[][]>();
  for (const guard of guards) {
    if (
      guard.values.some(
        (value) =>
          value !== null &&
          typeof value !== "string" &&
          (typeof value !== "number" || !Number.isFinite(value)),
      )
    )
      throw new Error("Authority predicates require scalar D1 arguments");
    const rows = groups.get(guard.sql) ?? [];
    rows.push(guard.values);
    groups.set(guard.sql, rows);
  }
  const sql: string[] = [];
  const values: unknown[] = [];
  for (const [predicate, rows] of groups) {
    let alias = "hq_authority_arguments";
    while (predicate.includes(alias)) alias += "_outer";
    let index = 0;
    const selected = predicate.replace(
      /\?/g,
      () => `json_extract(${alias}.value,'$[${index++}]')`,
    );
    if (rows.some((row) => row.length !== index))
      throw new Error("Authority predicate argument mismatch");
    sql.push(
      `NOT EXISTS(SELECT 1 FROM json_each(?) ${alias} WHERE COALESCE((${selected}),0)=0)`,
    );
    values.push(JSON.stringify(rows));
  }
  return { sql: sql.join(" AND "), values };
}
