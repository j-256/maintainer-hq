// Isolated Node subprocess transport fixture, never a deployed Access policy
import assert from "node:assert/strict";

globalThis.fetch = async (url, init) => {
  const name = String(url).replace(
    "https://workspace.example/api/commands/",
    "",
  );
  assert.ok(
    [
      "goal_sync",
      "repository_coverage",
      "repository_coverage_get",
      "workspace_attention",
      "attention_connection",
      "expectations_plan",
      "expectations_review",
      "expectations_apply",
      "projects_organize_plan",
      "projects_organize_review",
      "projects_organize_apply",
    ].includes(name),
  );
  assert.equal(init.redirect, "error");
  const headers = new Headers(init.headers);
  if (
    headers.get("CF-Access-Client-Id") !== "synthetic-client" ||
    headers.get("CF-Access-Client-Secret") !== "synthetic-service-secret"
  )
    return new Response("<html>synthetic-private-proxy-body</html>", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    });
  if (headers.get("Authorization") !== "Bearer synthetic-workspace-token")
    return Response.json(
      { error: { message: "Workspace credential denied" } },
      { status: 401 },
    );
  assert.equal(headers.get("Cookie"), null);
  assert.equal(headers.get("Cf-Access-Jwt-Assertion"), null);
  const body = JSON.parse(init.body);
  if (name !== "goal_sync")
    return Response.json({ name, input: body, transportVerified: true });
  return Response.json({
    objective: body.objective,
    status: body.status,
    transportVerified: true,
  });
};
