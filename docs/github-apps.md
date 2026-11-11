---
title: GitHub Apps
description: Register deployment-owned Apps, grant workspace access, and recover credentials deliberately.
---

# GitHub Apps

GitHub Apps are the recommended GitHub authentication option. Advanced manual token configuration remains supported for new and existing connections. Selecting an App never silently falls back to a token after a denial or interruption. App authentication covers GitHub evidence, Work, releases, discovery and reconciliation, dependency and Dependabot schedule PRs, and supported Actions configuration operations. Actual provider permissions and feature availability still determine which operations succeed.

HQ and Hookrelay own separate App registrations and private keys. HQ grants access to its workspace capabilities; Hookrelay manages repository webhooks using its own authority. Their management protocol exchanges reviewed metadata, never signing keys or installation tokens. Signed repository receivers remain in place; neither registration turns Hookrelay into an App-wide notification fan-out service. See [Hooks](hooks.md) and [manual webhook handoff](github-handoff.md) for those separate workflows.

## Deployment and workspace ownership

Start with one HQ App per deployment. An operator running workspaces for several teams can share that registration and installation while explicitly granting each workspace selected repositories and capabilities. For example, a deployment owner can offer repository A to the engineering workspace and repository B to the documentation workspace. Each workspace owner accepts its own offer; neither obtains the other's repository inventory or installation credentials.

The same mechanism supports independently administered tenants: the deployment operator selects an installation and makes an exact offer, then the target workspace owner accepts it. Owning a workspace does not confer deployment setup authority. Additional App registrations are available when separate ownership, permissions or signing identities are useful. A public App registration permits other GitHub accounts to install it; it does not make the HQ deployment publicly accessible or introduce GitHub login, public signup or autonomous tenant admission. A private registration is appropriate only when GitHub's installation restrictions fit the intended accounts. Stored visibility is an operator declaration, not verified provider state. HQ cannot change it through a local metadata save; inspect the actual GitHub App settings before relying on installation restrictions.

Revoking a workspace grant affects that grant alone. Disconnecting a deployment registration makes every grant using that registration unavailable, with the cross-workspace impact shown in the review. Both are local actions. Neither uninstalls the App upstream, removes repository hooks nor deletes historical operation receipts.

## Prepare the deployment

Use the protected hosting and release procedure in [secure hosting](hosting.md). Apply the App registry, grants, authority and lifecycle migrations in normal migration order, preserving existing token metadata and operation journals. Keep a protected database backup and the credential-encryption key ring together in the recovery procedure.

Configure these server-side settings through the deployment's existing configuration authority:

| Setting | Purpose |
| --- | --- |
| `GITHUB_APP_DEPLOYMENT_ID` | Stable deployment identifier included in encrypted-material bindings and installation quota identity |
| `GITHUB_APP_ORIGIN` | Exact HTTPS application origin, without a path, query or fragment |
| `GITHUB_APP_SETUP_PERMITS` | Bounded JSON list of explicit, expiring setup permits |
| `ACCESS_ISSUER`, `ACCESS_AUDIENCE` | Verified human identity boundary matching each permit |
| `PROVIDER_CREDENTIAL_KEYS` | Protected encryption key ring, shared with the credential custody system |

Each setup permit contains `id`, positive `revision`, `administrativeWorkspaceId`, authenticated `subject`, exact `issuer`, exact `audience` and ISO `expiresAt`. It authorizes a verified human who is also a live owner of that administrative workspace. Automation, source and reporter credentials cannot use it. Scope permits narrowly and rotate or revoke their revisions through the deployment authority. Expiring a setup permit does not disable independently accepted workspace grants.

Changing the deployment ID or discarding an encryption key does not migrate encrypted material: it makes the existing binding unreadable. Retain old encryption keys until all material encrypted under them has been deliberately replaced and recovery has been verified. Follow [credential storage and recovery](secrets.md) for the key-ring format and custody responsibilities.

## Guided registration

