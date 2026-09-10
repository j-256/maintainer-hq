import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, KeyRound, Laptop, Plus, ShieldCheck } from "lucide-react";
import { CAPABILITY, type Connection, type Snapshot } from "../shared/domain";
import { sourceFreshness } from "../shared/sources";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { SourceEditor } from "./source-editor";
import { CredentialManager } from "./publisher-credentials";
import { useSourceTime } from "./date-time";
import "./repositories.css";
import "./sources.css";

export function SourceSettings({ snapshot }: { snapshot: Snapshot }) {
  const displaySourceTime = useSourceTime();
  const [editor, setEditor] = useState<Connection | "new" | null>(null);
  const [credentialSource, setCredentialSource] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const returnFocus = useRef<HTMLElement | null>(null);
  const canAdmin = snapshot.capabilities.includes(CAPABILITY.ADMIN);
  const sources = snapshot.connections.filter(
    (source) => source.provider === "local",
  );
  const selected = sources.find((source) => source.id === credentialSource);
  function rememberFocus() {
    returnFocus.current = document.activeElement as HTMLElement | null;
  }
  return (
    <>
      <section
        className="source-settings"
        aria-labelledby="source-settings-heading"
      >
        <div className="source-section-heading">
          <div>
            <div className="eyebrow">EVIDENCE SOURCES</div>
            <h1 id="source-settings-heading">Local publishers</h1>
            <p>
              Let a machine send bounded updates. The dashboard does not need
              that machine to stay online.
            </p>
          </div>
          <Button
            disabled={!canAdmin}
            onClick={() => {
              rememberFocus();
              setEditor("new");
            }}
          >
            <Plus size={16} />
            Enroll publisher
          </Button>
        </div>
        {!canAdmin ? (
          <p className="permission-notice">
            <KeyRound size={16} />
            Only workspace owners can enroll sources, change their scope, or
            manage publisher credentials.
          </p>
        ) : !snapshot.repositories.length ? (
          <p className="permission-notice">
            You can prepare a disabled, empty publisher before enrolling or
            transferring repositories.
          </p>
        ) : null}
        {notice ? (
          <p className="save-notice" role="status">
            <Check size={16} />
            {notice}
          </p>
        ) : null}
        {!sources.length ? (
          <div className="source-empty">
            <Laptop size={26} />
            <h2>No local publishers yet</h2>
            <p>
              Enroll a source, choose the repositories it may report on, then
              create its credential. Without reports, local checkout status
              stays unobserved.
            </p>
          </div>
        ) : (
          sources.map((source) => {
            const freshness = sourceFreshness(source, snapshot.observations);
            const evidence = snapshot.observations
              .filter((item) => item.sourceId === source.id)
              .sort(
                (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt),
              );
            return (
              <article
                className="source-card"
                key={source.id}
                aria-label={source.name}
              >
                <div className="source-card-heading">
                  <div>
                    <Laptop size={19} />
                    <h2>{source.name}</h2>
                  </div>
                  <Badge variant="outline" data-source-state={freshness.state}>
                    {freshness.label}
                  </Badge>
                </div>
                <p>{freshness.detail}</p>
                <div className="source-scope-links">
                  {source.repositoryIds.map((id) => {
                    const repository = snapshot.repositories.find(
                      (item) => item.id === id,
                    );
                    return repository ? (
                      <Link
                        to={
                          "/repositories/" +
                          id +
                          "?workspace=" +
                          snapshot.workspace.id
                        }
                        key={id}
                      >
                        {repository.fullName}
                      </Link>
                    ) : null;
                  })}
                </div>
                <dl className="source-metadata">
                  <div>
                    <dt>Stale after</dt>
                    <dd>{source.freshnessMinutes} minutes</dd>
                  </div>
                  <div>
                    <dt>Last observation</dt>
                    <dd>
                      {displaySourceTime(evidence[0]?.observedAt ?? null)}
                    </dd>
                  </div>
                  <div>
                    <dt>Last received</dt>
                    <dd>{displaySourceTime(source.lastSuccessAt)}</dd>
                  </div>
                </dl>
                <div className="source-card-footer">
                  <code title="Source ID">{source.id}</code>
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canAdmin}
                      onClick={() => {
                        rememberFocus();
                        setEditor(source);
                      }}
                    >
                      Edit settings
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canAdmin}
                      onClick={() => {
                        rememberFocus();
                        setCredentialSource(source.id);
                      }}
                    >
                      <KeyRound size={14} />
                      Credentials
                    </Button>
                  </div>
                </div>
              </article>
            );
          })
        )}
        <div className="source-provider-note">
          <ShieldCheck size={20} />
          <div>
            <h2>Hosted providers are separate sources</h2>
            <p>
              Hosted integrations collect their own evidence. Hookrelay is
              managed in Hooks; Endpoint Monitor is managed in Monitoring. A
              local publisher cannot claim CI, security, delivery, or monitoring
              results.
            </p>
          </div>
        </div>
        {snapshot.connections
          .filter((source) => !["local", "github"].includes(source.provider))
          .map((source) => (
            <div className="settings-card" key={source.id}>
              <h2>{source.name}</h2>
              {source.provider === "hookrelay" ? (
                <>
                  <p>
                    Inspect provider-owned subscriptions, delivery state, and
                    reviewed retry receipts in Hooks. This connection does not
                    publish repository evidence.
                  </p>
                  <Link
                    className="quiet-link"
                    to={
                      "/hooks?workspace=" +
                      encodeURIComponent(snapshot.workspace.id) +
                      "&connection=" +
                      encodeURIComponent(source.id)
                    }
                  >
                    Open Hooks
                  </Link>
                </>
              ) : (
                <p>
                  {source.lastSuccessAt
                    ? "Last provider refresh: " +
                      displaySourceTime(source.lastSuccessAt)
                    : "Provider evidence has not been received."}{" "}
                  Management for this provider is not available.
                </p>
              )}
            </div>
          ))}
        {editor ? (
          <SourceEditor
            initial={editor === "new" ? undefined : editor}
            snapshot={snapshot}
            onClose={() => setEditor(null)}
            onSaved={(source) =>
              setNotice(source.name + ": publisher settings saved")
            }
            returnFocus={returnFocus.current}
          />
        ) : null}
        {selected ? (
          <CredentialManager
            source={selected}
            snapshot={snapshot}
            onClose={() => setCredentialSource(null)}
            returnFocus={returnFocus.current}
          />
        ) : null}
      </section>
    </>
  );
}
