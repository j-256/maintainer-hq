---
title: Local development
description: Run the same HQ application with isolated identity, persistent local state, and synthetic verification.
---

# Local development

Use Node.js 22.18 or newer and the repository lockfile. Development runs the same application with an isolated loopback-only owner identity; it is not a different local product.

```bash
npm ci
npm run dev:prepare
npm run dev
```

Open `http://127.0.0.1:5178/activity`. The seed is idempotent and does not fabricate repository health. The development database and local journal persist under `.wrangler/state`; restarting the server does not clear them. Preserve that directory privately if it matters. Do not expose this server through a tunnel or bind it to a public interface.

The isolated development identity is not a security boundary for real provider authority. Use only synthetic or deliberately isolated test credentials. UI credential-storage tests can place a synthetic `PROVIDER_CREDENTIAL_KEYS` keyring in the ignored, owner-only `.dev.vars` file. Never install a real broad provider token or production decryption key there. Changing a provider token in the development database does not revoke it upstream.

## Verify changes

```bash
npm run check
npm run test:e2e
npm run test:release
```

Checks exercise the Workers/D1 runtime, authorization, revisions, exact retries, evidence assessment, reviewed operations, scoped push, and publication hygiene. Browser tests use synthetic workspaces and an isolated database on port 5179. Their reset must never target the development journal or a production database.

To test alongside an interactive preview, give the test run its own state directory and port. `HQ_E2E_STATE` selects both Wrangler's synthetic database state and the E2E Vite cache; it has no effect on production builds or normal development mode. Do not reuse an active preview's state directory. Run one browser test process per state directory and output directory.

```bash
HQ_E2E_STATE=.wrangler/e2e-check HQ_E2E_PORT=5183 npm run test:e2e
```

Install a compatible test browser with `npx playwright install chromium`, or select an existing executable through `HQ_BROWSER_EXECUTABLE`. The same browser configuration supports the packaged production-runtime tests. Tests against synthetic provider responses do not verify live credentials or upstream permissions.

## Build documentation

```bash
npm --prefix site ci
npm run docs:check
npm run docs:dev
```

The static docs site has its own locked build dependencies. It reads the Markdown guides directly and uses local search. It has no HQ database or provider credentials. [Documentation maintenance](documentation.md) describes content, link, browser, and deployment checks.

## Production is a reviewed deployment

The checked-in development and placeholder hosting configuration is not a production identity configuration. Use the [offline release workflow](release.md) and [hosting gates](hosting.md) to build and inspect a concrete protected deployment. The production entrypoint excludes the development owner adapter.

Preserve database, binding, identity, credential, and provider recovery separately. A code rollback is not a database restore and cannot undo a provider operation. Development setup never provisions live provider authority.
