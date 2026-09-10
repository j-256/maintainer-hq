import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../worker/app";
import { DomainError, errorResponse } from "../worker/errors";
import { emitDiagnostic, type Diagnostic } from "../worker/diagnostics";
import { request } from "../src/lib/api";
import { callCommand, clientConfiguration } from "../cli/client";
import { runGitHubScheduled } from "../worker/github-runner";
import {
  githubScheduleNotice,
  GITHUB_REFRESH_LIMITS,
  type GitHubSource,
} from "../shared/github";
import type { ApiError } from "../shared/domain";
import type { Env } from "../worker/types";

const PRIVATE = "synthetic-secret-in-exception-body-url-or-header";
const origin = "https://workspace.example";
const owner = { subject: "owner", displayName: "Owner" };
const brokenDatabase = {
  HQ_DB: {
    prepare() {
      throw new Error(PRIVATE);
    },
  },
} as unknown as Env;
afterEach(() => vi.restoreAllMocks());

describe("Safe correlated diagnostics", () => {
  it("shares a server-generated support reference without recording exception text or client-supplied context", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApplication(async () => {
      throw new TypeError(PRIVATE);
    });
    const response = await app.fetch(
      new Request(origin + "/api/session?secret=" + PRIVATE, {
        headers: { Authorization: PRIVATE, "X-HQ-Support-Reference": PRIVATE },
      }),
      brokenDatabase,
    );
    const result = (await response.json()) as ApiError;
    expect(response.status).toBe(503);
    expect(result.error.reference).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers.get("X-HQ-Support-Reference")).toBe(
      result.error.reference,
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 1,
        event: "hq.request.failed",
        reference: result.error.reference,
        classification: "unexpected",
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
  });

  it("preserves domain status and keeps diagnostic emission from breaking failures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("Logging unavailable");
    });
    const response = errorResponse(
      new DomainError("forbidden", "Read-only access", 403),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: "forbidden",
        message: "Read-only access",
        reference: expect.any(String),
      },
    });
  });

  it("rejects extra log fields and unsafe operation names at the emission boundary", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const safe = {
      event: "hq.request.failed",
      reference: crypto.randomUUID(),
      operation: "session",
      status: 403,
      classification: "domain",
      elapsedMs: 1,
    } as const;
    emitDiagnostic({ ...safe, token: PRIVATE } as Diagnostic);
    emitDiagnostic({ ...safe, operation: PRIVATE + "/path" });
    expect(log).not.toHaveBeenCalled();
    emitDiagnostic(safe);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("preserves support references through browser, CLI and hosted MCP failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApplication(async () => owner);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      app.fetch(
        new Request(new URL(String(input), origin), {
          ...init,
          redirect: "manual",
          headers: { ...init?.headers, Origin: origin },
        }),
        brokenDatabase,
      ),
    );
    const input = { workspaceId: "alpha" };
    await expect(
      request("/api/commands/workspace_snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    ).rejects.toThrow(/Support reference: [a-f0-9-]{36}/);
    await expect(
      callCommand(
        clientConfiguration(origin, false, "synthetic-token"),
        "workspace_snapshot",
        input,
      ),
    ).rejects.toThrow(/Support reference: [a-f0-9-]{36}/);
    const rpc = await app.fetch(
      new Request(origin + "/mcp", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "workspace_snapshot", arguments: input },
        }),
      }),
      brokenDatabase,
    );
    const body = (await rpc.json()) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).toBe(true);
    const error = JSON.parse(body.result.content[0].text) as ApiError;
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "workspace_snapshot",
        reference: error.error.reference,
      }),
    );
    expect(log).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE);
  });

  it("records scheduler setup failures without raw database errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runGitHubScheduled(brokenDatabase)).rejects.toThrow(PRIVATE);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "hq.github.batch.completed",
        processed: 0,
        trigger: "scheduled",
        stopReason: "unexpected",
        failed: true,
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE);
  });
});

describe("Honest schedule notices", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  const source = {
    enabled: true,
    credentialConfigured: true,
    repositoryIds: ["one"],
    lastAttemptAt: new Date(now - 86400000).toISOString(),
    github: {
      configurationValid: true,
      activeRefreshId: null,
      retryAt: null,
      nextRefreshAt: new Date(now - 180000).toISOString(),
    },
  } as unknown as GitHubSource;
  it("uses server time and distinguishes overdue eligibility from slow active work", () => {
    expect(githubScheduleNotice(source, now)).toContain("overdue");
    const active = {
      ...source,
      github: { ...source.github, activeRefreshId: "refresh" },
    };
    expect(githubScheduleNotice(active, now)).toContain("queue allowance");
    const queued = {
      ...active,
      repositoryIds: Array.from(
        { length: GITHUB_REFRESH_LIMITS.REPOSITORIES },
        (_, i) => String(i),
      ),
      lastAttemptAt: new Date(now - 180000).toISOString(),
    };
    expect(githubScheduleNotice(queued, now)).toBeNull();
    expect(githubScheduleNotice(source, NaN)).toBeNull();
  });
  it("does not blame the scheduler for disabled, unconfigured or cooling-down sources", () => {
    expect(githubScheduleNotice({ ...source, enabled: false }, now)).toBeNull();
    expect(
      githubScheduleNotice({ ...source, credentialConfigured: false }, now),
    ).toBeNull();
    expect(
      githubScheduleNotice(
        { ...source, github: { ...source.github, configurationValid: false } },
        now,
      ),
    ).toBeNull();
    expect(
      githubScheduleNotice(
        {
          ...source,
          github: {
            ...source.github,
            retryAt: new Date(now + 60000).toISOString(),
          },
        },
        now,
      ),
    ).toBeNull();
  });
});
