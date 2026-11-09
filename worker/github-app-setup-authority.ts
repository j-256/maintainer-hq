import { z } from "zod";
import { CAPABILITY, idSchema } from "../shared/domain";
import { GITHUB_APP_LIMITS as LIMITS } from "../shared/github-apps";
import { credentialHash } from "./credential-hash";
import { DomainError } from "./errors";
import { authorizeHooks, hookActorGuard } from "./hook-authority";
import type { WorkspaceService } from "./service";

const permitSchema = z
  .object({
    id: idSchema,
    revision: z.number().int().positive(),
    administrativeWorkspaceId: idSchema,
    subject: z
      .string()
      .min(1)
      .max(300)
      .regex(/^[^\x00-\x1f\x7f]+$/),
    issuer: z.url().max(2048),
    audience: z.string().min(1).max(300),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export const githubAppOperatorAuthoritySchema = z
  .object({
    workspaceId: idSchema,
    subject: z.string().min(1).max(300),
    memberRevision: z.number().int().positive(),
    permitId: idSchema,
    permitRevision: z.number().int().positive(),
    permitFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type GitHubAppOperatorAuthority = z.infer<
  typeof githubAppOperatorAuthoritySchema
>;
function forbidden(): never {
  throw new DomainError(
    "forbidden",
    "A verified deployment setup permit and live ownership of its administrative workspace are required.",
    403,
  );
}
function deploymentPermits(context: WorkspaceService) {
  const { env } = context;
  let permits: z.infer<typeof permitSchema>[];
  try {
    const raw = env.GITHUB_APP_SETUP_PERMITS;
    if (
      !raw ||
      new TextEncoder().encode(raw).byteLength > LIMITS.SETUP_PERMIT_BYTES ||
      !idSchema.safeParse(env.GITHUB_APP_DEPLOYMENT_ID).success
    )
      forbidden();
    permits = z
      .array(permitSchema)
      .max(LIMITS.SETUP_PERMITS)
      .parse(JSON.parse(raw));
    if (new Set(permits.map((permit) => permit.id)).size !== permits.length)
      forbidden();
  } catch {
    return forbidden();
  }
  return permits;
}
export async function requireGitHubAppOperator(
  context: WorkspaceService,
  workspaceId: string,
): Promise<GitHubAppOperatorAuthority> {
  const { principal, env } = context;
  if (
    principal.tokenId ||
    principal.scopes ||
    principal.sourceId ||
    principal.reporterId ||
    (!context.development &&
      (!principal.access ||
        principal.access.issuer !== env.ACCESS_ISSUER ||
        principal.access.audience !== env.ACCESS_AUDIENCE))
  )
    forbidden();
  const permit = deploymentPermits(context).find(
    (entry) =>
      entry.subject === principal.subject &&
      entry.administrativeWorkspaceId === workspaceId &&
      entry.issuer === env.ACCESS_ISSUER &&
      entry.audience === env.ACCESS_AUDIENCE,
  );
  if (!permit || Date.parse(permit.expiresAt) <= context.now()) forbidden();
  const revoked = await context.db
    .prepare(
      "SELECT 1 FROM github_app_setup_revocations WHERE permit_id=? AND permit_revision=?",
    )
    .bind(permit.id, permit.revision)
    .first();
  if (revoked) forbidden();
  let memberRevision: number;
  try {
    memberRevision = await authorizeHooks(
      context,
      workspaceId,
      CAPABILITY.ADMIN,
    );
  } catch {
    return forbidden();
  }
  return {
    workspaceId,
    subject: principal.subject,
    memberRevision,
    permitId: permit.id,
    permitRevision: permit.revision,
    permitFingerprint: await credentialHash(
      JSON.stringify({ deploymentId: env.GITHUB_APP_DEPLOYMENT_ID, permit }),
    ),
    expiresAt: permit.expiresAt,
  };
}
export function githubAppIssuerGuard(
  context: WorkspaceService,
  authority: GitHubAppOperatorAuthority,
) {
  return {
    sql: `EXISTS(SELECT 1 FROM members WHERE workspace_id=? AND subject=? AND role='owner' AND revision=?)
      AND ?>? AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND NOT EXISTS(SELECT 1 FROM github_app_setup_revocations WHERE permit_id=? AND permit_revision=?)`,
    values: [
      authority.workspaceId,
      authority.subject,
      authority.memberRevision,
      authority.expiresAt,
      new Date(context.now()).toISOString(),
      authority.expiresAt,
      authority.permitId,
      authority.permitRevision,
    ],
  };
}
export async function assertGitHubAppIssuer(
  context: WorkspaceService,
  input: GitHubAppOperatorAuthority,
) {
  const authority = githubAppOperatorAuthoritySchema.parse(input);
  const permit = deploymentPermits(context).find(
    (entry) =>
      entry.id === authority.permitId &&
      entry.revision === authority.permitRevision &&
      entry.subject === authority.subject &&
      entry.administrativeWorkspaceId === authority.workspaceId &&
      entry.issuer === context.env.ACCESS_ISSUER &&
      entry.audience === context.env.ACCESS_AUDIENCE,
  );
  if (
    !permit ||
    authority.expiresAt !== permit.expiresAt ||
    (await credentialHash(
      JSON.stringify({
        deploymentId: context.env.GITHUB_APP_DEPLOYMENT_ID,
        permit,
      }),
    )) !== authority.permitFingerprint
  )
    forbidden();
  const guard = githubAppIssuerGuard(context, authority);
  if (
    !(await context.db
      .prepare(`SELECT 1 WHERE ${guard.sql}`)
      .bind(...guard.values)
      .first())
  )
    forbidden();
}
export function githubAppOperatorGuard(
  context: WorkspaceService,
  authority: GitHubAppOperatorAuthority,
) {
  const member = hookActorGuard(
    context,
    authority.workspaceId,
    CAPABILITY.ADMIN,
    authority.memberRevision,
  );
  const now = new Date(context.now()).toISOString();
  const identityExpiry =
    context.principal.expiresAt === undefined
      ? null
      : new Date(context.principal.expiresAt).toISOString();
  return {
    sql: `${member.sql} AND ? > ? AND ? > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND (? IS NULL OR ? > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      AND NOT EXISTS(SELECT 1 FROM github_app_setup_revocations WHERE permit_id=? AND permit_revision=?)`,
    values: [
      ...member.values,
      authority.expiresAt,
      now,
      authority.expiresAt,
      identityExpiry,
      identityExpiry,
      authority.permitId,
      authority.permitRevision,
    ],
  };
}
