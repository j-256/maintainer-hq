---
title: Dependency maintenance
description: Enforce temporary npm overrides, track upstream fixes, and verify cleanup.
---

# Dependency maintenance

Temporary dependency overrides need a reason, an accountable maintainer, a review deadline, and an explicit removal condition. Repository files own those decisions. The lifecycle checker verifies their effect against the lockfile; it never edits files, installs dependencies, runs repository scripts, opens pull requests, or changes provider configuration.

## Use the dashboard

Open **Dependencies** for a paginated workspace inventory, or the **Dependencies** section of a project or repository. Fleet and project lists read retained summaries only. Opening or refreshing the list does not call GitHub or npm. Repositories without an enrolled GitHub source, an accepted inspection, or a committed policy have distinct states; none establishes that their dependencies are safe.

In a repository, choose **Inspect repository** to read its default branch, an immutable Git tree, and the exact policy, manifest, and lockfile blobs in that tree. Blob digests, regular-file modes, identity, sizes, and complete tree coverage are verified before a report is accepted. The credential needs repository Contents read access. GitHub access and a repository's administrative role are separate; a watchlist repository can be inspected without webhook-management permission.

**Include upstream releases from public npm** explicitly permits looking up a bounded selection of parent package names on the public registry, without credentials. A released fix does not prove that the repository adopted it. Parents beyond the hosted selection limit remain visibly not checked; use the repository CLI for a complete bounded policy-level upstream check. Unsupported or failed registry responses never imply that cleanup is safe.

Accepted results keep their inspection time and commit. Source changes, credential rotation, workspace access changes, or repository revision changes invalidate the relevant authority. A local display clock updates expiry and stale labels without polling. Only mounted dependency queries respond to relevant workspace/source notifications; Activity and other tab data are not requested for this view.

Operators can prepare an exact renewal or unused-override cleanup review from a fresh complete inspection. Renewal requires a reason, an accountable maintainer, and a review window no longer than thirty days. Cleanup requires evidence that the override no longer applies and the policy has no unresolved lockfile or vulnerability problems. Its lifecycle record remains as an advisory regression guard. Reviews bind the original actor, workspace, source/repository revisions, credential identity, commit, and input digests and expire after five minutes. The saved review URL recovers the same before/after metadata. Preparing a review is not a provider write, package update, passing CI result, or applied cleanup.

Browser, CLI, and MCP share `dependencies_list`, `repository_dependencies`, `dependency_change_plan`, and `dependency_change_review`. Inputs accept enrolled identities and structured changes, not raw provider paths, scripts, credentials, or arbitrary document edits. Publishers and Activity reporters have no inspection or change-preparation authority.

### Inspect an upstream-update PR

If an update makes an override unused, the lifecycle check can fail before that update is merged. Enter its PR number under **Inspection target**, choose **Select target**, then **Inspect repository**. HQ accepts only an open PR whose head and base repositories match the enrolled repository. Its head branch and immutable commit must agree. Fork PRs are unsupported, and private PR inspection also requires Pull requests read permission on the read-only source credential.

PR evidence has a separate, bounded cache and does not replace the default-branch summary used by the fleet. One candidate is retained per source/repository enrollment, subject to the same read cooldown and shared credential budget. Changing the selected PR may require waiting for that cooldown. Reviews keep the PR number and target branch. A cleanup PR targets the upstream-update PR's head branch, so it proposes only the cleanup into that update; it does not independently propose the entire upstream update to the default branch.

### Configure repository write access

A workspace owner opens **Dependencies > Manage write access > Add provider access**. Choose a name, exact repository allowlist, an HQ cutoff no later than the token's expiry, and whether reviewed writes are allowed. Use a dedicated fine-grained GitHub credential with Contents and Pull requests write permissions for those repositories. Review the scope before entering the token through the separate private-input form. HQ's allowlist and cutoff restrict its use; they do not grant GitHub permissions, extend token lifetime, or revoke the upstream token.

