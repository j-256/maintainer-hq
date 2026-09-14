import { HOOK_SETUP_KIND } from "../shared/hook-setup";
import { HookSetupReviewDialog } from "./hook-resolution";
import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  History,
  Plus,
  RefreshCw,
  Settings2,
  Webhook,
} from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  HOOK_DELIVERY_STATES,
  HOOK_LIMITS,
  HOOK_POLICY_KIND,
  type HookConfigurationAvailability,
  type HookAssociation,
  type HookConnection,
  type HookDelivery,
  type HookResult,
  type HookSnapshot,
} from "../shared/hooks";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { HookAssociationEditor, HookConnectionEditor } from "./hook-editors";
import { HookDeliveryDetail, HookRetryReview } from "./hook-retry";
import { HookPolicyEditor } from "./hook-policy-editor";
import { HookPolicyReviewDialog } from "./hook-policy-review";
import {
  HookError,
  HookStatus,
  HookTime,
  HOOK_STATUS_LABELS,
} from "./hook-components";
import { useDateTime } from "./date-time";
import type { ResourceLinks } from "../shared/resource-links";
import {
  RelatedRepositoryLinks,
  RepositoryContext,
  ResourceRepositoriesEditor,
} from "./resource-repositories";
import "./sources.css";
import "./hooks.css";

type DeliveryCursor = HookResult<"deliveries">["nextCursor"];
type Response<T> = { result: T; capabilities: string[] };
const ALL_STATES = ":all";
const VIEWS = ["deliveries", "subscriptions", "history"] as const;

