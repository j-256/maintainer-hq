---
title: Commands and MCP
description: Find the shared command contract and choose safe browser, CLI, or MCP authentication.
---

# Commands and MCP

The browser, CLI, HTTP API, and MCP adapters call the same workspace-scoped service. They share validation, permissions, revisions, review fingerprints, and recovery semantics. There is no arbitrary remote shell, SQL endpoint, or caller-selected provider URL.

## GitHub App operations

The `github_apps_list`, `github_app_registration_*`, `github_app_manifest_*`, `github_app_installations_list`, `github_app_repositories_list`, `github_app_connection_*` and `github_app_grant_*` command families expose bounded metadata through the shared API, CLI and MCP. Use schema discovery for the exact command and inputs. Deployment setup requires a verified human setup permit plus live administrative workspace ownership; a workspace owner accepts its own offered grant independently. Automation credentials cannot become deployment setup operators.

Private signing material uses the dedicated browser file input, CLI `github-app-input` command or local stdio MCP private-file adapter. It never belongs in an ordinary command or MCP argument. See [registration, protected import and recovery](github-apps.md) before submitting private input. Saved metadata review links reopen the same review and never reapply it automatically. Use `github_app_connection_request_finish` to explicitly link an accepted grant or cancel a pending access request, and use the request list's cursor to page pending work or retained history.

## Discover exact inputs

From the repository with locked dependencies installed:

```bash
npm run cli -- list
npm run cli -- schema project_get
npm run cli -- schema activity_add
```

Discovery works without a running dashboard. The schema command is authoritative for exact names, required fields, bounds, and enums. These guides explain workflows rather than duplicating evolving JSON schemas.

| Task | Contract guide |
| --- | --- |
| Actionable attention and bounded operational previews | [Overview](overview.md) |
| Projects and resource context | [Projects](projects.md) |
| Reviewed project suggestions, grouping and priorities | [Organize repositories](projects.md#organize-repositories-together) |
| Move a project between workspaces | [Transfers](project-transfers.md) |
| Repository metadata and related resources | [Repositories](repositories.md) |
| Check and retain evidence for a repository's linked operational resources | [Operational coverage](repositories.md#shared-commands-and-bounds), `repository_coverage` |
| Read retained operational coverage and progress without contacting providers | [Saved operational coverage](repositories.md#shared-commands-and-bounds), `repository_coverage_get` |
| Discover repositories and reconcile reviewed enrollment changes | [Fleet enrollment](fleet-enrollment.md) |
| Reviewed expectation presets, exceptions and bulk changes | [Bulk expectations](repositories.md#set-expectations-across-repositories) |
| Expectation resolution and recorded review outcomes | [Resolve an expectation](repositories.md#resolve-an-expectation) |
| Goal and progress reports | [Activity](activity.md) |
| Saved repository coverage and latest collection results | [GitHub coverage](github.md) |
| Read-only GitHub collection | [GitHub evidence](github-evidence.md) |
| Inspect configured collection and repository-write credential coverage without credential values or provider calls | [Credential coverage](dependencies.md#inspect-repository-credential-coverage), `repository_credential_coverage` |
| Compare and edit Dependabot schedules through reviewed repository PRs | [Dependabot schedules](dependencies.md#dependabot-schedules) |
| Override lifecycle, PR-head inspections, reviewed maintenance PRs and recovery | [Dependency maintenance](dependencies.md) |
| Local observations | [Publishing](publishing.md) |
| Invites, roles, and first-owner setup | [Access](access.md) |
| Hookrelay, Endpoint Monitor, and secret operations | [Hooks](hooks.md), [Monitoring](monitoring.md), [Secrets](secrets.md) |
| Create a manual receiver and privately hand credentials to an external administrator | [GitHub webhook handoff](github-handoff.md), `hooks_handoff_*`; local file adapters `hooks_handoff_adopt_file` and `hooks_handoff_export_file` |

## Call one command

Prepare a JSON file matching the inspected schema. For example, `project_get` requires `workspaceId` and `projectId`. Use the real identifiers from your authorized workspace, not names or guessed IDs.

```bash
npm run cli -- call project_get --input request.json
```

Use `--input -` to read command metadata from stdin. Secret values are not ordinary command inputs. [Secrets](secrets.md) documents its dedicated private-input boundary.

Configure `HQ_URL` and one deliberate credential mode through protected environment configuration:

- Unattended clients use an enrolled `HQ_TOKEN` and the paired Access ingress credentials `HQ_ACCESS_CLIENT_ID` and `HQ_ACCESS_CLIENT_SECRET`
- A human session uses short-lived `HQ_ACCESS_TOKEN` instead; clear the automation variables before changing modes
- Isolated local development uses an explicit loopback URL and `--dev`, which suppresses real credentials

The client rejects mixed modes, insecure remote transport, and credential-bearing redirects. The Access service pair admits a request at the edge; the HQ token still needs the exact workspace scope. See [automation access](automation.md).

## MCP transports

The hosted MCP endpoint is `/mcp` on your protected application origin. A stdio adapter is available from the checkout. Invoke the executable directly so package-manager banners do not enter the protocol:

```bash
npx tsx cli/mcp.ts
```

For the isolated development server:

```bash
npx tsx cli/mcp.ts --url http://127.0.0.1:5178 --dev
```

Tool discovery exposes the shared bounded commands and their input schemas. A tool's presence is not permission to execute it. Reader, Reporter, and publisher credentials remain intentionally narrow. Hosted MCP cannot read your local files or environment; the trusted local Secrets input helper has a separately constrained interface.

## Retries and reviews

Retain the original ID and exact content after an ambiguous submission. Do not generate a new review, report, or refresh ID just to retry the same operation. A changed input needs a new intentional operation. Consequential actions require a matching actor, authority, revisions, fingerprint, and unexpired review. Inspect existing receipts before requesting recovery or replay.
