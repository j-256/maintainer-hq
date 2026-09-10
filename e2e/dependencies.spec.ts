import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  CAPABILITY,
  DEFAULT_EXPECTATIONS,
  type Repository,
} from "../shared/domain";
import { analyzeDependencyPolicy } from "../shared/dependency-policy";
import {
  type DependencyResult,
  type DependenciesPage,
} from "../shared/dependencies";
import {
  changedDependencyRule,
  type DependencyChangeReview,
} from "../shared/dependency-changes";
import { dependencyFixture } from "../test/fixtures/dependencies";
import { mockWorkspaceView } from "./workspace-fixture";
import { verifyFlatContrast } from "./flat-contrast";
import type { DependencyOperation } from "../shared/dependency-operations";
import { mockProviderCredentials } from "./provider-credentials-fixture";

const WORKSPACE = "development";
const SHA = "a".repeat(40);
const DIGEST = "sha256:" + "b".repeat(64);
async function populated(
  page: Page,
  request: APIRequestContext,
  writable = false,
) {
  const response = await request.post("/api/commands/repository_create", {
    headers: { "X-HQ-Client": "cli" },
    data: {
      workspaceId: WORKSPACE,
      repository: {
        fullName: "example/dependency-" + crypto.randomUUID(),
        projectId: "development-default",
        description: "Synthetic dependency browser fixture",
        classification: "watchlist",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const repository: Repository = await response.json();
  const f = dependencyFixture();
  const now = Date.now();
  f.rule.reviewedAt = new Date(now - 86400000).toISOString();
  f.rule.reviewBy = new Date(now + 7 * 86400000).toISOString();
  const source = {
    id: "dependency-fixture",
    name: "Synthetic read-only source",
    provider: "github" as const,
    revision: 1,
    enabled: true,
    freshnessMinutes: 30,
    repositoryIds: [repository.id],
    credentialConfigured: true,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    github: {
      credentialRef: "synthetic",
      configurationValid: true,
      refreshIntervalMinutes: 15,
      nextRefreshAt: null,
      retryAt: null,
      activeRefreshId: null,
      lastRefreshId: null,
      lastRefreshStatus: null,
    },
  };
  const result: DependencyResult = {
    repository: {
      id: repository.id,
      fullName: repository.fullName,
      revision: repository.revision,
    },
    source: { id: source.id, name: source.name, revision: 1 },
    state: "ready",
    nextReadAt: null,
    evidence: {
      inspectionId: crypto.randomUUID(),
      observedAt: new Date(now).toISOString(),
      retryAt: null,
      requests: 6,
      upstreamRequests: 1,
      elapsedMs: 25,
      read: { state: "observed", reason: "complete" },
      branch: "main",
      pullNumber: null,
      headSha: SHA,
      treeSha: SHA,
      policy: "present",
      report: {
        schemaVersion: 1,
        kind: "npm-override-lifecycle",
        policyDigest: DIGEST,
        files: [
          {
            manifestPath: "package.json",
            manifestDigest: DIGEST,
            lockDigest: DIGEST,
          },
        ],
        analysis: analyzeDependencyPolicy(f.policy, f.documents, now),
      },
    },
  };
  result.evidence!.report!.analysis.findings[0].upstream = {
    state: "fix_available",
    checkedAt: new Date(now).toISOString(),
    parentVersion: "2.2.0",
    requested: "1.0.1",
  };
  const state = {
    result,
    rejectStatus: 0,
    review: null as DependencyChangeReview | null,
    operation: null as DependencyOperation | null,
    loseApplyResponse: false,
    calls: [] as { name: string; input: Record<string, unknown> }[],
  };
  page.on("request", (req) => {
    if (req.url().includes("/api/commands/"))
      state.calls.push({
        name: req.url().split("/").at(-1)!,
        input: req.postDataJSON(),
      });
  });
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    capabilities: [CAPABILITY.READ, CAPABILITY.OPERATE],
    connections: [source],
  }));
  await page.route("**/api/commands/repository_dependencies", (route) =>
    state.rejectStatus
      ? route.fulfill({
          status: state.rejectStatus,
          json: {
            error: {
              code: "forbidden",
              message: "Synthetic dependency access was revoked",
            },
          },
        })
      : route.fulfill({
          json: {
            ...state.result,
            evidence: {
              ...state.result.evidence,
              pullNumber: route.request().postDataJSON().pullNumber ?? null,
              branch: route.request().postDataJSON().pullNumber
                ? "dependabot/runner"
                : "main",
            },
          },
        }),
  );
  await page.route("**/api/commands/dependencies_list", (route) => {
    const { page: pageNumber } = route.request().postDataJSON();
    const rows: DependenciesPage["rows"] = Array.from(
      { length: pageNumber === 2 ? 7 : 20 },
      (_, index) => ({
        repository: {
          id: repository.id,
          fullName:
            index === 0 ? repository.fullName : "example/fixture-" + index,
          projectId: null,
        },
        source: { id: source.id, name: source.name },
        summary: {
          state: index % 3 ? "tracked" : "attention",
          observedAt: new Date(now).toISOString(),
          headSha: SHA,
          active: 1,
          attention: index % 3 ? 0 : 1,
          reviewBy: f.rule.reviewBy,
          stale: false,
        },
      }),
    );
    rows.forEach((row, index) => {
      if (index) row.repository.id = "fixture-" + pageNumber + "-" + index;
    });
    return route.fulfill({ json: { page: pageNumber, total: 27, rows } });
  });
  await page.route("**/api/commands/dependency_change_plan", (route) => {
    const input = route.request().postDataJSON();
    const evidence = state.result.evidence!;
    state.review = {
      workspaceId: WORKSPACE,
      planId: "synthetic-review",
      fingerprint: DIGEST,
      actor: "Local maintainer",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      state: "ready",
      writer: input.credentialId
        ? {
            id: input.credentialId,
            revision: 1,
            name: "Synthetic repository writer",
            expiresAt: "2099-01-01T00:00:00.000Z",
          }
        : null,
      basis: {
        repository: state.result.repository,
        source: state.result.source,
        observedAt: evidence.observedAt,
        branch: input.pullNumber ? "dependabot/runner" : evidence.branch!,
        pullNumber: input.pullNumber ?? null,
        headSha: SHA,
        treeSha: SHA,
        policyDigest: DIGEST,
        files: evidence.report!.files,
      },
      change: input.change,
      ...changedDependencyRule(
        evidence.report!.analysis,
        input.overrideId,
        input.change,
        Date.now(),
      ),
    };
    return route.fulfill({ json: state.review });
  });
  await page.route("**/api/commands/dependency_change_review", (route) =>
    route.fulfill({ json: state.review }),
  );
  await page.route("**/api/commands/dependency_write_access", (route) =>
    route.fulfill({
      json: {
        credentials: writable
          ? [
              {
                id: "managed-synthetic-repositories",
                name: "Synthetic repository writer",
                revision: 1,
                expiresAt: "2099-01-01T00:00:00.000Z",
                writable: true,
                status: "available",
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/commands/dependency_operation_get", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(state.operation),
    }),
  );
  await page.route("**/api/commands/dependency_change_apply", (route) => {
    expect(route.request().postDataJSON().fingerprint).toBe(
      state.review!.fingerprint,
    );
    state.operation ??= {
      id: "synthetic-operation",
      planId: state.review!.planId,
      repositoryId: repository.id,
      status: "succeeded",
      phase: "finished",
      reason: "complete",
      branch: "hq/dependencies/" + state.review!.planId,
      treeSha: SHA,
      commitSha: SHA,
      pullRequest: { number: 17, state: "open", merged: false, headSha: SHA },
      files: [
        {
          path: ".maintainer-hq/dependencies.json",
          beforeDigest: DIGEST,
          afterDigest: DIGEST,
        },
      ],
      requests: 10,
      elapsedMs: 35,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executionExpiresAt: new Date(Date.now() + 60000).toISOString(),
      observedAt: new Date().toISOString(),
      nextReconcileAt: null,
    };
    if (state.loseApplyResponse) {
      state.loseApplyResponse = false;
      return route.abort("failed");
    }
    return route.fulfill({ json: state.operation });
  });
  await page.route(
    "**/api/commands/dependency_operation_reconcile",
    (route) => {
      state.operation!.pullRequest!.merged = true;
      state.operation!.pullRequest!.state = "closed";
      return route.fulfill({ json: state.operation });
    },
  );
  await page.route("**/api/commands/dependency_operations_list", (route) =>
    route.fulfill({
      json: {
        items: state.operation ? [state.operation] : [],
        nextBefore: null,
      },
    }),
  );
  return { repository, state };
}
const href = (repository: Repository) =>
  "/repositories/" +
  repository.id +
  "?workspace=" +
  WORKSPACE +
  "&section=dependencies";
for (const width of [1440, 390])
  for (const theme of ["light", "dark"]) {
    test(`dependency evidence and review are usable at ${width} ${theme}`, async ({
      page,
      request,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      const { repository, state } = await populated(page, request, true);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(href(repository));
      await expect(
        page.getByText("Override still needed", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(/This repository still needs its own adoption/),
      ).toBeVisible();
      expect(
        state.calls
          .filter((call) => call.name === "repository_dependencies")
          .every((call) => !call.input.refresh),
      ).toBe(true);
      expect(
        state.calls.some(
          (call) =>
            call.name === "workspace_snapshot" ||
            call.name.includes("activity"),
        ),
      ).toBe(false);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(
        page.getByText("Removal condition and dependency paths", {
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByText("Removal condition and dependency paths", { exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText("requests 1.0.0").first()).toBeVisible();
      await page
        .getByRole("button", { name: "Review renewal", exact: true })
        .click();
      const reason = page.getByLabel("Reason for keeping this override");
      await expect(reason).toBeFocused();
      await reason.fill(
        "Both installed runner versions still need the temporary mitigation",
      );
      await page.getByLabel("Review again in days").fill("7");
      await page
        .getByRole("button", { name: "Prepare review", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Dependency change review" }),
      ).toBeVisible();
      await expect(
        page.getByText("Prepared change, not submitted to GitHub."),
      ).toBeVisible();
      expect(state.review?.after.reason).toContain("Both installed");
      expect(state.review?.basis.headSha).toBe(SHA);
      const audit = await new AxeBuilder({ page }).analyze();
      expect(audit.violations).toEqual([]);
      await verifyFlatContrast(page, audit.incomplete);
      await page.screenshot({
        path: info.outputPath("dependency-review.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Create pull request", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "PR created", exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "PR created", exact: true }),
      ).toBeVisible();
      expect(
        state.calls.filter((call) => call.name === "dependency_change_apply"),
      ).toHaveLength(1);
      await page
        .getByRole("button", { name: "Check GitHub outcome", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "PR merged", exact: true }),
      ).toBeVisible();
      const outcomeAudit = await new AxeBuilder({ page }).analyze();
      expect(outcomeAudit.violations).toEqual([]);
      await verifyFlatContrast(page, outcomeAudit.incomplete);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath("dependency-outcome.png"),
        fullPage: true,
      });
      expect(errors).toEqual([]);
    });
  }
test("fleet pagination stays cached and dependency access revocation removes displayed findings", async ({
  page,
  request,
}) => {
  const { repository, state } = await populated(page, request);
  await page.goto("/dependencies?workspace=" + WORKSPACE);
  await expect(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  expect(
    state.calls.some((call) => call.name === "repository_dependencies"),
  ).toBe(false);
  await page.goto(href(repository));
  await expect(
    page.getByText("Override still needed", { exact: true }),
  ).toBeVisible();
  state.rejectStatus = 403;
  await page
    .getByRole("button", { name: "Inspect repository", exact: true })
    .click();
  await expect(
    page.getByText("Synthetic dependency access was revoked"),
  ).toBeVisible();
  await expect(
    page.getByText("Override still needed", { exact: true }),
  ).toHaveCount(0);
});
test("PR selection stays in its own query scope and binds the review target", async ({
  page,
  request,
}) => {
  const { repository, state } = await populated(page, request, true);
  await page.goto(href(repository));
  await page.getByLabel("Inspection target", { exact: true }).fill("42");
  await page
    .getByRole("button", { name: "Select target", exact: true })
    .click();
  await expect(page).toHaveURL(/dependencyPull=42/);
  await expect(
    page.getByText(/Cleanup will target that PR's branch/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect repository", exact: true })
    .click();
  await expect
    .poll(
      () =>
        state.calls.filter(
          (call) =>
            call.name === "repository_dependencies" &&
            call.input.refresh &&
            call.input.pullNumber === 42,
        ).length,
    )
    .toBe(1);
  await page
    .getByRole("button", { name: "Review renewal", exact: true })
    .click();
  await page
    .getByLabel("Reason for keeping this override")
    .fill("The selected update still requires the decoder mitigation");
  await page
    .getByRole("button", { name: "Prepare review", exact: true })
    .click();
  await expect(
    page.getByText(/on dependabot\/runner \(PR #42 head branch\)/),
  ).toBeVisible();
  expect(state.review?.basis.pullNumber).toBe(42);
});
test("lost submission responses require saved-outcome recovery without another apply", async ({
  page,
  request,
}) => {
  const { repository, state } = await populated(page, request, true);
  state.loseApplyResponse = true;
  await page.goto(href(repository));
  await page
    .getByRole("button", { name: "Review renewal", exact: true })
    .click();
  await page
    .getByLabel("Reason for keeping this override")
    .fill("Both installed runners still require the verified mitigation");
  await page
    .getByRole("button", { name: "Prepare review", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create pull request", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Check the saved outcome",
  );
  await expect(
    page.getByRole("button", { name: "Create pull request", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Prepared change, not submitted to GitHub.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Reload saved outcome", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "PR created", exact: true }),
  ).toBeVisible();
  expect(
    state.calls.filter((call) => call.name === "dependency_change_apply"),
  ).toHaveLength(1);
});
test("revoked repository access removes cached credential metadata and actions", async ({
  page,
}) => {
  const state = await mockProviderCredentials(page);
  const credential = state.credentials[0]!;
  credential.settings = {
    providerKind: "github-repositories",
    name: "Scoped maintenance access",
    expiresAt: "2099-01-01T00:00:00.000Z",
    writable: true,
    scope: { repositoryNames: ["example/repository"] },
  };
  await page.goto("/dependencies?workspace=development&view=access");
  await expect(
    page.getByRole("heading", {
      name: "Scoped maintenance access",
      exact: true,
    }),
  ).toBeVisible();
  await page.route("**/api/commands/provider_credentials_list", (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: { code: "forbidden", message: "Repository access revoked" },
      },
    }),
  );
  await page
    .getByRole("button", { name: "Refresh access", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Repository access revoked",
  );
  await expect(
    page.getByRole("heading", {
      name: "Scoped maintenance access",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add provider access", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Use for maintenance", exact: true }),
  ).toHaveCount(0);
});
for (const width of [1440, 390])
  for (const theme of ["light", "dark"]) {
    test(`repository write access setup is isolated at ${width} ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      const state = await mockProviderCredentials(page, { empty: true });
      const calls: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("/api/commands/"))
          calls.push(req.url().split("/").at(-1)!);
      });
      await page.goto("/dependencies?workspace=development&view=access");
      await expect(
        page.getByRole("heading", {
          name: "Repository write access",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Add provider access", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("combobox", { name: "Provider", exact: true }),
      ).toBeDisabled();
      await dialog
        .getByLabel("Name", { exact: true })
        .fill("Repository maintenance");
      await dialog
        .getByLabel("Stop using in HQ (local time)")
        .fill("2099-01-01T12:00");
      await dialog
        .getByLabel("Repository names, one owner/repository per line")
        .fill("example/repository");
      await dialog
        .getByRole("checkbox", { name: /Allow explicitly reviewed writes/ })
        .check();
      await dialog
        .getByRole("button", { name: "Review access", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Provider access review",
          exact: true,
        }),
      ).toBeVisible();
      expect(
        state.calls.find((call) => call.name === "provider_credential_plan")
          ?.input,
      ).toMatchObject({
        change: {
          settings: { providerKind: "github-repositories", writable: true },
        },
      });
      await page
        .getByLabel("Private provider token")
        .fill("synthetic-repository-test-only");
      await page
        .getByRole("button", {
          name: "Save credential with this scope",
          exact: true,
        })
        .click();
      await expect(
        page.getByText("The reviewed credential change is applied.", {
          exact: false,
        }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await expect(
        page.getByRole("heading", {
          name: "Repository maintenance",
          exact: true,
        }),
      ).toBeVisible();
      expect(
        calls.some(
          (name) =>
            name.startsWith("secrets_") ||
            name.includes("activity") ||
            name === "dependencies_list",
        ),
      ).toBe(false);
      expect(
        state.calls
          .filter((call) => call.name === "provider_credentials_list")
          .every((call) => call.input.purpose === "repositories"),
      ).toBe(true);
      const audit = await new AxeBuilder({ page }).analyze();
      expect(audit.violations).toEqual([]);
      await verifyFlatContrast(page, audit.incomplete);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath("repository-access.png"),
        fullPage: true,
      });
    });
  }
