export const APP_AUTHENTICATION_RETRIES = 1;
import { DomainError } from "./errors";

// Only a transport that has not invoked its provider request may create this proof
export class ProviderWriteNotSentError extends Error {
  readonly reason: "authority_changed" | "rate_limited";
  constructor(error: unknown) {
    super("The provider write was refused before submission");
    this.reason =
      error instanceof DomainError && error.code === "github_app_rate_limited"
        ? "rate_limited"
        : "authority_changed";
  }
}
