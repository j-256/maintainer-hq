import { supplyProviderCredential } from "../../shared/provider-credential-input";
import type { ProviderCredentialReview } from "../../shared/provider-credentials";
import { command } from "./api";

export function supplyBrowserCredential(
  workspaceId: string,
  review: ProviderCredentialReview,
  read: () => Promise<Uint8Array>,
) {
  return supplyProviderCredential({
    selection: {
      workspaceId,
      planId: review.id,
      fingerprint: review.fingerprint,
    },
    read,
    review: (selection) => command("provider_credential_review", selection),
    send: (path, init) => fetch(path, { ...init, credentials: "same-origin" }),
  });
}
