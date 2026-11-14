#!/usr/bin/env node
// Generates the Microsoft Store poster and superhero images for each locale,
// plus the language-neutral packaging icon. Requires ImageMagick (`convert`).
// Usage: node scripts/generate-store-assets.mjs [locale ...]
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(repoRoot, "store-assets");

const background = "#176c5c";
const foreground = "#f8fbf7";
const fontName = "Liberation-Serif";

const locales = {
  en: {
    superhero: "A local drafting aid for health professionals",
    poster: ["Structured clinical drafts,", "reviewed by you"],
  },
  de: {
    superhero: "Lokale Entwurfshilfe für Gesundheitsfachpersonen",
    poster: ["Strukturierte Entwürfe,", "von Ihnen geprüft"],
  },
  fr: {
    superhero: "Aide locale à la rédaction pour professionnels de santé",
    poster: ["Brouillons cliniques structurés,", "relus par vous"],
  },
  it: {
    superhero: "Un supporto locale alla stesura per operatori sanitari",
    poster: ["Bozze cliniche strutturate,", "riviste da te"],
  },
  es: {
    superhero: "Ayuda local de redacción para profesionales sanitarios",
    poster: ["Borradores clínicos estructurados,", "revisados por usted"],
  },
};

// The internal SVG renderer of ImageMagick 6 draws black fringes around glyphs,
// so text is drawn with ImageMagick's FreeType-based `-draw text` instead.
const escapeDraw = (text) => text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

const scene = (width, height, ops) => ({ width, height, ops });

const text = ({ x, y, size, anchor = "start", content }) => ({
  x,
  y,
  size,
  anchor,
  content,
});

const mark = ({ x, y, size }) => text({ x, y, size, anchor: "middle", content: "E" });

const posterScene = ({ poster }) =>
  scene(1440, 2160, [
    mark({ x: 713, y: 942, size: 713 }),
    text({ x: 720, y: 1356, size: 167, anchor: "middle", content: "Epikrise" }),
    text({ x: 720, y: 1474, size: 60, anchor: "middle", content: poster[0] }),
    text({ x: 720, y: 1555, size: 60, anchor: "middle", content: poster[1] }),
  ]);

const superheroScene = ({ superhero }) => ({
  ...scene(3840, 2160, [
    text({ x: 303, y: 983, size: 300, content: "Epikrise" }),
    text({ x: 303, y: 1175, size: 96, content: superhero }),
  ]),
  photo: join(assetRoot, "source", "superhero-background-1536x1024.png"),
});

const packagingScene = () =>
  scene(2160, 2160, [mark({ x: 1058, y: 1594, size: 1410 })]);

async function textWidth({ size, content }) {
  const { stdout } = await execFileAsync("convert", [
    "-font",
    fontName,
    "-pointsize",
    String(size),
    `label:${content}`,
    "-format",
    "%w",
    "info:",
  ]);
  return Number(stdout);
}

async function render({ width, height, ops, photo }, outputPath) {
  const args = photo
    ? [
        photo,
        "-resize",
        `${width}x${height}^`,
        "-gravity",
        "center",
        "-extent",
        `${width}x${height}`,
      ]
    : ["-size", `${width}x${height}`, `xc:${background}`];
  args.push("+gravity", "-font", fontName, "-fill", foreground);
  for (const op of ops) {
    const x = op.anchor === "middle" ? op.x - (await textWidth(op)) / 2 : op.x;
    args.push(
      "-pointsize",
      String(op.size),
      "-draw",
      `text ${x},${op.y} "${escapeDraw(op.content)}"`,
    );
  }
  args.push(`PNG24:${outputPath}`);
  await execFileAsync("convert", args);
}

async function main() {
  const requested = process.argv.slice(2);
  const unknown = requested.filter((locale) => !(locale in locales));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown locale(s): ${unknown.join(", ")}. Expected one of: ${Object.keys(locales).join(", ")}`,
    );
  }
  const selected = requested.length > 0 ? requested : Object.keys(locales);

  for (const locale of selected) {
    const strings = locales[locale];
    const localeDir = join(assetRoot, locale);
    await mkdir(localeDir, { recursive: true });
    await render(posterScene(strings), join(localeDir, "poster-9x16-1440x2160.png"));
    await render(
      superheroScene(strings),
      join(localeDir, "superhero-16x9-3840x2160.png"),
    );
    console.log(`Generated store assets for ${locale}`);
  }

  if (requested.length === 0) {
    await render(packagingScene(), join(assetRoot, "packaging-1x1-2160x2160.png"));
    console.log("Generated packaging icon");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
