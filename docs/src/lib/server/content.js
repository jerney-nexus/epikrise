import { renderMarkdown, slugify } from "./markdown.js";
import indexSource from "../content/index.md?raw";
import enSource from "../content/privacy-policy.en.md?raw";
import deSource from "../content/privacy-policy.de.md?raw";
import frSource from "../content/privacy-policy.fr.md?raw";
import itSource from "../content/privacy-policy.it.md?raw";
import esSource from "../content/privacy-policy.es.md?raw";

// The home page is one Markdown file; each "## " section becomes its own card.
function splitIndex(source) {
  const [intro, ...sections] = source.split(/^## /m);
  return {
    intro: renderMarkdown(intro),
    sections: sections.map((section) => {
      const [title, ...body] = section.split("\n");
      return {
        id: slugify(title),
        title: title.trim(),
        html: renderMarkdown(body.join("\n")),
      };
    }),
  };
}

export const indexPage = splitIndex(indexSource);

export const privacyPolicies = {
  en: {
    title: "Privacy Policy for Epikrise · Epikrise",
    html: renderMarkdown(enSource),
  },
  de: {
    title: "Datenschutzrichtlinie für Epikrise · Epikrise",
    html: renderMarkdown(deSource),
  },
  fr: {
    title: "Politique de confidentialité d’Epikrise · Epikrise",
    html: renderMarkdown(frSource),
  },
  it: {
    title: "Informativa sulla privacy di Epikrise · Epikrise",
    html: renderMarkdown(itSource),
  },
  es: {
    title: "Política de privacidad de Epikrise · Epikrise",
    html: renderMarkdown(esSource),
  },
};
