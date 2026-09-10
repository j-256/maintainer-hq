---
title: Releases and deployments
description: Inspect published versions, deployment records and changes since a release without confusing them with live health.
---

# Releases and deployments

Open a repository's **Releases** section to see its latest published stable release, the comparison with its default branch, and a bounded sample of GitHub deployment records. A project's **Releases** section uses the same view: choose one of its explicitly linked repositories. Only the selected repository is read. Neither project membership nor a similar name invents a provider deployment relationship.

## Read the evidence

**Latest published release** identifies GitHub's selected latest release, its publication time and the resolved tag commit. Follow **Open release** for its notes and assets. Drafts and prereleases are excluded; a provider response that cannot establish a published stable release is not accepted as one. A published version is not proof of the version serving traffic.

**Changes since release** compares the observed release commit with the observed default-branch commit. The links use immutable SHAs, not a moving branch or tag. Ahead, behind, identical and diverged histories remain distinct. A commit ahead of the release may already have been deployed through another workflow. Missing releases, deleted tag commits, unavailable default branches and denied comparisons cannot establish that work is waiting to ship.

**GitHub deployment records** shows the newest five records ordered by creation time, with each record's latest provider status, commit, environment and timestamps. Failed and error states remain visible. An empty successful read means GitHub returned no deployment records, not that no deployment exists. A missing status is not success. When more records exist, the displayed sample explicitly excludes older deployments and failures. GitHub may require sign-in or repository access to open its deployment-history interface. Follow a commit link for the exact code recorded by the deployment.

Deployment status is a provider record, not a live health check. Cloudflare runtime versions are not inferred from GitHub repository names, release tags, Hookrelay subscriptions or project membership. Monitoring evidence and explicitly enrolled provider resources retain their separate meaning.

## Access, freshness and recovery

The view reuses the selected enrolled GitHub source's read-only credential. Workspace viewers can inspect it without provider-operation or repository-administration permission. Repository access, Contents read permission and, where required by GitHub, Deployments read permission remain separate provider requirements. A denied read reports the gap without guessing which grant or feature is missing. Public metadata can be readable even when a private repository needs an additional grant. HQ never substitutes the machine's broad GitHub credential.

Release and deployment reads preserve independent permission coverage. A denied deployment read does not hide a valid release or commit comparison. **Observed** identifies the start of the accepted bounded collection, not a page-view time or a runtime heartbeat. Reading a cached result preserves that timestamp. Stale results, another window collecting, provider cooldown, disabled sources, missing configuration and read failures are shown explicitly. Review the GitHub connection for access and configuration gaps; use **Refresh evidence** after the displayed read window permits it.

The server shares a five-minute cache and a durable read lease for each enrolled repository/source pair. Concurrent windows reuse an accepted result or wait for the in-flight read. An interrupted attempt cannot bypass its read budget; after its bounded window, a later read can recover it. Source/repository revisions, credential identity and live workspace authority are checked across collection and return. Changed or revoked access does not revive an earlier result. Removing a source's repository enrollment removes its derived cache.

Accepted cache changes use the existing source-update notification path. Only mounted release queries react to relevant changes, and the shared coordinator coalesces recovery reads. Activity, hooks, monitoring and other repository sections do not keep the release query mounted. No new polling loop, Cron collection, provider write or fleet-wide release scan is introduced. A local display clock updates stale labels without HTTP requests.

## Shared command and resource limits

Browser, CLI and MCP use the same read-only `repository_releases` command. Supply exactly `workspaceId`, `repositoryId` and `sourceId` for an enrolled GitHub pair. Arbitrary provider URLs, GraphQL documents, repository names, credential values and operation instructions are not accepted. The response contains minimized evidence, source/repository revisions and the next permitted read time.

Each uncached collection uses one fixed GraphQL query and, only when two different immutable commits can be resolved, one REST comparison request. Each provider response retains the existing bounded body size and request deadline; comparison file patches, release bodies, commit messages, target/log URLs and provider payloads are discarded rather than stored, logged or returned. A malformed identity, inconsistent sample or comparison, unknown status, oversized response or interrupted read remains incomplete evidence.

The server also limits uncached contextual reads to ten per minute per credential hash across repositories, sources and workspaces using that same credential. Cache hits do not spend this provider-read budget. Provider cooldowns are shared with ordinary GitHub collection. GitHub's GraphQL and REST primary allowances are independent, while other rate limits can be shared. These bounds reduce repeated work; they do not guarantee an account-wide quota or spending ceiling, and other applications can consume the same provider allowance. See [diagnostics and Free-plan compatibility](diagnostics.md#cloudflare-free-plan-compatibility).

Release caches and read budgets are derived metadata, not provider configuration or operation receipts. Recovery must preserve workspace identity, memberships, enrollment, credentials and the operation journal. Use compatible code and all migrations when restoring; SQL backup alone does not recover the GitHub credential. Cache state can age out through the bounded read workflow without resetting provider configuration.

## Provider contracts

The fixed query follows GitHub's [repository](https://docs.github.com/en/graphql/reference/repos), [release](https://docs.github.com/en/graphql/reference/releases) and [deployment](https://docs.github.com/en/graphql/reference/deployments) schemas. Immutable comparisons use the [commit comparison API](https://docs.github.com/en/rest/commits/commits#compare-two-commits). Read the separate [GraphQL rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api) and [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) before increasing contextual or scheduled collection bounds.
