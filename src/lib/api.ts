import type { ApiError } from "../../shared/domain";
import { apiErrorMessage } from "../../shared/api-errors";
import type { CommandName } from "../../shared/commands";
import {
  secretCommandTimeout,
  SECRET_REQUEST_INTERRUPTED,
} from "../../shared/secret-command-timeouts";

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "request_failed",
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      redirect: "error",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new RequestError(
      "The workspace could not be reached. If sign-in expired, sign in again in another tab and retry. Your draft is still here.",
      0,
    );
  }
  if (
    response.ok &&
    !response.headers.get("Content-Type")?.includes("application/json")
  )
    throw new RequestError(
      "Sign in again in another tab, then retry. Your draft is still here.",
      401,
      "sign_in_required",
    );
  if (!response.ok) {
    let message =
      "The workspace could not be reached. Your draft is still here.";
    let code = "request_failed";
    try {
      const error = ((await response.json()) as ApiError).error;
      message = apiErrorMessage(error);
      code = error.code;
    } catch {
      /* Preserve a safe fallback for proxy failures */
    }
    throw new RequestError(message, response.status, code);
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (init?.signal?.aborted && error instanceof Error && error.name === "AbortError")
      throw error;
    throw new RequestError(
      "The workspace response was interrupted or incomplete. A write may have succeeded. Inspect the saved state or the same operation receipt before repeating it. Your draft is still here.",
      0,
      "response_interrupted",
    );
  }
}

export async function command<T>(
  name: CommandName,
  input: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = secretCommandTimeout(name);
  const deadline = timeout ? AbortSignal.timeout(timeout) : undefined;
  try {
    return await request<T>("/api/commands/" + name, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal:
        deadline && signal
          ? AbortSignal.any([signal, deadline])
          : (deadline ?? signal),
    });
  } catch (error) {
    if (
      !deadline ||
      signal?.aborted ||
      (error instanceof RequestError && error.status > 0 && !deadline.aborted)
    )
      throw error;
    throw new RequestError(
      SECRET_REQUEST_INTERRUPTED,
      0,
      "secret_request_interrupted",
    );
  }
}
