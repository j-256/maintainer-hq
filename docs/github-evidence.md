---
title: GitHub evidence contract
description: Understand read-only collection, coverage, scheduling, and safe credentials.
---

# GitHub evidence contract

The read-only collector accepts an enrolled GitHub repository name and a server-supplied credential. It makes GET requests only to the fixed GitHub API origin, rejects redirects, and emits a minimized typed result. Repository metadata, the default-branch head, CI, and security have separate coverage states. A successful fetch is not the same as healthy repository evidence.

## Evidence scope

| Category | Read scope | Meaning of an empty result |
| --- | --- | --- |
| Repository | The enrolled repository's metadata | Invalid response, not a missing repository record |
| Head | The default branch's commit | Unverified CI reference |
| Checks | Latest check runs for the observed commit | No check-run evidence |
| Statuses | Combined commit statuses for the observed commit | No commit-status evidence |
| Dependabot | Open repository alerts | No open alerts in the complete supported collection |
| Code scanning | Open alerts on the default branch | No open alerts in the complete supported collection |
| Secret scanning | Open alerts with literal values hidden | No open alerts in the complete supported collection |

CI is passing only when complete check-run and commit-status collections contain an actual success and no pending or unsuccessful result. Empty collections, skipped-only checks, pending work, malformed results, and unavailable endpoints cannot establish passing CI. The collector reports observed checks and statuses, not branch-protection or ruleset compliance. Failed results remain actionable when another category is unavailable.

A zero finding count requires complete reads of all supported security categories. Partial collections can report a positive lower bound, but cannot establish that the repository is free of findings. Repository assessment keeps incomplete security coverage visible alongside known findings. Scanning coverage is limited to what GitHub returns through these endpoints; it is not proof that every vulnerability or secret has been detected.

## Safety and bounds

The API version, timeout, response-size, pagination, and request budgets are named in the shared evidence contract. Timeout covers response-body reads as well as request establishment. Cancelled work does not start another request. Endpoint failures return fixed, actionable messages rather than provider response bodies.

Dependabot pagination uses cursors. Other supported list endpoints can use page or cursor links. A next link must retain the fixed origin, enrolled endpoint, and requested filters; credential-bearing redirects, extra parameters, duplicate cursors, filter changes, repeated pages, overlapping results, and inconsistent totals do not establish complete coverage. Hitting a collection budget produces a limited result, not an empty success. Rate-limit responses produce a retry deadline with a bounded backoff; the durable refresh layer owns scheduling that retry across sources.

Secret-scanning requests include `hide_secret=true`. Literal values and other unneeded fields are discarded even if a provider returns them despite that flag. Only allowlisted evidence enters the result. Provider error bodies, repository descriptions, commit messages, arbitrary links, and credential values are not returned or journaled. Evidence links are constructed from the fixed GitHub web origin and enrolled repository name.

Observation time belongs to the collection, not the browser refresh or later database receipt. Persisting, retrying, or displaying a result must not extend its freshness. A source's declared policy determines the expiry.

## Source ownership and credential custody

Each GitHub source belongs to one workspace and an explicit set of enrolled repositories. Owners control its name, enabled state, credential reference, refresh interval, and freshness window. Settings use optimistic revisions; conflicting edits leave the browser draft intact. A name-only edit preserves valid evidence. Removing a repository excludes its old observations; disabling a source or changing its credential reference expires existing evidence. Shortening freshness may shorten an existing expiry, but extending the policy or re-enabling a source cannot revive old evidence. Any settings revision cancels in-flight work that was bound to the preceding revision.

The dedicated Worker secret binding `GITHUB_CREDENTIALS` contains an object keyed by credential reference. Each entry has exactly `workspaceId`, a human-readable `name`, and a server-only `token`. Invalid entries are unavailable. Credential discovery returns only references and labels belonging to the authorized workspace, and requires owner access. GitHub does not use the generic provider `CREDENTIALS` map. Token values are never accepted by browser forms, ordinary API commands, CLI arguments, or MCP tools, and are not stored in D1. D1 retains an internal credential digest for job identity and cooldown coordination, never in routine responses.

Provision only read access to the selected repository metadata, default-branch head, checks, commit statuses, and supported alert endpoints. Supported token types and exact permissions must be checked against the linked GitHub endpoint contracts when provisioning. Inaccessible or disabled security features remain unavailable, not clear. Supplying a token with broader permissions does not broaden the collector: it still sends only the fixed allowlisted reads.

