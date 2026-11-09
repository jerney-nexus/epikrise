export type ThemePreference = "light" | "dark" | "auto";

export const themePreferenceKey = "epikrise.ui-theme";

const darkSchemeQuery = "(prefers-color-scheme: dark)";
const themeColors = { light: "#f2f5f1", dark: "#151f1a" } as const;
let stopFollowingSystem: (() => void) | null = null;

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "auto";
}

export function readStoredThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(themePreferenceKey);
    if (isThemePreference(stored)) return stored;
  } catch {
    // Storage can be unavailable in restricted webviews; the default applies.
  }
  return "auto";
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(themePreferenceKey, preference);
  } catch {
    // Storage can be unavailable in restricted webviews; the live switch still works.
  }
  applyThemePreference(preference);
}

export function applyThemePreference(preference: ThemePreference): void {
  stopFollowingSystem?.();
  stopFollowingSystem = null;
  if (preference !== "auto") {
    setResolvedTheme(preference);
    return;
  }
  const query = window.matchMedia(darkSchemeQuery);
  const follow = () => setResolvedTheme(query.matches ? "dark" : "light");
  query.addEventListener("change", follow);
  stopFollowingSystem = () => query.removeEventListener("change", follow);
  follow();
}

function setResolvedTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", themeColors[theme]);
}
