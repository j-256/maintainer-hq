import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  visit,
  type YAMLMap,
} from "yaml";
import {
  DEPENDABOT_LIMITS as LIMITS,
  dependabotEntrySchema,
  dependabotEditsSchema,
  dependabotMemberSchema,
  dependabotScheduleSchema,
  type DependabotEntry,
  type DependabotEdit,
} from "../shared/dependabot";

export class DependabotDocumentError extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported" | "limited",
    message: string,
  ) {
    super(message);
  }
}
function unsupported(): never {
  throw new DependabotDocumentError(
    "unsupported",
    "Dependabot configuration uses unsupported or shared YAML ownership",
  );
}
function document(text: string) {
  if (new TextEncoder().encode(text).byteLength > LIMITS.FILE_BYTES)
    throw new DependabotDocumentError(
      "limited",
      "Dependabot configuration exceeds the file limit",
    );
  const doc = parseDocument(text, {
    keepSourceTokens: true,
    uniqueKeys: true,
    strict: true,
  });
  if (doc.errors.length)
    throw new DependabotDocumentError(
      "malformed",
      "Dependabot YAML could not be parsed safely",
    );
  if (doc.warnings.length || !isMap(doc.contents)) unsupported();
  let count = 0;
  visit(doc, (_key, node) => {
    if (++count > LIMITS.YAML_NODES)
      throw new DependabotDocumentError(
        "limited",
        "Dependabot configuration exceeds the node limit",
      );
    if (
      isAlias(node) ||
      ((isMap(node) || isSeq(node) || isScalar(node)) && node.anchor)
    )
      unsupported();
    if (
      isMap(node) &&
      node.items.some(
        (item) =>
          !isScalar(item.key) ||
          typeof item.key.value !== "string" ||
          item.key.value === "<<",
      )
    )
      unsupported();
  });
  const value = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  if (
    value.version !== 2 ||
    !Array.isArray(value.updates) ||
    !value.updates.length
  )
    unsupported();
  if (value.updates.length > LIMITS.ENTRIES)
    throw new DependabotDocumentError("limited", "Too many Dependabot entries");
  return { doc, value };
}
type Mapping = {
  entry: DependabotEntry;
  path: (string | number)[];
  node: YAMLMap | null;
};
function semantic(value: unknown): string {
  const normalize = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(normalize)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, normalize(child)]),
          )
        : item;
  return JSON.stringify(normalize(value));
}
function mappings(text: string, digest: string) {
  const { doc, value } = document(text);
  const groups = value["multi-ecosystem-groups"];
  if (
    groups !== undefined &&
    (!groups || typeof groups !== "object" || Array.isArray(groups))
  )
    unsupported();
  const groupMap = new Map(
    Object.entries((groups ?? {}) as Record<string, unknown>),
  );
  if (groupMap.size > LIMITS.ENTRIES)
    throw new DependabotDocumentError("limited", "Too many Dependabot groups");
  const members = new Map<
    string,
    ReturnType<typeof dependabotMemberSchema.parse>[]
  >();
  const results: Mapping[] = [];
  function item(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) unsupported();
    const update = raw as Record<string, unknown>;
    if ((update.directory === undefined) === (update.directories === undefined))
      unsupported();
    const member = dependabotMemberSchema.safeParse({
      ecosystem: update["package-ecosystem"],
      directories: update.directories ?? [update.directory],
      targetBranch: update["target-branch"] ?? null,
    });
    if (
      !member.success ||
      member.data.directories.some((directory) => !directory.startsWith("/"))
    )
      unsupported();
    return { update, member: member.data };
  }
  function add(
    owner: "update" | "group",
    position: number,
    group: string | null,
    affected: ReturnType<typeof dependabotMemberSchema.parse>[],
    path: (string | number)[],
    ambiguous = false,
  ) {
    const node = doc.getIn([...path, "schedule"], true);
    const raw = doc.getIn([...path, "schedule"]);
    const parsed = dependabotScheduleSchema.safeParse(
      isMap(raw) ? raw.toJSON() : raw,
    );
    const schedule = parsed.success ? parsed.data : null;
    const safeMapping =
      isMap(node) &&
      !node.flow &&
      node.range &&
      !text
        .slice(text.lastIndexOf("\n", node.range[0] - 1) + 1, node.range[0])
        .trim();
    results.push({
      path: [...path, "schedule"],
      node: isMap(node) ? node : null,
      entry: dependabotEntrySchema.parse({
        id: digest + ":" + owner + ":" + position,
        owner,
        group,
        members: affected,
        schedule,
        editable: Boolean(schedule && safeMapping && !ambiguous),
        issue: ambiguous
          ? "ambiguous_group"
          : schedule
            ? null
            : "unsupported_schedule",
      }),
    });
  }
  (value.updates as unknown[]).forEach((raw, index) => {
    const { update, member } = item(raw);
    const group = update["multi-ecosystem-group"];
    if (group !== undefined) {
      if (typeof group !== "string" || !groupMap.has(group)) unsupported();
      const affected = members.get(group) ?? [];
      affected.push(member);
      members.set(group, affected);
    } else add("update", index, null, [member], ["updates", index]);
  });
  let index = 0;
  for (const [name, group] of groupMap) {
    const affected = members.get(name);
    if (affected?.length) {
      if (!group || typeof group !== "object" || Array.isArray(group))
        unsupported();
      const target = (group as Record<string, unknown>)["target-branch"];
      const normalized = affected.map((member) => ({
        ...member,
        targetBranch: target ?? member.targetBranch,
      }));
      add(
        "group",
        index,
        name,
        normalized as typeof affected,
        ["multi-ecosystem-groups", name],
        affected.some((member) => member.targetBranch !== null),
      );
    }
    index++;
  }
  if (!results.length || results.length > LIMITS.ENTRIES) unsupported();
  return { doc, value, mappings: results };
}
export function parseDependabotDocument(text: string, digest: string) {
  return { entries: mappings(text, digest).mappings.map((item) => item.entry) };
}
export function editDependabotDocument(
  text: string,
  digest: string,
  input: DependabotEdit[],
) {
  const edits = dependabotEditsSchema.parse(input);
  const original = mappings(text, digest);
  const replacements: { start: number; end: number; text: string }[] = [];
  const expected = original.doc.toJS({ maxAliasCount: 0 });
  const expectedDoc = original.doc.clone();
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  for (const edit of edits) {
    const item = original.mappings.find(
      (candidate) => candidate.entry.id === edit.entryId,
    );
    if (!item?.node?.range || !item.entry.editable)
      throw new Error("Schedule identity changed or is not safely editable");
    const [start, end] = item.node.range;
    if (text.slice(text.lastIndexOf("\n", start - 1) + 1, start).trim())
      throw new Error(
        "Flow or inline schedule ownership is not safely editable",
      );
    const clone = item.node.clone();
    for (const key of ["interval", "day", "time", "timezone", "cronjob"])
      if (!(key in edit.schedule)) clone.delete(key);
    for (const [key, value] of Object.entries(edit.schedule))
      clone.set(key, value);
    const indentation = text.slice(
      text.lastIndexOf("\n", start - 1) + 1,
      start,
    );
    const rendered =
      stringify(clone, { lineWidth: 0 })
        .replace(/\n$/, "")
        .split("\n")
        .map((line, index) => (index ? indentation + line : line))
        .join(newline) + (text.slice(start, end).endsWith("\n") ? newline : "");
    replacements.push({ start, end, text: rendered });
    expectedDoc.setIn(item.path, edit.schedule);
  }
  let changed = text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    changed =
      changed.slice(0, replacement.start) +
      replacement.text +
      changed.slice(replacement.end);
  const after = document(changed).value;
  if (semantic(after) !== semantic(expectedDoc.toJS({ maxAliasCount: 0 })))
    throw new Error(
      "The edit changes configuration outside the reviewed schedules",
    );
  if (semantic(after) === semantic(expected))
    throw new Error("Choose a different schedule before preparing a review");
  return changed;
}
