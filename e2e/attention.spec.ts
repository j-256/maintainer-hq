import { test, expect, type Page } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { attentionFixture } from "./attention-fixture";
import { mockWorkspaceView } from "./workspace-fixture";
import { DEFAULT_EXPECTATIONS, type Repository } from "../shared/domain";

const BASE = "/overview?workspace=development";
async function expectContainedMetrics(page: Page) {
  expect(
    await page.locator(".attention-metric > strong").evaluateAll((elements) =>
      elements.every((element) => {
        const value = element.getBoundingClientRect();
        const card = element.parentElement!.getBoundingClientRect();
        return (
          value.left >= card.left &&
          value.right <= card.right &&
          value.top >= card.top &&
          value.bottom <= card.bottom
        );
      }),
    ),
  ).toBe(true);
}
async function populate(page: Page) {
  const fixture = attentionFixture();
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/commands/"))
      calls.push({
        name: request.url().split("/").at(-1)!,
        input: request.postDataJSON(),
      });
  });
  await mockWorkspaceView(page, (snapshot) => ({ ...snapshot, ...fixture }));
  await page.route("**/api/commands/attention_connection", (route) =>
    route.fulfill({ json: fixture.response(route.request().postDataJSON()) }),
  );
  return { fixture, calls };
}
test("opening HQ and its logo lead to Overview without first reading Activity", async ({
  page,
}) => {
  const { calls } = await populate(page);
  await page.goto("/?workspace=development");
  await expect(page).toHaveURL(/\/overview\?workspace=development$/);
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  expect(
    calls
      .filter((call) => call.name === "workspace_view")
      .map((call) => call.input.view),
  ).toEqual(["overview"]);
  expect(calls.some((call) => call.name === "activity_feed")).toBe(false);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Activity", exact: true })
    .click();
  await expect(page).toHaveURL(/\/activity\?workspace=development$/);
  await page.getByRole("link", { name: "maintainerhq", exact: true }).click();
  await expect(page).toHaveURL(/\/overview\?workspace=development$/);
});
for (const theme of ["light", "dark"])
  for (const width of [1440, 390, 320])
    test(`actionable Overview is readable and navigable in ${theme} at ${width}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(
        (theme) => localStorage.setItem("hq.theme.v1", theme),
        theme,
      );
      await populate(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(BASE);
      await expect(
        page.getByText("Hook delivery exhausted retries", { exact: true }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("list", { name: "Attention items" })
          .locator("li")
          .first(),
      ).toContainText("Monitoring check failed");
      await expect(
        page
          .getByRole("list", { name: "Attention items" })
          .locator("li")
          .first(),
      ).toContainText("Not linked to a project or repository");
      await expect(
        page.getByText("Synthetic raw summary should not appear in attention"),
      ).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "Inspect delivery", exact: true }),
      ).toHaveAttribute("href", /event=synthetic-event&sink=phone/);
      const reviews = page.getByRole("button", { name: /^Reviews / });
      await reviews.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/attention=review/);
      await expect(
        page.getByText("Portfolio review overdue", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", {
          name: "Independent project / high importance",
          exact: true,
        }),
      ).toBeVisible();
      const reviewAudit = await new AxeBuilder({ page }).analyze();
      expect(reviewAudit.violations).toEqual([]);
      expect(reviewAudit.incomplete).toEqual([]);
      await page
        .getByRole("button", { name: "All attention", exact: true })
        .click();
      await expect(
        page.getByRole("list", { name: "Attention items" }),
      ).toBeVisible();
      const audit = await new AxeBuilder({ page }).analyze();
      expect(audit.violations).toEqual([]);
      expect(audit.incomplete).toEqual([]);
      await expectContainedMetrics(page);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath("overview.png"),
        fullPage: true,
      });
      expect(errors).toEqual([]);
    });

test("attention descriptions and counts honor enlarged text on narrow screens", async ({
  page,
}) => {
  await populate(page);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(BASE);
    await expect(
      page.getByText("Hook delivery exhausted retries", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "125%";
    });
    await expect(page.locator(".attention-row p").first()).toHaveCSS(
      "font-size",
      "18.75px",
    );
    await expectContainedMetrics(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const previews = page.getByRole("button", {
      name: "Inspect operational previews",
      exact: true,
    });
    await expect(previews).toHaveAccessibleDescription(/2 of 3 connections/);
    await previews.focus();
    await page.keyboard.press("Enter");
    await expect(previews).toHaveAttribute("aria-expanded", "true");
    await expect(previews).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

test("operational refresh becomes fully opaque as soon as it is enabled", async ({
  page,
}) => {
  const { fixture } = await populate(page);
  let release!: () => void;
  const readsReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/commands/attention_connection", async (route) => {
    if (route.request().postDataJSON().connectionId === "attention-hooks") {
      await readsReady;
    }
    await route.fulfill({
      json: fixture.response(route.request().postDataJSON()),
    });
  });
  try {
    await page.goto(BASE);
    const refresh = page.getByRole("button", {
      name: "Refresh operations",
      exact: true,
    });
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveCSS("opacity", "0.5");
    await refresh.evaluate((element) => {
      (
        window as unknown as { attentionEnabledOpacity?: string }
      ).attentionEnabledOpacity = undefined;
      new MutationObserver((_records, observer) => {
        if ((element as HTMLButtonElement).disabled) return;
        (
          window as unknown as { attentionEnabledOpacity?: string }
        ).attentionEnabledOpacity = getComputedStyle(element).opacity;
        observer.disconnect();
      }).observe(element, { attributes: true, attributeFilter: ["disabled"] });
    });
    release();
    await expect(refresh).toBeEnabled();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { attentionEnabledOpacity?: string })
            .attentionEnabledOpacity,
      ),
    ).toBe("1");
    const audit = await new AxeBuilder({ page }).analyze();
    expect(audit.violations).toEqual([]);
    expect(audit.incomplete).toEqual([]);
  } finally {
    release();
  }
});

test("attention keeps URL filters, bounded connection reads and item pagination separate", async ({
  page,
}) => {
  const { calls } = await populate(page);
  await page.goto(BASE);
  await expect(
    page.getByText("Hook delivery exhausted retries", { exact: true }),
  ).toBeVisible();
  const names = () =>
    [
      ...new Set(
        calls
          .filter((call) => call.name === "attention_connection")
          .map((call) => call.input.connectionId),
      ),
    ].sort();
  expect(names()).toEqual(["attention-hooks", "attention-monitors"]);
  expect(
    calls.some((call) =>
      /workspace_snapshot|activity_feed|github_refresh|monitoring_configuration/.test(
        call.name,
      ),
    ),
  ).toBe(false);
  await page
    .getByRole("navigation", { name: "Attention pagination" })
    .getByRole("button", { name: "Next", exact: true })
    .click();
  await expect(page).toHaveURL(/page=2/);
  await expect(
    page.getByRole("status").filter({ hasText: /attention items/ }),
  ).toBeFocused();
  await page
    .getByRole("textbox", { name: "Search attention" })
    .fill("Independent project");
  await expect(page).not.toHaveURL(/page=2/);
  await expect(
    page.getByText("Portfolio review overdue", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Search attention" }),
  ).toHaveValue("Independent project");
  await page
    .getByRole("button", { name: "Inspect operational previews", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Next connections", exact: true })
    .click();
  await expect
    .poll(names)
    .toEqual(["attention-hooks", "attention-monitors", "attention-other"]);
  await expect(page).toHaveURL(/connectionsPage=2/);
});

test("operational read failure stays a coverage gap and recovers without losing search", async ({
  page,
}) => {
  const { fixture } = await populate(page);
  let retry = false;
  await page.exposeFunction("allowAttentionRetry", () => {
    retry = true;
  });
  await page.addInitScript(() =>
    document.addEventListener(
      "click",
      (event) => {
        if (
          (event.target as Element).closest(
            'button[aria-label="Retry Primary hooks"]',
          )
        )
          void (
            window as unknown as { allowAttentionRetry: () => Promise<void> }
          ).allowAttentionRetry();
      },
      true,
    ),
  );
  await page.route("**/api/commands/attention_connection", (route) => {
    const input = route.request().postDataJSON();
    return input.connectionId === "attention-hooks" && !retry
      ? route.fulfill({
          status: 503,
          json: {
            error: {
              code: "provider_unavailable",
              message: "Safe provider read failed",
            },
          },
        })
      : route.fulfill({ json: fixture.response(input) });
  });
  await page.goto(BASE + "&attention=coverage&q=Primary+hooks");
  await expect(
    page.getByText("Operational evidence could not be refreshed", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect operational previews", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retry Primary hooks", exact: true })
    .click();
  await expect(
    page.getByText("Operational evidence could not be refreshed", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Search attention" }),
  ).toHaveValue("Primary hooks");
  await page
    .getByRole("button", { name: "All attention", exact: true })
    .click();
  await expect(
    page.getByText("Hook delivery exhausted retries", { exact: true }),
  ).toBeVisible();
});

test("operational previews age visibly without a new HTTP polling loop", async ({
  page,
}) => {
  await page.clock.install();
  const { calls } = await populate(page);
  await page.goto(BASE + "&q=Primary+hooks");
  await expect(
    page.getByText("Hook delivery exhausted retries", { exact: true }),
  ).toBeVisible();
  const reads = () =>
    calls.filter((call) => call.name === "attention_connection").length;
  const initial = reads();
  await page.clock.fastForward(90_000);
  await expect(
    page.getByText("Last known: Hook delivery exhausted retries", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Operational preview needs a refresh", { exact: true }),
  ).toBeVisible();
  expect(reads()).toBe(initial);
  await expect(
    page.getByRole("textbox", { name: "Search attention" }),
  ).toHaveValue("Primary hooks");
  await page
    .getByRole("button", { name: "Inspect operational previews", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Refresh operations", exact: true }),
  ).toBeEnabled();
});

test("real Overview push updates a review without reloading the view or disturbing its filters", async ({
  page,
  request,
}) => {
  const workspaceId = "polling-test";
  async function api<T>(name: string, input: object): Promise<T> {
    const response = await request.post("/api/commands/" + name, {
      headers: { "X-HQ-Client": "cli" },
      data: { workspaceId, ...input },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }
  const fields = {
    fullName: "example/attention-push-" + crypto.randomUUID(),
    description: "Synthetic attention push",
    projectId: "polling-default",
    classification: "maintained",
    lifecycle: "active",
    expectations: { ...DEFAULT_EXPECTATIONS, reviewDate: "2020-01-01" },
  };
  const repo = await api<Repository>("repository_create", {
    repository: fields,
  });
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/commands/"))
      calls.push(request.url().split("/").at(-1)!);
  });
  await page.goto(
    "/overview?workspace=" +
      workspaceId +
      "&attention=review&q=" +
      encodeURIComponent(repo.fullName),
  );
  await expect(
    page.getByText("Expectation review overdue", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".connection-state")).toContainText("Live updates");
  await page.waitForLoadState("networkidle");
  const initial = [...calls];
  await api("activity_add", {
    eventId: crypto.randomUUID(),
    kind: "note",
    title: "Off-tab Overview activity",
    summary: "Synthetic verification",
    resourceId: repo.id,
    goalId: null,
  });
  await page.waitForLoadState("networkidle");
  expect(calls).toEqual(initial);
  await api("repository_update", {
    repositoryId: repo.id,
    revision: repo.revision,
    repository: {
      ...fields,
      expectations: { ...fields.expectations, reviewDate: null },
    },
  });
  await expect(
    page.getByText("Expectation review overdue", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No matches", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Search attention" }),
  ).toHaveValue(repo.fullName);
  await expect(page).toHaveURL(/attention=review/);
  expect(calls).toEqual(initial);
  expect(calls).not.toContain("workspace_snapshot");
  expect(calls).not.toContain("activity_feed");
});
