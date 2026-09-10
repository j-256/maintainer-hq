import { z } from "zod";
import {
  CAPABILITY,
  idSchema,
  workspaceInput,
  type Capability,
} from "./domain";

export const AUTOMATION_PROFILE = Object.freeze({
  REPORTER: "reporter",
  READER: "reader",
} as const);
export const AUTOMATION_LIMITS = Object.freeze({
  ACTIVE_CREDENTIALS: 50,
  PENDING_PLANS: 25,
  HISTORY: 100,
  DAY_MS: 24 * 60 * 60 * 1000,
  REQUEST_TIMEOUT_MS: 15000,
});
export const AUTOMATION_DURATIONS = [7, 30, 90] as const;
export type AutomationProfile =
  (typeof AUTOMATION_PROFILE)[keyof typeof AUTOMATION_PROFILE];
export const AUTOMATION_SCOPES: Record<
  AutomationProfile,
  readonly Capability[]
> = {
  reporter: [CAPABILITY.ACTIVITY, CAPABILITY.GOALS],
  reader: [CAPABILITY.READ],
};
export const automationPlanInput = workspaceInput
  .extend({
    credentialId: idSchema,
    name: z.string().trim().min(1).max(80),
    profile: z.enum([AUTOMATION_PROFILE.REPORTER, AUTOMATION_PROFILE.READER]),
    reporterId: idSchema.nullable(),
    expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  })
  .strict()
  .refine(
    (value) =>
      value.profile === AUTOMATION_PROFILE.REPORTER
        ? value.reporterId !== null
        : value.reporterId === null,
    {
      message:
        "A Reporter needs a stable reporter ID; a Reader must not have one",
      path: ["reporterId"],
    },
  );
export const automationIssueInput = workspaceInput
  .extend({
    planId: idSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const automationRevokeInput = workspaceInput
  .extend({ credentialId: idSchema })
  .strict();
export type AutomationPlanFields = z.infer<typeof automationPlanInput>;
export type AutomationPlan = AutomationPlanFields & {
  planId: string;
  fingerprint: string;
  actor: string;
  workspaceName: string;
  scopes: readonly Capability[];
  expiresAt: string;
};
export type AutomationCredential = {
  id: string;
  name: string;
  profile: AutomationProfile;
  reporterId: string | null;
  owner: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};
export type IssuedAutomationCredential = {
  credential: AutomationCredential;
  token: string;
};
