import { test, expect, type Page } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { CAPABILITY } from "../shared/domain";
import { dependabotBrowserRows, dependabotFleetBrowserRows } from "./dependabot-fixture";
import { type DependabotChangeReview } from "../shared/dependabot-changes";
import { type DependabotOperation } from "../shared/dependabot-operations";
import { mockWorkspaceView } from "./workspace-fixture";
import type { Locator } from "@playwright/test";

const DIGEST = "sha256:" + "b".repeat(64),
  SHA = "a".repeat(40);
const href =
  "/dependencies?workspace=development&view=schedules&scheduleDate=2026-10-26&scheduleZone=UTC";
async function showOptions(page: Page, open = true) {
  const details = page.locator(".schedule-options");
  if ((await details.getAttribute("open") !== null) !== open) await details.locator("summary").click();
}
async function showOther(page: Page) {
  const details = page.locator(".schedule-other");
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
}
async function fixture(page: Page, writable = true, operator = true) {
  const rows = dependabotBrowserRows();
  const state = {
    rows,
    review: null as DependabotChangeReview | null,
    operation: null as DependabotOperation | null,
    calls: [] as string[],
    inventoryPages: [] as number[],
    lose: false,
    refreshDelay: 0,
    changedPages: false,
    rejectInventory: 0,
    reviewDenied: false,
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
      state.inventoryPages.push(pageNumber);
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
      return state.reviewDenied
        ? route.fulfill({
            status: 404,
            json: {
              error: {
                code: "not_found",
                message: "Review belongs to another actor",
              },
            },
          })
        : route.fulfill({ json: state.review });
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
  await showOther(page);
  await expect(
    page.getByText("Time assigned by GitHub", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.locator('[data-schedule-repository="schedule-3"]').getByRole("button", { name: /stale observation/ }),
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
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
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
  await showOptions(page);
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
  await showOptions(page);
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
  await showOptions(page);
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
    group.getByRole("button", { name: /Observed.*frontend/ }),
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

for (const edit of ["unknown time", "dense cron", "unmatched identity"])
  test(
    "saved reviews qualify overlap coverage for " + edit,
    async ({ page }) => {
      const state = await fixture(page);
      state.rows.splice(2);
      await page.goto(href);
      const alpha = page.locator('[data-schedule-repository="schedule-0"]');
      await alpha.getByRole("button", { name: /Observed/ }).click();
      if (edit === "dense cron") {
        await page
          .getByRole("combobox", { name: "Interval", exact: true })
          .selectOption("cron");
        await page.getByLabel("Cron expression").fill("* * * * *");
      } else
        await page
          .getByLabel("Time", { exact: true })
          .fill(edit === "unknown time" ? "" : "09:30");
      await page.getByRole("button", { name: "Save draft" }).click();
      await alpha.getByRole("button", { name: "Review changes" }).click();
      await page.getByRole("button", { name: "Prepare review" }).click();
      await expect(
        page.getByRole("heading", { name: "Saved schedule review" }),
      ).toBeVisible();
      if (edit === "unmatched identity") {
        state.rows[0]!.result!.evidence!.entries[0]!.id =
          "sha256:" + "e".repeat(64) + ":update:0";
        state.rows[0]!.result!.evidence!.file!.digest =
          "sha256:" + "e".repeat(64);
        await showOptions(page);
        await page
          .getByRole("button", { name: "Reload list", exact: true })
          .click();
      }
      await expect(
        page.getByRole("status").filter({
          hasText: /Proposed overlap comparison is (incomplete|undetermined)/,
        }),
      ).toBeVisible();
    },
  );
test("another operator can inspect a history receipt without the original review authority", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(href);
  const alpha = page.locator('[data-schedule-repository="schedule-0"]');
  await alpha.getByRole("button", { name: /Observed/ }).click();
  await page.getByLabel("Time", { exact: true }).fill("09:30");
  await page.getByRole("button", { name: "Save draft" }).click();
  await alpha.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Prepare review" }).click();
  await page.getByRole("button", { name: "Create pull request" }).click();
  await expect(
    page.getByRole("link", { name: "Pull request #42" }),
  ).toBeVisible();
  state.reviewDenied = true;
  await page.getByRole("button", { name: "Back to timeline" }).click();
  await alpha.getByRole("button", { name: /Observed/ }).click();
  await page.getByLabel("Time", { exact: true }).fill("09:45");
  await page.getByRole("button", { name: "Save draft" }).click();
  await alpha.getByRole("button", { name: /Observed/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "PR history" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /succeeded/ }).click();
  await expect(page.getByRole("link", { name: "Pull request #42" })).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to timeline" }).click();
  await expect(alpha.getByRole("button", { name: /Draft.*09:45/ })).toBeVisible();
  await alpha.getByRole("button", { name: /Observed/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "PR history" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /succeeded/ }).click();
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Pull request #42" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check GitHub outcome" }),
  ).toHaveCount(0);
  expect(
    state.calls.filter((name) => name === "dependabot_change_apply"),
  ).toHaveLength(1);
});
test("week dates zoom to a day and missing configuration links to its repository", async ({
  page,
}) => {
  const state = await fixture(page);
  const e = state.rows[0]!.result!.evidence!;
  e.configuration = "missing";
  e.file = null;
  e.entries = [];
  await page.goto(href);
  const day = page.getByRole("button", {
    name: "View Tuesday, October 27, 2026",
  });
  await expect(day).toBeVisible();
  await day.click();
  await expect(page.getByLabel("View", { exact: true })).toHaveValue("day");
  await expect(page.getByLabel("Starting date")).toHaveValue("2026-10-27");
  await showOther(page);
  await expect(
    page
      .locator('[data-schedule-repository="schedule-0"]')
      .getByRole("link", { name: "Open repository on GitHub" }),
  ).toHaveAttribute("href", "https://github.com/example/alpha");
});

async function dayEditor(page: Page) {
  await page
    .getByRole("button", { name: "View Monday, October 26, 2026" })
    .click();
  await expect(page.getByLabel("View", { exact: true })).toHaveValue("day");
  const row = page.locator('[data-schedule-repository="schedule-0"]');
  return {
    row,
    block: row.getByRole("button", { name: /Observed.*08:00/ }),
    lane: row.locator("[data-schedule-hour-lane]"),
  };
}
async function startMove(page: Page, block: Locator) {
  await block.scrollIntoViewIfNeeded();
  const box = await block.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  return box!;
}
test("week groups by weekday and opens a detailed quarter-hour day", async ({
  page,
}) => {
  await fixture(page);
  await page.goto(href);
  const monday = page.getByRole("region", {
    name: "Monday, October 26, 2026",
    exact: true,
  });
  await expect(monday).toBeVisible();
  await expect(
    monday.getByRole("button", { name: /Observed example\/alpha/ }),
  ).toBeVisible();
  await dayEditor(page);
  await expect(
    page.getByRole("list", { name: "Hours in UTC" }).getByRole("listitem"),
  ).toHaveCount(24);
  await expect(
    page.getByRole("button", { name: "View Tuesday, October 27, 2026" }),
  ).toBeVisible();
});
test("pointer movement snaps with a live time above the block and drops only a draft", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(href);
  const { row, block, lane } = await dayEditor(page);
  await startMove(page, block);
  const box = await lane.boundingBox();
  await page.mouse.move(
    box!.x + (box!.width * 566) / 1440,
    box!.y + box!.height / 2,
    { steps: 12 },
  );
  const label = page.locator(".schedule-drag-time");
  await expect(label).toContainText("09:30 UTC");
  const bubble = await label.boundingBox(),
    ghost = await page.locator(".schedule-drag-block").boundingBox();
  expect(bubble!.y + bubble!.height).toBeLessThanOrEqual(ghost!.y);
  await page.mouse.up();
  await expect(row.getByRole("button", { name: /Draft.*09:30/ })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.calls).not.toContain("dependabot_change_plan");
  expect(state.calls).not.toContain("dependabot_change_apply");
});
test("a weekly block moves across days from the detailed day and preserves its time", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(href);
  const { block } = await dayEditor(page);
  await startMove(page, block);
  const target = await page
    .locator('[data-schedule-drop-date="2026-10-27"]')
    .boundingBox();
  await page.mouse.move(
    target!.x + target!.width / 2,
    target!.y + target!.height / 2,
    { steps: 12 },
  );
  await expect(page.locator(".schedule-drag-time")).toContainText("Tue");
  await expect(page.locator(".schedule-drag-time")).toContainText("08:00 UTC");
  await page.mouse.up();
  await expect(page.getByLabel("Starting date")).toHaveValue("2026-10-27");
  const row = page.locator('[data-schedule-repository="schedule-0"]');
  await expect(row.getByRole("button", { name: /Draft.*08:00/ })).toBeVisible();
  await row.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Prepare review" }).click();
  expect(state.review!.edits[0]!.schedule).toEqual({
    interval: "weekly",
    day: "tuesday",
    time: "08:00",
  });
});
test("keyboard moves can be canceled or committed without opening the editor", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(href);
  const { row, block } = await dayEditor(page);
  await block.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".schedule-drag-time")).toContainText("08:15 UTC");
  await page.keyboard.press("Escape");
  await expect(row.getByRole("button", { name: /Draft/ })).toHaveCount(0);
  await block.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Starting date")).toHaveValue("2026-10-27");
  await expect(
    page
      .locator('[data-schedule-repository="schedule-0"]')
      .getByRole("button", { name: /Draft.*08:15/ }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.calls).not.toContain("dependabot_change_plan");
});
test("pointer Escape cancels and a normal click still opens the form", async ({
  page,
}) => {
  await fixture(page);
  await page.goto(href);
  const { row, block, lane } = await dayEditor(page);
  await startMove(page, block);
  const box = await lane.boundingBox();
  await page.mouse.move(
    box!.x + (box!.width * 555) / 1440,
    box!.y + box!.height / 2,
    { steps: 8 },
  );
  await expect(page.locator(".schedule-drag-time")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(row.getByRole("button", { name: /Draft/ })).toHaveCount(0);
  await block.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("a repository keeps unprojectable entries visible beside its scheduled entries", async ({ page }) => {
  const state = await fixture(page);
  const entry = structuredClone(state.rows[2]!.result!.evidence!.entries[0]!);
  entry.id = DIGEST + ":update:1";
  state.rows[0]!.result!.evidence!.entries.push(entry);
  await page.goto(href);
  await showOther(page);
  await expect(page.getByRole("region", { name: "Unplaced schedules" }).getByText("example/alpha", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Unplaced schedules" }).getByText("Time assigned by GitHub", { exact: true }).first()).toBeVisible();
});

test("leaving a grabbed block cancels the keyboard move", async ({ page }) => {
  await fixture(page);
  await page.goto(href);
  const { row, block } = await dayEditor(page);
  await block.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".schedule-drag-time")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(".schedule-drag-time")).toHaveCount(0);
  await expect(row.getByRole("button", { name: /Draft/ })).toHaveCount(0);
});

test("Escape suppresses the canceled pointer click until the next gesture", async ({ page }) => {
  await fixture(page);
  await page.goto(href);
  const { block } = await dayEditor(page);
  const box = await startMove(page, block);
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2);
  await expect(page.locator(".schedule-drag-time")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await block.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("week cards move to another weekday without opening its day", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(href);
  const block = page.locator('[data-schedule-repository="schedule-0"]').getByRole("button", { name: /Observed/ });
  await startMove(page, block);
  const target = (await page.locator('[data-schedule-drop-date="2026-10-27"]').boundingBox())!;
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await expect(page.locator(".schedule-drag-time")).toContainText("Tue, Oct 27 08:00 UTC");
  await page.mouse.up();
  await expect(page.getByLabel("View", { exact: true })).toHaveValue("week");
  await expect(page.getByRole("region", { name: "Tuesday, October 27, 2026", exact: true }).getByRole("button", { name: /Draft.*08:00/ })).toBeVisible();
  expect(state.calls).not.toContain("dependabot_change_plan");
});

test("overlap stays allowed during a filtered live move", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(href);
  const { row, block } = await dayEditor(page);
  await page.getByLabel("Find a repository").fill("alpha");
  await block.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".schedule-drag-time")).toContainText("3 starts at the same minute; overlap allowed.");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(page.locator(".schedule-drag-time")).toHaveCount(0);
  await expect(row.getByRole("button", { name: /Observed.*3 starts/ })).toBeVisible();
  expect(state.calls).not.toContain("dependabot_change_apply");
});

test.describe("touch scheduling", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("touch moves a block on the hourly lane without page overflow", async ({ page }) => {
    const state = await fixture(page);
    await page.goto(href);
    const { row, block, lane } = await dayEditor(page);
    await block.scrollIntoViewIfNeeded();
    const box = (await block.boundingBox())!, track = (await lane.boundingBox())!;
    const client = await page.context().newCDPSession(page);
    const touch = (x: number, y: number) => [{ x, y, id: 1 }];
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(box.x + box.width / 2, box.y + box.height / 2) });
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(track.x + track.width * 555 / 1440, box.y + box.height / 2) });
    await expect(page.locator(".schedule-drag-time")).toContainText("09:15 UTC");
    await client.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect(page.locator(".schedule-drag-time")).toHaveCount(0);
    await expect(row.getByRole("button", { name: /Draft/ })).toHaveCount(0);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(box.x + box.width / 2, box.y + box.height / 2) });
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(track.x + track.width * 555 / 1440, box.y + box.height / 2) });
    await expect(page.locator(".schedule-drag-time")).toContainText("09:15 UTC");
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(row.getByRole("button", { name: /Draft.*09:15/ })).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(state.calls).not.toContain("dependabot_change_apply");
  });
});

