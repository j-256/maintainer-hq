---
title: Offline release artifacts
description: Build a reviewed production artifact and preserve compatible recovery.
---

# Offline release artifacts

`npm run release --` inspects an explicit deployment profile, builds a portable artifact, or verifies that artifact. It has no deploy command. The default `npm run build` is a development verification build with a placeholder database, not a deployment candidate. Do not deploy its generated configuration.

## Profile and review

Start from `fixtures/release-profile.json` outside the checkout. That file contains synthetic identifiers for isolated tests, not resources to deploy. Replace every identity with a reviewed candidate account, Worker, database, intended hostname, Access issuer, and application audience. Identify the retained Worker and database too: candidate and retained identities must differ. `scheduledCollection` is an explicit boolean; enabled collection uses the fixed application schedule. Prefer disabled collection while verifying a candidate.

The strict profile accepts no secret values, arbitrary bindings, routes, named environments, or preview ingress. Its optional `hookrelayBindings` array declares reviewed private service bindings as `{ "binding": "HOOKRELAY_PRIMARY", "service": "<provider-worker>" }`. Names must use the `HOOKRELAY_` prefix, targets cannot be HQ or its retained predecessor, and named environments or arbitrary entrypoints are rejected. Generated bindings must exactly match the reviewed list. This grants network reachability, not management authority: the independently provisioned `HOOKRELAY_CREDENTIALS` secret selects a workspace-scoped bearer credential for each provider reference. See [Hooks](hooks.md) for enrollment and recovery.

The optional `monitoringBindings` array declares Endpoint Monitor services as `{ "binding": "MONITORING_PRIMARY", "service": "<provider-worker>" }`. It has the same exact-target and no-entrypoint constraints, requires the `MONITORING_` prefix, and reserves `MONITORING_CREDENTIALS` for the separate credential catalog. The generated service list must match both reviewed arrays exactly, with unique binding names. Omitting this optional field preserves existing profile fingerprints. See [Monitoring](monitoring.md) for provider migration order, scope, and recovery; a service binding alone does not authorize any probe or triage change.

The profile records hostname intent but never attaches that hostname. An Access issuer/audience configures application verification; it does not create an Access policy or protect static assets at the edge. Verify the separate Access application and its coverage before exposing the candidate.

The optional `workspacePush` boolean enables exactly the `WORKSPACE_EVENTS` binding and SQLite-backed `WorkspaceEvents` class migration. Omitting it does not inherit the development binding; the browser uses fallback refresh. Generated class names, bindings, and migrations must exactly match the reviewed profile. Enable it for the live dashboard after installing compatible write-count checks and the notification migration. See [push deployment and recovery](push.md) for mandatory ordering and rollback constraints.

```sh
npm ci
npm run check
npm run release -- inspect --profile <profile.json>
npm run release -- build --profile <profile.json> --review <profile-fingerprint> --output <new-artifact-directory>
npm run release -- verify --artifact <artifact-directory> --review <profile-fingerprint> --digest <artifact-fingerprint>
```

The output directory must not exist, and its parent must exist. Keep profiles and artifacts outside tracked source. Save the profile fingerprint and the build's artifact fingerprint separately from the artifact. `inspect` validates shape and review binding, not the existence or ownership of Cloudflare resources. Neither fingerprint grants deployment permission.

The build typechecks source, disables remote development bindings, omits inherited environment selection and the shell API token from its build subprocess, and requires unchanged source throughout compilation. The Vite configuration customizer replaces reviewed fields in place: object-form overrides merge arrays and can retain a placeholder database or unwanted schedule. A second check validates the actual generated database, schedule, identity variables, API routing, and binding contract before packaging. Unrecognized generated configuration fails closed and requires review when tooling changes.

The package contains the Worker, assets, migrations, projected portable Wrangler configuration, and a checksum manifest. Build-machine configuration paths and Vite internals are not copied into the package. Verification rejects changed contents, additional files, symlinks, private paths, recognized credential material, development identity code, and mismatched browser headers. The separately retained artifact digest also binds manifest changes. These checks establish integrity against that saved digest; they are not a signature, proof of a trustworthy build machine, or a complete secret scanner.

The portable configuration includes the reviewed execution ceiling of 2,000 ms CPU and 1,000 total subrequests per invocation. The generated-config verifier rejects omitted or changed ceilings. These settings require the Workers Standard usage model and are part of the artifact's fail-closed deployment contract, not a hostname or provider mutation.

CLI results go to stdout and diagnostics go to stderr. Exit statuses are `0` for success/help, `1` for runtime or artifact failure, `2` for usage/profile/review errors, and `3` for missing build dependencies. A failed build can leave an incomplete output directory for inspection; choose a new destination when retrying. Do not deploy concurrently with a build or edit its source while it runs.

## Goal lifecycle recovery

