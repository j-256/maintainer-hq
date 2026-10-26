import { z } from "zod";
import { CAPABILITY, idSchema, repositoryFields } from "../shared/domain";
import { githubConfigurationSchema } from "../shared/github";
import {
  REPOSITORY_CREDENTIAL_COVERAGE_LIMITS as LIMITS,
  repositoryCredentialCoverageInput,
  repositoryCredentialCoverageSchema,
  type RepositoryCredentialCoverage,
} from "../shared/repository-credential-coverage";
import {
  PROVIDER_CREDENTIAL_KIND,
  PROVIDER_CREDENTIAL_LIMITS,
} from "../shared/provider-credentials";
import { SOURCE_LIMITS } from "../shared/sources";
import { githubCredentialReferences } from "./github-credentials";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import {
  describeProviderCredential,
  PROVIDER_CREDENTIAL_COLUMNS,
  type ProviderCredentialRow,
} from "./provider-credential-store";
import { DomainError } from "./errors";
import type { WorkspaceService } from "./service";

const sourceSchema = z
  .object({
    id: idSchema,
    revision: z.number().int().positive().safe(),
    enabled: z.union([z.literal(0), z.literal(1)]),
    credentialRef: z.string().max(100).nullable(),
    configuration: z.string().max(LIMITS.METADATA_BYTES),
  })
  .strict();
const repositorySchema = z
  .object({
    id: idSchema,
    fullName: repositoryFields.shape.fullName,
    revision: z.number().int().positive().safe(),
    sources: z.string().max(LIMITS.METADATA_BYTES),
  })
  .strict();
function unavailable(): never {
  throw new DomainError(
    "metadata_unavailable",
    "Repository credential coverage could not be verified. Ask the owner to review configuration, then retry.",
    503,
  );
}
function conflict(): never {
  throw new DomainError(
    "conflict",
    "Repository access or credential configuration changed. Reload credential coverage.",
    409,
  );
}

