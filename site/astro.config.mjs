import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import sourceLinks from "./plugins/source-links.mjs";
import sealPages from "./plugins/seal-pages.mjs";

const SOURCE_REPOSITORY_URL = "https://github.com/j-256/maintainer-hq";

export default defineConfig({
  site: "https://docs.hq.lasers.app",
  output: "static",
  trailingSlash: "always",
  devToolbar: { enabled: false },
  markdown: {
    processor: unified({ smartypants: false, remarkPlugins: [sourceLinks] }),
  },
  security: {
    csp: {
      directives: [
        "default-src 'none'",
        "base-uri 'self'",
        "connect-src 'self'",
        "font-src 'self'",
        "img-src 'self' data:",
        "form-action 'none'",
        "object-src 'none'",
        "worker-src 'self'",
      ],
      scriptDirective: { resources: ["'self'", "'wasm-unsafe-eval'"] },
      styleDirective: { resources: ["'self'", "'unsafe-inline'"] },
    },
  },
  integrations: [
    starlight({
      title: "Maintainer HQ",
      description: "A practical guide to your projects, fleet evidence, and reviewed operations.",
      social: [
        { icon: "github", label: "Source on GitHub", href: SOURCE_REPOSITORY_URL },
      ],
      editLink: { baseUrl: SOURCE_REPOSITORY_URL + "/edit/main/docs/" },
      customCss: ["./src/styles/custom.css"],
      components: { Search: "./src/components/Search.astro" },
      favicon: "/favicon.svg",
      lastUpdated: false,
      pagefind: true,
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        { label: "Getting started", items: ["index", "getting-started", "concepts", "integrations"] },
        { label: "Using HQ", items: ["overview", "projects", "repositories", "fleet-enrollment", "repository-work", "releases", "dependencies", "github", "activity", "hooks", "monitoring", "secrets", "project-transfers", "preferences", "access"] },
        { label: "Automation and reference", collapsed: true, items: ["commands", "automation", "publishing", "github-evidence", "push"] },
        { label: "Self-hosting and recovery", collapsed: true, items: ["development", "hosting", "release", "import", "troubleshooting", "diagnostics", "typography", "documentation"] },
      ],
    }),
    sealPages(),
  ],
});
