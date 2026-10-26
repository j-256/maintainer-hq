import { DEPENDABOT_DAYS, type DependabotInventoryRow } from "../shared/dependabot";
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

const FLEET = Object.freeze({
  REPOSITORIES: 55,
  ENTRIES: 3,
  START_MINUTE: 8 * 60,
  SPREAD_MINUTES: 8 * 60,
  STEP_MINUTES: 15,
  ENTRY_GAP_MINUTES: 75,
  MINUTES_PER_HOUR: 60,
  STALE_EVERY: 23,
  STALE_AGE_MS: 10 * 60 * 1000,
  OVERLAP_EVERY: 11,
  UNKNOWN_EVERY: 29,
  CRON_EVERY: 19,
  DAILY_EVERY: 13,
  MONTHLY_EVERY: 17,
});
const FLEET_KINDS = ["service", "web", "cli", "library", "worker", "docs"];
const FLEET_ECOSYSTEMS = [
  "npm", "github-actions", "docker", "pip", "cargo", "gomod",
];
const FLEET_ZONES = ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"];
const FLEET_DIRECTORIES = ["/", "/packages/core", "/tools"];
export function dependabotFleetBrowserRows(): DependabotInventoryRow[] {
  const rows = dependabotBrowserRows();
  for (let index = rows.length; index < FLEET.REPOSITORIES; index++) {
    const row = structuredClone(rows[0]!);
    const id = "schedule-fleet-" + index;
    const fullName =
      "example/" + FLEET_KINDS[index % FLEET_KINDS.length] + "-" +
      String(index).padStart(2, "0");
    row.repository = { ...row.repository, id, fullName };
    row.result!.repository = { ...row.result!.repository, id, fullName };
    const evidence = row.result!.evidence!;
    evidence.inspectionId = crypto.randomUUID();
    evidence.observedAt = new Date(
      Date.now() - (index % FLEET.STALE_EVERY === 0 ? FLEET.STALE_AGE_MS : 0),
    ).toISOString();
    evidence.entries = Array.from({ length: index % FLEET.ENTRIES + 1 }, (_, entryIndex) => {
      const entry = structuredClone(rows[0]!.result!.evidence!.entries[0]!);
      const minute = FLEET.START_MINUTE +
        (Math.floor(index / DEPENDABOT_DAYS.length) * FLEET.STEP_MINUTES +
          entryIndex * FLEET.ENTRY_GAP_MINUTES) % FLEET.SPREAD_MINUTES;
      entry.id = DIGEST + ":update:" + entryIndex;
      entry.members = [{
        ecosystem: FLEET_ECOSYSTEMS[(index + entryIndex) % FLEET_ECOSYSTEMS.length]!,
        directories: [FLEET_DIRECTORIES[entryIndex]!],
        targetBranch: null,
      }];
      entry.schedule = {
        interval: "weekly",
        day: DEPENDABOT_DAYS[(index + entryIndex) % DEPENDABOT_DAYS.length]!,
        time: String(Math.floor(minute / FLEET.MINUTES_PER_HOUR)).padStart(2, "0") +
          ":" + String(minute % FLEET.MINUTES_PER_HOUR).padStart(2, "0"),
        timezone: FLEET_ZONES[index % FLEET_ZONES.length]!,
      };
      if (index % FLEET.OVERLAP_EVERY === 0)
        entry.schedule = { interval: "weekly", day: "monday", time: "08:00" };
      else if (index % FLEET.UNKNOWN_EVERY === 0)
        entry.schedule = { interval: "weekly" };
      else if (index % FLEET.CRON_EVERY === 0)
        entry.schedule = { interval: "cron", cronjob: "0 8,12 * * 1-5", timezone: "UTC" };
      else if (index % FLEET.DAILY_EVERY === 0)
        entry.schedule = { interval: "daily", time: "10:15", timezone: "Europe/London" };
      else if (index % FLEET.MONTHLY_EVERY === 0)
        entry.schedule = { interval: "monthly", time: "09:45", timezone: "UTC" };
      if (entryIndex === 0 && index % DEPENDABOT_DAYS.length === 0) {
        entry.id = DIGEST + ":group:0";
        entry.owner = "group";
        entry.group = "frontend";
        entry.members.push({ ecosystem: "docker", directories: ["/"], targetBranch: null });
      }
      return entry;
    });
    rows.push(row);
  }
  return rows;
}