for (const theme of ["light", "dark"])
  test(`${theme} hourly day and grabbed preview remain accessible on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((value) => localStorage.setItem("hq.theme.v1", value), theme);
    await fixture(page);
    await page.goto(href);
    const { block } = await dayEditor(page);
    await block.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    const label = (await page.locator(".schedule-drag-time").boundingBox())!;
    expect(label.x).toBeGreaterThanOrEqual(0);
    expect(label.y).toBeGreaterThanOrEqual(0);
    expect(label.x + label.width).toBeLessThanOrEqual(390);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
  });

test("off-center pointer pickup preserves the clock and applies only horizontal displacement", async ({ page }) => {
  await fixture(page);
  await page.goto(href);
  const { row, block, lane } = await dayEditor(page);
  await block.scrollIntoViewIfNeeded();
  const box = (await block.boundingBox())!;
  const track = (await lane.boundingBox())!;
  const x = box.x + box.width / 2 + 24;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 5);
  await expect(page.locator(".schedule-drag-time")).toContainText("08:00 UTC");
  await page.mouse.up();
  await expect(row.getByRole("button", { name: /Draft/ })).toHaveCount(0);
  const again = (await block.boundingBox())!;
  const nextX = again.x + again.width / 2 + 24;
  const nextY = again.y + again.height / 2;
  await page.mouse.move(nextX, nextY);
  await page.mouse.down();
  await page.mouse.move(nextX + track.width * 15 / 1440, nextY + 5);
  await expect(page.locator(".schedule-drag-time")).toContainText("08:15 UTC");
  await page.mouse.up();
  await expect(row.getByRole("button", { name: /Draft.*08:15/ })).toBeVisible();
});

test.describe("touch movement continuity", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("off-center touch pickup preserves the clock until horizontal movement", async ({ page }) => {
    await fixture(page);
    await page.goto(href);
    const { row, block, lane } = await dayEditor(page);
    await block.scrollIntoViewIfNeeded();
    const box = (await block.boundingBox())!;
    const track = (await lane.boundingBox())!;
    const client = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2 + 24;
    const y = box.y + box.height / 2;
    const touch = (left: number, top: number) => [{ x: left, y: top, id: 1 }];
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(x, y) });
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(x, y + 5) });
    await expect(page.locator(".schedule-drag-time")).toContainText("08:00 UTC");
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(x + track.width * 15 / 1440, y + 5) });
    await expect(page.locator(".schedule-drag-time")).toContainText("08:15 UTC");
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(row.getByRole("button", { name: /Draft.*08:15/ })).toBeInViewport({ ratio: 1 });
  });
  for (const earlyObserved of [false, true])
    test(`cross-day touch reveals the exact moved draft with early observation ${earlyObserved}`, async ({ page }) => {
      const state = await fixture(page);
      if (earlyObserved)
        state.rows[1]!.result!.evidence!.entries[0]!.schedule = {
          interval: "weekly", day: "tuesday", time: "00:15",
        };
      await page.goto(href);
      const { block } = await dayEditor(page);
      await block.scrollIntoViewIfNeeded();
      const box = (await block.boundingBox())!;
      const target = (await page.locator('[data-schedule-drop-date="2026-10-27"]').boundingBox())!;
      const client = await page.context().newCDPSession(page);
      const touch = (x: number, y: number) => [{ x, y, id: 1 }];
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(box.x + box.width / 2, box.y + box.height / 2) });
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(target.x + target.width / 2, target.y + target.height / 2) });
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(page.getByLabel("Starting date")).toHaveValue("2026-10-27");
      const row = page.locator('[data-schedule-repository="schedule-0"]');
      const draft = row.getByRole("button", { name: /Draft.*08:00/ });
      await expect(draft).toBeInViewport({ ratio: 1 });
      const next = (await draft.boundingBox())!;
      const lane = (await row.locator("[data-schedule-hour-lane]").boundingBox())!;
      const x = next.x + next.width / 2;
      const y = next.y + next.height / 2;
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(x, y) });
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(x + lane.width * 15 / 1440, y) });
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(row.getByRole("button", { name: /Draft.*08:15/ })).toBeInViewport({ ratio: 1 });
      expect(state.calls).not.toContain("dependabot_change_apply");
    });
});

for (const width of [1440, 390])
  test(`fleet-sized schedules load every page and populate the week at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await fixture(page);
    state.rows.splice(0, state.rows.length, ...dependabotFleetBrowserRows());
    await page.goto(href);
    await expect(page.getByText(/55 of 55 repositories/)).toBeVisible();
    expect([...new Set(state.inventoryPages)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    const days = page.locator(".schedule-week-day");
    await expect(days).toHaveCount(7);
    for (const day of await days.all())
      expect(await day.getByRole("button", { name: /Observed/ }).count()).toBeGreaterThan(0);
    await page.getByRole("button", { name: "View Wednesday, October 28, 2026" }).click();
    await expect.poll(() => page.locator(".schedule-time-block").count()).toBeGreaterThan(7);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

test("weekly assignments show repo and time with secondary metadata in details", async ({ page }) => {
  await fixture(page);
  await page.goto(href);
  const week = page.getByRole("region", { name: "Schedules grouped by weekday" });
  const alpha = week.locator('[data-schedule-repository="schedule-0"]');
  const block = alpha.getByRole("button", { name: /Observed/ });
  await expect(block).toContainText("alpha");
  await expect(block).toContainText("08:00");
  await expect(week.getByText("Observed", { exact: true })).toHaveCount(0);
  await expect(week.getByRole("button", { name: "PR history" })).toHaveCount(0);
  const stale = week.locator('[data-schedule-repository="schedule-3"]').getByRole("button", { name: /stale observation/ });
  await expect(stale).toHaveClass(/is-stale/);
  await stale.hover();
  await expect(page.getByRole("tooltip")).toContainText("Stale observation");
  await expect(page.getByRole("tooltip")).toContainText(/Stale observation \/ \d{4}-\d{2}-\d{2}/);
  await block.click();
  const details = page.getByRole("dialog");
  await expect(details.getByText("Ecosystem", { exact: true })).toBeVisible();
  await expect(details.getByText("npm", { exact: true })).toBeVisible();
  await expect(details.getByText("Repository root (/)", { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "PR history" })).toBeVisible();
});

test("isolated review inventory revalidates without dropping local drafts", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const state = await fixture(page);
  await page.goto(href);
  const alpha = page.locator('[data-schedule-repository="schedule-0"]');
  await alpha.getByRole("button", { name: /Observed/ }).click();
  await page.getByLabel("Time", { exact: true }).fill("09:30");
  await page.getByRole("button", { name: "Save draft" }).click();
  const before = state.inventoryPages.length;
  state.rows[0]!.result!.evidence!.inspectionId = crypto.randomUUID();
  state.rows[0]!.result!.evidence!.observedAt = new Date(Date.now() + 1000).toISOString();
  await page.clock.fastForward(30000);
  await expect.poll(() => state.inventoryPages.length).toBeGreaterThan(before);
  await expect(alpha.getByRole("button", { name: /Draft.*09:30/ })).toBeVisible();
});

test("assignment history cannot navigate away from unsaved form changes", async ({ page }) => {
  await fixture(page);
  await page.goto(href);
  await page.locator('[data-schedule-repository="schedule-0"]').getByRole("button", { name: /Observed/ }).click();
  const dialog = page.getByRole("dialog");
  await page.getByLabel("Time", { exact: true }).fill("09:30");
  await expect(dialog.getByRole("button", { name: "PR history" })).toBeDisabled();
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.locator('[data-schedule-repository="schedule-0"]').getByRole("button", { name: /Draft.*09:30/ }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "PR history" })).toBeEnabled();
});