This purpose is separate from read-only collection and GitHub Actions Secrets. Neither credential is automatically promoted into repository write authority, and repository-maintenance credentials cannot be enrolled in Secrets. HQ encrypts managed credentials with its independent provider-credential keyring. **Verify read access** proves only that repository metadata was readable, not that a write will succeed. Rotation and retirement show affected pending reviews and unsettled operations; reconcile them first when possible. Never enroll a broad machine-wide administrative token merely to avoid setup.

### Submit and recover a change

Select eligible **Repository write access** when preparing a change, inspect the before/after review, then choose **Create pull request**. **Prepare review only** remains available and explicitly has no provider effect. Confirmation rechecks the original actor, workspace membership, source, repository, credential identity, immutable commit and exact file digests. HQ journals acceptance before external effects, creates only the reviewed policy edit and, for cleanup, removes the exact unused manifest selector. Unrelated fields and file modes remain unchanged; lockfile bytes are not edited. The advisory guard remains, and the pure lifecycle checks must pass again on the proposed files.

HQ creates a Git tree, a commit, a new `hq/dependencies/<review-id>` branch, then a PR. It never overwrites an existing branch, merges, enables auto-merge, installs packages, executes repository scripts, or deploys. The base head is rechecked before branch publication and PR creation, but GitHub cannot freeze that base while a PR is created. Review the resulting diff and CI on GitHub before merging. Existing GitHub workflows may run in response to the branch or PR under their own configuration and authority.

**Reload saved outcome** reads the journal without provider calls. **Check GitHub outcome** performs bounded reads against the original branch, commit, repository, and PR marker; it never retries a write. Duplicate confirmation of the same review returns the same operation. Operation history is paginated and available to workspace operators; only the original submitting identity with unchanged captured authority can request provider reconciliation. A rotated credential is not silently substituted for recovery.

Treat **Outcome uncertain** and **Partially completed** literally. A lost response may leave a Git object, branch, or PR even when no final receipt exists. Inspect the recorded commit/branch or reconcile the original operation before preparing a new review. A branch-only attempt requires deliberate recovery on GitHub; HQ does not automatically create another PR or delete the branch. A verified PR can later be shown as created, closed, or merged; none proves passing CI or deployment. Merge cleanup into its reviewed destination, then inspect that destination again to establish adoption.

Browser, CLI, and MCP also share `dependency_write_access`, `dependency_change_apply`, `dependency_operation_get`, `dependency_operation_reconcile`, and `dependency_operations_list`. Credential setup uses the existing `provider_credential_*` reviews/private-input contract, with `provider_credentials_list` purpose `repositories` and provider kind `github-repositories`. Use [command schema discovery](commands.md#discover-exact-inputs) for exact bounds; tokens never belong in ordinary command inputs.

## Run the checks

After installing the locked dependencies with `npm ci`, run:

```bash
npm run check:dependencies
npm run --silent dependencies:report -- --upstream
```

The first command runs without network access and is included in `npm run check`. The second prints bounded JSON evidence and queries the public npm registry for the parent packages named in the policy. Do not use `--upstream` when those package names must not be disclosed to that registry. Neither command sends credentials or accepts registry URLs. Public registry failures remain unavailable, not proof that no fix exists.

Use `npm run check:dependencies -- --root /path/to/repository` to inspect another checkout containing a policy and adjacent lockfiles. `--policy` selects a relative policy path within that root. Help is available through either `-h` or `--help`. Results go to stdout and diagnostics go to stderr; `--json` puts the complete bounded report on stdout. Exit statuses are `0` for passing checks, `1` for runtime or requested upstream-read failures, `2` for invalid inputs, and `4` for lifecycle violations.

## Repository-owned policy

`.maintainer-hq/dependencies.json` contains `schemaVersion: 1` and a `manifests` array. Each manifest entry names its relative `package.json` path and an `overrides` array. Each override records:

- `id`: a stable, repository-wide lifecycle identity
- `lifecycle`: `active` while the override is required, or `removed` to verify cleanup and detect regressions
- `parent`, `package`, `requested`, and `replacement`: the exact supported override selector and replacement version
- `advisory` and `vulnerable`: the GitHub advisory identity and its affected semantic-version range
- `reason` and `owner`: why the exception exists and who reviews it
- `reviewedAt` and `reviewBy`: UTC timestamps, with a review window no longer than thirty days
- `removeWhen`: a specific, human-readable cleanup condition

The supported npm form is a package parent containing an exact dependency-version selector. For HQ's mitigation, that is `miniflare` containing `sharp@0.35.2` with replacement `0.35.4`. This selector does not keep overriding a future parent request for `sharp@0.35.4`. See [npm's version-scoped override contract](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides).

