import { describe, expect, it } from "vitest";
import { HQ_CREDENTIAL_PREFIX } from "../shared/credentials";

describe("HQ credential prefixes", () => {
  it("keeps credential classes explicit, stable, and distinct", () => {
    expect(HQ_CREDENTIAL_PREFIX).toEqual({
      AUTOMATION: "hqa_",
      PUBLISHER: "hqp_",
    });
    expect(new Set(Object.values(HQ_CREDENTIAL_PREFIX)).size).toBe(
      Object.values(HQ_CREDENTIAL_PREFIX).length,
    );
  });
});
