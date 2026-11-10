import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyThemePreference,
  readStoredThemePreference,
  setThemePreference,
  themePreferenceKey,
} from "../src/lib/theme";

type Listener = () => void;

function installBrowserStubs(stored: string | null = null) {
  const storage = new Map<string, string>();
  if (stored !== null) storage.set(themePreferenceKey, stored);
  const listeners = new Set<Listener>();
  const media = {
    matches: false,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  };
  const meta = new Map<string, string>();
  const documentStub = {
    documentElement: { dataset: {} as Record<string, string> },
    querySelector: () => ({
      setAttribute: (name: string, value: string) => meta.set(name, value),
    }),
  };

  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("window", { matchMedia: () => media });
  vi.stubGlobal("document", documentStub);

  return {
    storage,
    listeners,
    media,
    meta,
    root: documentStub.documentElement.dataset,
  };
}

describe("theme preference", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.resetModules();
  });

  it("defaults to auto when nothing is stored", () => {
    installBrowserStubs();
    expect(readStoredThemePreference()).toBe("auto");
  });

  it("ignores unknown stored values", () => {
    installBrowserStubs("sepia");
    expect(readStoredThemePreference()).toBe("auto");
  });

  it("persists and reads back an explicit choice", () => {
    const { storage, root } = installBrowserStubs();
    setThemePreference("dark");
    expect(storage.get(themePreferenceKey)).toBe("dark");
    expect(root.theme).toBe("dark");
    expect(readStoredThemePreference()).toBe("dark");
  });

  it("applies light and dark explicitly regardless of the OS scheme", () => {
    const { media, root, meta } = installBrowserStubs();
    media.matches = true;
    applyThemePreference("light");
    expect(root.theme).toBe("light");
    expect(meta.get("content")).toBe("#f2f5f1");
    applyThemePreference("dark");
    expect(root.theme).toBe("dark");
    expect(meta.get("content")).toBe("#151f1a");
  });

  it("follows the OS scheme in auto mode and reacts to changes", () => {
    const { media, listeners, root } = installBrowserStubs();
    media.matches = true;
    applyThemePreference("auto");
    expect(root.theme).toBe("dark");

    media.matches = false;
    listeners.forEach((listener) => listener());
    expect(root.theme).toBe("light");
  });

  it("stops following the OS when switched to an explicit theme", () => {
    const { listeners, root, media } = installBrowserStubs();
    applyThemePreference("auto");
    expect(listeners.size).toBe(1);

    applyThemePreference("light");
    expect(listeners.size).toBe(0);

    media.matches = true;
    expect(root.theme).toBe("light");
  });
});