test("same repository basenames retain owner identity in weekly assignments", async ({ page }) => {
  const state = await fixture(page);
  state.rows[1]!.repository.fullName = "other/alpha";
  state.rows[1]!.result!.repository.fullName = "other/alpha";
  await page.goto(href);
  const week = page.getByRole("region", { name: "Schedules grouped by weekday" });
  await expect(week.locator('[data-schedule-repository="schedule-0"]').getByRole("button", { name: /Observed/ })).toContainText("example/alpha");
  const other = week.locator('[data-schedule-repository="schedule-1"]').getByRole("button", { name: /Observed/ });
  await expect(other).toContainText("other/alpha");
  await other.click();
  await expect(page.getByRole("dialog").getByText("other/alpha", { exact: true })).toBeVisible();
});

test("read-only schedule details keep history available without an editable form", async ({ page }) => {
  const state = await fixture(page);
  const entry = state.rows[0]!.result!.evidence!.entries[0]!;
  entry.schedule = null;
  entry.editable = false;
  entry.issue = "unsupported_schedule";
  await page.goto(href);
  await showOther(page);
  await page.locator('[data-schedule-repository="schedule-0"]').getByRole("button", { name: "npm at repository root", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Schedule details" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "PR history" })).toBeEnabled();
  await dialog.getByRole("button", { name: "PR history" }).click();
  await expect(dialog.getByText("No schedule PR operations recorded.")).toBeVisible();
});

async function blockBackground(block: Locator) {
  return block.evaluate(node => getComputedStyle(node).backgroundColor);
}
test("time colors stay unique within a day and stable across filters, scopes, themes and statuses", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hq.theme.v1", "light"));
  const state = await fixture(page);
  state.rows[1]!.result!.evidence!.entries[0]!.schedule = { interval: "weekly", day: "monday", time: "12:00" };
  state.rows[5]!.result!.evidence!.entries[0]!.schedule = { interval: "weekly", day: "monday", time: "09:30" };
  await page.goto(href);
  const alpha = page.locator('[data-schedule-repository="schedule-0"]').getByRole("button", { name: /Observed/ });
  const beta = page.locator('[data-schedule-repository="schedule-1"]').getByRole("button", { name: /Observed/ });
  await expect(alpha).toBeVisible();
  const morning = await blockBackground(alpha);
  expect(await blockBackground(beta)).not.toBe(morning);
  const stale = page.locator('[data-schedule-repository="schedule-3"]').getByRole("button", { name: /Observed/ });
  expect(await blockBackground(stale)).toBe(morning);
  await page.getByLabel("Find a repository").fill("alpha");
  await expect(page.getByRole("button", { name: /^Observed/ })).toHaveCount(1);
  expect(await blockBackground(alpha)).toBe(morning);
  await page.getByLabel("Find a repository").fill("");
  await expect(beta).toBeVisible();
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  expect(await blockBackground(alpha)).toBe(morning);
  const { block } = await dayEditor(page);
  expect(await blockBackground(block)).toBe(morning);
  await page.getByLabel("Display timezone").selectOption("America/New_York");
  await expect(page.locator('[data-schedule-repository="schedule-0"]').getByRole("button", { name: /Observed.*04:00/ })).toBeVisible();
  expect(await blockBackground(page.locator('[data-schedule-repository="schedule-0"]').getByRole("button", { name: /Observed/ }))).not.toBe(morning);
});
test("matching times share their color and dragged draft colors follow the preview", async ({ page }) => {
  const state = await fixture(page);
  state.rows[1]!.result!.evidence!.entries[0]!.schedule!.time = "08:15";
  await page.goto(href);
  const { row, block } = await dayEditor(page);
  const morning = await blockBackground(block);
  const group = page.locator('[data-schedule-repository="schedule-5"]').getByRole("button", { name: /Observed/ });
  expect(await blockBackground(group)).toBe(morning);
  const stale = page.locator('[data-schedule-repository="schedule-3"]').getByRole("button", { name: /Observed/ });
  expect(await blockBackground(stale)).toBe(morning);
  const targetColor = await blockBackground(page.locator('[data-schedule-repository="schedule-1"]').getByRole("button", { name: /Observed/ }));
  await expect(block).toHaveClass(/has-overlap/);
  await block.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".schedule-drag-time")).toContainText("08:15");
  const ghost = page.locator(".schedule-drag-block");
  const proposed = await blockBackground(ghost);
  expect(proposed).not.toBe(morning);
  expect(proposed).toBe(targetColor);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".schedule-drag-time")).toContainText("08:30");
  expect(await blockBackground(ghost)).not.toBe(proposed);
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".schedule-drag-time")).toContainText("08:15");
  expect(await blockBackground(ghost)).toBe(proposed);
  await page.keyboard.press("Enter");
  const draft = row.getByRole("button", { name: /Draft.*08:15/ });
  await expect(draft).toBeVisible();
  await expect(draft).toHaveClass(/has-overlap/);
  expect(await blockBackground(draft)).toBe(proposed);
  expect(await blockBackground(block)).toBe(morning);
  await draft.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator(".schedule-drag-time")).toContainText("Tue");
  const destination = await blockBackground(ghost);
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Starting date")).toHaveValue("2026-10-27");
  expect(await blockBackground(page.locator('[data-schedule-repository="schedule-0"]').getByRole("button", { name: /Draft.*08:15/ }))).toBe(destination);
});

