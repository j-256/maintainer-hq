---
title: Documentation maintenance
description: Keep task guides, source contracts, static search, and safe publication in sync with the product.
---

# Documentation maintenance

The Markdown files under `docs/` are the canonical authored guides. The static site reads them directly; the README is an entry point, not a second copy of the product manual. Update task instructions and capability claims with the feature they describe, including recovery and resource costs.

## Build and preview

From a checkout with application dependencies installed:

```bash
npm --prefix site ci
npm run docs:check
npm run docs:test:browser
npm run docs:dev
```

The site has a separate lockfile for its build-time Astro, Starlight, and font dependencies. Use the production output for search and deployment checks: development preview is not evidence that the generated search index or production security policy works.

## Add or revise a guide

Keep a meaningful `title` and `description` in Markdown frontmatter. Include a first-level heading for source readers; the site removes that duplicate at render time. Use ordinary relative Markdown links such as `projects.md#recovery`, which the renderer maps to published routes. The generated link check must resolve both the page and fragment. The synthetic metadata import example is explicitly published; other repository files are not automatically copied into the site.

Place the page in the appropriate sidebar group in `site/astro.config.mjs`. Lead with the operator's task, prerequisites, and expected outcome; place command and recovery details below that. Distinguish an implemented adapter from a configured connection and a requested feature. Never describe a planned provider write or reusable vault as available.

Use one paragraph per source line, plain punctuation, meaningful link labels, and the shared readable type scale. Check wide tables, code, keyboard focus, mobile menus, search results, both themes, empty results, and the 404 page. Public search must never query the application's protected state.

## Public deployment boundary

The canonical docs hostname is `docs.hq.lasers.app`; `hq.lasers.app` temporarily redirects to it with HTTP 307 while retaining path and query. The operational dashboard remains independently protected at `repos.j-256.dev`. The related implementation's documentation is a different deployment and must not be overwritten.

`site/wrangler.jsonc` packages static assets only for the `hq-docs` deployment and its exact docs Custom Domain. It declares no executable Worker, provider or database binding, cron schedule, runtime credential, public command endpoint, workers.dev ingress, or preview URL. Hostname attachment and the product redirect require exact live ownership checks and the deployment operator's approved routing workflow. A build or ordinary upload does not authorize replacing an existing origin.

For an authorized publication, install the locked site dependencies, run both verification commands above, inspect the generated `site/dist` inventory, and preserve the previous artifact. After checking that the deployment and hostname still have their expected owners, run `npx wrangler deploy --config site/wrangler.jsonc` from the checkout. This command can attach the declared Custom Domain; it does not configure the product redirect or zone injection policy. Keep those exact-host rules in the deployment's routing inventory and verify them separately. Do not apply a broad zone-wide analytics or redirect change for this site.

Inspect the artifact and browser policy before publication. The build checks the final rendered scripts, replaces the page-specific script hashes, and puts the policy before executable content. This covers documentation helpers that are not registered in Astro's initial hash list. WebAssembly is allowed for local search without enabling JavaScript string evaluation. The edge headers add framing, referrer, and content-type protections. Do not inject third-party analytics or fonts. Verify the actual host's certificate, redirects, headers, search, links, and 404 behavior after deployment. Preserve the previous static artifact and exact routing state for corrective rollback; docs recovery does not involve application data.

## Free-plan posture

This surface is static documentation, independent of HQ's scheduled collection and D1 costs. Cloudflare documents ordinary static asset requests as free and unlimited; serving the guides and local search needs no application CPU or database calls. Worker caching or adding executable middleware can change billing, so do not carry that claim into a modified deployment without rechecking [static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

Keep the generated site within Free's static-file and per-file limits and check its artifact inventory during verification. A Paid account is not permission to omit that check. Search traffic downloads static index fragments; it is not a per-search HQ API invocation. The application has independently documented [Free-plan exceedances](diagnostics.md#cloudflare-free-plan-compatibility).

## Keep private context private

Never include credentials, signed URLs, real repository inventories, screenshots of private workspace content, raw provider bodies, deployment exports, machine paths, or operator recovery notes in public content or build output. Source metadata and environment names in an integration contract are not credential values. Use synthetic examples and audit the generated files, not just the Markdown.
