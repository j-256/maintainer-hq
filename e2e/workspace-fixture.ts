import type { Page } from "@playwright/test";
import type { Snapshot } from "../shared/domain";
import {
  VIEW_COLLECTIONS,
  viewSnapshot,
  type WorkspaceView,
} from "../shared/workspace-sync";

export async function mockWorkspaceView(
  page: Page,
  map: (snapshot: Snapshot) => Snapshot,
) {
  await page.route("**/api/commands/workspace_view", async (route) => {
    const response = await route.fetch();
    const view = (await response.json()) as WorkspaceView;
    const snapshot = map(viewSnapshot(view));
    await route.fulfill({
      response,
      json: {
        ...view,
        workspace: snapshot.workspace,
        capabilities: snapshot.capabilities,
        records: Object.fromEntries(
          VIEW_COLLECTIONS[view.scope.view].map((collection) => [
            collection,
            snapshot[collection],
          ]),
        ),
      },
    });
  });
  await page.route("**/api/commands/workspace_changes", (route) =>
    route.fulfill({
      json: {
        type: "reset",
        cursor: route.request().postDataJSON().cursor,
        reason: "concurrent_changes",
      },
    }),
  );
}
