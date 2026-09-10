---
title: Hosting and security gate
description: Prepare a protected online deployment with explicit identity and recovery.
---

# Hosting and security gate

Maintainer HQ is designed to run online without an operator's computer. The production application owns its database and scheduled GitHub collection; local machines only send observations and agent updates. Development runs the same application with a separate loopback-only identity adapter. This document defines the preparation and acceptance gates for a hosted deployment, not permission to deploy.

The application foundation, read-only GitHub workflow, verified identity resolver, deliberate first-owner setup, membership controls, fixed-profile automation credentials, shared machine Access transport, portable release artifacts, and reviewed one-time metadata import are implemented. The [import and recovery contract](import.md) separates metadata onboarding from complete private database restoration. A selected production import and an approved protected deployment rehearsal remain release prerequisites. The [Hooks integration](hooks.md) adds scoped provider metadata and reviewed retry operations with private service bindings. [Monitoring](monitoring.md) adds Endpoint Monitor configuration, bounded run/check evidence, incident triage, and reviewed recovery through its own private binding. [Repository workspaces](repositories.md) connect shared resources without taking ownership of their provider state. The [Secrets workspace](secrets.md) adds provider-neutral inventory and separately reviewed supplied-value operations with a dedicated input boundary. Provider integrations do not have to be provisioned before the Activity and repository workflows can be dogfooded online.

## What needs protection

| Resource or action | Authority | Boundary |
| --- | --- | --- |
| Application shell | Deployment and Access policy | Require the intended sign-in policy on every exposed hostname and preview |
| Inventory, observations, expectations, goals, and Activity | Workspace membership | Authenticated reads; no implicit membership from sign-in |
| Ordinary metadata edits | Owner or operator and credential scope | Structured edits, revision checks, bounded input, actor-attributed journal |
| Source configuration and credential grants | Workspace owner | Exact source/repository scope, expiry, revocation, privileged one-time value delivery |
| Local observations | Enrolled publisher credential | One workspace and source, approved repositories, real observation time; no reads or operator writes |
| GitHub collection | Enabled owner-configured source | Server-held read-only credential, fixed provider endpoints, durable bounded jobs |
| Hookrelay management | Workspace role and scoped provider credential | Private reviewed binding, bounded metadata, exact retry plans, durable intent and receipt reconciliation |
| Endpoint Monitor management | Workspace role and scoped provider credential | Private reviewed binding, configuration-bound evidence, exact configuration/triage plans, durable intent and receipt reconciliation |
| Goal and progress reporting | Explicitly enrolled automation identity | Verbatim goal text and attributed reports; no provider execution or secret access |
| Secret distribution and scope changes | Separately reviewed secret operation | Dedicated value-input boundary, exact destinations, verification limits, no values in ordinary state or logs |
| Provider authentication credentials | Workspace Owner and exact reviewed scope | Dedicated private input, authenticated ciphertext in private D1, independent deployment keyring, revision-bound rotation and local retirement |

There is no remote-shell capability. An authenticated hosted operation means running a defined application function against its owned state or an explicitly supported provider API. It does not mean executing commands on the operator's machine. Cloud-backed observations continue independently; offline local publishers simply become stale.

