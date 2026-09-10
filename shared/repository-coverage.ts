import { getRepositoryInput, type Observation } from "./domain";
import type { CoverageEvidence } from "./coverage-evidence";

export const repositoryCoverageInput = getRepositoryInput;
export type RepositoryCoverage = {
  repositoryId: string;
  phase: "ready" | "pending" | "cooldown";
  nextReadAt: string | null;
  generatedAt: string;
  links: { hooks: number; monitoring: number };
  evidence: {
    connectionId: string;
    connectionName: string;
    kind: "hook" | "monitor";
    observation: Observation & { details: { coverage: CoverageEvidence } };
  }[];
};
