import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  commands,
  commandAnnotations,
  type CommandName,
} from "../shared/commands";
import { LIMITS } from "../shared/domain";
import { DomainError, errorResponse } from "./errors";
import { WorkspaceService } from "./service";
import type { Env, PrincipalResolver } from "./types";
import { runGitHubJobs, runGitHubScheduled } from "./github-runner";
import { secureResponse } from "../shared/security";
import { workspaceInput } from "../shared/domain";
import {
  workspaceChangesInput,
  syncCursorSchema,
} from "../shared/workspace-sync";
import { PUSH_LIMITS } from "../shared/workspace-push";
import { authorizeHooks } from "./hook-authority";
import { socketIdentityHeader } from "./workspace-events";
import { deliverWorkspacePush } from "./workspace-push";
import { SecretReviews } from "./secret-reviews";
import { SecretOperations } from "./secret-operations";
import { ProviderCredentials } from "./provider-credentials";
import { reapSecretInputs } from "./secret-private-input";
import { emitDiagnostic } from "./diagnostics";
import type { TransferReceipt } from "../shared/project-transfers";

async function readJson(request: Request) {
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  )
    throw new DomainError(
      "media_type",
      "Send an application/json request",
      415,
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new DomainError("validation", "A request body is required", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LIMITS.BODY_BYTES) {
      await reader.cancel();
      throw new DomainError("too_large", "This request is too large", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new DomainError("validation", "Send valid JSON", 400);
  }
}

function protectOrigin(request: Request, development: boolean) {
  const url = new URL(request.url);
  if (
    development &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new DomainError(
      "forbidden",
      "Development is available on loopback only",
      403,
    );
  const origin = request.headers.get("Origin");
  if (
    (origin && origin !== url.origin) ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    throw new DomainError(
      "forbidden",
      "Use the workspace application origin",
      403,
    );
  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    !origin &&
    !request.headers.has("Authorization") &&
    !(development && request.headers.get("X-HQ-Client") === "cli")
  ) {
    throw new DomainError(
      "forbidden",
      "An authenticated client or same-origin browser is required",
      403,
    );
  }
}

export function createApplication(
  resolvePrincipal: PrincipalResolver,
  development = false,
) {
  return {
    async scheduled(_controller: ScheduledController, env: Env) {
      const [cleanup, collection] = await Promise.allSettled([
        reapSecretInputs(env),
        runGitHubScheduled(env),
      ]);
      if (cleanup.status === "rejected")
        emitDiagnostic({
          event: "hq.secrets.cleanup.interrupted",
          expiredInputMayRemain: true,
        });
      if (cleanup.status === "rejected" || collection.status === "rejected") {
        throw new Error(
          "Scheduled maintenance interrupted; inspect structured cleanup and collection diagnostics and durable receipts",
        );
      }
    },
    async fetch(
      request: Request,
      env: Env,
      context?: ExecutionContext,
    ): Promise<Response> {
      const url = new URL(request.url);
      if (
        !url.pathname.startsWith("/api/") &&
        url.pathname !== "/mcp" &&
        url.pathname !== "/healthz"
      )
        return secureResponse(await env.ASSETS.fetch(request), true);
      let response: Response;
      const diagnostic = { operation: "request", started: performance.now() };
      try {
        protectOrigin(request, development);
        if (url.pathname === "/healthz")
          response = Response.json({ status: "ok" });
        else {
          const principal = await resolvePrincipal(request, env);
          const kick = context
            ? () =>
                context.waitUntil(
                  runGitHubJobs(env).catch(() => {
                    // The runner records a safe failure; durable work awaits recovery
                  }),
                )
            : undefined;
          const service = new WorkspaceService(
            env,
            principal,
            development,
            Date.now,
            kick,
          );
          const execute = async (name: CommandName, input: unknown) => {
            const command = commands[name];
            const result = await service[command.method](input);
            if (!command.readOnly) {
              const workspaceId =
                input &&
                typeof input === "object" &&
                "workspaceId" in input &&
                typeof input.workspaceId === "string"
                  ? input.workspaceId
                  : undefined;
              const workspaces =
                name === "project_transfer_apply"
                  ? [
                      workspaceId,
                      (result as TransferReceipt).destinationWorkspaceId,
                    ]
                  : [workspaceId];
              const delivery = Promise.all(
                [...new Set(workspaces)].map((id) =>
                  deliverWorkspacePush(env, id),
                ),
              );
              if (context) context.waitUntil(delivery);
              else await delivery;
            }
            return result;
          };
          if (url.pathname === "/api/session" && request.method === "GET") {
            diagnostic.operation = "session";
            response = Response.json(await service.session());
          } else if (
            (url.pathname === "/api/secrets/input" ||
              url.pathname === "/api/secrets/transient-input" ||
              url.pathname === "/api/provider-credentials/input") &&
            request.method === "POST"
          ) {
            const credentialInput =
              url.pathname === "/api/provider-credentials/input";
            const transientInput =
              url.pathname === "/api/secrets/transient-input";
            diagnostic.operation = credentialInput
              ? "provider_credential_private_input"
              : transientInput
                ? "secrets_transient_input"
                : "secrets_private_input";
            response = Response.json(
              transientInput
                ? await new SecretOperations(service).supply(
                    request,
                    Object.fromEntries(url.searchParams),
                  )
                : await (
                    credentialInput
                      ? new ProviderCredentials(service)
                      : new SecretReviews(service)
                  ).upload(request, Object.fromEntries(url.searchParams)),
            );
            const delivery = deliverWorkspacePush(
              env,
              url.searchParams.get("workspaceId") ?? undefined,
            );
            if (context) context.waitUntil(delivery);
            else await delivery;
          } else if (
            url.pathname === "/api/events" &&
            request.method === "GET"
          ) {
            diagnostic.operation = "workspace_events";
            if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
              throw new DomainError(
                "upgrade_required",
                "Connect using the workspace WebSocket protocol.",
                426,
              );
            if (request.headers.get("Origin") !== url.origin)
              throw new DomainError(
                "forbidden",
                "Use the workspace application origin for live updates.",
                403,
              );
            const query = Object.fromEntries(url.searchParams);
            const subscription =
              query.view === undefined
                ? undefined
                : workspaceChangesInput.parse({
                    ...query,
                    cursor: z
                      .string()
                      .regex(/^\d{1,16}$/)
                      .transform(Number)
                      .pipe(syncCursorSchema)
                      .parse(query.cursor),
                    memberRevision: z
                      .string()
                      .regex(/^\d{1,16}$/)
                      .transform(Number)
                      .parse(query.memberRevision),
                  });
            const { workspaceId } = subscription ?? workspaceInput.parse(query);
            const memberRevision = await authorizeHooks(service, workspaceId);
            if (!env.WORKSPACE_EVENTS)
              throw new DomainError(
                "push_unavailable",
                "Live updates are unavailable. The dashboard can use fallback refresh.",
                503,
              );
            const expiresAt = Math.min(
              principal.expiresAt ?? Date.now() + PUSH_LIMITS.CONNECTION_MS,
              Date.now() + PUSH_LIMITS.CONNECTION_MS,
            );
            if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
              throw new DomainError(
                "unauthorized",
                "Renew your workspace sign-in.",
                401,
              );
            response = await env.WORKSPACE_EVENTS.getByName(workspaceId).fetch(
              new Request("https://workspace.internal/connect", {
                headers: {
                  Upgrade: "websocket",
                  ...socketIdentityHeader({
                    workspaceId,
                    subject: principal.subject,
                    tokenId: principal.tokenId ?? null,
                    memberRevision,
                    expiresAt,
                    ...(subscription
                      ? {
                          subscription: {
                            cursor: subscription.cursor,
                            memberRevision: subscription.memberRevision,
                            scope: {
                              view: subscription.view,
                              ...(subscription.repositoryId
                                ? { repositoryId: subscription.repositoryId }
                                : {}),
                            },
                          },
                        }
                      : {}),
                  }),
                },
              }),
            );
          } else if (url.pathname === "/mcp" && request.method === "POST") {
            diagnostic.operation = "mcp";
            const body = await readJson(request);
            const server = new McpServer({
              name: "maintainer-hq",
              version: "0.1.0",
            });
            for (const [name, command] of Object.entries(commands)) {
              server.registerTool(
                name,
                {
                  title: command.title,
                  description:
                    command.title +
                    " in an explicitly authorized workspace. Reported updates and provider-collected evidence retain their distinct provenance.",
                  inputSchema: command.schema as z.ZodType,
                  annotations: commandAnnotations(name, command.readOnly),
                },
                async (input: unknown) => {
                  const started = performance.now();
                  try {
                    return {
                      content: [
                        {
                          type: "text",
                          text: JSON.stringify(
                            await execute(name as CommandName, input),
                          ),
                        },
                      ],
                    };
                  } catch (error) {
                    return {
                      isError: true,
                      content: [
                        {
                          type: "text",
                          text: await errorResponse(error, {
                            operation: name,
                            started,
                          }).text(),
                        },
                      ],
                    };
                  }
                },
              );
            }
            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: undefined,
              enableJsonResponse: true,
            });
            await server.connect(transport);
            try {
              response = await transport.handleRequest(
                new Request(request.url, {
                  method: request.method,
                  headers: request.headers,
                  body: JSON.stringify(body),
                }),
              );
            } finally {
              await server.close();
            }
          } else if (
            url.pathname.startsWith("/api/commands/") &&
            request.method === "POST"
          ) {
            const name = url.pathname.slice("/api/commands/".length);
            if (!Object.hasOwn(commands, name))
              throw new DomainError("not_found", "Command not found", 404);
            const command = commands[name as CommandName];
            diagnostic.operation = name;
            response = Response.json(
              await execute(
                name as CommandName,
                command.schema.parse(await readJson(request)),
              ),
            );
          } else throw new DomainError("not_found", "Endpoint not found", 404);
        }
      } catch (error) {
        response = errorResponse(error, diagnostic);
      }
      return secureResponse(response);
    },
  };
}
