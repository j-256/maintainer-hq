import { type DependabotInventoryRow } from "../shared/dependabot";
const DIGEST = "sha256:" + "b".repeat(64),
  SHA = "a".repeat(40);
export function dependabotBrowserRows(): DependabotInventoryRow[] {
  const rows: DependabotInventoryRow[] = Array.from(
    { length: 6 },
    (_, index) => ({
      repository: {
        id: "schedule-" + index,
        fullName:
          "example/" +
          ["alpha", "beta", "unknown", "stale", "natural", "group"][index],
        projectId: "development-default",
      },
      source: { id: "synthetic-source", name: "Schedule source" },
      result: {
        repository: {
          id: "schedule-" + index,
          fullName:
            "example/" +
            ["alpha", "beta", "unknown", "stale", "natural", "group"][index],
          revision: 1,
        },
        source: {
          id: "synthetic-source",
          name: "Schedule source",
          revision: 1,
        },
        state: "ready",
        nextReadAt: null,
        evidence: {
          inspectionId: crypto.randomUUID(),
          observedAt: new Date(
            Date.now() - (index === 3 ? 600000 : 0),
          ).toISOString(),
          retryAt: null,
          requests: 5,
          elapsedMs: 20,
          read: { state: "observed", reason: "complete" },
          branch: "main",
          headSha: SHA,
          treeSha: SHA,
          configuration: "present",
          file: {
            path: ".github/dependabot.yml",
            mode: "100644",
            blobSha: SHA,
            digest: DIGEST,
          },
          entries: [
            {
              id: DIGEST + (index === 5 ? ":group:0" : ":update:0"),
              owner: index === 5 ? "group" : "update",
              group: index === 5 ? "frontend" : null,
              members: [
                { ecosystem: "npm", directories: ["/"], targetBranch: null },
                ...(index === 5
                  ? [
                      {
                        ecosystem: "docker",
                        directories: ["/"],
                        targetBranch: null,
                      },
                    ]
                  : []),
              ],
              schedule:
                index === 4
                  ? { interval: "cron", cronjob: "every day" }
                  : index === 2
                    ? { interval: "weekly" }
                    : { interval: "weekly", day: "monday", time: "08:00" },
              editable: true,
              issue: null,
            },
          ],
        },
      },
    }),
  );
  return rows;
}
