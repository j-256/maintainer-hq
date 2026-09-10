# Contributing to Maintainer HQ

Maintainer HQ is an opinionated, self-hosted operator application. Bug reports, focused improvements, and documentation corrections are welcome. Discuss architectural changes, new provider authority, new credential custody, or broadened deployment behavior in an issue before investing in an implementation.

Do not report vulnerabilities or include credentials, private repository data, production identifiers, database exports, or raw provider responses in an issue or pull request. Follow [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Development

Use Node.js 22.18 or newer and the committed lockfiles:

```sh
npm ci
npm --prefix site ci
npm run dev:prepare
npm run dev
```

Development uses a loopback-only identity and synthetic local state. Do not expose it through a tunnel or install broad production credentials. See [local development](docs/development.md) for isolated state and browser-test guidance.

## Verification

Run the checks relevant to your change while developing. Before requesting review, run the complete application, release, and documentation checks:

```sh
npm run check
npm run test:e2e
npm run test:release
npm run docs:check
npm run docs:test:browser
```

Browser-visible changes must cover desktop and mobile layouts, keyboard navigation, and both themes. Server-side and background changes need structured diagnostics that make representative failures and partial outcomes actionable without exposing secret or private data.

## Pull requests

- Keep each change focused and include its tests and durable documentation
- Preserve authorization, workspace isolation, revision checks, and recovery behavior
- Use synthetic fixtures and redact screenshots or logs
- Explain user-visible behavior, security boundaries, migration needs, and verification evidence
- Use Conventional Commit subjects

By submitting a contribution, you agree that it may be distributed under the repository's [AGPL-3.0-only license](LICENSE).
