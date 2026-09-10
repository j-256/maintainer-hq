export const RELEASE_FIXTURE = Object.freeze({
  repository: "example/release-fixture",
  token: "synthetic-release-read-credential",
  privateValue: "synthetic-private-provider-field",
  base: "a".repeat(40),
  head: "b".repeat(40),
  timestamp: "2026-09-01T12:00:00Z",
});

export function releaseFixture(fullName: string = RELEASE_FIXTURE.repository) {
  return {
    data: {
      releaseRepository: {
        nameWithOwner: fullName,
        defaultBranchRef: {
          name: "main",
          target: { oid: RELEASE_FIXTURE.head },
        },
        latestRelease: {
          databaseId: 17,
          tagName: "v1.0.0",
          publishedAt: RELEASE_FIXTURE.timestamp,
          isDraft: false,
          isPrerelease: false,
          tagCommit: { oid: RELEASE_FIXTURE.base },
          description: RELEASE_FIXTURE.privateValue,
        },
      },
      deploymentRepository: {
        nameWithOwner: fullName,
        deployments: {
          totalCount: 1,
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              databaseId: 6089727714,
              commitOid: RELEASE_FIXTURE.head,
              createdAt: String(RELEASE_FIXTURE.timestamp),
              environment: "production",
              latestStatus: {
                state: "FAILURE",
                createdAt: RELEASE_FIXTURE.timestamp,
                logUrl: RELEASE_FIXTURE.privateValue,
              },
              payload: RELEASE_FIXTURE.privateValue,
            },
          ],
        },
      },
    },
  };
}

export function comparisonFixture() {
  return {
    status: "ahead",
    ahead_by: 3,
    behind_by: 0,
    total_commits: 3,
    base_commit: { sha: RELEASE_FIXTURE.base },
    files: [{ patch: RELEASE_FIXTURE.privateValue }],
  };
}
