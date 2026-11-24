<script>
  import ThemePreference from "./ThemePreference.svelte";
</script>

<header class="site-header">
  <div class="site-header__inner">
    <a class="site-brand" href="/">
      <span class="site-brand__mark" aria-hidden="true">E</span>
      <span class="site-brand__name">Epikrise</span>
    </a>
    <nav class="site-nav" aria-label="Main">
      <a href="/#download">Download</a>
      <a href="/privacy-policy/en/">Privacy</a>
      <a href="https://github.com/jerney-nexus/epikrise">GitHub</a>
    </nav>
    <ThemePreference />
  </div>
</header>
