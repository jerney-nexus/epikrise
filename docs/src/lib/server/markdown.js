import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ typographer: true });

// Kramdown gives headings ids that the in-page links rely on (for example #download).
export function slugify(text) {
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

export function renderMarkdown(source) {
  return markdown.render(source);
}
