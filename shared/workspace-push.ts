import { z } from "zod";
import { idSchema } from "./domain";
import { syncScopeSchema, syncUpdateSchema } from "./workspace-sync";

export const PUSH_TOPIC = Object.freeze({
  workspace: 1,
  activity: 2,
  sources: 4,
  hooks: 8,
  monitoring: 16,
  access: 32,
  associations: 64,
  operations: 128,
});
export type PushTopic = keyof typeof PUSH_TOPIC;
export const PUSH_TOPICS = Object.keys(PUSH_TOPIC) as PushTopic[];
export const PUSH_LIMITS = Object.freeze({
  TOPIC_MASK: 255,
  WORKSPACES_PER_FLUSH: 10,
  SOCKETS_PER_WORKSPACE: 32,
  SOCKETS_PER_SUBJECT: 8,
  FRAMES_PER_CONNECTION: 256,
  CONNECTION_MS: 30 * 60 * 1000,
  FRAME_BYTES: 2048,
  HANDSHAKE_MS: 10000,
  HEARTBEAT_MS: 30000,
  HEARTBEAT_TIMEOUT_MS: 10000,
  INACTIVE_MS: 90_000,
  RECONNECT_MIN_MS: 1000,
  RECONNECT_MAX_MS: 60000,
  FALLBACK_MS: 60000,
  COALESCE_MS: 200,
  PING: "hq.ping.v1",
  PONG: "hq.pong.v1",
});
export const PUSH_CLOSE = Object.freeze({
  REAUTHENTICATE: 4001,
  ROTATE: 4002,
  REVOKED: 4003,
  INACTIVE: 4004,
  PROTOCOL: 1008,
  TOO_LARGE: 1009,
  DELIVERY: 1011,
  TEMPORARY: 1013,
});
export const pushChangeSchema = z
  .object({
    workspaceId: idSchema,
    revision: z.number().int().nonnegative().safe(),
    topics: z
      .array(z.enum(PUSH_TOPICS as [PushTopic, ...PushTopic[]]))
      .min(1)
      .max(PUSH_TOPICS.length),
  })
  .strict();
const legacyFrameSchema = z.discriminatedUnion("type", [
  pushChangeSchema
    .extend({ version: z.literal(1), type: z.literal("invalidate") })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("ready"),
      workspaceId: idSchema,
      revision: z.number().int().nonnegative().safe(),
      expiresAt: z.number().int().positive().safe(),
    })
    .strict(),
]);
const viewFrameBase = z
  .object({
    version: z.literal(2),
    workspaceId: idSchema,
    revision: z.number().int().nonnegative().safe(),
    scope: syncScopeSchema,
    topics: z
      .array(z.enum(PUSH_TOPICS as [PushTopic, ...PushTopic[]]))
      .max(PUSH_TOPICS.length),
    update: syncUpdateSchema,
  })
  .strict();
export const viewFrameSchema = z.discriminatedUnion("type", [
  viewFrameBase
    .extend({
      type: z.literal("ready"),
      expiresAt: z.number().int().positive().safe(),
    })
    .strict(),
  viewFrameBase.extend({ type: z.literal("update") }).strict(),
]);
export const pushFrameSchema = z.union([legacyFrameSchema, viewFrameSchema]);
export type PushChange = z.infer<typeof pushChangeSchema>;
export type PushFrame = z.infer<typeof pushFrameSchema>;
export function topicsFromMask(mask: number): PushTopic[] {
  return PUSH_TOPICS.filter((topic) => Boolean(mask & PUSH_TOPIC[topic]));
}
