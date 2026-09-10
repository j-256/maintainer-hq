import { WORK_LIMITS, workEvidenceSchema } from "../shared/repository-work";
import { readGitHubContext } from "./github-context";
import { collectRepositoryWork } from "./work-client";
import type { WorkspaceService } from "./service";

export function readRepositoryWork(context: WorkspaceService, input: unknown) {
  return readGitHubContext(context, input, {
    kind: "work",
    schema: workEvidenceSchema,
    responseBytes: WORK_LIMITS.RESPONSE_BYTES,
    collect: collectRepositoryWork,
  });
}
