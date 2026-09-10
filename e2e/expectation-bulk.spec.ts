import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { DEFAULT_EXPECTATIONS, type Repository } from "../shared/domain";

const WORKSPACE = "expectations-test";
const BASE = "/repositories?workspace=" + WORKSPACE;
const COUNT = 52;
async function command<T>(
  request: APIRequestContext,
  name: string,
  data: object,
): Promise<T> {
  const response = await request.post("/api/commands/" + name, {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId: WORKSPACE, ...data },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function choose(page: Page, label: string, value: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}
async function audit(page: Page, dialog = true) {
  if (dialog)
    await page.getByRole("dialog").evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
  const builder = new AxeBuilder({ page });
  const result = await (
    dialog ? builder.include('[role="dialog"]') : builder
  ).analyze();
  expect(result.violations).toEqual([]);
  for (const finding of result.incomplete) {
    expect(finding.id).toBe("color-contrast");
    for (const node of finding.nodes) {
      expect(node.target).toHaveLength(1);
      for (const check of node.any)
        expect(["pseudoContent", "elmPartiallyObscuring"]).toContain(
          check.data?.messageKey,
        );
      const measured = await page
        .locator(node.target[0] as string)
        .evaluate((element) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          function rgb(color: string) {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
          }
          function luminance(color: number[]) {
            const [r, g, b] = color
              .slice(0, 3)
              .map((channel) => channel / 255)
              .map((channel) =>
                channel <= 0.04045
                  ? channel / 12.92
                  : ((channel + 0.055) / 1.055) ** 2.4,
              );
            return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
          }
          const foreground = rgb(getComputedStyle(element).color);
          let background: number[] | undefined;
          for (
            let ancestor: Element | null = element;
            ancestor;
            ancestor = ancestor.parentElement
          ) {
            const style = getComputedStyle(ancestor);
            if (style.backgroundImage !== "none" || Number(style.opacity) !== 1)
              throw new Error(
                "Layered contrast requires a separate visual review",
              );
            const sample = rgb(style.backgroundColor);
            if (sample[3] === 255) {
              background = sample;
              break;
            }
            if (sample[3] !== 0)
              throw new Error(
                "Translucent contrast requires a separate visual review",
              );
          }
          if (!background || foreground[3] !== 255)
            throw new Error("No opaque contrast pair");
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          );
          let textNode: Node | null;
          let visibleRects = 0;
          while ((textNode = walker.nextNode())) {
            if (!textNode.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(textNode);
            for (const rect of range.getClientRects()) {
              if (rect.width === 0 || rect.height === 0) continue;
              const top = document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              );
              if (!top || !element.contains(top))
                throw new Error("Text is obscured or clipped");
              visibleRects++;
            }
          }
          const f = luminance(foreground),
            b = luminance(background);
          return {
            contrast: (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05),
            visibleRects,
          };
        });
      expect(measured.visibleRects).toBeGreaterThan(0);
      expect(measured.contrast).toBeGreaterThanOrEqual(4.5);
    }
  }
}
async function open(page: Page) {
  await page.goto(BASE);
  await page
    .getByRole("button", { name: "Set expectations", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
async function configureOne(page: Page) {
  await page
    .getByRole("checkbox", {
      name: "example/bulk-00 Maintained",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Choose changes", exact: true })
    .click();
  await choose(page, "Expectation preset", "Running service");
}
test.beforeAll(async ({ request }) => {
  const existing = await command<Repository[]>(
    request,
    "repositories_list",
    {},
  );
  for (let i = 0; i < COUNT; i++) {
    const fullName = "example/bulk-" + String(i).padStart(2, "0");
    if (!existing.some((row) => row.fullName === fullName))
      await command(request, "repository_create", {
        repository: {
          fullName,
          description: "Synthetic selection fixture",
          projectId: "expectations-default",
          classification: i % 2 ? "watchlist" : "maintained",
          lifecycle: i >= 50 ? "archived" : "active",
          expectations: { ...DEFAULT_EXPECTATIONS, note: "Keep note " + i },
        },
      });
  }
});
test.beforeEach(async ({ request }) => {
  for (const repo of (
    await command<Repository[]>(request, "repositories_list", {})
  ).filter(
    (row) =>
      row.fullName.endsWith("bulk-00") || row.fullName.endsWith("bulk-01"),
  ))
    await command(request, "repository_update", {
      repositoryId: repo.id,
      revision: repo.revision,
      repository: {
        fullName: repo.fullName,
        description: repo.description,
        projectId: repo.projectId,
        lifecycle: repo.lifecycle,
        classification: repo.classification,
        expectations: {
          ...DEFAULT_EXPECTATIONS,
          note: repo.expectations.note,
        },
      },
    });
});

test("selection is explicit, bounded and preserved across filters and pages", async ({
  page,
}) => {
  await open(page);
  await expect(
    page.getByRole("button", { name: "Choose changes" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Select this page" }).click();
  await expect(
    page.getByText("25 of 50 selected", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Selection pages" })
    .getByRole("button", { name: "Next" })
    .click();
  await page.getByRole("button", { name: "Select this page" }).click();
  await expect(
    page.getByText("50 of 50 selected", { exact: true }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: "Include archived" }).check();
  await page
    .getByRole("navigation", { name: "Selection pages" })
    .getByRole("button", { name: "Next" })
    .click();
  await page
    .getByRole("navigation", { name: "Selection pages" })
    .getByRole("button", { name: "Next" })
    .click();
  await expect(
    page.getByRole("button", { name: "Select this page" }),
  ).toBeDisabled();
  for (const checkbox of await page
    .getByRole("list", { name: "Repositories to change" })
    .getByRole("checkbox")
    .all())
    await expect(checkbox).toBeDisabled();
  await page.getByRole("button", { name: "Clear selection" }).click();
  await choose(page, "Select by tracking", "Maintained");
  await page
    .getByRole("textbox", { name: "Find repositories to change" })
    .fill("bulk-00");
  await expect(
    page.getByRole("list", { name: "Repositories to change" }).locator("li"),
  ).toHaveCount(1);
  await page
    .getByRole("checkbox", {
      name: "example/bulk-00 Maintained",
      exact: true,
    })
    .check();
  await page
    .getByRole("textbox", { name: "Find repositories to change" })
    .fill("no-match");
  await expect(
    page.getByText("1 of 50 selected", { exact: true }),
  ).toBeVisible();
});

test("presets and exceptions apply only reviewed fields and restore a receipt after reload", async ({
  page,
  request,
}) => {
  await open(page);
  await page
    .getByRole("checkbox", {
      name: "example/bulk-00 Maintained",
      exact: true,
    })
    .check();
  await page
    .getByRole("checkbox", {
      name: "example/bulk-01 Watchlist",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Choose changes" }).click();
  await expect(
    page.getByRole("button", { name: "Review changes" }),
  ).toBeDisabled();
  await choose(page, "Expectation preset", "Running service");
  const exception = page.locator(".expectation-row").filter({
    has: page.getByRole("heading", {
      name: "example/bulk-01",
      exact: true,
    }),
  });
  await exception.locator("summary").click();
  await exception
    .getByRole("checkbox", {
      name: "Override Endpoint monitoring",
      exact: true,
    })
    .check();
  await exception
    .getByRole("combobox", { name: "Endpoint monitoring", exact: true })
    .click();
  await page.getByRole("option", { name: "Optional", exact: true }).click();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Review expectation changes",
      exact: true,
    }),
  ).toBeFocused();
  await expect(page).toHaveURL(/expectationReview=/);
  await expect(
    page.getByRole("button", {
      name: "Apply to 2 repositories",
      exact: true,
    }),
  ).toBeEnabled();
  const reviewUrl = page.url();
  await page
    .getByRole("button", { name: "Apply to 2 repositories", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Expectations updated",
      exact: true,
    }),
  ).toBeVisible();
  const updated = await command<Repository[]>(request, "repositories_list", {});
  for (const [suffix, expected] of [
    ["bulk-00", "required"],
    ["bulk-01", "optional"],
  ]) {
    const repo = updated.find((row) => row.fullName.endsWith(suffix!))!;
    expect(repo.expectations.monitoring).toBe(expected);
    expect(repo.expectations.note).toBe(
      "Keep note " + Number(suffix!.slice(-2)),
    );
    expect(repo.expectations.hooks).toBe("unmanaged");
  }
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Expectations updated",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(reviewUrl);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Set expectations", exact: true }),
  ).toBeFocused();
});

test("an interrupted Apply keeps its identity and checks the committed receipt without applying twice", async ({
  page,
  request,
}) => {
  await page.clock.install();
  await open(page);
  await configureOne(page);
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await page.route("**/api/commands/expectations_apply", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    await route.abort();
  });
  await page
    .getByRole("button", { name: "Apply to 1 repository", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry same review", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Back to choices", exact: true }),
  ).toBeDisabled();
  await page.clock.fastForward(6 * 60 * 1000);
  await expect(page.getByRole("dialog")).toContainText(
    "An earlier Apply may still finish",
  );
  await expect(
    page.getByRole("button", { name: "Retry same review", exact: true }),
  ).toBeEnabled();
  const before = (
    await command<Repository[]>(request, "repositories_list", {})
  ).find((row) => row.fullName.endsWith("bulk-00"))!;
  await page
    .getByRole("button", { name: "Check saved receipt", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Expectations updated",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await command<Repository[]>(request, "repositories_list", {})).find(
      (row) => row.id === before.id,
    )?.revision,
  ).toBe(before.revision);
});

test("a concurrent edit rejects the whole batch and keeps choices through baseline refresh", async ({
  page,
  request,
}) => {
  await open(page);
  await configureOne(page);
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const repo = (
    await command<Repository[]>(request, "repositories_list", {})
  ).find((row) => row.fullName.endsWith("bulk-00"))!;
  await command(request, "repository_update", {
    repositoryId: repo.id,
    revision: repo.revision,
    repository: {
      fullName: repo.fullName,
      description: "Concurrent edit " + repo.revision,
      projectId: repo.projectId,
      classification: repo.classification,
      lifecycle: repo.lifecycle,
      expectations: repo.expectations,
    },
  });
  await page
    .getByRole("button", { name: "Apply to 1 repository", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "No expectation changes were applied",
  );
  await page
    .getByRole("button", { name: "Back to choices", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Use latest repository versions",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("combobox", {
      name: "Endpoint monitoring",
      exact: true,
    }),
  ).toContainText("Required");
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Apply to 1 repository",
      exact: true,
    }),
  ).toBeEnabled();
});

