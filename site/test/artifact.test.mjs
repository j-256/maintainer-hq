import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { test } from "node:test";
import { parse } from "parse5";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const DOCS = fileURLToPath(new URL("../../docs/", import.meta.url));
const ORIGIN = "https://docs.hq.lasers.app";
const SOURCE_REPOSITORY_URL = "https://github.com/j-256/maintainer-hq";
const FREE_ASSET_LIMITS = Object.freeze({ files: 20_000, fileBytes: 25 * 1024 * 1024 });

function elements(node, predicate) {
  const found = [];
  if (predicate(node)) found.push(node);
  for (const child of node.childNodes ?? []) found.push(...elements(child, predicate));
  return found;
}
function attribute(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value;
}
function content(node) {
  return node.nodeName === "#text" ? node.value : (node.childNodes ?? []).map(content).join("");
}
async function files(path = DIST) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    assert.equal(entry.isSymbolicLink(), false, "Static output cannot contain symlinks");
    if (entry.isDirectory()) result.push(...await files(full));
    else {
      assert.ok(entry.isFile(), "Static output must contain ordinary files");
      result.push(full);
    }
  }
  return result;
}
const inventory = await files();
const pages = new Map();
for (const file of inventory.filter((path) => path.endsWith(".html"))) {
  const path = "/" + relative(DIST, file).replace(/index\.html$/, "");
  pages.set(path, parse(await readFile(file, "utf8"), { sourceCodeLocationInfo: true }));
}

test("publishes every authored guide once with a meaningful title and canonical URL", async () => {
  for (const file of (await readdir(DOCS)).filter((path) => path.endsWith(".md"))) {
    const path = file === "index.md" ? "/" : "/" + file.slice(0, -3) + "/";
    const page = pages.get(path);
    assert.ok(page, "Missing published guide " + path);
    const headings = elements(page, (node) => node.tagName === "h1");
    assert.equal(headings.length, 1, path + " needs one page title");
    assert.ok(content(headings[0]).length > 3);
    const article = elements(page, (node) => attribute(node, "class")?.split(" ").includes("sl-markdown-content"));
    assert.equal(article.length, 1, path + " needs an authored article");
    assert.ok(content(article[0]).trim().length > 100, path + " has empty or incomplete authored content");
    const canonical = elements(page, (node) => node.tagName === "link" && attribute(node, "rel") === "canonical");
    assert.equal(attribute(canonical[0], "href"), ORIGIN + path);
    assert.ok(elements(page, (node) => node.tagName === "meta" && attribute(node, "name") === "description").length);
  }
});

test("every generated internal link, resource, and fragment resolves", async () => {
  const assets = new Set(inventory.map((file) => "/" + relative(DIST, file)));
  const failures = [];
  for (const [path, page] of pages) {
    for (const node of elements(page, (item) => item.tagName === "a" || attribute(item, "src") || (item.tagName === "link" && attribute(item, "rel") === "stylesheet"))) {
      const href = attribute(node, "href") ?? attribute(node, "src");
      if (!href || href.startsWith("data:")) continue;
      const target = new URL(href, ORIGIN + path);
      assert.ok(["https:", "http:", "mailto:"].includes(target.protocol), "Unsupported link protocol");
      if (target.origin !== ORIGIN) continue;
      if (!pages.has(target.pathname) && !assets.has(target.pathname)) {
        failures.push(path + " -> " + href);
        continue;
      }
      if (target.hash && pages.has(target.pathname)) {
        const id = decodeURIComponent(target.hash.slice(1));
        if (!elements(pages.get(target.pathname), (item) => attribute(item, "id") === id).length)
          failures.push(path + " -> missing fragment " + href);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("every guide exposes the public source repository", () => {
  for (const [path, page] of pages) {
    assert.ok(
      elements(page, (node) => node.tagName === "a" && attribute(node, "href") === SOURCE_REPOSITORY_URL).length,
      path + " does not link to the public source",
    );
  }
});

test("static pages allow only declared scripts and local runtime dependencies", () => {
  for (const [path, page] of pages) {
    const csp = elements(page, (node) => node.tagName === "meta" && attribute(node, "http-equiv")?.toLowerCase() === "content-security-policy");
    assert.equal(csp.length, 1, path);
    const policy = attribute(csp[0], "content");
    const scripts = policy.split(";").find((part) => part.trim().startsWith("script-src "));
    assert.ok(scripts?.includes("'self'"));
    assert.ok(scripts.includes("'wasm-unsafe-eval'"));
    assert.equal(scripts.includes("'unsafe-eval'"), false);
    assert.equal(scripts.includes("'unsafe-inline'"), false);
    assert.ok(policy.includes("connect-src 'self'"));
    for (const node of elements(page, (item) => item.tagName === "script")) {
      assert.ok(csp[0].sourceCodeLocation.endOffset <= node.sourceCodeLocation.startOffset, path + " executes a script before its policy");
      const src = attribute(node, "src");
      if (src) assert.equal(new URL(src, ORIGIN).origin, ORIGIN);
      else {
        const hash = createHash("sha256").update(content(node)).digest("base64");
        assert.ok(scripts.includes("'sha256-" + hash + "'"), path + " has an unapproved inline script");
      }
    }
  }
});

test("assets stay within Free limits and exclude private context and source maps", async () => {
  assert.ok(inventory.length <= FREE_ASSET_LIMITS.files);
  const privatePaths = new RegExp("/(?:" + ["Users", "c", "z"].join("|") + ")/");
  for (const file of inventory) {
    assert.ok((await lstat(file)).size <= FREE_ASSET_LIMITS.fileBytes, relative(DIST, file));
    assert.equal(file.endsWith(".map"), false);
    if (/\.(?:html|css|js|json|xml|txt)$/.test(file)) {
      const text = await readFile(file, "utf8");
      assert.equal(privatePaths.test(text), false, "Private path in " + relative(DIST, file));
      assert.equal(/\b(?:ghp|gho|ghu|ghs)_[a-zA-Z0-9]{20,}\b/.test(text), false);
      assert.equal(/\bhq[pa]_[a-f0-9]{64}\b/.test(text), false);
      assert.equal(/sourceMappingURL=/.test(text), false);
    }
  }
  assert.ok(inventory.some((file) => /\/pagefind\/wasm\.[a-z-]+\.pagefind$/.test(file)));
  assert.ok(pages.has("/404.html"));
});

test("the documented import download is exactly the synthetic source fixture", async () => {
  const fixture = await readFile(new URL("../../fixtures/import-metadata.json", import.meta.url), "utf8");
  const downloaded = await readFile(join(DIST, "examples/import-metadata.json"), "utf8");
  assert.deepEqual(JSON.parse(downloaded), JSON.parse(fixture));
});
