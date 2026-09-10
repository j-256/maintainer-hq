import { CAPABILITY } from "../shared/domain";
import { z } from "zod";
import { idSchema } from "../shared/domain";
import { DEPENDENCIES_LIMITS } from "../shared/dependencies";
import {
  dependencyChangeApplyInput,
  DEPENDENCY_CHANGE_KIND,
  type DependencyChangeReview,
} from "../shared/dependency-changes";
import {
  DEPENDENCY_OPERATION_LIMITS as LIMITS,
  DEPENDENCY_OPERATION_REASONS,
  dependencyOperationInput,
  dependencyOperationsInput,
  dependencyOperationSchema,
  type DependencyOperation,
} from "../shared/dependency-operations";
import {
  DEPENDENCY_LIMITS,
  DEPENDENCY_POLICY_PATH,
} from "../shared/dependency-policy";
import { dependencyFileChanges } from "../shared/dependency-edits";
import {
  DependencyChanges,
  dependencyReviewGuard,
  type StoredDependencyReview,
} from "./dependency-changes";
import { dependencyCredential } from "./dependency-credentials";
import { dependencyHash, inspectDependencyFiles } from "./dependency-client";
import {
  DependencyGitHub,
  DependencyProviderFailure,
  type DependencyPull,
} from "./dependency-github";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { DomainError } from "./errors";
import { captureProjectActivity } from "./project-resources";
import { emitDiagnostic } from "./diagnostics";
import type { WorkspaceService } from "./service";

