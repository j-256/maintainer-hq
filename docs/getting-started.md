---
title: Getting started
description: Sign in, choose a workspace, create a project, and begin collecting honest evidence.
---

# Getting started

You do not need a local server to use a hosted Maintainer HQ dashboard. Open the dashboard URL provided by your deployment operator and sign in with the invited account. The maintainer-operated deployment is private and does not offer public accounts; other operators can run independent installations from the [public source](https://github.com/j-256/maintainer-hq). Sign-in identifies you; workspace membership determines what you can see and change.

## Choose your workspace

Use the workspace selector in the sidebar, or open **Menu** on a narrow screen. The mobile menu includes every app section, your account role, the theme switch, and documentation. Switching workspaces from a project or repository detail opens the corresponding inventory in the destination workspace; it does not carry a resource from the previous workspace into the new one.

If you have an invitation, accept it using the same verified account the owner invited. If no workspace is available, ask an owner or deployment operator to arrange access. A link to an unavailable workspace offers your accessible workspaces without silently switching you to one. Visiting an empty installation does not make its first visitor an owner.

Owners manage membership and connection authority. Operators maintain metadata and run permitted provider operations. Viewers can inspect the workspace and set their own display preferences. [Access](access.md) explains invitations, roles, and recovery.

## Set your display preferences

Open **Settings > Date and time preferences**. Choose your date pattern, clock, and time zone, inspect the preview, and save. Local follows the browser's detected zone on each device; UTC is explicit. These preferences follow your account across workspaces. They do not change stored timestamps, schedules, or calendar-only deadlines.

## Add a project and its repository

Open **Projects** and choose **Create project**. Name the effort, describe it, and record its Importance and Portfolio decision. Add its first repository in the same form when useful. A project with no repository is also valid, but every repository must have one owning project.

To group an existing repository, open the project and use its repository-linking control. Review the assignment in the repository editor and save. HQ never guesses these relationships from names. A project can grow to include several repositories without changing its identity.

Enrollment changes HQ metadata. It does not create a GitHub repository, start collection, configure a webhook, or grant provider access. See [Projects](projects.md) and [Repositories](repositories.md).

## Add evidence deliberately

In **Settings > GitHub evidence**, an owner can [configure a GitHub source](github.md) using an available read-only credential reference. Select the exact repositories, freshness policy, and refresh interval. An unconfigured or disabled source is valid but cannot establish health. An empty disabled source can also prepare a workspace for a transfer.

Local publishers report checkout facts using narrowly scoped credentials. They send updates outward and do not serve the dashboard. Hookrelay and Endpoint Monitor have their own executing configuration and credentials. Start with [integration availability](integrations.md) before interpreting a disabled control as a broken feature.

## Use HQ day to day

Read Overview for attention and evidence gaps. Open a project or repository for its related resources and history. Use ordinary Save/Cancel for metadata; consequential operations have a separate exact review and receipt. If a response is interrupted, inspect that same receipt before trying another operation.

Activity groups work by goal and keeps older pages stable while new reports arrive. The active objective is shown verbatim. [Troubleshooting](troubleshooting.md) explains stale goal synchronization, incomplete GitHub evidence, login interruptions, and conflicts.
