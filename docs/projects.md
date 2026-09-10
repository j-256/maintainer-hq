---
title: Projects
description: Organize repositories and operational resources with Portfolio and Importance.
---

# Projects

A workspace is the shared membership and integration boundary around its projects. A project is the durable container for a product, service, tool, or other maintained effort. It can have no repository, one repository, or several, but every repository belongs to exactly one project. A repository has its own identity, expectations, provider scope, and revision. Project ownership does not create provider resources, broaden credentials, or establish health.

## Organize an effort

Open **Projects** and choose **Create project**. Record the name and description, then choose Importance and a Portfolio inclusion decision. Importance helps you prioritize; Portfolio records a visibility commitment. Neither changes observed health. If you exclude a project from your portfolio, record why.

Select **Enroll a repository with this project** when you want to add its first repository at the same time. Leave it unchecked for a repository-free project. Creation succeeds for the complete selection or leaves neither new record behind.

Open a project to switch between its Overview, Repositories, Releases, Hooks, Monitoring, Secrets, and Activity. [Releases](releases.md) reads one explicitly linked repository at a time, retaining that repository's source and provider evidence. These sections gather relevant resources without duplicating their provider configuration. Resources shared with other projects or repositories retain that wider scope when you open their controls.

Use the project editor to update metadata with Save/Cancel. To regroup an existing repository, use the linking control in the project's repository section and review its assignment in the repository editor. Moving the whole project to a different membership boundary requires [Move to workspace](project-transfers.md), with a separate exact review.

## Organize repositories together

Choose **Organize repositories** from **Projects** to work through a bounded selection of existing assignments. The list starts with all active repositories. Use search and **Include archived repositories** to change the candidates. Nothing is selected automatically. **Select this page** affects only its visible rows; **Select all matches** is offered only when the complete filtered set fits the selection limit. Selection persists across pages and filters.

The organizer preserves each saved assignment and never infers a relationship from names. **Choose projects** opens editable assignments: retain the current project, choose another target per repository, create a project, or use **Group all into one project** for a shared effort. You can exclude individual repositories before review. Every selected repository must retain or receive one target project, and a project can still have several repositories or none.

Each target has one **Project priorities** section. New projects start with Standard importance and an Undecided Portfolio, with no copied repository description or expectations. Name the project and expand **Edit priorities** when needed. Existing project decisions stay intact unless you edit them. Importance notes, Portfolio reasons, listing URLs and review dates belong to the project, not copies on each repository. An excluded Portfolio decision requires a reason. Importance is priority, not health; Listed does not publish a page. Use the ordinary project editor for other metadata such as descriptions and lifecycle.

**Review organization** shows the exact old and new repository assignments, projects to create, and project-level before/after decisions. Assignments and project decisions have separate pages in both choices and review; Apply always includes the complete explicitly selected set. Project priority changes also affect repositories linked outside the selection; the displayed linked count describes the review, not a guarantee that no later association can change. Repository expectations, descriptions, provider settings, grants and direct resource associations are not modified. Repository-derived project context follows the new assignment. Prior Activity retains its original context, and reassignment records both the previous and new project.

**Apply organization** saves the complete reviewed selection atomically. No-op assignments or project decisions do not increment revisions or emit change events. The review is bound to your workspace, identity and credential, selected repository revisions, affected existing project revisions, exact new project names and a shared expiry. Stale revisions, changed access, unavailable names or capacity reject the whole batch. Your draft stays intact. Go **Back to choices**, choose **Use latest repository and project versions** when offered, and inspect a fresh review. This refresh preserves selected priority changes while adopting updated values for fields you did not change.

If Apply is interrupted, use **Check saved receipt** or **Retry same review**. Do not start another batch until the original outcome is known. A missing receipt can mean an earlier request has not finished yet. The close warning offers the original review URL and does not claim to cancel Apply. The `organizationReview` URL parameter reopens the saved review and receipt for the same identity; an unresolved attempt in the same tab retains its recovery state across reload. Applied reviews and receipts are retained for idempotent recovery, including after expiry. Expired unapplied reviews can be cleaned up when another review is prepared. Review references do not grant access, and a receipt records a committed change rather than asserting that no later edits occurred.