The checker requires a matching lifecycle record for every override in each declared manifest. Missing records, changed replacements, stale manifest/lockfile declarations, unsupported override forms, and missing or invalid resolutions fail the check. It inspects both hoisted and nested parent dependencies and all locked copies of the affected package within that manifest's lockfile. Development and runtime parent use are distinguished; development scope does not excuse an affected version.

## Interpret the result

| State | Meaning | Next step |
| --- | --- | --- |
| Mitigated | The override matches installed parent declarations and the inspected lockfile resolves unaffected versions | Keep watching upstream and review by the deadline |
| Vulnerable | At least one locked copy still satisfies the recorded affected range | Repair the dependency tree and rerun verification |
| Review due | The active override's deadline has passed | Review the evidence and deliberately renew or remove the override |
| Unused | No installed parent still requests the overridden version | Remove the override and verify the resulting lockfile |
| Invalid | The available inputs cannot establish the claimed mitigation | Repair the reported input or coverage problem |
| Resolved | The override is absent and the retained lifecycle check verifies unaffected lockfile resolutions | Keep the record to catch a dependency regression |

An upstream fix and repository adoption are separate evidence. The public registry can report that a newer Miniflare requests patched Sharp while an installed test adapter still pins an older Miniflare. That does not make HQ's override removable. An unavailable, missing, aliased, or unsupported upstream declaration is not a confirmed fix.

Review expiry fails checks; it never removes the mitigation automatically. To renew, record a deliberate review, its reason, and a deadline within the allowed window. To remove, update every affected toolchain, remove the exact npm override, change the lifecycle record to `removed`, regenerate the lockfile, and run the full checks. A `removed` record does not keep an npm override active. It checks for regressions and does not impose an active-override review deadline.

## Automation

The repository's Dependabot configuration requests weekly dependency updates and groups the Cloudflare tooling family. The dependency-maintenance workflow checks pull requests, main-branch updates, a daily schedule, and manual runs. It executes without provider-write permissions or deployment credentials, checks lifecycle behavior and upstream metadata, audits all dependency scopes, and retains only the bounded report for a short period. It does not merge dependency changes automatically.

Workflow files and Dependabot configuration must be published to the repository before hosted automation can run. A failing workflow is not a merge restriction unless the repository's rules require that check. Configure required checks deliberately; do not treat a checked-in workflow as proof of enforcement on GitHub. A successful audit does not establish that every vulnerability is known or detected.

## Scope and evidence limits

The first checker supports npm lockfile version 3 and separate manifest/lockfile pairs. Workspace-linked lockfiles, package aliases, arbitrary override nesting, non-semver parent requests, other package managers, and custom registries need separate support. They must not be labeled safe by this checker. Only declared manifests are in scope; a passing root check says nothing about an undeclared package elsewhere in the repository.

Named limits bound manifest and override counts, package inspection, file sizes, parent evidence, response sizes, upstream concurrency, and review windows. Symlinked inputs and relative paths escaping the selected root are rejected. Stop concurrent input writers when producing a report; the filesystem reader does not provide an atomic snapshot of multiple files. Reports retain input digests and allowlisted lifecycle metadata, not raw manifests, lockfiles, local absolute paths, package scripts, registry responses, or credentials.

