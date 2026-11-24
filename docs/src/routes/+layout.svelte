<script>
  import "../lib/styles/style.scss";
  import SiteHeader from "../lib/components/SiteHeader.svelte";
  import SiteFooter from "../lib/components/SiteFooter.svelte";

  let { children } = $props();
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
