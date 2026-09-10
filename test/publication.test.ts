import { describe, expect, it } from "vitest";
import {
  hasExactSourceRepositoryUrl,
  SOURCE_REPOSITORY_URL,
} from "../scripts/check-publication.ts";

describe("publication source link", () => {
  it("accepts the exact repository URL in generated client code", () => {
    expect(
      hasExactSourceRepositoryUrl(
        `const source={href:"${SOURCE_REPOSITORY_URL}"}`,
      ),
    ).toBe(true);
  });

  it("rejects lookalike and embedded repository URLs", () => {
    for (const candidate of [
      "https://github.com.example/j-256/maintainer-hq",
      "https://example.test/?next=" + SOURCE_REPOSITORY_URL,
      SOURCE_REPOSITORY_URL + ".git",
      SOURCE_REPOSITORY_URL + "/issues",
      SOURCE_REPOSITORY_URL + "?tab=readme",
      SOURCE_REPOSITORY_URL + "#readme",
      "https://j-256@github.com/j-256/maintainer-hq",
      "prefix" + SOURCE_REPOSITORY_URL,
    ])
      expect(hasExactSourceRepositoryUrl(`const source="${candidate}"`)).toBe(
        false,
      );
  });
});
