import { useId } from "react";
import {
  HOOK_POLICY_LIMITS,
  HOOK_SEVERITIES,
  type HookPolicy,
  type HookPolicyFilter,
} from "../shared/hooks";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { toggleHookValue, type HookFilterDraft } from "./lib/hook-policy-draft";

const PATTERN_DRAFT_MAX_LENGTH =
  HOOK_POLICY_LIMITS.PATTERNS * (HOOK_POLICY_LIMITS.PATTERN_LENGTH + 2);

export function HookFilterFields({
  value,
  onChange,
  disabled,
}: {
  value: HookFilterDraft;
  onChange: (value: HookFilterDraft) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="hook-policy-filter-fields">
      <p className="hook-muted" id={id + "-hint"}>
        Leave fields empty to allow all events. Separate event types with
        commas: github.push, github.* or *. Exclusions take precedence.
      </p>
      <div className="hook-policy-columns">
        {(["includeEvents", "excludeEvents"] as const).map((field) => (
          <label className="hook-field" key={field}>
            <span>
              {field === "includeEvents"
                ? "Include event types"
                : "Exclude event types"}
            </span>
            <Input
              value={value[field]}
              maxLength={PATTERN_DRAFT_MAX_LENGTH}
              disabled={disabled}
              aria-describedby={id + "-hint"}
              placeholder={
                field === "includeEvents" ? "All event types" : "None excluded"
              }
              onChange={(event) =>
                onChange({ ...value, [field]: event.target.value })
              }
            />
          </label>
        ))}
      </div>
      <div className="hook-policy-columns">
        {(["includeSeverities", "excludeSeverities"] as const).map((field) => (
          <fieldset
            className="hook-policy-severities"
            key={field}
            disabled={disabled}
          >
            <legend>
              {field === "includeSeverities"
                ? "Include severities"
                : "Exclude severities"}
            </legend>
            {HOOK_SEVERITIES.map((severity) => (
              <label className="hook-checkbox" key={severity}>
                <Checkbox
                  disabled={disabled}
                  checked={value[field].includes(severity)}
                  onCheckedChange={(checked) =>
                    onChange({
                      ...value,
                      [field]: toggleHookValue(
                        value[field],
                        severity,
                        checked === true,
                      ),
                    })
                  }
                />
                <span>{severity}</span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
    </div>
  );
}

function FilterSummary({ value }: { value?: HookPolicyFilter | null }) {
  if (!value) return <span>No additional filters</span>;
  return (
    <ul className="hook-policy-filter-summary">
      {value.eventTypes?.include ? (
        <li>Include types: {value.eventTypes.include.join(", ")}</li>
      ) : null}
      {value.eventTypes?.exclude ? (
        <li>Exclude types: {value.eventTypes.exclude.join(", ")}</li>
      ) : null}
      {value.severities?.include ? (
        <li>Include severities: {value.severities.include.join(", ")}</li>
      ) : null}
      {value.severities?.exclude ? (
        <li>Exclude severities: {value.severities.exclude.join(", ")}</li>
      ) : null}
    </ul>
  );
}

export function HookPolicySummary({
  title,
  policy,
}: {
  title: string;
  policy: HookPolicy;
}) {
  return (
    <section className="hook-policy-summary" aria-label={title}>
      <h3>{title}</h3>
      <dl>
        <div>
          <dt>Routing</dt>
          <dd>{policy.enabled ? "Enabled" : "Disabled"}</dd>
        </div>
        <div>
          <dt>Destinations</dt>
          <dd>{policy.sinks.length ? policy.sinks.join(", ") : "None"}</dd>
        </div>
        <div>
          <dt>Subscription filters</dt>
          <dd>
            <FilterSummary value={policy.filter} />
          </dd>
        </div>
        {policy.sinks.map((name) => (
          <div key={name}>
            <dt>{name} filters</dt>
            <dd>
              <FilterSummary value={policy.sinkFilters[name]} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function HookPolicyIdentity({
  resourceId,
  authorityId,
}: {
  resourceId: string;
  authorityId: string;
}) {
  return (
    <details className="hook-policy-identity">
      <summary>Provider identity</summary>
      <dl className="hook-detail-grid">
        <div>
          <dt>Subscription ID</dt>
          <dd>
            <code>{resourceId}</code>
          </dd>
        </div>
        <div>
          <dt>Configuration authority</dt>
          <dd>
            <code>{authorityId}</code>
          </dd>
        </div>
      </dl>
    </details>
  );
}
