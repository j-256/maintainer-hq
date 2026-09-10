import { RELEASE_LIMITS, releaseEvidenceSchema } from "../shared/releases";
import { readGitHubContext } from "./github-context";
import { collectReleases } from "./release-client";
import type { WorkspaceService } from "./service";

export function readReleases(context: WorkspaceService, input: unknown) {
  return readGitHubContext(context, input, {
    kind: "releases",
    schema: releaseEvidenceSchema,
    responseBytes: RELEASE_LIMITS.RESPONSE_BYTES,
    collect: collectReleases,
  });
}
