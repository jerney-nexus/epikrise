(function () {
  var key = "epikrise.ui-theme";
  var select = document.getElementById("theme-preference");
  if (!select) return;

  var systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  var themeColor = document.querySelector('meta[name="theme-color"]');
  var colors = { light: "#f2f5f1", dark: "#151f1a" };

  function resolve(preference) {
    return preference === "dark" || (preference !== "light" && systemDark.matches)
      ? "dark"
      : "light";
  }

  function apply(preference) {
    var theme = resolve(preference);
    document.documentElement.dataset.theme = theme;
    if (themeColor) themeColor.setAttribute("content", colors[theme]);
  }

  var stored;
  try {
    stored = localStorage.getItem(key);
  } catch {
    stored = null;
  }
  select.value = stored === "light" || stored === "dark" ? stored : "auto";

  select.addEventListener("change", function () {
    try {
      localStorage.setItem(key, select.value);
    } catch {
      // Storage can be unavailable; the choice still applies for this page view.
    }
    apply(select.value);
  });

  systemDark.addEventListener("change", function () {
    if (select.value === "auto") apply("auto");
  });
})();
