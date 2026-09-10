import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_ROOT = fileURLToPath(new URL("../../docs/", import.meta.url));
const IMPORT_EXAMPLE = fileURLToPath(new URL("../../fixtures/import-metadata.json", import.meta.url));

export default function sourceLinks() {
  return (tree, file) => {
    if (tree.children[0]?.type === "heading" && tree.children[0].depth === 1)
      tree.children.shift();
    function visit(node) {
      if (["link", "definition", "image"].includes(node.type) && typeof node.url === "string") {
        const url = node.url;
        if (!/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) {
          const [path, fragment] = url.split("#");
          const target = resolve(dirname(file.path), path);
          const local = relative(DOCS_ROOT, target);
          if (target === IMPORT_EXAMPLE) node.url = "/examples/import-metadata.json";
          else if (/^[a-z0-9-]+\.md$/.test(local))
            node.url = (local === "index.md" ? "/" : "/" + local.slice(0, -3) + "/") + (fragment ? "#" + fragment : "");
          else throw new Error("Unpublished relative documentation link: " + url);
        }
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(tree);
  };
}
