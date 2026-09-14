---
title: Monitoring workspace
description: Read check and scheduler evidence, manage targets, and recover reviewed operations.
---

# Monitoring workspace

Monitoring is an independent Endpoint Monitor operator surface. Owners enroll deployment-approved connections, operators review supported configuration and triage actions, and viewers inspect evidence. Targets can stand alone or be explicitly linked to multiple [repository workspaces](repositories.md). HQ owns connection metadata, associations, and its action journal; Endpoint Monitor owns executing configuration, probes, incidents, triage, and provider receipts.

## Evidence and freshness

The Scheduler panel describes the latest retained completed scheduled run, including its scheduled and completion times, configuration revision, probe outcomes, phase errors, and notification failures. The provider keeps one bounded aggregate snapshot per completed scheduled minute in a fixed ring of 120 slots. Each snapshot holds at most ten check outcomes and has a 16 KiB byte cap. It contains identifiers, fingerprints, fixed outcomes, timestamps, and counters, not target URLs, responses, notes, or credentials. Healthy probes do not create per-target incident records.

Scheduler evidence is fresh until the scheduled instant plus the one-minute expected cadence and two minutes of grace. A late completion cannot reset that deadline. No completed run means unobserved, and an expired completion means overdue. Fresh completion proves that run reached its reporting point; the outcome counters can still contain failures. It does not prove every configured target ran or that the Worker has been continuously executing. Independently delivered missed-run alerts are not implemented by this display.

Each target separately shows its last check, last retained matching pass, and check deadline. A check must match the saved configuration revision, document fingerprint, and target fingerprint before it can support a passing or failing badge. Even restoring an older configuration's exact contents requires a check at the new revision. The check deadline uses the earlier of check start and scheduled time, plus the checked interval and two minutes of grace. Newer matching exceptional-state evidence cannot be hidden behind an older successful snapshot.

The ring is bounded evidence, not a complete probe history. Retained passes can age out; stopping the scheduler does not turn an old retained slot into fresh evidence. A successful check proves that recorded request met its expectations, not continuous uptime or automatic incident resolution. Incident state stays separate. Absence of an incident never substitutes for a successful check.

