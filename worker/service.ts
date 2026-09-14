import { HookSetup } from "./hook-setup";
import { ExpectationReviews } from "./expectation-review";
import {
  CAPABILITY,
  LIMITS,
  ROLE_CAPABILITIES,
  createRepositoryInput,
  expectationSchema,
  getRepositoryInput,
  updateRepositoryInput,
  workspaceInput,
  addActivityInput,
  syncGoalInput,
  type Activity,
  type Capability,
  type Connection,
  type Member,
  type Observation,
  type Principal,
  type Project,
  type Provider,
  type Repository,
  type Snapshot,
  type Workspace,
  type Goal,
} from "../shared/domain";
import { DomainError } from "./errors";
import type { Env } from "./types";
import { SourceService } from "./sources";
import { SOURCE_LIMITS } from "../shared/sources";
import {
  GitHubSources,
  GITHUB_SOURCE_SELECT,
  describeGitHubSources,
  type GitHubSourceRow,
} from "./github-sources";
import { GitHubJobs } from "./github-jobs";
import { githubCoverage } from "./github-coverage";
import { readReleases } from "./releases";
import { readRepositoryWork } from "./repository-work";
import { listDependencies, readRepositoryDependencies } from "./dependencies";
import { DependencyChanges } from "./dependency-changes";
import { dependencyWriteAccess } from "./dependency-credentials";
import { DependencyOperations } from "./dependency-operations";
import { readWorkspaceAttention, readAttentionConnection } from "./attention";
import { MembershipService } from "./membership";
import { AutomationService } from "./automation";
import { ImportService } from "./import";
import { ExpectationBulkService } from "./expectation-bulk";
import { ProjectOrganizationService } from "./project-organization";
import { FleetDiscoveryService } from "./fleet-discovery";
import { FleetReconciliationService } from "./fleet-reconciliation";
import { reportActorGuard } from "./report-authority";
import { ActivityReader } from "./activity";
import { activityFeedInput, goalActivityInput } from "../shared/activity";
import { PreferenceService } from "./preferences";
import { HooksService } from "./hooks";
import { ResourceLinksService } from "./resource-links";
import { repositoryContext } from "./repository-context";
import { RepositoryCoverageService } from "./repository-coverage";
import { repositoryAccess } from "./repository-access";
import { MonitoringService } from "./monitoring";
import { MonitoringOperations } from "./monitoring-operations";
import { hookProviderReferences } from "./hook-client";
import { monitorProviderReferences } from "./monitoring-client";
import { HookRetries } from "./hook-retries";
import { HookPolicies } from "./hook-policies";
import { SecretsService } from "./secrets";
import { ProviderCredentials } from "./provider-credentials";
import { SecretReviews } from "./secret-reviews";
import { SecretOperations } from "./secret-operations";
import { SecretRecovery } from "./secret-recovery";
import { SecretCleanup } from "./secret-cleanup";
import { ManagedConfigurations } from "./managed-configurations";
import { ManagedConfigurationOperations } from "./managed-configuration-operations";
import { WorkspaceSync } from "./workspace-sync";
import { ProjectService } from "./projects";
import { ProjectTransfers } from "./project-transfers";
import {
  ProjectResourcesService,
  captureProjectActivity,
} from "./project-resources";
import { authorizeHooks, hookActorGuard } from "./hook-authority";

type RepositoryRow = {
  id: string;
  workspace_id: string;
  full_name: string;
  description: string;
  project_id: string;
  classification: Repository["classification"];
  lifecycle: Repository["lifecycle"];
  expectations_json: string;
  revision: number;
  updated_at: string;
};

type GoalRow = Goal & {
  actorSubject: string;
  writeId: string;
  reporterId: string | null;
};
const GOAL_FIELDS =
  "id, source_id AS sourceId, objective, status, actor_name AS actor, started_at AS startedAt, reported_at AS reportedAt, received_at AS receivedAt";

function goalFromRow(row: GoalRow): Goal {
  return {
    id: row.id,
    sourceId: row.sourceId,
    objective: row.objective,
    status: row.status,
    actor: row.actor,
    startedAt: row.startedAt,
    reportedAt: row.reportedAt,
    receivedAt: row.receivedAt,
  };
}

