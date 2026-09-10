import type { JsonValue } from "./monitoring";

export const JSON_FIELD_TYPES = [
  "string",
  "number",
  "boolean",
  "null",
  "object",
  "array",
] as const;
export type JsonField = {
  id: string;
  key: string;
  type: (typeof JSON_FIELD_TYPES)[number];
  value: string;
  children: JsonField[];
};
export function jsonFields(
  value: Record<string, JsonValue> | JsonValue[],
): JsonField[] {
  return Object.entries(value).map(([key, child]) => ({
    id: crypto.randomUUID(),
    key,
    type:
      child === null
        ? "null"
        : Array.isArray(child)
          ? "array"
          : (typeof child as "string" | "number" | "boolean" | "object"),
    value: child === null || typeof child === "object" ? "" : String(child),
    children:
      child !== null && typeof child === "object" ? jsonFields(child) : [],
  }));
}
export function jsonFieldsValue(
  fields: JsonField[],
  array = false,
): Record<string, JsonValue> | JsonValue[] {
  if (
    !array &&
    new Set(fields.map((field) => field.key)).size !== fields.length
  )
    throw new Error("JSON property names must be unique within each object.");
  const entries = fields.map((field): [string, JsonValue] => {
    let value: JsonValue;
    switch (field.type) {
      case "null":
        value = null;
        break;
      case "object":
        value = jsonFieldsValue(field.children, false);
        break;
      case "array":
        value = jsonFieldsValue(field.children, true) as JsonValue[];
        break;
      case "number":
        if (!field.value.trim() || !Number.isFinite(Number(field.value)))
          throw new Error(
            "Enter a finite number for each numeric JSON expectation.",
          );
        value = Number(field.value);
        break;
      case "boolean":
        value = field.value === "true";
        break;
      default:
        value = field.value;
    }
    return [field.key, value];
  });
  return array
    ? entries.map(([, value]) => value)
    : Object.fromEntries(entries);
}
