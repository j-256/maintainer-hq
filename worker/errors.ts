import { ZodError } from "zod";
import type { ApiError } from "../shared/domain";
import { emitDiagnostic } from "./diagnostics";

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function errorResponse(
  error: unknown,
  context: { operation?: string; started?: number } = {},
): Response {
  const reference = crypto.randomUUID();
  const respond = (
    body: ApiError,
    status: number,
    classification: "domain" | "validation" | "unexpected",
  ) => {
    emitDiagnostic({
      event: "hq.request.failed",
      reference,
      operation: context.operation ?? "request",
      status,
      classification,
      elapsedMs: Math.max(
        0,
        Math.round(performance.now() - (context.started ?? performance.now())),
      ),
    });
    return Response.json(
      { error: { ...body.error, reference } },
      { status, headers: { "X-HQ-Support-Reference": reference } },
    );
  };
  if (error instanceof DomainError)
    return respond(
      { error: { code: error.code, message: error.message } },
      error.status,
      "domain",
    );
  if (error instanceof ZodError) {
    const fields = Object.fromEntries(
      error.issues.map((issue) => [issue.path.join("."), "Check this field"]),
    );
    return respond(
      {
        error: {
          code: "validation",
          message: "Some fields need your attention",
          fields,
        },
      },
      400,
      "validation",
    );
  }
  return respond(
    {
      error: {
        code: "unavailable",
        message:
          "This request could not be completed. A write may have succeeded. Inspect the saved state or the same operation receipt before repeating it.",
      },
    },
    503,
    "unexpected",
  );
}
