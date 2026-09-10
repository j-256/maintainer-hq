import { z } from "zod";
import {
  DEPENDENCY_LIMITS,
  dependencyAnalysisSchema,
  dependencyManifestPathSchema,
} from "./dependency-policy";

export const dependencyDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const dependencyReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("npm-override-lifecycle"),
    policyDigest: dependencyDigestSchema,
    files: z
      .array(
        z
          .object({
            manifestPath: dependencyManifestPathSchema,
            manifestDigest: dependencyDigestSchema,
            lockDigest: dependencyDigestSchema,
          })
          .strict(),
      )
      .min(1)
      .max(DEPENDENCY_LIMITS.MANIFESTS),
    analysis: dependencyAnalysisSchema,
  })
  .strict()
  .superRefine((report, context) => {
    const paths = new Set(report.files.map((file) => file.manifestPath));
    if (
      paths.size !== report.files.length ||
      paths.size !== report.analysis.manifestCount
    )
      context.addIssue({
        code: "custom",
        message: "Manifest evidence must be unique and complete",
      });
    if (
      report.analysis.findings.some(
        (finding) => !paths.has(finding.manifestPath),
      ) ||
      report.analysis.issues.some((issue) => !paths.has(issue.manifestPath))
    )
      context.addIssue({
        code: "custom",
        message: "Lifecycle findings must belong to an inspected manifest",
      });
    if (
      (report.analysis.outcome === "passed") !==
      (report.analysis.issues.length === 0)
    )
      context.addIssue({
        code: "custom",
        message: "The outcome must agree with the reported checks",
      });
  });
export type DependencyReport = z.infer<typeof dependencyReportSchema>;