export async function repositoryCredentialCoverage(
  context: WorkspaceService,
  input: unknown,
): Promise<RepositoryCredentialCoverage> {
  const { workspaceId, repositoryIds } =
    repositoryCredentialCoverageInput.parse(input);
  function checkExpiry() {
    if (
      context.principal.expiresAt !== undefined &&
      context.principal.expiresAt <= context.now()
    )
      throw new DomainError(
        "unauthorized",
        "Renew your workspace sign-in before reading credential coverage.",
        401,
      );
  }
  checkExpiry();
  const memberRevision = await authorizeHooks(context, workspaceId);
  const readCatalog = context.env.GITHUB_CREDENTIALS;
  const keyring = context.env.PROVIDER_CREDENTIAL_KEYS;
  async function snapshot() {
    const guard = hookActorGuard(
      context,
      workspaceId,
      CAPABILITY.READ,
      memberRevision,
    );
    return context.db.batch([
      context.db
        .prepare(
          `SELECT r.id,r.full_name AS fullName,r.revision,
        (SELECT json_group_array(json_object('id',id,'revision',revision,'enabled',enabled,
          'credentialRef',credential_ref,'configuration',configuration_json)) FROM (
          SELECT s.id,s.revision,s.enabled,s.credential_ref,s.configuration_json
          FROM source_repositories sr JOIN connections s ON s.workspace_id=sr.workspace_id AND s.id=sr.source_id
          WHERE sr.workspace_id=r.workspace_id AND sr.repository_id=r.id AND s.provider='github'
          ORDER BY s.id LIMIT ?)) AS sources
        FROM json_each(?) requested JOIN repositories r ON r.id=requested.value AND r.workspace_id=?
        WHERE ${guard.sql} ORDER BY CAST(requested.key AS INTEGER)`,
        )
        .bind(
          SOURCE_LIMITS.SOURCES + 1,
          JSON.stringify(repositoryIds),
          workspaceId,
          ...guard.values,
        ),
      context.db
        .prepare(
          `SELECT ${PROVIDER_CREDENTIAL_COLUMNS} FROM provider_credentials
        WHERE workspace_id=? AND provider_kind=? AND retired_at IS NULL AND ${guard.sql}
        ORDER BY id LIMIT ?`,
        )
        .bind(
          workspaceId,
          PROVIDER_CREDENTIAL_KIND.REPOSITORY,
          ...guard.values,
          PROVIDER_CREDENTIAL_LIMITS.WORKSPACE + 1,
        ),
    ]);
  }
  const captured = await snapshot();
  if (captured[0].results.length !== repositoryIds.length) {
    await authorizeHooks(context, workspaceId);
    throw new DomainError(
      "not_found",
      "A requested repository is not available in this workspace.",
      404,
    );
  }
  if (captured[1].results.length > PROVIDER_CREDENTIAL_LIMITS.WORKSPACE)
    throw new DomainError(
      "capacity",
      "Too many repository-maintenance credentials are enrolled. Ask the owner to review credential configuration.",
      409,
    );
  const encoder = new TextEncoder();
  const retained = JSON.stringify(captured.map((result) => result.results));
  if (encoder.encode(retained).byteLength > LIMITS.METADATA_BYTES)
    unavailable();
  const latestRevision = await authorizeHooks(context, workspaceId);
  checkExpiry();
  if (latestRevision !== memberRevision) conflict();
  const latest = await snapshot();
  checkExpiry();
  if (
    JSON.stringify(latest.map((result) => result.results)) !== retained ||
    readCatalog !== context.env.GITHUB_CREDENTIALS ||
    keyring !== context.env.PROVIDER_CREDENTIAL_KEYS
  )
    conflict();
  let rows: RepositoryCredentialCoverage["rows"];
  try {
    const readReferences = new Set(
      githubCredentialReferences(context.env, workspaceId).map(
        (entry) => entry.id,
      ),
    );
    const credentials = (captured[1].results as ProviderCredentialRow[]).map(
      (row) => describeProviderCredential(context, row),
    );
    rows = captured[0].results.map((value) => {
      const { sources, ...repository } = repositorySchema.parse(value);
      const collection: RepositoryCredentialCoverage["rows"][number]["collection"] =
        {
          configured: 0,
          disabled: 0,
          invalidConfiguration: 0,
          credentialUnavailable: 0,
          grant: "not_verified",
        };
      for (const source of z
        .array(sourceSchema)
        .max(SOURCE_LIMITS.SOURCES)
        .parse(JSON.parse(sources))) {
        if (!source.enabled) {
          collection.disabled++;
          continue;
        }
        let configuration: unknown;
        try {
          configuration = JSON.parse(source.configuration);
        } catch {
          configuration = null;
        }
        if (!githubConfigurationSchema.safeParse(configuration).success)
          collection.invalidConfiguration++;
        else if (
          !source.credentialRef ||
          !readReferences.has(source.credentialRef)
        )
          collection.credentialUnavailable++;
        else collection.configured++;
      }
      const maintenance: RepositoryCredentialCoverage["rows"][number]["maintenance"] =
        {
          configuredForWrites: 0,
          readOnly: 0,
          expired: 0,
          keyUnavailable: 0,
          grant: "not_verified",
        };
      for (const credential of credentials) {
        if (
          credential.settings.providerKind !==
          PROVIDER_CREDENTIAL_KIND.REPOSITORY
        )
          unavailable();
        if (
          !credential.settings.scope.repositoryNames.some(
            (name) => name.toLowerCase() === repository.fullName.toLowerCase(),
          )
        )
          continue;
        if (credential.status === "expired") maintenance.expired++;
        else if (credential.status === "key-unavailable")
          maintenance.keyUnavailable++;
        else if (credential.status !== "available") unavailable();
        else if (!credential.settings.writable) maintenance.readOnly++;
        else maintenance.configuredForWrites++;
      }
      return { repository, collection, maintenance };
    });
  } catch {
    unavailable();
  }
  const result = repositoryCredentialCoverageSchema.parse({
    generatedAt: new Date(context.now()).toISOString(),
    rows,
  });
  if (encoder.encode(JSON.stringify(result)).byteLength > LIMITS.RESPONSE_BYTES)
    unavailable();
  return result;
}
