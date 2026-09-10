---
title: Identity and workspace access
description: Understand roles, invitations, first-owner setup, and lost-access recovery.
---

# Identity and workspace access

Maintainer HQ separates sign-in from permission. A verified human Access session identifies an account; workspace membership grants a role. The same commands enforce this boundary for the browser, HTTP API, CLI, and MCP. An Access service identity does not receive human membership.

## Sign out or switch accounts

Choose **Sign out** below your account in the sidebar, or open **Menu** on a small screen. Review the signed-in account and choose **Sign out of Access**. Save any open changes first. Return to the dashboard and sign in with the intended account; switching identities does not transfer workspace membership or change permissions.

Cloudflare Access logout revokes that identity's sessions across applications protected by the same Access team, not just HQ. The confirmation discloses this wider effect. The application uses the same-origin `/cdn-cgi/access/logout` endpoint; it does not merely hide the UI or delete an application preference. Cloudflare documents its [logout and session revocation behavior](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#log-out-as-a-user).

The sign-out action is also available before an account has workspace membership. Isolated local development uses a fixed identity adapter and has no Access session to sign out of.

## Give someone access

If you are an owner, open **Settings > Members and invitations**. Invite the email address the person uses to sign in, select their role, and set an expiry. HQ does not send an invitation email: ask them to open the dashboard and accept the invitation using that account.

Choose Viewer for inspection, Operator for ordinary maintenance and permitted operations, or Owner for membership and connection authority. Review the full scope before granting Owner. Existing members and machine credentials can be revoked from Settings; revocation does not undo provider operations that were already accepted.

Personal display preferences are available to every human role. If you cannot see workspace controls, inspect your selected workspace and role before treating this as a sign-in failure. [Troubleshooting](troubleshooting.md) covers missing access and interrupted login.

## Repository and provider permissions

Open **Access & operations** beside a repository's **Edit expectations** button. The dialog separates the live HQ role from any client credential's scopes. An Owner using a read-only client credential still cannot edit expectations through that client. The operation rows say whether HQ permits the action, requires a different role, or requires a client scope. They are guidance, not a reusable authorization decision; every real operation checks live access again.

Maintained and Watchlist express how you track a repository. Neither proves who owns it, your GitHub role, or the provider credential's grants. Readable observations do not establish administration permission, and a watchlist repository may still be administrable through a separately authorized provider account.

The GitHub source list names only sources explicitly enrolled for this repository. **Credential configured** means HQ can resolve the workspace-scoped protected credential; it does not verify upstream permissions, token validity or successful collection. Disabled collection and invalid source configuration remain separate. Follow the exact source into GitHub coverage to inspect attempted and accepted evidence. An unavailable read can reflect missing access, an inaccessible resource or an unavailable provider feature; do not broaden grants based on the label alone.

GitHub owns repository webhooks. HQ's GitHub webhook create/edit adapter is not implemented, independently of whether your account could administer them upstream. Among GitHub's default organization repository roles, webhook management requires Admin; a custom repository role can separately include **Manage webhooks**. Fine-grained API credentials for creating a webhook require repository **Webhooks: write**, independently of the HQ role. These are documented prerequisites, not permissions observed for your account. See GitHub's [repository-role table](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization), [custom repository permissions](https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/about-custom-repository-roles) and [webhook API permissions](https://docs.github.com/en/rest/repos/webhooks#create-a-repository-webhook).

An **Open GitHub webhook settings** link appears only with explicit GitHub source enrollment. GitHub checks your separate browser sign-in and permissions when you follow it. HQ does not inspect webhook payloads or settings to decide whether to show the link. Without an enrolled source, a repository name alone does not create an upstream administration link.

Repository Hooks shows explicitly linked Hookrelay subscriptions and delivery retries, not the GitHub-owned webhook configuration. Monitoring and Secrets use their own provider connections, resource scopes and reviewed actions. A repository or project association supplies context; it neither transfers provider ownership nor grants permission. A supported operation still needs an enabled connection, exact resource scope, provider authorization and a fresh review before effects.

Browser, CLI and MCP share the bounded read-only `repository_access` command with exactly `workspaceId` and `repositoryId`. It returns HQ operation gates and enrolled GitHub configuration status, not credential references, values, provider grants or arbitrary provider responses. Reads use live membership and credential guards, reject reporting/publisher identities, and contact no providers. The source limit is `SOURCE_LIMITS.SOURCES` and the response-byte cap is `REPOSITORY_ACCESS_LIMITS.RESPONSE_BYTES`. HQ CPU and D1 work still apply; these are not an account-wide budget guarantee.

The dialog reads only while mounted. Reopen it or choose **Check access again** for a fresh read. Relevant access changes and changed repository/source metadata use the existing push and view coordinator; ordinary GitHub progress and Activity do not trigger guidance reads. The checked time follows Preferences. A failed read hides older guidance, including after revoked access, rather than leaving an outdated permission label visible.

## First-owner setup

The deployment operator selects a new database and independently verifies the intended owner's Access subject, issuer, and application audience. Do not infer the subject from a display name or let the first visitor claim ownership. The optional `INITIAL_OWNER_SETUP` deployment value is a short-lived permit, not a reusable administration endpoint. It contains `setupId`, `workspaceId`, `workspaceName`, `ownerSubject`, `issuedAt`, and `expiresAt`. Dates are ISO UTC timestamps, identifiers use the command schema's identifier grammar, and the permit may be valid for at most one hour. Keep deployment-specific values outside source control.

