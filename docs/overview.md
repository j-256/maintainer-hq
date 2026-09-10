---
title: Read the fleet overview
description: Separate actionable problems, missing evidence, stale sources, and overdue reviews.
---

# Read the fleet overview

Overview opens when you visit the application root or choose the HQ logo. It is the daily starting point for deciding what deserves attention. Choose Problems, Reviews or Coverage gaps, then search by project, repository, connection or reason. The list is paginated and filters stay in the URL. A saved repository record is not a healthy repository by itself. Activity remains available through its navigation item and direct links.

## Read status with its evidence

Problems include positively observed default-branch CI failures, open security findings, visibility mismatches, exhausted hook deliveries, unresolved Hookrelay signals, open monitoring incidents and fresh configuration-matching check or run failures. Each item explains the reason and links to its evidence or the relevant next action. CI failures link to the observed commit's checks when its identity is available. Optional or unmanaged expectations do not hide observed failures.

Coverage gaps are separate: disabled or unconfigured connections, unread checks, stale or future-dated evidence, missing required outcomes, unsuccessful provider reads and bounded preview limits. A passing result from one source cannot fill a missing category from another. Stale operational results retain their reason with a Last known label; they are not fresh incidents or successes. An empty Problems list is not an all-clear.

Required hook and monitoring rules use retained evidence from explicitly linked resources. An unmet rule links to **Operational checks** in the repository overview, where you can inspect evidence, set up missing resources or open their actual management controls. The fleet view reuses accepted observations; it does not fan out provider reads across every repository. Saving an assessment rule does not configure a provider.

The combined list puts problems before reviews and coverage, then orders by severity, project Importance and stable context. Critical severity is an observed problem's priority; project Importance is the maintainer's separate decision about visibility and impact. Counts cover the active workspace's repository evidence and selected operational previews, before search filtering. The displayed range reflects the selected category and search.

Reviews include overdue repository expectations and project-owned Portfolio decisions. A project's Portfolio review appears once, including when the project has no repositories. An overdue review is not a provider incident. Setting Portfolio to Listed does not publish a page or verify that a listing exists.

## Follow the relevant resource

Projects collect repositories and explicitly related operational resources. Repository details provide the same relevant Hooks, Monitoring, Secrets, and Activity navigation. A monitor can prove something about its target only when its check evidence is sufficiently fresh and configuration-bound. No incidents alone is not positive health evidence.

Provider resources discovered before enrollment remain provider-owned and unassociated. Enrolling a target requires a primary project, while explicit repository links can add cross-project relevance. Neither kind of link is a successful probe, and a connection's descriptive project label does not associate every provider resource automatically.

The Operational previews panel reads at most two Hooks or Monitoring connections at a time. Expand it to see the selected connections, read times, retry controls and connection pagination. Other connection pages are excluded from the displayed attention counts. Hookrelay uses its bounded signal/delivery sample and first exhausted-delivery page; Monitoring uses its run snapshot, first target page and first open-incident page. A limited preview links to the provider workspace for further paging. Repeated Hookrelay signal records are grouped by code, without claiming they represent distinct events or identifying an affected repository.

## Refresh and live updates

The dashboard receives scoped changed records for the active app view. Repository and project inventories do not need unrelated Activity updates. Initial loads, reconnect gaps, and changed authority can require bounded recovery reads. A live connection indicator describes the HQ transport, not GitHub or endpoint health.

Independent provider state still needs collection or a provider refresh. Refreshing the dashboard is not the same as running a GitHub collection or asking Endpoint Monitor to probe a target. Inspect the source or operation receipt to establish what actually ran. See [live updates](push.md) and [troubleshooting](troubleshooting.md).

Overview reads operational previews on opening, relevant HQ changes or an explicit Refresh operations. GitHub progress and unrelated Activity do not refetch those previews. There is no timed HTTP polling loop: a local clock marks the preview as needing refresh after a minute. A failed read is a coverage problem, not proof that the provider's resources failed. Retry it without losing the search or category. Lost authority or a changed connection discards obsolete preview data.

## CLI and MCP

`workspace_attention` returns the same paginated repository evidence and reviews, with category and search filters. It makes no provider calls and explicitly reports that operational evidence is excluded. `attention_connection` reads one exact operational connection using its ID and revision, returning the same safe attention items and explicit project/repository links. Both commands require workspace read authority and enforce response bounds; neither grants provider administration or accepts an arbitrary provider URL. Inspect their schemas through [Commands and MCP](commands.md).
