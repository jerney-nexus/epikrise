import { pageLanguage } from "./lib/page-language.js";

// The language comes from the URL so each prerendered page carries the right lang attribute.
export function handle({ event, resolve }) {
  const lang = pageLanguage(event.url.pathname);

  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace("%lang%", lang),
  });
}
