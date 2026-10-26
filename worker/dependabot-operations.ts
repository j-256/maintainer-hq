import {
  DEPENDABOT_LIMITS,
  DEPENDABOT_PATHS,
  dependabotScheduleLabel,
} from "../shared/dependabot";
import {
  DEPENDABOT_CHANGE_KIND,
  type DependabotChangeReview,
} from "../shared/dependabot-changes";
import {
  dependabotOperationSchema,
  type DependabotOperation,
} from "../shared/dependabot-operations";
import {
  DependabotChanges,
  type StoredDependabotReview,
} from "./dependabot-changes";
import { inspectDependabotFile } from "./dependabot-client";
import { editDependabotDocument } from "./dependabot-yaml";
import { RepositoryOperations } from "./repository-operations";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

export class DependabotOperations extends RepositoryOperations<
  DependabotChangeReview,
  StoredDependabotReview,
  DependabotOperation
> {
  constructor(context: WorkspaceService) {
    super(context, {
      kind: DEPENDABOT_CHANGE_KIND,
      branchPrefix: "hq/dependabot/",
      label: "Dependabot schedule",
      event: "hq.dependabot.operation",
      schema: dependabotOperationSchema,
      reviews: (context) => new DependabotChanges(context),
      maxFiles: 1,
      fileLimit: (path) =>
        DEPENDABOT_PATHS.some((item) => item === path)
          ? DEPENDABOT_LIMITS.FILE_BYTES
          : null,
      inspect: async (review, token, now) => {
        const inspected = await inspectDependabotFile(
          review.basis.repository.fullName,
          token,
          { now },
        );
        const e = inspected.evidence;
        return {
          ...inspected,
          requests: e.requests,
          available:
            e.read.state === "observed" && e.configuration === "present",
          matches:
            e.headSha === review.basis.headSha &&
            e.treeSha === review.basis.treeSha &&
            e.branch === review.basis.branch &&
            JSON.stringify(e.file) === JSON.stringify(review.basis.file),
        };
      },
      proposedDigest: (review) => review.proposedDigest,
      changes: (review, files) => {
        const text = files.get(review.basis.file.path);
        if (!text)
          throw new DomainError(
            "dependency_evidence_changed",
            "The reviewed schedule file is unavailable.",
            409,
          );
        return [
          {
            path: review.basis.file.path,
            content: editDependabotDocument(
              text,
              review.basis.file.digest,
              review.edits,
            ),
          },
        ];
      },
      messages: (review) => ({
        commit: "chore(dependabot): update schedules",
        title: "Update Dependabot schedules",
        body:
          "Update only the reviewed schedule mappings. Configured start times are nominal; overlaps are allowed.\n\n" +
          review.changes
            .map(
              (change) =>
                dependabotScheduleLabel(change.before.schedule) +
                " -> " +
                dependabotScheduleLabel(change.after.schedule),
            )
            .join("\n") +
          "\n\nMerge, CI, and deployment remain separate outcomes.",
      }),
    });
  }
}
