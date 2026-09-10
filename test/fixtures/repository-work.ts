export const WORK_FIXTURE = Object.freeze({
  repository: "example/work-fixture",
  token: "synthetic-work-read-token",
  privateValue: "synthetic-private-provider-payload",
  timestamp: "2026-09-08T12:00:00Z",
  head: "a".repeat(40),
});
export function providerPull(
  number = 1,
  author = { __typename: "User", login: "contributor" },
) {
  return {
    id: "PR_synthetic_" + number,
    number,
    title: "Review dependency update " + number,
    state: "OPEN",
    createdAt: "2026-06-01T12:00:00Z",
    updatedAt: "2026-09-07T12:00:00Z",
    isDraft: false,
    headRefOid: WORK_FIXTURE.head,
    author,
  };
}
export function workFixture(
  fullName: string = WORK_FIXTURE.repository,
  pulls = [
    providerPull(1),
    providerPull(2, { __typename: "Bot", login: "dependabot" }),
  ],
) {
  const connection = () => ({
    totalCount: pulls.length,
    pageInfo: { hasNextPage: false },
    nodes: structuredClone(pulls),
  });
  return {
    data: {
      pullRepository: {
        nameWithOwner: fullName,
        recent: connection(),
        oldest: connection(),
      },
      issueRepository: {
        nameWithOwner: fullName,
        hasIssuesEnabled: true,
        issues: {
          totalCount: 1,
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              number: 3,
              title: "Document first-use workflow",
              state: "OPEN",
              createdAt: "2026-05-01T12:00:00Z",
              updatedAt: "2026-09-07T12:00:00Z",
            },
          ],
        },
      },
    },
    private: WORK_FIXTURE.privateValue,
  };
}
export function workSignalsFixture(
  fullName: string = WORK_FIXTURE.repository,
  ids = ["PR_synthetic_2", "PR_synthetic_1"],
) {
  return {
    data: {
      nodes: ids.map((id) => {
        const number = Number(id.split("_").at(-1));
        return {
          id,
          number,
          state: "OPEN",
          repository: { nameWithOwner: fullName },
          headRefOid: WORK_FIXTURE.head,
          reviewDecision: number === 1 ? "REVIEW_REQUIRED" : "APPROVED",
          reviewRequests: { totalCount: number === 1 ? 0 : 1 },
          commits: {
            nodes: [
              {
                commit: {
                  oid: WORK_FIXTURE.head,
                  statusCheckRollup: {
                    state: number === 1 ? "FAILURE" : "SUCCESS",
                  },
                },
              },
            ],
          },
          body: WORK_FIXTURE.privateValue,
        };
      }),
    },
  };
}
