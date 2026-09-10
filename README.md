# Maintainer HQ

An online workspace for the projects you maintain: repositories, fleet evidence, hooks, monitoring, managed provider configuration, supplied-value secret operations, and accountable Activity.

A workspace is the shared access and integration boundary around its projects. Every repository and enrolled operational resource belongs to a project, while provider connections and credentials stay workspace-scoped so several projects can share them without duplicating provider configuration. Browser, CLI, and MCP share one authorized service. Local machines send observations outward; they are not required to serve the dashboard.

## Availability

Maintainer HQ is self-hosted software. The maintainer-operated deployment is private and is not a public hosted service. Run your own installation using the [development](docs/development.md), [secure hosting](docs/hosting.md), and [offline release](docs/release.md) guides. Production setup is deliberately review-driven because it establishes identity, provider authority, storage, and recovery boundaries.

## Documentation

Read the [Maintainer HQ guide](https://docs.hq.lasers.app), or browse the same Markdown in this checkout:

- [Getting started](docs/getting-started.md) and [how HQ is organized](docs/concepts.md)
- [Projects](docs/projects.md), [repositories](docs/repositories.md), and [reviewed workspace transfers](docs/project-transfers.md)
- [Activity and exact goals](docs/activity.md), [date/time preferences](docs/preferences.md), and [live updates](docs/push.md)
- [Integration availability](docs/integrations.md), [Hooks](docs/hooks.md), [Monitoring](docs/monitoring.md), and [Secrets](docs/secrets.md)
- [Connect GitHub](docs/github.md) and inspect per-repository refresh results
- [Dependency maintenance](docs/dependencies.md), temporary-override lifecycle checks, and reviewed cleanup or renewal PRs
- [CLI and MCP](docs/commands.md), [automation credentials](docs/automation.md), and [local publishing](docs/publishing.md)
- [Troubleshooting](docs/troubleshooting.md), [diagnostics and Free-plan costs](docs/diagnostics.md), and [secure hosting](docs/hosting.md)

GitHub Actions and Cloudflare Workers configuration support UI-managed provider access, secret-name inventory, readable provider-declared non-secret variables, reviewed supplied-secret distribution, and separately reviewed source removal. GitHub includes repository, environment, and repository-effective organization scopes; Cloudflare distinguishes `secret_text`, `plain_text`, and `json` bindings. HQ can own explicit presence definitions for GitHub repository or environment secret names without taking custody of their values, and can retain, compare, and reconcile desired values for non-secret GitHub variables through exact reviewed writes. Other observed entries remain provider-owned. GitHub secret input is client-sealed, while Cloudflare secret input passes transiently through HQ during an explicitly confirmed Worker deployment. A general-purpose reusable vault remains a separate custody design. An installed adapter still needs deliberately provisioned provider authority. The availability guide distinguishes these boundaries without promising configured integrations.

## Develop

Use Node.js 22.18 or newer:

```bash
npm ci
npm run dev:prepare
npm run dev
```

Open `http://127.0.0.1:5178/activity`. Development has an isolated loopback-only identity and persistent local state under `.wrangler/state`. Do not expose it publicly or discard its journal unintentionally. See [local development](docs/development.md) for browser setup and isolated test storage.

```bash
npm run check
npm run test:e2e
npm run test:release
```

Production requires a reviewed [release artifact](docs/release.md), protected identity, storage, and deployment verification. Synthetic tests are not proof of live provider permissions or health.

## Maintain the docs

```bash
npm --prefix site ci
npm run docs:check
npm run docs:test:browser
npm run docs:dev
```

The static site reads the guides under `docs/` directly. Search stays local to that site. Keep task instructions, implemented capability claims, and recovery documentation in the same logical change as the feature. See [documentation maintenance](docs/documentation.md).

## Design contract

Keep provider engines independent and give each kind of configuration one authority. Separate expectations from observed evidence. Use structured Save/Cancel for metadata and expiring exact reviews with recoverable receipts for consequential operations. Preserve workspace isolation, explicit provider scope, honest freshness, and bounded CLI/MCP parity.

Related implementations are references for selective reuse, not compatibility requirements. This project is licensed under [AGPL-3.0-only](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change and [SECURITY.md](SECURITY.md) to report a vulnerability privately.
