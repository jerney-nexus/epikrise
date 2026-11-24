<script>
  let { data } = $props();
</script>

<svelte:head>
  <title>Epikrise</title>
  <link rel="canonical" href="https://epikrise.jerney.nexus/" />
</svelte:head>

<article class="page">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- HTML is rendered from repository Markdown at build time. -->
  {@html data.html}
</article>
