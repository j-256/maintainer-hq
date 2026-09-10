---
title: GitHub evidence
description: Review repository coverage, diagnose gaps, and configure read-only collection.
---

# GitHub evidence

Open **Settings > GitHub evidence** for the Coverage view. Each row identifies the repository, its explicit GitHub connection, accepted evidence and the latest refresh result. Search repository names or filter by connection, coverage state and lifecycle; archived repositories are excluded unless requested. Pagination bounds the displayed rows and their receipt-detail read, moving keyboard focus to the result summary when the page changes. The URL retains these choices through reload, receipt inspection and navigation between Coverage and Connections.

**Inspect** expands the individual checks and observation, acceptance and expiry times. Multiple connections retain separate results and next steps; one readable connection does not hide another connection's missing coverage. **Open refresh receipt** opens that source's exact latest run when available, or its refresh history when none is retained. **Edit connection** uses the existing revision-checked form. Viewers can inspect coverage and receipts, but only owners can edit settings.

## Interpret coverage

- **Coverage current** means the supported checks were read within their freshness window. It does not mean CI passed or there are no security findings. Open the repository for those results.
- **Access or feature gaps** means some checks were unavailable. Inspect which checks were denied and review repository access, credential read permissions and feature availability. A denied read alone cannot identify the missing permission or prove that an upgrade is needed.
- **Collection error**, **Provider rate limited**, **Read limit reached** and **Evidence incomplete** describe different read failures or bounds. Inspect the receipt and its diagnostics; honor a reported provider cooldown before retrying.
- **Evidence stale** means the accepted observation expired. Review schedule eligibility, cooldown and receipt progress in the connection. Reloading the dashboard does not freshen it.
- **Awaiting evidence**, **Connection not configured**, **Collection disabled** and **Not collected** keep missing observations separate from missing credentials, deliberate disablement and absent enrollment. Choose or enable a connection only when collection is intended.

The latest refresh can contain a queued item that has not been attempted. Its queue time is not a successful read or fresh evidence. An older accepted result remains visible independently, and its original expiry still applies. Receipts from earlier source settings or repository names are explicitly historical; evidence under an earlier repository name does not establish coverage for the renamed record. A source's **Last complete collection** clock advances only when every selected repository is fully collected, so it may be older than accepted results from runs with access gaps.

Refresh details have their own failure and Retry state. Accepted evidence from the workspace view remains visible if that read fails, with any retained receipt details identified as an earlier successful read. Choosing one connection or narrowing the repository search can resolve an oversized selection. No coverage read contacts GitHub or requests broader provider permissions.

## Manage connections

To discover or reconcile repository enrollment using an existing source's read authority, open **Repositories > Review enrollment**. [Fleet enrollment](fleet-enrollment.md) checks either the HQ inventory or a selected owner catalog without importing all accessible repositories. Discovery and collection membership are separate choices; an unavailable read does not propose a deletion.

Choose **Connect GitHub** to name the connection, select enrolled repositories and an available server-side credential reference, and set the refresh and freshness intervals. **Configure later** saves an unconfigured source without claiming evidence. The **Connections** view contains settings, schedule and refresh controls; expand a connection's repository scope or choose **View coverage** to inspect its selected repositories. Owners manage settings; owners and operators can refresh or cancel collection; viewers can inspect status and receipts. None of these controls writes to GitHub.

**Refresh GitHub** queues durable work and opens its receipt. **Refresh history** shows per-repository progress, attempts, minimized evidence, and unavailable or incomplete categories. Closing the view does not cancel work. Cancellation stops pending work and prevents an in-flight result from being accepted, while retaining completed evidence. A failed or interrupted request can be inspected through history; agents must reuse the same refresh ID when retrying an ambiguous submission.

Opening history in Settings records the selected source and receipt in the page URL. Share that URL only with someone who should have workspace access; the link itself grants none. A linked older receipt can be opened even when it is outside the latest history page, until retention removes it. New [GitHub Activity events](activity.md#github-refresh-events) offer an inline receipt view that preserves the journal's filters and historical position. **Refresh receipt** reads the saved progress again without queuing another collection.

The hosted collector resumes queued work and schedules due sources through a Cron handler. Refresh eligibility is not a completion deadline: bounded work, rate limits, and backlog can delay collection, and expired evidence stays visibly stale. The loopback preview does not run a hosted scheduler or provision GitHub credentials. Production deployment and credential provisioning require their own approval.

The shared commands include `github_coverage`, `github_credentials_list`, `github_source_get`, `github_source_enroll`, `github_source_update`, `github_refresh`, `github_refresh_get`, `github_refreshes_list`, and `github_refresh_cancel`. Read their schemas with the CLI or MCP tool discovery. `github_coverage` accepts bounded explicit repository IDs and an optional connection ID, returning saved coverage and latest-run item metadata in the requested repository order. It requires workspace read authority and accepts no pagination cursor, provider URL or credential value. Source enrollment uses a stable source ID; updates and refreshes bind to the saved source revision. A refresh receipt is bound to its requesting actor, source, revision, and stable refresh ID. See the [GitHub evidence contract](github-evidence.md) for credential custody, recovery, limits, and deployment prerequisites.
