import { resolve } from "node:path";
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const siteOutput = resolve(import.meta.dirname, "build/site");

// Static GitHub Pages site under docs/. The Tauri app config stays in vite.config.js.
export default defineConfig({
  root: resolve(import.meta.dirname, "docs"),
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({
        pages: siteOutput,
        assets: siteOutput,
      }),
    }),
  ],
});