test("laptop workbench fits fleet assignments and scrolls weekdays independently", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const state = await fixture(page);
  state.rows.splice(0, state.rows.length, ...dependabotFleetBrowserRows());
  await page.goto(href);
  await expect(page.getByText(/55 of 55 repositories/)).toBeVisible();
  const first = page.locator(".schedule-week-marker").first();
  expect((await first.boundingBox())!.y).toBeLessThan(340);
  const visibleRows = () =>
    page
      .locator(".schedule-week-day")
      .first()
      .locator(".schedule-week-marker")
      .evaluateAll(
        (nodes) =>
          nodes.filter((node) => {
            const box = node.getBoundingClientRect(),
              parent = node.closest("ol")!.getBoundingClientRect();
            return (
              box.top >= parent.top &&
              box.bottom <= Math.min(parent.bottom, innerHeight)
            );
          }).length,
      );
  expect(await visibleRows()).toBeGreaterThanOrEqual(10);
  const days = await page
    .locator(".schedule-week-day")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().top),
    );
  expect(new Set(days).size).toBe(1);
  const monday = page.locator(".schedule-week-blocks").first(),
    tuesday = page.locator(".schedule-week-blocks").nth(1);
  await monday.evaluate((node) => (node.scrollTop = node.scrollHeight));
  expect(await monday.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect(await tuesday.evaluate((node) => node.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "Enter focus view" }).click();
  expect(await visibleRows()).toBeGreaterThanOrEqual(15);
  await page
    .getByRole("button", { name: "View Monday, October 26, 2026" })
    .click();
  const entries = page.locator(".schedule-day-scroll .schedule-entry");
  await expect.poll(() => entries.count()).toBeGreaterThan(15);
  expect((await entries.first().boundingBox())!.height).toBeLessThanOrEqual(44);
  expect(
    await entries.evaluateAll(
      (nodes) =>
        nodes.filter((node) => {
          const box = node.getBoundingClientRect(),
            parent = node
              .closest(".schedule-day-scroll")!
              .getBoundingClientRect();
          return box.top >= parent.top && box.bottom <= parent.bottom;
        }).length,
    ),
  ).toBeGreaterThanOrEqual(12);
  await page.getByRole("button", { name: "Exit focus view" }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("focus preserves drafts and filters while dialogs and move cancellation remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const state = await fixture(page);
  await page.goto(href);
  await page.getByRole("button", { name: "Enter focus view" }).click();
  const { block } = await dayEditor(page);
  await block.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Exit focus view" }),
  ).toBeVisible();
  await expect(page.locator(".schedule-drag-ghost")).toHaveCount(0);
  await block.click();
  await page.getByLabel("Time", { exact: true }).fill("09:30");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByLabel("Find a repository").fill("beta");
  await expect(
    page.getByRole("button", { name: "Review changes" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Exit focus view" }).click();
  await expect(page.getByLabel("Find a repository")).toHaveValue("beta");
  await expect(page.getByLabel("View", { exact: true })).toHaveValue("day");
  await page.getByRole("button", { name: "Enter focus view" }).click();
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Prepare review" }).click();
  await expect(
    page.getByRole("button", { name: "Create pull request" }),
  ).toBeVisible();
  expect(state.calls).not.toContain("dependabot_change_apply");
});

for (const theme of ["light", "dark"])
  test(`${theme} compact focus keeps mobile options, dialogs and navigation accessible`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(t => localStorage.setItem("hq.theme.v1", t), theme);
    await fixture(page);
    await page.goto(href);
    await showOptions(page);
    const options = await page.locator(".schedule-options-panel").boundingBox();
    expect(options!.x).toBeGreaterThanOrEqual(0);
    expect(options!.x + options!.width).toBeLessThanOrEqual(390);
    await showOptions(page, false);
    await page.getByRole("button", { name: "Enter focus view" }).click();
    await expect(page.getByRole("navigation", { name: "Main navigation", exact: true })).toHaveCount(0);
    await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
    await showOptions(page);
    await expect(page.locator(".schedule-options-panel")).toBeInViewport({ ratio: 1 });
    await showOptions(page, false);
    const { block } = await dayEditor(page);
    await block.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("time[datetime]")).toBeVisible();
    await page.getByLabel("Time", { exact: true }).fill("09:30");
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("button", { name: "Review changes" })).toBeVisible();
    const workbench = page.getByRole("region", { name: "Dependabot schedules", exact: true });
    expect((await workbench.boundingBox())!.height).toBe(844);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(async () => (await workbench.boundingBox())!.height).toBe(720);
    const draft = page.getByRole("button", { name: /Draft.*09:30/ });
    await draft.focus();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Exit focus view" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Enter focus view" })).toBeVisible();
    expect(await page.locator(".sidebar").getAttribute("inert")).toBeNull();
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Enter focus view" }).click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

