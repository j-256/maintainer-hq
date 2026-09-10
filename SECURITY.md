# Security policy

## Supported versions

Until Maintainer HQ publishes a stable release series, security fixes target the latest commit on `main`. Older commits and private deployments are not maintained as separate supported versions.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/j-256/maintainer-hq/security/advisories/new) for suspected vulnerabilities. Do not open a public issue for a vulnerability and do not include a live credential, private repository inventory, production identifier, database export, signed URL, or raw provider response in any report.

Describe the affected surface, prerequisites, reproducible behavior, likely impact, and a minimal synthetic proof when one is safe to provide. State whether you believe exploitation occurred, but do not probe infrastructure or accounts you do not own or have permission to test.

The maintainer will validate the report, coordinate a fix and disclosure when warranted, and preserve uncertainty when an external effect cannot be reconstructed safely. No response or remediation deadline is promised.

## Deployment responsibility

This repository provides self-hosted software, not access to the maintainer's private deployment. Each deployment operator is responsible for identity policy, workspace membership, provider credentials, storage, backups, logs, hostname protection, and incident response. A source-code issue and a deployment-specific compromise may require separate reports and remediation.