for (const state of ["ready", "stale", "expired"] as const)
  test(`unconfirmed expectation Apply retains its exact recovery target across a ${state} reload`, async ({
    page,
  }) => {
    await open(page);
    await configureOne(page);
    await page
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
    await expect(page).toHaveURL(/expectationReview=/);
    const url = page.url();
    await page.route("**/api/commands/expectations_apply", (route) =>
      route.abort(),
    );
    await page
      .getByRole("button", { name: "Apply to 1 repository", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Retry same review", exact: true }),
    ).toBeEnabled();
    await page.route("**/api/commands/expectations_review", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: {
          ...(await response.json()),
          state,
          expiresAt: new Date(
            Date.now() + (state === "expired" ? -1000 : 60000),
          ).toISOString(),
        },
      });
    });
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Retry same review", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Back to choices", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Check saved receipt", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Retry same review", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Back to choices", exact: true }),
    ).toBeDisabled();
    expect(page.url()).toBe(url);
    await page.unroute("**/api/commands/expectations_review");
    await page.unroute("**/api/commands/expectations_apply");
    await page
      .getByRole("button", { name: "Retry same review", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Expectations updated",
        exact: true,
      }),
    ).toBeVisible();
    expect(page.url()).toBe(url);
  });

test("closing an unconfirmed Apply preserves a recovery URL without claiming it was discarded", async ({
  page,
  request,
}) => {
  await open(page);
  await configureOne(page);
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(page).toHaveURL(/expectationReview=/);
  const reviewUrl = page.url();
  await page.route("**/api/commands/expectations_apply", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    await route.abort();
  });
  await page
    .getByRole("button", { name: "Apply to 1 repository", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry same review", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const warning = page.getByRole("alertdialog");
  await expect(warning).toContainText("Closing does not cancel Apply");
  await expect(
    warning.getByRole("textbox", { name: "Saved review URL", exact: true }),
  ).toHaveValue(reviewUrl);
  await expect(
    warning.getByRole("button", { name: "Discard changes", exact: true }),
  ).toHaveCount(0);
  await warning
    .getByRole("button", { name: "Keep review open", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry same review", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await warning
    .getByRole("button", { name: "Close editor", exact: true })
    .click();
  await expect(page).not.toHaveURL(/expectationReview=/);
  const before = (
    await command<Repository[]>(request, "repositories_list", {})
  ).find((row) => row.fullName.endsWith("bulk-00"))!;
  await page.goto(reviewUrl);
  await expect(
    page.getByRole("heading", {
      name: "Expectations updated",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await command<Repository[]>(request, "repositories_list", {})).find(
      (row) => row.id === before.id,
    )?.revision,
  ).toBe(before.revision);
});

for (const theme of ["light", "dark"])
  for (const width of [1440, 390, 320])
    test(`expectation setup is readable and keyboard-accessible in ${theme} at ${width}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (theme) => localStorage.setItem("hq.theme.v1", theme),
        theme,
      );
      await page.goto(BASE);
      await expect(
        page.getByRole("button", { name: "Set expectations", exact: true }),
      ).toBeEnabled();
      await audit(page, false);
      await page
        .getByRole("button", { name: "Set expectations", exact: true })
        .click();
      const checkbox = page.getByRole("checkbox", {
        name: "example/bulk-00 Maintained",
        exact: true,
      });
      await checkbox.focus();
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
      await audit(page);
      await page
        .getByRole("button", { name: "Choose changes", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "Expectation preset", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("option", { name: "Running service", exact: true })
        .click();
      await expect(
        page.getByRole("checkbox", {
          name: "Change Endpoint monitoring",
          exact: true,
        }),
      ).toBeChecked();
      await audit(page);
      expect(
        await page
          .locator(".expectation-dialog")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      expect(
        await page
          .locator(".expectation-scroll")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("expectation-editor.png"),
      });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await page
        .getByRole("button", { name: "Keep editing", exact: true })
        .click();
      await expect(
        page.getByRole("checkbox", {
          name: "Change Endpoint monitoring",
          exact: true,
        }),
      ).toBeChecked();
      await page
        .getByRole("button", { name: "Review changes", exact: true })
        .click();
      await audit(page);
      await page
        .getByRole("button", { name: "Apply to 1 repository", exact: true })
        .focus();
      for (let index = 0; index < 10; index++) {
        await page.keyboard.press("Tab");
        expect(
          await page
            .getByRole("dialog")
            .evaluate((element) => element.contains(document.activeElement)),
        ).toBe(true);
      }
      await page.screenshot({
        path: testInfo.outputPath("expectation-review.png"),
      });
      await page
        .getByRole("button", { name: "Apply to 1 repository", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", {
          name: "Expectations updated",
          exact: true,
        }),
      ).toBeVisible();
      await audit(page);
      await page.screenshot({
        path: testInfo.outputPath("expectation-receipt.png"),
      });
      await page.getByRole("button", { name: "Done", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("button", { name: "Set expectations", exact: true }),
      ).toBeFocused();
    });
