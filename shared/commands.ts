import {
  hookSetupConnectionInput,
  hookSetupPlanInput,
  hookSetupStatusInput,
} from "./hook-setup";
import { activityFeedInput, goalActivityInput } from "./activity";
import {
  fleetDiscoveryInput,
  fleetReconciliationPlanInput,
  fleetReconciliationReviewInput,
  fleetReconciliationApplyInput,
} from "./fleet-discovery";
import {
  projectOrganizationPlanInput,
  projectOrganizationReviewInput,
  projectOrganizationApplyInput,
} from "./project-organization";
import {
  expectationBulkPlanInput,
  expectationBulkReviewInput,
  expectationBulkApplyInput,
} from "./expectation-bulk";
import { attentionConnectionInput, workspaceAttentionInput } from "./attention";
import {
  providerCredentialApplyInput,
  providerCredentialPlanInput,
  providerCredentialReviewInput,
  providerCredentialVerifyInput,
  providerCredentialsListInput,
} from "./provider-credentials";
import {
  departedResourceInput,
  projectTransferApplyInput,
  projectTransferPlanInput,
  projectTransferPreviewInput,
  projectTransferReviewInput,
} from "./project-transfers";
import { workspaceViewInput, workspaceChangesInput } from "./workspace-sync";
import {
  projectResourcesInput,
  resourceProjectInput,
  resourceProjectSaveInput,
} from "./project-resources";
import {
  secretConnectionSaveInput,
  secretScopesInput,
  secretInventoryInput,
  secretDraftInput,
  secretReviewInput,
  secretHistoryInput,
  secretApplyInput,
  secretRunInput,
  secretStepInput,
  secretRecoveryPlanInput,
} from "./secrets";
import {
  secretCleanupInput,
  secretCleanupPlanInput,
  secretCleanupApplyInput,
  secretCleanupHistoryInput,
} from "./secret-cleanup";
import {
  managedConfigurationApplyInput,
  managedConfigurationHistoryInput,
  managedConfigurationInput,
  managedConfigurationListInput,
  managedConfigurationPlanInput,
  managedConfigurationReviewInput,
  managedConfigurationSaveInput,
  managedConfigurationStopInput,
} from "./managed-configurations";
import {
  repositoryResourcesInput,
  resourceLinksSaveInput,
  resourceReferenceInput,
} from "./resource-links";
import {
  monitorApplyInput,
  monitorConfigurationPlanInput,
  monitorConnectionInput,
  monitorConnectionSaveInput,
  monitorIncidentInput,
  monitorIncidentsInput,
  monitorReviewInput,
  monitorTargetInput,
  monitorTargetsInput,
  monitorTriagePlanInput,
} from "./monitoring";
import {
  addActivityInput,
  createProjectInput,
  getProjectInput,
  updateProjectInput,
  createRepositoryInput,
  getRepositoryInput,
  updateRepositoryInput,
  workspaceInput,
  syncGoalInput,
} from "./domain";
import {
  enrollSourceInput,
  updateSourceInput,
  sourceInput,
  issuePublisherCredentialInput,
  revokePublisherCredentialInput,
  publishObservationsInput,
} from "./sources";
import {
  githubEnrollInput,
  githubUpdateInput,
  githubCredentialListInput,
  githubRefreshInput,
  githubRefreshGetInput,
  githubRefreshListInput,
} from "./github";
import { githubCoverageInput } from "./github-coverage";
import { releaseInput } from "./releases";
import { workInput } from "./repository-work";
import {
  dependenciesListInput,
  dependencyInspectionInput,
} from "./dependencies";
import {
  dependencyChangePlanInput,
  dependencyChangeReviewInput,
  dependencyWriteAccessInput,
  dependencyChangeApplyInput,
} from "./dependency-changes";
import {
  dependencyOperationInput,
  dependencyOperationsInput,
} from "./dependency-operations";
import {
  identityInput,
  setupApplyInput,
  invitationCreateInput,
  invitationInput,
  invitationRevokeInput,
  memberRemoveInput,
  memberUpdateInput,
} from "./membership";
import {
  automationPlanInput,
  automationIssueInput,
  automationRevokeInput,
} from "./automation";
import { importPlanInput, importApplyInput } from "./import";
import { updatePreferencesInput } from "./preferences";
import {
  hookAssociationInput,
  hookAssociationGetInput,
  hookConnectionInput,
  hookConnectionSaveInput,
  hookDeliveriesInput,
  hookDeliveryInput,
  hookRetryApplyInput,
  hookRetryInput,
  hookRetryPlanInput,
  hookSubscriptionsInput,
  hookPolicyDetailInput,
  hookPolicyPageInput,
  hookPolicyPlanInput,
} from "./hooks";

import { repositoryCoverageInput } from "./repository-coverage";

