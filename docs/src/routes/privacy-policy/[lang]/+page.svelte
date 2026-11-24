<script>
  let { data } = $props();
</script>

<svelte:head>
  <title>{data.title}</title>
  <link
    rel="canonical"
    href="https://epikrise.jerney.nexus/privacy-policy/{data.lang}/"
  />
</svelte:head>

<article class="page page--legal">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- HTML is rendered from repository Markdown at build time. -->
  {@html data.html}
</article>
