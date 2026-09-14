import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { DEFAULT_EXPECTATIONS, type Repository } from "../shared/domain";
import type { HookSetupReview } from "../shared/hook-setup";

const connection = {
  id: "resolution-hooks",
  name: "Synthetic hooks",
  providerRef: "primary",
  providerName: "Synthetic provider",
  projectId: null,
  revision: 1,
  enabled: true,
  available: true,
};
const authority = { authorityId: "a".repeat(32), revision: 1, mode: "active" };
const resourceId = "00000000-0000-4000-8000-000000000041";
const now = () => new Date().toISOString();
async function fixture(
  page: Page,
  request: APIRequestContext,
  options: { unavailable?: boolean; lose?: boolean } = {},
) {
  const response = await request.post("/api/commands/repository_create", {
    headers: { "X-HQ-Client": "cli" },
    data: {
      workspaceId: "development",
      repository: {
        fullName: "synthetic/" + crypto.randomUUID(),
        description: "Expectation setup",
        projectId: "development-default",
        classification: "maintained",
        lifecycle: "active",
        expectations: DEFAULT_EXPECTATIONS,
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const repository = (await response.json()) as Repository;
  const state = {
    applies: 0,
    links: [] as string[],
    reviews: new Map<string, HookSetupReview>(),
    configured: false,
  };
  await page.route("**/api/commands/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const input = route.request().postDataJSON();
    let result: unknown;
    switch (name) {
      case "hooks_connections":
        result = [connection];
        break;
      case "hooks_configuration":
        result = {
          status: "supported",
          configuration: {
            ...authority,
            canConfigure: true,
            supported: { policy: true, create: true, retire: false },
            observedAt: now(),
          },
        };
        break;
      case "hooks_setup_configuration":
        result = {
          status: "supported",
          configuration: {
            ...authority,
            canCreate: !options.unavailable,
            reason: options.unavailable ? "grant_required" : "ready",
            observedAt: now(),
          },
        };
        break;
      case "hooks_policy_subscriptions":
        result = {
          result: {
            ...authority,
            items: [
              {
                resourceId,
                name: "Existing subscription",
                source: "github",
                policy: {
                  enabled: true,
                  sinks: ["Test phone"],
                  filter: null,
                  sinkFilters: {},
                },
              },
            ],
            nextCursor: null,
            observedAt: now(),
          },
          repositoryLinks: [
            {
              resourceKey: "Existing subscription",
              repositoryIds: state.links,
            },
          ],
        };
        break;
      case "hooks_policy_destinations":
        result = {
          result: {
            ...authority,
            items: [
              {
                resourceId: "00000000-0000-4000-8000-000000000042",
                name: "Test phone",
                type: "ntfy",
                retired: false,
              },
            ],
            nextCursor: null,
            observedAt: now(),
          },
        };
        break;
      case "resource_repositories":
        result = {
          ...input,
          revision: 0,
          connectionRevision: 1,
          repositoryIds: state.links,
          updatedAt: null,
        };
        break;
      case "resource_repositories_save":
        state.links = input.repositoryIds;
        result = { ...input, revision: 1, updatedAt: now() };
        break;
      case "repository_coverage":
      case "repository_coverage_get":
        result = {
          repositoryId: repository.id,
          phase: "ready",
          nextReadAt: null,
          generatedAt: now(),
          links: { hooks: state.links.length, monitoring: 0 },
          evidence: [],
        };
        break;
      case "hooks_setup_plan": {
        const review: HookSetupReview = {
          id: input.reviewId,
          fingerprint: "b".repeat(64),
          connectionId: connection.id,
          connectionName: connection.name,
          repositoryId: repository.id,
          repositoryName: repository.fullName,
          actorMatches: true,
          linked: false,
          createdAt: now(),
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          operation: null,
          provider: {
            planId: input.reviewId,
            resourceId,
            name: input.name,
            repository: repository.fullName,
            events: input.events,
            sinks: input.sinks,
            action: input.resourceId ? "install" : "create",
            status: "ready",
            errorCode: null,
            createdAt: now(),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            updatedAt: now(),
            routingConfigured: false,
            webhookInstalled: false,
            webhookId: null,
          },
        };
        state.reviews.set(review.id, review);
        result = review;
        break;
      }
      case "hooks_setup_get":
        result = state.reviews.get(input.planId);
        break;
      case "hooks_setup_apply":
      case "hooks_setup_reconcile": {
        const review = state.reviews.get(input.planId)!;
        if (name === "hooks_setup_apply") state.applies++;
        const lost = options.lose && name === "hooks_setup_apply";
        review.provider = {
          ...review.provider!,
          status: lost ? "indeterminate" : "installed",
          routingConfigured: true,
          webhookInstalled: !lost,
          webhookId: lost ? null : 42,
          updatedAt: now(),
        };
        review.linked = true;
        state.links = [repository.id];
        state.configured = true;
        review.operation = {
          id: "setup-operation",
          status: lost ? "indeterminate" : "succeeded",
          summary: lost
            ? "Installation outcome is uncertain."
            : "Routing and installation confirmed.",
          updatedAt: now(),
        };
        result = review;
        break;
      }
      case "hooks_setup_status":
        result = {
          resourceId,
          name: "Repository hooks",
          routingConfigured: state.configured,
          webhook: "installed",
          deliveredAt: null,
          observedAt: now(),
        };
        break;
      default:
        return route.fallback();
    }
    return route.fulfill({ json: result });
  });
  return {
    repository,
    state,
    url:
      "/repositories/" +
      repository.id +
      "?workspace=development&dialog=expectations",
  };
}
async function openSetup(page: Page, url: string) {
  await page.goto(url);
  await page
    .getByRole("button", { name: "Set up coverage", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Hook coverage");
  await expect(
    page.getByRole("button", { name: "Create subscription", exact: true }),
  ).toBeEnabled();
}
async function createReview(page: Page) {
  await page
    .getByRole("button", { name: "Create subscription", exact: true })
    .click();
  await page
    .getByLabel("Subscription name", { exact: true })
    .fill("Repository hooks");
  await page.getByRole("checkbox", { name: /Test phone/ }).check();
  await page.getByRole("button", { name: "Review setup", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Apply setup", exact: true }),
  ).toBeEnabled();
}

test("resolves hooks inside a project's bulk expectation draft and restores its choices", async ({
  page,
  request,
}) => {
  const { repository } = await fixture(page, request);
  await page.goto(
    "/projects/development-default?workspace=development&section=repositories",
  );
  await page
    .getByRole("button", { name: "Set expectations", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Find repositories to change" })
    .fill(repository.fullName);
  await page
    .getByRole("checkbox", {
      name: repository.fullName + " Maintained",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Choose changes", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Change Hook coverage", exact: true })
    .check();
  await page
    .getByRole("combobox", { name: "Hook coverage", exact: true })
    .click();
  await page.getByRole("option", { name: "Required", exact: true }).click();
  await page.getByRole("button", { name: "Set up hooks", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Hook coverage");
  expect(new URL(page.url()).searchParams.get("resolveRepository")).toBe(
    repository.id,
  );
  await page
    .getByRole("button", { name: "Link subscription", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Linked to repository", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Back to expectations", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Hook coverage", exact: true }),
  ).toHaveText("Required");
  await expect(
    page.getByRole("button", { name: "Review changes", exact: true }),
  ).toBeEnabled();
  expect(new URL(page.url()).pathname).toBe("/projects/development-default");
  expect(new URL(page.url()).searchParams.get("dialog")).toBe("expectations");
});

test("preserves expectation drafts across setup and browser Back, with shareable modal URLs", async ({
  page,
  request,
}) => {
  const { url } = await fixture(page, request);
  await page.goto(url);
  await page.getByLabel("Description", { exact: true }).fill("Draft retained");
  await page
    .getByRole("button", { name: "Set up coverage", exact: true })
    .click();
  expect(new URL(page.url()).searchParams.get("resolve")).toBe("hooks");
  await page.goBack();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "Draft retained",
  );
  await page
    .getByRole("button", { name: "Set up coverage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Link subscription", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Linked to repository", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Back to expectations", exact: true })
    .click();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "Draft retained",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
});

test("keeps setup drafts on dismissal and restores saved reviews after reload", async ({
  page,
  request,
}) => {
  const { url, state } = await fixture(page, request);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openSetup(page, url);
  await createReview(page);
  expect(state.applies).toBe(0);
  await page
    .getByRole("button", { name: "Back to editing", exact: true })
    .click();
  await expect(
    page.getByLabel("Subscription name", { exact: true }),
  ).toHaveValue("Repository hooks");
  await page
    .getByLabel("Subscription name", { exact: true })
    .fill("Changed draft");
  await page
    .getByRole("button", { name: "Back to expectations", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(
    page.getByLabel("Subscription name", { exact: true }),
  ).toHaveValue("Changed draft");
  await page.getByRole("button", { name: "Review setup", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Apply setup", exact: true }),
  ).toBeEnabled();
  const saved = page.url();
  await page.reload();
  expect(page.url()).toBe(saved);
  await page.getByRole("button", { name: "Apply setup", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Routing and installation confirmed.",
  );
  await expect(page.getByRole("dialog")).toContainText(
    "Awaiting delivery evidence",
  );
  expect(state.applies).toBe(1);
  expect(errors).toEqual([]);
});

test("reconciles an interrupted setup without offering another Apply", async ({
  page,
  request,
}) => {
  const { url, state } = await fixture(page, request, { lose: true });
  await openSetup(page, url);
  await createReview(page);
  await page.getByRole("button", { name: "Apply setup", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Installation outcome is uncertain.",
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Apply setup", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Reconcile setup", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Routing and installation confirmed.",
  );
  expect(state.applies).toBe(1);
});

for (const theme of ["light", "dark"])
  for (const width of [390, 1440]) {
    test(`supports keyboard and accessible ${theme} setup at ${width}px`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("hq.theme.v1", value),
        theme,
      );
      const { url } = await fixture(page, request, { unavailable: true });
      await page.goto(url + "&resolve=hooks");
      await expect(page.getByRole("dialog")).toContainText(
        "A provider administrator must grant hook setup",
      );
      await expect(
        page.getByRole("button", { name: "Create subscription", exact: true }),
      ).toBeDisabled();
      await page.getByRole("dialog").evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
          .violations,
      ).toEqual([]);
      expect(
        await page
          .getByRole("dialog")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await page.keyboard.press("Tab");
      expect(
        await page
          .getByRole("dialog")
          .evaluate((element) => element.contains(document.activeElement)),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toContainText("Edit repository");
    });
  }
