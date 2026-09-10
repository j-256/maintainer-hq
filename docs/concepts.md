---
title: How HQ is organized
description: Distinguish workspace access, project identity, repository evidence, and provider-owned resources.
---

# How HQ is organized

A workspace is the shared membership, access, and integration boundary around a collection of projects. A project is the product, service, tool, or effort you maintain. Every HQ repository belongs to exactly one project, but a project can contain no repositories, one repository, or several. A repository remains a distinct source-code identity belonging to a provider; neither record is an alias for the other.

```text
Workspace: membership, access, connections, and credentials
  Project: durable maintained effort
    Repositories: required ownership, code identities, and expectations
    Hooks: primary ownership of enrolled subscriptions
    Monitoring: primary ownership of enrolled targets
    Secrets: primary ownership of enrolled provider resources
    Activity: immutable attribution and work reports
```

This containment is a data invariant, not only a navigation model. Repository creation, fleet enrollment, and metadata import require an owning project. Saving an enrolled Hookrelay subscription, monitoring target, or Secrets resource also requires one primary project. Explicit repository links can make an operational resource relevant to additional projects without changing that primary ownership. Shared resources retain one provider configuration and operation history.

The workspace remains more than a visual folder only where sharing requires it: membership, invitations, provider connections, credentials, authorization, and workspace audit concerns cross project boundaries. A provider catalog can expose a resource before HQ enrolls it into a project. That discovery state is not a projectless maintained resource.

## What each decision means

| Decision | What it controls | What it does not prove or change |
| --- | --- | --- |
| Workspace membership | Access to HQ data and permitted operations | Provider credentials or provider roles |
| Project ownership | Containment of repositories and enrolled operational resources | GitHub ownership or deployment location |
| Importance | Maintainer priority: Standard, High, or Critical | Incident severity or observed health |
| Portfolio inclusion | Undecided, Planned, Listed, or Excluded visibility decision | Publication of a portfolio page |
| Repository tracking | Maintained or watchlist intent | GitHub administration permission |
| Expectations | Evidence and review requirements | Actual CI, scanning, or endpoint results |
| Connection enrollment | Approved provider resources and HQ scope | New upstream authority |

Assessment and organization controls take effect inside HQ. A repository review date appears in Overview when due; it is not an outbound reminder. Changing project lifecycle or disabling an HQ connection does not stop a provider's service. Use the specific [Monitoring](monitoring.md), [Hooks](hooks.md) or [Secrets](secrets.md) operation and inspect its exact review and receipt for a provider change. Unavailable operation controls name the missing capability instead of accepting an intent-only substitute. Portfolio publication and reusable secret-value storage are not provided by their metadata or inventory screens.

## Connections own provider access

A connection belongs to a workspace and refers to independently provisioned provider authority that several projects can share. It can expose resources without pretending those resources are GitHub repositories. A connection's optional descriptive project context is only a hint; each enrolled target still receives an explicit primary project.

GitHub webhooks are repository-scoped GitHub configuration. Hookrelay subscriptions are a different authority and can receive events unrelated to GitHub. Likewise, endpoint health describes a target, not every aspect of a repository's quality.

Following a shared resource from a project does not narrow the effect of its provider operation. Review the full target and shared-impact information before confirming.

## Moving is different from regrouping

Assigning a repository to another project inside its workspace is an ordinary metadata edit. [Moving a project between workspaces](project-transfers.md) changes access and requires Owner membership in both. The exact review accounts for source enrollment, dependencies, history, and credentials. Unsupported provider dependencies block the move before any partial transfer.

## Local and hosted are the same product

The hosted application runs defined, authorized operations against HQ state or supported provider APIs. It does not run a remote shell on your machine. Local development uses the same application with an isolated loopback identity. Local publishers contribute checkout observations; when they are offline, those observations become stale rather than preventing you from opening the dashboard.
