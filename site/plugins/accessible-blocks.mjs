import { parse, serialize } from "parse5";

function text(node) {
  return node.nodeName === "#text" ? node.value : (node.childNodes ?? []).map(text).join("");
}
function attribute(node, name, value) {
  const existing = node.attrs.find((item) => item.name === name);
  if (existing) existing.value = value;
  else node.attrs.push({ name, value });
}

export default function accessibleBlocks(html) {
  const tree = parse(html);
  let heading = "Documentation";
  let sequence = 0;
  function visit(node) {
    if (/^h[1-6]$/.test(node.tagName ?? "")) heading = text(node);
    if (node.tagName === "h1") attribute(node, "tabindex", "-1");
    if (node.tagName === "pre" || node.tagName === "table") {
      attribute(node, "tabindex", "0");
      attribute(node, "aria-label", heading + (node.tagName === "pre" ? " code example " : " table ") + ++sequence);
      if (node.tagName === "pre") attribute(node, "role", "region");
    }
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(tree);
  return serialize(tree);
}