export const commands = {
  dependency_change_apply: {
    schema: dependencyChangeApplyInput,
    method: "dependencyChangeApply",
    title: "Submit the exact reviewed dependency change as a new GitHub branch and pull request without merging or replaying uncertain writes",
    readOnly: false,
  },
  dependency_operation_get: {
    schema: dependencyOperationInput,
    method: "dependencyOperationGet",
    title: "Read a retained dependency operation receipt without provider calls",
    readOnly: true,
  },
  dependency_operation_reconcile: {
    schema: dependencyOperationInput,
    method: "dependencyOperationReconcile",
    title: "Reconcile the original dependency branch and pull request through bounded reads without repeating writes",
    readOnly: true,
  },
  dependency_operations_list: {
    schema: dependencyOperationsInput,
    method: "dependencyOperationsList",
    title: "List bounded repository dependency operation history within the workspace",
    readOnly: true,
  },
  dependency_write_access: {
    schema: dependencyWriteAccessInput,
    method: "dependencyWriteAccess",
    title: "List repository-scoped maintenance credentials without revealing tokens or granting access",
    readOnly: true,
  },
  dependency_change_plan: {
    schema: dependencyChangePlanInput,
    method: "dependencyChangePlan",
    title: "Prepare an actor-bound expiring override renewal or verified-unused cleanup review without provider writes",
    readOnly: false,
  },
  dependency_change_review: {
    schema: dependencyChangeReviewInput,
    method: "dependencyChangeReview",
    title: "Recover an exact dependency change review and inspect expiry or changed workspace/source authority",
    readOnly: true,
  },
  dependencies_list: {
    schema: dependenciesListInput,
    method: "dependenciesList",
    title: "List a bounded workspace or project dependency-maintenance page from retained evidence without provider calls",
    readOnly: true,
  },
  repository_dependencies: {
    schema: dependencyInspectionInput,
    method: "repositoryDependencies",
    title: "Read retained override lifecycle evidence, or explicitly inspect bounded committed npm policy and lockfiles without provider writes",
    readOnly: true,
  },
  repository_coverage_get: {
    schema: repositoryCoverageInput,
    method: "repositoryCoverageGet",
    title:
      "Read retained HQ coverage and check progress without provider calls or state changes",
    readOnly: true,
  },
  repository_coverage: {
    schema: repositoryCoverageInput,
    method: "repositoryCoverage",
    title:
      "Inspect and retain bounded linked operational evidence without triggering probes or provider writes",
    readOnly: true,
  },
  fleet_sources: {
    schema: workspaceInput,
    method: "fleetSources",
    title:
      "List bounded owner-only GitHub source choices without provider reads or credential values",
    readOnly: true,
  },
  fleet_discover: {
    schema: fleetDiscoveryInput,
    method: "fleetDiscover",
    title:
      "Read a bounded GitHub catalog or HQ inventory page through a selected source without enrolling repositories",
    readOnly: true,
  },
  fleet_reconciliation_plan: {
    schema: fleetReconciliationPlanInput,
    method: "fleetReconciliationPlan",
    title:
      "Verify selected GitHub identities and save an exact expiring HQ enrollment review",
    readOnly: false,
  },
  fleet_reconciliation_review: {
    schema: fleetReconciliationReviewInput,
    method: "fleetReconciliationReview",
    title:
      "Recover an actor-bound fleet enrollment review and its original committed receipt",
    readOnly: true,
  },
  fleet_reconciliation_apply: {
    schema: fleetReconciliationApplyInput,
    method: "fleetReconciliationApply",
    title:
      "Apply only reviewed HQ repository and collection-scope changes atomically without GitHub writes",
    readOnly: false,
  },
  provider_credential_verify: {
    schema: providerCredentialVerifyInput,
    method: "providerCredentialVerify",
    title:
      "Verify bounded secret metadata reads for one exact allowed resource without testing writes",
    readOnly: true,
  },
  provider_credentials_list: {
    schema: providerCredentialsListInput,
    method: "providerCredentialsList",
    title:
      "List a bounded owner-only page of provider credential metadata without private values",
    readOnly: true,
  },
  provider_credential_plan: {
    schema: providerCredentialPlanInput,
    method: "providerCredentialPlan",
    title:
      "Review exact provider credential scope, rotation or retirement without accepting private input",
    readOnly: false,
  },
  provider_credential_review: {
    schema: providerCredentialReviewInput,
    method: "providerCredentialReview",
    title:
      "Inspect an owner-only provider credential review and its dependency impact",
    readOnly: true,
  },
  provider_credential_apply: {
    schema: providerCredentialApplyInput,
    method: "providerCredentialApply",
    title:
      "Apply reviewed credential settings or local retirement without provider effects or private command arguments",
    readOnly: false,
  },
  project_transfer_destinations: {
    schema: workspaceInput,
    method: "projectTransferDestinations",
    title:
      "List eligible owner workspaces without widening a workspace credential",
    readOnly: true,
  },
  project_transfer_preview: {
    schema: projectTransferPreviewInput,
    method: "projectTransferPreview",
    title:
      "Preview project transfer access, source rebinding and unresolved dependencies without moving metadata",
    readOnly: true,
  },
  project_transfer_plan: {
    schema: projectTransferPlanInput,
    method: "projectTransferPlan",
    title: "Prepare an expiring exact project workspace transfer review",
    readOnly: false,
  },
  project_transfer_review: {
    schema: projectTransferReviewInput,
    method: "projectTransferReview",
    title:
      "Read an actor-bound transfer review and its original committed receipt",
    readOnly: true,
  },
  project_transfer_apply: {
    schema: projectTransferApplyInput,
    method: "projectTransferApply",
    title:
      "Apply the exact reviewed project transfer atomically without copying credentials or history",
    readOnly: false,
  },
  departed_resource_context: {
    schema: departedResourceInput,
    method: "departedResourceContext",
    title:
      "Read original-workspace historical context for a departed project or repository without destination data",
    readOnly: true,
  },
  secrets_cleanup_plan: {
    schema: secretCleanupPlanInput,
    method: "secretsCleanupPlan",
    title:
      "Review non-atomic source removal after accepted destination writes and fresh metadata checks",
    readOnly: false,
  },
  secrets_cleanup_review: {
    schema: secretCleanupInput,
    method: "secretsCleanupReview",
    title: "Read a source-removal review and its independent deletion receipt",
    readOnly: true,
  },
  secrets_cleanup_history: {
    schema: secretCleanupHistoryInput,
    method: "secretsCleanupHistory",
    title: "Read a bounded page of source-removal reviews for one distribution",
    readOnly: true,
  },
  secrets_cleanup_apply: {
    schema: secretCleanupApplyInput,
    method: "secretsCleanupApply",
    title:
      "Apply one exact reviewed source removal without retrying submitted deletion",
    readOnly: false,
  },
  secrets_cleanup_reconcile: {
    schema: secretCleanupInput,
    method: "secretsCleanupReconcile",
    title:
      "Observe source metadata without retrying deletion or inferring uncertain acceptance",
    readOnly: false,
  },
  secrets_configurations: {
    schema: managedConfigurationListInput,
    method: "secretsConfigurations",
    title:
      "List HQ-managed secret and variable definitions without reading provider state",
    readOnly: true,
  },
  secrets_configuration_save: {
    schema: managedConfigurationSaveInput,
    method: "secretsConfigurationSave",
    title:
      "Save revision-checked HQ management metadata and desired non-secret values without provider writes",
    readOnly: false,
  },
  secrets_configuration_stop: {
    schema: managedConfigurationStopInput,
    method: "secretsConfigurationStop",
    title:
      "Stop HQ management while leaving provider configuration unchanged",
    readOnly: false,
  },
  secrets_configuration_status: {
    schema: managedConfigurationInput,
    method: "secretsConfigurationStatus",
    title:
      "Compare one managed definition with exact live provider entries without changing them",
    readOnly: true,
  },
  secrets_configuration_plan: {
    schema: managedConfigurationPlanInput,
    method: "secretsConfigurationPlan",
    title:
      "Prepare an actor-bound expiring create, update, delete, or no-op review from exact live provider state",
    readOnly: false,
  },
  secrets_configuration_review: {
    schema: managedConfigurationReviewInput,
    method: "secretsConfigurationReview",
    title:
      "Read an exact managed configuration review and retained operation receipt",
    readOnly: true,
  },
  secrets_configuration_apply: {
    schema: managedConfigurationApplyInput,
    method: "secretsConfigurationApply",
    title:
      "Apply one exact reviewed non-secret provider change after durable operation intent",
    readOnly: false,
  },
  secrets_configuration_reconcile: {
    schema: managedConfigurationReviewInput,
    method: "secretsConfigurationReconcile",
    title:
      "Reconcile uncertain managed configuration outcomes through bounded reads without repeating writes",
    readOnly: false,
  },
  secrets_configuration_history: {
    schema: managedConfigurationHistoryInput,
    method: "secretsConfigurationHistory",
    title: "Read bounded managed configuration operation history",
    readOnly: true,
  },
  secrets_recovery_plan: {
    schema: secretRecoveryPlanInput,
    method: "secretsRecoveryPlan",
    title:
      "Review one retained-input recovery with explicit overwrite acknowledgement and no provider effects",
    readOnly: false,
  },
  secrets_apply: {
    schema: secretApplyInput,
    method: "secretsApply",
    title:
      "Accept exact reviewed secret distribution intent before provider effects",
    readOnly: false,
  },
  secrets_run: {
    schema: secretRunInput,
    method: "secretsRun",
    title:
      "Execute one exact pending secret destination without replaying submitted writes",
    readOnly: false,
  },
  secrets_reconcile: {
    schema: secretStepInput,
    method: "secretsReconcile",
    title:
      "Read fresh destination metadata without retrying or inferring stored value equality",
    readOnly: false,
  },
  secrets_draft: {
    schema: secretDraftInput,
    method: "secretsDraft",
    title:
      "Prepare exact secret destinations and private input requirements without provider effects",
    readOnly: false,
  },
  secrets_review: {
    schema: secretReviewInput,
    method: "secretsReview",
    title:
      "Read a secret review and public input requirements without private input material",
    readOnly: true,
  },
  secrets_history: {
    schema: secretHistoryInput,
    method: "secretsHistory",
    title:
      "Read a bounded page of workspace or repository-linked secret reviews",
    readOnly: true,
  },
  secrets_cancel: {
    schema: secretReviewInput,
    method: "secretsCancel",
    title:
      "Cancel an unaccepted secret review and discard staged input without provider effects",
    readOnly: false,
  },
  secrets_connections: {
    schema: workspaceInput,
    method: "secretsConnections",
    title: "List workspace Secrets connections and provider capabilities",
    readOnly: true,
  },
  secrets_providers: {
    schema: workspaceInput,
    method: "secretsProviders",
    title: "List owner-visible Secrets credential scopes without credentials",
    readOnly: true,
  },
  secrets_connection_save: {
    schema: secretConnectionSaveInput,
    method: "secretsConnectionSave",
    title:
      "Save revision-checked HQ Secrets enrollment without changing provider secrets",
    readOnly: false,
  },
  secrets_scopes: {
    schema: secretScopesInput,
    method: "secretsScopes",
    title:
      "Read bounded configuration scopes for an enrolled provider resource",
    readOnly: true,
  },
  secrets_inventory: {
    schema: secretInventoryInput,
    method: "secretsInventory",
    title:
      "Read a bounded provider secret-metadata or non-secret-variable page",
    readOnly: true,
  },
  monitoring_connections: {
    schema: workspaceInput,
    method: "monitoringConnections",
    title: "List workspace Endpoint Monitor connections",
    readOnly: true,
  },
  monitoring_providers: {
    schema: workspaceInput,
    method: "monitoringProviders",
    title: "List owner-visible monitoring references without credentials",
    readOnly: true,
  },
  monitoring_connection_save: {
    schema: monitorConnectionSaveInput,
    method: "monitoringConnectionSave",
    title:
      "Save revision-checked HQ connection metadata without changing probes",
    readOnly: false,
  },
  monitoring_snapshot: {
    schema: monitorConnectionInput,
    method: "monitoringSnapshot",
    title:
      "Read bounded operational counts and configuration-bound run evidence",
    readOnly: true,
  },
  monitoring_configuration: {
    schema: monitorConnectionInput,
    method: "monitoringConfiguration",
    title:
      "Read the bounded private executing monitoring configuration and revision",
    readOnly: true,
  },
  monitoring_targets: {
    schema: monitorTargetsInput,
    method: "monitoringTargets",
    title:
      "Read a bounded target page with check evidence and repository links",
    readOnly: true,
  },
  monitoring_target: {
    schema: monitorTargetInput,
    method: "monitoringTarget",
    title: "Read the exact selected monitor target and its evidence",
    readOnly: true,
  },
  monitoring_incidents: {
    schema: monitorIncidentsInput,
    method: "monitoringIncidents",
    title:
      "Read bounded incident pages with explicit target and status filters",
    readOnly: true,
  },
  monitoring_incident: {
    schema: monitorIncidentInput,
    method: "monitoringIncident",
    title: "Read the selected incident and a bounded triage-history page",
    readOnly: true,
  },
  monitoring_configuration_plan: {
    schema: monitorConfigurationPlanInput,
    method: "monitoringConfigurationPlan",
    title:
      "Review a single target change or structured defaults change at an exact configuration revision",
    readOnly: false,
  },
  monitoring_triage_plan: {
    schema: monitorTriagePlanInput,
    method: "monitoringTriagePlan",
    title:
      "Review acknowledgement, snooze, or operator dismissal at an exact incident revision",
    readOnly: false,
  },
  monitoring_apply: {
    schema: monitorApplyInput,
    method: "monitoringApply",
    title:
      "Confirm the exact monitoring review once with durable intent and actor authority",
    readOnly: false,
  },
  monitoring_review: {
    schema: monitorReviewInput,
    method: "monitoringReview",
    title: "Read an HQ monitoring review and its saved operation receipt",
    readOnly: true,
  },
  monitoring_reconcile: {
    schema: monitorReviewInput,
    method: "monitoringReconcile",
    title:
      "Recover an uncertain operation through its original provider receipt without resending",
    readOnly: false,
  },
  monitoring_history: {
    schema: workspaceInput,
    method: "monitoringHistory",
    title: "Read bounded workspace monitoring operation history",
    readOnly: true,
  },
  repository_resources: {
    schema: repositoryResourcesInput,
    method: "repositoryResources",
    title:
      "Read a bounded page of explicitly linked repository hooks and monitors",
    readOnly: true,
  },
  resource_repositories: {
    schema: resourceReferenceInput,
    method: "resourceRepositories",
    title: "Read the saved repository links for a shared hook or monitor",
    readOnly: true,
  },
  resource_repositories_save: {
    schema: resourceLinksSaveInput,
    method: "resourceRepositoriesSave",
    title:
      "Save revision-checked repository links without changing provider configuration",
    readOnly: false,
  },
  hooks_connections: {
    schema: workspaceInput,
    method: "hooksConnections",
    title: "List workspace Hookrelay connections",
    readOnly: true,
  },
  hooks_providers: {
    schema: workspaceInput,
    method: "hooksProviders",
    title:
      "List owner-visible Hookrelay provider references without credentials",
    readOnly: true,
  },
  hooks_connection_save: {
    schema: hookConnectionSaveInput,
    method: "hooksConnectionSave",
    title:
      "Save reviewed HQ connection metadata without changing Hookrelay configuration",
    readOnly: false,
  },
  hooks_snapshot: {
    schema: hookConnectionInput,
    method: "hooksSnapshot",
    title: "Read bounded Hookrelay health with explicit sample coverage",
    readOnly: true,
  },
  hooks_subscriptions: {
    schema: hookSubscriptionsInput,
    method: "hooksSubscriptions",
    title: "Read a bounded page of redacted hook subscriptions",
    readOnly: true,
  },
  hooks_deliveries: {
    schema: hookDeliveriesInput,
    method: "hooksDeliveries",
    title: "Read a bounded live page of hook delivery metadata",
    readOnly: true,
  },
  hooks_delivery: {
    schema: hookDeliveryInput,
    method: "hooksDelivery",
    title: "Read the exact selected hook delivery state",
    readOnly: true,
  },
  hooks_association_get: {
    schema: hookAssociationGetInput,
    method: "hooksAssociationGet",
    title: "Read the saved project association for one hook subscription",
    readOnly: true,
  },
  hooks_association_save: {
    schema: hookAssociationInput,
    method: "hooksAssociationSave",
    title:
      "Associate a hook subscription with an HQ project without changing the provider",
    readOnly: false,
  },
  hooks_retry_plan: {
    schema: hookRetryPlanInput,
    method: "hooksRetryPlan",
    title:
      "Review a single exhausted delivery with exact provider and actor authority",
    readOnly: false,
  },
  hooks_retry_apply: {
    schema: hookRetryApplyInput,
    method: "hooksRetryApply",
    title:
      "Confirm the exact reviewed hook retry once with durable operation intent",
    readOnly: false,
  },
  hooks_retry_get: {
    schema: hookRetryInput,
    method: "hooksRetryGet",
    title: "Read a saved Hooks review and local operation receipt",
    readOnly: true,
  },
  hooks_retry_reconcile: {
    schema: hookRetryInput,
    method: "hooksRetryReconcile",
    title:
      "Reconcile an uncertain Hooks operation from its original provider receipt without resending",
    readOnly: false,
  },
  hooks_history: {
    schema: workspaceInput,
    method: "hooksHistory",
    title: "Read bounded workspace Hooks operation history",
    readOnly: true,
  },
  hooks_setup_configuration: {
    schema: hookSetupConnectionInput,
    method: "hooksSetupConfiguration",
    title: "Read online hook setup availability and missing grants",
    readOnly: true,
  },
  hooks_setup_status: {
    schema: hookSetupStatusInput,
    method: "hooksSetupStatus",
    title:
      "Check routing, GitHub installation and observed delivery separately",
    readOnly: true,
  },
  hooks_setup_plan: {
    schema: hookSetupPlanInput,
    method: "hooksSetupPlan",
    title: "Review repository hook creation or installation with exact scope",
    readOnly: false,
  },
  hooks_setup_get: {
    schema: hookRetryInput,
    method: "hooksSetupGet",
    title: "Read a saved hook setup review and operation",
    readOnly: true,
  },
  hooks_setup_apply: {
    schema: hookRetryApplyInput,
    method: "hooksSetupApply",
    title: "Apply reviewed hook setup with durable intent",
    readOnly: false,
  },
  hooks_setup_reconcile: {
    schema: hookRetryInput,
    method: "hooksSetupReconcile",
    title: "Reconcile hook setup without repeating an uncertain installation",
    readOnly: false,
  },
  hooks_configuration: {
    schema: hookConnectionInput,
    method: "hooksConfiguration",
    title: "Read online routing availability without changing provider grants",
    readOnly: true,
  },
  hooks_policy_subscriptions: {
    schema: hookPolicyPageInput,
    method: "hooksPolicySubscriptions",
    title:
      "Read a revision-bound page of stable subscription identities and routing policies",
    readOnly: true,
  },
  hooks_policy_destinations: {
    schema: hookPolicyPageInput,
    method: "hooksPolicyDestinations",
    title:
      "Read bounded destination metadata without credentials or private routes",
    readOnly: true,
  },
  hooks_policy_subscription: {
    schema: hookPolicyDetailInput,
    method: "hooksPolicySubscription",
    title: "Read the exact stable subscription policy before editing",
    readOnly: true,
  },
  hooks_policy_plan: {
    schema: hookPolicyPlanInput,
    method: "hooksPolicyPlan",
    title:
      "Review exact future-ingress policy changes with actor and provider revisions",
    readOnly: false,
  },
  hooks_policy_apply: {
    schema: hookRetryApplyInput,
    method: "hooksPolicyApply",
    title: "Apply a reviewed routing policy once with durable operation intent",
    readOnly: false,
  },
  hooks_policy_get: {
    schema: hookRetryInput,
    method: "hooksPolicyGet",
    title: "Read a saved routing review and local operation receipt",
    readOnly: true,
  },
  hooks_policy_reconcile: {
    schema: hookRetryInput,
    method: "hooksPolicyReconcile",
    title:
      "Reconcile uncertain routing acceptance without resubmitting the change",
    readOnly: false,
  },
  preferences_get: {
    schema: workspaceInput,
    method: "preferencesGet",
    title: "Read the signed-in user's date, clock, and time-zone preferences",
    readOnly: true,
  },
  preferences_update: {
    schema: updatePreferencesInput,
    method: "preferencesUpdate",
    title:
      "Save the signed-in user's reviewed display preferences with revision protection",
    readOnly: false,
  },
  metadata_import_status: {
    schema: workspaceInput,
    method: "metadataImportStatus",
    title: "Read one-time metadata import eligibility and receipt",
    readOnly: true,
  },
  metadata_import_plan: {
    schema: importPlanInput,
    method: "metadataImportPlan",
    title: "Review bounded project metadata for an empty workspace",
    readOnly: false,
  },
  metadata_import_apply: {
    schema: importApplyInput,
    method: "metadataImportApply",
    title:
      "Apply the exact reviewed metadata import once with a stable receipt",
    readOnly: false,
  },
  automation_credentials_list: {
    schema: workspaceInput,
    method: "automationCredentials",
    title: "List owner-managed automation credentials without values",
    readOnly: true,
  },
  automation_credential_plan: {
    schema: automationPlanInput,
    method: "automationCredentialPlan",
    title: "Prepare an expiring review of exact automation permissions",
    readOnly: false,
  },
  automation_credential_issue: {
    schema: automationIssueInput,
    method: "automationCredentialIssue",
    title: "Issue the exact reviewed automation credential value once",
    readOnly: false,
  },
  automation_credential_revoke: {
    schema: automationRevokeInput,
    method: "automationCredentialRevoke",
    title: "Revoke a workspace automation credential immediately",
    readOnly: false,
  },
  setup_status: {
    schema: identityInput,
    method: "setupStatus",
    title: "Review deployment-approved first-owner setup",
    readOnly: true,
  },
  setup_apply: {
    schema: setupApplyInput,
    method: "setupApply",
    title: "Accept the exact reviewed first-owner setup",
    readOnly: false,
  },
  members_list: {
    schema: workspaceInput,
    method: "membersList",
    title: "List workspace members for access review",
    readOnly: true,
  },
  member_update: {
    schema: memberUpdateInput,
    method: "memberUpdate",
    title: "Change a reviewed member role while retaining an owner",
    readOnly: false,
  },
  member_remove: {
    schema: memberRemoveInput,
    method: "memberRemove",
    title: "Remove reviewed membership and revoke its credentials",
    readOnly: false,
  },
  invitations_list: {
    schema: workspaceInput,
    method: "invitationsList",
    title: "List restricted workspace invitation metadata",
    readOnly: true,
  },
  invitation_create: {
    schema: invitationCreateInput,
    method: "invitationCreate",
    title: "Invite a verified email to an explicit workspace role",
    readOnly: false,
  },
  invitation_revoke: {
    schema: invitationRevokeInput,
    method: "invitationRevoke",
    title: "Revoke a reviewed pending invitation",
    readOnly: false,
  },
  invitations_mine: {
    schema: identityInput,
    method: "ownInvitations",
    title: "List invitations for the verified signed-in account",
    readOnly: true,
  },
  invitation_accept: {
    schema: invitationInput,
    method: "invitationAccept",
    title: "Accept a reviewed invitation with the verified signed-in account",
    readOnly: false,
  },
  github_credentials_list: {
    schema: githubCredentialListInput,
    method: "githubCredentials",
    title: "List workspace-bound GitHub credential references without values",
    readOnly: true,
  },
  github_source_get: {
    schema: sourceInput,
    method: "githubSourceGet",
    title: "Read GitHub source settings and freshness",
    readOnly: true,
  },
  github_coverage: {
    schema: githubCoverageInput,
    method: "githubCoverage",
    title:
      "Read selected repositories' GitHub coverage and latest refresh attempts",
    readOnly: true,
  },
  repository_work: {
    schema: workInput,
    method: "repositoryWork",
    title:
      "Read bounded open pull-request and issue context, review and head-check evidence for an enrolled repository",
    readOnly: true,
  },
  repository_releases: {
    schema: releaseInput,
    method: "repositoryReleases",
    title:
      "Read bounded cached releases, deployment records and immutable commit comparison for an enrolled repository",
    readOnly: true,
  },
  github_source_enroll: {
    schema: githubEnrollInput,
    method: "githubSourceEnroll",
    title: "Enroll a repository-scoped read-only GitHub source",
    readOnly: false,
  },
  github_source_update: {
    schema: githubUpdateInput,
    method: "githubSourceUpdate",
    title: "Save GitHub scope, credential reference, and refresh settings",
    readOnly: false,
  },
  github_refresh: {
    schema: githubRefreshInput,
    method: "githubRefresh",
    title: "Queue a bounded read-only GitHub refresh",
    readOnly: false,
  },
  github_refresh_get: {
    schema: githubRefreshGetInput,
    method: "githubRefreshGet",
    title: "Read GitHub refresh progress and minimized evidence",
    readOnly: true,
  },
  github_refreshes_list: {
    schema: githubRefreshListInput,
    method: "githubRefreshes",
    title: "List bounded GitHub refresh history",
    readOnly: true,
  },
  github_refresh_cancel: {
    schema: githubRefreshGetInput,
    method: "githubRefreshCancel",
    title: "Cancel queued and in-flight GitHub refresh work",
    readOnly: false,
  },
  workspace_snapshot: {
    schema: workspaceInput,
    method: "snapshot",
    title: "Read workspace",
    readOnly: true,
  },
  workspace_view: {
    schema: workspaceViewInput,
    method: "workspaceView",
    title: "Load only the metadata required by an app view",
    readOnly: true,
  },
  workspace_changes: {
    schema: workspaceChangesInput,
    method: "workspaceChanges",
    title: "Read bounded changed records for an app view since its cursor",
    readOnly: true,
  },
  activity_list: {
    schema: workspaceInput,
    method: "activity",
    title: "Read activity",
    readOnly: true,
  },
  activity_add: {
    schema: addActivityInput,
    method: "addActivity",
    title: "Post a reported update",
    readOnly: false,
  },
  activity_feed: {
    schema: activityFeedInput,
    method: "activityFeed",
    title: "Page activity grouped by goal with workspace-wide filters",
    readOnly: true,
  },
  goal_activity: {
    schema: goalActivityInput,
    method: "goalActivity",
    title:
      "Page one goal's activity using the same filters and snapshot cursor",
    readOnly: true,
  },
  goals_list: {
    schema: workspaceInput,
    method: "goals",
    title: "Read goals with verbatim objectives",
    readOnly: true,
  },
  goal_sync: {
    schema: syncGoalInput,
    method: "syncGoal",
    title: "Sync a goal objective and status from its source",
    readOnly: false,
  },
  repositories_list: {
    schema: workspaceInput,
    method: "repositories",
    title: "List repositories",
    readOnly: true,
  },
  expectations_plan: {
    schema: expectationBulkPlanInput,
    method: "expectationBulkPlan",
    title:
      "Review exact bounded repository expectation patches without applying them",
    readOnly: false,
  },
  projects_organize_plan: {
    schema: projectOrganizationPlanInput,
    method: "projectOrganizationPlan",
    title:
      "Review bounded project creation, priorities and exact repository assignments",
    readOnly: false,
  },
  projects_organize_review: {
    schema: projectOrganizationReviewInput,
    method: "projectOrganizationReview",
    title: "Read the actor-bound organization review and original receipt",
    readOnly: true,
  },
  projects_organize_apply: {
    schema: projectOrganizationApplyInput,
    method: "projectOrganizationApply",
    title:
      "Apply only the exact reviewed project organization atomically and once",
    readOnly: false,
  },
  expectations_review: {
    schema: expectationBulkReviewInput,
    method: "expectationBulkReview",
    title:
      "Read an actor-bound expectation review and recover its saved receipt",
    readOnly: true,
  },
  expectations_apply: {
    schema: expectationBulkApplyInput,
    method: "expectationBulkApply",
    title:
      "Apply only the exact reviewed expectation changes atomically and once",
    readOnly: false,
  },
  repository_get: {
    schema: getRepositoryInput,
    method: "repository",
    title: "Read repository",
    readOnly: true,
  },
  repository_context: {
    schema: getRepositoryInput,
    method: "repositoryContext",
    title:
      "Preview a repository's linked resource metadata without provider requests",
    readOnly: true,
  },
  repository_access: {
    schema: getRepositoryInput,
    method: "repositoryAccess",
    title:
      "Explain live HQ operation gates and enrolled GitHub access without provider requests",
    readOnly: true,
  },
  workspace_attention: {
    schema: workspaceAttentionInput,
    method: "workspaceAttention",
    title:
      "Read paginated repository evidence and review attention without provider requests",
    readOnly: true,
  },
  attention_connection: {
    schema: attentionConnectionInput,
    method: "attentionConnection",
    title:
      "Read a bounded operational attention preview for one exact connection",
    readOnly: true,
  },
  repository_create: {
    schema: createRepositoryInput,
    method: "createRepository",
    title: "Enroll repository",
    readOnly: false,
  },
  repository_update: {
    schema: updateRepositoryInput,
    method: "updateRepository",
    title: "Save repository expectations",
    readOnly: false,
  },
  project_create: {
    schema: createProjectInput,
    method: "createProject",
    title:
      "Create a project and optionally enroll its first repository atomically",
    readOnly: false,
  },
  projects_list: {
    schema: workspaceInput,
    method: "projects",
    title:
      "List bounded project metadata without provider configuration or values",
    readOnly: true,
  },
  project_get: {
    schema: getProjectInput,
    method: "project",
    title: "Read one workspace project and its metadata revision",
    readOnly: true,
  },
  project_update: {
    schema: updateProjectInput,
    method: "updateProject",
    title:
      "Save project metadata without changing provider state or permissions",
    readOnly: false,
  },
  project_resources: {
    schema: projectResourcesInput,
    method: "projectResources",
    title:
      "Page direct project resource associations and repository-derived context without provider fan-out",
    readOnly: true,
  },
  resource_project: {
    schema: resourceProjectInput,
    method: "resourceProject",
    title: "Read the explicit project association for one provider resource",
    readOnly: true,
  },
  resource_project_save: {
    schema: resourceProjectSaveInput,
    method: "resourceProjectSave",
    title:
      "Save one project association without changing provider configuration or grants",
    readOnly: false,
  },
  sources_list: {
    schema: workspaceInput,
    method: "connections",
    title: "List source connection status",
    readOnly: true,
  },
  source_get: {
    schema: sourceInput,
    method: "sourceGet",
    title: "Read publisher source settings",
    readOnly: true,
  },
  source_enroll: {
    schema: enrollSourceInput,
    method: "sourceEnroll",
    title: "Enroll a repository-scoped local publisher",
    readOnly: false,
  },
  source_update: {
    schema: updateSourceInput,
    method: "sourceUpdate",
    title: "Save publisher scope and freshness settings",
    readOnly: false,
  },
  publisher_credentials_list: {
    schema: sourceInput,
    method: "publisherCredentials",
    title: "List publisher credential metadata without values",
    readOnly: true,
  },
  publisher_credential_issue: {
    schema: issuePublisherCredentialInput,
    method: "publisherCredentialIssue",
    title:
      "Create a source-scoped credential and reveal its sensitive value once",
    readOnly: false,
  },
  publisher_credential_revoke: {
    schema: revokePublisherCredentialInput,
    method: "publisherCredentialRevoke",
    title: "Revoke a publisher credential",
    readOnly: false,
  },
  observations_publish: {
    schema: publishObservationsInput,
    method: "observationsPublish",
    title:
      "Publish local checkout observations within the credential source scope",
    readOnly: false,
  },
} as const;
export type CommandName = keyof typeof commands;

