import { test, expect, type Page } from "./test-fixture";
import AxeBuilder from "@axe-core/playwright";
import {
  mockSecrets,
  SECRET_CONNECTION,
  SECRET_RESOURCE,
  SECRET_TIME,
} from "./secrets-fixture";

const URL = "/secrets?workspace=development";
const VALUE = "synthetic-private-value\ntrailing newline\n";
test("Secrets task views do not contain provider or vault planning commentary", async ({
  page,
}) => {
  await mockSecrets(page);
  for (const view of ["inventory", "operations", "providers"]) {
    await page.goto(URL + "&view=" + view);
    await expect(
      page.getByRole("heading", { name: "Secrets", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/\bvault\b/i)).toHaveCount(0);
  }
});
async function audit(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState !== "idle" &&
                animation.playState !== "finished" &&
                Number.isFinite(animation.effect?.getComputedTiming().endTime),
            ).length,
      ),
    )
    .toBe(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}
test("accessibility audit settles canceled transitions without awaiting their replacement promise", async ({
  page,
}) => {
  await mockSecrets(page);
  await page.goto(URL);
  await expect(
    page.getByRole("button", { name: "Change scope", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const animation = document.body.animate([{ opacity: 1 }, { opacity: 1 }], {
      duration: 150,
    });
    animation.cancel();
    const original = document.getAnimations.bind(document);
    document.getAnimations = () => [animation, ...original()];
  });
  await audit(page);
});
async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function supply(page: Page) {
  await page
    .getByRole("button", { name: "Prepare destinations", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Supply the value privately" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Review secret distribution",
      exact: true,
    }),
  ).toBeFocused();
  await expect(page.getByText(/\bvault\b/i)).toHaveCount(0);
  await expect(
    page.getByText(/HQ cannot decrypt this GitHub-sealed value/),
  ).toBeVisible();
  await page.getByLabel("Supplied value (visible while editing)").fill(VALUE);
  await page
    .getByRole("button", { name: "Seal value and prepare final review" })
    .click();
  await expect(
    page.getByRole("button", { name: "Review and confirm distribution" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Supplied value (visible while editing)"),
  ).toHaveCount(0);
}
async function confirmDistribution(page: Page) {
  await page
    .getByRole("button", { name: "Review and confirm distribution" })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByRole("button", { name: "Keep reviewing", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Review and confirm distribution",
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByRole("button", { name: "Confirm distribution", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Confirm distribution", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Distribution receipts" }),
  ).toBeFocused();
}
test("inventory is paginated, provider-neutral, accessible, and preserves read errors", async ({
  page,
}) => {
  const state = await mockSecrets(page);
  await page.goto(URL);
  await expect(page.getByText("DEPLOY_TOKEN", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Secrets", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const pages = page.getByRole("navigation", { name: "Secret name pages" });
  await pages.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("SECOND_TOKEN", { exact: true })).toBeVisible();
  await expect(pages.getByRole("button", { name: "Next" })).toBeDisabled();
  await choose(page, "Scope", "Environment: Production / Blue");
  await expect(
    page.getByRole("heading", {
      name: "Environment: Production / Blue secrets",
    }),
  ).toBeVisible();
  state.rejectReads = true;
  await page.getByRole("button", { name: "Refresh secrets" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic provider read unavailable",
  );
  await expect(page.getByText("DEPLOY_TOKEN", { exact: true })).toBeVisible();
  state.rejectReads = false;
  await page.getByRole("button", { name: "Refresh secrets" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await audit(page);
  expect(state.writes).toBe(0);
});
test("inventory separates provider variables, effective organization entries and writable secret scopes", async ({
  page,
}) => {
  const state = await mockSecrets(page);
  await page.goto(URL);
  await page.getByRole("button", { name: "Variables", exact: true }).click();
  await expect(page.getByText("DEPLOY_REGION", { exact: true })).toBeVisible();
  await expect(page.getByText("us-central1", { exact: true })).toBeVisible();
  await expect(page.getByText("Text variable", { exact: true })).toBeVisible();
  await expect(page.getByText("Unmanaged by HQ", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Distribute supplied value",
      exact: true,
    }),
  ).toHaveCount(0);
  await choose(page, "Scope", "Organization: example");
  await expect(
    page.getByRole("heading", { name: "Organization: example variables" }),
  ).toBeVisible();
  await expect(
    page.getByText(/available to the selected repository/),
  ).toBeVisible();
  expect(
    state.calls.filter((item) => item.name === "secrets_inventory").at(-1)
      ?.input,
  ).toMatchObject({
    entryKind: "variable",
    target: { scope: { kind: "organization", name: "example" } },
  });
  await page.getByRole("button", { name: "Secrets", exact: true }).click();
  await choose(page, "Scope", "Repository");
  await page
    .getByRole("button", { name: "Supply a new secret", exact: true })
    .click();
  const destination = page.getByRole("group", {
    name: "Destination 1",
    exact: true,
  });
  await destination
    .getByRole("combobox", { name: "Scope", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: "Organization: example", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "Repository", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await audit(page);
  expect(state.writes).toBe(0);
});
test("adopts a provider variable, reviews exact drift, and retains one applied receipt", async ({
  page,
}) => {
  const state = await mockSecrets(page);
  await page.goto(URL);
  await page.getByRole("button", { name: "Variables", exact: true }).click();
  await page.getByRole("button", { name: "Manage in HQ", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Manage configuration" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("HQ label", { exact: true })).toHaveValue(
    "DEPLOY_REGION",
  );
  await expect(
    editor.getByLabel("Desired non-secret value", { exact: true }),
  ).toHaveValue("us-central1");
  await editor
    .getByLabel("Desired non-secret value", { exact: true })
    .fill("eu-west-1");
  await editor
    .getByRole("button", { name: "Save managed configuration", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  await expect(page).toHaveURL(/view=managed/);
  await expect(page.getByText("Drifted", { exact: true })).toBeVisible();
  await expect(page.getByText("eu-west-1", { exact: true })).toBeVisible();
  await expect(page.getByText("us-central1", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Review reconciliation", exact: true })
    .click();
  await expect(page).toHaveURL(/configurationReview=/);
  await expect(
    page.getByRole("heading", {
      name: "Managed configuration review",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Update variable", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("eu-west-1", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Update variable", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("submit at most one provider request");
  await confirmation
    .getByRole("button", {
      name: "Confirm reviewed operation",
      exact: true,
    })
    .click();
  await expect(page.getByText("succeeded", { exact: true })).toBeVisible();
  await expect(page.getByText("In sync", { exact: true })).toBeVisible();
  expect(state.managedWrites).toBe(1);
  expect(state.providerVariables.get("DEPLOY_REGION")).toBe("eu-west-1");
  await page.reload();
  await expect(page.getByText("succeeded", { exact: true })).toBeVisible();
  expect(state.managedWrites).toBe(1);
  await page
    .getByRole("button", {
      name: "Back to managed configuration",
      exact: true,
    })
    .click();
  await expect(page.getByText("In sync", { exact: true })).toBeVisible();
  await page
    .getByRole("button", {
      name: "All managed configurations",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Managed operation history" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open receipt", exact: true }),
  ).toBeVisible();
  await audit(page);
});

test("tracks a secret name without custody or a value write and can stop management only", async ({
  page,
}) => {
  const state = await mockSecrets(page);
  await page.goto(URL);
  await page.getByRole("button", { name: "Manage in HQ", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Manage configuration" });
  await expect(
    editor.getByText(/never accepts or stores a secret value/),
  ).toBeVisible();
  await expect(
    editor.getByLabel("Desired non-secret value", { exact: true }),
  ).toHaveCount(0);
  await editor
    .getByRole("button", { name: "Save managed configuration", exact: true })
    .click();
  await expect(page.getByText("Presence only", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review reconciliation", exact: true }),
  ).toHaveCount(0);
  expect(state.managedWrites).toBe(0);
  await page
    .getByRole("button", {
      name: "All managed configurations",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Stop management", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("Provider entries and values remain unchanged");
  await confirmation
    .getByRole("button", { name: "Stop management only", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No HQ-managed configuration yet" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(page.getByText("Unmanaged by HQ", { exact: true })).toBeVisible();
  expect(state.managedWrites).toBe(0);
});

test("viewer access can inspect managed status but cannot edit or prepare provider changes", async ({
  page,
}) => {
  const state = await mockSecrets(page, { viewer: true });
  state.configurations.push({
    id: "managed-region",
    label: "Deploy region",
    entryKind: "variable",
    custody: "none",
    desiredValue: "eu-west-1",
    revision: 1,
    createdAt: SECRET_TIME,
    updatedAt: SECRET_TIME,
    destinations: [
      {
        destination: {
          connectionId: SECRET_CONNECTION.id,
          connectionRevision: SECRET_CONNECTION.revision,
          target: {
            resourceId: SECRET_RESOURCE.id,
            scope: { kind: "repository" },
          },
          name: "DEPLOY_REGION",
        },
        desiredState: "present",
      },
    ],
  });
  await page.goto(URL + "&view=managed");
  await expect(page.getByText("Deploy region", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manage configuration", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "View live status", exact: true })
    .click();
  await expect(page.getByText("Drifted", { exact: true })).toBeVisible();
  await expect(page.getByText("eu-west-1", { exact: true })).toBeVisible();
  await expect(page.getByText("us-central1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit definition", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review reconciliation", exact: true }),
  ).toHaveCount(0);
  await audit(page);
});
test("new connection enrollment uses installed provider scopes without credential entry", async ({
  page,
}) => {
  const state = await mockSecrets(page, { empty: true });
  await page.goto(URL);
  await page
    .getByRole("button", { name: "Connect provider", exact: true })
    .click();
  await page
    .getByLabel("Connection name", { exact: true })
    .fill("Approved deployment resources");
  await choose(page, "Installed provider", "Synthetic provider");
  await page
    .getByRole("checkbox", { name: SECRET_RESOURCE.label, exact: true })
    .check();
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("DEPLOY_TOKEN", { exact: true })).toBeVisible();
  expect(state.connections[0]?.resourceIds).toEqual([SECRET_RESOURCE.id]);
  expect(state.writes).toBe(0);
  expect(state.deletions).toBe(0);
});
test("supplies exact bytes, confirms independently, and opens durable receipts from history", async ({
  page,
}) => {
  const state = await mockSecrets(page);
  await page.goto(URL);
  await page
    .getByRole("button", { name: "Distribute supplied value", exact: true })
    .click();
  await supply(page);
  expect(state.values).toEqual([VALUE]);
  expect(JSON.stringify(state.calls)).not.toContain(VALUE);
  expect(state.writes).toBe(0);
  await confirmDistribution(page);
  await expect(
    page.getByText("Provider accepted", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toBe(1);
  await page
    .getByRole("button", { name: "Check metadata 1", exact: true })
    .click();
  expect(state.writes).toBe(1);
  await page.getByRole("button", { name: "Back to Secrets" }).click();
  await expect(
    page.getByRole("heading", { name: "Secrets", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Open review", exact: false }).click();
  await expect(
    page.getByText("Provider accepted", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Provider accepted", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toBe(1);
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain(VALUE);
  await audit(page);
});
test("lost private-input and execution responses recover the same receipt without repeating effects", async ({
  page,
}) => {
  const state = await mockSecrets(page);
  state.loseInputResponse = true;
  state.loseRunResponse = true;
  await page.goto(URL);
  await page
    .getByRole("button", { name: "Distribute supplied value", exact: true })
    .click();
  await supply(page);
  await expect(page.getByRole("alert")).toContainText(
    "Input acceptance is uncertain",
  );
  expect(state.values).toEqual([VALUE]);
  await page
    .getByRole("button", { name: "Reload receipt", exact: true })
    .click();
  await expect(page.locator("#secret-review-title")).toBeFocused();
  await confirmDistribution(page);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByText("Provider accepted", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toBe(1);
  await page
    .getByRole("button", { name: "Reload receipt", exact: true })
    .click();
  expect(state.writes).toBe(1);
});
test("multi-destination interruptions resume only the remaining explicitly confirmed destinations", async ({
  page,
}) => {
  const state = await mockSecrets(page);
  state.loseRunResponse = true;
  await page.goto(URL);
  await page
    .getByRole("button", { name: "Distribute supplied value", exact: true })
    .click();
  await page.getByRole("button", { name: /Add destination/ }).click();
  const destination = page.getByRole("group", {
    name: "Destination 2",
    exact: true,
  });
  await destination
    .getByRole("combobox", { name: "Connection", exact: true })
    .click();
  await page
    .getByRole("option", { name: SECRET_CONNECTION.name, exact: true })
    .click();
  await destination
    .getByRole("combobox", { name: "Scope", exact: true })
    .click();
  await page
    .getByRole("option", {
      name: "Environment: Production / Blue",
      exact: true,
    })
    .click();
  await supply(page);
  expect(state.values).toEqual([VALUE, VALUE]);
  await confirmDistribution(page);
  await expect(
    page.getByText("Provider accepted", { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText("Pending", { exact: true })).toBeVisible();
  expect(state.writes).toBe(1);
  await page
    .getByRole("button", { name: "Reload receipt", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review pending destinations", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByText("Environment: Production / Blue", { exact: false }),
  ).toBeVisible();
  await expect(dialog.locator(".secret-target-facts")).toHaveCount(1);
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Confirm distribution", exact: true })
    .click();
  await expect(
    page.getByText("Provider accepted", { exact: true }),
  ).toHaveCount(2);
  expect(
    state.calls
      .filter((item) => item.name === "secrets_run")
      .map((item) => item.input.destinationIndex),
  ).toEqual([0, 1]);
  expect(state.writes).toBe(2);
});
test("review expiry disables confirmation with a local clock and no status polling", async ({
  page,
}) => {
  const state = await mockSecrets(page);
  await page.goto(URL);
  await page
    .getByRole("button", { name: "Distribute supplied value", exact: true })
    .click();
  await supply(page);
  const now = Date.now();
  [...state.reviews.values()][0]!.expiresAt = new Date(
    now + 10_000,
  ).toISOString();
  await page.clock.install({ time: now });
  await page.reload();
  const confirm = page.getByRole("button", {
    name: "Review and confirm distribution",
    exact: true,
  });
  await expect(confirm).toBeEnabled();
  const reads = state.calls.filter(
    (item) => item.name === "secrets_review",
  ).length;
  await page.clock.fastForward(11_000);
  await expect(confirm).toBeDisabled();
  await expect(
    page.getByText("This review has expired.", { exact: false }),
  ).toBeVisible();
  expect(
    state.calls.filter((item) => item.name === "secrets_review"),
  ).toHaveLength(reads);
  expect(state.writes).toBe(0);
});
test("retained recovery requires acknowledgement and leaves the parent acceptance uncertain", async ({
  page,
}) => {
  const state = await mockSecrets(page);
  state.uncertainWrite = true;
  await page.goto(URL);
  await page
    .getByRole("button", { name: "Distribute supplied value", exact: true })
    .click();
  await supply(page);
  await confirmDistribution(page);
  const parent = [...state.reviews.values()][0]!;
  await page
    .getByRole("button", { name: "Check metadata 1", exact: true })
    .click();
  await expect(
    page.getByText("Acceptance uncertain", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review recovery 1" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Prepare recovery review" }).click();
  await expect(
    page.getByRole("heading", { name: "Retained-input recovery review" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Supplied value (visible while editing)"),
  ).toHaveCount(0);
  state.uncertainWrite = false;
  await confirmDistribution(page);
  await expect(
    page.getByText("Provider accepted", { exact: true }),
  ).toBeVisible();
  expect(parent.operation?.receipts[0]?.writeStatus).toBe("indeterminate");
  expect(state.values).toHaveLength(1);
  expect(state.writes).toBe(2);
});
test("scope changes keep their source until separately reviewed deletion and preserve deletion uncertainty", async ({
  page,
}) => {
  const state = await mockSecrets(page);
  state.uncertainDeletion = true;
  await page.goto(URL);
  await page.getByRole("button", { name: "Change scope", exact: true }).click();
  const destination = page.getByRole("group", {
    name: "Destination 1",
    exact: true,
  });
  await destination
    .getByRole("combobox", { name: "Scope", exact: true })
    .click();
  await page
    .getByRole("option", {
      name: "Environment: Production / Blue",
      exact: true,
    })
    .click();
  await supply(page);
  await confirmDistribution(page);
  expect(state.deletions).toBe(0);
  await page
    .getByRole("checkbox", { name: /I understand removal is non-atomic/ })
    .check();
  await page
    .getByRole("button", { name: "Prepare source-removal review", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Review source deletion", exact: true }),
  ).toBeVisible();
  expect(state.deletions).toBe(0);
  await page
    .getByRole("button", { name: "Review source deletion", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByRole("button", {
      name: "Confirm source deletion",
      exact: true,
    }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  let resume!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  state.beforeCleanupWrite = () => held;
  await dialog
    .getByRole("button", { name: "Confirm source deletion", exact: true })
    .click();
  try {
    await expect
      .poll(() =>
        state.calls.some((item) => item.name === "secrets_cleanup_apply"),
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Back to Secrets", exact: true }),
    ).toBeDisabled();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "An operation is still running",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Leave receipt", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Keep receipt open", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Distribution receipts", exact: true }),
    ).toBeVisible();
  } finally {
    resume();
  }
  await expect(
    page.getByText("Acceptance uncertain", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Check source metadata", exact: true })
    .click();
  await expect(
    page.getByText("Acceptance uncertain", { exact: true }),
  ).toBeVisible();
  expect(state.deletions).toBe(1);
  expect(state.writes).toBe(1);
  await audit(page);
});
test("connection and destination drafts survive conflicts and guarded navigation", async ({
  page,
}) => {
  const state = await mockSecrets(page);
  await page.goto(URL);
  await page.getByRole("button", { name: "Connection settings" }).click();
  await page
    .getByLabel("Connection name", { exact: true })
    .fill("My retained connection draft");
  state.conflict = true;
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Connection changed");
  await expect(page.getByLabel("Connection name", { exact: true })).toHaveValue(
    "My retained connection draft",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Connection name", { exact: true })).toHaveValue(
    "My retained connection draft",
  );
  state.conflict = false;
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.connections[0]?.name).toBe("My retained connection draft");
  await page
    .getByRole("button", { name: "Distribute value", exact: true })
    .click();
  await page.getByLabel("Secret name", { exact: true }).fill("KEPT_DRAFT");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Secret name", { exact: true })).toHaveValue(
    "KEPT_DRAFT",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  expect(state.writes).toBe(0);
});
test("viewer and repository contexts expose metadata without write controls", async ({
  page,
}) => {
  const state = await mockSecrets(page, { viewer: true });
  await page.goto(
    "/repositories/" +
      SECRET_RESOURCE.id +
      "?workspace=development&section=secrets",
  );
  await expect(page.getByText("DEPLOY_TOKEN", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect provider", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Distribute value", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Change scope", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No secret operations recorded" }),
  ).toBeVisible();
  expect(
    state.calls.find((item) => item.name === "secrets_history")?.input
      .repositoryId,
  ).toBe(SECRET_RESOURCE.id);
  expect(
    state.calls.find((item) => item.name === "secrets_inventory")?.input
      .connectionId,
  ).toBe(SECRET_CONNECTION.id);
});
test("mobile themes and keyboard-only scope controls remain usable", async ({
  page,
}) => {
  await mockSecrets(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(URL);
  await expect(page.getByText("DEPLOY_TOKEN", { exact: true })).toBeVisible();
  const scope = page.getByRole("combobox", { name: "Scope", exact: true });
  await scope.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("option", { name: "Repository", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("option", { name: "Organization: example", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("option", {
      name: "Environment: Production / Blue",
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(scope).toContainText("Environment: Production / Blue");
  for (const theme of ["light", "dark"]) {
    const switcher = page.getByRole("button", {
      name: "Switch to " + theme + " theme",
      exact: true,
    });
    if (await switcher.count()) await switcher.click();
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await audit(page);
    await page.screenshot({
      path: test.info().outputPath("secrets-mobile-" + theme + ".png"),
      fullPage: true,
    });
  }
});
