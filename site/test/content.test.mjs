import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sourceLinks from "../plugins/source-links.mjs";
import accessibleBlocks from "../plugins/accessible-blocks.mjs";

test("source links retain fragments and only publish approved source content", () => {
  const link = (url) => ({ type: "link", url, children: [] });
  const tree = { children: [
    { type: "heading", depth: 1 },
    link("projects.md#recovery"), link("index.md"),
    link("../fixtures/import-metadata.json"), link("https://example.org/reference"),
  ] };
  const file = { path: fileURLToPath(new URL("../../docs/index.md", import.meta.url)) };
  sourceLinks()(tree, file);
  assert.deepEqual(tree.children.map((node) => node.url), [
    "/projects/#recovery", "/", "/examples/import-metadata.json", "https://example.org/reference",
  ]);
  for (const url of ["../package.json", "../README.md", "nested/unpublished.md", "../../../private.txt"])
    assert.throws(() => sourceLinks()({ children: [link(url)] }, file), /Unpublished relative/);
});

test("scrollable content receives keyboard focus and useful names without changing table semantics", () => {
  const html = accessibleBlocks('<h1 id="_top">Guide</h1><h2>Command reference</h2><pre>example</pre><table><tr><th>Heading</th></tr></table>');
  assert.match(html, /<h1 id="_top" tabindex="-1">/);
  assert.match(html, /<pre tabindex="0" aria-label="Command reference code example 1" role="region">/);
  assert.match(html, /<table tabindex="0" aria-label="Command reference table 2">/);
  assert.equal(accessibleBlocks(html), html);
});
