---
title: Troubleshooting
description: Turn incomplete evidence, stale goals, login interruptions, and uncertain receipts into useful next steps.
---

# Troubleshooting

An interrupted response is not evidence that a write failed. A metadata save can commit before its response is read, and a provider action can be accepted before HQ receives its receipt. Inspect saved state or the same operation receipt before repeating a write. Keep stable request identifiers for exact retries and retain drafts until the outcome is known. Malformed response bodies are replaced with safe recovery guidance rather than raw parser messages.

Start with the exact workspace, source or resource, observation time, and saved receipt. Preserve an error's support reference. Do not paste secret values, tokens, raw provider responses, or database exports into Activity or a support message.

## GitHub refresh completed with incomplete evidence

The job finished, but some requested evidence could not be collected. That is different from a Worker crash, and it is not a clean security result.

Open **Settings**, find the GitHub source, then open **Refresh history** and inspect the affected repository results. Look for the category and reason: repository access, permission or feature availability, timeout, rate cooldown, pagination, or a request bound. Use [GitHub evidence](github-evidence.md) and [diagnostics](diagnostics.md) to interpret those outcomes.

The generic Activity completion message does not name every missing category. Repeated similar messages need not mean the scheduler failed repeatedly; separate changes can produce the same summary. Do not grant broader credentials or suppress required evidence simply to clear the warning.

## Awaiting goal sync

HQ has not received a fresh confirmation from the goal's source. This is a reporting-freshness warning, not proof that work is blocked. Refreshing your browser cannot make an agent active.

The reporter should read its actual source goal, send its verbatim objective and real status using the original identities, and add separate progress reports at meaningful milestones. Paused and cleared source states must not be relabeled as executing. [Activity](activity.md) describes the complete lifecycle.

## Live connection, stale provider evidence

A connected WebSocket proves only that the dashboard's update transport is connected. GitHub collection and provider checks have their own eligibility, run status, and evidence times. Inspect the source receipt or Monitoring run evidence. An empty incident list cannot substitute for a fresh successful check or a scheduler heartbeat.

## A control is disabled

Read the explanation beside the control. You may lack an HQ role, the connection may be disabled, a credential may be missing or expired, or an adapter may not be implemented. [Integration availability](integrations.md) separates these cases. A project association and a Maintained classification never grant provider administration.

For a workspace transfer, both workspaces must already exist and you must be an Owner in each. Resolve every dependency in the preview before review. Credentials, provider resources, and earlier history are not silently carried across that access boundary.

## Sign-in expired or a save conflicted

Keep the open draft. If prompted, sign in in another tab, return, and retry the same intended save. A revision conflict means someone or something changed the saved record. Load and inspect that revision deliberately before replacing your draft; do not submit a guessed newer revision.

## A provider operation was interrupted

Open the same review URL or receipt. An interrupted response can hide an accepted upstream write. Do not create another operation merely because the browser timed out.

Receipts distinguish not sent, accepted, rejected, and indeterminate outcomes. Reconciliation observes provider state without replaying the write; later presence or absence does not turn uncertain acceptance into certainty. Follow the operation's [Hooks](hooks.md), [Monitoring](monitoring.md), or [Secrets](secrets.md) recovery guide.

## Something still looks wrong

Use the recorded support reference and relevant timestamps to correlate [safe application logs](diagnostics.md). Platform sampling and retention can omit events, so missing log rows are not proof that nothing happened. Keep the durable operation receipt, authority checks, and provider evidence in the investigation.
