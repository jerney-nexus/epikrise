import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import MarkdownIt from "markdown-it";

const siteRoot = resolve(import.meta.dirname, "docs");
const markdown = new MarkdownIt({ typographer: true });

// Kramdown gives headings ids that the in-page links rely on (for example #download).
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

markdown.core.ruler.push("heading_ids", (state) => {
  state.tokens.forEach((token, index) => {
    if (token.type === "heading_open") {
      token.attrSet("id", slugify(state.tokens[index + 1].content));
    }
  });
});

function readSiteFile(relativePath) {
  return readFileSync(resolve(siteRoot, relativePath), "utf8");
}

function siteIncludes() {
  return {
    name: "epikrise-site-includes",
    transformIndexHtml(html) {
      return html
        .replace(/<!--partial:([\w-]+)-->/g, (_, name) =>
          readSiteFile(`_partials/${name}.html`).trimEnd(),
        )
        .replace(/<!--markdown:([\w.-]+\.md)-->/g, (_, file) =>
          markdown.render(readSiteFile(file)),
        );
    },
  };
}

export default defineConfig({
  root: siteRoot,
  plugins: [siteIncludes()],
  build: {
    outDir: resolve(import.meta.dirname, "build/site"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(siteRoot, "index.html"),
        "privacy-policy-en": resolve(siteRoot, "privacy-policy/en/index.html"),
        "privacy-policy-de": resolve(siteRoot, "privacy-policy/de/index.html"),
        "privacy-policy-fr": resolve(siteRoot, "privacy-policy/fr/index.html"),
        "privacy-policy-it": resolve(siteRoot, "privacy-policy/it/index.html"),
        "privacy-policy-es": resolve(siteRoot, "privacy-policy/es/index.html"),
      },
    },
  },
});
