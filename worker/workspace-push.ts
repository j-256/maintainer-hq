import { PUSH_LIMITS, topicsFromMask } from "../shared/workspace-push";
import { emitDiagnostic } from "./diagnostics";
import type { Env } from "./types";

export async function flushWorkspacePush(env: Env, workspaceId?: string) {
  if (!env.WORKSPACE_EVENTS) return;
  const rows = await env.HQ_DB.prepare(
    `SELECT workspace_id,revision,pending_topics FROM workspace_push_outbox
    WHERE pending_topics<>0 AND (? IS NULL OR workspace_id=?) ORDER BY workspace_id LIMIT ?`,
  )
    .bind(
      workspaceId ?? null,
      workspaceId ?? null,
      PUSH_LIMITS.WORKSPACES_PER_FLUSH,
    )
    .all<{ workspace_id: string; revision: number; pending_topics: number }>();
  let interrupted = false;
  for (const row of rows.results) {
    try {
      await env.WORKSPACE_EVENTS.getByName(row.workspace_id).publish({
        workspaceId: row.workspace_id,
        revision: row.revision,
        topics: topicsFromMask(row.pending_topics),
      });
      await env.HQ_DB.prepare(
        "UPDATE workspace_push_outbox SET pending_topics=0 WHERE workspace_id=? AND revision=?",
      )
        .bind(row.workspace_id, row.revision)
        .run();
    } catch {
      interrupted = true;
    }
  }
  if (interrupted)
    throw new Error("Workspace notifications retained for retry");
}

export async function deliverWorkspacePush(env: Env, workspaceId?: string) {
  try {
    await flushWorkspacePush(env, workspaceId);
  } catch {
    emitDiagnostic({ event: "hq.push.interrupted", pendingRetained: true });
  }
}
