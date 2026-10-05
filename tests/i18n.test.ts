import { readFile } from "node:fs/promises";
import { FluentBundle, FluentResource } from "@fluent/bundle";
import { describe, expect, it } from "vitest";
import {
  defaultLocale,
  initializeLocale,
  localePreferenceKey,
  pseudoLocale,
  resolveLocale,
  setLocale,
  supportedLocales,
  translate,
} from "../src/lib/i18n";

const catalogDirectory = new URL("../locales/", import.meta.url);
const messageId = (source: string) =>
  `ui-${source
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;

async function readCatalog(locale: string) {
  const source = await readFile(new URL(`${locale}/app.ftl`, catalogDirectory), "utf8");
  const bundle = new FluentBundle(locale);
  bundle.addResource(new FluentResource(source));
  const keys = [...source.matchAll(/^([a-z][a-z0-9-]*)\s*=/gm)].map(
    (match) => match[1],
  );
  return { locale, bundle, keys };
}

describe("Fluent localization", () => {
  it("provides the same message keys in every shipped locale", async () => {
    const catalogs = await Promise.all(supportedLocales.map(readCatalog));
    const englishKeys = [
      ...catalogs.find((catalog) => catalog.locale === "en")!.keys,
    ].sort();

    for (const { keys } of catalogs) {
      expect([...keys].sort()).toEqual(englishKeys);
    }
  });

  it("defines every translation key referenced by the Svelte workspace", async () => {
    const source = await readFile(
      new URL("../src/routes/+page.svelte", import.meta.url),
      "utf8",
    );
    const usedSources = [...source.matchAll(/\bt\("([^"]+)"/g)].map(
      (match) => match[1],
    );
    const catalogs = await Promise.all(supportedLocales.map(readCatalog));

    for (const { locale, bundle } of catalogs) {
      for (const message of usedSources) {
        expect(
          bundle.getMessage(messageId(message)),
          `${locale}: ${message}`,
        ).toBeDefined();
      }
    }
  });

  it("uses the stored locale before the detected OS locale", () => {
    expect(initializeLocale("en", "de-CH")).toBe("en");
    expect(initializeLocale(null, "de-CH")).toBe("de-CH");
    expect(initializeLocale(null, "de-AT")).toBe("de-CH");
    expect(initializeLocale(null, "fr-CH")).toBe(defaultLocale);
  });

  it("persists supported selections but keeps pseudo-localization temporary", () => {
    const originalStorage = globalThis.localStorage;
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });

    try {
      setLocale("en");
      expect(values.get(localePreferenceKey)).toBe("en");
      setLocale(pseudoLocale);
      expect(values.get(localePreferenceKey)).toBe("en");
    } finally {
      if (originalStorage === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          value: originalStorage,
        });
      }
    }
  });

  it("pseudo-localizes formatted messages to expose untranslated UI", () => {
    expect(resolveLocale("en-GB")).toBe("en");
    expect(translate(pseudoLocale, "Provider")).toMatch(/^［.*］$/);
  });

  it("pseudo-localizes every UI message and finds no untranslated markup text", async () => {
    const source = await readFile(
      new URL("../src/routes/+page.svelte", import.meta.url),
      "utf8",
    );
    const markup = source.split("</svelte:head>")[1]?.split("<style>")[0] ?? "";
    const staticText = [
      ...new Set(
        [...markup.matchAll(/>([^<>{}]+)</g)]
          .map((match) => match[1].trim().replace(/\s+/g, " "))
          .filter((value) => /[A-Za-z]/.test(value)),
      ),
    ].sort();
    expect(staticText).toEqual(
      [
        "E",
        "Epikrise",
        "Ollama",
        "OpenAI",
        "OpenAI compatible",
        "OpenRouter",
        "Anthropic",
        "Gemini",
        "xAI",
        "Groq",
      ].sort(),
    );

    const usedSources = [...source.matchAll(/\bt\("([^"]+)"/g)].map(
      (match) => match[1],
    );
    const args = {
      count: 2,
      error: "sample error",
      label: "sample label",
      line: 1,
      name: "sample.txt",
      round: 2,
      status: 418,
    };
    for (const message of usedSources) {
      expect(translate(pseudoLocale, message, args), message).toMatch(/^［.+］$/);
    }
  });
});