The intended owner signs in, reviews the workspace name, account, and expiry, then explicitly accepts ownership. `setup_status` exposes a reviewed fingerprint only to that verified account. `setup_apply` accepts that exact fingerprint; it atomically creates the workspace, owner membership, journal entry, and singleton installation receipt only in an empty database. Concurrent exact requests share one result. Changed inputs, another account, development identities, and automation credentials cannot claim ownership. Remove the deployment permit after setup. The completed receipt permits safe inspection/retry without recreating anything.

Deleting memberships or the workspace does not reopen setup. Never remove the installation receipt to recover access. A deployment that already contains application data must use an explicitly reviewed recovery operation, not pretend to be a fresh installation. A protected deployed sign-in rehearsal is required in addition to signed-JWT fixture tests.

## Member controls

Settings > Members and invitations provides owner-only membership and invitation controls. Owners manage access and credentials; operators edit metadata and run permitted provider operations; viewers read workspace information. Credentials remain constrained by both their own scopes and their owner's live role. At least one owner must remain after every role change or removal, including concurrent requests.

Every human role can set its own [date and time preferences](preferences.md). That personal capability does not permit changing another account's settings or workspace metadata. Fixed automation profiles remain read-only or reporting-only as declared.

Invite the email the recipient uses to sign in, choose a role, and choose an expiry. No email is sent and there is no secret invitation link. Tell the recipient to open the dashboard and use the matching account. Only its verified Access email can see and accept the invitation. Acceptance records the stable subject and never silently changes an existing membership's role. An inviter who loses ownership or whose credential expires or is revoked cannot authorize acceptance. Removal revokes that member's machine credentials and pending invitations; reinvitation does not reactivate them. Membership revisions advance across removal and rejoining, so a stale form cannot change the replacement membership.

Invite creation uses a caller-chosen stable `invitationId`. Retry an interrupted request with the same ID and exact fields; use a new ID for a different invitation. Role changes, removals, and revocation require the reviewed revision. On a conflict, the form preserves the draft and requires a fresh review. Invitation email addresses are restricted to owners and their recipient; shared Activity records the access event without copying a pending recipient address into the journal. Lists and pending invitations are bounded.

## Shared commands and transport

Account commands are `setup_status`, `setup_apply`, `invitations_mine`, and `invitation_accept`. Workspace commands are `members_list`, `member_update`, `member_remove`, `invitations_list`, `invitation_create`, and `invitation_revoke`. Use `npm run cli -- schema <command>` to inspect their exact fields. The HTTP command endpoint and both MCP transports expose the same service methods and validation.

For a deliberate human CLI or stdio MCP session, load the short-lived Access application session into `HQ_ACCESS_TOKEN` through protected environment configuration. This is a credential; never put it in command arguments, URLs, tracked files, screenshots, or logs. The shared client sends it as the `CF_Authorization` cookie with the exact application origin, not as a forged identity header. Clear `HQ_TOKEN` in this mode. Human sessions expire and are not an unattended automation strategy. The Access edge must verify the cookie and forward the signed assertion; an approved deployed rehearsal must verify that complete path. See the [Access application token contract](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

The client rejects ambiguous credential modes, insecure remote destinations, invalid origins, and redirects. Development mode suppresses all supplied credentials and works only on loopback. An explicit invalid HQ bearer never falls back to an accompanying human session. Browser interruption and login-gate errors preserve open drafts and explain how to sign in in another tab before retrying.

Shared service authorization rechecks identity expiry and the live credential's workspace, owner, publisher or reporter binding, revocation, expiry, and required scope. Resolving an identity does not preserve authority after its credential changes. An already-resolved credential that loses authority receives `forbidden`; an expired human identity requires sign-in again. Session discovery and basic inventory reads use this check as well as consequential operations. Conditional write guards remain responsible for access changes at the database write boundary.

For unattended agents and scripts, use the fixed Reporter or Reader profiles in Settings > Automation access. They do not inherit the owner's broad permissions. Their paired Access ingress transport, exact reviews, live revocation, and one-time value recovery are documented in [automation access](automation.md). Clear both Access service variables when switching to a human session.

## Lost access and recovery

If another owner remains, invite the replacement verified account, review its role, and remove the obsolete membership. Access subjects can change when an account is removed and re-added at the identity provider boundary. Do not automatically rekey existing membership merely because a display email matches. Check the signed subject and the Access account before authorizing recovery.

If no usable owner remains, pause application writes and have the deployment operator capture a private database backup and verify the exact target database, replacement signed subject, and intended workspace. Review a narrowly scoped transactional repair that grants the replacement owner, records its reason and actor, and revokes obsolete credentials and pending invitations. Reconcile membership-generation records and retained setup receipts; never delete the setup receipt or relax the production identity resolver. Test the repair against an isolated restored database, obtain explicit production approval, then verify sign-in and least privilege before reopening writes. This recovery authority belongs to deployment administration, not an unauthenticated application command.

Backups can revive old credential digests and invitations. Reconcile revocations and expired authority before accepting traffic after a restore. Preserve identity configuration and protected credential recovery separately from application metadata. See [hosting and recovery gates](hosting.md).
