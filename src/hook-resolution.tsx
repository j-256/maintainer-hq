import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, RefreshCw, Webhook } from "lucide-react";
import { CAPABILITY, type Repository, type Snapshot } from "../shared/domain";
import type {
  HookConfigurationAvailability,
  HookConnection,
  HookPolicySubscription,
  HookResult,
} from "../shared/hooks";
import {
  HOOK_SETUP_EVENTS,
  HOOK_SETUP_DESTINATIONS,
  type HookSetupConfiguration,
  type HookSetupReview,
  type HookSetupStatus,
} from "../shared/hook-setup";
import type { ResourceLinks } from "../shared/resource-links";
import { expectationHref } from "../shared/expectation-resolution";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { StatusBadge } from "./components/ui/status";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { HookError, HookTime } from "./hook-components";
import { HookDestinations, HookPolicyEditor } from "./hook-policy-editor";
import { HookPolicyReviewDialog } from "./hook-policy-review";
import { DiscardDialog, useCloseGuard } from "./source-editor";
import "./hook-resolution.css";
import "./hooks.css";

type Navigate = (fields: Record<string, string | null>) => void;
function HookVerification({
  workspaceId,
  connectionId,
  resourceId,
}: {
  workspaceId: string;
  connectionId: string;
  resourceId: string;
}) {
  const query = useQuery({
    queryKey: [
      "hooks",
      workspaceId,
      "setup-verification",
      connectionId,
      resourceId,
    ],
    queryFn: ({ signal }) =>
      command<HookSetupStatus>(
        "hooks_setup_status",
        { workspaceId, connectionId, resourceId },
        signal,
      ),
    retry: false,
    staleTime: 0,
  });
  const labels: Record<HookSetupStatus["webhook"], string> = {
    installed: "Webhook installed",
    missing: "GitHub webhook missing",
    changed: "GitHub webhook settings differ",
    unverified: "Installation unverified for this subscription",
    unavailable: "GitHub verification unavailable",
    limited: "GitHub verification incomplete",
  };
  return (
    <div
      className="hook-resolution-stack"
      aria-label="Installation and delivery evidence"
    >
      {query.isPending ? (
        <p role="status">Checking installation and delivery...</p>
      ) : null}
      {query.error ? <HookError error={query.error} /> : null}
      {query.data ? (
        <>
          <StatusBadge
            tone={query.data.webhook === "installed" ? "success" : "warning"}
          >
            {labels[query.data.webhook]}
          </StatusBadge>
          <p>
            {query.data.deliveredAt ? (
              <>
                Delivery observed <HookTime value={query.data.deliveredAt} />.
              </>
            ) : (
              "No successful delivery in the checked event sample. A setup ping does not prove notification delivery."
            )}
          </p>
          <p className="field-help">
            Checked <HookTime value={query.data.observedAt} />.
          </p>
        </>
      ) : null}
      <Button
        variant="outline"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Check again
      </Button>
    </div>
  );
}
export function HookSetupReviewDialog({
  snapshot,
  planId,
  onClose,
}: {
  snapshot: Snapshot;
  planId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ["hooks", snapshot.workspace.id, "setup-review", planId],
    queryFn: ({ signal }) =>
      command<HookSetupReview>(
        "hooks_setup_get",
        { workspaceId: snapshot.workspace.id, planId },
        signal,
      ),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="hook-resolution" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Hook setup</DialogTitle>
          <DialogDescription>
            Saved review and recoverable operation progress.
          </DialogDescription>
        </DialogHeader>
        <div className="hook-resolution-scroll">
          <SetupReview
            snapshot={snapshot}
            planId={planId}
            onBusy={setBusy}
            navigate={(fields) => {
              if (!query.data) return;
              const url = new URL(
                expectationHref(
                  snapshot.workspace.id,
                  query.data.repositoryId,
                  "hooks",
                ),
                window.location.origin,
              );
              url.searchParams.set("connection", query.data.connectionId);
              for (const [key, value] of Object.entries(fields))
                if (value !== null) url.searchParams.set(key, value);
              navigate(url.pathname + url.search);
            }}
          />
        </div>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Done
        </Button>
      </DialogContent>
    </Dialog>
  );
}
function SetupReview({
  snapshot,
  planId,
  navigate,
  onBusy,
}: {
  snapshot: Snapshot;
  planId: string;
  navigate: Navigate;
  onBusy: (busy: boolean) => void;
}) {
  const workspaceId = snapshot.workspace.id;
  const client = useQueryClient();
  const key = ["hooks", workspaceId, "setup-review", planId];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      command<HookSetupReview>(
        "hooks_setup_get",
        { workspaceId, planId },
        signal,
      ),
    staleTime: 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(Date.now);
  const data = query.data;
  const receipt = data?.provider;
  const verification = useQuery({
    queryKey: [
      "hooks",
      workspaceId,
      "setup-verification",
      receipt?.resourceId,
      receipt?.updatedAt,
    ],
    queryFn: ({ signal }) =>
      command<HookSetupStatus>(
        "hooks_setup_status",
        {
          workspaceId,
          connectionId: data!.connectionId,
          resourceId: receipt!.resourceId,
        },
        signal,
      ),
    enabled: Boolean(data?.operation && receipt?.routingConfigured),
    retry: false,
    staleTime: 0,
  });
  useEffect(() => {
    if (data?.operation) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [data?.operation]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  async function act(reconcile: boolean) {
    if (!data || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await command<HookSetupReview>(
        reconcile ? "hooks_setup_reconcile" : "hooks_setup_apply",
        {
          workspaceId,
          planId,
          ...(!reconcile ? { fingerprint: data.fingerprint } : {}),
        },
        AbortSignal.timeout(30000),
      );
      client.setQueryData(key, next);
      await client.invalidateQueries({
        predicate: (entry) =>
          [
            "workspace",
            "hooks",
            "repository-coverage",
            "repository-resources",
            "repository-coverage-cache",
          ].includes(String(entry.queryKey[0])),
      });
    } catch (failure) {
      setError(failure);
      void query.refetch();
    } finally {
      setBusy(false);
    }
  }
  const canOperate = snapshot.capabilities.includes(CAPABILITY.OPERATE);
  const expired =
    data &&
    Math.min(
      Date.parse(data.expiresAt),
      receipt ? Date.parse(receipt.expiresAt) : Infinity,
    ) <= now;
  return (
    <div className="hook-resolution-stack">
      <h3>{data?.operation ? "Setup progress" : "Review hook setup"}</h3>
      {query.isPending ? <p role="status">Loading saved setup...</p> : null}
      {query.error ? (
        <>
          <HookError error={query.error} />
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry review read
          </Button>
        </>
      ) : null}
      {data && !receipt ? (
        <>
          <p>
            The provider review was not confirmed. Recover it or review the
            setup again.
          </p>
          <Button disabled={busy || !canOperate} onClick={() => void act(true)}>
            Recover saved review
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              navigate({ setupReview: null, setup: "create", resume: null })
            }
          >
            Back to setup
          </Button>
        </>
      ) : null}
      {receipt && data ? (
        <>
          <dl className="hook-setup-summary">
            <div>
              <dt>Repository</dt>
              <dd>{data.repositoryName}</dd>
            </div>
            <div>
              <dt>Connection</dt>
              <dd>{data.connectionName}</dd>
            </div>
            <div>
              <dt>Subscription</dt>
              <dd>{receipt.name}</dd>
            </div>
            <div>
              <dt>Destinations</dt>
              <dd>{receipt.sinks.join(", ")}</dd>
            </div>
            <div>
              <dt>GitHub events</dt>
              <dd>{receipt.events.join(", ")}</dd>
            </div>
          </dl>
          {!data.operation ? (
            <p>
              {receipt.action === "create"
                ? "Create this subscription, link it to the repository, and install a signed GitHub webhook."
                : "Install the GitHub webhook for this existing subscription."}{" "}
              GitHub sends a setup ping; notification delivery is verified
              separately.
            </p>
          ) : (
            <>
              <div
                className="hook-resolution-stack"
                aria-label="Hook setup progress"
              >
                <StatusBadge
                  tone={receipt.routingConfigured ? "success" : "warning"}
                >
                  {receipt.routingConfigured
                    ? "Routing configured"
                    : "Routing not confirmed"}
                </StatusBadge>
                <StatusBadge tone={data.linked ? "success" : "warning"}>
                  {data.linked
                    ? "Repository linked"
                    : "Repository link pending"}
                </StatusBadge>
                <StatusBadge
                  tone={
                    verification.data?.webhook === "installed"
                      ? "success"
                      : "warning"
                  }
                >
                  {verification.data?.webhook === "installed"
                    ? "Webhook installed"
                    : receipt.webhookInstalled
                      ? "Installation accepted; fresh verification pending"
                      : "Webhook installation incomplete"}
                </StatusBadge>
                <StatusBadge
                  tone={verification.data?.deliveredAt ? "success" : "neutral"}
                >
                  {verification.data?.deliveredAt
                    ? "Delivery observed"
                    : "Awaiting delivery evidence"}
                </StatusBadge>
              </div>
              <p role="status">{data.operation.summary}</p>
              {receipt.errorCode === "github_rejected" ? (
                <p>
                  GitHub rejected installation. Check the provider credential's
                  Webhooks permission and repository access, then review another
                  attempt.
                </p>
              ) : null}
              {receipt.status === "indeterminate" ||
              receipt.status === "installing" ? (
                <p>
                  The installation may have succeeded. Reconcile this operation
                  before attempting another installation.
                </p>
              ) : null}
              {verification.error ? (
                <HookError error={verification.error} />
              ) : null}
              {verification.data ? (
                <p className="field-help">
                  Checked <HookTime value={verification.data.observedAt} />.{" "}
                  {verification.data.deliveredAt ? (
                    <>
                      Last successful delivery{" "}
                      <HookTime value={verification.data.deliveredAt} />.
                    </>
                  ) : (
                    "A setup ping does not prove notification delivery."
                  )}
                </p>
              ) : null}
            </>
          )}
          {expired && !data.operation ? (
            <p role="status">
              This review expired. Review the saved choices again.
            </p>
          ) : null}
          {!data.actorMatches && !data.operation ? (
            <p>Only the original reviewer can apply this setup.</p>
          ) : null}
          {!canOperate ? (
            <p>Your workspace role can inspect setup but cannot apply it.</p>
          ) : null}
          {error ? <HookError error={error} /> : null}
          <div className="hook-resolution-actions">
            {!data.operation ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    navigate({
                      setupReview: null,
                      setup: "create",
                      resume: planId,
                    })
                  }
                >
                  Back to editing
                </Button>
                <Button
                  disabled={
                    busy ||
                    !canOperate ||
                    !data.actorMatches ||
                    Boolean(expired)
                  }
                  onClick={() => void act(false)}
                >
                  {busy ? "Applying setup..." : "Apply setup"}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={busy || !canOperate}
                  onClick={() => void act(true)}
                >
                  {busy ? "Reconciling..." : "Reconcile setup"}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    verification.isFetching ||
                    !receipt.routingConfigured
                  }
                  onClick={() => void verification.refetch()}
                >
                  Check verification
                </Button>
              </>
            )}
            {data.operation &&
            ["rejected", "configured", "expired", "conflict"].includes(
              receipt.status,
            ) ? (
              <Button
                disabled={busy || !canOperate}
                onClick={() =>
                  navigate({
                    setupReview: null,
                    setup: "create",
                    resume: planId,
                  })
                }
              >
                Review installation again
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function CreateHook({
  snapshot,
  repository,
  connection,
  navigate,
  configuration,
  resume,
  onBusy,
}: {
  snapshot: Snapshot;
  repository: Repository;
  connection: HookConnection;
  navigate: Navigate;
  configuration: HookSetupConfiguration;
  resume: string | null;
  onBusy: (busy: boolean) => void;
}) {
  const [name, setName] = useState(repository.fullName.replaceAll("/", "-"));
  const [sinks, setSinks] = useState<string[]>([]);
  const [events, setEvents] = useState<string[]>(["push"]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  const [error, setError] = useState<unknown>(null);
  const [base, setBase] = useState<string | null>(null);
  const attempt = useRef<{ input: string; id: string } | null>(null);
  const old = useQuery({
    queryKey: ["hooks", snapshot.workspace.id, "setup-resume", resume],
    queryFn: ({ signal }) =>
      command<HookSetupReview>(
        "hooks_setup_get",
        { workspaceId: snapshot.workspace.id, planId: resume },
        signal,
      ),
    enabled: Boolean(resume),
    staleTime: 0,
  });
  const oldReceipt = old.data?.provider;
  useEffect(() => {
    if (!oldReceipt || base !== null) return;
    setName(oldReceipt.name);
    setSinks(oldReceipt.sinks);
    setEvents(oldReceipt.events);
    setBase(
      JSON.stringify({
        name: oldReceipt.name,
        sinks: oldReceipt.sinks,
        events: oldReceipt.events,
      }),
    );
  }, [oldReceipt, base]);
  const dirty =
    JSON.stringify({ name, sinks, events }) !==
    (base ??
      JSON.stringify({
        name: repository.fullName.replaceAll("/", "-"),
        sinks: [],
        events: ["push"],
      }));
  const guard = useCloseGuard(dirty, () =>
    navigate({ setup: null, resume: null }),
  );
  const canOperate =
    snapshot.capabilities.includes(CAPABILITY.OPERATE) &&
    snapshot.capabilities.includes(CAPABILITY.EDIT);
  async function review() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const fields = {
      workspaceId: snapshot.workspace.id,
      connectionId: connection.id,
      connectionRevision: connection.revision,
      repositoryId: repository.id,
      repositoryRevision: repository.revision,
      authorityId: configuration.authorityId,
      revision: configuration.revision,
      resourceId: oldReceipt?.routingConfigured ? oldReceipt.resourceId : null,
      name: name.trim(),
      sinks,
      events,
    };
    const input = JSON.stringify(fields);
    if (attempt.current?.input !== input)
      attempt.current = { input, id: crypto.randomUUID() };
    try {
      const result = await command<HookSetupReview>(
        "hooks_setup_plan",
        { ...fields, reviewId: attempt.current.id },
        AbortSignal.timeout(30000),
      );
      guard.permitNavigation();
      navigate({ setupReview: result.id, setup: "create", resume: null });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="hook-resolution-stack">
      <h3>
        {oldReceipt?.routingConfigured
          ? "Install the GitHub webhook"
          : "Create a hook subscription"}
      </h3>
      {old.error ? <HookError error={old.error} /> : null}
      <fieldset
        disabled={busy || !canOperate || Boolean(resume && !oldReceipt)}
        className="hook-resolution-stack"
      >
        <label htmlFor="setup-name">Subscription name</label>
        <Input
          id="setup-name"
          maxLength={160}
          value={name}
          disabled={oldReceipt?.routingConfigured}
          onChange={(event) => setName(event.target.value)}
        />
        <h4>Destinations</h4>
        <HookDestinations
          limit={HOOK_SETUP_DESTINATIONS}
          workspaceId={snapshot.workspace.id}
          connectionId={connection.id}
          base={configuration}
          selected={sinks}
          onChange={setSinks}
          disabled={busy || Boolean(oldReceipt?.routingConfigured)}
        />
        <fieldset disabled={oldReceipt?.routingConfigured}>
          <legend>GitHub events</legend>
          <div className="hook-setup-events">
            {HOOK_SETUP_EVENTS.map((value) => (
              <label key={value} className="hook-checkbox">
                <Checkbox
                  checked={events.includes(value)}
                  onCheckedChange={(checked) =>
                    setEvents((previous) =>
                      checked
                        ? [...previous, value]
                        : previous.filter((item) => item !== value),
                    )
                  }
                />
                {value.replaceAll("_", " ")}
              </label>
            ))}
          </div>
        </fieldset>
        {!sinks.length ? (
          <p>
            Select an existing destination to continue. If none is available, a
            provider administrator must add one in Hookrelay.
          </p>
        ) : null}
      </fieldset>
      {error ? <HookError error={error} /> : null}
      <div className="hook-resolution-actions">
        <Button variant="outline" disabled={busy} onClick={guard.requestClose}>
          Back to subscriptions
        </Button>
        <Button
          disabled={
            busy ||
            !canOperate ||
            !configuration.canCreate ||
            !name.trim() ||
            !sinks.length ||
            !events.length ||
            Boolean(resume && !oldReceipt)
          }
          onClick={() => void review()}
        >
          {busy ? "Preparing review..." : "Review setup"}
        </Button>
      </div>
      <DiscardDialog guard={guard} busy={busy} />
    </div>
  );
}

export function HookResolution({
  snapshot,
  repository,
  onBack,
}: {
  snapshot: Snapshot;
  repository: Repository;
  onBack: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const focus = useRef<HTMLElement | null>(null);
  const client = useQueryClient();
  const workspaceId = snapshot.workspace.id;
  const canEdit = snapshot.capabilities.includes(CAPABILITY.EDIT);
  const connections = useQuery({
    queryKey: ["hooks", workspaceId, "connections"],
    queryFn: ({ signal }) =>
      command<HookConnection[]>("hooks_connections", { workspaceId }, signal),
  });
  const connectionId =
    params.get("connection") ??
    connections.data?.find((value) => value.enabled && value.available)?.id;
  const selected = connections.data?.find((value) => value.id === connectionId);
  const active = Boolean(selected?.enabled && selected.available);
  const policy = params.get("policy");
  const policyReview = params.get("policyReview");
  const setupReview = params.get("setupReview");
  const creating = params.get("setup") === "create";
  const authority = useQuery({
    queryKey: [
      "hooks",
      workspaceId,
      "resolution-authority",
      connectionId,
      selected?.revision,
    ],
    queryFn: ({ signal }) =>
      command<HookConfigurationAvailability>(
        "hooks_configuration",
        { workspaceId, connectionId },
        signal,
      ),
    enabled: active,
  });
  const setup = useQuery({
    queryKey: [
      "hooks",
      workspaceId,
      "setup-configuration",
      connectionId,
      selected?.revision,
    ],
    queryFn: ({ signal }) =>
      command<{
        status: "supported" | "unsupported";
        configuration: HookSetupConfiguration | null;
      }>("hooks_setup_configuration", { workspaceId, connectionId }, signal),
    enabled: active,
    retry: false,
  });
  const config = authority.data?.configuration;
  const online = config?.mode === "active" && config.supported.policy;
  const cursor = cursors.at(-1) ?? null;
  const inventory = useQuery({
    queryKey: [
      "hooks",
      workspaceId,
      "resolution-subscriptions",
      connectionId,
      config?.revision,
      cursor,
    ],
    queryFn: async ({ signal }) => {
      if (online)
        return command<{
          result: HookResult<"configuration_subscriptions">;
          repositoryLinks: ResourceLinks[];
        }>(
          "hooks_policy_subscriptions",
          {
            workspaceId,
            connectionId,
            authorityId: config.authorityId,
            revision: config.revision,
            cursor,
          },
          signal,
        );
      const data = await command<{
        result: HookResult<"subscriptions">;
        repositoryLinks: ResourceLinks[];
      }>("hooks_subscriptions", { workspaceId, connectionId, cursor }, signal);
      return {
        ...data,
        result: {
          ...data.result,
          items: data.result.items.map((item) => ({
            name: item.name,
            source: item.source,
            resourceId: "",
            policy: {
              enabled: item.enabled,
              sinks: item.sinks,
              filter: null,
              sinkFilters: {},
            },
          })),
        },
      };
    },
    enabled: active && Boolean(authority.data) && !creating && !setupReview,
    retry: false,
  });
  const navigate: Navigate = (fields) => {
    focus.current = document.activeElement as HTMLElement | null;
    const next = new URLSearchParams(params);
    if (connectionId) next.set("connection", connectionId);
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setParams(next);
  };
  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      await command(
        "repository_coverage",
        { workspaceId, repositoryId: repository.id },
        AbortSignal.timeout(65000),
      );
      await client.invalidateQueries({
        predicate: (query) =>
          [
            "hooks",
            "repository-coverage",
            "repository-coverage-cache",
            "workspace",
          ].includes(String(query.queryKey[0])),
      });
      setNotice(
        "Linked resources checked. Installation and delivery evidence remain separate.",
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function link(item: HookPolicySubscription) {
    if (busy || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const reference = {
        workspaceId,
        connectionId: selected.id,
        kind: "hook",
        resourceKey: item.name,
      };
      const saved = await command<ResourceLinks>(
        "resource_repositories",
        reference,
      );
      if (!saved.repositoryIds.includes(repository.id))
        await command("resource_repositories_save", {
          ...reference,
          revision: saved.revision,
          connectionRevision: selected.revision,
          repositoryIds: [...saved.repositoryIds, repository.id],
        });
      await refresh();
      setNotice(item.name + " linked to " + repository.fullName + ".");
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  const missing =
    setup.data?.status === "unsupported"
      ? "This Hookrelay version supports linking and routing. A provider update is needed for online creation."
      : setup.data?.configuration?.reason === "grant_required"
        ? "A provider administrator must grant hook setup to this connection. Existing routing access does not grant creation."
        : setup.data?.configuration?.reason === "inactive"
          ? "The provider configuration authority must be activated before online setup."
          : setup.data?.configuration?.reason === "provider_setup_required"
            ? "A provider administrator must configure the GitHub credential, setup key and ingress origin in Hookrelay."
            : null;
  return (
    <>
      <Dialog
        open={!policy && !policyReview}
        onOpenChange={(open) => {
          if (!open && !busy) onBack();
        }}
      >
        <DialogContent className="hook-resolution" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              <Webhook size={20} aria-hidden="true" /> Hook coverage
            </DialogTitle>
            <DialogDescription>{repository.fullName}</DialogDescription>
          </DialogHeader>
          <div className="hook-resolution-scroll">
            {setupReview ? (
              <SetupReview
                snapshot={snapshot}
                planId={setupReview}
                navigate={navigate}
                onBusy={setBusy}
              />
            ) : (
              <>
                {!creating ? (
                  <p>
                    Link a subscription or set one up here. Coverage checks
                    require enabled routing with a destination; GitHub
                    installation and delivery have their own evidence.
                  </p>
                ) : null}
                {connections.isPending ? (
                  <p role="status">Reading hook connections...</p>
                ) : null}
                {connections.error ? (
                  <HookError error={connections.error} />
                ) : null}
                {connections.data?.length ? (
                  <div className="form-field">
                    <label htmlFor="setup-connection">Hook connection</label>
                    <Select
                      value={selected?.id ?? ""}
                      disabled={creating || busy}
                      onValueChange={(id) => {
                        setCursors([null]);
                        navigate({ connection: id, verify: null });
                      }}
                    >
                      <SelectTrigger id="setup-connection">
                        <SelectValue placeholder="Choose a connection" />
                      </SelectTrigger>
                      <SelectContent>
                        {connections.data.map((value) => (
                          <SelectItem key={value.id} value={value.id}>
                            {value.name}
                            {!value.enabled || !value.available
                              ? " (unavailable)"
                              : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {connections.data && !active ? (
                  <div className="hook-resolution-stack">
                    <p>
                      {selected
                        ? "This connection is disabled or unavailable. An owner can update its provider access."
                        : "Choose an available Hookrelay connection. An owner can add one from Hooks."}
                    </p>
                    <Button asChild variant="outline">
                      <Link
                        to={
                          "/hooks?" +
                          new URLSearchParams({
                            workspace: workspaceId,
                            repository: repository.id,
                          })
                        }
                      >
                        Open Hooks connections
                      </Link>
                    </Button>
                  </div>
                ) : null}
                {authority.error ? <HookError error={authority.error} /> : null}
                {setup.error ? <HookError error={setup.error} /> : null}
                {missing ? <p className="hook-notice">{missing}</p> : null}
                {creating && selected && setup.data?.configuration ? (
                  <CreateHook
                    key={selected.id + "/" + (params.get("resume") ?? "new")}
                    snapshot={snapshot}
                    repository={repository}
                    connection={selected}
                    configuration={setup.data.configuration}
                    navigate={navigate}
                    resume={params.get("resume")}
                    onBusy={setBusy}
                  />
                ) : !creating && active ? (
                  <>
                    <div className="hook-resolution-actions">
                      <Button
                        disabled={
                          !setup.data?.configuration?.canCreate ||
                          !snapshot.capabilities.includes(CAPABILITY.OPERATE) ||
                          !canEdit
                        }
                        onClick={() => navigate({ setup: "create" })}
                      >
                        Create subscription
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void refresh()}
                      >
                        <RefreshCw size={16} /> Check coverage
                      </Button>
                    </div>
                    {inventory.isPending ? (
                      <p role="status">Reading subscriptions...</p>
                    ) : null}
                    {inventory.error ? (
                      <>
                        <HookError error={inventory.error} />
                        <Button onClick={() => void inventory.refetch()}>
                          Retry subscription read
                        </Button>
                      </>
                    ) : null}
                    {inventory.data?.result.items.map((item) => {
                      const links =
                        inventory.data.repositoryLinks.find(
                          (value) => value.resourceKey === item.name,
                        )?.repositoryIds ?? [];
                      const linked = links.includes(repository.id);
                      return (
                        <article
                          className="hook-resolution-subscription"
                          key={item.resourceId || item.name}
                        >
                          <h3>{item.name}</h3>
                          <StatusBadge
                            tone={
                              item.policy.enabled && item.policy.sinks.length
                                ? "success"
                                : "warning"
                            }
                          >
                            {item.policy.enabled && item.policy.sinks.length
                              ? "Routing configured"
                              : "Routing needs attention"}
                          </StatusBadge>
                          <p>
                            {item.policy.sinks.length
                              ? "Destinations: " + item.policy.sinks.join(", ")
                              : "No destinations configured"}
                          </p>
                          {links.length > (linked ? 1 : 0) ? (
                            <p>
                              Shared with {links.length - Number(linked)} other
                              repositories. Routing changes affect them too.
                            </p>
                          ) : null}
                          <div className="hook-resolution-actions">
                            <Button
                              disabled={busy || !canEdit || linked}
                              onClick={() => void link(item)}
                            >
                              {linked
                                ? "Linked to repository"
                                : "Link subscription"}
                            </Button>
                            {item.resourceId ? (
                              <Button
                                variant="outline"
                                onClick={() =>
                                  navigate({ policy: item.resourceId })
                                }
                              >
                                {config?.canConfigure &&
                                snapshot.capabilities.includes(
                                  CAPABILITY.OPERATE,
                                )
                                  ? "Configure routing"
                                  : "View routing"}
                              </Button>
                            ) : null}
                            {item.resourceId ? (
                              <Button
                                variant="outline"
                                onClick={() =>
                                  navigate({
                                    verify:
                                      params.get("verify") === item.resourceId
                                        ? null
                                        : item.resourceId,
                                  })
                                }
                              >
                                {params.get("verify") === item.resourceId
                                  ? "Hide verification"
                                  : "Check installation and delivery"}
                              </Button>
                            ) : null}
                          </div>
                          {item.resourceId &&
                          params.get("verify") === item.resourceId &&
                          selected ? (
                            <HookVerification
                              workspaceId={workspaceId}
                              connectionId={selected.id}
                              resourceId={item.resourceId}
                            />
                          ) : null}
                        </article>
                      );
                    })}
                    {inventory.data && !inventory.data.result.items.length ? (
                      <p>
                        {inventory.data.result.nextCursor
                          ? "No subscriptions in this page. Continue to the next page."
                          : "No subscriptions found. Create one to begin setup."}
                      </p>
                    ) : null}
                    <div className="hook-resolution-actions">
                      <Button
                        variant="outline"
                        disabled={cursors.length < 2 || inventory.isFetching}
                        onClick={() => setCursors(cursors.slice(0, -1))}
                      >
                        Previous subscriptions
                      </Button>
                      <Button
                        variant="outline"
                        disabled={
                          !inventory.data?.result.nextCursor ||
                          inventory.isFetching
                        }
                        onClick={() =>
                          setCursors([
                            ...cursors,
                            inventory.data!.result.nextCursor,
                          ])
                        }
                      >
                        Next subscriptions
                      </Button>
                    </div>
                  </>
                ) : null}
              </>
            )}
            {error ? <HookError error={error} /> : null}
            {notice ? <p role="status">{notice}</p> : null}
          </div>
          <div className="hook-resolution-actions">
            <Button variant="outline" disabled={busy} onClick={onBack}>
              <ArrowLeft size={16} /> Back to expectations
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {selected && policy ? (
        <HookPolicyEditor
          snapshot={snapshot}
          connection={selected}
          resourceId={policy}
          open={!policyReview}
          returnFocus={focus.current}
          onClose={() => {
            navigate({ policy: null, policyReview: null });
            void refresh();
          }}
          onReview={(id) => navigate({ policyReview: id })}
        />
      ) : null}
      {policyReview ? (
        <HookPolicyReviewDialog
          snapshot={snapshot}
          planId={policyReview}
          returnFocus={focus.current}
          onClose={() => {
            navigate({ policy: null, policyReview: null });
            void refresh();
          }}
          onBack={policy ? () => navigate({ policyReview: null }) : null}
        />
      ) : null}
    </>
  );
}