1. Open **Settings > GitHub evidence > Authentication** as the deployment setup operator. Under deployment Apps, choose guided registration and select the intended GitHub account, App name, visibility and capability profiles.
2. Open the generated registration ceremony while authenticated to this exact HQ deployment. Review the permissions on GitHub and create the App there. HQ binds the return to the original actor, setup permit, administrative membership, origin and expiring one-time attempt.
3. Inspect the saved attempt after returning. An interrupted conversion can be indeterminate even if GitHub created the App. HQ never repeats a claimed conversion automatically. A browser URL outcome is only a navigation hint; the saved attempt establishes the result.
4. Install the App in the intended GitHub account and select repositories there. Registration and installation do not grant an HQ workspace access by themselves.
5. In the deployment controls, inspect the paged installation and repository pickers. Select exact numeric identities, target workspace and capabilities, then review the grant offer. Installation repository inventory is restricted to setup operators and uses a private, uncached, metadata-only credential.
6. Have the target workspace owner inspect and accept the same offer. The person performing both roles may be the same human, but both authority checks are required. Select the accepted App grant explicitly in the source, maintenance or configuration connection, save, then refresh and inspect its receipt.

Pending workspace access requests expire after seven days and do not consume active capacity afterward. Workspace owners explicitly resolve a request against a matching accepted grant or cancel it; accepting an unrelated grant does not silently close a request. Duplicate pending requests by the same actor for the same capabilities return the existing request. Both workspace and administration lists have bounded cursor pagination; shared commands retain resolved, cancelled and expired history.

Review links contain metadata IDs and fingerprints only. They can reopen the same actor-bound review after reload. They do not authorize another actor, extend expiry, replace private input or automatically apply the review.

## Protected import and recovery

Use protected import for an existing App or interrupted guided setup. Prepare the registration metadata review first, with the exact App ID, visibility and capabilities. Supply the matching RSA private key through the dedicated private-input boundary. Keys must be PKCS#1 or PKCS#8 RSA with at least 2048 bits. The browser accepts a deliberately selected private file; the CLI accepts an owner-only regular non-symlink file or piped stdin. Neither accepts key values in command arguments.

The private JSON envelope is `{"version":1,"privateKey":"PEM string","webhookSecret":"optional matching lifecycle secret"}`. Store it outside the checkout with owner-only permissions. Do not paste its contents into an ordinary command, MCP argument, issue, log or screenshot. The optional webhook secret must match GitHub's configured App webhook secret; inventing a replacement locally does not configure GitHub.

Use `npm run cli -- schema github_app_registration_plan` and `npm run cli -- github-app-input --help` for exact inputs. After reviewing metadata, submit the file with `npm run cli -- github-app-input --workspace <administrative-workspace> --review <review-id> --fingerprint <fingerprint> --input <private-file>`. Review and authority are checked before the client reads the file and before the server consumes private input. The local stdio MCP private adapter accepts a file reference, while ordinary metadata commands and hosted MCP never receive key material.

Private input is bounded, authenticated, same-origin checked, revision checked and encrypted at rest with deployment, registration and material identity as authenticated context. Usable installation tokens are kept only in bounded in-process caches. OAuth client secrets returned during manifest conversion are discarded because these workflows do not use user OAuth.

After a timeout or interrupted submission, inspect the same review before retrying. An applied receipt means acceptance was recorded; `submitted:false` does not compare a newly selected file with stored material. An indeterminate manifest attempt requires protected import of matching material or a deliberately new registration, never a blind conversion replay. Recover the matching webhook secret separately when its original value is unavailable.

For signing-key rotation, create a key in GitHub, review replacement under the existing HQ registration and supply it through protected input. Local key revisions invalidate old reviews, tokens and authority observations. Retire the old upstream key only after the new identity works and protected recovery is available. Changing the webhook secret also requires coordinated upstream configuration and protected HQ replacement; failure on one side leaves lifecycle ingress unavailable. These upstream changes retain their own approval boundaries.

## Permissions and supported behavior

| HQ profile | Repository permissions |
| --- | --- |
| Collection | Metadata, Contents, Checks, Commit statuses, Pull requests, Issues, Deployments, Dependabot alerts, Code scanning alerts and Secret scanning alerts read |
| Repository maintenance | Metadata read, Contents and Pull requests write |
| Configuration read | Metadata, Actions, Secrets, Variables and Environments read |
| Configuration write | Metadata and Actions read, Secrets, Variables and Environments write |

GitHub names the App permission for Variables `actions_variables`. Use that spelling in App manifests and scoped permission profiles. Configuration inventory responses and GraphQL requests retain their separate `variables` fields.

Profiles describe registration ceilings; each operation narrows its token further to its exact repositories and permissions. HQ does not request repository Administration, Workflows or repository Webhooks permission. Hookrelay owns webhook management through its separate App. Editing supported Dependabot YAML through a PR remains repository maintenance; enabling new Dependabot administration or editing workflow files is outside this feature. Ordinary repository rules still apply to App-created PRs.

