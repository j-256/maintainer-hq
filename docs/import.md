---
title: One-time metadata import and recovery
description: Review starting metadata without importing credentials or invented health.
---

# One-time metadata import and recovery

Metadata import is a starting point for a new workspace, not ongoing synchronization or a second configuration authority. Normal expectation changes stay in the structured repository editor. Prepare and review a metadata file once, select it under **Settings > Import metadata**, inspect the exact target and records, and choose **Import reviewed metadata**. No JSON editor is part of the application flow.

Only an owner with `read`, `workspace:admin`, and `metadata:write` may prepare, inspect, or apply an import. The target must have no projects, no repositories, and no previous import receipt. Import never merges, overwrites, or updates providers. An existing populated workspace explains this restriction in Settings.

## Accepted metadata

The strict versioned schema is `importManifest` in the shared domain contract. [The example file](../fixtures/import-metadata.json) contains only synthetic project and repository intent. Files are bounded by size, project count, and repository count; the CLI can inspect exact limits and fields with `schema metadata_import_plan`.

A version 2 file contains `formatVersion`, a descriptive `sourceLabel`, project records, and repository records. Each project has a file-local key plus its metadata. Each repository carries a full name, description, classification, lifecycle, explicit expectations, and a `projectKey` referencing a project declared in the same file. Project keys, project names, and repository names must be unique within their documented scopes. Version 1 projectless manifests and unsupported fields are rejected at every object boundary. Full legacy documents, credentials, members, sources, pending operations, observations, and goal identities are not accepted. Free-text descriptions and notes still require human review: a structural allowlist cannot detect every secret someone might paste into prose.

The source label is descriptive, not proof of origin. Retain the original metadata projection and its independently computed digest in private recovery storage. Review any conversion rules alongside the candidate file. A coarse coverage requirement is not equivalent to a provider's detailed configuration: schedules, policy exceptions, hook profiles, endpoint associations, and baseline-dependent review rules must be mapped or explicitly retained for separate work. Missing provider evidence must never become healthy status through conversion. Do not substitute a stale local document for the hosted configuration authority.

## Exact review and retries

`metadata_import_plan` accepts the explicit workspace and manifest. It normalizes record order and saves a short-lived review bound to the actor, initiating credential, membership revision, workspace, and exact metadata. The returned fingerprint identifies that review, not an independently authenticated external source. The plan grants no additional authority.

`metadata_import_apply` accepts only the workspace, plan ID, and fingerprint. Live owner authority, credential validity and scopes, membership revision, expiry, and an empty project and repository inventory are checked at the write boundary. Project inserts, project-owned repository inserts, the receipt, plan completion, and Activity are one database transaction. A conflicting import, changed access, concurrent enrollment, missing project reference, or failed insert cannot leave a partial import. The import uses a bounded batch with set-based inserts, not one database round trip per record.

The same successful apply can be retried after a lost response, including after the original review expires, while the reviewing identity retains the required authority and revision. It returns the original receipt without duplicating repositories or Activity. A different actor, initiating credential, plan, or fingerprint cannot claim that receipt through apply. Owner-only `metadata_import_status` reports inventory eligibility and the saved receipt after a reload.

The browser preserves an interrupted review and offers **Retry same import**. Do not start a new import when the result is uncertain. If the tab was closed, inspect import status first. A completed receipt remains visible even if repositories are subsequently edited. File and review drafts are held in component state, not persistent browser storage. Navigating away from an unsaved review requires confirmation.

Browser, HTTP commands, CLI, and MCP share these contracts. Preparing a review is a write; applying a reviewed import is retry-safe. Neither command performs a provider operation or creates production resources.

## Database recovery is a different operation

A complete backup includes identities, credential digests, queue state, and the journal. It is not a metadata import file and must not be uploaded through the import UI. Preserve it privately with restrictive permissions. Keep secret-value recovery separate. Never bootstrap production by copying a development database and implicitly granting its identities access.

Rehearse recovery against a new isolated storage directory with explicit local database configuration. Export using the owning Wrangler configuration, restore into isolated SQLite and local D1, check schema integrity and foreign keys, and compare every exported table's normalized rows with the export. Compare Activity and goals exactly, including whitespace, original owners, statuses, and timestamps. Then test application reads against the restored schema and migrate the isolated copy if required. Do not point a rehearsal command at the dogfood state directory or a remote database.

Local SQLite and local D1 recovery verify the export format and application schema, not remote D1 Time Travel, deployed Access, route rollback, or production credential recovery. Before reopening a restored deployment, reconcile revoked credentials and pending work; restoring old database rows can revive authority or in-flight intent. A hostname rollback does not undo database writes, and a database restore does not restore provider tokens or ingress policy. The [hosting gate](hosting.md) defines the separately approved deployed rehearsal and cutover.