Lockfile verification is not installed-binary attestation, proof that CI ran, branch-protection verification, or proof that a change was deployed. Preserve those distinctions when publishing reports or reviewing a cleanup. The CLI runs in the repository/CI process and adds no Worker invocation. Hosted inspection runs the same pure policy analyzer in HQ, without executing repository code.

Hosted inspection additionally limits each file to 1 MiB, aggregate decoded files to 4 MiB, the complete tree to 12,000 entries, GitHub calls to twenty, and optional public npm reads to four parent packages. Provider payloads retain the shared bounded stream/deadline guard. The repository/source cache and shared contextual-read budget prevent repeated uncached work within five minutes and limit contextual collections per credential. Large or unsupported repositories return incomplete evidence instead of weakening checks. The CLI's larger local file allowance is an alternative for those repositories, not a claim that its output has been ingested by HQ.

The **Inspection details** disclosure provides a reference, provider-request counts, and elapsed time including network waits. Accepted uncached inspections emit one allowlisted `hq.dependencies.inspected` diagnostic with the same reference, outcome, stop reason, and timing. Failures, policy violations, and incomplete requested upstream checks produce warning diagnostics. Cache hits do not repeat the log. Raw files, reasons, provider payloads, credentials, and credential hashes are excluded from these logs. Authentication or cache-acceptance failures use the ordinary command support reference. See [Free-plan compatibility](diagnostics.md#cloudflare-free-plan-compatibility) for independent platform limits.

Submission admits at most ten new operations per workspace in five minutes and retains at most one thousand dependency operations; reaching history capacity stops new submissions for deliberate operator handling rather than silently deleting receipts. Each attempt has a one-minute execution lease, up to twenty immutable-evidence reads and six bounded GitHub operation requests, with six-second individual operation deadlines. Each reviewed edit touches at most the policy and one manifest. Reconciliation is limited to one provider check per operation per minute. Terminal submission and reconciliation diagnostics use `hq.dependencies.operation`, the operation reference, action, phase, outcome, request count, and elapsed time; raw file content, tokens, provider bodies, and review reasons are excluded. These application bounds are not a global spending ceiling.

## Hosted recovery

Apply `0033_dependencies.sql` through the ordered migration workflow after a private export and isolated restore test. It adds only derived per-enrollment dependency evidence and source-topic notifications; enrollment removal cascades its cache. Preserve authority, original inspection timestamps, pending reviews, and the operation journal during recovery. A restored cache is historical evidence until inspected again. Do not restore an older whole database to undo a UI change or reinterpret a prepared review as an applied repository change.

Repository writes require `0034_repository_credentials.sql`, which widens the credential-purpose constraint while preserving existing ciphertext, identities, revisions, indexes, and notification triggers. PR-head inspection requires `0035_dependency_candidates.sql`, an additive cache with enrollment-cascade cleanup and source notifications. Restore the independent encryption keyring alongside a private database export; D1 alone cannot recover usable credentials. Keep purpose-aware credential readers and dependency-operation reconciliation in rollback builds after these records exist. Never replay accepted intent because a response or worker was lost, restore older ciphertext to revive retired access, or treat `action_plans.applied_at` as proof of a GitHub merge.

## HQ's Sharp mitigation

HQ's development and test Miniflare dependencies request Sharp `0.35.2`. The lifecycle policy replaces that request with `0.35.4` for [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). The reviewed advisory identifies the fixed Sharp release and its libheif update; the native runtime probe on 2026-09-09 reported Sharp `0.35.4` and libheif `1.23.2`. HQ does not invoke the affected local image-transformation paths, and the native tooling is absent from its deployed Worker bundle. This reduces production exposure but does not justify leaving the development toolchain vulnerable.

Do not use a forceful audit fix that downgrades the Cloudflare toolchain. The policy and matching native lock packages must change together. Regenerate and verify the lockfile through npm, then exercise the complete application checks before integrating a toolchain update.
