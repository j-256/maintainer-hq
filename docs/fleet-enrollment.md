---
title: Review fleet enrollment
description: Discover repositories and reconcile verified names, archive state, and collection membership without changing GitHub.
---

# Review fleet enrollment

In **Repositories**, choose **Review enrollment** to find repositories or reconcile GitHub changes with HQ. This is an owner workflow. It changes only reviewed HQ metadata and collection membership, never GitHub repositories or provider permissions.

## Choose what to check

Select an enabled, configured GitHub source. Its existing workspace-scoped credential supplies the read authority; choosing a source does not add repositories to its scheduled collection. The dialog loads a minimal source list on demand, without downloading other Settings or Activity data.

Choose **Changes to HQ repositories** to check the workspace's enrolled records, including metadata-only records outside collection. Alternatively, choose **Owner or organization catalog** and enter an exact GitHub owner name to browse repositories visible through that credential. Press **Check GitHub**. Results are paginated, and the provider observation time and coverage remain visible. There is no recurring discovery scanner or polling loop.

Visibility is credential-relative. A private repository may be inaccessible, and an organization catalog is not a complete list of everything the user can access. Unavailable, forbidden, missing, malformed or bounded results never imply deletion, archive state, healthy checks, or administration rights. A cooldown gives a retry time rather than silently changing authority.

## Select and review

Nothing is selected automatically. Select individual verified rows, continuing across pages when needed, then choose **Configure repositories**, whose label includes the selected count. Conflicting names or identities remain non-selectable with an explanation. A retained alias and its canonical HQ record are not merged automatically.

For each new repository, explicitly choose its owning project and HQ tracking classification. The project must still exist at the reviewed revision when the change is applied. New records use the displayed ordinary expectation defaults: CI and security are required, while hooks and monitoring are not managed here. These are HQ expectations, not evidence or provider configuration. Choose collection membership separately: new repositories stay outside collection unless selected. Existing membership and project ownership are preserved unless changed through their dedicated controls.

**Prepare review** independently verifies selected GitHub identities and shows exact name, archive state and collection changes. Existing descriptions, tracking, expectations, project membership, Portfolio, Importance, resource links and source observations stay intact. New metadata can be enrolled without collecting it. To remove a source's final collection member, disable the source and edit its scope in **Settings > GitHub evidence**; this workflow does not silently disable it.

**Apply reviewed changes** saves the reviewed HQ changes together and returns a receipt. Adding or removing collection members, or renaming a collected repository, invalidates the selected source's old queued work and makes its saved scope eligible for collection. Removed members' observations expire in place; their history is not deleted. Other sources and credentials are not rewritten. An archived state by itself does not stop collection.

## Identity and stale reviews

HQ keeps derived GitHub node identities separately from repository metadata. A first name lookup follows GitHub's supported rename lookup and discloses its observed identity; it is not proof of historical ownership before that read. A previously recorded identity can verify a later rename or transfer even when the old name becomes unavailable or is reused. Contradictory identities, duplicate HQ records and reused-name conflicts require an operator decision, not an automatic merge.

Source settings, collection membership, repository revisions, selected project revisions, identity bindings, capacity and live workspace/client authority are checked again before saving. Reviews expire from the oldest verification observation, not from a reload of cached evidence. If a review becomes stale, return to choices and explicitly adopt updated HQ versions before preparing another review. Missing repositories or projects must be removed or replaced in the selection; they are not recreated implicitly.

## Recover an interrupted request

Keep the review URL, which uses the `fleetReview` query parameter. It grants no access and is bound to the original workspace, identity and credential. A preparation attempt also retains its validated, secret-free inputs in that browser tab's session storage so a reload can retry the same review ID and choices.

After an uncertain Apply, use **Check saved review** first. If no committed receipt is available, retry only that exact Apply and fingerprint. A request may finish after its response is lost. The UI does not automatically resubmit writes or allow a replacement review while an Apply is unresolved. Repeating a successful Apply returns its original receipt without reapplying metadata or creating duplicate Activity.

Closing the dialog warns about unsaved choices or an unresolved review. Normal inventory filters are retained. A review prepared but not applied can be discarded deliberately; preparing another ID is a new operation, not a retry.

## Shared commands and bounds

Use `fleet_sources`, `fleet_discover`, `fleet_reconciliation_plan`, `fleet_reconciliation_review` and `fleet_reconciliation_apply` through the [CLI or MCP](commands.md). Discovery requires live workspace read and admin authority; reviewed changes also require metadata-write authority. Reporter and publisher credentials cannot use this operator workflow. Inspect command schemas for exact input names and cursor shapes. No command accepts a provider URL, raw GraphQL, credential value or arbitrary SQL.

`FLEET_DISCOVERY_LIMITS` bounds each provider page and review selection to 25 repositories. Discovery uses one fixed GraphQL query; verification uses at most two, sharing a 25-second deadline. Source-revision-bound cursors cannot be reused with another authority or catalog. Results and saved reviews have UTF-8 byte ceilings, and pending reviews and expired-review cleanup are bounded per owner.

One latest discovery cache per source is reused for five minutes with its original observation time. Changing scope replaces an inactive cache entry but cannot overlap an active lease or bypass the shared credential quota and provider cooldown. Work, Releases and fleet discovery share that read budget. Comparing cached provider facts with HQ always uses live HQ metadata. These bounds are not a spending ceiling or proof of Free-plan compatibility; see [resource costs](diagnostics.md#cloudflare-free-plan-compatibility).

Deployment requires the additive discovery migration and a private restore test. Keep identity bindings, receipt history and the workspace-move cleanup trigger during recovery. See [fleet discovery recovery](release.md#fleet-discovery-recovery). No new credential, binding, hostname, schedule or provider grant is required.
