const privacyPolicyPath = /^\/privacy-policy\/(en|de|fr|it|es)\/$/;

// The language comes from the URL so each prerendered page carries the right lang attribute.
export function handle({ event, resolve }) {
  const match = privacyPolicyPath.exec(event.url.pathname);
  const lang = match ? match[1] : "en";

  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace("%lang%", lang),
  });
}
