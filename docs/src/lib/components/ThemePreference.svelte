<script>
  import { onMount } from "svelte";

  // Mirrors the inline script in src/app.html, which sets the theme before first paint.
  const themePreferenceKey = "epikrise.ui-theme";
  const themeColors = { light: "#f2f5f1", dark: "#151f1a" };

  let preference = $state("auto");

  function resolveTheme(value, systemDark) {
    return value === "dark" || (value !== "light" && systemDark) ? "dark" : "light";
  }

  function applyTheme(value) {
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = resolveTheme(value, systemDark);
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", themeColors[theme]);
  }

  function readStoredPreference() {
    try {
      const stored = localStorage.getItem(themePreferenceKey);
      return stored === "light" || stored === "dark" ? stored : "auto";
    } catch {
      return "auto";
    }
  }

  function choose(event) {
    preference = event.currentTarget.value;
    try {
      localStorage.setItem(themePreferenceKey, preference);
    } catch {
      // Storage can be unavailable; the choice still applies for this page view.
    }
    applyTheme(preference);
  }

  onMount(() => {
    preference = readStoredPreference();
    applyTheme(preference);
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (preference === "auto") applyTheme("auto");
    };
    systemDark.addEventListener("change", onSystemChange);
    return () => systemDark.removeEventListener("change", onSystemChange);
  });
</script>

<label class="theme-select">
  <span>Theme</span>
  <select value={preference} onchange={choose}>
    <option value="auto">Auto</option>
    <option value="light">Light</option>
    <option value="dark">Dark</option>
  </select>
</label>
