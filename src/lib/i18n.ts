import { FluentBundle, FluentResource } from "@fluent/bundle";
import { get, writable } from "svelte/store";

export const defaultLocale = "de-CH";
export const pseudoLocale = "qps-ploc";
export const localePreferenceKey = "epikrise.ui-locale";

const catalogFiles = import.meta.glob<string>("../../locales/*/app.ftl", {
  eager: true,
  query: "?raw",
  import: "default",
});

const bundles = new Map<string, FluentBundle>();
for (const [path, source] of Object.entries(catalogFiles)) {
  const locale = path.split("/").at(-2);
  if (!locale) continue;
  const bundle = new FluentBundle(locale);
  bundle.addResource(new FluentResource(source));
  bundles.set(locale, bundle);
}

export const supportedLocales = [...bundles.keys()].sort((left, right) =>
  left === defaultLocale ? -1 : right === defaultLocale ? 1 : left.localeCompare(right),
);
export const activeLocale = writable(defaultLocale);

function messageId(source: string): string {
  const slug = source
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `ui-${slug}`;
}

function pseudoLocalize(value: string): string {
  const expanded = value.replace(
    /[aeiou]/gi,
    (letter) => `${letter}${letter.toLowerCase()}`,
  );
  return `［${expanded}］`;
}

export function translate(
  locale: string,
  source: string,
  args: Record<string, string | number> = {},
): string {
  const bundle = bundles.get(locale === pseudoLocale ? "en" : locale);
  if (!bundle) return source;
  const message = bundle.getMessage(messageId(source));
  if (!message?.value) return source;
  const value = bundle.formatPattern(message.value, args);
  return locale === pseudoLocale ? pseudoLocalize(value) : value;
}

export function initializeLocale(
  storedLocale: string | null,
  osLocale: string | null,
): string {
  const stored = supportedLocales.find((locale) => locale === storedLocale);
  const detected = resolveLocale(osLocale);
  const locale = stored ?? detected;
  activeLocale.set(locale);
  return locale;
}

export function resolveLocale(candidate: string | null): string {
  if (!candidate) return defaultLocale;
  const normalized = candidate.replaceAll("_", "-").toLowerCase();
  const exact = supportedLocales.find((locale) => locale.toLowerCase() === normalized);
  if (exact) return exact;
  const language = normalized.split("-")[0];
  return (
    supportedLocales.find(
      (locale) => locale.toLowerCase().split("-")[0] === language,
    ) ?? defaultLocale
  );
}

export function setLocale(locale: string): void {
  if (locale === pseudoLocale) {
    activeLocale.set(locale);
    return;
  }
  if (!supportedLocales.includes(locale)) return;
  try {
    localStorage.setItem(localePreferenceKey, locale);
  } catch {
    // Storage can be unavailable in restricted webviews; the live switch still works.
  }
  activeLocale.set(locale);
}

export function getActiveLocale(): string {
  return get(activeLocale);
}