Provision the catalog through the deployment platform's secret-input boundary, using protected standard input or its privileged secret manager. Do not place it in source-controlled configuration, frontend environment variables, logs, or screenshots. To rotate safely, disable affected sources first, rotate their deployment binding, then re-enable the sources. Already-running Worker invocations retain their environment snapshot; the disabled source revision in D1 is what invalidates their results immediately. The same provider token used under multiple references or workspaces shares a digest-keyed cooldown.

## Durable execution and recovery

Refresh intent, actor identity, source revision, pinned repository identities, and item receipts are persisted before any external read. Duplicate refresh IDs return the original receipt to the same actor for the same source and revision. Conflicting reuse is rejected. Only one refresh may be active per source. Manual refreshes have a minimum interval, and provider cooldowns can extend the wait. An active manual job rechecks the requesting member's operator authority and bearer credential validity at claim and acceptance; scheduled work instead derives authority from the owner's enabled workspace source configuration.

Workers claim an item with an expiring lease and recheck source revision, enabled state, repository scope and identity, actor authority, provider credential identity, and lease ownership before accepting it. D1 batches atomically record outcomes and evidence. A stale lease, revoked actor, cancelled job, renamed repository, or incompatible source cannot overwrite evidence. Observation ordering prevents an older read from replacing a newer one. Workspace evidence capacity is enforced at the same write boundary; a capacity failure is visible in the receipt instead of breaking the workspace snapshot.

HTTP requests schedule a bounded background slice with `waitUntil`; the persisted queue survives interruption of that slice. The production Cron handler recovers interrupted leases, schedules due sources, drains bounded work, and performs a final recovery pass without a browser or local machine. Named limits in `shared/github.ts` bound source scope, intervals, per-invocation work and time, retries, recovery age, and history. A source can select up to one hundred repositories. Scheduled slices process at most twenty repositories sequentially within a two-minute wall budget, including scheduler setup. The runner does not claim another repository without reserving its twenty-second collection deadline plus a five-second acceptance margin. Database delays can still consume that margin; leases and acceptance checks remain authoritative. HTTP background slices remain limited to one repository and twenty-five seconds.

Each paginated endpoint allows five pages of up to one hundred entries. Two scalar reads plus five paginated endpoints yield a maximum of twenty-seven GitHub requests per repository, or 540 per complete scheduled slice. This profile requires Workers Paid; it deliberately exceeds the Free external-request allowance and has observed CPU usage above Free's allowance. See the [compatibility record](diagnostics.md#cloudflare-free-plan-compatibility) for measured and projected CPU, request, database, and logging usage. Increasing the deployment's CPU ceiling to five minutes is unnecessary for this profile.

Unprocessed repositories remain queued for subsequent invocations. Cron runs on a fixed eligibility cadence, not a guarantee that every repository completes at its configured interval; source intervals and freshness should allow for the total enrolled workload. A fifty-repository fixture drains across three ordinary scheduled slices, but slow providers, deeper pagination, additional sources, and recovery can extend that drain. Repeated interruption exhausts attempts; over-age jobs terminate visibly. Provider rate limiting leaves unread items queued until cooldown ends, while the rate-limited item's incomplete evidence remains explicit. A new refresh is required to reread that item.

GitHub quotas remain independent of the Cloudflare plan. GitHub documents a shared personal-token allowance of 5,000 requests per hour; fifty repositories at seven requests each every five minutes project 4,200 requests per hour before other applications or manual refreshes. Repeated full pagination projects 16,200 requests per hour and cannot sustain that cadence on this allowance. Increase source intervals when measured demand requires it, retain cooldowns, and inspect partial receipts instead of assuming Paid removes provider limits. These are workload projections, not measured hourly consumption. See GitHub's [rate-limit contract](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

Enabled release profiles invoke the scheduler every minute to drain these small batches. This is not a per-source refresh interval: persisted source settings determine when new reads become due, and an unfinished refresh continues without creating duplicate work. Disabled release profiles have no Cron trigger.

Saving source settings does not bypass the minimum interval after the previous refresh attempt. The scheduler leaves that source eligible for the next permitted tick without recording a collection failure or imposing a longer default delay. Concurrent source edits, disablement, removal, accepted refreshes and shared provider cooldowns are rechecked without replacing an earlier genuine error. Invalid configuration and unavailable credentials still produce explicit source errors; unexpected scheduler failures still reach invocation diagnostics. The retry deadline remains visible in the source's provider-cooldown status.

