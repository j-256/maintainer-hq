---
title: GitHub webhook handoff
description: Create a receiver for an external repository and privately hand credentials to its administrator.
---

# GitHub webhook handoff

Use **Hooks -> New GitHub hook** when a trusted third-party repository administrator will install the webhook. Choose a project, an exact `owner/repository` or HTTPS github.com repository URL, Activity/Stars/Security alerts, and existing destinations. An enrolled repository and local checkout are optional. Repository-context actions preselect the identity/project and can link accepted receivers to that saved repository.

**Review hook** saves the exact connection, repository, profile, destinations and authority revision. **Create hook** accepts that review once. HQ persists operation intent before configuring provider routing and reports incomplete associations as partial. The administrator still installs GitHub's webhook. The `handoff` URL parameter and Hooks operation history reopen safe receipts. After interruption, use **Reconcile saved operation** to read the original provider receipt without resubmitting Apply or replacing credentials.

Creation, adoption, reconciliation, reveal and export require live owner membership and `secrets:write`. Automation credentials need their live owner, workspace, read and secrets scopes. Only the original actor/credential can apply or reconcile. Authorized readers can inspect safe metadata. Provider grants and key provisioning remain separate deployment-owner actions.

## Private handoff

**Reveal URL and secret** loads one receiver's values into that panel. Copy the URL, secret or complete administrator instructions deliberately and share privately. Instructions include individual events, JSON content type, SSL verification, active-hook setting and GitHub settings URL. Activity selects push changes, workflow activity and opened/closed pull requests; Stars uses `star`; Security alerts uses code-scanning, Dependabot and secret-scanning alerts. Choose destinations appropriate to the payload sensitivity.

Profiles share one signing secret and have distinct reserved URLs. Adding profiles preserves established credentials. **Find existing hooks** reopens accepted manual profiles or explains the need for legacy adoption. Hide, close, navigation, identity/connection changes and reload clear revealed values. Private results stay out of generic commands, React Query, router state and persistent browser storage; HQ does not persist private input/output. Clipboard denial leaves values selectable for manual copying.

**Download private recovery** explicitly downloads one repository envelope. Browser downloads do not guarantee private permissions: move it into protected storage, set mode 0600 and import it with Hookrelay's adapter. The CLI exporter creates a new mode-0600 file and is preferable for automation. Provider custody is retained.

Routing, authenticated GitHub ping and notification delivery are separate observations over a bounded retained-event sample. Refresh after the administrator saves and pings the hook. A ping does not establish all upstream settings or prove Discord delivery; absent observations do not prove upstream absence.

## Adoption and recovery

Adopt existing ordinary environment-HMAC receivers through a trusted local adapter before adding profiles. Adoption preserves UUIDs, hashes, signing values, authentication and policy and leaves upstream hooks unchanged. Include every canonical legacy profile. Pending rotations/retirement, alternate keys, derived automatic authentication and already-bound records are unsupported. Keep the protected manifest; never paste it into a browser or generic command.

```sh
npm run cli -- schema hooks_handoff_plan
npm run cli -- hook-handoff-adopt --help
npm run cli -- hook-handoff-export --help
npm run cli -- hook-handoff-adopt -i <safe-selection.json> -m <private-fleet-manifest>
npm run cli -- hook-handoff-export -i <safe-export-selection.json> -o <new-private-export.json>
```

Adoption selection matches `hooks_handoff_plan`, including the existing first profile and destinations. Only its named active unbound record is read from an explicit regular non-symlink mode-0600 manifest and sent privately. Confirm the returned safe review with `hooks_handoff_apply`. Export selection contains `workspaceId`, `connectionId` and the provider credential's `repositoryId` UUID, distinct from an optional HQ repository ID. Existing export files are never overwritten.

Local MCP tools `hooks_handoff_adopt_file` and `hooks_handoff_export_file` use the same adapters and return safe metadata/path only. Hosted MCP cannot read/write client files. Raw values never belong in arguments or MCP inputs.

Hookrelay's `github:handoff:recovery inspect` and `import` merge the envelope into an explicit encrypted manifest and optional authoritative golden routes. Recovery is written first; identical reruns preserve credentials/bindings. Optional development HMAC mirroring applies to adopted environment profiles; wrapping-key restoration is separate. Manifest v5 adds safe provider identities without changing shared-HMAC semantics. Legacy writers reject/skip provider-managed entries; unrelated legacy records remain usable.

## Deployment and limits

Deploy compatible Hookrelay code and `0011_github_handoffs.sql`; apply all HQ migrations as usual. HQ uses existing review/operation tables. The selected provider credential needs `read` and `handoff`, plus `custody` for private adoption/retrieval/export. Hookrelay needs active D1 authority, existing HTTPS `HOOK_SETUP_ORIGIN` and protected `HOOK_HANDOFF_KEYS`. Manual setup does not require the automatic installer's token or derivation root. UI deployment does not provision these prerequisites.

Keep existing service bindings and public management protection. Private calls use a fixed provider path, dedicated headers, redirect rejection, bounded streams and complete deadlines. Browser auth is never forwarded. HQ applies same-origin protection, strict parsers, no-store, live owner rechecks and connection/provider identity checks. Correlated diagnostics omit values and raw provider errors.

Preserve provider backups and all wrapping keys referenced by accepted bundles. A changed active key affects new bundles; old keys remain necessary. Rewrapping, rotation and retirement require their owning migration workflow. Missing/corrupt custody produces typed ingress HTTP 503; invalid signatures remain HTTP 401. Never regenerate credentials to clear unexplained storage failure.

Handoff adds bounded management and authorized local review/association work, without scheduled GitHub collection or upstream installation. Combined CPU and billable rows are unmeasured on Free. Hookrelay's [manual handoff guide](https://github.com/j-256/hookrelay/blob/main/docs/github-handoff.md) records indexed-lookup and storage/traffic estimates with official limits verified on 2026-11-05. HQ's [existing Paid requirements and Free fallback](diagnostics.md#cloudflare-free-plan-compatibility) still apply; synthetic/Paid testing does not establish Free support.

For isolated review, set `HQ_HANDOFF_DEMO=true` in the development checkout's ignored `.dev.vars`, run `npm run dev:prepare`, then start development. Its synthetic connection uses the normal HQ service/owner checks without GitHub or Discord calls. Only the loopback development entrypoint imports it. Provider fixture state resets on restart. Never expose this environment publicly or use it for real custody.
