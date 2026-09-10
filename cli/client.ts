import { commands, type CommandName } from "../shared/commands";
import { LIMITS, type ApiError } from "../shared/domain";
import { apiErrorMessage } from "../shared/api-errors";
import {
  fleetCommandTimeout,
  FLEET_REQUEST_INTERRUPTED,
} from "../shared/fleet-discovery";
import {
  secretCommandTimeout,
  SECRET_REQUEST_INTERRUPTED,
} from "../shared/secret-command-timeouts";

export const CLIENT_LIMITS = Object.freeze({
  HEADER_BYTES: 1024,
  ACCESS_JWT_BYTES: 16384,
  REQUEST_TIMEOUT_MS: 15000,
});

export class ClientError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export function clientConfiguration(
  url: string,
  development: boolean,
  token = process.env.HQ_TOKEN,
  accessToken = process.env.HQ_ACCESS_TOKEN,
  accessClientId = process.env.HQ_ACCESS_CLIENT_ID,
  accessClientSecret = process.env.HQ_ACCESS_CLIENT_SECRET,
) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ClientError("Use a valid workspace origin URL", 2);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
    parsed.hostname,
  );
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  )
    throw new ClientError(
      "Use an origin URL without credentials, query, or path",
      2,
    );
  if (development && !loopback)
    throw new ClientError("--dev is limited to loopback origins", 2);
  if (
    parsed.protocol !== "https:" &&
    !(development && loopback && parsed.protocol === "http:")
  )
    throw new ClientError(
      "Hosted workspaces require HTTPS; loopback HTTP requires --dev",
      2,
    );
  if (!development && token && accessToken)
    throw new ClientError(
      "Choose HQ_TOKEN for automation or HQ_ACCESS_TOKEN for a signed-in human session, not both",
      2,
    );
  if (!development && Boolean(accessClientId) !== Boolean(accessClientSecret))
    throw new ClientError(
      "Set both HQ_ACCESS_CLIENT_ID and HQ_ACCESS_CLIENT_SECRET for the Access service gate",
      2,
    );
  if (!development && accessToken && (accessClientId || accessClientSecret))
    throw new ClientError(
      "Choose a human HQ_ACCESS_TOKEN session or automation Access service credentials, not both",
      2,
    );
  if (
    !development &&
    [accessClientId, accessClientSecret].some(
      (value) =>
        value &&
        (value.length > CLIENT_LIMITS.HEADER_BYTES ||
          !/^[\x21-\x7e]+$/.test(value)),
    )
  )
    throw new ClientError(
      "Access service credentials must be bounded header-safe values",
      2,
    );
  if (!development && !token && !accessToken)
    throw new ClientError(
      "Set HQ_TOKEN for an enrolled workspace credential or HQ_ACCESS_TOKEN for a signed-in human session; use --dev only for loopback",
      2,
    );
  if (
    !development &&
    accessToken &&
    (accessToken.length > CLIENT_LIMITS.ACCESS_JWT_BYTES ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken))
  )
    throw new ClientError(
      "HQ_ACCESS_TOKEN must be a bounded Access application session token",
      2,
    );
  if (
    !development &&
    token &&
    (token.length > CLIENT_LIMITS.HEADER_BYTES || !/^[\x21-\x7e]+$/.test(token))
  )
    throw new ClientError("HQ_TOKEN is not a valid workspace credential", 2);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (development) headers["X-HQ-Client"] = "cli";
  else if (accessToken) {
    headers.Cookie = "CF_Authorization=" + accessToken;
    headers.Origin = parsed.origin;
  } else {
    headers.Authorization = "Bearer " + token;
    if (accessClientId && accessClientSecret) {
      headers["CF-Access-Client-Id"] = accessClientId;
      headers["CF-Access-Client-Secret"] = accessClientSecret;
    }
  }
  return { origin: parsed.origin, headers };
}

export async function callCommand(
  configuration: ReturnType<typeof clientConfiguration>,
  name: CommandName,
  input: unknown,
) {
  let parsed: unknown;
  try {
    parsed = commands[name].schema.parse(input);
  } catch {
    throw new ClientError(
      "Input does not match the command schema. Run schema " +
        name +
        " for the expected fields.",
      2,
    );
  }
  const body = JSON.stringify(parsed);
  if (Buffer.byteLength(body) > LIMITS.BODY_BYTES)
    throw new ClientError("Input exceeds the request size limit", 2);
  let response: Response;
  const timeout = fleetCommandTimeout(name) ?? secretCommandTimeout(name);
  const interrupted = fleetCommandTimeout(name)
    ? FLEET_REQUEST_INTERRUPTED
    : SECRET_REQUEST_INTERRUPTED;
  try {
    response = await fetch(configuration.origin + "/api/commands/" + name, {
      method: "POST",
      headers: configuration.headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeout ?? CLIENT_LIMITS.REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ClientError(
      timeout
        ? interrupted
        : "The workspace could not be reached. An interrupted write may have succeeded; retry with the same event ID or inspect the workspace before proceeding.",
    );
  }
  if (
    response.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  ) {
    await response.body?.cancel();
    throw new ClientError(
      "The workspace returned a sign-in page or non-API response. Check your Access session or paired service credentials. An interrupted write may have succeeded; inspect before issuing a replacement credential.",
    );
  }
  if (!response.ok) {
    let message = "Workspace request failed (" + response.status + ")";
    try {
      message = apiErrorMessage(((await response.json()) as ApiError).error);
    } catch {
      /* Never print proxy response bodies */
    }
    throw new ClientError(message);
  }
  try {
    return await response.json();
  } catch {
    throw new ClientError(
      timeout
        ? interrupted
        : "The workspace response was interrupted or incomplete. Inspect the workspace before repeating a write.",
    );
  }
}
