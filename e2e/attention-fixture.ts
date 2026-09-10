import {
  DEFAULT_PORTFOLIO,
  type Connection,
  type Project,
} from "../shared/domain";
import { operationalItem } from "../shared/attention-operations";
import {
  attentionConnectionInput,
  type AttentionConnection,
} from "../shared/attention";
import { coverageFixture } from "./github-coverage-fixture";

export function attentionFixture() {
  const coverage = coverageFixture();
  const now = Date.now();
  const projects: Project[] = [
    {
      id: "shared-project",
      workspaceId: "development",
      name: "Important service",
      description: "Synthetic shared project",
      lifecycle: "active",
      importance: "critical",
      importanceNote: "",
      portfolio: { ...DEFAULT_PORTFOLIO },
      revision: 1,
      updatedAt: new Date(now).toISOString(),
    },
    {
      id: "standalone-project",
      workspaceId: "development",
      name: "Independent project",
      description: "Synthetic project without repositories",
      lifecycle: "active",
      importance: "high",
      importanceNote: "",
      portfolio: { ...DEFAULT_PORTFOLIO, reviewDate: "2026-01-01" },
      revision: 1,
      updatedAt: new Date(now).toISOString(),
    },
  ];
  const repositories = coverage.repositories.map((repository, index) => ({
    ...repository,
    projectId: projects[0].id,
    expectations: {
      ...repository.expectations,
      reviewDate: index === 0 ? "2026-01-01" : null,
    },
  }));
  const observations = coverage.observations.map((observation) => ({
    ...observation,
    details: {
      ...observation.details,
      ci: "failing" as const,
      openFindings: 2,
    },
    summary: "Synthetic raw summary should not appear in attention",
  }));
  const operational: Connection[] = [
    { id: "attention-hooks", name: "Primary hooks", provider: "hookrelay" },
    {
      id: "attention-monitors",
      name: "Primary monitoring",
      provider: "endpoint-monitor",
    },
    {
      id: "attention-other",
      name: "Secondary hooks connection",
      provider: "hookrelay",
    },
  ].map((source) => ({
    ...source,
    provider: source.provider as Connection["provider"],
    revision: 1,
    enabled: true,
    credentialConfigured: true,
    freshnessMinutes: 5,
    repositoryIds: [],
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  }));
  function response(input: unknown): AttentionConnection {
    const { connectionId, revision } = attentionConnectionInput.parse(input);
    const source = operational.find((source) => source.id === connectionId)!;
    return {
      connectionId,
      revision,
      readAt: new Date(now).toISOString(),
      limited: false,
      items:
        connectionId === "attention-hooks"
          ? [
              operationalItem("development", source, "hook", now, {
                id: "delivery",
                title: "Hook delivery exhausted retries",
                category: "problem",
                reason:
                  "Phone sink exhausted its retries. Inspect the exact delivery.",
                resourceKey: "important-changes",
                repositoryIds: [repositories[1].id, repositories[2].id],
                projectIds: [projects[0].id],
                action: "Inspect delivery",
                href: "/hooks?workspace=development&connection=attention-hooks&event=synthetic-event&sink=phone&subscription=important-changes",
              }),
            ]
          : connectionId === "attention-monitors"
            ? [
                operationalItem("development", source, "monitor", now, {
                  id: "check",
                  title: "Monitoring check failed",
                  category: "problem",
                  severity: "critical",
                  reason: "The configuration-matching check returned HTTP 503.",
                  resourceKey: "service-health",
                  action: "Inspect target",
                  href: "/monitoring?workspace=development&connection=attention-monitors&target=service-health",
                }),
                operationalItem("development", source, "monitor", now, {
                  id: "stale",
                  title: "Monitoring scheduler evidence is overdue",
                  category: "coverage",
                  reason:
                    "The last completed run is beyond its deadline. Inspect scheduler evidence.",
                }),
              ]
            : [],
    };
  }
  return {
    projects,
    repositories,
    observations,
    connections: [...coverage.sources, ...operational],
    response,
  };
}
