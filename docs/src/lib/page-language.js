const privacyPolicyPath = /^\/privacy-policy\/(en|de|fr|it|es)\/$/;

export function pageLanguage(pathname) {
  const match = privacyPolicyPath.exec(pathname);
  return match ? match[1] : "en";
}
