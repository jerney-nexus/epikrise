<script>
  import { resolve } from "$app/paths";

  let { data } = $props();

  // Decorative 24px line icons, keyed by section id from index.md.
  const icons = {
    download: "M12 3v12m-5-5 5 5 5-5M5 21h14",
    privacy: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z",
    project:
      "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  };
</script>

<svelte:head>
  <title>Epikrise</title>
  <link rel="canonical" href="https://epikrise.jerney.nexus/" />
</svelte:head>

<div class="home">
  <section class="hero" aria-label="Introduction">
    <div class="hero__glow" aria-hidden="true"></div>
    <p class="hero__eyebrow">
      <span class="hero__dot" aria-hidden="true"></span>
      Local-only · Desktop · Drafting aid
    </p>
    <div class="hero__copy">
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- HTML is rendered from repository Markdown at build time. -->
      {@html data.intro}
    </div>
    <div class="hero__actions">
      <a
        class="button button--primary"
        href="https://github.com/jerney-nexus/epikrise/releases"
      >
        Download
      </a>
      <a class="button button--ghost" href={resolve("/privacy-policy/en/")}>
        Privacy policy
      </a>
    </div>
  </section>

  <div class="cards">
    {#each data.sections as section (section.id)}
      <section class="card" id={section.id} aria-labelledby="{section.id}-title">
        <span class="card__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d={icons[section.id]} /></svg>
        </span>
        <h2 id="{section.id}-title">{section.title}</h2>
        <div class="card__body">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- HTML is rendered from repository Markdown at build time. -->
          {@html section.html}
        </div>
      </section>
    {/each}
  </div>
</div>
