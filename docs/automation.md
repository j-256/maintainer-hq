---
title: Automation access
description: Connect a scoped agent or script without granting owner authority.
---

# Automation access

Settings > Automation access creates owner-managed credentials for agents and scripts. A credential belongs to one workspace and its issuing member. It expires, can be revoked immediately, and never exceeds the issuing member's live role. Removing that member revokes their credentials; rejoining does not reactivate them. Credential values are shown once and only digests are stored.

| Profile | Permissions | Excluded |
| --- | --- | --- |
| Reporter | `activity:write`, `goals:write` for its bound reporter ID | Workspace reads, expectation changes, provider operations, access administration, secret values |
| Reader | `read` workspace status, metadata, and journal | Writes, provider operations, access administration, secret values |

Source-scoped local publisher credentials are separate and grant only observation publication. GitHub provider credentials are also separate. There is no general remote shell or broad operator-token preset.

## Review, create, and recover

Choose a recognizable name, profile, and lifetime in the creation form. A Reporter also needs a stable reporter ID. Review the exact workspace, owner, permissions, reporter identity, and lifetime. The server stores a short-lived plan bound to the initiating actor, actor credential, live membership revision, and exact inputs. A changed member revision or expired review requires a fresh review. Concurrent application cannot issue the same credential twice.

The creation response is the only opportunity to save the value. It is masked by default, with explicit Reveal and Copy controls and a close warning. The application keeps the value only in the open component, not the query cache, browser storage, ordinary journal, or credential list. Save it in protected client configuration as `HQ_TOKEN`. Never paste it into Activity, chat, command arguments, URLs, screenshots, or tracked files. Avoid screen recording during issuance. Copying deliberately places the value on the system clipboard; manage clipboard history as sensitive storage.

If the response is interrupted, inspect the credential list by its name and stable ID. Do not assume issuance failed and do not expect a repeated request to reveal the value. Revoke any credential whose value was not saved, then create a replacement. Keep the same reporter ID for the same reporting client. Changing the reporter ID creates a separate identity, not permission to alter another reporter's history. Credential history is bounded and lists active credentials first. Pending reviews expire; the server limits outstanding reviews and active credentials.

Revocation preserves prior goals and journal entries. It is idempotent and cannot be undone. Live report authorization is checked inside the write, so a credential revoked between initial authentication and persistence cannot write. A response lost after a committed report is recovered by retrying the exact report, not by creating another journal event.

## Hosted transport

For an Access-protected host, configure these values through a protected environment or credential store:

- `HQ_URL`: the HTTPS workspace origin
- `HQ_TOKEN`: the workspace Reporter, Reader, or enrolled Publisher credential
- `HQ_ACCESS_CLIENT_ID` and `HQ_ACCESS_CLIENT_SECRET`: the separately approved Access service credential pair

The shared CLI and stdio MCP client sends both `CF-Access-Client-Id` and `CF-Access-Client-Secret` on every machine request, alongside the HQ bearer in `Authorization`. The Access service credential passes only the ingress gate. It neither grants membership nor substitutes for the HQ token. The paired-header contract and Service Auth policy are described in [Cloudflare's service-token documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/). Deployments must verify the actual policy, including alternate ingress, before relying on this flow.

Do not combine these machine credentials with `HQ_ACCESS_TOKEN`, which represents an explicit human session. Mixed modes, incomplete pairs, unsafe header values, insecure remote URLs, and credential-bearing redirects are rejected. Loopback `--dev` suppresses every credential variable. Login pages produce an actionable non-API error without printing proxy response bodies. No Access bypass or service credential is provisioned by the application credential screen.

## CLI and MCP parity

The shared operations are `automation_credentials_list`, `automation_credential_plan`, `automation_credential_issue`, and `automation_credential_revoke`. Use `npm run cli -- schema <command>` for exact bounded inputs. Preparing a plan takes workspace ID, caller-chosen credential ID, name, profile, reporter ID or null, and expiry duration. Applying takes the returned plan ID and fingerprint in the same workspace and authenticated session. Revocation takes the exact workspace and credential ID.

Issuance returns a privileged one-time value on CLI stdout or in the MCP tool result. Use an owner session only in a trusted client that protects those outputs. Prefer the browser flow for human issuance. A Reporter or Reader cannot list credentials, prepare grants, issue credentials, or manage members. All surfaces call the same application service.

Reporters call `goal_sync` with their bound reporter ID as `sourceId`. Retain the actual goal's stable `goalId`, exact `objective`, `startedAt`, status, and source report time. Preserve whitespace. Retrying the same report returns its original receipt; an older report cannot overwrite a newer one. A changed objective requires a new goal identity. Human-owned and reporter-owned records are distinct even when the same workspace member issued the credential. Replacement credentials with the same owner and reporter ID can continue that reporter's goals.

Statuses are `active`, `blocked`, `paused`, `complete`, and `cleared`. Report `paused` when the source suspends the goal, not `blocked` or `active`. Report `cleared` only after the source clears that exact goal; it preserves history without claiming completion. Publish the new goal separately, retaining its own verbatim objective and start time. Source status and substantive work updates are separate evidence; reporting an unrelated progress note does not refresh or resume a goal. HQ does not control the source goal scheduler.

For Activity, retain `eventId` across retries and change it only for a distinct update. Pass the existing `goalId` to group a report with one of the same owner's and bound reporter's goals; preserve the association on retries. A Reporter can also attach a report to an already-known repository ID without gaining access to repository data. It cannot rewrite another actor's or reporter's update. Reported work is not independently observed provider evidence. Report transitions and periodic confirmations; polling the dashboard alone must never make an inactive source appear alive. See the [Activity contract](activity.md) for pagination and historical grouping.
