import { test, expect, type Page } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { CAPABILITY } from "../shared/domain";
import { dependabotBrowserRows } from "./dependabot-fixture";
import { type DependabotChangeReview } from "../shared/dependabot-changes";
import { type DependabotOperation } from "../shared/dependabot-operations";
import { mockWorkspaceView } from "./workspace-fixture";

const DIGEST = "sha256:" + "b".repeat(64),
  SHA = "a".repeat(40);
const href =
  "/dependencies?workspace=development&view=schedules&scheduleDate=2026-10-26&scheduleZone=UTC";
async function fixture(page: Page, writable = true, operator = true) {
  const rows=dependabotBrowserRows();
  const state = {
    rows,
    review: null as DependabotChangeReview | null,
    operation: null as DependabotOperation | null,
    calls: [] as string[],
    lose: false,
    refreshDelay: 0,
    changedPages: false,
    rejectInventory: 0,
  };
  await mockWorkspaceView(page, (s) => ({
    ...s,
    capabilities: operator
      ? [CAPABILITY.READ, CAPABILITY.OPERATE]
      : [CAPABILITY.READ],
  }));
  await page.route("**/api/commands/dependabot*", async (route) => {
    const name = route.request().url().split("/").at(-1)!,
      input = route.request().postDataJSON();
    state.calls.push(name);
    if (name === "dependabot_schedules") {
      if (state.rejectInventory)
        return route.fulfill({
          status: state.rejectInventory,
          json: {
            error: {
              code: "forbidden",
              message: "Synthetic schedule access revoked",
            },
          },
        });
      const pageNumber = input.page ?? 1;
      return route.fulfill({
        json: {
          revision: state.changedPages && pageNumber > 1 ? 2 : 1,
          page: pageNumber,
          pageSize: 10,
          total: rows.length,
          rows: rows.slice((pageNumber - 1) * 10, pageNumber * 10),
        },
      });
    }
    if (name === "dependabot_change_plan") {
      const row = rows.find((r) => r.repository.id === input.repositoryId)!,
        e = row.result!.evidence!;
      state.review = {
        workspaceId: "development",
        planId: crypto.randomUUID(),
        fingerprint: DIGEST,
        actor: "Fixture operator",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        state: "ready",
        writer: input.credentialId
          ? {
              id: "managed-writer",
              name: "Fixture write access",
              revision: 1,
              expiresAt: "2099-01-01T00:00:00Z",
            }
          : null,
        basis: {
          repository: row.result!.repository,
          source: row.result!.source,
          observedAt: e.observedAt,
          headSha: SHA,
          treeSha: SHA,
          branch: "main",
          file: e.file!,
        },
        edits: input.edits,
        changes: input.edits.map(
          (edit: { entryId: string; schedule: unknown }) => {
            const before = e.entries.find((item) => item.id === edit.entryId)!;
            return { before, after: { ...before, schedule: edit.schedule } };
          },
        ),
        proposedDigest: "sha256:" + "c".repeat(64),
      } as DependabotChangeReview;
      return route.fulfill({ json: state.review });
    }
    if (name === "dependabot_change_review")
      return route.fulfill({ json: state.review });
    if (name === "dependabot_operations_list")
      return route.fulfill({
        json: {
          items: state.operation ? [state.operation] : [],
          nextBefore: null,
        },
      });
    if (name === "dependabot_change_apply") {
      const r = state.review!;
      state.operation = {
        id: crypto.randomUUID(),
        planId: r.planId,
        repositoryId: r.basis.repository.id,
        status: "succeeded",
        phase: "finished",
        reason: "complete",
        branch: "hq/dependabot/" + r.planId,
        treeSha: SHA,
        commitSha: SHA,
        pullRequest: { number: 42, state: "open", merged: false, headSha: SHA },
        files: [
          {
            path: r.basis.file.path,
            beforeDigest: DIGEST,
            afterDigest: r.proposedDigest,
          },
        ],
        requests: 11,
        elapsedMs: 100,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        executionExpiresAt: new Date(Date.now() + 60000).toISOString(),
        observedAt: new Date().toISOString(),
        nextReconcileAt: null,
      };
      return state.lose
        ? route.abort("failed")
        : route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(state.operation),
          });
    }
    if (
      name === "dependabot_operation_get" ||
      name === "dependabot_operation_reconcile"
    )
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(state.operation),
      });
    throw new Error("Unexpected schedule command: " + name);
  });
  await page.route("**/api/commands/repository_dependabot", async (route) => {
    state.calls.push("repository_dependabot");
    if (state.refreshDelay)
      await new Promise((resolve) => setTimeout(resolve, state.refreshDelay));
    return route.fulfill({
      json: rows.find(
        (row) =>
          row.repository.id === route.request().postDataJSON().repositoryId,
      )!.result,
    });
  });
  await page.route("**/api/commands/dependency_write_access", (route) =>
    route.fulfill({
      json: {
        credentials: writable
          ? [
              {
                id: "managed-writer",
                name: "Fixture write access",
                revision: 1,
                expiresAt: "2099-01-01T00:00:00Z",
                writable: true,
                status: "available",
              },
            ]
          : [],
      },
    }),
  );
  return state;
}
test("repository timeline retains all-scope overlaps through filters and timezone/day changes", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(href);
  await expect(
    page.getByRole("heading", { name: "Dependabot schedules" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "6 of 6 repositories" }),
  ).toBeVisible();
  const alpha = page.locator('[data-schedule-repository="schedule-0"]');
  await expect(
    alpha.getByRole("button", { name: /Observed.*3 starts/ }),
  ).toHaveCount(1);
  expect(state.calls).not.toContain("repository_dependabot");
  await page.getByLabel("Find a repository").fill("alpha");
  await expect(alpha.getByRole("button", { name: /3 starts/ })).toBeVisible();
  await expect(
    page.locator('[data-schedule-repository="schedule-1"]'),
  ).toHaveCount(0);
  await page.getByLabel("View", { exact: true }).selectOption("day");
  await page.getByLabel("Display timezone").selectOption("America/New_York");
  await expect(alpha.getByRole("button", { name: /04:00/ })).toBeVisible();
});
test("Save creates only a local draft, Cancel preserves it, and review creates one PR", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(href);
  await page
    .locator('[data-schedule-repository="schedule-0"]')
    .getByRole("button", { name: /Observed/ })
    .click();
  await page.getByLabel("Time", { exact: true }).fill("09:30");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  expect(state.calls).not.toContain("dependabot_change_plan");
  await expect(
    page.getByText("Local draft", { exact: true }).first(),
  ).toBeVisible();
  await page
    .locator('[data-schedule-repository="schedule-0"]')
    .getByRole("button", { name: /Draft/ })
    .click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .locator('[data-schedule-repository="schedule-0"]')
    .getByRole("button", { name: "Review changes" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review schedule changes" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Prepare review" }).click();
  await expect(
    page.getByRole("button", { name: "Create pull request" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Create pull request" }).click();
  await expect(
    page.getByRole("link", { name: "Pull request #42" }),
  ).toBeVisible();
  expect(
    state.calls.filter((name) => name === "dependabot_change_apply"),
  ).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Pull request #42" }),
  ).toBeVisible();
});
test("missing write access is review-only and unknown/stale schedules stay explicit", async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto(href);
  await expect(
    page.getByText("Time assigned by GitHub", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Stale observation", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Timeline unavailable for this cron expression", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator('[data-schedule-repository="schedule-0"]')
    .getByRole("button", { name: /Observed/ })
    .click();
  await page.getByLabel("Time", { exact: true }).fill("09:30");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page
    .locator('[data-schedule-repository="schedule-0"]')
    .getByRole("button", { name: "Review changes" })
    .click();
  await expect(
    page.getByText(/No repository write credential is available/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Prepare review" }).click();
  await expect(
    page.getByRole("button", { name: "Create pull request" }),
  ).toBeDisabled();
});
test("lost apply response recovers the original receipt without another write", async ({
  page,
}) => {
  const state = await fixture(page);
  state.lose = true;
  await page.goto(href);
  await page
    .locator('[data-schedule-repository="schedule-0"]')
    .getByRole("button", { name: /Observed/ })
    .click();
  await page.getByLabel("Time", { exact: true }).fill("09:30");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page
    .locator('[data-schedule-repository="schedule-0"]')
    .getByRole("button", { name: "Review changes" })
    .click();
  await page.getByRole("button", { name: "Prepare review" }).click();
  await page.getByRole("button", { name: "Create pull request" }).click();
  await expect(
    page.getByRole("link", { name: "Pull request #42" }),
  ).toBeVisible();
  expect(
    state.calls.filter((name) => name === "dependabot_change_apply"),
  ).toHaveLength(1);
});
for (const theme of ["light", "dark"])
  test(`${theme} mobile list and keyboard editor are accessible`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(
      (t) => localStorage.setItem("hq.theme.v1", t),
      theme,
    );
    await fixture(page, false, false);
    await page.goto(href);
    const alpha = page.locator('[data-schedule-repository="schedule-0"]');
    const button = alpha.getByRole("button", { name: /Observed/ });
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(button).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const a11y = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(a11y.violations).toEqual([]);
  });

test("changed inventory pages remain incomplete and access errors hide retained rows", async ({
  page,
}) => {
  const state = await fixture(page);
  for (let index = 6; index < 12; index++)
    state.rows.push({
      ...state.rows[0]!,
      repository: {
        ...state.rows[0]!.repository,
        id: "schedule-" + index,
        fullName: "example/extra-" + index,
      },
    });
  state.changedPages = true;
  await page.goto(href);
  await expect(
    page.getByText(
      "Repository inventory changed while loading. Reload the list.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "10 of 12 repositories" }),
  ).toBeVisible();
  state.rejectInventory = 403;
  await page.getByRole("button", { name: "Reload list", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator("[data-schedule-repository]")).toHaveCount(0);
});
test("refresh cancellation stops unsent work and drafts stay pinned when observations change", async ({
  page,
}) => {
  const state = await fixture(page);
  state.refreshDelay = 400;
  await page.goto(href);
  await page
    .getByRole("button", { name: "Refresh schedules", exact: true })
    .click();
  await expect
    .poll(
      () =>
        state.calls.filter((name) => name === "repository_dependabot").length,
    )
    .toBe(2);
  await page.getByRole("button", { name: "Stop refresh", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Refresh stopped" }),
  ).toBeVisible();
  expect(
    state.calls.filter((name) => name === "repository_dependabot"),
  ).toHaveLength(2);
  const alpha = page.locator('[data-schedule-repository="schedule-0"]');
  await alpha.getByRole("button", { name: /Observed/ }).click();
  await page.getByLabel("Time", { exact: true }).fill("09:30");
  await page.getByRole("button", { name: "Save draft" }).click();
  state.rows[0]!.result!.evidence!.headSha = "f".repeat(40);
  await page.getByRole("button", { name: "Reload list", exact: true }).click();
  await expect(
    alpha.getByText("Draft evidence changed", { exact: true }),
  ).toBeVisible();
  await expect(
    alpha.getByRole("button", { name: "Review changes" }),
  ).toBeDisabled();
});
test("an overlap remains allowed through draft review and one grouped schedule stays one marker", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(href);
  const group = page.locator('[data-schedule-repository="schedule-5"]');
  await expect(
    group.getByRole("button", { name: /Observed frontend/ }),
  ).toHaveCount(1);
  const alpha = page.locator('[data-schedule-repository="schedule-0"]');
  await alpha.getByRole("button", { name: /Observed/ }).click();
  await page.getByLabel("Schedule timezone").fill("UTC");
  await page.getByRole("button", { name: "Save draft" }).click();
  await alpha.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Prepare review" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "1 proposed overlapping start minutes" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create pull request" }).click();
  await expect(
    page.getByRole("link", { name: "Pull request #42" }),
  ).toBeVisible();
  expect(state.review!.changes).toHaveLength(1);
});
