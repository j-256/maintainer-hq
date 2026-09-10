import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Clock3, Globe2 } from "lucide-react";
import { CAPABILITY, type Snapshot } from "../shared/domain";
import {
  DATE_FORMATS,
  LOCAL_TIME_ZONE,
  type PreferenceRecord,
  type UserPreferences,
} from "../shared/preferences";
import { createDateTimeFormatter } from "../shared/date-time";
import { command } from "./lib/api";
import { Button } from "./components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { DiscardDialog, useCloseGuard } from "./source-editor";
import { useDateTime } from "./date-time";
import "./preferences.css";

const REQUEST_TIMEOUT_MS = 15000;
const suffix = (workspaceId: string) =>
  "?workspace=" + encodeURIComponent(workspaceId);

export function PreferenceSummary({ workspaceId }: { workspaceId: string }) {
  const date = useDateTime();
  return (
    <section
      className="settings-card preferences-summary"
      aria-labelledby="preferences-title"
    >
      <div>
        <h2 id="preferences-title">
          <Clock3 size={19} aria-hidden="true" /> Date and time
        </h2>
        <p>
          Personal display preferences across your workspaces. Times use{" "}
          {date.zoneLabel}.
        </p>
      </div>
      <Button asChild variant="outline">
        <Link to={"/settings/preferences" + suffix(workspaceId)}>
          Date and time preferences
        </Link>
      </Button>
    </section>
  );
}

export function PreferenceSettings({
  snapshot,
  record,
  onSaved,
}: {
  snapshot: Snapshot;
  record: PreferenceRecord;
  onSaved: (record: PreferenceRecord) => void;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState<{
    base: PreferenceRecord;
    draft: UserPreferences;
  } | null>(null);
  const dirty =
    editing !== null &&
    JSON.stringify(editing.draft) !== JSON.stringify(editing.base.preferences);
  const base = dirty ? editing.base : record;
  const draft = dirty ? editing.draft : record.preferences;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(false);
  const guard = useCloseGuard(dirty || busy, () =>
    navigate("/settings" + suffix(snapshot.workspace.id)),
  );
  const canEdit = snapshot.capabilities.includes(CAPABILITY.PREFERENCES);
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = useMemo(() => {
    const catalog = new Set(Intl.supportedValuesOf("timeZone"));
    if (record.preferences.timeZone !== LOCAL_TIME_ZONE)
      catalog.add(record.preferences.timeZone);
    catalog.delete("UTC");
    return ["UTC", ...Array.from(catalog).sort()];
  }, [record.preferences.timeZone]);
  const preview = useMemo(
    () => createDateTimeFormatter(draft, localTimeZone),
    [draft, localTimeZone],
  );
  const previewAt = new Date().toISOString();
  const newer = record.revision > base.revision;
  function change(next: UserPreferences) {
    setEditing({ base, draft: next });
    setSaved(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canEdit || busy || !dirty) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await command<PreferenceRecord>(
        "preferences_update",
        {
          workspaceId: snapshot.workspace.id,
          revision: base.revision,
          preferences: draft,
        },
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      );
      onSaved(result);
      setEditing(null);
      setSaved(true);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Preferences could not be saved. Your draft is still here.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function loadSaved() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await command<PreferenceRecord>(
        "preferences_get",
        {
          workspaceId: snapshot.workspace.id,
        },
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      );
      onSaved(result);
      setEditing(null);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Saved preferences could not be loaded. Your draft is still here.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PERSONAL PREFERENCES</div>
          <h1>Date and time</h1>
          <p>Make timestamps comfortable to read, everywhere in HQ.</p>
        </div>
        <Button variant="ghost" onClick={guard.requestClose}>
          <ArrowLeft size={16} /> Settings
        </Button>
      </div>
      <section
        className="settings-card preferences-editor"
        aria-labelledby="preferences-form-title"
      >
        <h2 id="preferences-form-title">Your display preferences</h2>
        <p>
          Saved to your account, not this workspace or device. Other users keep
          their own settings.
        </p>
        <form onSubmit={(event) => void save(event)}>
          <fieldset disabled={busy || !canEdit} className="preferences-fields">
            <legend className="sr-only">Date and time formats</legend>
            <div className="preferences-field">
              <label id="preference-date-label">Date format</label>
              <Select
                value={draft.dateFormat}
                onValueChange={(dateFormat) =>
                  change({
                    ...draft,
                    dateFormat: dateFormat as UserPreferences["dateFormat"],
                  })
                }
                disabled={busy || !canEdit}
              >
                <SelectTrigger
                  aria-labelledby="preference-date-label"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATE_FORMATS.map((format) => (
                    <SelectItem key={format} value={format}>
                      {format}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="preferences-field">
              <label id="preference-clock-label">Clock</label>
              <Select
                value={draft.clockFormat}
                onValueChange={(clockFormat) =>
                  change({
                    ...draft,
                    clockFormat: clockFormat as UserPreferences["clockFormat"],
                  })
                }
                disabled={busy || !canEdit}
              >
                <SelectTrigger
                  aria-labelledby="preference-clock-label"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="24h">24-hour clock</SelectItem>
                  <SelectItem value="12h">12-hour clock (AM/PM)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="preferences-field">
              <label id="preference-zone-label">Time zone</label>
              <Select
                value={draft.timeZone}
                onValueChange={(timeZone) => change({ ...draft, timeZone })}
                disabled={busy || !canEdit}
              >
                <SelectTrigger
                  aria-labelledby="preference-zone-label"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">
                    Local time ({localTimeZone})
                  </SelectItem>
                  {zones.map((zone) => (
                    <SelectItem key={zone} value={zone}>
                      {zone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="field-help">
                Local follows this browser. Named zones follow their
                daylight-saving rules. Type a zone name while the menu is open.
              </p>
            </div>
          </fieldset>
          <div
            className="preferences-preview"
            role="group"
            aria-label="Date and time preview"
          >
            <span className="eyebrow">PREVIEW</span>
            <time dateTime={previewAt} title={preview.tooltip(previewAt)}>
              {preview.dateTime(previewAt, true)}
            </time>
            <span>
              <Globe2 size={15} aria-hidden="true" /> {preview.zoneLabel}
            </span>
          </div>
          <p className="preferences-explanation">
            Only display changes. Stored timestamps and collection schedules
            remain unchanged. Calendar-only review deadlines keep their original
            day.
          </p>
          {!canEdit ? (
            <p className="permission-notice">
              This credential cannot change personal preferences. Use your
              signed-in browser or a permitted human session.
            </p>
          ) : null}
          {newer && dirty ? (
            <p role="status">
              Your saved preferences changed elsewhere. Your draft is still
              here.
            </p>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {saved ? (
            <p className="preferences-saved" role="status">
              Preferences saved. Display changes apply across HQ.
            </p>
          ) : null}
          <div className="form-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={guard.requestClose}
            >
              Cancel
            </Button>
            {error || newer ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setReload(true)}
              >
                Load saved preferences
              </Button>
            ) : null}
            <Button type="submit" disabled={busy || !dirty || !canEdit}>
              {busy ? "Saving..." : "Save preferences"}
            </Button>
          </div>
        </form>
      </section>
      <DiscardDialog guard={guard} busy={busy} />
      <AlertDialog open={reload} onOpenChange={setReload}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Load saved preferences?</AlertDialogTitle>
            <AlertDialogDescription>
              This discards your draft only after the saved preferences load
              successfully.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={() => void loadSaved()}>
              Load saved preferences
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
