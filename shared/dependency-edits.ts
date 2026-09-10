import { applyEdits, modify } from "jsonc-parser";
import {
  DEPENDENCY_POLICY_PATH,
  analyzeDependencyPolicy,
  dependencyPolicySchema,
  type DependencyDocuments,
} from "./dependency-policy";
import {
  changedDependencyRule,
  type DependencyChangeReview,
} from "./dependency-changes";

function edit(text: string, path: (string | number)[], value: unknown) {
  return applyEdits(text, modify(text, path, value, {}));
}
function equivalent(text: string, expected: unknown) {
  const canonical = (_key: string, value: unknown): unknown =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value;
  if (
    JSON.stringify(JSON.parse(text), canonical) !==
    JSON.stringify(expected, canonical)
  )
    throw new Error("The exact dependency edit could not be verified");
}
export function dependencyFileChanges(
  review: DependencyChangeReview,
  files: ReadonlyMap<string, string>,
  now: number,
): { path: string; content: string }[] {
  const policyText = files.get(DEPENDENCY_POLICY_PATH);
  if (!policyText) throw new Error("The reviewed policy file is missing");
  const policy = dependencyPolicySchema.parse(JSON.parse(policyText));
  const documents: DependencyDocuments[] = policy.manifests.map((item) => ({
    manifestPath: item.path,
    manifest: JSON.parse(files.get(item.path) ?? "null"),
    lock: JSON.parse(
      files.get(item.path.replace(/package\.json$/, "package-lock.json")) ??
        "null",
    ),
  }));
  const analysis = analyzeDependencyPolicy(policy, documents, now);
  const { before } = changedDependencyRule(
    analysis,
    review.before.id,
    review.change,
    now,
  );
  if (JSON.stringify(before) !== JSON.stringify(review.before))
    throw new Error("The reviewed override changed");
  const manifestIndex = policy.manifests.findIndex((item) =>
    item.overrides.some((rule) => rule.id === before.id),
  );
  const manifest = policy.manifests[manifestIndex]!;
  const ruleIndex = manifest.overrides.findIndex(
    (rule) => rule.id === before.id,
  );
  const expectedPolicy = JSON.parse(policyText);
  expectedPolicy.manifests[manifestIndex].overrides[ruleIndex] = review.after;
  let updatedPolicy = policyText;
  for (const field of [
    "reason",
    "owner",
    "reviewedAt",
    "reviewBy",
    "lifecycle",
  ] as const) {
    if (review.before[field] !== review.after[field])
      updatedPolicy = edit(
        updatedPolicy,
        ["manifests", manifestIndex, "overrides", ruleIndex, field],
        review.after[field],
      );
  }
  equivalent(updatedPolicy, expectedPolicy);
  const changed = [{ path: DEPENDENCY_POLICY_PATH, content: updatedPolicy }];
  if (review.change.kind === "remove") {
    const document = documents[manifestIndex]!;
    const text = files.get(manifest.path)!;
    const original = JSON.parse(text);
    const expected = structuredClone(original);
    const selector = before.package + "@" + before.requested;
    if (expected.overrides?.[before.parent]?.[selector] !== before.replacement)
      throw new Error("The exact npm override is not present");
    delete expected.overrides[before.parent][selector];
    let path = ["overrides", before.parent, selector];
    if (!Object.keys(expected.overrides[before.parent]).length) {
      delete expected.overrides[before.parent];
      path = ["overrides", before.parent];
    }
    if (!Object.keys(expected.overrides).length) {
      delete expected.overrides;
      path = ["overrides"];
    }
    const content = edit(text, path, undefined);
    equivalent(content, expected);
    document.manifest = JSON.parse(content);
    changed.push({ path: manifest.path, content });
  }
  const after = analyzeDependencyPolicy(expectedPolicy, documents, now);
  const target = after.findings.find((item) => item.rule.id === before.id);
  if (
    !target ||
    target.status !==
      (review.change.kind === "remove" ? "resolved" : "mitigated") ||
    after.issues.some(
      (issue) =>
        issue.overrideId === before.id ||
        !["review_due", "unused_override"].includes(issue.code),
    )
  )
    throw new Error(
      "The edited files do not satisfy the reviewed dependency checks",
    );
  return changed;
}