Goal lifecycle releases require `0021_goal_lifecycle.sql` before deploying code that reports `paused` or `cleared`. Export the database privately and restore-test the migration first. It widens the goal status constraint while retaining original goal identities, journal entries, ordering, and push cursors, and recreates the goal-owned triggers. Once the new statuses have been reported, preserve a compatible reader and writer in code rollback builds; do not map them to active, blocked, or complete or restore an old database to undo a UI change. Reload open clients after this schema capability upgrade so their validation and presentation recognize the new states.

## Project recovery

Project-aware releases require `0022_projects.sql` and `0023_project_resources.sql` after a private export and isolated restore test. Retain stable project IDs, explicit resource associations, immutable Activity attribution, monotonic change cursors, and compatible readers and writers during rollback. Reload clients after the record projection upgrade. Follow [project recovery](projects.md#recovery) for duplicate-identity handling and legacy metadata initialization; these migrations do not activate or move provider resources.

Workspace transfers additionally require `0024_project_transfers.sql`. Restore-test it against populated project and repository history before deployment, including globally unique repository identity, structural revision clocks, transfer receipts, and source-workspace historical context. Old writers that require historical records and their repository to share a workspace are incompatible after a move. Preserve the transfer-aware schema and writer during code rollback; prefer a corrective forward deployment over restoring pre-transfer data. See [transfer recovery](project-transfers.md#storage-bounds-and-recovery). Apply packaged migrations through the ordered migration command, not by concatenating the entire schema into one SQL request.

## Provider credentials and Secrets recovery

UI-managed provider access requires `0025_provider_credentials.sql` after a private export and isolated restore test. Install the independently backed-up `PROVIDER_CREDENTIAL_KEYS` keyring through a private deployment-secret workflow before enabling setup. Preserve existing secret bindings and deployed variables during upload; use Wrangler's `--keep-vars` with the verified portable artifact. The release profile deliberately contains no credential or key value. Follow the [credential custody and key-rotation contract](secrets.md#encrypted-provider-credential-custody) rather than putting a key in generated configuration.

Retain the credential table, review receipts, revisions, dependent connection invalidation, notification triggers and all keys required by intended recovery exports. Restoring a database may revive a retired credential or earlier authorization; reconcile upstream revocations before reopening writes. A lost key cannot be reconstructed from the database. Deleting ciphertext or rolling back code does not revoke a provider token.

Cloudflare-aware recovery builds must preserve private transient input, whole-Worker deployment evidence, indexed submission markers, and indeterminate outcomes. Do not reinterpret a Cloudflare review as a GitHub-sealed operation or manufacture retained input. Database or Worker-code rollback cannot undo a provider deployment or restore a deleted supplied value; reconcile each captured receipt separately.

## GitHub Activity recovery

Source-attributed GitHub Activity requires `0026_github_activity.sql` after a private export and isolated restore test. It adds nullable journal references and bounded per-repository change comparisons without rewriting older events or assigning guessed provenance. Preserve the journal, refresh records, insertion ordering and push cursors as one recovery unit. Receipt retention may remove a linked refresh while the Activity reference remains; do not delete the journal entry or substitute another run. Code rollback must retain compatible readers for the added fields, and must not restore an old database merely to undo a presentation change.

## Repository overview recovery

Apply `0027_repository_context.sql` after a private export and populated isolated restore test. It replaces only the Secrets connection notification triggers to include the existing association topic; it does not rewrite stored resources, journals, or change cursors. Preserve those triggers and immutable GitHub repository attribution in recovery builds. Receipt expiry does not authorize removing historical repository links, and source edits must not reassign earlier events. This release needs no new provider binding, credential, hostname, or schema backfill. An older compatible UI can run against the retained additive metadata; do not restore an older whole database to undo the overview.

## Release evidence recovery

Apply `0028_release_evidence.sql` after a private export and populated isolated restore test. It adds derived per-enrollment GitHub release caches and shared credential-hash read budgets, with source-topic notifications for newly accepted evidence. Source enrollment deletion cascades its cache; no provider configuration, operation receipt or historical journal is rewritten. Preserve the source notification trigger and read-budget state during recovery. Older compatible code can ignore these additive tables; do not restore the whole database to undo a release-view change. The existing read credential remains independently recoverable through its protected custody workflow.

## Pull-request and issue context

Apply `0029_repository_work.sql` after a private export and populated isolated restore test. It adds a derived per-enrollment work cache with source-topic notifications, reusing the shared credential read budget and cooldowns. No provider configuration, credential grant, enrollment, journal or operation receipt is rewritten. Preserve the additive table, trigger and budget state for compatible rollback; an older reader can ignore the work cache. Restore independently held read credentials through the existing custody workflow. Do not restore an older whole database to undo this view.

## Fleet discovery recovery

Apply `0030_fleet_discovery.sql` after a private export and populated isolated restore test. It adds derived GitHub identity bindings and one bounded latest discovery cache per source. Identity bindings cover metadata-only repositories outside scheduled collection. A before-workspace-move trigger removes the old workspace's credential-backed identity before the repository moves; it must survive recovery to avoid leaking authority or blocking transfers through foreign keys. Connection or repository removal also cascades its derived identities. The migration does not rewrite expectations, projects, source scope, associations, observations, credentials or history.

Preserve applied `fleet.reconcile` plans and operation receipts alongside accepted metadata and source revisions. Code rollback must not reinterpret a successful receipt, replay an uncertain action with a new ID, or restore an older whole database to undo enrollment. Compatible older code can ignore the additive tables, but keep the move-cleanup trigger and collect new evidence before relying on restored caches. Existing GitHub credentials retain their independent protected recovery path. Follow [fleet enrollment](fleet-enrollment.md) for exact-ID readback and retry.

## Operational coverage recovery

Apply `0031_operational_coverage.sql` after a private export and populated isolated restore test. It adds derived repository read leases, shared workspace budgets and connection operation epochs. Its triggers invalidate minimized coverage when saved links, connection authority or monitoring operations change; a before-workspace-move trigger removes old coverage leases so they cannot carry authority across workspaces or block a transfer. No provider resource, expectation, credential or historical receipt is rewritten by the migration.

Preserve these invalidation and move-cleanup triggers in compatible recovery builds. Restored coverage is only historical evidence until checked again and must keep its original expiry; do not re-date an old passing result. Reload open clients after the observation schema upgrade. Older code must not parse away coverage details and then treat the remaining health label as current proof; prefer a compatible forward repair. A database restore does not reverse provider changes, and an older whole database must not be restored merely to undo this presentation.

## Hook routing recovery

Apply `0032_hook_policy_coverage.sql` after a private export and populated isolated restore test. It adds connection-epoch and retained-coverage invalidation when a routing operation starts or changes status. It does not activate Hookrelay configuration, widen a credential, or alter a provider route. Retain routing action plans, secret-free provider reviews, operation intent, immutable Activity context, and the invalidation triggers during code rollback. Recovery code must distinguish routing receipts from delivery retries and preserve unresolved acceptance for reconciliation against the original provider identity. Do not restore an old whole database or resubmit an uncertain operation to undo a UI deployment. The independent provider activation and authority recovery sequence is documented in [Hooks](hooks.md#provider-deployment-boundary).

## Dependency maintenance recovery

Dependency maintenance requires `0033_dependencies.sql` after a private export and isolated restore test. The per-enrollment cache is derived metadata; preserve its source notification trigger and the shared contextual-read budget while retaining reviews and operation history. Existing code can ignore the additive cache, but must not reinterpret prepared dependency reviews as provider effects. [Dependency recovery](dependencies.md#hosted-recovery) describes the evidence and authority boundaries.

Apply `0034_repository_credentials.sql` and `0035_dependency_candidates.sql` before repository-write and PR-head inspection features. The credential-table rebuild preserves encrypted values, exact settings, identities, revisions and push triggers; restore-test existing ciphertext with the independent keyring. Keep purpose-aware readers after repository-maintenance credentials exist, alongside recorded operation phases, immutable reviews and bounded read-only reconciliation. The candidate cache is separate from fleet/default-branch evidence and must retain its enrollment cascade and source notification trigger. These migrations grant no provider permission. Configure a dedicated token through the UI only after separate approval; do not widen the read-only collector or Secrets grants.

## Project containment recovery

Apply `0036_project_containment.sql` after a private export and populated isolated restore test. The migration fails atomically if any repository or saved Hookrelay, Monitoring, or Secrets resource association has a null project. Inventory and assign those records to valid projects in their existing workspace before retrying the ordered migration; it does not guess ownership from names, connections, or repository links. A failed attempt adds neither the import receipt column nor the enforcement triggers.

After application, new and updated repositories and saved operational-resource associations cannot be projectless. Metadata import uses format version 2 and creates declared projects and their repositories in one reviewed transaction; version 1 projectless manifests are incompatible. Preserve the enforcement triggers, import project counts, and compatible writers during rollback. An older writer that submits null ownership must remain offline; prefer a compatible forward repair over weakening the schema or restoring a whole database.

## Browser policy

Static assets and Worker responses share a restrictive Content Security Policy, no framing, no referrers, MIME sniffing protection, restricted browser permissions, and HTTPS transport policy. Scripts load only from the application's origin with no inline-script or eval exemption. Styles permit inline declarations for the component library. Fonts are bundled locally. API responses use `no-store`; static assets require private revalidation. The policy is defined in `shared/security.ts`, with a parity-tested `public/_headers` for assets served before the Worker.

The Cloudflare asset router applies `_headers` to static responses, not responses generated by the Worker. Both paths must be tested on the built package. See [Cloudflare's asset header rules](https://developers.cloudflare.com/workers/static-assets/headers/) and [Vite static asset handling](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/).

## Approval boundary

The portable config deliberately has no routes, `workers_dev: false`, and `preview_urls: false`. Direct deployment, D1 creation or remote migrations, credential grants, Access policy changes, and hostname handoff still require explicit approval under the [hosting gates](hosting.md). Use the artifact's config from its own directory if deployment is approved; never assume a Wrangler flag changes an already-built Vite target. Reverify the separately recorded digest immediately before an approved deployment and inspect the target account, Worker, D1, Access coverage, and retained rollback target again.