export function commandAnnotations(name: string, readOnly: boolean) {
  return {
    readOnlyHint: readOnly,
    destructiveHint: [
      "fleet_reconciliation_apply",
      "projects_organize_apply",
      "expectations_apply",
      "provider_credential_apply",
      "project_transfer_apply",
      "member_update",
      "member_remove",
      "invitation_revoke",
      "automation_credential_revoke",
      "source_update",
      "publisher_credential_revoke",
      "github_source_update",
      "github_refresh_cancel",
      "hooks_connection_save",
      "hooks_policy_apply",
      "hooks_setup_apply",
      "monitoring_connection_save",
      "secrets_connection_save",
      "secrets_cancel",
      "secrets_apply",
      "secrets_run",
      "secrets_cleanup_apply",
      "secrets_configuration_save",
      "secrets_configuration_stop",
      "secrets_configuration_apply",
      "monitoring_apply",
    ].includes(name),
    openWorldHint:
      name === "github_refresh" ||
      [
        "fleet_discover",
        "fleet_reconciliation_plan",
        "attention_connection",
        "repository_releases",
        "repository_work",
        "repository_dependencies",
        "dependency_operation_reconcile",
        "provider_credential_verify",
        "hooks_snapshot",
        "hooks_configuration",
        "hooks_setup_configuration",
        "hooks_setup_status",
        "hooks_policy_subscriptions",
        "hooks_policy_destinations",
        "hooks_policy_subscription",
        "hooks_policy_plan",
        "hooks_setup_plan",
        "hooks_setup_reconcile",
        "hooks_policy_apply",
        "hooks_setup_apply",
        "hooks_policy_reconcile",
        "hooks_subscriptions",
        "hooks_deliveries",
        "hooks_delivery",
        "hooks_retry_plan",
        "hooks_retry_apply",
        "hooks_retry_reconcile",
        "monitoring_snapshot",
        "monitoring_configuration",
        "monitoring_targets",
        "monitoring_target",
        "monitoring_incidents",
        "monitoring_incident",
        "monitoring_configuration_plan",
        "monitoring_triage_plan",
        "monitoring_apply",
        "monitoring_reconcile",
        "secrets_inventory",
        "secrets_scopes",
        "secrets_draft",
        "secrets_run",
        "secrets_reconcile",
        "secrets_recovery_plan",
        "secrets_cleanup_plan",
        "secrets_cleanup_apply",
        "secrets_cleanup_reconcile",
        "secrets_configuration_status",
        "secrets_configuration_plan",
        "secrets_configuration_apply",
        "secrets_configuration_reconcile",
      ].includes(name),
    idempotentHint:
      readOnly ||
      [
        "fleet_reconciliation_plan",
        "fleet_reconciliation_apply",
        "projects_organize_apply",
        "expectations_apply",
        "provider_credential_apply",
        "project_transfer_plan",
        "project_transfer_apply",
        "metadata_import_apply",
        "setup_apply",
        "invitation_create",
        "invitation_accept",
        "automation_credential_revoke",
        "activity_add",
        "goal_sync",
        "source_enroll",
        "observations_publish",
        "publisher_credential_revoke",
        "github_source_enroll",
        "github_refresh",
        "github_refresh_cancel",
        "hooks_retry_plan",
        "hooks_retry_apply",
        "hooks_retry_reconcile",
        "monitoring_apply",
        "hooks_policy_plan",
        "hooks_setup_plan",
        "hooks_setup_reconcile",
        "hooks_policy_apply",
        "hooks_setup_apply",
        "hooks_policy_reconcile",
        "monitoring_reconcile",
        "secrets_draft",
        "secrets_cancel",
        "secrets_apply",
        "secrets_run",
        "secrets_reconcile",
        "secrets_recovery_plan",
        "secrets_cleanup_plan",
        "secrets_cleanup_apply",
        "secrets_cleanup_reconcile",
        "secrets_configuration_save",
        "secrets_configuration_stop",
        "secrets_configuration_plan",
        "secrets_configuration_apply",
        "secrets_configuration_reconcile",
      ].includes(name),
  };
}
