<script>
  import { resolve } from "$app/paths";
  import ThemePreference from "./ThemePreference.svelte";
</script>

<header class="site-header" lang="en">
  <div class="site-header__inner">
    <a class="site-brand" href={resolve("/")}>
      <svg
        class="site-brand__mark"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 1024 1024"
        aria-hidden="true"
      >
        <path
          fill="#176c5c"
          d="M288 64h448a224 224 0 0 1 224 224v448a224 224 0 0 1-224 224H144a80 80 0 0 1-80-80V288A224 224 0 0 1 288 64Z"
        />
        <text
          x="512"
          y="588"
          fill="#f8fbf7"
          font-family="Georgia, 'Times New Roman', serif"
          font-size="640"
          text-anchor="middle"
          dominant-baseline="middle"
        >
          E
        </text>
      </svg>
      <span class="site-brand__name">Epikrise</span>
    </a>
    <nav class="site-nav" aria-label="Main">
      <a href={resolve("/#download")}>Download</a>
      <a href={resolve("/privacy-policy/en/")}>Privacy</a>
      <a href="https://github.com/jerney-nexus/epikrise">GitHub</a>
    </nav>
    <ThemePreference />
  </div>
</header>