The [repository coverage check](repositories.md#read-the-repository-overview) reuses these exact target and scheduler reads without triggering probes. It retains a minimized result for explicitly linked targets and requires both a passing configuration-matching check and a fresh completed scheduler run that was enabled and used the saved configuration. An unresolved incident remains a warning even when a recovery probe passes. Saving a Monitoring requirement changes HQ's assessment rule, not provider configuration. Use **Manage monitoring** for reviewed target or default changes. Acceptance of a monitoring operation invalidates related repository coverage; an old passing check cannot validate the new configuration.

Browser deadlines advance independently of polling, including after a failed refresh or while offline. The shared display clock pauses in hidden tabs and catches up immediately when visible again. Read timestamps, probe intent, notification intent, bounded incident counts, and analytics settings are labeled separately from execution evidence. A `+` count is a lower bound. All displayed instants use account date/time preferences and retain exact UTC tooltips.

## Configuration and triage

Inspect a target to edit its URL, method, accepted statuses, timeout, failure/recovery thresholds, and optional response assertions. JSON subset expectations use a structured nested-value editor, not raw JSON text. The defaults editor controls the shared schedule and probe defaults. Adding, editing, or removing a target creates a review against the exact saved configuration; unrelated targets are preserved. Public HTTP/HTTPS URLs are required, and provider validation remains authoritative for schedule capacity and normalized configuration.

The [monitoring expectation action](repositories.md#resolve-an-expectation) opens the same target and schedule editors from a repository or bulk expectation draft. Saved reviews have addressable URLs, and returning keeps the expectation choices. After creating a monitor, choose **Link monitor** to associate it with the repository; acceptance of target configuration and verification of monitoring coverage are separate steps.

Drafts survive failed requests and revision conflicts. Loading saved state explicitly replaces the draft only after a successful read. Review names the exact change and expiry before confirmation. Configuration acceptance does not prove scheduler adoption; the next completed run and target check establish that separately.

Incident inspection offers reviewed acknowledgement, bounded snoozing, or deliberate dismissal, with optional operator notes. Snooze review shows the exact end time in the viewer's selected time zone. Triage changes operator state, not probe evidence. Target filters and provider cursors keep incident and history reads bounded. Missing targets, disabled connections, malformed responses, unavailable permissions, and failed refreshes are not treated as healthy empty results.

## Operations and recovery

Each HQ review binds its workspace, actor and credential, membership revision, connection revision, provider credential identity, exact inputs, relevant provider revisions, fingerprint, and expiry. Only its original actor and credential can confirm. HQ persists operation intent and immutable repository attribution before the external effect, then rechecks live authority before submission. Provider acceptance and HQ's saved receipt are separate facts.

Keep stable review IDs when recovering an interrupted planning response. Confirm only the original plan ID and fingerprint. A lost response can leave running or indeterminate work; use the addressable review or Operations history to reconcile the original provider receipt. Reconciliation never submits a new configuration or triage action. Any authorized workspace operator can reconcile, including after the connection has been disabled. An unexpired open provider review remains uncertain while a request could be in flight; it is not evidence that nothing happened.

Retain the original scoped credential descriptor until uncertain operations are resolved. Rotating a credential or changing a connection must not silently redirect recovery to a different provider identity. If a receipt is no longer available, preserve the uncertain record and inspect provider-owned state rather than inventing success or repeating the action. Rolling back code does not undo provider changes, and restoring a whole database over subsequent work is not routine rollback.

## Shared command contract

Browser, CLI, HTTP MCP, and stdio MCP share validated workspace commands. Discover exact input schemas with `npm run cli -- schema <command>` or MCP discovery:

- Connections: `monitoring_connections`, owner-only `monitoring_providers`, `monitoring_connection_save`
- Evidence and configuration: `monitoring_snapshot`, `monitoring_configuration`, `monitoring_targets`, `monitoring_target`
- Incidents: `monitoring_incidents`, `monitoring_incident`
- Reviews and recovery: `monitoring_configuration_plan`, `monitoring_triage_plan`, `monitoring_apply`, `monitoring_review`, `monitoring_reconcile`, `monitoring_history`

Reader automation can inspect metadata but cannot configure or triage. Source publishers and activity reporters have no Monitoring authority. HQ actions also require the selected provider credential's matching capability. Inputs never accept caller-selected management URLs, SQL, binding names, shell commands, or provider token values. Endpoint Monitor's own `status` CLI reads the same retained run/check evidence without probing targets or reading a local target file.

## Provider deployment and credential boundary

Apply Endpoint Monitor's remote-configuration, management, and bounded run-status migrations before deploying its compatible provider. Preserve the executing remote configuration and its revisions; a stale local deployment file must not overwrite online edits. Apply HQ's repository-association and Monitoring migrations before deploying the compatible HQ artifact. Preserve private database backups, prior artifacts, bindings, runtime settings, and separately recoverable credentials. Migrations are additive; database restoration and code rollback are independent decisions.

HQ's reviewed release profile declares `monitoringBindings`, each with a `MONITORING_` binding name and exact provider Worker target. The server-side `MONITORING_CREDENTIALS` secret maps opaque provider references to `{ workspaceId, name, binding, providerId, revision, token }`. Endpoint Monitor separately holds token digests, identities, revisions, workspace allowlists, read/configure/triage capabilities, and expiry. Provision values through protected input and storage. Ordinary UI forms, logs, screenshots, command arguments, source, and release profiles must not contain them.

The binding client constructs its own authorization headers and calls only the provider's versioned `POST /admin/api/v1` path. It does not forward browser cookies or Access assertions. Redirects are rejected, streamed response bytes and total response time are capped, successful responses require strict supported schemas, and raw provider error text is discarded. A private binding requires no new public hostname or preview. It provides reachability, not authority by itself.

Deployment verification uses real read-only provider metadata, configuration-bound scheduled evidence, denied unauthorized access, and the intended HQ Access/binding placement. Do not alter a live target, dismiss an incident, or force a notification as a smoke test. Synthetic Workers/D1 and browser fixtures cover effects, conflicts, duplicate confirmation, revoked authority, delayed responses, expiry, recovery, both themes, and mobile/keyboard behavior separately.

## Resource and Free-plan considerations

`MONITOR_LIMITS` bounds connections, provider references, target documents, page sizes, pending reviews, response bytes, deadlines, notes, nested assertions, and returned history. Provider reads do not persist snapshots into HQ. Visible first pages refresh on a bounded cadence; deeper pages do not repeatedly poll. Reviewed mutations add HQ journal/receipt writes and provider-owned writes. None of these bounds is a global spending limit or an edge rate limit.

The provider's aggregate snapshot changes at most one row per completed scheduled minute, including disabled runs with configured storage. Duplicate completion for the same minute does not replace the accepted row. A continuously completing minute schedule projects at most 1,440 aggregate snapshot changes per day; that is a logical-write projection, not measured billable D1 rows or index work. Probe, incident, notification, analytics, retention, and review work have separate costs. There is no per-probe success log or unbounded success-event journal.

Free-plan compatibility of the combined authenticated HQ/provider path is unmeasured. A successful Paid deployment or synthetic test does not establish Free support. Measure CPU, request and query allowances, billable database rows, retention, provider fan-out, and logging independently before claiming compatibility. Existing measured HQ collection exceedances and logging policy are recorded in [diagnostics](diagnostics.md). CPU limits do not cap downstream spending, and this integration does not implement automatic spending shutoff.