Repository-effective organization secrets and variables remain the existing limited scope; an App does not confer an organization-wide configuration catalog. Scanner licensing, feature enablement, public-repository query behavior outside an installation and exact GraphQL query support require separate evidence. A 404 may hide denied access. An empty or inaccessible response never establishes healthy security or complete coverage. GitHub Enterprise Server, merge bypass, hosted tenant signup and App-wide notification collection are outside this implementation.

## Authority, lifecycle and interruption

Active reads use verified provider authority no older than sixty seconds and never beyond the credential or local grant expiry. Each provider effect performs a fresh target-specific check after durable intent, then checks captured local revisions again before dispatch. Membership, source, grant, key and observed authority generations fence acceptance. A normal token renewal with unchanged authority does not invalidate the identity of a review; an authority change requires a fresh review.

Local generation checks do not create provider-side compare-and-swap or recall an in-flight request. Signed lifecycle invalidation improves detection but cannot provide instant knowledge of missed provider events. Bounded reconciliation checks due scopes, respects installation cooldowns and records incomplete progress. Repeated failures get a retry cursor so one denied scope cannot indefinitely starve later scopes.

The dedicated `POST /api/github-apps/events/<registration-id>` route accepts bounded raw bytes verified with HMAC-SHA256 before JSON parsing. It handles installation lifecycle events, selected-repository changes and signed ping, with delivery deduplication and no retained raw payload. Deletion revokes local grants for that numeric App and installation, including duplicate local registrations. Delayed additions never reactivate grants or enroll repositories.

The callback and ceremony routes remain behind verified human authentication. GitHub must reach only the dedicated lifecycle route without a user session. Configure the existing ingress policy with that exact method/path exception; keep all other API routes protected. Imported Apps without matching webhook material report lifecycle ingress unavailable. This does not authorize a new hostname or an ingress deployment.

Disable query-string capture at every ingress, proxy, request tracing and access-log layer for `/api/github-apps/manifest/callback`, and exclude private request bodies and Authorization headers everywhere. Callback codes and state must not enter logs, analytics, referrers or screenshots. Application responses use no-store and restrictive referrer policy and redirect to a clean metadata-only settings URL; those headers cannot sanitize upstream infrastructure logging. Verify the deployed routing and logging policy before real registration.

