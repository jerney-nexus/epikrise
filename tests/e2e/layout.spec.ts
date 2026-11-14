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
  // Generation clears the source, so check the populated source before submitting.
  await page.locator("#source-material").fill(longSource);
  await expectContentFitsWidth(page, "#source-material");
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
  await expectContentFitsWidth(page, ".draft-output");
}

async function openTemplateEditor(page: Page) {
  await openScreen(page, settingsTriggers.template);
  await page.locator(".edit-template-button").click();
  await expect(page.locator(".template-editor-dialog")).toBeVisible();
  await expectLayoutFits(page);
  await page.locator(".template-editor-dialog .dialog-close").click();
}

// Horizontal-only check for scrollable text areas: vertical scrolling is intentional.
async function expectContentFitsWidth(page: Page, selector: string) {
  const problems = await page.locator(selector).evaluate((container) => {
    const issues: string[] = [];
    const box = container.getBoundingClientRect();
    if (container.scrollWidth > container.clientWidth + 1) {
      issues.push("container scrolls horizontally");
    }
    for (const element of container.querySelectorAll<HTMLElement>("*")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Content inside an intentional horizontal scroller may extend past the box.
      let insideScroller = false;
      for (
        let node = element.parentElement;
        node && node !== container;
        node = node.parentElement
      ) {
        if (["auto", "scroll"].includes(getComputedStyle(node).overflowX)) {
          insideScroller = true;
          break;
        }
      }
      if (insideScroller) continue;
      if (rect.left < box.left - 1 || rect.right > box.right + 1) {
        issues.push(
          `content exceeds container width: "${element.textContent?.trim().slice(0, 40)}"`,
        );
      }
    }
    return issues;
  });
  expect(problems).toEqual([]);
}

// Screen-level checks for the topmost dialog, or the whole page when none is open.
async function expectLayoutFits(page: Page) {
  const problems = await page.evaluate(() => {
    const issues: string[] = [];
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const { scrollWidth } = document.documentElement;
    if (scrollWidth > viewportWidth) {
      issues.push(`document scrolls horizontally (${scrollWidth} > ${viewportWidth})`);
    }

    // Earlier open dialogs are covered by the topmost one and not interactive.
    const dialogs = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
    const topDialog = dialogs.item(dialogs.length - 1);
    const root: ParentNode = topDialog ?? document.body;
    if (topDialog) {
      const box = topDialog.getBoundingClientRect();
      if (
        box.left < -1 ||
        box.top < -1 ||
        box.right > viewportWidth + 1 ||
        box.bottom > viewportHeight + 1
      ) {
        issues.push(
          `dialog leaves the viewport: ${topDialog.getAttribute("aria-labelledby")}`,
        );
      }
    }

    const clipsOverflow = (style: CSSStyleDeclaration) =>
      ["hidden", "clip"].includes(style.overflowX) ||
      ["hidden", "clip"].includes(style.overflowY);
    const scrolls = (style: CSSStyleDeclaration) =>
      ["auto", "scroll"].includes(style.overflowX) ||
      ["auto", "scroll"].includes(style.overflowY);
    // The part of an element that is visible through its clipping or scrolling ancestors.
    const visibleRect = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      let { left, top, right, bottom } = rect;
      for (
        let node = element.parentElement;
        node && node !== document.body;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        if (!clipsOverflow(style) && !scrolls(style)) continue;
        const clip = node.getBoundingClientRect();
        left = Math.max(left, clip.left);
        top = Math.max(top, clip.top);
        right = Math.min(right, clip.right);
        bottom = Math.min(bottom, clip.bottom);
      }
      return { left, top, right, bottom };
    };

    const label = (element: HTMLElement) =>
      element.textContent?.trim().slice(0, 40) || element.tagName.toLowerCase();

    const checkControls = () => {
      // The hidden template and source file inputs are clipped off-screen; their visible trigger buttons are checked instead.
      const controls = Array.from(
        root.querySelectorAll<HTMLElement>(
          "button, [role='tab'], label, a, h1, h2, h3, input:not(.template-file-input):not(.source-file-input), select, textarea",
        ),
      ).filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      });

      for (const element of controls) {
        const box = element.getBoundingClientRect();
        for (
          let node = element.parentElement;
          node && node !== document.body;
          node = node.parentElement
        ) {
          const style = getComputedStyle(node);
          if (scrolls(style)) break;
          if (!clipsOverflow(style)) continue;
          const clip = node.getBoundingClientRect();
          if (
            box.left < clip.left - 1 ||
            box.right > clip.right + 1 ||
            box.top < clip.top - 1 ||
            box.bottom > clip.bottom + 1
          ) {
            issues.push(`control clipped by ancestor: "${label(element)}"`);
            break;
          }
        }
      }

      const selector = "button, [role='tab'], label, a, h1, h2, h3";
      for (const element of root.querySelectorAll<HTMLElement>(selector)) {
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
          issues.push(`clipped or overflowing text: "${label(element)}"`);
        }
      }

      // Unrelated controls must not paint over each other; ancestor/descendant pairs are expected.
      for (let i = 0; i < controls.length; i += 1) {
        for (let j = i + 1; j < controls.length; j += 1) {
          const a = controls[i];
          const b = controls[j];
          if (a.contains(b) || b.contains(a)) continue;
          const first = visibleRect(a);
          const second = visibleRect(b);
          const overlapX =
            Math.min(first.right, second.right) - Math.max(first.left, second.left);
          const overlapY =
            Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
          if (overlapX > 1 && overlapY > 1) {
            issues.push(`controls overlap: "${label(a)}" and "${label(b)}"`);
          }
        }
      }
    };

    checkControls();
    // Content below the fold in a scroll container only renders after scrolling, so check each scroll position.
    const candidates = root instanceof HTMLElement ? [root] : [];
    const scrollers = [
      ...candidates,
      ...root.querySelectorAll<HTMLElement>("*"),
    ].filter(
      (element) =>
        scrolls(getComputedStyle(element)) &&
        element.scrollHeight > element.clientHeight + 1,
    );
    for (const scroller of scrollers) {
      const initialTop = scroller.scrollTop;
      const step = Math.max(1, scroller.clientHeight);
      for (let top = 0; ; top += step) {
        scroller.scrollTop = top;
        checkControls();
        if (top + step >= scroller.scrollHeight) break;
      }
      scroller.scrollTop = initialTop;
    }
    return [...new Set(issues)];
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
