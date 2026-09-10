---
title: Publish local observations
description: Enroll a narrowly scoped publisher and report real checkout facts without a local dashboard server.
---

# Publish local observations

A local publisher sends measured checkout facts to the hosted dashboard. It does not execute remote commands or need to keep a local web server running. Offline observations become stale while the online workspace remains available.

## Enroll a publisher

Open **Settings > Local publishers** and choose **Enroll publisher**. Name the source, select the repositories it may report on, and set its freshness window. Save the source, open **Credentials**, review the selected repositories and expiry, and create a named publisher credential. Save the value privately before closing the dialog. It is returned once and only its digest is stored. It is not retained in the browser's persistent storage or application query cache.

Owners can administer source scope and credentials. Operators and viewers can inspect source status but cannot grant publishing access. A publisher credential can submit observations for its enrolled source and selected repositories only. It cannot list workspaces, read repository metadata, write expectations or goals, administer credentials, select a different provider, or execute commands. Publication checks live membership, credential validity, source revision, and scope at the atomic write boundary.

On a hosted publishing client, configure `HQ_URL` with the HTTPS workspace origin and load `HQ_TOKEN` privately from your credential store. Never place the value in command arguments, Activity, or a tracked file. The publisher sends the shared command:

```bash
npm run cli -- schema observations_publish
npm run cli -- call observations_publish --input report.json
```

The producer supplies `workspaceId`, `sourceId`, a stable `reportId`, and an `observations` array. Each observation contains the enrolled `repositoryId`, the real UTC `observedAt`, branch, dirty flag, and measured ahead count. Missing or failed measurements must not be replaced with fabricated clean or zero values. The schema rejects provider health claims, arbitrary payloads, local paths, caller-selected expiry, and repositories outside the source scope. Local checkout facts do not verify GitHub CI, security findings, hooks, or monitoring.

Retain the same report ID and content when retrying an interrupted publication. Identical retries return the original receipt without extending freshness. Distinct reports require strictly newer observation timestamps for every included repository; validation and receipt writes are all-or-nothing. HQ computes expiration from observation time and the source policy. Delayed observations can be accepted as stale evidence. Reports are bounded by request size, batch and workspace limits, with at least five seconds between new reports per source. Receipt history is retained for seven days; timestamp ordering still prevents replay from replacing newer evidence after a receipt expires. First reports and changed checkout facts appear in Activity; unchanged heartbeats do not flood the journal.

Source settings use revision-aware Save/Cancel. Scope changes affect every credential for that source. Disabling a source stops new reports and expires its existing evidence; re-enabling it or extending freshness does not revive expired evidence. Revoking one credential immediately prevents further writes with that credential but does not revoke others or erase previously received observations. Credentials expire automatically. A lost credential cannot be recovered: inspect the issued list, revoke it, and issue a replacement. Active credentials appear before historical entries.

The equivalent CLI and MCP commands are `sources_list`, `source_get`, `source_enroll`, `source_update`, `publisher_credentials_list`, `publisher_credential_issue`, `publisher_credential_revoke`, and `observations_publish`. Enrollment uses a stable source ID for retries; updates and credential issuance bind to the reviewed source revision. Credential issuance is deliberately not retry-transparent: its privileged response contains a sensitive value once, including on CLI stdout or in an MCP tool result. Do not capture that response in general-purpose logs. An interrupted issuance must be inspected and, if its value was lost, revoked before replacement.

The loopback preview stores synthetic credentials only in its isolated development database. An explicit bearer header follows the real credential resolver, including revocation; an invalid header never falls back to the development owner. `--dev` continues to use the local owner and never sends `HQ_TOKEN`. No production identity, credential, provider, or scheduler is configured by enrolling a development source.
