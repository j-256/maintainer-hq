import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  Clock3,
  KeyRound,
  Laptop,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { CAPABILITY, type Connection, type Snapshot } from "../shared/domain";
import { sourceFreshness } from "../shared/sources";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Disclosure } from "@/components/ui/disclosure";
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
            <h1 className="page-title" id="source-settings-heading">
              <Laptop size={26} aria-hidden="true" />
              Local publishers
            </h1>
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
            Only workspace owners can enroll publishers, change their scope, or
            manage credentials.
          </p>
        ) : !snapshot.repositories.length ? (
          <p className="permission-notice">
            No repositories are enrolled. Prepare an empty publisher with
            publishing disabled.
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
            <h2>No local publishers</h2>
            <p>Enroll a machine to report checkout state.</p>
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
                <Disclosure title="Report details" icon={Clock3}>
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
                    <div>
                      <dt>Source ID</dt>
                      <dd>{source.id}</dd>
                    </div>
                  </dl>
                </Disclosure>
                <div className="source-card-footer">
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
        {!sources.length ? (
          <p className="permission-notice">
            Local checkout state is unobserved until reports arrive.
          </p>
        ) : null}
        <Disclosure title="Publisher permissions" icon={ShieldCheck}>
          <p>
            A publisher can report local checkout observations for its allowed
            repositories. It cannot read workspace data, edit expectations, run
            operations, or report CI, security, delivery, or monitoring results.
          </p>
          <p>
            GitHub, Hookrelay, and Endpoint Monitor collect their own evidence.
            Manage Hookrelay in Hooks and Endpoint Monitor in Monitoring.
          </p>
          {snapshot.connections
            .filter((source) => !["local", "github"].includes(source.provider))
            .map((source) => (
              <div className="settings-card" key={source.id}>
                <h2>{source.name}</h2>
                {source.provider === "hookrelay" ? (
                  <>
                    <p>
                      Inspect subscriptions, deliveries, and retry receipts in
                      Hooks. This connection does not publish repository
                      evidence.
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
        </Disclosure>
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
