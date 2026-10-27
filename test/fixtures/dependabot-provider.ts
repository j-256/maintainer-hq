export const DEPENDABOT_PROVIDER = Object.freeze({
  repository: "example/schedule-fixture",
  token: "synthetic-schedule-reader",
  head: "a".repeat(40),
  root: "b".repeat(40),
  github: "c".repeat(40),
  privateValue: "PRIVATE_REGISTRY_VALUE_NOT_FOR_RESPONSES",
});
export const DEPENDABOT_SOURCE = `version: 2
registries:
  private:
    type: npm-registry
    token: ${DEPENDABOT_PROVIDER.privateValue}
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "08:00"
`;
export async function dependabotProviderFixture(
  source: string | Uint8Array = DEPENDABOT_SOURCE,
) {
  const F = DEPENDABOT_PROVIDER;
  const bytes =
    typeof source === "string" ? new TextEncoder().encode(source) : source;
  const prefix = new TextEncoder().encode("blob " + bytes.byteLength + "\0");
  const object = new Uint8Array(prefix.length + bytes.length);
  object.set(prefix);
  object.set(bytes, prefix.length);
  const sha = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-1", object)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const blob = {
    sha,
    size: bytes.length,
    encoding: "base64",
    content: btoa(String.fromCharCode(...bytes)),
  };
  const root = {
    sha: F.root,
    truncated: false,
    tree: [{ path: ".github", type: "tree", mode: "040000", sha: F.github }],
  };
  const tree = {
    sha: F.github,
    truncated: false,
    tree: [
      {
        path: "dependabot.yml",
        type: "blob",
        mode: "100644",
        sha,
        size: bytes.length,
      },
    ],
  };
  return {
    source,
    blob,
    root,
    tree,
    response(url: URL): Response {
      const suffix = url.pathname.slice(("/repos/" + F.repository).length);
      if (!suffix)
        return Response.json({
          full_name: F.repository,
          default_branch: "main",
        });
      if (suffix === "/branches/main")
        return Response.json({
          name: "main",
          commit: { sha: F.head, commit: { tree: { sha: F.root } } },
        });
      if (suffix === "/git/trees/" + F.root) return Response.json(root);
      if (suffix === "/git/trees/" + F.github) return Response.json(tree);
      if (suffix === "/git/blobs/" + sha) return Response.json(blob);
      return new Response(null, { status: 404 });
    },
  };
}
