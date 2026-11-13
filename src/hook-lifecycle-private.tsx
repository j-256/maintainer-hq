import { useEffect, useRef, useState } from "react";
import type { LifecycleReview } from "../shared/hook-lifecycle";
import { supplyLifecycleInput } from "../shared/hook-lifecycle-input";
import { command } from "./lib/api";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";

export function LifecyclePrivateInput({ review, onSubmitted }: { review: LifecycleReview; onSubmitted: () => void }) {
  const type = review.after?.type;
  const [url, setUrl] = useState(""); const [topic, setTopic] = useState(""); const [token, setToken] = useState(""); const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  function clear() { setUrl(""); setTopic(""); setToken(""); setSecret(""); }
  useEffect(() => () => { active.current?.abort(); }, []);
  useEffect(() => {
    active.current?.abort(); active.current = null;
    clear(); setBusy(false); setError("");
    return () => { active.current?.abort(); };
  }, [review.id, review.workspaceId, review.fingerprint, review.canSupplyPrivate, type]);
  async function submit() {
    if (busy) return;
    setBusy(true); setError(""); const controller = new AbortController(); active.current = controller;
    const draft = type === "ntfy" ? { type, topic, ...(url ? { server: url } : {}), ...(token ? { token } : {}) } : type === "discord" ? { type, url } : { type: "webhook", url, signingSecret: secret };
    clear();
    try {
      await supplyLifecycleInput({ selection: { workspaceId: review.workspaceId, planId: review.id, fingerprint: review.fingerprint },
        review: input => command("hooks_lifecycle_get", { workspaceId: input.workspaceId, planId: input.planId }, controller.signal),
        read: async () => new TextEncoder().encode(JSON.stringify(draft)),
        send: (path, init) => fetch(path, { ...init, credentials: "same-origin", signal: AbortSignal.any([controller.signal, init.signal!]) }),
      });
      if (!controller.signal.aborted) onSubmitted();
    } catch { if (!controller.signal.aborted) { setError("Private acceptance is uncertain or was refused. Refresh this review, correct rejected input, or reconcile interrupted acceptance before supplying another value. The input draft was cleared."); onSubmitted(); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className="lifecycle-private" aria-label="Private destination input">
    <h3>Private destination configuration</h3>
    <p>Supply credentials after checking this review. Values are sent through a separate protected endpoint and cleared on submission or close.</p>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy || !review.canSupplyPrivate}>
        {type === "ntfy" ? <>
          <label htmlFor="lifecycle-server">Server (optional)</label><Input id="lifecycle-server" type="url" autoComplete="off" value={url} onChange={event => setUrl(event.target.value)} />
          <label htmlFor="lifecycle-topic">Topic</label><Input id="lifecycle-topic" type="password" autoComplete="off" required value={topic} onChange={event => setTopic(event.target.value)} />
          <label htmlFor="lifecycle-token">Token (optional)</label><Input id="lifecycle-token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} />
        </> : <><label htmlFor="lifecycle-url">Destination URL</label><Input id="lifecycle-url" type="password" autoComplete="off" required value={url} onChange={event => setUrl(event.target.value)} /></>}
        {type === "webhook" ? <><label htmlFor="lifecycle-signing-secret">Signing secret</label><Input id="lifecycle-signing-secret" type="password" autoComplete="off" required value={secret} onChange={event => setSecret(event.target.value)} /></> : null}
        <Button type="submit">{busy ? "Supplying private input..." : "Supply private destination"}</Button>
      </fieldset>
    </form>
    {!review.canSupplyPrivate ? <p>Private input needs the original actor and credential, unchanged membership and connection, and provider provision and custody grants. Refresh or ask the deployment owner to restore authority.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