The checked release configuration keeps Workers Logs enabled with mandatory request-query redaction and automatic tracing/Issues capture disabled. Rebuild older artifacts rather than editing their sealed configuration. Follow [telemetry privacy](diagnostics.md#telemetry-privacy) for serving-version readback and synthetic callback probes; this source policy does not certify Access/WAF logging or hosted redaction.

A confirmed provider acknowledgement remains recorded if authority changes during the request; follow-up metadata becomes unverified and the operation stops or remains partial. A dispatched request without a definitive response stays indeterminate. Reconciliation reads cannot turn uncertainty into confirmed acceptance. Only an explicit unapplied 401 permits one App-token remint retry under the same input and deadline, with authority checked again. Network interruptions, ambiguous results and manual tokens do not use that retry. Review every partial receipt before deliberately preparing recovery.

Diagnostics include correlation IDs, bounded counts, timing, lifecycle states and refusal codes, without raw provider responses, keys, tokens or webhook secrets. Inspect the exact attempt, grant, refresh or operation receipt alongside [diagnostics](diagnostics.md).

## Advanced manual tokens and rollback

Keep existing `GITHUB_CREDENTIALS` collection bindings and managed provider credentials when they are still needed. Token-backed sources and maintenance/configuration credentials retain their existing protected setup, scope, expiry, rotation and verification paths. New connections may select **Advanced: manual token** without creating an App. See [GitHub evidence custody](github-evidence.md#source-ownership-and-credential-custody) and [Secrets](secrets.md).

To migrate, accept an explicit App grant, select it in each intended connection and save. Saving invalidates queued work tied to the old source revision; it does not erase its receipt. Inspect a new refresh and separately review subsequent writes. There is no implicit adoption of repositories newly added to an upstream installation.

To roll back authentication, inspect interrupted operations first, explicitly select a configured manual token, save and refresh. Revoke the unused workspace grant or disconnect the registration only after reviewing its scope and cross-workspace impact. Do not delete journals, encryption keys or upstream installations as a shortcut. Database rollback cannot undo an accepted provider effect or restore a deleted secret value.

## Resource limits and Free-plan compatibility

Limits were checked against Cloudflare's official documentation on 2026-11-10. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) specify 50 external subrequests and 10 ms CPU per Free invocation, versus a default 10,000 external subrequests on Paid. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) separately specify 50 D1 queries per Free invocation and 1,000 on Paid, with at most 100 bound parameters per statement. A D1 `batch()` counts as one D1 API call for the invocation limit, while every contained statement still executes and incurs database work. Trigger work and rows scanned/written are additional costs, not captured by counting top-level statements.

Synthetic measurements below use the real local D1/services with generated RSA keys, one installation, no cooldowns, immediate fixture responses and no concurrent changes. They measure binding API calls and top-level statements, not deployed CPU, billable rows or complete outer HTTP authentication. Reproduce with `npx vitest run test/github-app-migration.test.ts test/github-app-discovery-authority.test.ts test/github-app-write-paths.test.ts --reporter=verbose --silent=false`, then inspect the `APP_RESOURCE_` records.

| Scenario | D1 calls / statements | Provider requests | Crypto work |
| --- | --- | --- | --- |
| Cold single-repository credential resolution | 20 / 20 | 3, including metadata and operation-scope mints | 3 RSA signatures, 2 decryptions, 9 digests |
| Warm identical resolution | 13 / 13 | 0 | 3 digests, no signature or decryption |
| Fresh-effect resolution after warm read | 16 / 16 | 2 authority requests; operation token already cached | 2 RSA signatures, 1 decryption, 7 digests |
| Cold discovery authority for 100 accepted repositories | 513 / 513 | 2 | Shared installation verification and exact-set metadata mint |
| Warm discovery authority for that set | 311 / 311 | 0 | Local scope checks and authority identity digests |
| Dependency PR preparation, including fresh evidence | 133 / 136 | 10 | Credential and authority work included |
| Dependabot PR preparation, including fresh evidence | 150 / 154 | 10 | Credential and authority work included |
| Dependency PR execution through confirmed receipt | 500 / 514 | 23, including 7 mints and separately fenced Git effects | Fresh checks before each effect |
| Dependabot PR execution through confirmed receipt | 500 / 514 | 22, including 7 mints and separately fenced Git effects | Fresh checks before each effect |

The large discovery and reviewed PR workflows exceed Free's D1 invocation limit even though their provider request counts fit its external-request ceiling. These measured workloads require Paid with this execution model. A smaller grant can reduce discovery work, but does not make the measured PR operations Free-compatible. A Free-compatible PR workflow would require separately designed resumable phases or batching that retains all authority and intent fences; manual token configuration is not a blanket Free-plan guarantee. Other existing large configuration workflows also have documented limits in [Secrets](secrets.md#resource-limits-and-free-plan-posture).

The production configuration requests a 2,000 ms CPU limit, a Paid configuration. Local elapsed timings include emulated database and provider waits and do not measure deployed CPU. No maximum-size App workload has been verified against either Free's CPU ceiling or the configured Paid ceiling. Measure Worker CPU, D1 rows and actual request totals on approved isolated deployed resources before capacity claims. Lifecycle reconciliation shares its invocation with other scheduled work: its scope, request and elapsed-time bounds are not an account-wide cost cap or proof that the combined schedule fits a plan.

GitHub's [stateless installation-token notice](https://github.blog/changelog/2026-10-02-stateless-github-app-installation-tokens-rolled-out/) describes longer, variable-length opaque tokens. HQ does not parse their format. App tokens have a defensive 16 KiB ceiling within a separate bounded response; existing manual credential inputs retain their own smaller bound. Real maximum token/header sizes across selected repository sets and deployed ingress remain unverified.

## Verification boundary

Local tests cover explicit token-to-App migration and recovery, separate workspace grants, stale queued work, ordinary renewal, protected custody, duplicate/interrupted callbacks, key and scope changes, lifecycle invalidation, authorization races, partial effects, client parity and accessible setup flows. Fixtures are synthetic. They do not verify live GitHub permissions, exact public/private GraphQL behavior, actual manifest return through protected ingress, hook delivery, notification delivery or deployed CPU.

Before live verification, approve the exact test Apps, accounts, public/private repositories, outside-installation watchlist repository, requested permissions, Worker targets and isolated sinks. Registration, grants, repository writes, hook creation, deployment and notification sends are separate effects. Keep partial outcomes and resource observations in a protected operator record and reconcile them before retrying. Passing local tests does not authorize any of those actions.
