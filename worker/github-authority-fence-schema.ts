import { z } from "zod";
import { CAPABILITY, idSchema, repositoryFields } from "../shared/domain";
import {
  githubCapabilitySchema,
  githubProviderIdSchema,
} from "../shared/github-apps";

const revision = z.number().int().positive().safe();
const base = z.object({
  workspaceId: idSchema,
  connectionId: idSchema,
  connectionRevision: revision,
  connectionKind: z.enum([
    "source",
    "configuration",
    "configuration-admission",
  ]),
  repositoryId: idSchema.nullable(),
  repositoryFullName: repositoryFields.shape.fullName,
  capability: githubCapabilitySchema,
  binding: z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("actor"),
        subject: z.string().min(1).max(300),
        tokenId: idSchema.nullable(),
        membershipRevision: revision,
      })
      .strict(),
    z
      .object({
        kind: z.literal("source"),
        sourceId: idSchema,
        sourceRevision: revision,
        jobId: idSchema,
      })
      .strict(),
  ]),
  actorCapability: z.enum(CAPABILITY),
  actorExpiresAt: z.number().int().nonnegative().safe().nullable(),
});
export const githubAuthorityFenceSchema = z.discriminatedUnion("kind", [
  base
    .extend({
      kind: z.literal("token"),
      reference: idSchema,
      credentialIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  base
    .extend({
      kind: z.literal("app"),
      registrationId: idSchema,
      registrationRevision: revision,
      keyRevision: revision,
      installationId: githubProviderIdSchema,
      grantId: idSchema,
      grantRevision: revision,
      observedAuthorityGeneration: revision,
      providerRepositoryId: githubProviderIdSchema,
    })
    .strict(),
]);
