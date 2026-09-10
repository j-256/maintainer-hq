import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { CAPABILITY, idSchema } from "../shared/domain";
import {
  PUSH_CLOSE,
  PUSH_LIMITS,
  pushChangeSchema,
  type PushFrame,
} from "../shared/workspace-push";
import type { Env } from "./types";
import {
  syncScopeSchema,
  syncCursorSchema,
  SYNC_LIMITS,
  VIEW_TOPICS,
  type SyncUpdate,
} from "../shared/workspace-sync";
import { WorkspaceService } from "./service";

export const socketIdentitySchema = z
  .object({
    workspaceId: idSchema,
    subject: z.string().regex(/^[\x21-\x7e]{1,255}$/),
    tokenId: idSchema.nullable(),
    memberRevision: z.number().int().positive(),
    expiresAt: z.number().int().positive().safe(),
    subscription: z
      .object({
        scope: syncScopeSchema,
        cursor: syncCursorSchema,
        memberRevision: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
type SocketIdentity = z.infer<typeof socketIdentitySchema>;
type Attachment = SocketIdentity & {
  revision: number;
  frames: number;
  cursor?: number;
  connectedAt?: number;
};
const INTERNAL_IDENTITY = "X-HQ-Socket-Identity";
export const socketIdentityHeader = (identity: SocketIdentity) => ({
  [INTERNAL_IDENTITY]: JSON.stringify(socketIdentitySchema.parse(identity)),
});

async function allowed(db: D1Database, identities: SocketIdentity[]) {
  const now = new Date().toISOString();
  const rows = await db
    .prepare(
      `SELECT CAST(i.key AS INTEGER) AS slot FROM json_each(?) i
    JOIN members m ON m.workspace_id=json_extract(i.value,'$.workspaceId') AND m.subject=json_extract(i.value,'$.subject')
    WHERE m.role IN ('owner','operator','viewer') AND m.revision=json_extract(i.value,'$.memberRevision')
      AND (json_extract(i.value,'$.tokenId') IS NULL OR EXISTS
        (SELECT 1 FROM credentials c WHERE c.id=json_extract(i.value,'$.tokenId') AND c.workspace_id=m.workspace_id AND c.owner_subject=m.subject
          AND c.revoked_at IS NULL AND c.expires_at>? AND c.source_id IS NULL AND c.reporter_id IS NULL
          AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value=?)))`,
    )
    .bind(JSON.stringify(identities), now, CAPABILITY.READ)
    .all<{ slot: number }>();
  return new Set(rows.results.map((row) => row.slot));
}

export class WorkspaceEvents extends DurableObject<Env> {
  private delivery: Promise<unknown> = Promise.resolve();
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.delivery.then(operation, operation);
    this.delivery = result.catch(() => undefined);
    return result;
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PUSH_LIMITS.PING, PUSH_LIMITS.PONG),
    );
  }
  private identity(socket: WebSocket): Attachment {
    return socket.deserializeAttachment() as Attachment;
  }
  private close(socket: WebSocket, code: number, reason: string) {
    try {
      socket.close(code, reason);
    } catch {
      /* The peer may already be closed */
    }
  }
  private send(socket: WebSocket, frame: PushFrame) {
    const attachment = this.identity(socket);
    const message = JSON.stringify(frame);
    if (attachment.frames >= PUSH_LIMITS.FRAMES_PER_CONNECTION) {
      this.close(socket, PUSH_CLOSE.ROTATE, "Renew the live update connection");
      return;
    }
    if (
      new TextEncoder().encode(message).byteLength >
      (frame.version === 2 ? SYNC_LIMITS.FRAME_BYTES : PUSH_LIMITS.FRAME_BYTES)
    ) {
      this.close(
        socket,
        PUSH_CLOSE.TOO_LARGE,
        "Live update exceeded its size limit",
      );
      return;
    }
    try {
      socket.send(message);
      socket.serializeAttachment({
        ...attachment,
        frames: attachment.frames + 1,
        revision: frame.revision,
        ...(frame.version === 2 ? { cursor: frame.update.cursor } : {}),
      });
    } catch {
      this.close(socket, PUSH_CLOSE.DELIVERY, "Live updates interrupted");
    }
  }
  private async scheduleExpiry() {
    const times: number[] = [];
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const expiresAt = this.identity(socket).expiresAt;
      if (expiresAt <= now)
        this.close(
          socket,
          PUSH_CLOSE.REAUTHENTICATE,
          "Renew live update authorization",
        );
      else times.push(expiresAt);
    }
    if (!times.length) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...times));
  }
  fetch(request: Request) {
    return this.serial(() => this.acceptConnection(request));
  }
  private async changes(identity: Attachment): Promise<SyncUpdate> {
    const service = new WorkspaceService(this.env, {
      subject: identity.subject,
      displayName: "Workspace observer",
      ...(identity.tokenId
        ? {
            tokenId: identity.tokenId,
            workspaceId: identity.workspaceId,
            scopes: [CAPABILITY.READ],
          }
        : {}),
    });
    return service.workspaceChanges({
      workspaceId: identity.workspaceId,
      ...identity.subscription!.scope,
      cursor: identity.cursor ?? identity.subscription!.cursor,
      memberRevision: identity.subscription!.memberRevision,
    });
  }
  private async acceptConnection(request: Request) {
    if (
      request.method !== "GET" ||
      new URL(request.url).pathname !== "/connect" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    )
      return new Response(null, { status: 404 });
    let identity: SocketIdentity;
    try {
      identity = socketIdentitySchema.parse(
        JSON.parse(request.headers.get(INTERNAL_IDENTITY) ?? "null"),
      );
    } catch {
      return new Response(null, { status: 403 });
    }
    if (
      !this.env.WORKSPACE_EVENTS ||
      this.env.WORKSPACE_EVENTS.idFromName(identity.workspaceId).toString() !==
        this.ctx.id.toString() ||
      identity.expiresAt <= Date.now() ||
      identity.expiresAt > Date.now() + PUSH_LIMITS.CONNECTION_MS
    )
      return new Response(null, { status: 403 });
    if (!(await allowed(this.env.HQ_DB, [identity])).has(0))
      return new Response(null, { status: 403 });
    const { revision = 0 } =
      (await this.env.HQ_DB.prepare(
        "SELECT revision FROM workspace_push_outbox WHERE workspace_id=?",
      )
        .bind(identity.workspaceId)
        .first<{ revision: number }>()) ?? {};
    const sockets = this.ctx.getWebSockets().filter((socket) => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      const attachment = this.identity(socket);
      if (attachment.expiresAt <= Date.now()) {
        this.close(
          socket,
          PUSH_CLOSE.REAUTHENTICATE,
          "Renew live update authorization",
        );
        return false;
      }
      const lastPeerAt =
        this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ??
        attachment.connectedAt;
      if (
        lastPeerAt !== undefined &&
        Date.now() - lastPeerAt >= PUSH_LIMITS.INACTIVE_MS
      ) {
        this.close(
          socket,
          PUSH_CLOSE.INACTIVE,
          "Renew the inactive live update connection",
        );
        return false;
      }
      return true;
    });
    if (
      sockets.length >= PUSH_LIMITS.SOCKETS_PER_WORKSPACE ||
      sockets.filter(
        (socket) => this.identity(socket).subject === identity.subject,
      ).length >= PUSH_LIMITS.SOCKETS_PER_SUBJECT
    )
      return new Response(null, { status: 429 });
    const update = identity.subscription
      ? await this.changes({ ...identity, revision, frames: 0 })
      : null;
    if (!(await allowed(this.env.HQ_DB, [identity])).has(0))
      return new Response(null, { status: 403 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!);
    server!.serializeAttachment({
      ...identity,
      revision,
      frames: 0,
      connectedAt: Date.now(),
    } satisfies Attachment);
    this.send(
      server!,
      identity.subscription && update
        ? {
            version: 2,
            type: "ready",
            workspaceId: identity.workspaceId,
            revision,
            expiresAt: identity.expiresAt,
            scope: identity.subscription.scope,
            update,
            topics: [],
          }
        : {
            version: 1,
            type: "ready",
            workspaceId: identity.workspaceId,
            revision,
            expiresAt: identity.expiresAt,
          },
    );
    await this.scheduleExpiry();
    return new Response(null, { status: 101, webSocket: client });
  }
  publish(input: unknown) {
    return this.serial(() => this.publishChange(input));
  }
  private async publishChange(input: unknown) {
    const change = pushChangeSchema.parse(input);
    if (
      !this.env.WORKSPACE_EVENTS ||
      this.env.WORKSPACE_EVENTS.idFromName(change.workspaceId).toString() !==
        this.ctx.id.toString()
    )
      throw new Error("Workspace notification identity mismatch");
    const sockets = this.ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.OPEN);
    if (!sockets.length) return;
    let permitted: Set<number>;
    try {
      permitted = await allowed(
        this.env.HQ_DB,
        sockets.map((socket) => this.identity(socket)),
      );
    } catch {
      for (const socket of sockets)
        this.close(
          socket,
          PUSH_CLOSE.TEMPORARY,
          "Live access could not be checked",
        );
      throw new Error("Live access unavailable");
    }
    const updates = new Map<string, SyncUpdate>();
    for (const [index, socket] of sockets.entries()) {
      const identity = this.identity(socket);
      if (identity.expiresAt <= Date.now())
        this.close(
          socket,
          PUSH_CLOSE.REAUTHENTICATE,
          "Renew live update authorization",
        );
      else if (
        identity.workspaceId !== change.workspaceId ||
        !permitted.has(index)
      )
        this.close(socket, PUSH_CLOSE.REVOKED, "Workspace access changed");
      else if (change.revision > identity.revision) {
        if (!identity.subscription) {
          this.send(socket, { version: 1, type: "invalidate", ...change });
          continue;
        }
        const { scope } = identity.subscription;
        const topics = change.topics.filter((topic) =>
          VIEW_TOPICS[scope.view].includes(topic),
        );
        if (!topics.length) {
          socket.serializeAttachment({
            ...identity,
            revision: change.revision,
          });
          continue;
        }
        const key = JSON.stringify([
          scope,
          identity.cursor ?? identity.subscription.cursor,
          identity.memberRevision,
          identity.subscription.memberRevision,
        ]);
        let update = updates.get(key);
        if (!update) {
          update = await this.changes(identity);
          updates.set(key, update);
        }
        if (
          identity.expiresAt <= Date.now() ||
          !(await allowed(this.env.HQ_DB, [identity])).has(0)
        ) {
          this.close(socket, PUSH_CLOSE.REVOKED, "Workspace access changed");
          continue;
        }
        if (
          update.type === "delta" &&
          !update.removals.length &&
          !Object.values(update.upserts).some((rows) => rows.length) &&
          topics.every((topic) => topic === "workspace")
        ) {
          socket.serializeAttachment({
            ...identity,
            revision: change.revision,
          });
          continue;
        }
        this.send(socket, {
          version: 2,
          type: "update",
          ...change,
          topics,
          scope,
          update,
        });
      }
    }
    await this.scheduleExpiry();
  }
  async alarm() {
    for (const socket of this.ctx.getWebSockets())
      if (this.identity(socket).expiresAt <= Date.now())
        this.close(
          socket,
          PUSH_CLOSE.REAUTHENTICATE,
          "Renew live update authorization",
        );
    await this.scheduleExpiry();
  }
  webSocketMessage(socket: WebSocket) {
    this.close(
      socket,
      PUSH_CLOSE.PROTOCOL,
      "This connection only delivers workspace change notifications",
    );
  }
  async webSocketClose(socket: WebSocket) {
    this.close(socket, 1000, "Live updates closed");
    await this.scheduleExpiry();
  }
  async webSocketError(socket: WebSocket) {
    this.close(socket, PUSH_CLOSE.DELIVERY, "Live updates interrupted");
    await this.scheduleExpiry();
  }
}
