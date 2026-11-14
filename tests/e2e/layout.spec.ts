import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

type LocaleCase = {
  locale: string;
  heading?: string;
};

const localeCases: LocaleCase[] = [
  { locale: "en", heading: "New discharge summary" },
  { locale: "de-CH", heading: "Neuer Austrittsbericht" },
  { locale: "fr", heading: "Nouvelle épicrise" },
  { locale: "it", heading: "Nuova lettera di dimissione" },
  { locale: "es", heading: "Nueva epicrisis" },
  // Pseudo-localized preview: longer strings expose layout problems early.
  { locale: "qps-ploc" },
];

const viewports = [
  { name: "minimum supported", width: 960, height: 640 },
  { name: "default", width: 1280, height: 860 },
];

// Header buttons in source order: Help, General, Provider, Model, Template.
const settingsTriggers = { help: 0, general: 1, provider: 2, model: 3, template: 4 };

async function selectLocale(page: Page, locale: string) {
  await page.locator(".settings-trigger").nth(settingsTriggers.general).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator("#interface-language").selectOption(locale);
  await expect(page.locator("#interface-language")).toHaveValue(locale);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function openScreen(page: Page, trigger: number) {
  await page.locator(".settings-trigger").nth(trigger).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function closeScreen(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

// Long synthetic text fills the source panel and draft output so wrapping is exercised.
const longSource = Array.from(
  { length: 6 },
  (_, index) =>
    `Synthetic paragraph ${index + 1}: patient stable, observations recorded, ` +
    "follow-up arranged with the community team and results reviewed before discharge.",
).join("\n\n");

const longDraft = Array.from(
  { length: 8 },
  (_, index) =>
    `Synthetic draft section ${index + 1} with extended wording that must wrap cleanly ` +
    "inside the draft output panel at every supported width without clipping controls.",
).join("\n\n");

async function openCaseView(page: Page) {
  await page.locator("#source-material").fill(longSource);
  await page.locator(".generate-button").click();
  await page.waitForFunction(
    () => window.__EPIKRISE_TEST__?.generationRequests.length === 1,
  );
  const requestId = await page.evaluate(
    () => window.__EPIKRISE_TEST__?.generationRequests[0]?.requestId,
  );
  await page.evaluate(
    ({ requestId, output }) => {
      window.__EPIKRISE_TEST__?.emit("generation://done", {
        requestId,
        content: output,
        violations: [],
      });
    },
    { requestId, output: longDraft },
  );
  await expect(page.locator(".draft-output")).toContainText(
    "Synthetic draft section 8",
  );
}

async function openTemplateEditor(page: Page) {
  await openScreen(page, settingsTriggers.template);
  await page.locator(".edit-template-button").click();
  await expect(page.locator(".template-editor-dialog")).toBeVisible();
  await expectLayoutFits(page);
  await page.locator(".template-editor-dialog .dialog-close").click();
}

async function expectLayoutFits(page: Page) {
  const problems = await page.evaluate(() => {
    const issues: string[] = [];
    const viewportWidth = document.documentElement.clientWidth;
    const { scrollWidth } = document.documentElement;
    if (scrollWidth > viewportWidth) {
      issues.push(`document scrolls horizontally (${scrollWidth} > ${viewportWidth})`);
    }

    for (const dialog of document.querySelectorAll<HTMLElement>("dialog[open]")) {
      const box = dialog.getBoundingClientRect();
      if (box.left < -1 || box.right > viewportWidth + 1) {
        issues.push(
          `dialog leaves the viewport: ${dialog.getAttribute("aria-labelledby")}`,
        );
      }
    }

    const selector = "button, [role='tab'], label, a, h1, h2, h3";
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (style.visibility === "hidden" || box.width === 0 || box.height === 0)
        continue;
      // Intentional single-line truncation is allowed to exceed its box.
      if (style.textOverflow === "ellipsis") continue;
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      if (text.width === 0 || text.height === 0) continue;
      const overflows =
        text.left < box.left - 1 ||
        text.right > box.right + 1 ||
        text.top < box.top - 1 ||
        text.bottom > box.bottom + 1;
      if (overflows) {
        issues.push(`clipped or overflowing text: "${element.textContent?.trim()}"`);
      }
    }
    return issues;
  });
  expect(problems).toEqual([]);
}

for (const viewport of viewports) {
  test.describe(`${viewport.name} viewport (${viewport.width}x${viewport.height})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const { locale, heading } of localeCases) {
      test(`${locale} fits the workspace, settings, case view, and template editor`, async ({
        page,
      }) => {
        await page.goto("/");
        await selectLocale(page, locale);
        if (heading) {
          await expect(page.getByRole("heading", { name: heading })).toBeVisible();
        }
        await expectLayoutFits(page);

        for (const trigger of Object.values(settingsTriggers)) {
          await openScreen(page, trigger);
          await expectLayoutFits(page);
          await closeScreen(page);
        }

        await openCaseView(page);
        await expectLayoutFits(page);

        await openTemplateEditor(page);
      });
    }
  });
}