function repositoryFromRow(row: RepositoryRow): Repository {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    fullName: row.full_name,
    description: row.description,
    projectId: row.project_id,
    classification: row.classification,
    lifecycle: row.lifecycle,
    expectations: expectationSchema.parse(JSON.parse(row.expectations_json)),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export class WorkspaceService {
  dependencyChangeApply(input: unknown) { return new DependencyOperations(this).apply(input); }
  dependencyOperationGet(input: unknown) { return new DependencyOperations(this).get(input); }
  dependencyOperationReconcile(input: unknown) { return new DependencyOperations(this).reconcile(input); }
  dependencyOperationsList(input: unknown) { return new DependencyOperations(this).list(input); }
  dependencyWriteAccess(input: unknown) { return dependencyWriteAccess(this, input); }
  dependencyChangePlan(input: unknown) { return new DependencyChanges(this).plan(input); }
  dependencyChangeReview(input: unknown) { return new DependencyChanges(this).review(input); }
  dependenciesList(input: unknown) {
    return listDependencies(this, input);
  }
  repositoryDependencies(input: unknown) {
    return readRepositoryDependencies(this, input);
  }
  repositoryWork(input: unknown) {
    return readRepositoryWork(this, input);
  }
  repositoryReleases(input: unknown) {
    return readReleases(this, input);
  }
  workspaceAttention(input: unknown) {
    return readWorkspaceAttention(this, input);
  }
  attentionConnection(input: unknown) {
    return readAttentionConnection(this, input);
  }
  readonly db: D1Database;
  constructor(
    readonly env: Env,
    readonly principal: Principal,
    readonly development = false,
    readonly now: () => number = Date.now,
    readonly kickGitHub?: () => void,
  ) {
    this.db = env.HQ_DB;
  }

  private get membership() {
    return new MembershipService(this);
  }
  fleetDiscover(input: unknown) {
    return new FleetDiscoveryService(this).discover(input);
  }
  fleetSources(input: unknown) {
    return new FleetDiscoveryService(this).sources(input);
  }
  fleetReconciliationPlan(input: unknown) {
    return new FleetReconciliationService(this).plan(input);
  }
  fleetReconciliationReview(input: unknown) {
    return new FleetReconciliationService(this).review(input);
  }
  fleetReconciliationApply(input: unknown) {
    return new FleetReconciliationService(this).apply(input);
  }
  providerCredentialsList(input: unknown) {
    return new ProviderCredentials(this).list(input);
  }
  providerCredentialPlan(input: unknown) {
    return new ProviderCredentials(this).plan(input);
  }
  providerCredentialReview(input: unknown) {
    return new ProviderCredentials(this).review(input);
  }
  providerCredentialApply(input: unknown) {
    return new ProviderCredentials(this).apply(input);
  }
  providerCredentialVerify(input: unknown) {
    return new ProviderCredentials(this).verify(input);
  }
  secretsConnections(input: unknown) {
    return new SecretsService(this).list(input);
  }
  secretsConfigurations(input: unknown) {
    return new ManagedConfigurations(this).list(input);
  }
  secretsConfigurationSave(input: unknown) {
    return new ManagedConfigurations(this).save(input);
  }
  secretsConfigurationStop(input: unknown) {
    return new ManagedConfigurations(this).stop(input);
  }
  secretsConfigurationStatus(input: unknown) {
    return new ManagedConfigurations(this).status(input);
  }
  secretsConfigurationPlan(input: unknown) {
    return new ManagedConfigurationOperations(this).plan(input);
  }
  secretsConfigurationReview(input: unknown) {
    return new ManagedConfigurationOperations(this).get(input);
  }
  secretsConfigurationApply(input: unknown) {
    return new ManagedConfigurationOperations(this).apply(input);
  }
  secretsConfigurationReconcile(input: unknown) {
    return new ManagedConfigurationOperations(this).reconcile(input);
  }
  secretsConfigurationHistory(input: unknown) {
    return new ManagedConfigurationOperations(this).history(input);
  }
  secretsCleanupPlan(input: unknown) {
    return new SecretCleanup(this).plan(input);
  }
  secretsCleanupReview(input: unknown) {
    return new SecretCleanup(this).get(input);
  }
  secretsCleanupHistory(input: unknown) {
    return new SecretCleanup(this).history(input);
  }
  secretsCleanupApply(input: unknown) {
    return new SecretCleanup(this).apply(input);
  }
  secretsCleanupReconcile(input: unknown) {
    return new SecretCleanup(this).reconcile(input);
  }
  secretsApply(input: unknown) {
    return new SecretOperations(this).apply(input);
  }
  secretsRecoveryPlan(input: unknown) {
    return new SecretRecovery(this).plan(input);
  }
  secretsRun(input: unknown) {
    return new SecretOperations(this).run(input);
  }
  secretsReconcile(input: unknown) {
    return new SecretOperations(this).reconcile(input);
  }
  secretsDraft(input: unknown) {
    return new SecretReviews(this).draft(input);
  }
  secretsReview(input: unknown) {
    return new SecretReviews(this).get(input);
  }
  secretsHistory(input: unknown) {
    return new SecretReviews(this).history(input);
  }
  secretsCancel(input: unknown) {
    return new SecretReviews(this).cancel(input);
  }
  secretsProviders(input: unknown) {
    return new SecretsService(this).providers(input);
  }
  secretsConnectionSave(input: unknown) {
    return new SecretsService(this).save(input);
  }
  secretsScopes(input: unknown) {
    return new SecretsService(this).scopes(input);
  }
  secretsInventory(input: unknown) {
    return new SecretsService(this).inventory(input);
  }
  hooksConnections(input: unknown) {
    return new HooksService(this).list(input);
  }
  monitoringConnections(input: unknown) {
    return new MonitoringService(this).list(input);
  }
  monitoringProviders(input: unknown) {
    return new MonitoringService(this).providers(input);
  }
  monitoringConnectionSave(input: unknown) {
    return new MonitoringService(this).save(input);
  }
  monitoringSnapshot(input: unknown) {
    return new MonitoringService(this).snapshot(input);
  }
  monitoringConfiguration(input: unknown) {
    return new MonitoringService(this).configuration(input);
  }
  monitoringTargets(input: unknown) {
    return new MonitoringService(this).targets(input);
  }
  monitoringTarget(input: unknown) {
    return new MonitoringService(this).target(input);
  }
  monitoringIncidents(input: unknown) {
    return new MonitoringService(this).incidents(input);
  }
  monitoringIncident(input: unknown) {
    return new MonitoringService(this).incident(input);
  }
  monitoringConfigurationPlan(input: unknown) {
    return new MonitoringOperations(this).configurationPlan(input);
  }
  monitoringTriagePlan(input: unknown) {
    return new MonitoringOperations(this).triagePlan(input);
  }
  monitoringApply(input: unknown) {
    return new MonitoringOperations(this).apply(input);
  }
  monitoringReview(input: unknown) {
    return new MonitoringOperations(this).get(input);
  }
  monitoringReconcile(input: unknown) {
    return new MonitoringOperations(this).reconcile(input);
  }
  monitoringHistory(input: unknown) {
    return new MonitoringOperations(this).history(input);
  }
  resourceRepositories(input: unknown) {
    return new ResourceLinksService(this).get(input);
  }
  resourceRepositoriesSave(input: unknown) {
    return new ResourceLinksService(this).save(input);
  }
  repositoryResources(input: unknown) {
    return new ResourceLinksService(this).forRepository(input);
  }
  repositoryContext(input: unknown) {
    return repositoryContext(this, input);
  }
  repositoryCoverage(input: unknown) {
    return new RepositoryCoverageService(this).read(input);
  }
  repositoryCoverageGet(input: unknown) {
    return new RepositoryCoverageService(this).read(input, false);
  }
  expectationReviewComplete(input: unknown) {
    return new ExpectationReviews(this).complete(input);
  }
  expectationReviewGet(input: unknown) {
    return new ExpectationReviews(this).get(input);
  }

  repositoryAccess(input: unknown) {
    return repositoryAccess(this, input);
  }
  resourceProject(input: unknown) {
    return new ProjectResourcesService(this).get(input);
  }
  resourceProjectSave(input: unknown) {
    return new ProjectResourcesService(this).save(input);
  }
  projectResources(input: unknown) {
    return new ProjectResourcesService(this).forProject(input);
  }
  hooksProviders(input: unknown) {
    return new HooksService(this).providers(input);
  }
  hooksConnectionSave(input: unknown) {
    return new HooksService(this).save(input);
  }
  hooksSnapshot(input: unknown) {
    return new HooksService(this).snapshot(input);
  }
  hooksSubscriptions(input: unknown) {
    return new HooksService(this).subscriptions(input);
  }
  hooksDeliveries(input: unknown) {
    return new HooksService(this).deliveries(input);
  }
  hooksDelivery(input: unknown) {
    return new HooksService(this).delivery(input);
  }
  hooksAssociationGet(input: unknown) {
    return new HooksService(this).association(input);
  }
  hooksAssociationSave(input: unknown) {
    return new HooksService(this).associate(input);
  }
  hooksRetryPlan(input: unknown) {
    return new HookRetries(this).plan(input);
  }
  hooksRetryApply(input: unknown) {
    return new HookRetries(this).apply(input);
  }
  hooksRetryGet(input: unknown) {
    return new HookRetries(this).get(input);
  }
  hooksRetryReconcile(input: unknown) {
    return new HookRetries(this).reconcile(input);
  }
  hooksHistory(input: unknown) {
    return new HookRetries(this).history(input);
  }
  hooksConfiguration(input: unknown) {
    return new HookPolicies(this).configuration(input);
  }
  hooksSetupConfiguration(input: unknown) {
    return new HookSetup(this).configuration(input);
  }
  hooksSetupStatus(input: unknown) {
    return new HookSetup(this).status(input);
  }
  hooksSetupPlan(input: unknown) {
    return new HookSetup(this).plan(input);
  }
  hooksSetupGet(input: unknown) {
    return new HookSetup(this).get(input);
  }
  hooksSetupApply(input: unknown) {
    return new HookSetup(this).apply(input);
  }
  hooksSetupReconcile(input: unknown) {
    return new HookSetup(this).reconcile(input);
  }
  hooksPolicySubscriptions(input: unknown) {
    return new HookPolicies(this).page(input, "subscriptions");
  }
  hooksPolicyDestinations(input: unknown) {
    return new HookPolicies(this).page(input, "sinks");
  }
  hooksPolicySubscription(input: unknown) {
    return new HookPolicies(this).detail(input);
  }
  hooksPolicyPlan(input: unknown) {
    return new HookPolicies(this).plan(input);
  }
  hooksPolicyApply(input: unknown) {
    return new HookPolicies(this).apply(input);
  }
  hooksPolicyGet(input: unknown) {
    return new HookPolicies(this).get(input);
  }
  hooksPolicyReconcile(input: unknown) {
    return new HookPolicies(this).reconcile(input);
  }
  preferencesGet(input: unknown) {
    return new PreferenceService(this).get(input);
  }
  preferencesUpdate(input: unknown) {
    return new PreferenceService(this).update(input);
  }
  setupStatus(input: unknown) {
    return this.membership.setupStatus(input);
  }
  setupApply(input: unknown) {
    return this.membership.setupApply(input);
  }
  membersList(input: unknown) {
    return this.membership.list(input);
  }
  memberUpdate(input: unknown) {
    return this.membership.update(input);
  }
  memberRemove(input: unknown) {
    return this.membership.remove(input);
  }
  invitationsList(input: unknown) {
    return this.membership.invitations(input);
  }
  invitationCreate(input: unknown) {
    return this.membership.invite(input);
  }
  invitationRevoke(input: unknown) {
    return this.membership.revoke(input);
  }
  ownInvitations(input: unknown) {
    return this.membership.ownInvitations(input);
  }
  invitationAccept(input: unknown) {
    return this.membership.accept(input);
  }
  automationCredentials(input: unknown) {
    return new AutomationService(this).list(input);
  }
  automationCredentialPlan(input: unknown) {
    return new AutomationService(this).plan(input);
  }
  automationCredentialIssue(input: unknown) {
    return new AutomationService(this).issue(input);
  }
  automationCredentialRevoke(input: unknown) {
    return new AutomationService(this).revoke(input);
  }
  metadataImportStatus(input: unknown) {
    return new ImportService(this).status(input);
  }
  metadataImportPlan(input: unknown) {
    return new ImportService(this).plan(input);
  }
  metadataImportApply(input: unknown) {
    return new ImportService(this).apply(input);
  }
  expectationBulkPlan(input: unknown) {
    return new ExpectationBulkService(this).plan(input);
  }
  projectOrganizationPlan(input: unknown) {
    return new ProjectOrganizationService(this).plan(input);
  }
  projectOrganizationReview(input: unknown) {
    return new ProjectOrganizationService(this).review(input);
  }
  projectOrganizationApply(input: unknown) {
    return new ProjectOrganizationService(this).apply(input);
  }
  expectationBulkReview(input: unknown) {
    return new ExpectationBulkService(this).review(input);
  }
  expectationBulkApply(input: unknown) {
    return new ExpectationBulkService(this).apply(input);
  }

  private async assertLiveIdentity(capability: Capability) {
    const principal = this.principal;
    if (principal.expiresAt !== undefined && principal.expiresAt <= this.now())
      throw new DomainError(
        "unauthorized",
        "Your workspace sign-in expired. Authenticate again before continuing.",
        401,
      );
    if (!principal.tokenId) return;
    const credential = await this.db
      .prepare(
        `SELECT 1 FROM credentials c JOIN members m ON m.workspace_id=c.workspace_id AND m.subject=c.owner_subject
        WHERE c.id=? AND c.workspace_id=? AND c.owner_subject=? AND c.revoked_at IS NULL
          AND julianday(c.expires_at)>julianday(?) AND julianday(c.expires_at)>julianday('now')
          AND c.source_id IS ? AND c.reporter_id IS ?
          AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value=?)`,
      )
      .bind(
        principal.tokenId,
        principal.workspaceId ?? null,
        principal.subject,
        new Date(this.now()).toISOString(),
        principal.sourceId ?? null,
        principal.reporterId ?? null,
        capability,
      )
      .first();
    if (!credential)
      throw new DomainError(
        "forbidden",
        "Your live workspace credential no longer permits this operation. Check access before continuing.",
        403,
      );
  }

  async authorize(
    workspaceId: string,
    capability: Capability = CAPABILITY.READ,
  ): Promise<Workspace> {
    workspaceInput.parse({ workspaceId });
    if (
      this.principal.workspaceId &&
      this.principal.workspaceId !== workspaceId
    )
      throw new DomainError("not_found", "Workspace not found", 404);
    const row = await this.db
      .prepare(
        "SELECT w.id, w.name, m.role FROM workspaces w JOIN members m ON m.workspace_id = w.id WHERE w.id = ? AND m.subject = ?",
      )
      .bind(workspaceId, this.principal.subject)
      .first<Workspace>();
    if (!row) throw new DomainError("not_found", "Workspace not found", 404);
    const permitted = ROLE_CAPABILITIES[row.role];
    const publisher =
      capability === CAPABILITY.PUBLISH &&
      Boolean(this.principal.tokenId && this.principal.sourceId) &&
      this.principal.scopes?.length === 1 &&
      this.principal.scopes[0] === CAPABILITY.PUBLISH &&
      permitted.includes(CAPABILITY.EDIT);
    if (
      (!publisher && !permitted?.includes(capability)) ||
      (this.principal.scopes && !this.principal.scopes.includes(capability))
    ) {
      throw new DomainError(
        "forbidden",
        "Your role does not allow this operation",
        403,
      );
    }
    await this.assertLiveIdentity(capability);
    return row;
  }

  async session() {
    if (
      this.principal.scopes &&
      !this.principal.scopes.includes(CAPABILITY.READ)
    )
      throw new DomainError(
        "forbidden",
        "This credential cannot read workspace information",
        403,
      );
    await this.assertLiveIdentity(CAPABILITY.READ);
    const rows = await this.db
      .prepare(
        "SELECT w.id, w.name, m.role FROM workspaces w JOIN members m ON m.workspace_id = w.id WHERE m.subject = ? ORDER BY w.name",
      )
      .bind(this.principal.subject)
      .all<Workspace>();
    const workspaces = rows.results.filter(
      (row) =>
        !this.principal.workspaceId || this.principal.workspaceId === row.id,
    );
    return {
      principal: {
        subject: this.principal.subject,
        displayName: this.principal.displayName,
      },
      workspaces,
      development: this.development,
      preferences: await new PreferenceService(this).own(),
    };
  }

  async repositories(input: unknown): Promise<Repository[]> {
    const { workspaceId } = workspaceInput.parse(input);
    await this.authorize(workspaceId);
    const rows = await this.db
      .prepare(
        "SELECT * FROM repositories WHERE workspace_id = ? ORDER BY full_name LIMIT ?",
      )
      .bind(workspaceId, LIMITS.MAX_REPOSITORIES + 1)
      .all<RepositoryRow>();
    if (rows.results.length > LIMITS.MAX_REPOSITORIES)
      throw new DomainError(
        "capacity",
        "Repository inventory exceeds the supported workspace limit",
        409,
      );
    return rows.results.map(repositoryFromRow);
  }

  async repository(input: unknown): Promise<Repository> {
    const { workspaceId, repositoryId } = getRepositoryInput.parse(input);
    await this.authorize(workspaceId);
    const row = await this.db
      .prepare("SELECT * FROM repositories WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, repositoryId)
      .first<RepositoryRow>();
    if (!row) throw new DomainError("not_found", "Repository not found", 404);
    return repositoryFromRow(row);
  }

  projects(input: unknown): Promise<Project[]> {
    return new ProjectService(this).list(input);
  }
  project(input: unknown) {
    return new ProjectService(this).get(input);
  }
  updateProject(input: unknown) {
    return new ProjectService(this).update(input);
  }
  projectTransferDestinations(input: unknown) {
    return new ProjectTransfers(this).destinations(input);
  }
  projectTransferPreview(input: unknown) {
    return new ProjectTransfers(this).preview(input);
  }
  projectTransferPlan(input: unknown) {
    return new ProjectTransfers(this).plan(input);
  }
  projectTransferReview(input: unknown) {
    return new ProjectTransfers(this).get(input);
  }
  projectTransferApply(input: unknown) {
    return new ProjectTransfers(this).apply(input);
  }
  departedResourceContext(input: unknown) {
    return new ProjectTransfers(this).departed(input);
  }

  async activity(input: unknown): Promise<Activity[]> {
    const { workspaceId } = workspaceInput.parse(input);
    await this.authorize(workspaceId);
    return (
      await this.db
        .prepare(
          "SELECT id, actor_name AS actor, type, title, summary, resource_id AS resourceId, goal_id AS goalId, created_at AS createdAt, github_source_id AS githubSourceId, github_refresh_id AS githubRefreshId, github_source_name AS githubSourceName FROM activity WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .bind(workspaceId, LIMITS.PAGE_SIZE)
        .all<Activity>()
    ).results;
  }

  async activityFeed(input: unknown) {
    const parsed = activityFeedInput.parse(input);
    await this.authorize(parsed.workspaceId);
    if (parsed.projectId)
      await new ProjectTransfers(this).historyProject(
        parsed.workspaceId,
        parsed.projectId,
      );
    const feed = await new ActivityReader(this.db).feed(parsed);
    await this.authorize(parsed.workspaceId);
    return feed;
  }

  async goalActivity(input: unknown) {
    const parsed = goalActivityInput.parse(input);
    await this.authorize(parsed.workspaceId);
    if (parsed.projectId)
      await new ProjectTransfers(this).historyProject(
        parsed.workspaceId,
        parsed.projectId,
      );
    const events = await new ActivityReader(this.db).goal(parsed);
    await this.authorize(parsed.workspaceId);
    return events;
  }

  async members(input: unknown): Promise<Member[]> {
    const { workspaceId } = workspaceInput.parse(input);
    await this.authorize(workspaceId, CAPABILITY.ADMIN);
    return (
      await this.db
        .prepare(
          "SELECT subject, display_name AS displayName, role FROM members WHERE workspace_id = ? ORDER BY display_name",
        )
        .bind(workspaceId)
        .all<Member>()
    ).results;
  }

  async addActivity(input: unknown): Promise<Activity> {
    const { workspaceId, eventId, kind, title, summary, resourceId, goalId } =
      addActivityInput.parse(input);
    await this.authorize(workspaceId, CAPABILITY.ACTIVITY);
    const guard = this.reportGuard(workspaceId, CAPABILITY.ACTIVITY);
    await this.assertReportAuthority(guard);
    if (
      resourceId &&
      !(await this.db
        .prepare(
          "SELECT 1 FROM repositories WHERE workspace_id=? AND id=? UNION ALL SELECT 1 FROM projects WHERE workspace_id=? AND id=?",
        )
        .bind(workspaceId, resourceId, workspaceId, resourceId)
        .first())
    )
      throw new DomainError(
        "not_found",
        "Repository or project not found",
        404,
      );
    const reporterId = this.principal.reporterId ?? null;
    const goalGuard = {
      sql: "(? IS NULL OR EXISTS (SELECT 1 FROM goals g WHERE g.workspace_id = ? AND g.id = ? AND (? IS NULL OR (g.reporter_id = ? AND g.actor_subject = ?))))",
      values: [
        goalId,
        workspaceId,
        goalId,
        reporterId,
        reporterId,
        this.principal.subject,
      ],
    };
    if (
      !(await this.db
        .prepare(`SELECT 1 WHERE ${goalGuard.sql}`)
        .bind(...goalGuard.values)
        .first())
    )
      throw new DomainError(
        "not_found",
        "Goal not found for this activity writer",
        404,
      );
    const type = "update." + kind;
    await this.db
      .prepare(
        `INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at, reporter_id, goal_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql} AND (? IS NULL OR EXISTS (SELECT 1 FROM repositories WHERE workspace_id=? AND id=? UNION ALL SELECT 1 FROM projects WHERE workspace_id=? AND id=?)) AND ${goalGuard.sql} ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        eventId,
        workspaceId,
        this.principal.subject,
        this.principal.displayName,
        type,
        title,
        summary,
        resourceId,
        new Date(this.now()).toISOString(),
        this.principal.reporterId ?? null,
        goalId,
        ...guard.values,
        resourceId,
        workspaceId,
        resourceId,
        workspaceId,
        resourceId,
        ...goalGuard.values,
      )
      .run();
    await this.assertReportAuthority(guard);
    const row = await this.db
      .prepare(
        "SELECT id, actor_subject, reporter_id AS reporterId, actor_name AS actor, type, title, summary, resource_id AS resourceId, goal_id AS goalId, created_at AS createdAt, github_source_id AS githubSourceId, github_refresh_id AS githubRefreshId, github_source_name AS githubSourceName FROM activity WHERE workspace_id = ? AND id = ?",
      )
      .bind(workspaceId, eventId)
      .first<Activity & { actor_subject: string; reporterId: string | null }>();
    if (
      !row ||
      row.actor_subject !== this.principal.subject ||
      row.reporterId !== (this.principal.reporterId ?? null) ||
      row.type !== type ||
      row.title !== title ||
      row.summary !== summary ||
      row.resourceId !== resourceId ||
      row.goalId !== goalId
    ) {
      throw new DomainError(
        "conflict",
        "This event ID has already been used. Start a new update to publish different content.",
        409,
      );
    }
    return {
      id: row.id,
      actor: row.actor,
      type: row.type,
      title: row.title,
      summary: row.summary,
      resourceId: row.resourceId,
      goalId: row.goalId,
      createdAt: row.createdAt,
    };
  }

  private reportGuard(
    workspaceId: string,
    capability: typeof CAPABILITY.ACTIVITY | typeof CAPABILITY.GOALS,
  ) {
    return reportActorGuard(
      workspaceId,
      this.principal,
      capability,
      new Date(this.now()).toISOString(),
    );
  }

  private async assertReportAuthority(
    guard: ReturnType<typeof reportActorGuard>,
  ) {
    if (
      !(await this.db
        .prepare(`SELECT 1 WHERE ${guard.sql}`)
        .bind(...guard.values)
        .first())
    )
      throw new DomainError(
        "forbidden",
        "Reporting access changed or this credential expired. Contact a workspace owner.",
        403,
      );
  }

  async goals(input: unknown): Promise<Goal[]> {
    const { workspaceId } = workspaceInput.parse(input);
    await this.authorize(workspaceId);
    return (
      await this.db
        .prepare(
          `SELECT ${GOAL_FIELDS} FROM goals WHERE workspace_id = ? ORDER BY (status IN ('complete', 'cleared')), julianday(started_at) DESC, id DESC LIMIT ?`,
        )
        .bind(workspaceId, LIMITS.PAGE_SIZE)
        .all<Goal>()
    ).results;
  }

  async syncGoal(input: unknown): Promise<Goal> {
    const parsed = syncGoalInput.parse(input);
    const { workspaceId, goalId, sourceId, objective, status } = parsed;
    const startedAt = new Date(parsed.startedAt).toISOString();
    const reportedAt = new Date(parsed.reportedAt).toISOString();
    await this.authorize(workspaceId, CAPABILITY.GOALS);
    if (this.principal.reporterId && this.principal.reporterId !== sourceId)
      throw new DomainError(
        "forbidden",
        "This credential can only synchronize its bound reporter's goals",
        403,
      );
    const guard = this.reportGuard(workspaceId, CAPABILITY.GOALS);
    await this.assertReportAuthority(guard);
    if (
      Date.parse(reportedAt) > this.now() + LIMITS.FUTURE_SKEW_MS ||
      Date.parse(startedAt) > Date.parse(reportedAt)
    )
      throw new DomainError(
        "validation",
        "Goal timestamps are inconsistent",
        400,
      );
    const matchesIdentity = (row: GoalRow) =>
      row.actorSubject === this.principal.subject &&
      row.reporterId === (this.principal.reporterId ?? null) &&
      row.sourceId === sourceId &&
      row.objective === objective &&
      Date.parse(row.startedAt) === Date.parse(startedAt);
    const matchesReport = (row: GoalRow) =>
      matchesIdentity(row) &&
      Date.parse(row.reportedAt) === Date.parse(reportedAt) &&
      row.status === status;
    const before = await this.goalRow(workspaceId, goalId);
    if (before && !matchesIdentity(before))
      throw new DomainError(
        "conflict",
        "A goal identity must retain its original source and verbatim objective",
        409,
      );
    if (before && Date.parse(before.reportedAt) > Date.parse(reportedAt))
      throw new DomainError(
        "conflict",
        "A newer goal update has already been received",
        409,
      );
    if (before && Date.parse(before.reportedAt) === Date.parse(reportedAt)) {
      if (matchesReport(before)) {
        await this.assertReportAuthority(guard);
        return goalFromRow(before);
      }
      throw new DomainError(
        "conflict",
        "A different goal status was already reported for this instant",
        409,
      );
    }
    const receivedAt = new Date(this.now()).toISOString();
    const writeId = crypto.randomUUID();
    const statements = [
      this.db
        .prepare(
          `INSERT INTO goals (id, workspace_id, source_id, actor_subject, actor_name, objective, status, started_at, reported_at, received_at, write_id, reporter_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql} ON CONFLICT (workspace_id, id) DO UPDATE SET status = excluded.status, reported_at = excluded.reported_at, received_at = excluded.received_at, write_id = excluded.write_id WHERE goals.write_id = ?`,
        )
        .bind(
          goalId,
          workspaceId,
          sourceId,
          this.principal.subject,
          this.principal.displayName,
          objective,
          status,
          startedAt,
          reportedAt,
          receivedAt,
          writeId,
          this.principal.reporterId ?? null,
          ...guard.values,
          before?.writeId ?? null,
        ),
    ];
    const results = await this.db.batch(statements);
    await this.assertReportAuthority(guard);
    if (!results[0]?.meta.changes) {
      const concurrent = await this.goalRow(workspaceId, goalId);
      if (concurrent && matchesReport(concurrent))
        return goalFromRow(concurrent);
      throw new DomainError(
        "conflict",
        "This goal changed during synchronization",
        409,
      );
    }
    return {
      id: goalId,
      sourceId,
      objective,
      status,
      actor: before?.actor ?? this.principal.displayName,
      startedAt: before?.startedAt ?? startedAt,
      reportedAt,
      receivedAt,
    };
  }

  private goalRow(workspaceId: string, goalId: string) {
    return this.db
      .prepare(
        `SELECT ${GOAL_FIELDS}, actor_subject AS actorSubject, write_id AS writeId, reporter_id AS reporterId FROM goals WHERE workspace_id = ? AND id = ?`,
      )
      .bind(workspaceId, goalId)
      .first<GoalRow>();
  }

  async connections(
    input: unknown,
    selectedIds?: string[],
  ): Promise<Connection[]> {
    const { workspaceId } = workspaceInput.parse(input);
    await this.authorize(workspaceId);
    const rows = await this.db
      .prepare(
        "SELECT s.id, s.name, s.provider, s.credential_ref, s.last_attempt_at, s.last_success_at, s.last_error, s.revision, s.enabled, s.freshness_minutes, EXISTS (SELECT 1 FROM credentials c JOIN members m ON m.workspace_id = c.workspace_id AND m.subject = c.owner_subject WHERE c.workspace_id = s.workspace_id AND c.source_id = s.id AND c.revoked_at IS NULL AND c.expires_at > ? AND m.role IN ('owner', 'operator')) AS publisher_credential FROM connections s WHERE s.workspace_id = ? AND (? IS NULL OR s.id IN (SELECT value FROM json_each(?))) ORDER BY s.name LIMIT ?",
      )
      .bind(
        new Date(this.now()).toISOString(),
        workspaceId,
        selectedIds ? JSON.stringify(selectedIds) : null,
        selectedIds ? JSON.stringify(selectedIds) : null,
        SOURCE_LIMITS.SOURCES + 1,
      )
      .all<{
        id: string;
        name: string;
        provider: Provider;
        credential_ref: string | null;
        last_attempt_at: string | null;
        last_success_at: string | null;
        last_error: string | null;
        revision: number;
        enabled: number;
        freshness_minutes: number;
        publisher_credential: number;
      }>();
    if (rows.results.length > SOURCE_LIMITS.SOURCES)
      throw new DomainError(
        "capacity",
        "Source inventory exceeds the supported workspace limit",
        409,
      );
    const scopes = (
      await this.db
        .prepare(
          "SELECT source_id, repository_id FROM source_repositories WHERE workspace_id = ? AND (? IS NULL OR source_id IN (SELECT value FROM json_each(?))) ORDER BY repository_id",
        )
        .bind(
          workspaceId,
          selectedIds ? JSON.stringify(selectedIds) : null,
          selectedIds ? JSON.stringify(selectedIds) : null,
        )
        .all<{ source_id: string; repository_id: string }>()
    ).results;
    let available: Record<string, unknown> = {};
    try {
      available = this.env.CREDENTIALS ? JSON.parse(this.env.CREDENTIALS) : {};
    } catch {
      /* Invalid deployment credentials remain unavailable */
    }
    const githubRows = (
      await this.db
        .prepare(
          GITHUB_SOURCE_SELECT +
            " AND (? IS NULL OR s.id IN (SELECT value FROM json_each(?)))",
        )
        .bind(
          workspaceId,
          selectedIds ? JSON.stringify(selectedIds) : null,
          selectedIds ? JSON.stringify(selectedIds) : null,
        )
        .all<GitHubSourceRow>()
    ).results;
    const github = new Map(
      (
        await describeGitHubSources(
          this.env,
          workspaceId,
          githubRows,
          scopes,
          this.now(),
        )
      ).map((source) => [source.id, source]),
    );
    return rows.results.map(
      (row) =>
        github.get(row.id) ?? {
          id: row.id,
          name: row.name,
          provider: row.provider,
          lastAttemptAt: row.last_attempt_at,
          lastSuccessAt: row.last_success_at,
          lastError: row.last_error,
          revision: row.revision,
          enabled: Boolean(row.enabled),
          freshnessMinutes: row.freshness_minutes,
          repositoryIds: scopes
            .filter((scope) => scope.source_id === row.id)
            .map((scope) => scope.repository_id),
          credentialConfigured:
            row.provider === "local"
              ? Boolean(row.publisher_credential)
              : row.provider === "hookrelay"
                ? hookProviderReferences(this.env, workspaceId).some(
                    (value) =>
                      value.id === row.credential_ref && value.available,
                  )
                : row.provider === "endpoint-monitor"
                  ? monitorProviderReferences(this.env, workspaceId).some(
                      (value) =>
                        value.id === row.credential_ref && value.available,
                    )
                  : Boolean(
                      row.credential_ref &&
                        Object.hasOwn(available, row.credential_ref),
                    ),
        },
    );
  }

  async observations(input: unknown): Promise<Observation[]> {
    const { workspaceId } = workspaceInput.parse(input);
    await this.authorize(workspaceId);
    const rows = await this.db
      .prepare(
        "SELECT o.*, c.provider FROM observations o JOIN connections c ON c.workspace_id = o.workspace_id AND c.id = o.source_id WHERE o.workspace_id = ? AND (c.provider NOT IN ('local', 'github') OR EXISTS (SELECT 1 FROM source_repositories s WHERE s.workspace_id = o.workspace_id AND s.source_id = o.source_id AND s.repository_id = o.resource_id)) ORDER BY julianday(o.observed_at) DESC LIMIT ?",
      )
      .bind(workspaceId, LIMITS.MAX_OBSERVATIONS + 1)
      .all<{
        source_id: string;
        resource_type: Observation["resourceType"];
        resource_id: string;
        name: string;
        health: Observation["health"];
        summary: string;
        details_json: string;
        observed_at: string;
        expires_at: string;
        received_at: string;
        provider: Provider;
      }>();
    if (rows.results.length > LIMITS.MAX_OBSERVATIONS)
      throw new DomainError(
        "capacity",
        "Observation inventory exceeds the supported workspace limit",
        409,
      );
    return rows.results.map((row) => ({
      sourceId: row.source_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      name: row.name,
      health: row.health,
      summary: row.summary,
      details: JSON.parse(row.details_json),
      observedAt: row.observed_at,
      expiresAt: row.expires_at,
      receivedAt: row.received_at,
      provider: row.provider,
    }));
  }

  async snapshot(input: unknown): Promise<Snapshot> {
    const { workspaceId } = workspaceInput.parse(input);
    const workspace = await this.authorize(workspaceId);
    const [projects, repositories, observations, connections, activity, goals] =
      await Promise.all([
        this.projects(input),
        this.repositories(input),
        this.observations(input),
        this.connections(input),
        this.activity(input),
        this.goals(input),
      ]);
    const capabilities = ROLE_CAPABILITIES[workspace.role].filter(
      (capability) =>
        !this.principal.scopes || this.principal.scopes.includes(capability),
    );
    return {
      workspace,
      principal: {
        subject: this.principal.subject,
        displayName: this.principal.displayName,
      },
      capabilities,
      projects,
      repositories,
      observations,
      connections,
      activity,
      goals,
      generatedAt: new Date(this.now()).toISOString(),
      development: this.development,
    };
  }

  workspaceView(input: unknown) {
    return new WorkspaceSync(this).view(input);
  }

  workspaceChanges(input: unknown) {
    return new WorkspaceSync(this).changes(input);
  }

  sourceGet(input: unknown) {
    return new SourceService(this).get(input);
  }
  githubSourceGet(input: unknown) {
    return new GitHubSources(this).get(input);
  }
  githubCoverage(input: unknown) {
    return githubCoverage(this, input);
  }
  githubSourceEnroll(input: unknown) {
    return new GitHubSources(this).enroll(input);
  }
  githubSourceUpdate(input: unknown) {
    return new GitHubSources(this).update(input);
  }
  githubCredentials(input: unknown) {
    return new GitHubSources(this).credentialReferences(input);
  }
  githubRefresh(input: unknown) {
    return new GitHubJobs(this).refresh(input);
  }
  githubRefreshGet(input: unknown) {
    return new GitHubJobs(this).get(input);
  }
  githubRefreshes(input: unknown) {
    return new GitHubJobs(this).list(input);
  }
  githubRefreshCancel(input: unknown) {
    return new GitHubJobs(this).cancel(input);
  }
  sourceEnroll(input: unknown) {
    return new SourceService(this).enroll(input);
  }
  sourceUpdate(input: unknown) {
    return new SourceService(this).update(input);
  }
  publisherCredentials(input: unknown) {
    return new SourceService(this).credentials(input);
  }
  publisherCredentialIssue(input: unknown) {
    return new SourceService(this).issue(input);
  }
  publisherCredentialRevoke(input: unknown) {
    return new SourceService(this).revoke(input);
  }
  observationsPublish(input: unknown) {
    return new SourceService(this).publish(input);
  }

  private audit(
    workspaceId: string,
    type: string,
    title: string,
    summary: string,
    resourceId: string | null,
    table: "projects" | "repositories",
    id = crypto.randomUUID(),
  ) {
    return this.db
      .prepare(
        `INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${table} WHERE workspace_id = ? AND id = ?)`,
      )
      .bind(
        id,
        workspaceId,
        this.principal.subject,
        this.principal.displayName,
        type,
        title,
        summary,
        resourceId,
        new Date(this.now()).toISOString(),
        workspaceId,
        resourceId,
      );
  }

  createProject(input: unknown) {
    return new ProjectService(this).create(input);
  }

  async createRepository(input: unknown) {
    const { workspaceId, repository } = createRepositoryInput.parse(input);
    const memberRevision = await authorizeHooks(
      this,
      workspaceId,
      CAPABILITY.EDIT,
    );
    const guard = hookActorGuard(
      this,
      workspaceId,
      CAPABILITY.EDIT,
      memberRevision,
    );
    await this.validateProject(workspaceId, repository.projectId);
    const duplicate = await this.db
      .prepare(
        "SELECT id FROM repositories WHERE workspace_id = ? AND full_name = ?",
      )
      .bind(workspaceId, repository.fullName)
      .first();
    if (duplicate)
      throw new DomainError(
        "conflict",
        "This repository is already in the workspace",
        409,
      );
    const count = await this.db
      .prepare(
        "SELECT count(*) AS total FROM repositories WHERE workspace_id = ?",
      )
      .bind(workspaceId)
      .first<{ total: number }>();
    if ((count?.total ?? 0) >= LIMITS.MAX_REPOSITORIES)
      throw new DomainError(
        "capacity",
        "Workspace repository limit reached",
        409,
      );
    const id = crypto.randomUUID();
    const timestamp = new Date(this.now()).toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO repositories (id, workspace_id, full_name, description, project_id, classification, lifecycle, expectations_json, revision, updated_at, write_id) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE (SELECT count(*) FROM repositories WHERE workspace_id = ?) < ? AND ${guard.sql}
            AND EXISTS (SELECT 1 FROM projects WHERE workspace_id=? AND id=?) ON CONFLICT (workspace_id, full_name) DO NOTHING`,
        )
        .bind(
          id,
          workspaceId,
          repository.fullName,
          repository.description,
          repository.projectId,
          repository.classification,
          repository.lifecycle,
          JSON.stringify(repository.expectations),
          timestamp,
          crypto.randomUUID(),
          workspaceId,
          LIMITS.MAX_REPOSITORIES,
          ...guard.values,
          workspaceId,
          repository.projectId,
        ),
      this.audit(
        workspaceId,
        "repository.created",
        "Repository enrolled",
        repository.fullName,
        id,
        "repositories",
      ),
    ]);
    if (!results[0]?.meta.changes) {
      await authorizeHooks(this, workspaceId, CAPABILITY.EDIT);
      await this.validateProject(workspaceId, repository.projectId);
      if (
        !(await this.db
          .prepare(`SELECT 1 WHERE ${guard.sql}`)
          .bind(...guard.values)
          .first())
      )
        throw new DomainError(
          "revision_conflict",
          "Workspace access changed while enrolling this repository. Keep your draft and review again.",
          409,
        );
      const exists = await this.db
        .prepare(
          "SELECT id FROM repositories WHERE workspace_id = ? AND full_name = ?",
        )
        .bind(workspaceId, repository.fullName)
        .first();
      throw new DomainError(
        exists ? "conflict" : "capacity",
        exists
          ? "This repository is already in the workspace"
          : "Workspace repository limit reached",
        409,
      );
    }
    return this.repository({ workspaceId, repositoryId: id });
  }

  async updateRepository(input: unknown) {
    const { workspaceId, repositoryId, repository, revision } =
      updateRepositoryInput.parse(input);
    const memberRevision = await authorizeHooks(
      this,
      workspaceId,
      CAPABILITY.EDIT,
    );
    const guard = hookActorGuard(
      this,
      workspaceId,
      CAPABILITY.EDIT,
      memberRevision,
    );
    const before = await this.repository({ workspaceId, repositoryId });
    if (before.revision !== revision)
      throw new DomainError(
        "revision_conflict",
        "This repository changed while you were editing. Your draft has been preserved.",
        409,
      );
    await this.validateProject(workspaceId, repository.projectId);
    const duplicate = await this.db
      .prepare(
        "SELECT id FROM repositories WHERE workspace_id = ? AND full_name = ? AND id != ?",
      )
      .bind(workspaceId, repository.fullName, repositoryId)
      .first();
    if (duplicate)
      throw new DomainError(
        "conflict",
        "Another record already uses that repository name",
        409,
      );
    const timestamp = new Date(this.now()).toISOString();
    const writeId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const changed = Object.keys(repository).filter(
      (key) =>
        JSON.stringify(repository[key as keyof typeof repository]) !==
        JSON.stringify(before[key as keyof typeof repository]),
    );
    if (!changed.length) return before;
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE repositories SET full_name = ?, description = ?, project_id = ?, classification = ?, lifecycle = ?, expectations_json = ?, revision = revision + 1, updated_at = ?, write_id = ? WHERE workspace_id = ? AND id = ? AND revision = ? AND NOT EXISTS (SELECT 1 FROM repositories WHERE workspace_id = ? AND full_name = ? AND id != ?) AND ${guard.sql}
            AND EXISTS (SELECT 1 FROM projects WHERE workspace_id=? AND id=?)`,
        )
        .bind(
          repository.fullName,
          repository.description,
          repository.projectId,
          repository.classification,
          repository.lifecycle,
          JSON.stringify(repository.expectations),
          timestamp,
          writeId,
          workspaceId,
          repositoryId,
          revision,
          workspaceId,
          repository.fullName,
          repositoryId,
          ...guard.values,
          workspaceId,
          repository.projectId,
        ),
      this.db
        .prepare(
          "INSERT INTO activity (id, workspace_id, actor_subject, actor_name, type, title, summary, resource_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM repositories WHERE workspace_id = ? AND id = ? AND write_id = ?)",
        )
        .bind(
          eventId,
          workspaceId,
          this.principal.subject,
          this.principal.displayName,
          "repository.updated",
          "Repository updated",
          repository.fullName + ": " + changed.join(", "),
          repositoryId,
          timestamp,
          workspaceId,
          repositoryId,
          writeId,
        ),
      captureProjectActivity(this.db, workspaceId, eventId, null, null, null, [
        before.projectId,
        repository.projectId,
      ]),
    ]);
    if (!results[0]?.meta.changes) {
      await authorizeHooks(this, workspaceId, CAPABILITY.EDIT);
      await this.validateProject(workspaceId, repository.projectId);
      if (
        !(await this.db
          .prepare(`SELECT 1 WHERE ${guard.sql}`)
          .bind(...guard.values)
          .first())
      )
        throw new DomainError(
          "revision_conflict",
          "Workspace access changed while editing this repository. Keep your draft and review again.",
          409,
        );
      const latest = await this.repository({ workspaceId, repositoryId });
      if (latest.revision === revision)
        throw new DomainError(
          "conflict",
          "Another record already uses that repository name",
          409,
        );
      throw new DomainError(
        "revision_conflict",
        "This repository changed while you were editing. Your draft has been preserved.",
        409,
      );
    }
    return this.repository({ workspaceId, repositoryId });
  }

  private async validateProject(workspaceId: string, projectId: string) {
    if (
      !(await this.db
        .prepare("SELECT id FROM projects WHERE workspace_id = ? AND id = ?")
        .bind(workspaceId, projectId)
        .first())
    ) {
      throw new DomainError(
        "validation",
        "Choose a project from this workspace",
        400,
      );
    }
  }
}
