import { dependencyFixture } from "./dependencies";
import { DEPENDENCY_POLICY_PATH } from "../../shared/dependency-policy";

export const DEPENDENCY_PROVIDER = Object.freeze({
  repository: "example/dependency-fixture",
  token: "synthetic-read-credential",
  head: "a".repeat(40),
  tree: "b".repeat(40),
  privateValue: "PRIVATE_MANIFEST_VALUE_NOT_FOR_RESPONSES",
});
export async function dependencyProviderFixture(
  fixture = dependencyFixture(),
  candidate?: { number: number; branch: string },
) {
  const { repository, head, tree, privateValue } = DEPENDENCY_PROVIDER;
  const files = new Map<string, string>([
    [DEPENDENCY_POLICY_PATH, JSON.stringify(fixture.policy, null, 2) + "\n"],
    [
      "package.json",
      JSON.stringify(
        { ...fixture.manifest, privateNote: privateValue },
        null,
        2,
      ) + "\n",
    ],
    ["package-lock.json", JSON.stringify(fixture.lock, null, 2) + "\n"],
  ]);
  const blobs = new Map<string, unknown>();
  const entries: {
    path: string;
    type: string;
    mode: string;
    sha: string;
    size: number;
  }[] = [];
  for (const [path, text] of files) {
    const bytes = new TextEncoder().encode(text);
    const object = new TextEncoder().encode(
      "blob " + bytes.byteLength + "\0" + text,
    );
    const sha = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-1", object)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    entries.push({
      path,
      type: "blob",
      mode: "100644",
      sha,
      size: bytes.byteLength,
    });
    blobs.set(sha, {
      sha,
      size: bytes.byteLength,
      encoding: "base64",
      content: btoa(String.fromCharCode(...bytes)),
    });
  }
  const treeResponse = { sha: tree, truncated: false, tree: entries };
  return {
    fixture,
    files,
    blobs,
    tree: treeResponse,
    response(url: URL): Response {
      const suffix = url.pathname.slice(("/repos/" + repository).length);
      if (!suffix)
        return Response.json({ full_name: repository, default_branch: "main" });
      if (candidate && suffix === "/pulls/" + candidate.number)
        return Response.json({
          number: candidate.number,
          state: "open",
          head: {
            ref: candidate.branch,
            sha: head,
            repo: { full_name: repository },
          },
          base: { repo: { full_name: repository } },
        });
      if (
        suffix ===
        "/branches/" + encodeURIComponent(candidate?.branch ?? "main")
      )
        return Response.json({
          name: candidate?.branch ?? "main",
          commit: { sha: head, commit: { tree: { sha: tree } } },
        });
      if (suffix === "/git/trees/" + tree) return Response.json(treeResponse);
      const blob = blobs.get(suffix.slice("/git/blobs/".length));
      return blob ? Response.json(blob) : new Response(null, { status: 404 });
    },
  };
}
