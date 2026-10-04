import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});

export function renderOutputHtml(value: string, lintedLines: number[] = []): string {
  const environment = {};
  const tokens = markdown.parse(value, environment);

  for (const token of tokens) {
    if (!token.block || token.nesting !== 1 || !token.map) continue;

    const startLine = token.map[0] + 1;
    const endLine = token.map[1];
    token.attrSet("data-source-start-line", String(startLine));
    token.attrSet("data-source-end-line", String(endLine));

    if (lintedLines.some((line) => line >= startLine && line <= endLine)) {
      token.attrJoin("class", "linted-line");
    }
  }

  const html = markdown.renderer.render(tokens, markdown.options, environment);
  // Images are forbidden: clipboard HTML leaves the webview CSP, and a remote
  // image URL could leak case text to an attacker-controlled host on paste.
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["img"] });
}
