#!/usr/bin/env node
// Generates the Microsoft Store poster and superhero images for each locale,
// plus the language-neutral packaging icon. Requires ImageMagick (`convert`).
// Usage: node scripts/generate-store-assets.mjs [locale ...]
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(repoRoot, "store-assets");

const background = "#176c5c";
const foreground = "#f8fbf7";
const fontFamily = "Liberation Serif";

const locales = {
  en: {
    superhero: "A local drafting aid for clinicians",
    poster: ["Structured clinical drafts,", "reviewed by you"],
  },
  de: {
    superhero: "Lokale Entwurfshilfe für medizinisches Personal",
    poster: ["Strukturierte Entwürfe,", "von Ihnen geprüft"],
  },
  fr: {
    superhero: "Une aide locale à la rédaction pour les cliniciens",
    poster: ["Brouillons cliniques structurés,", "relus par vous"],
  },
  it: {
    superhero: "Un supporto locale alla stesura per i clinici",
    poster: ["Bozze cliniche strutturate,", "riviste da Lei"],
  },
  es: {
    superhero: "Una ayuda local de redacción para clínicos",
    poster: ["Borradores clínicos estructurados,", "revisados por usted"],
  },
};

const escapeXml = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const svgDocument = (width, height, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
  `<rect width="${width}" height="${height}" fill="${background}"/>` +
  body +
  `</svg>`;

const text = ({ x, y, size, anchor = "start", content, weight = "normal" }) =>
  `<text x="${x}" y="${y}" font-family="${fontFamily}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${foreground}">${escapeXml(content)}</text>`;

const mark = ({ x, y, size }) => text({ x, y, size, anchor: "middle", content: "E" });

const posterSvg = ({ poster }) =>
  svgDocument(
    1440,
    2160,
    mark({ x: 713, y: 942, size: 713 }) +
      text({ x: 720, y: 1356, size: 167, anchor: "middle", content: "Epikrise" }) +
      text({ x: 720, y: 1474, size: 60, anchor: "middle", content: poster[0] }) +
      text({ x: 720, y: 1555, size: 60, anchor: "middle", content: poster[1] }),
  );

const superheroSvg = ({ superhero }) =>
  svgDocument(
    3840,
    2160,
    mark({ x: 3083, y: 1517, size: 1250 }) +
      text({ x: 303, y: 983, size: 300, content: "Epikrise" }) +
      text({ x: 303, y: 1175, size: 110, content: superhero }),
  );

const packagingSvg = () =>
  svgDocument(2160, 2160, mark({ x: 1058, y: 1594, size: 1410 }));

async function render(svg, outputPath, tempDir) {
  const svgPath = join(tempDir, `${Math.random().toString(36).slice(2)}.svg`);
  await writeFile(svgPath, svg);
  await execFileAsync("convert", [
    "-background",
    "none",
    svgPath,
    `PNG24:${outputPath}`,
  ]);
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
  const tempDir = await mkdtemp(join(tmpdir(), "epikrise-store-assets-"));

  try {
    for (const locale of selected) {
      const strings = locales[locale];
      const localeDir = join(assetRoot, locale);
      await mkdir(localeDir, { recursive: true });
      await render(
        posterSvg(strings),
        join(localeDir, "poster-9x16-1440x2160.png"),
        tempDir,
      );
      await render(
        superheroSvg(strings),
        join(localeDir, "superhero-16x9-3840x2160.png"),
        tempDir,
      );
      console.log(`Generated store assets for ${locale}`);
    }

    if (requested.length === 0) {
      await render(
        packagingSvg(),
        join(assetRoot, "packaging-1x1-2160x2160.png"),
        tempDir,
      );
      console.log("Generated packaging icon");
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