The shared commands are `projects_organize_plan`, `projects_organize_review` and `projects_organize_apply`. Their [CLI and MCP schemas](commands.md) accept unique selected repository IDs and revisions plus used new or existing project targets. Existing-project patches accept only Importance, its explanatory note and the complete Portfolio decision; unrelated metadata cannot be replaced through this contract. New-project inputs name only the new identity and its presentation decisions. Owners and operators need live metadata-edit authority; reporter and source credentials cannot organize projects.

## Metadata commands

Browser, CLI, and MCP use the shared workspace command contract:

- `projects_list` reads the bounded workspace project inventory
- `project_get` reads one exact project and its metadata revision
- `project_create` creates a project, optionally with `firstRepository` for atomic enrollment of its first repository
- `project_update` saves ordinary metadata against an expected revision

Reads require live workspace membership and read authority. Writes additionally require metadata-edit authority. The write transaction checks membership revision and credential scope again, and records an actor-attributed journal event only for an applied write. Duplicate names, capacity limits, concurrent edits, and changed access are not silently overwritten. A combined creation creates neither record if the repository cannot be enrolled. Provider enrollment is separate: creating repository metadata does not activate a source or grant access to GitHub.

Project IDs are globally unique and do not encode workspace location. Names are unique within the workspace. Metadata contains the project name, description, active/archived lifecycle, Importance and explanatory note, Portfolio inclusion, revision, and update timestamp. Renaming or archiving a project does not rename, archive, stop, or delete any repository, hook, monitoring target, or secret.

Importance values are `standard`, `high`, and `critical`. They express maintainer prioritization, not incident severity or observed health. Portfolio states are `undecided`, `planned`, `listed`, and `excluded`, with a reason, optional HTTPS listing URL, and optional review date. Exclusion requires a reason. Saving `listed` does not publish or verify a portfolio page. HQ does not fetch a supplied listing URL.

## Operator workspace

The Projects inventory has search, lifecycle and Portfolio filters, Importance ordering, and bounded pagination. Project details bring together repositories, hooks, monitoring, Secrets resources, and project Activity. The create form can enroll a first repository atomically; repository-free projects are equally valid. Link an existing repository by selecting it and reviewing its assignment in the ordinary repository editor. Regrouping is explicit and never inferred from repository names.

Project metadata forms retain their drafts during pushed updates and failed saves. A changed revision requires deliberate recovery before another save. Project-list filters remain separate from embedded repository controls, so opening a repository and returning does not replace the project search. Read-only roles can inspect metadata but cannot save it.

Project sections subscribe only to their relevant app-view topics and record collections. The project inventory and repository section do not request Activity. Resource sections page through stored associations without provider fan-out; their links open the exact connection and target in the provider workspace. Project descriptors and repository grouping remain workspace-scoped so regrouping can remove an item from the previous project without relying on inferred tombstones. Provider controls disclose project context and can still affect resources shared outside that project.

Importance orders the Overview attention list and is available as a repository inventory sort. Repository health continues to use evidence and expectations only. Portfolio review dates become overdue after the selected UTC calendar date; a due review adds an attention item, not a failed provider check.

## Association boundaries

Repository `projectId` is a required workspace-local association. Creation and updates reject a missing or foreign project, and organization can only move a repository from one project to another. Hookrelay subscriptions, Monitoring targets, and Secrets resources require an explicit primary project when their association is saved. A connection's optional project context does not assign every provider target to that project. Provider credentials belong to workspace connections, and shared resources retain one provider configuration and operation history.

`resource_project` reads one resource association and `resource_project_save` writes its required primary project using the saved association, connection, and selected project revisions. A discovered provider resource can return no association before enrollment, but a save cannot create or retain a projectless association. Resource kinds are `hook`, `monitor`, and `secret`. Hooks use the existing Hookrelay subscription association as their single canonical authority; the legacy hook-specific command delegates to the shared association service. Monitoring uses an exact target identity. Secrets uses an enrolled resource identity, never a secret value or provider credential. Disabled connections remain visible as disabled. A stored hook or monitoring reference is HQ context, not proof that the provider target exists or is healthy.

