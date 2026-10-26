import { DEPENDENCIES_LIMITS } from "../shared/dependencies";
import {
  DEPENDENCY_CHANGE_KIND,
  type DependencyChangeReview,
} from "../shared/dependency-changes";
import {
  dependencyOperationSchema,
  type DependencyOperation,
} from "../shared/dependency-operations";
import {
  DEPENDENCY_LIMITS,
  DEPENDENCY_POLICY_PATH,
  dependencyManifestPathSchema,
} from "../shared/dependency-policy";
import { dependencyFileChanges } from "../shared/dependency-edits";
import {
  DependencyChanges,
  type StoredDependencyReview,
} from "./dependency-changes";
import { inspectDependencyFiles } from "./dependency-client";
import { RepositoryOperations } from "./repository-operations";
import type { WorkspaceService } from "./service";
export class DependencyOperations extends RepositoryOperations<
  DependencyChangeReview,
  StoredDependencyReview,
  DependencyOperation
> {
  constructor(context: WorkspaceService) {
    super(context, {
      kind: DEPENDENCY_CHANGE_KIND,
      branchPrefix: "hq/dependencies/",
      label: "Dependency",
      event: "hq.dependencies.operation",
      schema: dependencyOperationSchema,
      reviews: (context) => new DependencyChanges(context),
      maxFiles: 2,
      fileLimit: (path) =>
        path === DEPENDENCY_POLICY_PATH
          ? DEPENDENCY_LIMITS.POLICY_BYTES
          : dependencyManifestPathSchema.safeParse(path).success
            ? DEPENDENCIES_LIMITS.FILE_BYTES
            : null,
      inspect: async (review, token, now) => {
        const inspected = await inspectDependencyFiles(
          review.basis.repository.fullName,
          token,
          { now, pullNumber: review.basis.pullNumber ?? undefined },
        );
        const e = inspected.evidence;
        return {
          ...inspected,
          requests: e.requests,
          available: e.read.state === "observed" && Boolean(e.report),
          matches:
            e.headSha === review.basis.headSha &&
            e.treeSha === review.basis.treeSha &&
            e.branch === review.basis.branch &&
            e.pullNumber === review.basis.pullNumber &&
            e.report?.policyDigest === review.basis.policyDigest &&
            JSON.stringify(e.report?.files) ===
              JSON.stringify(review.basis.files),
        };
      },
      changes: dependencyFileChanges,
      messages: (review) => ({
        commit:
          "chore(dependencies): " +
          (review.change.kind === "remove" ? "remove unused " : "renew ") +
          review.before.package +
          " override",
        title:
          (review.change.kind === "remove" ? "Remove unused " : "Renew ") +
          review.before.package +
          " override",
        body:
          "## Reviewed dependency maintenance\n\n" +
          review.after.reason +
          "\n\nThe advisory regression guard remains. This PR does not prove passing CI, merge, or deployment.",
      }),
    });
  }
}