test("compact Day exposes a placed schedule's projection limit and its detail", async ({ page }) => {
  const state = await fixture(page);
  state.rows.splice(1);
  state.rows[0]!.result!.evidence!.entries[0]!.schedule = { interval: "cron", cronjob: "*/15 * * * *" };
  await page.goto(href + "&scheduleMode=day");
  await expect(page.locator(".schedule-time-block")).toHaveCount(64);
  await expect.soft(page.getByRole("status").filter({ hasText: "Display limit reached" })).toBeVisible();
  const label = page.locator(".schedule-row-label");
  await expect.soft(label).toHaveAccessibleName(/Too many occurrences to plot completely/);
  await label.click();
  await expect(page.getByRole("dialog").getByText("Too many occurrences to plot completely", { exact: true })).toBeVisible();
});

for (const mode of ["week", "day"])
  test(`${mode} distinguishes unavailable repository reads before disclosure`, async ({ page }) => {
    const state = await fixture(page);
    state.rows.splice(1);
    const evidence = state.rows[0]!.result!.evidence!;
    evidence.read = { state: "unavailable", reason: "credential" };
    evidence.configuration = "unknown";
    evidence.file = null;
    evidence.entries = [];
    await page.goto(href + "&scheduleMode=" + mode);
    await expect(page.getByText(/1 of 1 repositories/)).toBeVisible();
    await expect(page.locator(".schedule-other summary")).toContainText("1 repository unavailable");
    await expect(page.locator(".schedule-other")).not.toHaveAttribute("open", "");
    await showOther(page);
    await expect(page.getByText("Read unavailable: credential", { exact: true }).first()).toBeVisible();
  });