`project_resources` reads one project with an optional resource-kind filter and typed pagination cursor. Each result distinguishes direct project association from repository-derived relevance and reports repository counts within and outside the project. Shared resources appear once per page, without copying provider configuration or history. Reads stay in workspace metadata and do not fan out to providers. Secrets resources removed from enrollment are not returned as available resources. Association commands do not change connection enrollment or grant provider operations.

`activity_feed` and `goal_activity` accept a project filter bound into the pagination cursor. Attribution is recorded when an event is written, using direct resource associations and relevant repositories at that time. Repository regrouping and resource reassociation record both affected projects; existing events retain their original attribution. Hook and monitoring operation outcomes copy the original intent's project and repository context. Secrets events capture the review's exact source and destinations plus its captured repository context. A reported `activity_add` update may identify either a workspace repository or a project in `resourceId`, so repository-free projects can have their own notes. General goal updates appear only where that goal has relevant attributed activity within the page watermark.

Moving a project between workspaces is a separate [reviewed transfer](project-transfers.md), not a side effect of regrouping. It requires Owner authority in both workspaces and preserves stable identities and source-only history. Unsupported provider dependencies block before any partial move.

## Recovery

Apply `0022_projects.sql` after a private export and isolated restore test. The migration preserves existing project IDs, repository and hook relationships, and Activity. Legacy metadata uses its recorded creation time, or workspace creation time when no project event exists, for the initial revision timestamp. Initializing that timestamp emits project-record updates through the existing change and push triggers: cursors advance monotonically, and bounded change retention continues normally. A duplicate project ID across workspaces fails the migration for deliberate recovery rather than silently inventing an identity.

`0023_project_resources.sql` adds per-resource Monitoring and Secrets associations, an update timestamp on existing Hookrelay associations, and immutable project Activity attribution. Existing hook associations are preserved, with an unknown timestamp until their next save. Earlier Activity is not backfilled from present-day repository grouping. Foreign keys and workspace checks prevent cross-workspace attribution. Keep attribution-capable writers during recovery: reverting to an older writer can leave new operation history without project context even if the added tables remain readable.

Apply `0036_project_containment.sql` only after a private export and isolated restore test. It deliberately fails before making schema changes if any repository or saved Hookrelay, Monitoring, or Secrets association has no project. Assign each orphan to a valid project in the same workspace, then rerun the ordered migration. The migration adds database enforcement for subsequent inserts and updates and adds project counts to import receipts. Writers that can submit a null repository or resource project are incompatible after this migration; use a compatible forward deployment rather than weakening the invariant during recovery.

Project resource pages and association counts are bounded by the shared contract. Repository context is materialized once per resource-list query and counts are calculated for the selected page. Activity attribution and push triggers add database writes; they are not free merely because they execute within an existing batch. These metadata operations add no provider subrequests. Document measured Free-plan overages separately under the deployment's execution and cost policy rather than claiming that pagination alone proves Free-plan compatibility.

Organization uses the existing action-plan and operation tables, with no provider effects or additional migration. `PROJECT_ORGANIZATION_LIMITS` bounds selections, target definitions, input/review bytes, open reviews per actor and expired-plan cleanup. Fixed-size JSON-backed SQL statements keep bound-parameter use independent of selection size, but affected rows, Activity links, structural clocks and push triggers still consume database work. Preserve the original stable project IDs, assignments, journal and receipts during code recovery; do not restore an older database to undo a UI change. Recovery instructions for [project transfers](project-transfers.md) continue to apply to later workspace moves.

The project projection includes lifecycle, Importance, Portfolio, workspace identity, and revision in bounded bootstrap and changed-record responses. Reload clients across the schema upgrade so strict record validation recognizes that shape. Preserve compatible readers and writers during code rollback; a database restore is not a UI rollback. Keep the compatible goal-lifecycle contract and reviewed Worker execution ceilings as well.
