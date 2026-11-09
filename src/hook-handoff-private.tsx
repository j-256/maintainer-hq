import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { HANDOFF_PRIVATE_BYTES, handoffRevealSchema, handoffExportSchema, type HandoffReveal } from "../shared/hook-handoff";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

async function privateRequest<T>(action: "reveal" | "export", input: unknown, signal: AbortSignal, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch("/api/hooks/handoff/private", { method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, input }), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  if (!response.ok || response.headers.get("cache-control") !== "no-store" || !response.headers.get("content-type")?.includes("application/json") || !response.body) { void response.body?.cancel(); throw new Error(); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > HANDOFF_PRIVATE_BYTES) throw new Error(); chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } finally { void reader.cancel().catch(() => {}); }
}
function instructions(value: HandoffReveal): string {
  return [`GitHub webhook for ${value.repository} (${value.profile})`, `Settings: ${value.settingsUrl}`, `Payload URL: ${value.url}`, `Content type: ${value.contentType}`, `Secret: ${value.secret}`, "Enable SSL verification", `Select individual events: ${value.events.join(", ")}`, "Keep Active enabled. Send the GitHub ping after saving."].join("\n");
}
export function HandoffPrivatePanel({ workspaceId, connectionId, repositoryId, resourceId }: { workspaceId: string; connectionId: string; repositoryId: string; resourceId: string }) {
  const [value, setValue] = useState<HandoffReveal | null>(null);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, []);
  function hide() { controller.current?.abort(); controller.current = null; setValue(null); setNotice(""); setBusy(false); }
  async function reveal() {
    hide(); const active = new AbortController(); controller.current = active; setBusy(true);
    try {
      const result = await privateRequest("reveal", { workspaceId, connectionId, resourceId }, active.signal, handoffRevealSchema);
      if (result.resourceId !== resourceId) throw new Error();
      if (!active.signal.aborted && controller.current === active) setValue(result);
    } catch { if (!active.signal.aborted) setNotice("Private credentials are unavailable. Ask the deployment owner to check custody grants and keyring access."); }
    finally { if (!active.signal.aborted) setBusy(false); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice("Copied. Share through a private channel with the repository administrator."); }
    catch { setNotice("Clipboard access was denied. Select and copy the visible value manually."); }
  }
  async function download() {
    const active = new AbortController(); controller.current?.abort(); controller.current = active; setBusy(true); setNotice("");
    try {
      const result = await privateRequest("export", { workspaceId, connectionId, repositoryId }, active.signal, handoffExportSchema);
      if (result.record.provider.workspaceId !== workspaceId || result.record.provider.repositoryId !== repositoryId) throw new Error();
      if (active.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2) + "\n"], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = "github-hook-recovery.json"; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Private recovery downloaded. Move it into protected storage and import it with Hookrelay's recovery adapter. Browser downloads do not guarantee private file permissions.");
    } catch { if (!active.signal.aborted) setNotice("Private recovery export failed. Credentials remain in provider custody; retry this same repository."); }
    finally { if (!active.signal.aborted) setBusy(false); }
  }
  return <section className="handoff-private" aria-label="Private administrator handoff">
    <h3>Administrator handoff</h3>
    <p>Give the URL, signing secret, and event selection to the trusted repository administrator. All profiles for this repository share the signing secret.</p>
    {value ? <>
      <label htmlFor="handoff-url">Payload URL</label><Input id="handoff-url" value={value.url} readOnly autoComplete="off" />
      <Button variant="outline" onClick={() => void copy(value.url)}>Copy URL</Button>
      <label htmlFor="handoff-secret">Signing secret</label><Input id="handoff-secret" value={value.secret} readOnly autoComplete="off" />
      <Button variant="outline" onClick={() => void copy(value.secret)}>Copy secret</Button>
      <p>Content type: application/json. Enable SSL verification. Events: <code>{value.events.join(", ")}</code>.</p>
      <div className="handoff-actions"><Button onClick={() => void copy(instructions(value))}>Copy administrator instructions</Button><Button variant="outline" onClick={hide}>Hide credentials</Button></div>
    </> : <Button variant="outline" disabled={busy} onClick={() => void reveal()}>{busy ? "Opening private credentials..." : "Reveal URL and secret"}</Button>}
    <Button variant="outline" disabled={busy} onClick={() => void download()}>Download private recovery</Button>
    <p className="hook-muted">Closing this view clears revealed values. Provider custody remains available. Store a protected recovery export separately.</p>
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
