import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "parse5";
import accessibleBlocks from "./accessible-blocks.mjs";

const SCRIPT_RESOURCES = ["'self'", "'wasm-unsafe-eval'"];
const MAX_SCRIPT_BYTES = 128 * 1024;

function elements(node, predicate) {
  const result = predicate(node) ? [node] : [];
  for (const child of node.childNodes ?? []) result.push(...elements(child, predicate));
  return result;
}
function attribute(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value;
}

export function sealPage(html) {
  const page = parse(html, { sourceCodeLocationInfo: true });
  const metas = elements(page, (node) => node.tagName === "meta" && attribute(node, "http-equiv")?.toLowerCase() === "content-security-policy");
  assert.equal(metas.length, 1, "Expected the generated page policy");
  const meta = metas[0];
  const policy = attribute(meta, "content").split(";").map((item) => item.trim()).filter(Boolean);
  assert.equal(policy.filter((item) => item.startsWith("script-src ")).length, 1);
  const head = elements(page, (node) => node.tagName === "head")[0];
  const charset = head.childNodes.find((node) => node.tagName === "meta" && attribute(node, "charset"));
  assert.ok(charset?.sourceCodeLocation, "A declared character encoding is required");
  const insertion = charset.sourceCodeLocation.endOffset;
  const hashes = new Set();
  for (const script of elements(page, (node) => node.tagName === "script")) {
    assert.ok(script.sourceCodeLocation.startOffset >= insertion, "Character encoding must precede scripts");
    const src = attribute(script, "src");
    if (src) {
      assert.ok(src.startsWith("/") && !src.startsWith("//"), "Only same-origin compiled scripts are allowed");
      continue;
    }
    const source = (script.childNodes ?? []).map((node) => node.value ?? "").join("");
    assert.ok(Buffer.byteLength(source) <= MAX_SCRIPT_BYTES, "Inline script exceeds the reviewed bound");
    hashes.add("'sha256-" + createHash("sha256").update(source).digest("base64") + "'");
  }
  const sealed = policy.map((directive) => directive.startsWith("script-src ")
    ? "script-src " + [...SCRIPT_RESOURCES, ...[...hashes].sort()].join(" ")
    : directive).join("; ");
  assert.equal(sealed.includes('"'), false, "Policy cannot contain attribute delimiters");
  const location = meta.sourceCodeLocation;
  assert.ok(location && location.startOffset >= insertion);
  const withoutPolicy = html.slice(0, location.startOffset) + html.slice(location.endOffset);
  const markup = '<meta http-equiv="content-security-policy" content="' + sealed + '">';
  return withoutPolicy.slice(0, insertion) + markup + withoutPolicy.slice(insertion);
}

export default function sealPages() {
  return {
    name: "hq-final-page-policy",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        async function walk(directory) {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            assert.equal(entry.isSymbolicLink(), false, "Build output cannot contain symlinks");
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.name.endsWith(".html")) {
              const html = await readFile(path, "utf8");
              await writeFile(path, sealPage(accessibleBlocks(html)));
            }
          }
        }
        await walk(fileURLToPath(dir));
      },
    },
  };
}
