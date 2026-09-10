import type { ApiError } from "./domain";

export function apiErrorMessage(error: ApiError["error"]) {
  const reference =
    typeof error.reference === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      error.reference,
    )
      ? error.reference
      : null;
  return (
    error.message + (reference ? " Support reference: " + reference + "." : "")
  );
}
