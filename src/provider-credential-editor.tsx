import { useRef, useState, type FormEvent } from "react";
import type { Snapshot } from "../shared/domain";
import {
  providerCredentialFieldsSchema,
  providerResourceNames,
  PROVIDER_CREDENTIAL_KIND,
  PROVIDER_CREDENTIAL_LABELS,
  type ProviderCredentialKind,
  type ProviderCredential,
  type ProviderCredentialReview,
} from "../shared/provider-credentials";
import { SECRET_PROVIDER_KIND } from "../shared/secrets";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
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
import { DiscardDialog, useCloseGuard } from "./source-editor";
import { SecretError } from "./secret-components";

const MINUTE_MS = 60 * 1000;
type Draft = {
  name: string;
  providerKind: ProviderCredentialKind;
  expires: string;
  writable: boolean;
  accountId: string;
  resources: string;
  replaceToken: boolean;
};
function localExpiry(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * MINUTE_MS)
    .toISOString()
    .slice(0, 16);
}
function fields(
  value?: ProviderCredential,
  initialKind: ProviderCredentialKind = SECRET_PROVIDER_KIND.GITHUB,
): Draft {
  return {
    name: value?.settings.name ?? "",
    providerKind: value?.settings.providerKind ?? initialKind,
    expires: value ? localExpiry(value.settings.expiresAt) : "",
    writable: value?.settings.writable ?? false,
    accountId:
      value?.settings.providerKind === SECRET_PROVIDER_KIND.CLOUDFLARE
        ? value.settings.scope.accountId
        : "",
    resources: value ? providerResourceNames(value).join("\n") : "",
    replaceToken: !value || value.status !== "available",
  };
}
export function ProviderCredentialEditor({
  snapshot,
  initial,
  initialKind = SECRET_PROVIDER_KIND.GITHUB,
  onClose,
  onReview,
  returnFocus,
}: {
  snapshot: Snapshot;
  initial?: ProviderCredential;
  initialKind?: ProviderCredentialKind;
  onClose: () => void;
  onReview: (review: ProviderCredentialReview) => void;
  returnFocus: HTMLElement | null;
}) {
  const [draft, setDraft] = useState(() => fields(initial, initialKind));
  const [credentialId] = useState(
    () => initial?.id ?? "managed-" + crypto.randomUUID(),
  );
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const form = useRef<HTMLFormElement>(null);
  const planned = useRef(false);
  const guard = useCloseGuard(
    JSON.stringify(draft) !== JSON.stringify(fields(initial, initialKind)) ||
      busy,
    onClose,
  );
  const names = draft.resources
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const repositories = snapshot.repositories.filter((repo) =>
    repo.fullName.toLowerCase().includes(filter.toLowerCase()),
  );
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (busy || !form.current?.reportValidity()) return;
    const expires = Date.parse(draft.expires);
    const parsed = providerCredentialFieldsSchema.safeParse({
      providerKind: draft.providerKind,
      name: draft.name,
      writable: draft.writable,
      expiresAt: Number.isFinite(expires)
        ? new Date(expires).toISOString()
        : "",
      scope:
        draft.providerKind !== SECRET_PROVIDER_KIND.CLOUDFLARE
          ? { repositoryNames: names }
          : { accountId: draft.accountId.trim(), workerNames: names },
    });
    if (!parsed.success || expires <= Date.now()) {
      setError(
        new Error(
          "Enter a name, a future local cutoff and a nonempty scope without duplicate or invalid resource names. Cloudflare also requires its account ID.",
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const review = await command<ProviderCredentialReview>(
        "provider_credential_plan",
        {
          workspaceId: snapshot.workspace.id,
          credentialId,
          revision: initial?.revision ?? 0,
          change: {
            kind: "save",
            settings: parsed.data,
            replaceToken: draft.replaceToken,
          },
        },
      );
      planned.current = true;
      guard.saved();
      onReview(review);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) guard.requestClose();
        }}
      >
        <DialogContent
          className="secret-dialog provider-dialog"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (planned.current) return;
            (returnFocus?.isConnected
              ? returnFocus
              : document.querySelector<HTMLElement>("#main-content")
            )?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {initial ? "Edit provider access" : "Add provider access"}
            </DialogTitle>
            <DialogDescription>
              Choose what this credential may reach. Review its effects before
              entering a token through the separate private input.
            </DialogDescription>
          </DialogHeader>
          <form ref={form} className="secret-form" onSubmit={prepare}>
            <fieldset className="provider-fields" disabled={busy}>
              <label className="hook-field">
                Name
                <Input
                  required
                  maxLength={80}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                  placeholder="Production Workers or product repositories"
                />
              </label>
              <div className="hook-field">
                <label htmlFor="credential-provider">Provider</label>
                <Select
                  value={draft.providerKind}
                  disabled={
                    busy ||
                    Boolean(initial) ||
                    initialKind === PROVIDER_CREDENTIAL_KIND.REPOSITORY
                  }
                  onValueChange={(providerKind: ProviderCredentialKind) =>
                    setDraft({
                      ...draft,
                      providerKind,
                      resources: "",
                      accountId: "",
                      replaceToken: true,
                    })
                  }
                >
                  <SelectTrigger id="credential-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {initialKind === PROVIDER_CREDENTIAL_KIND.REPOSITORY ? (
                      <SelectItem value={PROVIDER_CREDENTIAL_KIND.REPOSITORY}>
                        {
                          PROVIDER_CREDENTIAL_LABELS[
                            PROVIDER_CREDENTIAL_KIND.REPOSITORY
                          ]
                        }
                      </SelectItem>
                    ) : (
                      <>
                        <SelectItem value={SECRET_PROVIDER_KIND.GITHUB}>
                          GitHub Actions
                        </SelectItem>
                        <SelectItem value={SECRET_PROVIDER_KIND.CLOUDFLARE}>
                          Cloudflare Workers
                        </SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <label className="hook-field">
                Stop using in HQ (local time)
                <Input
                  required
                  type="datetime-local"
                  value={draft.expires}
                  onChange={(event) =>
                    setDraft({ ...draft, expires: event.target.value })
                  }
                  aria-describedby="credential-expiry-help"
                />
              </label>
              <p className="hook-muted" id="credential-expiry-help">
                Choose a cutoff no later than the provider token's expiry. This
                does not change or extend its upstream lifetime.
              </p>
              {draft.providerKind === SECRET_PROVIDER_KIND.CLOUDFLARE ? (
                <label className="hook-field">
                  Cloudflare account ID
                  <Input
                    required
                    pattern="[a-f0-9]{32}"
                    maxLength={32}
                    value={draft.accountId}
                    onChange={(event) =>
                      setDraft({ ...draft, accountId: event.target.value })
                    }
                    placeholder="Account ID, not a zone ID"
                    spellCheck={false}
                    autoCapitalize="none"
                  />
                </label>
              ) : null}
              <fieldset className="secret-destination">
                <legend>
                  {draft.providerKind !== SECRET_PROVIDER_KIND.CLOUDFLARE
                    ? "Allowed repositories"
                    : "Allowed Workers"}
                </legend>
                {draft.providerKind !== SECRET_PROVIDER_KIND.CLOUDFLARE &&
                snapshot.repositories.length ? (
                  <>
                    <Input
                      aria-label="Filter workspace repositories"
                      placeholder="Find a workspace repository"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                    />
                    <div className="secret-choices">
                      {repositories.map((repo) => (
                        <label key={repo.id}>
                          <Checkbox
                            checked={names.some(
                              (name) =>
                                name.toLowerCase() ===
                                repo.fullName.toLowerCase(),
                            )}
                            disabled={busy}
                            onCheckedChange={(checked) =>
                              setDraft({
                                ...draft,
                                resources: (checked
                                  ? [...names, repo.fullName]
                                  : names.filter(
                                      (name) =>
                                        name.toLowerCase() !==
                                        repo.fullName.toLowerCase(),
                                    )
                                ).join("\n"),
                              })
                            }
                          />
                          <span>{repo.fullName}</span>
                        </label>
                      ))}
                      {!repositories.length ? (
                        <p className="hook-muted">
                          No matching workspace repositories.
                        </p>
                      ) : null}
                    </div>
                  </>
                ) : null}
                <label className="hook-field">
                  {draft.providerKind !== SECRET_PROVIDER_KIND.CLOUDFLARE
                    ? "Repository names, one owner/repository per line"
                    : "Worker names, one per line"}
                  <Textarea
                    required
                    rows={4}
                    value={draft.resources}
                    onChange={(event) =>
                      setDraft({ ...draft, resources: event.target.value })
                    }
                    spellCheck={false}
                    autoCapitalize="none"
                  />
                </label>
                <p className="hook-muted">
                  This is HQ's allowlist, not an upstream permission grant.{" "}
                  {draft.providerKind !== SECRET_PROVIDER_KIND.CLOUDFLARE
                    ? "You can verify a repository before enrolling it in HQ."
                    : "Use a dedicated account-scoped token. A Worker is its own provider resource; it does not need a repository."}
                </p>
              </fieldset>
              {draft.providerKind === PROVIDER_CREDENTIAL_KIND.REPOSITORY ? (
                <p className="hook-muted">
                  Use a dedicated token with Contents and Pull requests write
                  permissions. This connection creates maintenance branches and
                  PRs; it cannot manage Secrets or merge changes.
                </p>
              ) : null}
              <label className="secret-checkbox">
                <Checkbox
                  checked={draft.writable}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    setDraft({ ...draft, writable: checked === true })
                  }
                />
                <span>
                  Allow explicitly reviewed writes. Read access alone does not
                  prove the token can write.
                </span>
              </label>
              {initial ? (
                <label className="secret-checkbox">
                  <Checkbox
                    checked={draft.replaceToken}
                    disabled={busy || initial.status !== "available"}
                    onCheckedChange={(checked) =>
                      setDraft({ ...draft, replaceToken: checked === true })
                    }
                  />
                  <span>
                    Replace the token through private input after review
                    {initial.status !== "available"
                      ? " (required for unavailable credentials)"
                      : ""}
                  </span>
                </label>
              ) : null}
            </fieldset>
            {error ? <SecretError error={error} /> : null}
            <div className="secret-actions">
              <Button type="submit" disabled={busy}>
                {busy ? "Preparing review..." : "Review access"}
              </Button>
              <Button
                variant="outline"
                type="button"
                disabled={busy}
                onClick={guard.requestClose}
              >
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <DiscardDialog guard={guard} busy={busy} />
    </>
  );
}
