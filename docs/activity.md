---
title: Activity journal
description: Follow exact goals and accountable work with grouped, paginated history.
---

# Activity journal

Activity combines attributed work reports with recorded workspace changes. Search and type or repository filters run against the full authorized journal, not just the newest snapshot. The pinned active goal remains verbatim and independent of those filters.

## Reading and navigation

Each goal has a collapsible section with its complete objective, status, matching event count, and latest matching timestamp. Completed and cleared sections start collapsed; active, blocked, or paused sections start open. Filtering opens matching sections so their results are visible. Explicit collapse choices survive automatic refresh and page navigation within the selected filters.

The pinned panel distinguishes active execution, a reported blocker, and a paused source goal. Paused means the objective remains open without claiming the source is executing. Cleared means removed from the source, not completed: its exact objective and journal remain available in history but it is no longer pinned. HQ mirrors those source decisions; it does not pause, resume, clear, or complete the source's goals itself. Creating a replacement does not silently clear another goal.

Active and blocked reports older than five minutes are labeled as last reported with **Awaiting goal sync**. This is a source-report freshness warning, not a work blocker or an instruction to refresh the browser. A local display clock ages that warning without network requests. Paused and historical states do not require execution confirmations. The sync timestamp remains visible, and journal updates can describe separately reported work while a source goal is paused.

The main pager keeps each goal together and treats an unassociated event as its own entry. An expanded goal has a separate pager for its updates. Opening a section fetches that goal's updates on demand. Changing a filter or search starts at the newest page. Keyboard focus moves to the page heading after navigation, and failed requests offer a retry without discarding filters.

The newest journal page follows saved changes through [workspace push updates](push.md) while the tab is visible and online. Hidden tabs disconnect and catch up on return. The connection indicator distinguishes a live socket from reconnecting or the slow fallback refresh used when push is unavailable. Loaded data and unsaved drafts stay in the tab, but reloading offline does not provide an offline workspace. A failed refresh keeps the last successful snapshot and offers a retry.

Moving to an older page fixes an insertion watermark, so incoming events cannot shift or duplicate the entries being read. Fixed pages do not poll repeatedly; navigation, returning to the tab, reconnecting, and explicit refresh can revalidate them. Returning toward the first page preserves that history view. Choose **Return to live activity** to fetch new arrivals immediately. Within a goal, **Newest updates** returns to the latest snapshot available to its enclosing journal page. The pinned goals continue to refresh independently; a historical section uses refreshed goal status when that goal is present in the workspace snapshot. Its event list and matching count retain the page's watermark until the page is revalidated.

Times use the viewer's timezone. Reported checks describe the writer's report; they are not independent provider health evidence.

Repository workspaces use the same server-side journal filter as Activity, with the selected repository fixed. A matching event names that repository directly or has an immutable repository association captured when the operation was recorded. Linking a resource later does not retroactively move its old operations between repositories. A goal's unscoped transitions and general updates are relevant when that goal has an explicitly repository-associated update within the same history watermark. Updates explicitly associated with other repositories remain excluded. The full objective stays verbatim. See [repository workspaces](repositories.md) for shared-resource ownership and scope.

## GitHub refresh events

New GitHub refresh events identify the source and link to their exact refresh receipt. **View refresh receipt** opens a quick view without leaving your Activity filters or historical page; opening the link in another tab uses a shareable Settings URL. The selected workspace and source still determine access. A link does not grant permission.

Refresh events also capture their run's selected repository identities in the same database batch. They remain visible in those repositories' journal and compact overview after the source scope changes or the receipt expires. Cancellation retains that attribution too. Historical events without captured repository links are not assigned from a source's later configuration.

Completion summaries name a bounded sample of repositories whose evidence changed and the affected categories, such as default-branch commit, CI results, security findings, or coverage. The receipt lists each repository's recorded change categories. A first observation is distinguished from a change to existing evidence. Collection times and diagnostic timing counters alone do not count as evidence changes.

**Access / feature gap** means a reported unavailable category has matching permission/feature diagnostics. It does not prove which permission or provider feature is missing, make the gap acceptable, or turn missing evidence into health. Credential rejection, timeouts, provider errors, collection bounds, mixed failures, and incomplete legacy diagnostics require collection attention. **Collected** describes collection completeness, not passing CI or an absence of security findings.

Unchanged scheduled sweeps remain quiet in Activity while retaining bounded run receipts. Changes in collection condition can still produce an event without repository evidence changes. Manually requested refreshes remain explicit. Older events are not rewritten or assigned guessed receipt links, and older receipts without change comparisons say so. Receipt retention can expire a linked run while its Activity entry remains; the quick view explains that absence and offers history. Use **Refresh receipt** to update an open receipt explicitly, including a running collection opened from Activity.

## Associating work with a goal

The note form offers an optional goal picker. API, CLI, and MCP writers pass `goalId` to `activity_add` when an update belongs to an existing goal. Keep that association and the other event fields unchanged when retrying the same `eventId`. A Reporter credential can associate updates only with goals belonging to its bound reporter and owner, without gaining workspace read access. An authorized human writer can select any goal in the workspace.

Goal transitions are associated automatically. The database migration links older transitions only when their workspace, actor, reporter, and exact objective identify a unique goal. Ambiguous transitions and unassociated progress reports remain standalone. HQ does not guess goal membership from timestamps or nearby prose.

An agent publishing its work uses both `goal_sync` and `activity_add`. Goal confirmations say when the agent checked in; they do not explain progress. Sync immediately after creating or changing a source goal, including pause, clear, resume, and completion; check the actual source state before reporting it. Confirm status again at substantive milestones while executing. Publish progress for implementation milestones, completed verification, deployment outcomes, and genuine blockers, linked to the exact goal and relevant repository. Distinguish local results from deployed behavior and never backdate a missing report to imply continuous reporting. Only confirm active work when the source is actually executing; an unattended timer that repeats the last active status is not evidence that an agent is working.

## Reporting identity and retries

Writers generate a stable `eventId` for each update and retain it when retrying that same content. Reusing the identifier with changed content is a conflict. Goal publishers send the original `objective`, stable `sourceId`, distinct `goalId`, source status, `startedAt`, and `reportedAt`. Goal identities cannot change their objective or owner. Read the command schema for supported source states instead of deriving them from display labels.

Timestamps use UTC ISO 8601 and are compared at millisecond precision. Equivalent spellings do not change identity or ordering. Older reports cannot overwrite newer state, and transitions are journaled atomically without duplicating retries. An identical retry retains its original receipt time rather than refreshing an old report. A delayed source report stays visibly stale even when HQ receives it successfully.

## Shared read contract

`activity_feed` returns bounded pages of goal groups and standalone events. `goal_activity` returns bounded pages of updates for one goal. Both accept the workspace, type filter, literal search text, repository ID, page size, and cursor. The cursor is bound to those filters and the read mode; do not modify it or carry it into a different query. All reads recheck workspace authority. A cursor grants no access by itself.

Responses contain `nextCursor` for older entries and `viewCursor` for revisiting the same page. Goal groups also provide an `eventsCursor` that shares the enclosing page's watermark. Use it when opening the group's updates. The older `activity_list` command remains a bounded recent-event list for clients that do not need navigation; the dashboard uses the paginated contract.

The database keeps insertion order separately from display timestamps, so tied timestamps, delayed reports, and deletion of the newest event cannot cause a newly inserted event to reuse an existing history position. Back up the database before applying migrations; the journal, goal records, and ordering table belong to the same recovery unit.
