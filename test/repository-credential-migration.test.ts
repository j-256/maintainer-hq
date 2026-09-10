import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  sealProviderCredential,
  openProviderCredential,
  type CredentialBinding,
} from "../worker/provider-credential-crypto";

const bindings = env as unknown as {
  HQ_DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
it("widens credential purpose without changing existing ciphertext, identities, history, or push triggers", async () => {
  const index = bindings.TEST_MIGRATIONS.findIndex(
    (item) => item.name === "0034_repository_credentials.sql",
  );
  expect(index).toBeGreaterThan(0);
  const db = bindings.HQ_DB;
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(0, index));
  await db
    .prepare(
      "INSERT INTO workspaces (id,name,created_at) VALUES ('upgrade','Upgrade','2026-01-01')",
    )
    .run();
  const environment = {
    PROVIDER_CREDENTIAL_KEYS: JSON.stringify({
      version: 1,
      activeKeyId: "test",
      keys: [{ id: "test", key: btoa("a".repeat(32)) }],
    }),
  };
  const binding: CredentialBinding = {
    workspaceId: "upgrade",
    credentialId: "managed-existing",
    revision: 3,
    identity: "a".repeat(64),
    settings: {
      name: "Existing GitHub access",
      providerKind: "github-actions",
      expiresAt: "2099-01-01T00:00:00.000Z",
      writable: true,
      scope: { repositoryNames: ["example/fixture"] },
    },
  };
  const encrypted = await sealProviderCredential(
    environment,
    binding,
    "synthetic-preserved-token",
  );
  await db
    .prepare(
      "INSERT INTO provider_credentials (workspace_id,id,provider_kind,settings_json,revision,identity,key_id,nonce,ciphertext,created_at,updated_at,write_id) VALUES (?,?,?,?,?,?,?,?,?,'2026-01-01','2026-01-01','original')",
    )
    .bind(
      binding.workspaceId,
      binding.credentialId,
      binding.settings.providerKind,
      JSON.stringify(binding.settings),
      binding.revision,
      binding.identity,
      encrypted.keyId,
      encrypted.nonce,
      encrypted.ciphertext,
    )
    .run();
  const before = await db.prepare("SELECT * FROM provider_credentials").all();
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS.slice(index));
  const after = await db.prepare("SELECT * FROM provider_credentials").all();
  expect(after.results).toEqual(before.results);
  expect(await openProviderCredential(environment, binding, encrypted)).toBe(
    "synthetic-preserved-token",
  );
  await db.prepare("DELETE FROM workspace_push_outbox").run();
  await db
    .prepare("UPDATE provider_credentials SET revision=revision+1 WHERE id=?")
    .bind(binding.credentialId)
    .run();
  expect(
    await db
      .prepare(
        "SELECT pending_topics FROM workspace_push_outbox WHERE workspace_id='upgrade'",
      )
      .first("pending_topics"),
  ).toBe(1);
});
