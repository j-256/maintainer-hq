import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  parseDependabotDocument,
  editDependabotDocument,
} from "../worker/dependabot-yaml";
import { DEPENDABOT_LIMITS } from "../shared/dependabot";

const digest = "sha256:" + "a".repeat(64);
const source = `# repository policy
version: 2
registries:
  private:
    type: npm-registry
    token: synthetic-private-registry-material
updates:
  - package-ecosystem: npm
    directories: ["/", "/site"]
    target-branch: main
    schedule: # keep this header
      interval: weekly # keep this comment
      day: monday
      time: "08:00"
    ignore:
      - dependency-name: "private-*"
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: daily
`;

describe("Dependabot source normalization and schedule-only edits", () => {
  it("bounds document bytes, YAML nodes, and update entries", () => {
    for (const text of [
      source + "#".repeat(DEPENDABOT_LIMITS.FILE_BYTES),
      source + "extra: [" + "0,".repeat(DEPENDABOT_LIMITS.YAML_NODES) + "0]\n",
      "version: 2\nupdates:\n" +
        Array.from(
          { length: DEPENDABOT_LIMITS.ENTRIES + 1 },
          () =>
            "  - package-ecosystem: npm\n    directory: /\n    schedule: { interval: weekly }\n",
        ).join(""),
    ])
      expect(() => parseDependabotDocument(text, digest)).toThrow(
        /limit|Too many/,
      );
  });
  it("returns normalized entries without registry or unrelated configuration", () => {
    const result = parseDependabotDocument(source, digest);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      id: digest + ":update:0",
      owner: "update",
      members: [
        { ecosystem: "npm", directories: ["/", "/site"], targetBranch: "main" },
      ],
      schedule: { interval: "weekly", day: "monday", time: "08:00" },
      editable: true,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-private|private-\*|registries|token/,
    );
    expect(result.entries[1]!.schedule).toEqual({ interval: "daily" });
  });

  it.each(["\n", "\r\n"])(
    "preserves every byte outside the selected mapping with %j line endings",
    (newline) => {
      const original = source.replaceAll("\n", newline);
      const entry = parseDependabotDocument(original, digest).entries[0]!;
      const changed = editDependabotDocument(original, digest, [
        {
          entryId: entry.id,
          schedule: {
            interval: "weekly",
            day: "friday",
            time: "09:30",
            timezone: "America/Chicago",
          },
        },
      ]);
      const start = original.indexOf("      interval:");
      const end = original.indexOf("    ignore:");
      expect(changed.startsWith(original.slice(0, start))).toBe(true);
      expect(changed.endsWith(original.slice(end))).toBe(true);
      expect(changed).toContain("# keep this comment");
      expect(changed).toContain("synthetic-private-registry-material");
      const before = parse(original),
        after = parse(changed);
      before.updates[0].schedule = after.updates[0].schedule;
      expect(after).toEqual(before);
      expect(after.updates[0].schedule).toEqual({
        interval: "weekly",
        day: "friday",
        time: "09:30",
        timezone: "America/Chicago",
      });
      if (newline === "\r\n")
        expect(changed.replaceAll("\r\n", "")).not.toContain("\n");
    },
  );

  it("edits several distinct entries without redirecting duplicate ecosystem identities", () => {
    const original = source.replace("github-actions", "npm");
    const entries = parseDependabotDocument(original, digest).entries;
    const changed = editDependabotDocument(
      original,
      digest,
      entries.map((entry) => ({
        entryId: entry.id,
        schedule: { interval: "daily" as const, time: "10:00" },
      })),
    );
    expect(
      parse(changed).updates.map(
        (entry: { schedule: unknown }) => entry.schedule,
      ),
    ).toEqual([
      { interval: "daily", time: "10:00" },
      { interval: "daily", time: "10:00" },
    ]);
    expect(() =>
      editDependabotDocument(original, digest, [
        {
          entryId: "sha256:" + "b".repeat(64) + ":update:0",
          schedule: { interval: "daily" },
        },
      ]),
    ).toThrow(/identity/);
    expect(() =>
      editDependabotDocument(original, digest, [
        { entryId: entries[0]!.id, schedule: { interval: "daily" } },
        { entryId: entries[0]!.id, schedule: { interval: "weekly" } },
      ]),
    ).toThrow(/once/);
  });

  it("compares schedule edits semantically when the original keys use a different order", () => {
    const original = source.replace(
      'interval: weekly # keep this comment\n      day: monday\n      time: "08:00"',
      'time: "08:00"\n      interval: weekly # keep this comment\n      day: monday',
    );
    const entry = parseDependabotDocument(original, digest).entries[0]!;
    const changed = editDependabotDocument(original, digest, [
      {
        entryId: entry.id,
        schedule: { interval: "weekly", day: "monday", time: "09:00" },
      },
    ]);
    expect(parse(changed).updates[0].schedule).toEqual({
      interval: "weekly",
      day: "monday",
      time: "09:00",
    });
  });

  it("marks inline or flow schedule mappings read-only before an edit is offered", () => {
    const original =
      'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: { interval: weekly, time: "08:00" }\n';
    expect(parseDependabotDocument(original, digest).entries[0]).toMatchObject({
      editable: false,
      schedule: { interval: "weekly", time: "08:00" },
    });
  });

  it("normalizes and edits one owning multi-ecosystem group", () => {
    const original = `version: 2
multi-ecosystem-groups:
  infrastructure:
    schedule:
      interval: weekly
      time: "12:00"
    labels: [dependencies]
updates:
  - package-ecosystem: docker
    directory: /
    patterns: ["*"]
    multi-ecosystem-group: infrastructure
  - package-ecosystem: terraform
    directory: /infra
    patterns: ["*"]
    multi-ecosystem-group: infrastructure
`;
    const result = parseDependabotDocument(original, digest);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry).toMatchObject({
      owner: "group",
      group: "infrastructure",
      members: [{ ecosystem: "docker" }, { ecosystem: "terraform" }],
    });
    const changed = editDependabotDocument(original, digest, [
      { entryId: entry.id, schedule: { interval: "daily", time: "11:00" } },
    ]);
    expect(parse(changed).updates).toEqual(parse(original).updates);
    expect(parse(changed)["multi-ecosystem-groups"].infrastructure).toEqual({
      schedule: { interval: "daily", time: "11:00" },
      labels: ["dependencies"],
    });
  });

  it.each([
    "version: 2\nversion: 2\nupdates: []\n",
    "version: 2\nupdates: [invalid]\n",
    "version: 3\nupdates: []\n",
    "version: 2\nupdates: [\n",
    source.replace(
      "interval: weekly",
      "interval: weekly\n      interval: daily",
    ),
    source.replace("interval: weekly", "<<: { interval: weekly }"),
    source.replace("registries:", "registries: &private"),
    source.replace("schedule: # keep this header", "schedule: *private"),
  ])(
    "rejects malformed, duplicate, alias/merge, or unsupported document ownership",
    (text) => {
      expect(() => parseDependabotDocument(text, digest)).toThrow();
    },
  );

  it("keeps unsupported schedule fields visible and read-only without exposing their values", () => {
    const result = parseDependabotDocument(
      source.replace(
        "interval: weekly # keep this comment",
        "interval: weekly\n      future-field: synthetic-unrelated-value",
      ),
      digest,
    );
    expect(result.entries[0]).toMatchObject({
      schedule: null,
      editable: false,
      issue: "unsupported_schedule",
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-unrelated-value");
    expect(() =>
      editDependabotDocument(
        source.replace(
          "interval: weekly # keep this comment",
          "interval: weekly\n      future-field: synthetic-unrelated-value",
        ),
        digest,
        [{ entryId: result.entries[0]!.id, schedule: { interval: "daily" } }],
      ),
    ).toThrow();
  });
});
