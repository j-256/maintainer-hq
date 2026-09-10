---
title: Integration availability
description: See what HQ implements, what requires provider setup, and what remains planned.
---

# Integration availability

An implemented adapter is not automatically configured in your deployment. HQ membership, connection enrollment, and upstream credentials are separate requirements. The UI must show missing or disabled authority instead of inventing healthy results.

| Capability | Implemented behavior | Setup or remaining boundary |
| --- | --- | --- |
| GitHub evidence | Read-only repository, CI, and security collection with durable refresh receipts | An owner selects repositories and a separately provisioned read-only credential; some endpoints can remain unavailable |
| Local observations | Bounded checkout reports from an enrolled publisher | A source and expiring publisher credential; no local dashboard server is required |
| Hookrelay | Subscription and delivery inspection, associations, and reviewed retry recovery | A deployment-approved private binding and scoped management credential |
| Endpoint Monitor | Configuration, scheduler/check evidence, incidents, triage, and reviewed operations | A private provider binding and separately scoped authority |
| GitHub Actions configuration | UI-managed credential setup and retirement; secret-name and non-secret-variable inventory across repository, environment, and repository-effective organization scopes; vault-free secret presence definitions; desired repository/environment variables with reviewed reconciliation; supplied-secret distribution; retained-input recovery; and separately reviewed source removal | An independently provisioned token and protected deployment keyring; Secrets, Variables, and Environments permissions differ, while organization entries remain inventory-only and organization-wide catalogs are not used |
| Cloudflare Workers configuration | UI-managed provider access, case-sensitive `secret_text` name inventory, readable `plain_text` and `json` variable inventory, reviewed supplied-secret writes, and separate source removal | An independently provisioned Workers Scripts credential and protected deployment keyring; one fully serving version, immediate deployment effects, and no retained supplied value |
| Managed reusable vault | A requested product capability | Persistent value custody and distribution policy need a separate design; no stored-value reveal or general vault is implemented |
| Automatic spending shutoff | A requested operational capability | Monitoring thresholds, ingress shutdown, background work, and deliberate recovery remain a separate design |

## Choose the right connection

Collection sources observe evidence. Management connections perform supported operations. A GitHub collector token is not a Secrets credential, and a local publisher cannot administer hooks, edit expectations, or write goals.

Project and repository associations make resources easier to find. They do not expand a credential's provider scope. A watchlist repository remains useful even when you cannot administer it; the exact upstream permission determines which operations are available.

## Secret values are not inventory

Neither installed adapter reveals stored secret values. Both adapters return values that their provider explicitly classifies as non-secret variables. Unmanaged values are read live without persistence; an HQ-managed GitHub variable deliberately retains its desired non-secret value for comparison and reviewed reconciliation. Do not put credentials in variables merely because a provider makes their values readable. To distribute a secret value or change its scope, supply it from a trusted source, review the destinations, and inspect each receipt. Presence of a name after a write is not proof of plaintext equality or runtime usability.

Cloudflare Worker secrets use dedicated transient input, not GitHub sealed boxes. Each accepted write or removal activates a Worker deployment; no automatic retry is made. Cryptographic bindings, gradual-deployment mutations, same-Worker renames, and account-level Secrets Store custody are not supported. Follow [Cloudflare setup and operation](secrets.md#cloudflare-workers-secrets) for the exact boundaries. The common [Secrets contract](secrets.md) also supports mixed-provider distributions without storing Cloudflare supplied values.
