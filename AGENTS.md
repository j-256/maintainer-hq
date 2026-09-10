# Maintainer HQ guidance

Maintainer HQ is an online-first, workspace-scoped operator application. Browser, CLI, and MCP clients share the same domain service, authorization, validation, and action semantics. Local development runs that application with an explicitly isolated identity adapter, not a second product.

## Safety and ownership

- Authorize every read and write against the authenticated principal and explicit workspace membership
- Keep application metadata separate from provider-owned configuration and source-owned observations
- Local publishers may submit bounded observations for their enrolled source only; they cannot edit expectations or execute operations
- Keep secret values, bearer routes, raw provider payloads, and credentials out of routine responses, logs, fixtures, screenshots, and public artifacts
- Accept secret material only through a dedicated privileged input boundary; never use command arguments for values
- Bind consequential actions to the actor, workspace, exact inputs, relevant revisions, and an expiring reviewed plan
- Persist operation intent before external effects and preserve partial or indeterminate outcomes for reconciliation
- Never trust a request header as a development identity in the production entrypoint
- Production deployment, provider mutation, credential grants, and pushes retain explicit approval boundaries

## Product quality

Use structured forms with normal Save/Cancel behavior for ordinary metadata. Explain missing permissions, unavailable integrations, stale information, validation failures, and conflicts in the UI. Never present mock or unobserved state as healthy production evidence.

Every operator capability requires bounded MCP parity in the same logical change. CLI and MCP call the shared application contract; neither exposes arbitrary commands, SQL, provider paths, or raw private documents.

Provider APIs belong to their own projects. Their CLI and web management paths must use the same configuration authority. Do not let deployment or a stale local file silently overwrite online edits.

## Verification

Use the repository's focused tests while developing and its complete check command before integration. Browser-visible changes require agent-browser verification at desktop and mobile sizes, keyboard navigation, and both themes. Exercise authorization, workspace isolation, freshness, concurrent edits, duplicate requests, failures, and recovery.

Source and comments use ASCII. Comments do not end in periods. Use Conventional Commits, preserve unrelated changes, and never push without an explicit request.
