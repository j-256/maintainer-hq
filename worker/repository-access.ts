import { z } from "zod";
import {
  CAPABILITY,
  ROLE_CAPABILITIES,
  ROLES,
  getRepositoryInput,
  idSchema,
  repositoryFields,
} from "../shared/domain";
import { githubConfigurationSchema } from "../shared/github";
import {
  REPOSITORY_ACCESS_LIMITS,
  hqOperationGates,
  repositoryAccessSchema,
  type RepositoryAccess,
} from "../shared/repository-access";
import { SOURCE_LIMITS } from "../shared/sources";
import { githubCredential } from "./github-credentials";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

const sourceRow = z.object({
  id: idSchema,
  name: z.string().max(120),
  revision: z.number().int().positive(),
  enabled: z.union([z.literal(0), z.literal(1)]),
  credentialRef: z.string().nullable(),
  configuration: z.string(),
});
const rowSchema = z.object({
  id: idSchema,
  fullName: repositoryFields.shape.fullName,
  classification: repositoryFields.shape.classification,
  revision: z.number().int().positive(),
  role: z.enum(ROLES),
  scopes: z.string().nullable(),
  sources: z.string(),
});

export async function repositoryAccess(
  context: WorkspaceService,
  input: unknown,
): Promise<RepositoryAccess> {
  const { workspaceId, repositoryId } = getRepositoryInput.parse(input);
  function checkExpiry() {
    if (
      context.principal.expiresAt !== undefined &&
      context.principal.expiresAt <= context.now()
    )
      throw new DomainError(
        "unauthorized",
        "Renew your workspace sign-in before checking access.",
        401,
      );
  }
  checkExpiry();
  const memberRevision = await authorizeHooks(context, workspaceId);
  const guard = hookActorGuard(
    context,
    workspaceId,
    CAPABILITY.READ,
    memberRevision,
  );
  const generatedAt = new Date(context.now()).toISOString();
  const raw = await context.db
    .prepare(
      `SELECT r.id,r.full_name AS fullName,r.classification,r.revision,m.role,
    (SELECT scopes_json FROM credentials WHERE id=?) AS scopes,
    (SELECT json_group_array(json_object('id',id,'name',name,'revision',revision,'enabled',enabled,
      'credentialRef',credential_ref,'configuration',configuration_json)) FROM (
      SELECT s.id,s.name,s.revision,s.enabled,s.credential_ref,s.configuration_json
      FROM source_repositories sr JOIN connections s ON s.workspace_id=sr.workspace_id AND s.id=sr.source_id
      WHERE sr.workspace_id=r.workspace_id AND sr.repository_id=r.id AND s.provider='github'
      ORDER BY s.name,s.id LIMIT ?)) AS sources
    FROM repositories r JOIN members m ON m.workspace_id=r.workspace_id AND m.subject=?
    WHERE r.workspace_id=? AND r.id=? AND ${guard.sql}`,
    )
    .bind(
      context.principal.tokenId ?? null,
      SOURCE_LIMITS.SOURCES + 1,
      context.principal.subject,
      workspaceId,
      repositoryId,
      ...guard.values,
    )
    .first();
  const latestRevision = await authorizeHooks(context, workspaceId);
  checkExpiry();
  if (latestRevision !== memberRevision)
    throw new DomainError(
      "conflict",
      "Workspace access changed. Check access again.",
      409,
    );
  if (!raw) throw new DomainError("not_found", "Repository not found.", 404);
  try {
    const { role, scopes, sources, ...repository } = rowSchema.parse(raw);
    const enrolled = z
      .array(sourceRow)
      .max(SOURCE_LIMITS.SOURCES)
      .parse(JSON.parse(sources));
    const liveScopes =
      scopes === null
        ? ROLE_CAPABILITIES[role]
        : z.array(z.enum(CAPABILITY)).parse(JSON.parse(scopes));
    const effective = liveScopes.filter(
      (scope) =>
        !context.principal.scopes || context.principal.scopes.includes(scope),
    );
    const result = repositoryAccessSchema.parse({
      repository,
      hq: {
        role,
        client: context.principal.tokenId ? "credential" : "session",
        gates: hqOperationGates(role, effective),
      },
      github: {
        webhookAdapter: "hookrelay_setup",
        administration: "not_verified",
        sources: enrolled.map((source) => {
          let configurationValid = false;
          try {
            configurationValid = githubConfigurationSchema.safeParse(
              JSON.parse(source.configuration),
            ).success;
          } catch {
            /* Keep invalid source configuration unavailable */
          }
          return {
            id: source.id,
            name: source.name,
            revision: source.revision,
            enabled: Boolean(source.enabled),
            configurationValid,
            credential: githubCredential(
              context.env,
              workspaceId,
              source.credentialRef,
            )
              ? "configured"
              : "unavailable",
            grant: "not_verified",
          };
        }),
      },
      generatedAt,
    });
    if (
      new TextEncoder().encode(JSON.stringify(result)).byteLength >
      REPOSITORY_ACCESS_LIMITS.RESPONSE_BYTES
    )
      throw new Error("Response limit");
    return result;
  } catch {
    throw new DomainError(
      "metadata_unavailable",
      "Access guidance could not be read. Check the repository and its sources, then retry.",
      503,
    );
  }
}
