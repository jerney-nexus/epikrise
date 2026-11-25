<script>
  import "../lib/styles/style.scss";
  import { page } from "$app/state";
  import SiteHeader from "../lib/components/SiteHeader.svelte";
  import SiteFooter from "../lib/components/SiteFooter.svelte";
  import { pageLanguage } from "../lib/page-language.js";

  let { children } = $props();

  // Keeps <html lang> in step with client-side navigation between language pages.
  $effect(() => {
    document.documentElement.lang = pageLanguage(page.url.pathname);
  });
</script>

<svelte:head>
  <meta name="theme-color" content="#f2f5f1" />
  <meta
    name="description"
    content="Epikrise, a local-only drafting aid for clinical material"
  />
</svelte:head>

<a class="skip-link" href="#main">Skip to content</a>
<SiteHeader />
<main id="main">
  {@render children()}
</main>
<SiteFooter />