Repository names, operational notes, and security findings can be sensitive even though they are not credentials. Keep them behind membership checks and out of static assets, telemetry payloads, and public examples. Treat D1 backups as private operator data, including encrypted UI-managed provider credentials. Keep raw provider tokens, machine token values, and the independently recoverable deployment keyring out of public artifacts and ordinary application state. The [provider credential custody contract](secrets.md#encrypted-provider-credential-custody) describes setup, rotation, retirement, and restore hazards.

## Ingress and identity

Use Access for browser sign-in and an application-level workspace membership check for authorization. The production resolver verifies the Access assertion's signature, issuer, audience, and subject. An email display name is not a role assignment. An Access-authenticated person without an enrolled membership can identify their own session but cannot read a workspace.

Prefer protecting the candidate Worker before exposing it, preserving the intended policies through the hostname handoff. Protection of an old Worker does not automatically protect a different Worker that inherits its hostname. Cloudflare supports both Worker-level and hostname-based Access; inspect the actual policy destination rather than inferring it from a domain name. Keep alternate ingress disabled unless its protected rehearsal use has been explicitly approved. See [Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

The application uses the signed `Cf-Access-Jwt-Assertion` contract, not an assumed `ctx.access` value. Cloudflare documents that the Static Assets router does not propagate `ctx.access` to the user Worker. Fixture tests and a protected deployed smoke test must exercise the real assertion path before sign-in is considered verified.

### Machine clients

The recommended initial Access deployment uses a dedicated Service Auth credential to pass the outer ingress policy, plus a separate HQ bearer credential to authorize the exact workspace actions. These are different authorities: the Access credential must not grant an HQ role, and the HQ credential does not bypass Access. An Access service identity alone has no human subject and must not become an implicit owner.

Use the separate `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers for ingress; reserve `Authorization: Bearer ...` for the HQ token. Read values from protected client configuration, never ordinary command arguments, URLs, source files, or browser storage. The CLI and stdio MCP adapter share this transport through the paired `HQ_ACCESS_CLIENT_ID` and `HQ_ACCESS_CLIENT_SECRET` environment variables. They preserve HTTPS-only transport, exact-origin scoping, redirect rejection, and development-mode credential suppression. The provider contract is documented under [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/). An isolated transport fixture is not verification of a deployed Service Auth policy.

Do not add a blanket Access bypass to make a client work. A future application-only API ingress is a separate design choice requiring its own browser-cookie/JWT behavior, abuse controls, and verification. It is not a reason to require a local server.

## First owner and automation enrollment

Bootstrap is a deliberate deployment operation against a new, explicitly selected database. It must bind a chosen workspace to an independently verified Access subject, show the proposed owner, reject a nonempty or conflicting target, and record the action atomically. Never grant ownership to the first visitor, trust a caller-supplied email, ship a development identity, or leave an unauthenticated seed endpoint available. Recovery after membership loss is an explicit administrative operation, not a reusable bootstrap bypass.

The implemented setup permit, owner-only invitation and membership controls, human-session CLI/MCP transport, and recovery boundaries are documented in [identity and workspace access](access.md). Local signed-JWT and concurrency tests do not substitute for verifying the intended account through an approved protected deployment.

After bootstrap, manage membership and automation credentials through structured owner controls and equivalent bounded API, CLI, and MCP commands. Protect the last owner's access. Issue expiring, revocable machine credentials with a stable identity and explicit scopes; store only digests. Handle an interrupted one-time value response by inspection and revocation, not speculative repeated issuance.

The publisher workflow does not grant goal-writing authority. The implemented Reporter profile grants only `goals:write` and `activity:write`, binds a stable reporter ID, and does not grant workspace reads or metadata edits. Reader grants only `read`. Owner controls issue and revoke these profiles through expiring exact reviews; see [automation access](automation.md). The agent must copy the active goal's exact objective and source timestamps into `goal_sync`, retain its IDs when retrying, and report transitions and periodic confirmations. Dashboard polling does not establish that an agent is still working. Keep stale reports and completed goal history visible.

## Deployment prerequisites

Before requesting a production cutover, complete and verify these gates:

1. **Identity and enrollment:** signed-JWT positive and negative tests, first-owner bootstrap, membership lifecycle, and scoped automation issuance/revocation. Test wrong issuer/audience, expiry, bad signature, missing subject, missing membership, lost authority, and invalid bearer credentials without fallback.
2. **Machine ingress:** shared CLI/MCP Access headers, no secret-bearing redirects or diagnostics, dev credential suppression, and actionable login-gate errors. Test outer Access permission separately from HQ membership and scopes.
3. **Reviewed production profile:** an explicit account, new D1 identity, issuer, audience, Worker identity, ingress policy, and schedule. Keep deployment-specific values outside public source. Refuse placeholders, development bindings, mismatched build/profile inputs, unintended domains, and an unreviewed existing domain owner.
4. **Artifact and browser security:** verify the generated Worker and asset manifest, not just source configuration. Apply and test the intended CSP, framing, referrer, cache, and content-type policies on both asset and API responses. Access protects entry; it does not replace browser security policy. Static asset header rules do not cover Worker-generated responses; see [Workers asset headers](https://developers.cloudflare.com/workers/static-assets/headers/).
5. **One-time data preparation:** review selected repository metadata and expectations through a secret-free import plan. Map unsupported fields explicitly. Never import legacy memberships, credentials, pending operations, or observations as fresh evidence. Use application-owned import validation and receipts, not manual production document editing.
6. **Recovery rehearsal:** restore an export into isolated storage, verify schema and foreign keys, and recover the journal. Distinguish a local SQL restoration from a remote D1 restore. Preserve provider credential recovery separately.
7. **Product verification:** run complete code and browser checks, inspect mobile and both themes, verify exact goal text, permissions, conflicts, stale sources, interrupted work, and the absence of fabricated health. Review bundle-size warnings as performance work, not failed functional tests.

The Vite build emits a generated Wrangler configuration and deployment redirect file. A source configuration with placeholder D1 identity remains a placeholder in that output. Do not hand-edit generated artifacts or assume an unrelated command-line profile will rebuild them. The reviewed profile must participate in the build and be validated again before deployment.

The implemented [offline release workflow](release.md) builds an explicit candidate profile, rejects unexpected generated targets and bindings, and packages only portable deployment files with separately verifiable digests. It never attaches a hostname or authorizes deployment. A built-package browser test exercises the production entrypoint, isolated D1, and static/API security headers without contacting a production provider.

Do not rely on an interactive Wrangler conflict prompt as the authorization boundary. Its noninteractive custom-domain path can request replacement of an existing origin and DNS record. Keep a fresh, exact hostname-owner precondition and a separately approved cutover action outside an ordinary candidate build or upload.

## Staged cutover

Prefer a separate candidate Worker and new D1 database. This keeps the retained application and its database available for recovery without mixing incompatible schemas, identity models, or provider credentials. Reusing the retained Worker is a secondary option only with an explicit version, binding, secret, schedule, and recovery review.

The live deployment procedure is approval-gated:

1. Capture deployed ownership, Access destinations and policies, bindings, schedules, and a restorable database point. Record the retained application's known limitations; a backup is not proof of a healthy fallback.
2. Create the candidate database and apply the reviewed schema. Deploy only to the approved candidate identity with no unprotected ingress. Establish Access protection before enabling any rehearsal URL.
3. Bootstrap the verified owner. Import only the reviewed metadata. Keep sources disabled until their production credentials and scopes are approved. Do not import development fixture identities or synthetic provider receipts.
4. Rehearse browser sign-in and membership, structured edits, real CLI/MCP reads, a verbatim goal update, scoped local publication, and revoked/expired credentials. Test negative cases outside the Access session as well as inside it.
5. Provision a separately approved read-only GitHub credential and pilot source. Verify actual repository permissions, incomplete security coverage, manual and scheduled receipts, cooldowns, and freshness without a local server. A fixture test is not a production provider test.
6. Present the exact hostname handoff, expected old owner, candidate identity, schedule changes, and rollback conditions. Apply only after explicit approval and a fresh state check. Never claim the handoff is atomic or interruption-free without a supported and verified mechanism.
7. Verify unauthenticated denial, authorized browser access, CLI/MCP, agent goal delivery, source freshness, and hosted schedule progress at the canonical hostname. Disable any temporary preview ingress. Update the deployment recovery record and estate ownership documentation.

A first online Activity deployment may precede GitHub credential provisioning. In that case, show unconfigured sources honestly and describe it as Activity/metadata dogfooding, not a live fleet-status rollout. Hooks, Monitoring, secret mutations, remote Git publication, and retirement of retained resources are separate approvals.

## Recovery rules

Keep the retained application, database, Access policy, and recovery material until the maintainer accepts the new hosted workflow. If cutover fails, pause new writes and collection, preserve the candidate's journal, and inspect the actual hostname owner before restoring the reviewed attachment. Do not silently discard metadata written after cutover or merge incompatible databases.

For candidate data recovery, capture the pre-recovery state, use the provider-supported restore path, and reconcile credentials and in-flight jobs before reopening access. D1 Time Travel restores overwrite the database in place and cancel in-flight queries; available history depends on the account plan. A restored digest can make an old machine token valid again, so reconcile revocations before accepting traffic. A restored queue can contain work whose provider outcome must be rechecked. See [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

A database restore does not restore deployment bindings, Access policy, or secret values. A route rollback does not reverse database writes. Keep these recovery actions explicit and independently verified. Do not remove the task preview database or its private exports until the journal has been deliberately preserved in its next home.
