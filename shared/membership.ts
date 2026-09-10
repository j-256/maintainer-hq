import { z } from "zod";
import { idSchema, ROLES, workspaceInput, type Role } from "./domain";

export const MEMBERSHIP_LIMITS = Object.freeze({
  MEMBERS: 100,
  PENDING_INVITATIONS: 50,
  HISTORY: 100,
  INVITATION_DAYS: 30,
  SETUP_BYTES: 2048,
  SETUP_TTL_MS: 60 * 60 * 1000,
});
export const subjectSchema = z.string().regex(/^[\x21-\x7e]{1,255}$/);
export const emailSchema = z.email().max(254).toLowerCase();
export const identityInput = z.object({}).strict();
export const initialOwnerSetupSchema = z
  .object({
    setupId: idSchema,
    workspaceId: idSchema,
    workspaceName: z.string().trim().min(1).max(80),
    ownerSubject: subjectSchema,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export const setupApplyInput = z
  .object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const invitationCreateInput = workspaceInput
  .extend({
    invitationId: idSchema,
    email: emailSchema,
    role: z.enum(ROLES),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(MEMBERSHIP_LIMITS.INVITATION_DAYS),
  })
  .strict();
export const invitationInput = z
  .object({ invitationId: idSchema, revision: z.number().int().positive() })
  .strict();
export const invitationRevokeInput = workspaceInput
  .extend(invitationInput.shape)
  .strict();
export const memberRemoveInput = workspaceInput
  .extend({ subject: subjectSchema, revision: z.number().int().positive() })
  .strict();
export const memberUpdateInput = memberRemoveInput
  .extend({ role: z.enum(ROLES) })
  .strict();

export type ManagedMember = {
  subject: string;
  displayName: string;
  role: Role;
  revision: number;
};
export type Invitation = {
  id: string;
  email: string;
  role: Role;
  revision: number;
  createdAt: string;
  expiresAt: string;
  state: "pending" | "accepted" | "revoked" | "expired";
};
export type OwnInvitation = Pick<
  Invitation,
  "id" | "role" | "revision" | "expiresAt"
> & { workspaceId: string; workspaceName: string };
export type SetupStatus =
  | { state: "unavailable" }
  | {
      state: "ready";
      fingerprint: string;
      workspaceId: string;
      workspaceName: string;
      owner: string;
      expiresAt: string;
    }
  | { state: "complete"; workspaceId: string };
