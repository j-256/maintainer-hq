---
title: Project workspace transfers
description: Review access and dependencies before moving a project between workspaces.
---

# Project workspace transfers

A transfer changes which HQ workspace owns a project and its explicitly grouped repositories. It preserves their IDs, expectations, lifecycle, Importance, and Portfolio decisions. It does not transfer a GitHub repository, migrate a provider resource, copy credentials, distribute secrets, or publish old history.

## Review and authority

Both workspaces must already exist, and the same person must have live Owner membership in both. Workspace-scoped credentials cannot cross this boundary, even when their owner belongs to both workspaces. Browser owner sessions, CLI `HQ_ACCESS_TOKEN` owner authentication, and owner-authenticated MCP use the same service contract. No command mints a broader credential or changes membership.

### In the dashboard

Open a project and choose **Move to workspace**. Select a destination, then **Inspect destination** to see the exact repositories, membership changes, source enrollment, and unresolved dependencies. If a source needs a destination, prepare one in that workspace's Settings, return to the transfer, choose the matching source, and **Refresh preview**. Both local and GitHub sources can be saved disabled with no repositories; the transfer does not grant credentials or enable collection.

**Review transfer** becomes available only when the inspected choices are ready. Read what moves, who gains or loses access, and what stays behind. Acknowledge the history and credential boundary, then **Confirm move**. A stale or expired review requires returning to the preserved choices and refreshing the preview. Cancel protects unsaved choices and restores keyboard focus to the move button.

The final review has a URL containing its review reference. Reloading that URL inspects the same plan or original receipt; it does not create another move. If confirmation is interrupted, use **Inspect saved result** before trying a new transfer. The success receipt links to the project in the destination. Old project and repository URLs open read-only retained context in their original workspace, with an explicit **View retained Activity** link. These historical pages offer no new-note action and do not disclose destination details.

### Automation contract

The command sequence is:

1. `project_transfer_destinations` lists eligible destination workspaces after source authorization
2. `project_transfer_preview` reads bounded access and dependency information for the exact project, expected project revision, destination, and explicit source mappings
3. `project_transfer_plan` captures a ready preview using a caller-generated UUID `reviewId`; retrying the exact request returns that review
4. `project_transfer_review` reads the actor-bound review, expiry, validity, and original receipt
5. `project_transfer_apply` accepts only the source workspace, review ID, and exact fingerprint, and commits the reviewed metadata transaction once

The preview distinguishes members who gain access, lose access, retain access, or change roles. It includes pending invitations and active credential names, scopes, and expiry, never tokens or hashes. Destination credentials retain their existing authority and may consequently cover newly enrolled metadata. Source credentials do not travel. Invitations grant nothing until accepted under their ordinary rules.

Reviews bind the actor and credential, exact inputs, both workspace structural revisions, the captured preview, and expiry. Membership, invitations, credentials, resource associations, source enrollment, project/repository metadata, and relevant operation-state changes invalidate an outstanding review. Routine Activity, goal updates, observations, and source telemetry do not. Confirmation rechecks authority and these revisions inside the committing batch. A conflict requires a new review rather than overwriting changes. Expired reviews cannot be confirmed.

## What moves and what stays

The supported transfer moves project and repository metadata and explicitly rebinds existing local/GitHub observation-source enrollment to selected same-provider destination sources. Each source needs a destination mapping. An empty destination source can be prepared in a disabled state. Enabling any source still requires repository enrollment. The transfer never automatically enables the destination source or changes its schedule or provider grants.

Connections, credentials, old observations, publisher receipts, and GitHub refresh history remain in their original workspace. A source emptied by the move is disabled; a source retaining other repositories keeps its enabled state. Descriptive connection-level project context is cleared as a disclosed effect, not moved as provider ownership. Destination evidence starts unverified and must be collected under the destination's own authority.

Direct and repository-derived Hookrelay, Monitoring, and Secrets resources appear as explicit blockers. Shared resources are identified, never duplicated or silently detached. Matching connection labels or provider names are not proof that another workspace can address the same provider resource. Resolve the associations deliberately through their own management surfaces, or wait for provider-aware transfer support. A metadata transfer must not be used to bypass pending provider work or secret custody.

