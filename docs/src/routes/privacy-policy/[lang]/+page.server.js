import { error } from "@sveltejs/kit";
import { privacyPolicies } from "../../../lib/server/content.js";

export function entries() {
  return Object.keys(privacyPolicies).map((lang) => ({ lang }));
}

export function load({ params }) {
  const policy = privacyPolicies[params.lang];
  if (!policy) error(404, "Not found");

  return { lang: params.lang, title: policy.title, html: policy.html };
}
