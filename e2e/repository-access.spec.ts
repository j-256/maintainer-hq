import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  DEFAULT_EXPECTATIONS,
  ROLE_CAPABILITIES,
  type Repository,
} from "../shared/domain";
import {
  hqOperationGates,
  type RepositoryAccess,
} from "../shared/repository-access";
import { mockWorkspaceView } from "./workspace-fixture";
import { verifyFlatContrast } from "./flat-contrast";

const workspaceId = "development";
async function setup(request: APIRequestContext, enroll = true) {
  const response = await request.post("/api/commands/repository_create", {
    headers: { "X-HQ-Client": "cli" },
    data: {
      workspaceId,
      repository: {
        fullName: "example/access-" + crypto.randomUUID(),
        description: "Synthetic permission guidance",
        projectId: "development-default",
        classification: "watchlist",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const repository: Repository = await response.json();
  const sourceId = "access-" + crypto.randomUUID();
  if (enroll) {
    const source = await request.post("/api/commands/github_source_enroll", {
      headers: { "X-HQ-Client": "cli" },
      data: {
        workspaceId,
        sourceId,
        source: {
          name: "Read-only evidence source",
          repositoryIds: [repository.id],
          credentialRef: null,
          enabled: false,
          refreshIntervalMinutes: 15,
          freshnessMinutes: 30,
        },
      },
    });
    expect(source.ok(), await source.text()).toBeTruthy();
  }
  const href = `/repositories/${repository.id}?workspace=${workspaceId}&section=hooks&q=access&classification=watchlist&page=2`;
  return { repository, sourceId, href };
}
async function settled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === "running" &&
                animation.effect?.getTiming().iterations !== Infinity,
            ).length,
      ),
    )
    .toBe(0);
}

for (const theme of ["dark", "light"])
  for (const width of [1440, 390]) {
    test(`access guidance ${theme} ${width}: readable, bounded and keyboard accessible`, async ({
      page,
      request,
    }) => {
      const { href, repository, sourceId } = await setup(request);
      await page.setViewportSize({ width, height: 960 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      const requests: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/commands/"))
          requests.push(request.url().split("/").at(-1)!);
      });
      await page.goto(href);
      const trigger = page.getByRole("button", { name: "Access & operations" });
      await expect(trigger).toBeVisible();
      expect(requests).not.toContain("repository_access");
      await trigger.focus();
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Access & operations" });
      await expect(
        dialog.getByRole("heading", { name: "Your HQ role: owner" }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("heading", {
          name: "Access & operations",
          exact: true,
        }),
      ).toBeFocused();
      expect(
        await dialog
          .locator(".repository-access-body")
          .evaluate((element) => element.scrollTop),
      ).toBe(0);
      await expect(
        dialog.getByText("Credential unavailable", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText("Collection disabled", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText(/Watchlist is a tracking choice/),
      ).toBeVisible();
      await expect(
        dialog.getByRole("link", { name: "Open GitHub webhook settings" }),
      ).toHaveAttribute(
        "href",
        "https://github.com/" + repository.fullName + "/settings/hooks",
      );
      await expect(
        dialog.getByRole("link", { name: "Read-only evidence source" }),
      ).toHaveAttribute(
        "href",
        `/settings/github?workspace=${workspaceId}&repository=${repository.id}&lifecycle=all&connection=${sourceId}`,
      );
      await expect(
        dialog.getByRole("link", { name: "Repository Hooks", exact: true }),
      ).toHaveAttribute("href", /section=hooks/);
      await settled(page);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      const result = await new AxeBuilder({ page }).analyze();
      expect(result.violations).toEqual([]);
      for (const finding of result.incomplete) {
        if (finding.id === "aria-hidden-focus") {
          for (const node of finding.nodes)
            expect(node.target[0]).toMatch(
              /^(#root|span\[data-radix-focus-guard)/,
            );
          continue;
        }
        expect(finding.id).toBe("color-contrast");
        for (const node of finding.nodes) {
          const selector = node.target[0] as string;
          await page.locator(selector).scrollIntoViewIfNeeded();
          const visible = await new AxeBuilder({ page })
            .include(selector)
            .withRules(["color-contrast"])
            .analyze();
          expect(visible.violations).toEqual([]);
          await verifyFlatContrast(page, visible.incomplete);
        }
      }
      const close = dialog.getByRole("button", { name: "Close", exact: true });
      await close.focus();
      for (const direction of ["Tab", "Shift+Tab"]) {
        const steps = (await dialog.locator("a,button").count()) + 2;
        for (let index = 0; index < steps; index++) {
          await page.keyboard.press(direction);
          await expect
            .poll(() =>
              dialog.evaluate((element) =>
                element.contains(document.activeElement),
              ),
            )
            .toBe(true);
        }
      }
      await dialog
        .getByRole("link", { name: "Understand provider permissions" })
        .focus();
      await expect(
        dialog.getByRole("link", { name: "Understand provider permissions" }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
      expect(page.url()).toContain("q=access");
      expect(requests).not.toContain("workspace_snapshot");
      expect(requests).not.toContain("activity_feed");
      expect(requests).not.toContain("repository_work");
    });
  }
test("local-only, viewer and credential restrictions remain useful without inventing a remote", async ({
  page,
  request,
}) => {
  const { href } = await setup(request, false);
  await mockWorkspaceView(page, (snapshot) => ({
    ...snapshot,
    workspace: { ...snapshot.workspace, role: "viewer" },
    capabilities: [...ROLE_CAPABILITIES.viewer],
  }));
  await page.route("**/api/commands/repository_access", async (route) => {
    const response = await route.fetch();
    const result: RepositoryAccess = await response.json();
    await route.fulfill({
      response,
      json: {
        ...result,
        hq: {
          role: "viewer",
          client: "session",
          gates: hqOperationGates("viewer", ROLE_CAPABILITIES.viewer),
        },
      },
    });
  });
  await page.goto(href);
  await expect(
    page.getByRole("button", { name: "Edit expectations" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Access & operations" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Your HQ role: viewer" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("HQ role required", { exact: true }),
  ).toHaveCount(4);
  await expect(dialog.getByText(/No GitHub source is enrolled/)).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Open GitHub webhook settings" }),
  ).toHaveCount(0);
  await dialog.getByRole("link", { name: "Secrets", exact: true }).click();
  await expect(page).toHaveURL(/section=secrets/);
  await expect(dialog).not.toBeVisible();
});
test("denied and failed refreshes hide earlier guidance and retry the exact read", async ({
  page,
  request,
}) => {
  const { href } = await setup(request);
  let status = 200;
  await page.route("**/api/commands/repository_access", async (route) => {
    if (status !== 200)
      return route.fulfill({
        status,
        json: { error: { code: "forbidden", message: "Synthetic denial" } },
      });
    const response = await route.fetch();
    const result: RepositoryAccess = await response.json();
    await route.fulfill({
      response,
      json: {
        ...result,
        hq: {
          role: "owner",
          client: "credential",
          gates: hqOperationGates("owner", ROLE_CAPABILITIES.viewer),
        },
      },
    });
  });
  await page.goto(href);
  await page.getByRole("button", { name: "Access & operations" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Client scope required", { exact: true }),
  ).toHaveCount(4);
  for (const failure of [403, 503]) {
    status = failure;
    await dialog.getByRole("button", { name: "Check access again" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Previous guidance is hidden",
    );
    await expect(
      dialog.getByRole("heading", { name: /Your HQ role/ }),
    ).toHaveCount(0);
    status = 200;
    await dialog.getByRole("button", { name: "Check access again" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Your HQ role: owner" }),
    ).toBeVisible();
  }
});
