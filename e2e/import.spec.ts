import { test, expect } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import { DEFAULT_EXPECTATIONS } from "../shared/domain";

const workspaceId = "import-test";
const manifest = {
  formatVersion: 2,
  sourceLabel: "Reviewed browser fixture",
  projects: [
    {
      key: "imported-project",
      name: "Imported project",
      description: "Imported project context",
      lifecycle: "active",
      importance: "standard",
      importanceNote: "",
      portfolio: {
        status: "undecided",
        reason: "",
        url: null,
        reviewDate: null,
      },
    },
  ],
  repositories: [
    {
      fullName: "example/imported-project",
      description: "This is metadata, not fresh health evidence",
      projectKey: "imported-project",
      classification: "maintained",
      lifecycle: "active",
      expectations: {
        ...DEFAULT_EXPECTATIONS,
        note: "  Preserve intent\nacross lines.  ",
      },
    },
  ],
};
const file = (value: unknown) => ({
  name: "metadata.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(value)),
});
const repositoryMetadata = (value = manifest.repositories[0]) => {
  const { projectKey, ...metadata } = value;
  void projectKey;
  return metadata;
};

test("metadata review validates files, preserves drafts, and recovers a lost apply response without duplicates", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("net::ERR_FAILED")
    )
      errors.push(message.text());
  });
  await page.goto("/settings/import?workspace=" + workspaceId);
  await page.getByRole("button", { name: "Review metadata file" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByLabel("Project metadata file", { exact: true });
  await expect(input).toBeFocused();
  await input.setInputFiles(
    file({ ...manifest, credentials: [{ token: "synthetic-never-uploaded" }] }),
  );
  await expect(dialog.getByRole("alert")).toContainText(
    "not a supported project metadata file",
  );
  await expect(
    dialog.getByRole("button", { name: "Review exact import" }),
  ).toBeDisabled();
  await input.setInputFiles(
    file({
      ...manifest,
      repositories: [
        manifest.repositories[0],
        { ...manifest.repositories[0], fullName: "EXAMPLE/IMPORTED-PROJECT" },
      ],
    }),
  );
  await expect(dialog.getByRole("alert")).toContainText(
    "repositories.1.fullName",
  );
  await input.setInputFiles(file(manifest));
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "1 project records and 1 repository records",
  );
  await dialog.getByRole("button", { name: "Review exact import" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Review project import" }),
  ).toBeVisible();
  await expect(dialog).toContainText("Synthetic import workspace");
  await expect(
    dialog.getByRole("heading", { name: "example/imported-project" }),
  ).toBeVisible();
  expect(await dialog.locator(".import-note").textContent()).toBe(
    manifest.repositories[0].expectations.note,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBeTruthy();
  await page.route(
    "**/api/commands/metadata_import_apply",
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    },
    { times: 1 },
  );
  await dialog
    .getByRole("button", { name: "Import reviewed metadata" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Retry this same review",
  );
  await expect(
    dialog.getByRole("button", { name: "Back to file" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry same import" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Metadata imported" }),
  ).toBeVisible();
  await expect(dialog).toContainText("1 project and 1 repository added to");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Bring your project metadata" }),
  ).toBeFocused();
  await page.reload();
  const section = page.locator("section", {
    has: page.getByRole("heading", { name: "Bring your project metadata" }),
  });
  await expect(section.getByRole("status")).toContainText("Import complete");
  await expect(
    section.getByRole("button", { name: "Review metadata file" }),
  ).toHaveCount(0);
  const response = await request.post("/api/commands/repositories_list", {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId },
  });
  const repos = await response.json();
  expect(repos).toHaveLength(1);
  expect(repos[0]).toMatchObject({
    ...repositoryMetadata(),
    projectId: expect.any(String),
  });
  const activity = await request.post("/api/commands/activity_list", {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId },
  });
  expect(
    (await activity.json()).filter(
      (event: { type: string }) => event.type === "metadata.imported",
    ),
  ).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("populated workspaces explain why import cannot overwrite their inventory", async ({
  page,
  request,
}) => {
  const projectsResponse = await request.post("/api/commands/projects_list", {
    headers: { "X-HQ-Client": "cli" },
    data: { workspaceId: "development" },
  });
  const projects = (await projectsResponse.json()) as { id: string }[];
  const enrolled = await request.post("/api/commands/repository_create", {
    headers: { "X-HQ-Client": "cli" },
    data: {
      workspaceId: "development",
      repository: {
        ...repositoryMetadata(),
        fullName: "example/occupied-import-" + Date.now(),
        projectId: projects[0]!.id,
      },
    },
  });
  expect(enrolled.status()).toBe(200);
  await page.goto("/settings/import?workspace=development");
  const section = page.locator("section", {
    has: page.getByRole("heading", { name: "Bring your project metadata" }),
  });
  await expect(section).toContainText("never merges or overwrites");
  await expect(
    section.getByRole("button", { name: "Review metadata file" }),
  ).toHaveCount(0);
});
