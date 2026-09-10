import { Plus, X } from "lucide-react";
import { MONITOR_LIMITS, type MonitorTarget } from "../shared/monitoring";
import { JSON_FIELD_TYPES, type JsonField } from "../shared/monitoring-editor";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
export {
  HookError as MonitorError,
  HookTime as MonitorTime,
} from "./hook-components";
export function MonitorTargetFacts({ target }: { target: MonitorTarget }) {
  return (
    <dl className="monitor-target-facts">
      <div>
        <dt>URL</dt>
        <dd className="monitor-private-url">{target.url}</dd>
      </div>
      <div>
        <dt>Method</dt>
        <dd>{target.method}</dd>
      </div>
      <div>
        <dt>Expected status</dt>
        <dd>
          {target.expectedStatuses?.join(", ") ??
            "Reachability (HTTP below 500)"}
        </dd>
      </div>
      <div>
        <dt>Failure / recovery threshold</dt>
        <dd>
          {target.failureThreshold} / {target.recoveryThreshold} probes
        </dd>
      </div>
      <div>
        <dt>Timeout</dt>
        <dd>{target.timeoutMilliseconds / 1000} seconds</dd>
      </div>
      {target.expect?.contentType ? (
        <div>
          <dt>Content type</dt>
          <dd>{target.expect.contentType}</dd>
        </div>
      ) : null}
      {target.expect?.bodyIncludes ? (
        <div>
          <dt>Required text</dt>
          <dd>{target.expect.bodyIncludes}</dd>
        </div>
      ) : null}
      {target.expect?.location ? (
        <div>
          <dt>Expected redirect</dt>
          <dd className="monitor-private-url">
            {target.expect.location.url}
            <span>
              {target.expect.location.ignoreQuery
                ? "Query string ignored"
                : "Exact query string required"}
            </span>
          </dd>
        </div>
      ) : null}
      {target.expect?.jsonSubset ? (
        <div>
          <dt>Required JSON fields</dt>
          <dd>
            <JsonReadValue value={target.expect.jsonSubset} />
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
function JsonReadValue({ value }: { value: unknown }) {
  if (value !== null && typeof value === "object")
    return (
      <dl className="monitor-json-summary">
        {Object.entries(value).map(([key, child]) => (
          <div key={key}>
            <dt>{key || '""'}</dt>
            <dd>
              <JsonReadValue value={child} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return (
    <span>
      {value === null
        ? "null"
        : typeof value === "string"
          ? '"' + value + '"'
          : String(value)}
    </span>
  );
}

export function JsonFieldsEditor({
  fields,
  onChange,
  disabled,
  array = false,
  depth = 0,
}: {
  fields: JsonField[];
  onChange: (fields: JsonField[]) => void;
  disabled: boolean;
  array?: boolean;
  depth?: number;
}) {
  const change = (id: string, next: Partial<JsonField>) =>
    onChange(
      fields.map((field) => (field.id === id ? { ...field, ...next } : field)),
    );
  return (
    <div className="monitor-json-editor">
      {fields.map((field, index) => (
        <div className="monitor-json-field" key={field.id}>
          <div className="monitor-json-row">
            {array ? (
              <span className="hook-muted">Item {index + 1}</span>
            ) : (
              <Input
                aria-label={"Property name " + (index + 1)}
                value={field.key}
                disabled={disabled}
                placeholder="Property name"
                onChange={(event) =>
                  change(field.id, { key: event.target.value })
                }
              />
            )}
            <Select
              value={field.type}
              disabled={disabled}
              onValueChange={(type) =>
                change(field.id, {
                  type: type as JsonField["type"],
                  ...(type === "boolean" &&
                  !["true", "false"].includes(field.value)
                    ? { value: "false" }
                    : {}),
                })
              }
            >
              <SelectTrigger
                aria-label={
                  "Value type for " +
                  (array
                    ? "item " + (index + 1)
                    : field.key || "property " + (index + 1))
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {JSON_FIELD_TYPES.filter(
                  (type) =>
                    depth < MONITOR_LIMITS.JSON_DEPTH ||
                    !["object", "array"].includes(type),
                ).map((type) => (
                  <SelectItem key={type} value={type}>
                    {type === "string"
                      ? "Text"
                      : type[0]!.toUpperCase() + type.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={
                "Remove JSON " +
                (array
                  ? "item " + (index + 1)
                  : "property " + (field.key || index + 1))
              }
              disabled={disabled}
              onClick={() =>
                onChange(fields.filter((item) => item.id !== field.id))
              }
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </div>
          {field.type === "object" || field.type === "array" ? (
            <JsonFieldsEditor
              fields={field.children}
              array={field.type === "array"}
              depth={depth + 1}
              disabled={disabled}
              onChange={(children) => change(field.id, { children })}
            />
          ) : field.type === "boolean" ? (
            <Select
              value={field.value}
              disabled={disabled}
              onValueChange={(value) => change(field.id, { value })}
            >
              <SelectTrigger
                aria-label={
                  "Expected value for " + (field.key || "item " + (index + 1))
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">True</SelectItem>
                <SelectItem value="false">False</SelectItem>
              </SelectContent>
            </Select>
          ) : field.type !== "null" ? (
            <Input
              aria-label={
                "Expected value for " + (field.key || "item " + (index + 1))
              }
              type={field.type === "number" ? "number" : "text"}
              step="any"
              value={field.value}
              disabled={disabled}
              maxLength={MONITOR_LIMITS.JSON_BYTES}
              onChange={(event) =>
                change(field.id, { value: event.target.value })
              }
            />
          ) : null}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          onChange([
            ...fields,
            {
              id: crypto.randomUUID(),
              key: "",
              type: "string",
              value: "",
              children: [],
            },
          ])
        }
      >
        <Plus size={14} aria-hidden="true" /> Add {array ? "item" : "property"}
      </Button>
    </div>
  );
}