const KIND = DEPENDENCY_CHANGE_KIND;
const BRANCH_PREFIX = "hq/dependencies/";
function marker(planId: string) {
  return "Maintainer-HQ-Review: " + planId;
}
function observedPull(
  pull: DependencyPull,
  review: DependencyChangeReview,
  operation: DependencyOperation,
) {
  const repository = review.basis.repository.fullName.toLowerCase();
  if (
    pull.head.repo?.full_name.toLowerCase() !== repository ||
    pull.base.repo.full_name.toLowerCase() !== repository ||
    pull.head.ref !== operation.branch ||
    pull.base.ref !== review.basis.branch ||
    !pull.body?.includes(marker(operation.planId))
  )
    throw new DependencyProviderFailure("identity_changed");
  if (pull.head.sha !== operation.commitSha)
    throw new DependencyProviderFailure("identity_changed");
  return {
    number: pull.number,
    state: pull.state,
    merged: pull.merged ?? false,
    headSha: pull.head.sha,
  };
}
export class DependencyOperations {
  constructor(readonly context: WorkspaceService) {}
  get db() {
    return this.context.db;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  private async row(workspaceId: string, planId: string) {
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const actor = hookActorGuard(this.context, workspaceId, CAPABILITY.OPERATE);
    const row = await this.db
      .prepare(
        `SELECT result_json FROM operations WHERE workspace_id=? AND plan_id=? AND kind=? AND ${actor.sql}`,
      )
      .bind(workspaceId, planId, KIND, ...actor.values)
      .first<string>("result_json");
    return row ? dependencyOperationSchema.parse(JSON.parse(row)) : null;
  }
  private public(operation: DependencyOperation) {
    return operation.status === "running" &&
      Date.parse(operation.executionExpiresAt) <= this.context.now()
      ? {
          ...operation,
          status: "indeterminate" as const,
          reason: "interrupted" as const,
        }
      : operation;
  }
  async get(input: unknown) {
    const { workspaceId, planId } = dependencyOperationInput.parse(input);
    const row = await this.row(workspaceId, planId);
    return row ? this.public(row) : null;
  }
  async list(input: unknown) {
    const { workspaceId, repositoryId, before } =
      dependencyOperationsInput.parse(input);
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const guard = hookActorGuard(this.context, workspaceId, CAPABILITY.OPERATE);
    let cursor: { createdAt: string; id: string } | null = null;
    if (before) {
      try {
        cursor = z
          .object({ createdAt: z.iso.datetime(), id: idSchema })
          .strict()
          .parse(JSON.parse(atob(before)));
      } catch {
        throw new DomainError(
          "validation",
          "Select a valid dependency history page.",
          400,
        );
      }
    }
    const result = await this.db
      .prepare(
        `SELECT result_json FROM operations WHERE workspace_id=? AND kind=? AND json_extract(result_json,'$.repositoryId')=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) AND ${guard.sql} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .bind(
        workspaceId,
        KIND,
        repositoryId,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        ...guard.values,
        LIMITS.HISTORY_PAGE + 1,
      )
      .all<{ result_json: string }>();
    await authorizeHooks(this.context, workspaceId, CAPABILITY.OPERATE);
    const items = result.results
      .slice(0, LIMITS.HISTORY_PAGE)
      .map((row) =>
        this.public(
          dependencyOperationSchema.parse(JSON.parse(row.result_json)),
        ),
      );
    return {
      items,
      nextBefore:
        result.results.length > LIMITS.HISTORY_PAGE
          ? btoa(
              JSON.stringify({
                createdAt: items.at(-1)!.startedAt,
                id: items.at(-1)!.id,
              }),
            )
          : null,
    };
  }
  private async check(
    workspaceId: string,
    stored: StoredDependencyReview,
    deadline: string,
  ) {
    if (Date.parse(deadline) <= this.context.now() + LIMITS.REQUEST_MS)
      throw new DomainError(
        "dependency_access_changed",
        "The execution deadline was reached.",
        409,
      );
    const guard = await dependencyReviewGuard(this.context, stored);
    if (
      !stored.review.writer ||
      !stored.writerIdentity ||
      !(await this.db
        .prepare(`SELECT 1 WHERE ${guard.sql}`)
        .bind(...guard.values)
        .first())
    )
      throw new DomainError(
        "dependency_access_changed",
        "The original reviewed authority is no longer available.",
        409,
      );
    const credential = await dependencyCredential(
      this.context,
      workspaceId,
      stored.review.writer.id,
      stored.review.basis.repository.fullName,
    );
    if (
      credential.identity !== stored.writerIdentity ||
      credential.revision !== stored.review.writer.revision
    )
      throw new DomainError(
        "dependency_access_changed",
        "Repository write access changed.",
        409,
      );
    return credential;
  }
  private async persist(
    workspaceId: string,
    operation: DependencyOperation,
    elapsed: number,
    requests: number,
  ) {
    operation.updatedAt = this.timestamp();
    operation.elapsedMs = Math.max(0, Math.round(elapsed));
    operation.requests = requests;
    const result = await this.db
      .prepare(
        `UPDATE operations SET status=?,summary=?,result_json=?,updated_at=? WHERE workspace_id=? AND id=? AND plan_id=? AND kind=? AND status='running'`,
      )
      .bind(
        operation.status,
        DEPENDENCY_OPERATION_REASONS[operation.reason],
        JSON.stringify(dependencyOperationSchema.parse(operation)),
        operation.updatedAt,
        workspaceId,
        operation.id,
        operation.planId,
        KIND,
      )
      .run();
    if (!result.meta.changes)
      throw new DomainError(
        "conflict",
        "Operation recording changed. Reload the original operation.",
        409,
      );
  }
  private audit(
    workspaceId: string,
    operation: DependencyOperation,
    title: string,
  ) {
    const eventId = crypto.randomUUID();
    return [
      this.db
        .prepare(
          `INSERT INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
        SELECT ?,?,?,?,'dependency.operation.updated',?,?,? WHERE EXISTS (SELECT 1 FROM operations WHERE workspace_id=? AND id=? AND updated_at=?)`,
        )
        .bind(
          eventId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          title,
          DEPENDENCY_OPERATION_REASONS[operation.reason],
          this.timestamp(),
          workspaceId,
          operation.id,
          operation.updatedAt,
        ),
      this.db
        .prepare(
          `INSERT INTO activity_repository_links (workspace_id,event_id,repository_id) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?) AND EXISTS (SELECT 1 FROM repositories WHERE workspace_id=? AND id=?)`,
        )
        .bind(
          workspaceId,
          eventId,
          operation.repositoryId,
          workspaceId,
          eventId,
          workspaceId,
          operation.repositoryId,
        ),
      captureProjectActivity(this.db, workspaceId, eventId),
    ];
  }
  async apply(input: unknown) {
    const { workspaceId, planId, fingerprint } =
      dependencyChangeApplyInput.parse(input);
    const reviews = new DependencyChanges(this.context);
    const { row, stored } = await reviews.load(workspaceId, planId);
    if (fingerprint !== row.fingerprint)
      throw new DomainError("conflict", "Confirm the exact saved review.", 409);
    const previous = await this.row(workspaceId, planId);
    if (previous) return this.public(previous);
    const review = await reviews.review({ workspaceId, planId });
    if (review.state !== "ready" || !review.writer)
      throw new DomainError(
        "conflict",
        "Prepare a fresh review with repository write access before submitting a pull request.",
        409,
      );
    const started = performance.now();
    const operation: DependencyOperation = {
      id: crypto.randomUUID(),
      planId,
      repositoryId: review.basis.repository.id,
      status: "running",
      phase: "checking",
      reason: "checking",
      branch: BRANCH_PREFIX + planId,
      treeSha: null,
      commitSha: null,
      pullRequest: null,
      files: [],
      requests: 0,
      elapsedMs: 0,
      startedAt: this.timestamp(),
      updatedAt: this.timestamp(),
      executionExpiresAt: new Date(
        this.context.now() + LIMITS.EXECUTION_MS,
      ).toISOString(),
      observedAt: null,
      nextReconcileAt: null,
    };
    await this.check(workspaceId, stored, operation.executionExpiresAt);
    const guard = await dependencyReviewGuard(this.context, stored);
    const claimed = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO operations (id,workspace_id,plan_id,actor_subject,kind,status,summary,result_json,created_at,updated_at)
        SELECT ?,?,?,?,?,'running',?,?,?,? WHERE ${guard.sql} AND EXISTS (SELECT 1 FROM action_plans WHERE id=? AND workspace_id=? AND applied_at IS NULL AND fingerprint=? AND expires_at>? AND julianday(expires_at)>julianday('now'))
        AND (SELECT count(*) FROM operations WHERE workspace_id=? AND kind=?)<?
        AND (SELECT count(*) FROM operations WHERE workspace_id=? AND kind=? AND created_at>?)<?`,
        )
        .bind(
          operation.id,
          workspaceId,
          planId,
          this.context.principal.subject,
          KIND,
          DEPENDENCY_OPERATION_REASONS.checking,
          JSON.stringify(operation),
          operation.startedAt,
          operation.updatedAt,
          ...guard.values,
          planId,
          workspaceId,
          fingerprint,
          this.timestamp(),
          workspaceId,
          KIND,
          LIMITS.HISTORY,
          workspaceId,
          KIND,
          new Date(this.context.now() - LIMITS.START_WINDOW_MS).toISOString(),
          LIMITS.STARTS_PER_WINDOW,
        ),
      this.db
        .prepare(
          `UPDATE action_plans SET applied_at=? WHERE workspace_id=? AND id=? AND EXISTS (SELECT 1 FROM operations WHERE id=? AND plan_id=?)`,
        )
        .bind(this.timestamp(), workspaceId, planId, operation.id, planId),
    ]);
    if (!claimed[0].meta.changes) {
      const existing = await this.get({ workspaceId, planId });
      if (existing) return existing;
      throw new DomainError(
        "conflict",
        "The review changed, the submission budget was reached, or operation history is at its capacity. Wait five minutes before another submission or review existing outcomes. No write was sent.",
        409,
      );
    }
    await this.db.batch(
      this.audit(workspaceId, operation, "Dependency change accepted"),
    );
    let client: DependencyGitHub | null = null;
    let readRequests = 0;
    const save = () =>
      this.persist(
        workspaceId,
        operation,
        performance.now() - started,
        readRequests + (client?.requests ?? 0),
      );
    try {
      const credential = await this.check(
        workspaceId,
        stored,
        operation.executionExpiresAt,
      );
      client = new DependencyGitHub(
        review.basis.repository.fullName,
        credential.token,
        fetch,
        LIMITS.REQUEST_MS,
        Date.parse(operation.executionExpiresAt),
      );
      const inspected = await inspectDependencyFiles(
        review.basis.repository.fullName,
        credential.token,
        {
          now: this.context.now,
          pullNumber: review.basis.pullNumber ?? undefined,
        },
      );
      readRequests = inspected.evidence.requests;
      if (
        inspected.evidence.read.state !== "observed" ||
        !inspected.evidence.report
      )
        throw new DependencyProviderFailure("provider_unavailable");
      if (
        inspected.evidence.headSha !== review.basis.headSha ||
        inspected.evidence.treeSha !== review.basis.treeSha ||
        inspected.evidence.branch !== review.basis.branch ||
        inspected.evidence.pullNumber !== review.basis.pullNumber ||
        inspected.evidence.report.policyDigest !== review.basis.policyDigest ||
        JSON.stringify(inspected.evidence.report.files) !==
          JSON.stringify(review.basis.files)
      )
        throw new DomainError(
          "dependency_evidence_changed",
          "The repository changed after review.",
          409,
        );
      const changes = dependencyFileChanges(
        review,
        inspected.files,
        this.context.now(),
      );
      const files = [];
      for (const file of changes) {
        const mode = inspected.modes.get(file.path);
        if (
          !mode ||
          new TextEncoder().encode(file.content).byteLength >
            (file.path === DEPENDENCY_POLICY_PATH
              ? DEPENDENCY_LIMITS.POLICY_BYTES
              : DEPENDENCIES_LIMITS.FILE_BYTES)
        )
          throw new DomainError(
            "dependency_evidence_changed",
            "The edit exceeds the reviewed file bounds.",
            409,
          );
        files.push({ ...file, mode });
        operation.files.push({
          path: file.path,
          beforeDigest: await dependencyHash(inspected.files.get(file.path)!),
          afterDigest: await dependencyHash(file.content),
        });
      }
      for (const phase of [
        "tree",
        "commit",
        "branch",
        "pull_request",
      ] as const) {
        await this.check(workspaceId, stored, operation.executionExpiresAt);
        if (
          (phase === "branch" || phase === "pull_request") &&
          (await client.readBranch(review.basis.branch)) !==
            review.basis.headSha
        )
          throw new DomainError(
            "dependency_evidence_changed",
            "The reviewed base branch moved during submission.",
            409,
          );
        if (phase === "branch" || phase === "pull_request")
          await this.check(workspaceId, stored, operation.executionExpiresAt);
        operation.phase = phase;
        await save();
        if (phase === "tree")
          operation.treeSha = await client.tree(review.basis.treeSha, files);
        if (phase === "commit")
          operation.commitSha = await client.commit(
            review.basis.headSha,
            operation.treeSha!,
            "chore(dependencies): " +
              (review.change.kind === "remove" ? "remove unused " : "renew ") +
              review.before.package +
              " override\n\n" +
              marker(planId),
          );
        if (phase === "branch")
          await client.branch(operation.branch, operation.commitSha!);
        if (phase === "pull_request")
          operation.pullRequest = observedPull(
            await client.pull(
              operation.branch,
              review.basis.branch,
              (review.change.kind === "remove" ? "Remove unused " : "Renew ") +
                review.before.package +
                " override",
              "## Reviewed dependency maintenance\n\n" +
                review.after.reason +
                "\n\n" +
                "The advisory regression guard remains. This PR does not prove passing CI, merge, or deployment.\n\n" +
                marker(planId) +
                "\n" +
                fingerprint,
            ),
            review,
            operation,
          );
        await save();
      }
      operation.phase = "finished";
      operation.status = "succeeded";
      operation.reason = "complete";
      operation.observedAt = this.timestamp();
    } catch (error) {
      operation.reason =
        error instanceof DependencyProviderFailure
          ? error.reason
          : error instanceof DomainError &&
              error.code === "dependency_evidence_changed"
            ? "evidence_changed"
            : error instanceof DomainError &&
                error.code === "dependency_access_changed"
              ? "access_changed"
              : operation.phase === "checking"
                ? "provider_unavailable"
                : "outcome_unknown";
      operation.status =
        operation.reason === "outcome_unknown"
          ? "indeterminate"
          : operation.phase === "checking"
            ? "failed"
            : "partial";
    }
    await save();
    await this.db.batch(
      this.audit(
        workspaceId,
        operation,
        operation.status === "succeeded"
          ? "Dependency pull request created"
          : "Dependency change needs attention",
      ),
    );
    emitDiagnostic({
      event: "hq.dependencies.operation",
      action: "submit",
      reference: operation.id,
      workspaceId,
      repositoryId: operation.repositoryId,
      phase: operation.phase,
      status: operation.status,
      reason: operation.reason,
      requests: operation.requests,
      elapsedMs: operation.elapsedMs,
    });
    return this.get({ workspaceId, planId });
  }
  async reconcile(input: unknown) {
    const { workspaceId, planId } = dependencyOperationInput.parse(input);
    const operation = await this.row(workspaceId, planId);
    if (!operation)
      throw new DomainError(
        "not_found",
        "Dependency operation not found.",
        404,
      );
    if (
      operation.status === "running" &&
      Date.parse(operation.executionExpiresAt) > this.context.now()
    )
      return operation;
    if (
      operation.nextReconcileAt &&
      Date.parse(operation.nextReconcileAt) > this.context.now()
    )
      return this.public(operation);
    const reviews = new DependencyChanges(this.context);
    const { stored } = await reviews.load(workspaceId, planId);
    const review = await reviews.review({ workspaceId, planId });
    const credential = await this.check(
      workspaceId,
      stored,
      new Date(this.context.now() + LIMITS.EXECUTION_MS).toISOString(),
    );
    const nextRead = new Date(
      this.context.now() + LIMITS.RECONCILE_MS,
    ).toISOString();
    const guard = await dependencyReviewGuard(this.context, stored);
    const claimed = await this.db
      .prepare(
        `UPDATE operations SET result_json=json_set(result_json,'$.nextReconcileAt',?) WHERE workspace_id=? AND id=? AND result_json=? AND ${guard.sql}`,
      )
      .bind(
        nextRead,
        workspaceId,
        operation.id,
        JSON.stringify(operation),
        ...guard.values,
      )
      .run();
    if (!claimed.meta.changes) return this.get({ workspaceId, planId });
    const started = performance.now();
    operation.nextReconcileAt = nextRead;
    const client = new DependencyGitHub(
      review.basis.repository.fullName,
      credential.token,
    );
    let observed = false;
    try {
      const pulls = operation.pullRequest
        ? [await client.readPull(operation.pullRequest.number)]
        : await client.findPull(operation.branch);
      if (pulls.length > 1)
        throw new DependencyProviderFailure("identity_changed");
      if (pulls.length) {
        const full = operation.pullRequest
          ? pulls[0]!
          : await client.readPull(pulls[0]!.number);
        operation.pullRequest = observedPull(full, review, operation);
        operation.status = "succeeded";
        operation.reason = "complete";
        operation.phase = "finished";
      } else {
        const sha = await client.readBranch(operation.branch);
        if (sha !== operation.commitSha)
          throw new DependencyProviderFailure("identity_changed");
        operation.status = "partial";
        operation.reason = "branch_only";
      }
      observed = true;
    } catch (error) {
      operation.status = "indeterminate";
      operation.reason =
        error instanceof DependencyProviderFailure
          ? error.reason
          : "provider_unavailable";
    }
    operation.observedAt = observed ? this.timestamp() : operation.observedAt;
    operation.updatedAt = this.timestamp();
    await this.check(
      workspaceId,
      stored,
      new Date(this.context.now() + LIMITS.EXECUTION_MS).toISOString(),
    );
    await this.db
      .prepare(
        `UPDATE operations SET status=?,summary=?,result_json=?,updated_at=? WHERE workspace_id=? AND id=? AND json_extract(result_json,'$.nextReconcileAt')=? AND ${guard.sql}`,
      )
      .bind(
        operation.status,
        DEPENDENCY_OPERATION_REASONS[operation.reason],
        JSON.stringify(operation),
        operation.updatedAt,
        workspaceId,
        operation.id,
        nextRead,
        ...guard.values,
      )
      .run();
    emitDiagnostic({
      event: "hq.dependencies.operation",
      action: "reconcile",
      reference: operation.id,
      workspaceId,
      repositoryId: operation.repositoryId,
      phase: operation.phase,
      status: operation.status,
      reason: operation.reason,
      requests: client.requests,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    });
    return this.get({ workspaceId, planId });
  }
}