Completed job items preserve partial and failed results. `lastSuccessAt` advances only after complete collection across the selected repositories; it is not a health assertion. A failed read replaces that source's passing claim with unknown or incomplete evidence instead of freshening it. Manual starts and terminal outcomes are journaled. Scheduled outcomes are journaled when evidence or source error state changes, not for identical heartbeat reads. Completed historical receipts expire after the retention window, except for a source's latest receipt; Activity is retained separately. A refresh ID is not a permanent idempotency key after its receipt expires, so long-delayed clients should inspect history before submitting new work.

## Bounded coverage reads

Release and deployment context is a separate [bounded on-demand read](releases.md). It reuses enrolled read credentials without adding endpoints to scheduled CI/security refreshes or changing the observation health contract.

`github_coverage` is a read-only workspace contract shared by the browser, CLI and MCP. It accepts unique explicit repository IDs bounded by `GITHUB_COVERAGE_LIMITS.REPOSITORIES` and an optional exact source ID. It returns repository identity/revision, currently enrolled GitHub source metadata, accepted check coverage with original observation/receipt/expiry times, and each source's latest refresh item for the selected repository. Rows preserve requested repository order. A selected source that exists but does not enroll a requested repository contributes no coverage; a source or repository outside the workspace is unavailable, not an inferred association.

The latest-run item is not a query for the latest attempted item across all retained history. Its attempt count distinguishes a queued or cancelled-before-attempt item from actual collection, independently of the last accepted observation. Source-revision and repository-name matches qualify the receipt; an old name also makes accepted evidence unsuitable for the saved repository identity. Complete read coverage is independent of observed CI failures and security findings. Unavailable, unobserved, error, limited and rate-limited checks remain distinct. Missing check keys cannot become observed by omission.

The implementation batches bounded local metadata, scope, evidence and latest-item reads, then revalidates live principal authority and repository/source revisions. Reader access is sufficient; publisher and Reporter credentials remain excluded. It resolves only safe server-side credential availability metadata and cooldowns, with no provider requests. Raw payloads, credential references or values, check summaries and unrelated observation fields are excluded from this projection. Stored malformed evidence or receipt metadata fails explicitly. Named source-row and UTF-8 response bounds fail closed with guidance to narrow the selection.

The Coverage screen derives filters and pagination from its existing tab-scoped repository/source/evidence records. Only visible repository IDs request latest-item details. Source or repository changes invalidate that active auxiliary read; Activity-only updates do not. Connections and other tabs do not keep the coverage query mounted. A local display clock ages evidence without fetching it, and hidden tabs stop the clock. Failed reads preserve the workspace evidence display with an explicit error and retry, rather than rendering an empty or healthy result.

## Deployment and verification boundary

The repository's production configuration declares the scheduled handler but uses placeholder storage identity and does not provision authentication or provider credentials. Deployment must deliberately configure the real D1 database, apply migrations, establish workspace membership and authenticated access, install the dedicated GitHub binding, and verify the Cron trigger before enabling production sources. Preserve D1 through the provider's backup/recovery path and the credential catalog through a separate protected secret recovery path. Restoring only source code does not restore memberships, receipts, observations, or secrets. The retained hosted deployment is not modified by running this preview.

Collector and durable-job tests exercise the local Workers/D1 runtime with isolated GitHub responses and synthetic credentials. The actual scheduled handler and production bearer-authenticated HTTP background path are fixture-tested. Browser tests use real isolated source-setting writes and explicit synthetic refresh receipts to verify progress, incomplete evidence, cancellation, role-specific controls, conflicts, retry behavior, and accessibility. These checks do not claim that production credentials, private repository permissions, or a deployed schedule have been validated.

## References

The endpoint and parameter shapes follow GitHub's [published REST OpenAPI description](https://github.com/github/rest-api-description/tree/main/descriptions/api.github.com). CI semantics are documented in the [check runs API](https://docs.github.com/en/rest/checks/runs) and [commit statuses API](https://docs.github.com/en/rest/commits/statuses). Security reads use the [Dependabot alerts](https://docs.github.com/en/rest/dependabot/alerts), [code-scanning alerts](https://docs.github.com/en/rest/code-scanning/code-scanning), and [secret-scanning alerts](https://docs.github.com/en/rest/secret-scanning/secret-scanning) contracts.
