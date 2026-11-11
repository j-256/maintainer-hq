import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DependencyGitHub, dependencyProviderDiagnostic } from "../worker/dependency-github";
import { DomainError } from "../worker/errors";
import { emitDiagnostic, type Diagnostic } from "../worker/diagnostics";

const PRIVATE = "private-provider-detail-must-stay-private";
const SHA = "a".repeat(40);

describe("bounded maintenance provider failure diagnostics", () => {
  it("retains a transport classification without exposing exception text or replaying a write", async () => {
    const client = new DependencyGitHub("example/repository", "synthetic-token", async () => {
      throw new TypeError(PRIVATE);
    });
    const error = await client.tree(SHA, []).catch((error: unknown) => error);
    expect(error).toMatchObject({
      reason: "outcome_unknown",
      diagnostic: { stage: "fetch", errorType: "TypeError" },
    });
    expect(client.requests).toBe(1);
    expect(JSON.stringify(error)).not.toContain(PRIVATE);
  });

  it("records the observed HTTP status without retaining the provider body", async () => {
    const client = new DependencyGitHub("example/repository", "synthetic-token", async () => new Response(PRIVATE, { status: 502 }));
    const error = await client.tree(SHA, []).catch((error: unknown) => error);
    expect(error).toMatchObject({
      reason: "outcome_unknown",
      diagnostic: { stage: "response", errorType: "HttpStatus", status: 502 },
    });
    expect(JSON.stringify(error)).not.toContain(PRIVATE);
  });

  it("distinguishes an invalid response after provider acceptance", async () => {
    const client = new DependencyGitHub("example/repository", "synthetic-token", async () => new Response(PRIVATE, { status: 201 }));
    const error = await client.tree(SHA, []).catch((error: unknown) => error);
    expect(error).toMatchObject({
      reason: "outcome_unknown",
      diagnostic: { stage: "decode", errorType: "SyntaxError", status: 201 },
    });
    expect(JSON.stringify(error)).not.toContain(PRIVATE);
  });

  it("preserves a failed authority fence and its observed status without changing the error", async () => {
    const failure = new DomainError("dependency_access_changed", PRIVATE, 409);
    const client = new DependencyGitHub("example/repository", "synthetic-token", async () => Response.json({ sha: SHA }, { status: 201 }), undefined, undefined, async () => ({ token: "synthetic-token", assertLive: async () => { throw failure; } }));
    const error = await client.tree(SHA, []).catch((error: unknown) => error);
    expect(error).toBe(failure);
    const diagnostic = dependencyProviderDiagnostic(error);
    expect(diagnostic).toEqual({ stage: "fence", errorType: "DomainError", status: 201 });
    expect(JSON.stringify(diagnostic)).not.toContain(PRIVATE);
  });

  it("retains observed status when response schema validation fails", async () => {
    const client = new DependencyGitHub("example/repository", "synthetic-token", async () => Response.json({ sha: "invalid", privateDetail: PRIVATE }, { status: 201 }));
    const error = await client.tree(SHA, []).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(z.ZodError);
    const diagnostic = dependencyProviderDiagnostic(error);
    expect(diagnostic).toEqual({ stage: "validation", errorType: "ZodError", status: 201 });
    expect(JSON.stringify(diagnostic)).not.toContain(PRIVATE);
  });

  it("emits allowlisted failure metadata and rejects private or arbitrary additions", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event = {
      event: "hq.dependabot.operation", action: "reconcile", reference: crypto.randomUUID(),
      workspaceId: "fixture", repositoryId: "repository", phase: "tree", status: "indeterminate",
      reason: "provider_unavailable", requests: 1, elapsedMs: 1,
      providerFailure: { stage: "fetch", errorType: "TypeError" },
    } as const;
    try {
      emitDiagnostic(event as Diagnostic);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ providerFailure: event.providerFailure }));
      log.mockClear();
      emitDiagnostic({ ...event, providerFailure: { ...event.providerFailure, message: PRIVATE } } as unknown as Diagnostic);
      emitDiagnostic({ ...event, providerFailure: { ...event.providerFailure, errorType: PRIVATE } } as unknown as Diagnostic);
      expect(log).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE);
    } finally { log.mockRestore(); }
  });
});
