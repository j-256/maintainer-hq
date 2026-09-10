---
title: Pull requests and issues
description: Review open work, requested reviews, head checks, dependency bots and aging issues without provider write access.
---

# Pull requests and issues

Open a repository's **Work** section for its open PR and issue totals, a compact sample of PRs, and its oldest open issues. Follow a numbered title to the exact GitHub discussion, a head link to the observed commit, or a check link to the PR's Checks tab. GitHub's own interface may require a separate sign-in and repository access.

## Find the next thing to review

PRs combine up to ten recently updated and ten oldest open records, with duplicates removed. The total comes from GitHub independently of the sample. The view says when additional PRs exist; **All pull requests on GitHub** opens the complete provider list. Local pagination and filters apply only to the collected sample, not every open PR. New evidence preserves the selected filter and sample page.

- **Pending review** includes a provider decision requiring review or outstanding review requests. These are separate signals: review can be required without a named reviewer, and an approved PR can still have an outstanding request. A missing decision is not approval. Drafts remain explicitly labeled.
- **Failing checks** includes error or failure rollups for the exact sampled head commit. Pending, expected and absent rollups remain distinct. A passing head rollup does not establish required-check coverage, merge-commit checks or merge readiness. A PR that changes head, closes or loses access during collection retains its metadata with unavailable or incomplete signals.
- **Dependency bots** includes GitHub-reported Bot actors with the exact Dependabot or Renovate identity. Titles and human logins do not establish this attribution. Other bots and manually authored dependency updates can exist outside this filter.
- **Aging work** means open for at least thirty days. Creation age is not inactivity or a promised review deadline. The row also shows its last update date; date format and time zone follow Preferences.

Issues have a separate open total that excludes PRs and a sample of the ten oldest open issues. Disabled GitHub Issues is identified explicitly. An empty successful read means no open issues were reported, not that all work is complete.

## Access and freshness

The selected enrolled GitHub source supplies the existing protected read credential. Workspace viewers can use Work without repository administration or provider writes. Repository visibility and the provider's Pull requests, Issues and Checks read access remain independent of the HQ role and maintained/watchlist classification. A denied read cannot reliably distinguish missing grants, inaccessible resources and unavailable provider features; review the GitHub connection instead of assuming which permission to add. HQ does not replace a denied credential with a broader local one.

PR metadata, issue metadata, reviews and checks preserve their own read coverage. A check permission error does not hide readable PR titles or review decisions. Null reviewer counts, decisions and check rollups are labeled as unreported, not converted into a passing state. Signals are joined only to the exact sampled PR identity, repository, open state and head SHA.

**Observed** records the beginning of the accepted collection. Cache hits preserve that time. **Refresh work** becomes available after the displayed five-minute read window; a cooldown can extend it. Another window may be collecting, a source may be disabled, or a credential may need an owner's attention. These states are not healthy evidence. After a temporary read failure, any retained evidence keeps its original timestamp. Revoked or changed access hides it.

Only the mounted Work section reads this repository's work. The view uses the existing changed-record push coordinator, without a new polling loop or a scheduled fleet scan. Filters and pagination do not contact GitHub. A display-only clock updates age and stale labels. No project association or resource ownership is inferred from the sample.

## Shared command and bounds

Browser, CLI and MCP use the same read-only `repository_work` command with exactly `workspaceId`, `repositoryId` and `sourceId`. The pair must already be enrolled. The command accepts no provider URLs, GraphQL documents, node IDs, credential values, repository names or write instructions.

An uncached read makes one fixed GraphQL metadata query and, when PRs are available, one fixed signal query using only the sampled node identities. Bodies, comments, review text, file changes, user email addresses and arbitrary provider URLs are not requested. The response retains bounded titles, authorship metadata, timestamps, counts and enumerated signals, not raw provider responses or internal node identities. Identity drift, inconsistent samples, malformed values, oversized responses, timeouts and unknown statuses stay incomplete.

Work and [Releases](releases.md) share the existing credential-hash budget of ten uncached contextual collections per minute across repositories, sources and workspaces. Their caches are separate per enrolled pair, while live authority checks, revision/credential pins, read leases and provider cooldowns use shared machinery. A failed or interrupted attempt cannot bypass its original read window. Removing enrollment cascades the derived caches, not provider data or the journal.

Work responses are capped at 64 KiB. The transport retains its existing response-body and deadline bounds. Cache and budget operations consume D1 work, and parsing/serialization consume Worker CPU. Read-only does not mean free. These caps are not measurements of Free-plan compatibility or an account-wide spending ceiling; see [diagnostics and Free-plan compatibility](diagnostics.md#cloudflare-free-plan-compatibility).

## Provider contracts and recovery

The fixed queries follow GitHub's [pull-request](https://docs.github.com/en/graphql/reference/pulls), [issue](https://docs.github.com/en/graphql/reference/issues) and [commit/check-rollup](https://docs.github.com/en/graphql/reference/commits) contracts. [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api) apply independently of the application's cache limits.

The work cache is derived evidence, not a secret store, provider configuration or operation receipt. Restore workspace authority, enrollment, migrations and independently held credentials together. Compatible older code may ignore the additive cache table; do not restore an old whole database to undo a Work UI change. See the [release recovery procedure](release.md#pull-request-and-issue-context).
