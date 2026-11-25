const ERROR_CATEGORIES = Object.freeze([
  "FOREIGN KEY constraint failed", "UNIQUE constraint failed", "NOT NULL constraint failed",
  "no such table", "no such column", "database is locked", "SQLITE_ERROR", "SQLITE_CONSTRAINT",
  "SQLITE_BUSY", "SQLITE_AUTH", "SQLITE_TOOBIG", "SQLITE_FULL", "SQLITE_CORRUPT",
  "Authentication error", "insufficient permissions", "timed out",
]);
const DIAGNOSTIC_LIMIT = 8;

export function wranglerDiagnostics(output: string, knownMigrations: string[]) {
  const mentioned = new Set(output.match(/\b\d{4}_[a-z0-9_]+\.sql\b/g) ?? []);
  return {
    mentionedMigrations: knownMigrations.filter(name => mentioned.has(name)).slice(-DIAGNOSTIC_LIMIT),
    providerCodes: [...new Set([...output.matchAll(/\[code:\s*(\d{3,8})\]/g)].map(match => match[1]))].slice(0, DIAGNOSTIC_LIMIT),
    categories: ERROR_CATEGORIES.filter(category => output.toLowerCase().includes(category.toLowerCase())).slice(0, DIAGNOSTIC_LIMIT),
  };
}
