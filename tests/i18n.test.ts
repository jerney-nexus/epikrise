import { readFile } from "node:fs/promises";
import { FluentBundle, FluentResource } from "@fluent/bundle";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeLocale,
  compareLocales,
  createBundles,
  defaultLocale,
  getActiveLocale,
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
    const usedSources = [
      ...source.matchAll(/\bt\("([^"]+)"/g),
      ...source.matchAll(/\bt\([^"()]+\? "([^"]+)" : "([^"]+)"\)/g),
      ...source.matchAll(/generationMessage = "([^"]+)"/g),
    ].flatMap((match) => match.slice(1));
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
    expect(initializeLocale(null, "it-CH")).toBe("it");
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

  it("localizes native menu labels and fallback status in every locale", () => {
    expect(translate("en", "Settings")).toBe("Settings");
    expect(translate("de-CH", "Settings")).toBe("Einstellungen");
    expect(translate(pseudoLocale, "Settings")).toMatch(/^［.*］$/);
    expect(translate(pseudoLocale, "Undo")).toMatch(/^［.*］$/);
    for (const label of [
      "Paste and Match Style",
      "Delete",
      "Show All",
      "Bring All to Front",
      "Actual Size",
      "Zoom In",
      "Zoom Out",
      "Start Speaking",
      "Stop Speaking",
      "Start Dictation…",
      "Emoji & Symbols",
    ]) {
      expect(translate("en", label), label).toBe(label);
      expect(translate("de-CH", label), label).not.toBe(label);
      expect(translate(pseudoLocale, label), label).toMatch(/^［.+］$/);
    }
    expect(
      translate(
        "en",
        "Native Settings and Help menus are unavailable. Use the in-app buttons.",
      ),
    ).toContain("Use the in-app buttons");
    expect(
      translate(
        "de-CH",
        "Native Settings and Help menus are unavailable. Use the in-app buttons.",
      ),
    ).toContain("Schaltflächen in der App");
    const removeBidiIsolates = (value: string) =>
      value.replaceAll(/[\u2068\u2069]/g, "");
    expect(
      removeBidiIsolates(translate("en", "About { $app }", { app: "Epikrise" })),
    ).toBe("About Epikrise");
    expect(
      removeBidiIsolates(translate("de-CH", "Hide { $app }", { app: "Epikrise" })),
    ).toBe("Epikrise ausblenden");
    expect(
      removeBidiIsolates(translate("de-CH", "Quit { $app }", { app: "Epikrise" })),
    ).toBe("Epikrise beenden");
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
      category: "language_data_file",
      count: 2,
      error: "sample error",
      exitCode: 1,
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

describe("locale state and fallbacks", () => {
  it("orders the default locale first, then the rest alphabetically", () => {
    expect(compareLocales(defaultLocale, "en")).toBe(-1);
    expect(compareLocales("en", defaultLocale)).toBe(1);
    expect(compareLocales("en", "fr")).toBeLessThan(0);
    expect(compareLocales("fr", "en")).toBeGreaterThan(0);
  });

  it("builds bundles per locale folder and skips files outside one", () => {
    const bundles = createBundles({
      "../../locales/en/app.ftl": "settings = Settings",
      "app.ftl": "settings = Ignored",
    });
    expect([...bundles.keys()]).toEqual(["en"]);
    expect(bundles.get("en")?.getMessage("settings")?.value).toBeDefined();
  });

  const withLocalStorage = (storage: Partial<Storage>, run: () => void) => {
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    try {
      run();
    } finally {
      if (originalStorage) {
        Object.defineProperty(globalThis, "localStorage", originalStorage);
      } else {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      }
    }
  };

  afterEach(() => {
    activeLocale.set(defaultLocale);
  });

  it("lists the default locale first and the rest alphabetically", () => {
    expect(supportedLocales[0]).toBe(defaultLocale);
    expect(supportedLocales.slice(1)).toEqual(
      [...supportedLocales.slice(1)].sort((left, right) => left.localeCompare(right)),
    );
  });

  it("starts on the default locale and tracks switches in the store", () => {
    expect(getActiveLocale()).toBe(defaultLocale);
    setLocale("en");
    expect(getActiveLocale()).toBe("en");
    let observed: string | undefined;
    const unsubscribe = activeLocale.subscribe((value) => (observed = value));
    setLocale(defaultLocale);
    unsubscribe();
    expect(observed).toBe(defaultLocale);
  });

  it("ignores unsupported locale selections without touching storage or state", () => {
    const writes: string[] = [];
    withLocalStorage({ setItem: (key: string) => void writes.push(key) }, () => {
      setLocale("zz");
    });
    expect(writes).toEqual([]);
    expect(getActiveLocale()).toBe(defaultLocale);
  });

  it("still switches locale when storage is unavailable", () => {
    withLocalStorage(
      {
        setItem: () => {
          throw new Error("storage disabled");
        },
      },
      () => {
        setLocale("en");
      },
    );
    expect(getActiveLocale()).toBe("en");
  });

  it("switches locale when storage is missing entirely", () => {
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    delete (globalThis as { localStorage?: Storage }).localStorage;
    try {
      setLocale("en");
    } finally {
      if (originalStorage) {
        Object.defineProperty(globalThis, "localStorage", originalStorage);
      }
    }
    expect(getActiveLocale()).toBe("en");
  });

  it("resolves null, exact, underscore, and language-only OS locales", () => {
    expect(resolveLocale(null)).toBe(defaultLocale);
    expect(resolveLocale("EN_us")).toBe("en");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale("zz")).toBe(defaultLocale);
  });

  it("maps regional OS tags for the added catalogs to their language", () => {
    expect(resolveLocale("fr-CH")).toBe("fr");
    expect(resolveLocale("it-CH")).toBe("it");
    expect(resolveLocale("es-ES")).toBe("es");
  });

  it("round-trips a stored French, Italian, or Spanish preference", () => {
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
      for (const locale of ["fr", "it", "es"]) {
        setLocale(locale);
        expect(values.get(localePreferenceKey)).toBe(locale);
        expect(initializeLocale(values.get(localePreferenceKey) ?? null, "de-CH")).toBe(
          locale,
        );
      }
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

  it("returns the source text for locales without a bundle", () => {
    expect(translate("zz", "Settings")).toBe("Settings");
  });

  it("returns the source text when a locale lacks the message", () => {
    const unknownSource = "A label that is not in any catalog";
    expect(translate("en", unknownSource)).toBe(unknownSource);
    expect(translate(pseudoLocale, unknownSource)).toBe(unknownSource);
  });
});
