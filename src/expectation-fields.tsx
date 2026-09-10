import { DEFAULT_EXPECTATIONS, type Expectations } from "../shared/domain";
import {
  EXPECTATION_KEYS,
  type ExpectationKey,
  type ExpectationPatch,
} from "../shared/expectation-bulk";
import {
  EXPECTATION_HELP,
  EXPECTATION_LABELS,
  REQUIREMENT_LABELS,
} from "../shared/presentation";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

export const BULK_FIELD_LABELS: Record<ExpectationKey, string> = {
  ...EXPECTATION_LABELS,
  visibility: "Expected visibility",
  reviewDate: "Review date",
  note: "Note",
};
const VISIBILITY_LABELS = {
  any: "Any visibility",
  public: "Public",
  private: "Private",
};

export function ExpectationFields({
  id,
  patch,
  onChange,
  defaults = DEFAULT_EXPECTATIONS,
  exception = false,
}: {
  id: string;
  patch: ExpectationPatch;
  onChange: (patch: ExpectationPatch) => void;
  defaults?: Expectations;
  exception?: boolean;
}) {
  function value<K extends ExpectationKey>(key: K, next: Expectations[K]) {
    onChange({ ...patch, [key]: next });
  }
  return (
    <div className="expectation-fields">
      {EXPECTATION_KEYS.map((key) => {
        const active = patch[key] !== undefined;
        const label = BULK_FIELD_LABELS[key];
        const fieldId = id + "-" + key;
        return (
          <div className="expectation-field" key={key}>
            <div className="expectation-choice">
              <Checkbox
                id={fieldId + "-change"}
                checked={active}
                onCheckedChange={(checked) => {
                  const next = { ...patch };
                  if (checked) Object.assign(next, { [key]: defaults[key] });
                  else delete next[key];
                  onChange(next);
                }}
              />
              <label htmlFor={fieldId + "-change"}>
                {exception ? "Override " : "Change "}
                {label}
              </label>
            </div>
            {active ? (
              key === "note" ? (
                <Textarea
                  id={fieldId}
                  aria-label={label}
                  maxLength={1500}
                  value={patch.note ?? ""}
                  onChange={(event) => value("note", event.target.value)}
                />
              ) : key === "reviewDate" ? (
                <Input
                  id={fieldId}
                  aria-label={label}
                  type="date"
                  value={patch.reviewDate ?? ""}
                  onChange={(event) =>
                    value("reviewDate", event.target.value || null)
                  }
                />
              ) : (
                <Select
                  value={patch[key] as string}
                  onValueChange={(next) =>
                    value(key, next as Expectations[typeof key])
                  }
                >
                  <SelectTrigger id={fieldId} aria-label={label}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(
                      key === "visibility"
                        ? VISIBILITY_LABELS
                        : REQUIREMENT_LABELS,
                    ).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            ) : (
              <p className="expectation-muted">
                {exception
                  ? "Use batch choice"
                  : "Keep each repository's value"}
              </p>
            )}
            {active && key in EXPECTATION_HELP ? (
              <p className="expectation-muted">
                {EXPECTATION_HELP[key as keyof typeof EXPECTATION_HELP]}
              </p>
            ) : null}
            {active && key === "reviewDate" ? (
              <p className="expectation-muted">
                An empty date clears the selected repositories' review date.
              </p>
            ) : null}
            {active && key === "note" ? (
              <p className="expectation-muted">
                Replaces the entire note for these repositories. An empty note
                clears it.
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
