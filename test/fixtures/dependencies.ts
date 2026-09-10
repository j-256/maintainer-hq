import type {
  DependencyDocuments,
  DependencyPolicy,
} from "../../shared/dependency-policy";

export const DEPENDENCY_TEST_NOW = Date.parse("2026-09-10T00:00:00.000Z");
export function dependencyFixture() {
  const policy: DependencyPolicy = {
    schemaVersion: 1,
    manifests: [
      {
        path: "package.json",
        overrides: [
          {
            id: "decoder-advisory",
            lifecycle: "active",
            parent: "runner",
            package: "decoder",
            requested: "1.0.0",
            replacement: "1.0.1",
            advisory: "GHSA-2345-6789-cfgh",
            vulnerable: "<1.0.1",
            reason: "The development runner requires the patched image decoder",
            owner: "Project maintainers",
            reviewedAt: "2026-09-09T00:00:00.000Z",
            reviewBy: "2026-10-09T00:00:00.000Z",
            removeWhen:
              "Remove after both runner versions request a patched decoder and verify the resulting lockfile",
          },
        ],
      },
    ],
  };
  const manifest = {
    devDependencies: { runner: "2.1.0", harness: "1.0.0" },
    overrides: { runner: { "decoder@1.0.0": "1.0.1" } },
  };
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { devDependencies: { ...manifest.devDependencies } },
      "node_modules/runner": {
        version: "2.1.0",
        dev: true,
        dependencies: { decoder: "1.0.0" },
      },
      "node_modules/harness": {
        version: "1.0.0",
        dev: true,
        dependencies: { runner: "2.0.0" },
      },
      "node_modules/harness/node_modules/runner": {
        version: "2.0.0",
        dev: true,
        dependencies: { decoder: "1.0.0" },
      },
      "node_modules/decoder": { version: "1.0.1", dev: true },
    } as Record<string, Record<string, unknown>>,
  };
  const documents: DependencyDocuments[] = [
    { manifestPath: "package.json", manifest, lock },
  ];
  return {
    policy,
    manifest,
    lock,
    documents,
    rule: policy.manifests[0]!.overrides[0]!,
  };
}