Open Hookrelay, Monitoring, or managed-configuration reviews and pending, running, partial, or indeterminate operations in either workspace block transfer. So do retained private Secret inputs, live supplied-value reviews, unresolved Secret receipts or cleanup, and active GitHub refreshes for affected sources/repositories. An active managed definition targeting a repository in the project must be stopped first; its provider entry remains unchanged and can be adopted again in the destination workspace. The transfer does not cancel or reconcile external work. Conflicting project names, duplicate repository enrollments, destination capacity, unsupported sources, and oversized dependency graphs block before any move.

## History, receipts and live updates

Existing Activity and its project/repository attribution stay in the workspace where they were recorded. Source-only members can read that workspace's retained historical context but not the destination's name, members, current project metadata, or provider state. Destination-only members gain current metadata and the incoming transfer event, not the source's old Activity. Each side receives an audit record in the same transaction as the move. New source reports cannot attribute fresh work to an unenrolled moved resource.

`departed_resource_context` reads one exact moved project or repository descriptor under source read authority. It returns the historical name, stable IDs, and move time without destination details. Project-filtered Activity remains available for retained historical context. Current resource reads remain workspace-scoped; history does not grant access to the new location.

Source-side changed-record removals and destination-side additions use the existing bounded push protocol. Both workspaces are notified after a committed receipt, without sending a whole-workspace snapshot. Existing attribution and observations are not copied as push payloads.

If a confirmation response is lost, inspect `project_transfer_review` or retry the exact apply request. The committed receipt is returned without repeating the move. It records the original outcome even if the project has since moved again. A later failed statement rolls back metadata, source enrollment, history context, both audit records, and the receipt together.

## Storage, bounds and recovery

`0024_project_transfers.sql` adds globally unique repository identity, retains historical repository references independently of current workspace location, and creates actor-bound reviews, departed-resource context, and structural revision clocks. A duplicate repository ID across workspaces fails migration rather than inventing identities. Historical foreign keys remain enforced; current attribution and refresh enrollment have separate workspace guards.

Take a private database export, restore it in isolation, apply the migration to populated history, and verify foreign keys and retained records before deployment. The apply transaction uses D1 foreign-key deferral only for the mutually dependent project/repository workspace changes. Tests exercise the actual local D1 binding, including a failing final constraint and a subsequent clean transaction. Do not disable foreign-key enforcement or remove history to make a move pass.

An export that places required unique indexes after row inserts cannot be replayed in that order with foreign-key enforcement. In an isolated, empty restore database, create the exported tables and indexes first, load the exact data inside a foreign-key-deferred transaction, then install the exported history and notification triggers. This avoids recomputing derived journal rows during import. Parse SQL statements with a quote- and trigger-aware parser, never by splitting on semicolons. Require a clean foreign-key check, an integrity check, and matching pre/post record digests before trusting the restored copy. This restore ordering is not permission to remove live indexes, disable foreign keys, or suspend live history capture.

Use compatible writers during recovery. Older writers that assume a repository's history must share its current workspace cannot safely operate after a transfer. Code rollback is not database rollback. Prefer a corrective forward deployment; restoring pre-transfer data requires quiescing writers, accounting for all intervening operations, and an explicit recovery decision. Preserve exports privately and never commit provider payloads or database exports.

`TRANSFER_LIMITS` owns graph, response-byte, expiry, and review-storage limits. Inventory reads reject overflow instead of silently truncating a move. Plans have bounded pending and retained capacity; committed receipts are retained for retry and audit rather than silently evicted. A capacity failure requires deliberate maintenance, not deleting receipts behind an active caller. Preview and apply add no provider subrequests. Structural clocks and historical/push triggers add D1 writes, and reviews store a bounded metadata snapshot. Those costs still matter on Paid. Keep deployed CPU/subrequest ceilings explicit and document measured Free-plan exceedances under the deployment's execution policy; bounded batches alone are not evidence of Free-plan compatibility.