test("hover distinguishes repeated repository assignments without opening the editor", async ({ page }) => {
  const state = await fixture(page);
  const original = state.rows[0]!.result!.evidence!.entries[0]!;
  state.rows[0]!.result!.evidence!.entries = ["npm", "docker", "cargo"].map((ecosystem, index) => ({
    ...structuredClone(original),
    id: DIGEST + ":update:" + index,
    members: [{ ecosystem, directories: [index ? "/packages/" + ecosystem : "/"], targetBranch: index === 1 ? "release/1.0" : null }],
  }));
  await page.goto(href);
  const blocks = page.locator('[data-schedule-repository="schedule-0"] .schedule-week-marker');
  await expect(blocks).toHaveCount(3);
  for (const [index, ecosystem] of ["npm", "docker", "cargo"].entries()) {
    await blocks.nth(index).hover();
    const preview = page.getByRole("tooltip");
    await expect(preview).toContainText("example/alpha");
    await expect(preview).toContainText(ecosystem);
    await expect(preview).toContainText(index ? "/packages/" + ecosystem : "Repository root (/)");
    await expect(preview).toContainText(index === 1 ? "release/1.0" : "Default branch");
    await expect(preview).toContainText("weekly");
    await expect(preview).toContainText("08:00 UTC");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  expect(state.calls).not.toContain("repository_dependabot");
  expect(state.calls).not.toContain("dependabot_change_plan");
});

test("assignment focus previews are hoverable, dismiss before focus view and yield to moves", async ({ page }) => {
  await fixture(page);
  await page.goto(href);
  await page.getByRole("button", { name: "Enter focus view" }).click();
  const group = page.locator('[data-schedule-repository="schedule-5"]').getByRole("button", { name: /Observed/ });
  await group.focus();
  const preview = page.getByRole("tooltip");
  await expect(preview).toContainText("frontend");
  await expect(preview).toContainText("npm");
  await expect(preview).toContainText("docker");
  await expect(preview.getByText("Repository root (/)", { exact: true })).toHaveCount(2);
  await expect(group).toHaveAccessibleDescription(/Space picks up a block/);
  await expect(group).toHaveAccessibleDescription(/frontend/);
  await preview.hover();
  await expect(preview).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Exit focus view" })).toBeVisible();
  await expect(group).toBeFocused();
  const { block } = await dayEditor(page);
  await block.focus();
  await expect(preview).toBeVisible();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await expect(preview).toHaveCount(0);
  await expect(page.locator(".schedule-drag-time")).toContainText("08:15 UTC");
  await page.keyboard.press("Enter");
  const draft = page.getByRole("button", { name: /Draft.*example\/alpha.*08:15/ });
  await expect(draft).toBeFocused();
  await page.keyboard.press("Tab");
  await draft.focus();
  await expect(preview).toContainText("Local draft");
  await expect(preview).toContainText("08:15 UTC");
  await expect(preview).toContainText("08:15");
});

for (const theme of ["light", "dark"])
  test(`${theme} assignment preview fits the mobile viewport and leaves click editing available`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(value => localStorage.setItem("hq.theme.v1", value), theme);
    const state = await fixture(page);
    const entry = state.rows[0]!.result!.evidence!.entries[0]!;
    entry.members[0]!.directories = ["/packages/" + "long-directory-".repeat(12)];
    await page.goto(href);
    const block = page.locator('[data-schedule-repository="schedule-0"]').getByRole("button", { name: /Observed/ });
    await block.focus();
    const preview = page.getByRole("tooltip");
    await expect(preview).toBeVisible();
    await expect(preview).toBeInViewport({ ratio: 1 });
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(preview).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

test("large grouped previews disclose omitted details without a keyboard-inaccessible scroll panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  const state = await fixture(page);
  const entry = state.rows[5]!.result!.evidence!.entries[0]!;
  entry.members = Array.from({ length: 5 }, (_, member) => ({
    ecosystem: "npm",
    directories: Array.from({ length: 5 }, (_, directory) => "/packages/" + member + "/" + directory + "/" + "long-name-".repeat(12)),
    targetBranch: "release/" + member,
  }));
  await page.goto(href);
  await page.getByRole("button", { name: "Enter focus view" }).click();
  const block = page.locator('[data-schedule-repository="schedule-5"]').getByRole("button", { name: /Observed/ });
  await block.focus();
  const preview = page.getByRole("tooltip");
  await expect(preview.getByText("Preview shortened. Open assignment for full details.", { exact: true })).toBeVisible();
  await expect(preview).toBeInViewport({ ratio: 1 });
  await expect(block).toHaveAccessibleDescription(/2 more members in details/);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog").locator(".schedule-member-details")).toHaveCount(5);
});

for (const [observedHour, draftHour] of [[1, 3], [3, 1]])
  test(`hover projection warnings follow observed ${observedHour} and draft ${draftHour} across DST`, async ({ page }) => {
    const state = await fixture(page);
    state.rows.splice(1);
    state.rows[0]!.result!.evidence!.entries[0]!.schedule = {
      interval: "cron", cronjob: "30 " + observedHour + " * * *", timezone: "America/New_York",
    };
    await page.goto(href.replace("scheduleZone=UTC", "scheduleZone=America%2FNew_York"));
    const monday = page.locator(".schedule-week-day").first();
    const observed = monday.getByRole("button", { name: /Observed/ });
    await observed.click();
    await page.getByLabel("Cron expression").fill("30 " + draftHour + " * * *");
    await page.getByRole("button", { name: "Save draft" }).click();
    await observed.hover();
    const preview = page.getByRole("tooltip");
    await expect(preview).toContainText("Schedule: 30 " + observedHour + " * * *");
    if (observedHour === 1) await expect.soft(preview).toContainText("Ambiguous or nonexistent local time");
    else await expect.soft(preview).not.toContainText("Ambiguous or nonexistent local time");
    await monday.getByRole("button", { name: /Draft/ }).hover();
    await expect(preview).toContainText("Schedule: 30 " + draftHour + " * * *");
    if (draftHour === 1) await expect(preview).toContainText("Ambiguous or nonexistent local time");
    else await expect(preview).not.toContainText("Ambiguous or nonexistent local time");
  });
