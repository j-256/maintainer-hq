---
title: Date and time preferences
description: Choose date patterns, a 24-hour clock, and local, UTC, or named time zones.
---

# Date and time preferences

Open Settings > Date and time preferences. Choose a date format, a 24-hour or 12-hour clock, and Local, UTC, or a named IANA time zone. The preview uses the draft choices; Save applies them throughout the dashboard. Cancel and navigation protect unsaved edits. Failed saves preserve the draft, and revision conflicts require loading and reviewing saved preferences before retrying.

Local follows the browser's detected zone on each device. A named zone follows that zone's daylight-saving rules; UTC never shifts. The local label shows the detected zone so an automation browser or device with an unexpected zone is visible. Local is stored as a mode, not converted to a fixed zone when saved. Accounts without a saved record use `yyyy-MM-dd`, a 24-hour clock, and Local.

The supported date patterns are `yyyy-MM-dd`, `MM/dd/yyyy`, `dd/MM/yyyy`, `dd.MM.yyyy`, and `MMM d, yyyy`. The clock uses `00:00` at midnight in 24-hour mode and AM/PM in 12-hour mode. Numeric dates use Gregorian years and Latin digits; named months use English abbreviations. Browser-native calendar input controls retain their device presentation, while saved calendar-only review dates use the chosen date pattern without shifting the underlying day.

Typed timestamps in Activity, goals, repository evidence, sources, refresh history, credentials, invitations, import reviews, and connection notices share the same formatter. Journal prose is historical text and is not rewritten. Activity and goal timestamp tooltips retain the named zone and exact UTC ISO instant, so repeated local times at a daylight-saving boundary can be distinguished. Stored timestamps, freshness calculations, collection schedules, expiration, and API timestamp fields remain unchanged.

## Account scope and shared commands

Preferences belong to the authenticated stable subject, not a workspace, browser storage, or a caller-selected user ID. They follow the account across its workspaces and devices. Another user's preferences cannot be read or changed through these commands. Owners, operators, and viewers may save their own display preferences; this does not grant workspace-edit or provider-operation authority. Fixed Reader, Reporter, and publisher credentials do not receive `preferences:write`.

The shared `preferences_get` and `preferences_update` commands require an explicit authorized workspace. Updates require both `read` and `preferences:write`, the last saved `revision`, and the complete preference object. Inputs reject unknown fields and unsupported formats or zones. Read the command schemas through CLI or MCP discovery; browser, CLI, and both MCP transports use the same service and optimistic-revision check.

```json
{
  "workspaceId": "example-workspace",
  "revision": 0,
  "preferences": {
    "dateFormat": "yyyy-MM-dd",
    "clockFormat": "24h",
    "timeZone": "local"
  }
}
```

Revision zero creates a record only if one does not exist. Competing saves cannot silently overwrite each other. If a response is lost, read saved preferences and compare them with the intended choices before retrying with a fresh revision. The write boundary rechecks live membership and any credential's ownership, scope, revocation, and expiry. Personal preference changes do not generate shared workspace Activity.

## Storage and recovery

Apply the additive user-preferences migration before deploying code that reads it. Preferences are stored in D1's `user_preferences` table with subject, JSON settings, revision, and update time. Include that table in normal private database backups. A rollback to older application code can leave the table intact; do not delete preference records, reset revisions, or move them to another subject implicitly. An identity-recovery procedure must explicitly decide whether to transfer preferences along with the verified account's access.

Session reads include the account's preference record, adding one indexed D1 read without a separate polling request. Saving uses bounded authorization reads and one conditional write; formatting occurs in the browser. Preferences do not create background jobs, external subrequests, additional application success logs, or a new scheduled workload. This does not establish Free-plan compatibility for the whole application; see the existing [capacity and logging record](diagnostics.md#cloudflare-free-plan-compatibility).