function HookPagination({
  page,
  previous,
  next,
  pending,
}: {
  page: number;
  previous: (() => void) | null;
  next: (() => void) | null;
  pending: boolean;
}) {
  return (
    <nav className="hook-pagination" aria-label="Hooks pagination">
      <span>Page {page}</span>
      <div>
        <Button
          variant="outline"
          disabled={!previous || pending}
          onClick={() => previous?.()}
        >
          <ChevronLeft size={16} aria-hidden="true" /> Previous
        </Button>
        <Button
          variant="outline"
          disabled={!next || pending}
          onClick={() => next?.()}
        >
          Next <ChevronRight size={16} aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
function HookSummary({
  data,
  onAttention,
}: {
  data: HookSnapshot;
  onAttention: () => void;
}) {
  const totals = data.deliveries.totals;
  const active =
    totals.pending + totals.queued + totals.processing + totals.retrying;
  return (
    <section aria-label="Hookrelay health sample" className="hook-summary">
      <dl className="hook-metrics">
        <div>
          <dt>
            {data.deliveries.truncated ? "Exhausted in sample" : "Exhausted"}
          </dt>
          <dd>
            <Button
              variant="ghost"
              onClick={onAttention}
              aria-label={
                "Inspect all exhausted deliveries, " +
                totals.exhausted +
                (data.deliveries.truncated ? " in sample" : " retained")
              }
              title="Inspect all exhausted deliveries"
            >
              {totals.exhausted}
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </dd>
        </div>
        <div>
          <dt>In progress</dt>
          <dd>{active}</dd>
        </div>
        <div>
          <dt>Delivered</dt>
          <dd>{totals.delivered}</dd>
        </div>
        <div>
          <dt>Filtered</dt>
          <dd>{totals.filtered}</dd>
        </div>
      </dl>
      <p className="hook-muted">
        {data.deliveries.truncated
          ? "Sampled health, not a complete inventory: the latest " +
            data.deliveries.sampled +
            " updated deliveries. Older failures may be outside this sample."
          : "Counts cover all " +
            data.deliveries.sampled +
            " retained deliveries at the time of this read."}{" "}
        Read <HookTime value={data.observedAt} />.
      </p>
      {data.signals.items.some((value) => !value.resolvedAt) ? (
        <p className="hook-notice">
          Hookrelay has unresolved operational signals in its recent sample.
          Delivery status alone does not cover ingress or retention health.
        </p>
      ) : null}
      <details className="hook-signals">
        <summary>
          Recent operational signals ({data.signals.items.length})
        </summary>
        <p className="hook-muted">
          Last successful retention pass:{" "}
          <HookTime value={data.lastRetentionAt} />.
        </p>
        {data.signals.items.length ? (
          <ul>
            {data.signals.items.map((signal, index) => (
              <li key={signal.code + signal.firstSeenAt + index}>
                <div>
                  <strong>{signal.code.replaceAll("-", " ")}</strong>
                  <Badge variant="outline">
                    {signal.resolvedAt ? "Resolved" : signal.severity}
                  </Badge>
                </div>
                <p>
                  {signal.occurrences}{" "}
                  {signal.occurrences === 1 ? "occurrence" : "occurrences"}.
                  Last seen <HookTime value={signal.lastSeenAt} />.
                </p>
                {signal.resolvedAt ? (
                  <p>
                    Resolved <HookTime value={signal.resolvedAt} />.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p>No operational signals in this sample.</p>
        )}
        {data.signals.truncated ? (
          <p className="hook-notice">
            Older operational signals are not included. This sample does not
            establish their absence.
          </p>
        ) : null}
      </details>
    </section>
  );
}
function Deliveries({
  snapshot,
  connection,
  status,
  subscription,
  onFilter,
  onInspect,
}: {
  snapshot: Snapshot;
  connection: HookConnection;
  status: HookDelivery["status"] | null;
  subscription: string | null;
  onFilter: (status: string | null, subscription: string | null) => void;
  onInspect: (delivery: HookDelivery) => void;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const [cursors, setCursors] = useState<DeliveryCursor[]>([null]);
  const [filter, setFilter] = useState(subscription ?? "");
  const cursor = cursors.at(-1) ?? null;
  const query = useQuery({
    queryKey: [
      "hooks",
      workspaceId,
      "deliveries",
      connection.id,
      connection.revision,
      status,
      subscription,
      cursor,
    ],
    queryFn: ({ signal }) =>
      command<Response<HookResult<"deliveries">>>(
        "hooks_deliveries",
        {
          workspaceId,
          connectionId: connection.id,
          status,
          subscription,
          cursor,
        },
        signal,
      ),
    staleTime: HOOK_LIMITS.REFRESH_MS,
    refetchInterval: cursor ? false : HOOK_LIMITS.REFRESH_MS,
  });
  const data = query.data?.result;
  function filterSubscription(event: FormEvent) {
    event.preventDefault();
    onFilter(status, filter.trim() || null);
  }
  function refresh() {
    if (!cursor) {
      void query.refetch();
      return;
    }
    void client.invalidateQueries({
      queryKey: [
        "hooks",
        workspaceId,
        "deliveries",
        connection.id,
        connection.revision,
        status,
        subscription,
        null,
      ],
    });
    setCursors([null]);
  }
  return (
    <section aria-labelledby="hook-deliveries-title" className="hook-section">
      <div className="hook-section-heading">
        <div>
          <h2 id="hook-deliveries-title">Deliveries</h2>
          <p>Live provider state. Inspect a delivery to review recovery.</p>
        </div>
        <Button variant="outline" disabled={query.isFetching} onClick={refresh}>
          <RefreshCw size={16} aria-hidden="true" /> Refresh
        </Button>
      </div>
      <div className="hook-filters">
        <div className="hook-field">
          <label htmlFor="hook-state">Delivery state</label>
          <Select
            value={status ?? ALL_STATES}
            onValueChange={(value) =>
              onFilter(value === ALL_STATES ? null : value, subscription)
            }
          >
            <SelectTrigger id="hook-state" aria-label="Delivery state">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATES}>All states</SelectItem>
              {HOOK_DELIVERY_STATES.map((state) => (
                <SelectItem key={state} value={state}>
                  {HOOK_STATUS_LABELS[state]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <form onSubmit={filterSubscription} className="hook-filter-form">
          <label htmlFor="hook-subscription-filter">Subscription name</label>
          <div>
            <Input
              id="hook-subscription-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Exact subscription name"
              maxLength={160}
            />
            <Button type="submit" variant="outline">
              Filter
            </Button>
            {subscription ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onFilter(status, null)}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </form>
      </div>
      {query.error ? <HookError error={query.error} /> : null}
      {query.isPending ? (
        <p className="hook-loading" role="status">
          Reading deliveries...
        </p>
      ) : null}
      {data ? (
        <>
          <div
            className="hook-table-scroll"
            role="region"
            aria-label="Delivery table, scroll horizontally on narrow screens"
            tabIndex={0}
          >
            <table className="hook-table">
              <caption className="sr-only">
                Hookrelay deliveries, most recently updated first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Event and subscription</th>
                  <th scope="col">Sink</th>
                  <th scope="col">State</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.eventId + "\u0000" + item.sinkName}>
                    <td>
                      <code>{item.eventId}</code>
                      <span>{item.subscription}</span>
                    </td>
                    <td>{item.sinkName}</td>
                    <td>
                      <HookStatus status={item.status} />
                    </td>
                    <td>
                      <HookTime value={item.updatedAt} />
                    </td>
                    <td>
                      <Button
                        variant="outline"
                        onClick={() => onInspect(item)}
                        aria-label={
                          "Inspect delivery " +
                          item.eventId +
                          " to " +
                          item.sinkName
                        }
                      >
                        Inspect
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.items.length ? (
            <div className="hook-empty">
              <Webhook size={24} aria-hidden="true" />
              <h3>
                {data.nextCursor
                  ? "No matches in this page"
                  : "No deliveries in this selection"}
              </h3>
              <p>
                {data.nextCursor
                  ? "The search is incomplete. Continue to the next bounded page to inspect older candidates."
                  : "Try another state or subscription, or refresh after Hookrelay receives events."}
              </p>
            </div>
          ) : null}
          <p className="hook-muted">
            Read <HookTime value={data.observedAt} />. Updates can move
            deliveries between live pages; refresh to start from the newest
            state.
            {subscription
              ? " Subscription filtering examines a bounded candidate page at a time."
              : ""}
          </p>
          <HookPagination
            page={cursors.length}
            previous={
              cursors.length > 1 ? () => setCursors(cursors.slice(0, -1)) : null
            }
            next={
              data.nextCursor
                ? () => setCursors([...cursors, data.nextCursor])
                : null
            }
            pending={query.isFetching}
          />
        </>
      ) : null}
    </section>
  );
}
function Subscriptions({
  snapshot,
  connection,
  onDeliveries,
  onPolicy,
}: {
  snapshot: Snapshot;
  connection: HookConnection;
  onDeliveries: (name: string) => void;
  onPolicy: (resourceId: string) => void;
}) {
  const [page, setPage] = useState<{
    identity: string;
    cursors: (string | null)[];
  }>({ identity: "legacy", cursors: [null] });
  const [editing, setEditing] = useState<HookAssociation | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [params] = useSearchParams();
  const [notice, setNotice] = useState("");
  const focus = useRef<HTMLElement | null>(null);
  function rememberFocus() {
    focus.current = document.activeElement as HTMLElement | null;
  }
  const workspaceId = snapshot.workspace.id;
  const configuration = useQuery({
    queryKey: [
      "hooks",
      workspaceId,
      "configuration",
      connection.id,
      connection.revision,
    ],
    queryFn: ({ signal }) =>
      command<HookConfigurationAvailability>(
        "hooks_configuration",
        { workspaceId, connectionId: connection.id },
        signal,
      ),
    staleTime: HOOK_LIMITS.REFRESH_MS,
  });
  const available = configuration.data?.configuration;
  const authority =
    available?.mode === "active" && available.supported.policy
      ? available
      : null;
  const paginationIdentity = authority
    ? authority.authorityId + "/" + authority.revision
    : "legacy";
  const cursors = page.identity === paginationIdentity ? page.cursors : [null];
  function setCursors(cursors: (string | null)[]) {
    setPage({ identity: paginationIdentity, cursors });
  }
  const cursor = cursors.at(-1) ?? null;
  const query = useQuery({
    queryKey: [
      "hooks",
      workspaceId,
      "subscriptions",
      connection.id,
      connection.revision,
      paginationIdentity,
      cursor,
    ],
    queryFn: async ({
      signal,
    }): Promise<
      Response<
        Omit<HookResult<"subscriptions">, "items"> & {
          items: (HookResult<"subscriptions">["items"][number] & {
            resourceId?: string;
          })[];
        }
      > & {
        associations: HookAssociation[];
        repositoryLinks: ResourceLinks[];
      }
    > => {
      if (authority) {
        const response = await command<
          Response<HookResult<"configuration_subscriptions">> & {
            associations: HookAssociation[];
            repositoryLinks: ResourceLinks[];
          }
        >(
          "hooks_policy_subscriptions",
          {
            workspaceId,
            connectionId: connection.id,
            authorityId: authority.authorityId,
            revision: authority.revision,
            cursor,
          },
          signal,
        );
        return {
          ...response,
          result: {
            ...response.result,
            disappeared: 0,
            items: response.result.items.map((item) => ({
              resourceId: item.resourceId,
              name: item.name,
              source: item.source,
              enabled: item.policy.enabled,
              sinks: item.policy.sinks,
            })),
          },
        };
      }
      return command<
        Response<HookResult<"subscriptions">> & {
          associations: HookAssociation[];
          repositoryLinks: ResourceLinks[];
        }
      >(
        "hooks_subscriptions",
        { workspaceId, connectionId: connection.id, cursor },
        signal,
      );
    },
    enabled: !configuration.isPending,
    staleTime: HOOK_LIMITS.REFRESH_MS,
  });
  const data = query.data?.result;
  const canEdit = snapshot.capabilities.includes(CAPABILITY.EDIT);
  return (
    <section
      aria-labelledby="hook-subscriptions-title"
      className="hook-section"
    >
      <div className="hook-section-heading">
        <div>
          <h2 id="hook-subscriptions-title">Subscriptions</h2>
          <p>
            Control routing and keep related projects and repositories in view.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={query.isFetching || configuration.isFetching}
          onClick={async () => {
            const fresh = await configuration.refetch();
            const next = fresh.data?.configuration;
            const nextIdentity =
              next?.mode === "active" && next.supported.policy
                ? next.authorityId + "/" + next.revision
                : "legacy";
            if (nextIdentity === paginationIdentity) void query.refetch();
          }}
        >
          <RefreshCw size={16} aria-hidden="true" /> Refresh
        </Button>
      </div>
      {configuration.error ? <HookError error={configuration.error} /> : null}
      {!configuration.isPending && !authority ? (
        <p className="hook-notice">
          {configuration.isError
            ? "Routing availability could not be verified. Subscription reads remain available below."
            : available?.mode === "legacy"
              ? "Routing is read-only until the deployment owner activates Hookrelay's online configuration. Existing routes continue to run."
              : "This Hookrelay deployment does not support the routing editor. Subscription reads remain available."}
        </p>
      ) : authority && !authority.canConfigure ? (
        <p className="permission-notice">
          This connection can read routing but its provider credential cannot
          apply changes.
        </p>
      ) : null}
      {query.error ? <HookError error={query.error} /> : null}
      {query.isPending ? (
        <p className="hook-loading" role="status">
          Reading subscriptions...
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="save-notice">
          {notice}
        </p>
      ) : null}
      {data ? (
        <>
          <div className="hook-subscription-grid">
            {data.items.map((item, index) => {
              const association = query.data!.associations.find(
                (value) => value.subscription === item.name,
              );
              const projectId = association?.projectId;
              const project = snapshot.projects.find(
                (value) => value.id === projectId,
              );
              return (
                <article
                  className="source-card"
                  key={item.resourceId ?? item.name + "/" + index}
                >
                  <div className="source-card-heading">
                    <h3>{item.name}</h3>
                    <Badge variant="outline">
                      {item.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </div>
                  <p>
                    {item.source} &middot; {item.sinks.length}{" "}
                    {item.sinks.length === 1 ? "destination" : "destinations"}
                  </p>
                  <div className="hook-sinks">
                    {item.sinks.length ? (
                      item.sinks.map((sink) => (
                        <Badge key={sink} variant="secondary">
                          {sink}
                        </Badge>
                      ))
                    ) : (
                      <span className="hook-muted">
                        No destinations configured
                      </span>
                    )}
                  </div>
                  <p>
                    {project
                      ? "Project: " + project.name
                      : "Not enrolled in a project"}
                  </p>
                  <div className="hook-actions">
                    {item.resourceId ? (
                      <Button
                        variant="outline"
                        onClick={() => onPolicy(item.resourceId!)}
                      >
                        {authority?.canConfigure &&
                        snapshot.capabilities.includes(CAPABILITY.OPERATE)
                          ? "Edit routing"
                          : "View routing"}
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      onClick={() => onDeliveries(item.name)}
                    >
                      View deliveries
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        rememberFocus();
                        setLinking(item.name);
                      }}
                    >
                      Related repositories
                    </Button>
                    {canEdit ? (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          rememberFocus();
                          setEditing(
                            association ?? {
                              subscription: item.name,
                              projectId: null,
                              revision: 0,
                            },
                          );
                        }}
                      >
                        Associate project
                      </Button>
                    ) : null}
                  </div>
                  <RelatedRepositoryLinks
                    snapshot={snapshot}
                    ids={
                      query.data!.repositoryLinks.find(
                        (value) => value.resourceKey === item.name,
                      )?.repositoryIds ?? []
                    }
                  />
                </article>
              );
            })}
          </div>
          {!data.items.length ? (
            <div className="hook-empty">
              <Webhook size={24} aria-hidden="true" />
              <h3>
                {data.nextCursor
                  ? "No subscriptions in this page"
                  : "No subscriptions recorded"}
              </h3>
              <p>
                Hookrelay remains the configuration authority. A configured
                provider with no routes is different from an unavailable
                connection.
              </p>
            </div>
          ) : null}
          {data.disappeared ? (
            <p className="hook-notice">
              Some subscriptions changed during this read. Refresh before
              treating this page as complete.
            </p>
          ) : null}
          <p className="hook-muted">
            Read <HookTime value={data.observedAt} />. Names and sink labels
            only; bearer routes and credentials stay with Hookrelay.
          </p>
          <HookPagination
            page={cursors.length}
            previous={
              cursors.length > 1 ? () => setCursors(cursors.slice(0, -1)) : null
            }
            next={
              data.nextCursor
                ? () => setCursors([...cursors, data.nextCursor])
                : null
            }
            pending={query.isFetching}
          />
        </>
      ) : null}
      {linking ? (
        <ResourceRepositoriesEditor
          key={linking}
          reference={{
            workspaceId,
            kind: "hook",
            connectionId: connection.id,
            resourceKey: linking,
          }}
          snapshot={snapshot}
          returnFocus={focus.current}
          suggestedRepositoryId={
            snapshot.repositories.find(
              (value) => value.id === params.get("repository"),
            )?.id
          }
          onClose={() => setLinking(null)}
          onSaved={() =>
            setNotice(
              "Repository links saved. Hookrelay configuration is unchanged.",
            )
          }
        />
      ) : null}
      {editing ? (
        <HookAssociationEditor
          key={editing.subscription}
          initial={editing}
          connectionId={connection.id}
          snapshot={snapshot}
          onClose={() => setEditing(null)}
          returnFocus={focus.current}
          onSaved={() => {
            setNotice(
              "Project association saved. Hookrelay configuration is unchanged.",
            );
          }}
        />
      ) : null}
    </section>
  );
}
function HookHistory({
  snapshot,
  onReceipt,
}: {
  snapshot: Snapshot;
  onReceipt: (planId: string, kind: string) => void;
}) {
  const workspaceId = snapshot.workspace.id;
  const query = useQuery({
    queryKey: ["hooks", workspaceId, "history"],
    queryFn: ({ signal }) =>
      command<
        {
          id: string;
          kind: string;
          planId: string;
          status: string;
          summary: string;
          createdAt: string;
          updatedAt: string;
        }[]
      >("hooks_history", { workspaceId }, signal),
  });
  return (
    <section className="hook-section" aria-labelledby="hook-history-title">
      <div className="hook-section-heading">
        <div>
          <h2 id="hook-history-title">Workspace Hooks operations</h2>
          <p>
            The latest {HOOK_LIMITS.HISTORY} operations requested through HQ,
            across its Hookrelay connections.
          </p>
        </div>
        <History size={22} aria-hidden="true" />
      </div>
      {query.error ? <HookError error={query.error} /> : null}
      {query.isPending ? (
        <p role="status">Loading operation receipts...</p>
      ) : null}
      {query.data ? (
        query.data.length ? (
          <div className="hook-history">
            {query.data.map((item) => (
              <article key={item.id}>
                <div>
                  <Badge variant="outline">
                    {item.status === "succeeded"
                      ? "Accepted"
                      : item.status === "failed"
                        ? "Not accepted"
                        : "Needs reconciliation"}
                  </Badge>
                  <p>{item.summary}</p>
                  <HookTime value={item.updatedAt} />
                </div>
                <Button
                  variant="outline"
                  onClick={() => onReceipt(item.planId, item.kind)}
                >
                  Open receipt
                </Button>
              </article>
            ))}
          </div>
        ) : (
          <div className="hook-empty">
            <History size={24} aria-hidden="true" />
            <h3>No Hooks operations requested through HQ</h3>
            <p>
              Reviewed operations and their recovery receipts will appear here.
              Hookrelay's own delivery history remains in the Deliveries view.
            </p>
          </div>
        )
      ) : null}
    </section>
  );
}

export function HooksView({ snapshot }: { snapshot: Snapshot }) {
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const focus = useRef<HTMLElement | null>(null);
  const workspaceId = snapshot.workspace.id;
  const date = useDateTime();
  const canAdmin = snapshot.capabilities.includes(CAPABILITY.ADMIN);
  const connections = useQuery({
    queryKey: ["hooks", workspaceId, "connections"],
    queryFn: ({ signal }) =>
      command<HookConnection[]>("hooks_connections", { workspaceId }, signal),
  });
  const connectionId = params.get("connection") ?? connections.data?.[0]?.id;
  const selected = connections.data?.find((value) => value.id === connectionId);
  const active = Boolean(selected?.enabled && selected.available);
  const view =
    VIEWS.find((value) => value === params.get("view")) ?? "deliveries";
  const summary = useQuery({
    queryKey: [
      "hooks",
      workspaceId,
      "snapshot",
      connectionId,
      selected?.revision,
    ],
    queryFn: ({ signal }) =>
      command<Response<HookSnapshot>>(
        "hooks_snapshot",
        { workspaceId, connectionId },
        signal,
      ),
    enabled: active && view !== "history",
    staleTime: HOOK_LIMITS.REFRESH_MS,
    refetchInterval: HOOK_LIMITS.REFRESH_MS,
  });
  const status =
    HOOK_DELIVERY_STATES.find((value) => value === params.get("status")) ??
    null;
  const subscription = params.get("subscription");
  const eventId = params.get("event");
  const sinkName = params.get("sink");
  const planId = params.get("review");
  const policyId = params.get("policy");
  const policyReviewId = params.get("policyReview");
  const setupReviewId = params.get("setupReview");
  function navigate(fields: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    next.set("workspace", workspaceId);
    if (connectionId) next.set("connection", connectionId);
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next);
  }
  function rememberFocus() {
    focus.current = document.activeElement as HTMLElement | null;
  }
  return (
    <div className="hooks-workspace">
      <RepositoryContext snapshot={snapshot} section="hooks" />
      <div className="page-heading">
        <div>
          <div className="eyebrow">DELIVERY OPERATIONS</div>
          <h1 tabIndex={-1}>Hooks</h1>
          <p>
            Subscriptions, delivery state, and deliberate recovery. Times use{" "}
            {date.zoneLabel}.
          </p>
        </div>
        {canAdmin ? (
          <Button
            onClick={() => {
              rememberFocus();
              setEditing(":new");
            }}
          >
            <Plus size={16} aria-hidden="true" /> Connect Hookrelay
          </Button>
        ) : null}
      </div>
      {notice ? (
        <p className="save-notice" role="status">
          {notice}
        </p>
      ) : null}
      {connections.error ? <HookError error={connections.error} /> : null}
      {connections.isPending ? (
        <p className="hook-loading" role="status">
          Loading Hookrelay connections...
        </p>
      ) : null}
      {connections.data?.length === 0 ? (
        <div className="hook-empty">
          <Webhook size={32} aria-hidden="true" />
          <h2>Bring your hooks into view</h2>
          <p>
            Connect Hookrelay to view subscriptions, inspect deliveries, and
            review retries.
          </p>
          {!canAdmin ? <p>Ask a workspace owner to add a connection.</p> : null}
          <Button asChild variant="outline">
            <Link to={"/settings?workspace=" + encodeURIComponent(workspaceId)}>
              Workspace settings
            </Link>
          </Button>
        </div>
      ) : null}
      {connections.data?.length ? (
        <div className="hook-connection-bar">
          <div className="hook-field">
            <label htmlFor="hook-connection">Connection</label>
            <Select
              value={selected?.id ?? ""}
              onValueChange={(id) =>
                navigate({
                  connection: id,
                  subscription: null,
                  event: null,
                  sink: null,
                  review: null,
                  policy: null,
                  policyReview: null,
                })
              }
            >
              <SelectTrigger
                id="hook-connection"
                aria-label="Hookrelay connection"
              >
                <SelectValue placeholder="Select a connection" />
              </SelectTrigger>
              <SelectContent>
                {connections.data.map((value) => (
                  <SelectItem key={value.id} value={value.id}>
                    {value.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selected ? (
            <>
              <Badge variant="outline">
                {!selected.enabled
                  ? "Disabled in HQ"
                  : selected.available
                    ? "Configured"
                    : "Provider unavailable"}
              </Badge>
              <span className="hook-muted">
                {selected.providerName ?? "Saved provider reference"}
              </span>
              {canAdmin ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    rememberFocus();
                    setEditing(selected.id);
                  }}
                >
                  <Settings2 size={16} aria-hidden="true" /> Connection settings
                </Button>
              ) : null}
            </>
          ) : (
            <p className="hook-notice">
              The selected connection is not available in this workspace.
            </p>
          )}
        </div>
      ) : null}
      {selected ? (
        <>
          <nav className="hook-views" aria-label="Hooks views">
            {VIEWS.map((value) => (
              <Button
                key={value}
                variant={value === view ? "secondary" : "ghost"}
                aria-current={value === view ? "page" : undefined}
                onClick={() => navigate({ view: value })}
              >
                {value === "history"
                  ? "Operations"
                  : value === "deliveries"
                    ? "Deliveries"
                    : "Subscriptions"}
              </Button>
            ))}
          </nav>
          {view !== "history" ? (
            active ? (
              <>
                {summary.error ? <HookError error={summary.error} /> : null}
                {summary.isPending ? (
                  <p role="status" className="hook-loading">
                    Reading provider health...
                  </p>
                ) : summary.data ? (
                  <HookSummary
                    data={summary.data.result}
                    onAttention={() =>
                      navigate({
                        view: "deliveries",
                        status: "exhausted",
                        subscription: null,
                      })
                    }
                  />
                ) : null}
                {view === "deliveries" ? (
                  <Deliveries
                    key={JSON.stringify([
                      selected.id,
                      selected.revision,
                      status,
                      subscription,
                    ])}
                    snapshot={snapshot}
                    connection={selected}
                    status={status}
                    subscription={subscription}
                    onFilter={(status, subscription) =>
                      navigate({ status, subscription })
                    }
                    onInspect={(item) => {
                      rememberFocus();
                      navigate({ event: item.eventId, sink: item.sinkName });
                    }}
                  />
                ) : (
                  <Subscriptions
                    key={selected.id + "/" + selected.revision}
                    snapshot={snapshot}
                    connection={selected}
                    onPolicy={(id) => {
                      rememberFocus();
                      navigate({
                        policy: id,
                        policyReview: null,
                        review: null,
                        event: null,
                        sink: null,
                      });
                    }}
                    onDeliveries={(name) =>
                      navigate({
                        view: "deliveries",
                        status: null,
                        subscription: name,
                      })
                    }
                  />
                )}
              </>
            ) : (
              <div className="hook-empty">
                <Webhook size={26} aria-hidden="true" />
                <h2>
                  {selected.enabled
                    ? "Provider connection unavailable"
                    : "This HQ connection is disabled"}
                </h2>
                <p>
                  {selected.enabled
                    ? "The scoped credential or private service binding needs attention from the deployment owner. No successful provider read is implied."
                    : "HQ will not read this connection or start new provider operations. Hookrelay's notification engine is unaffected; existing operation receipts remain available."}
                </p>
              </div>
            )
          ) : (
            <HookHistory
              snapshot={snapshot}
              onReceipt={(id, kind) => {
                rememberFocus();
                navigate({
                  review:
                    kind === HOOK_POLICY_KIND || kind === HOOK_SETUP_KIND
                      ? null
                      : id,
                  setupReview: kind === HOOK_SETUP_KIND ? id : null,
                  policyReview: kind === HOOK_POLICY_KIND ? id : null,
                  policy: null,
                  event: null,
                  sink: null,
                });
              }}
            />
          )}
        </>
      ) : null}
      {editing ? (
        <HookConnectionEditor
          key={editing}
          initial={connections.data?.find((value) => value.id === editing)}
          snapshot={snapshot}
          onClose={() => setEditing(null)}
          returnFocus={focus.current}
          onSaved={(value) => {
            setNotice(
              "Connection saved. Hookrelay routes and sinks are unchanged.",
            );
            navigate({ connection: value.id });
          }}
        />
      ) : null}
      {selected &&
      eventId &&
      sinkName &&
      !planId &&
      !policyReviewId &&
      !policyId ? (
        <HookDeliveryDetail
          key={JSON.stringify([
            selected.id,
            selected.revision,
            eventId,
            sinkName,
          ])}
          snapshot={snapshot}
          connection={selected}
          eventId={eventId}
          sinkName={sinkName}
          returnFocus={focus.current}
          onClose={() => navigate({ event: null, sink: null })}
          onReview={(id) => navigate({ review: id })}
        />
      ) : null}
      {planId && !policyReviewId && !policyId ? (
        <HookRetryReview
          key={planId}
          snapshot={snapshot}
          planId={planId}
          returnFocus={focus.current}
          onClose={() => navigate({ review: null, event: null, sink: null })}
        />
      ) : null}
      {selected && policyId ? (
        <HookPolicyEditor
          key={selected.id + "/" + policyId}
          snapshot={snapshot}
          connection={selected}
          resourceId={policyId}
          open={!policyReviewId}
          returnFocus={focus.current}
          onClose={() => navigate({ policy: null, policyReview: null })}
          onReview={(id) => navigate({ policyReview: id })}
        />
      ) : null}
      {setupReviewId ? (
        <HookSetupReviewDialog
          snapshot={snapshot}
          planId={setupReviewId}
          onClose={() => navigate({ setupReview: null })}
        />
      ) : null}
      {policyReviewId ? (
        <HookPolicyReviewDialog
          key={policyReviewId}
          snapshot={snapshot}
          planId={policyReviewId}
          returnFocus={focus.current}
          onClose={() => navigate({ policy: null, policyReview: null })}
          onBack={
            selected && policyId ? () => navigate({ policyReview: null }) : null
          }
        />
      ) : null}
    </div>
  );
}
