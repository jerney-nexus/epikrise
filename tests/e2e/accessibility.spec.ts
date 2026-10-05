import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

test.use({ reducedMotion: "reduce" });

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(results.violations).toEqual([]);
}

const onboardingTest = test.extend({ seedTemplates: false });

onboardingTest(
  "@a11y first-run onboarding has no WCAG 2.2 A/AA violations",
  async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Bring your clinical template" }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
  },
);

test("@a11y workspace and settings dialogs have no scoped axe violations", async ({
  page,
}) => {
  await page.goto("/");
  await expectNoAxeViolations(page);

  await page.getByRole("button", { name: "General settings" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "General settings" });
  await expect(settingsDialog).toBeVisible();
  await expect(
    page.getByText("Update checks contact GitHub Releases only when requested."),
  ).toBeVisible();
  const bottomClearance = await settingsDialog.evaluate((element) => {
    const updateSettings = element.querySelector(".update-settings");
    return updateSettings
      ? element.getBoundingClientRect().bottom -
          updateSettings.getBoundingClientRect().bottom
      : Number.POSITIVE_INFINITY;
  });
  expect(bottomClearance).toBeLessThan(40);
  const heightBeforeClick = await settingsDialog.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  const updateCheckbox = page.getByRole("checkbox", {
    name: "Enable direct-release updates",
  });
  const sizeBeforeClick = await updateCheckbox.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(sizeBeforeClick).toEqual({ width: 18, height: 18 });
  await page.getByRole("heading", { name: "General settings" }).click();
  const heightAfterClick = await settingsDialog.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(heightAfterClick).toBe(heightBeforeClick);
  const sizeAfterClick = await updateCheckbox.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(sizeAfterClick).toEqual(sizeBeforeClick);
  await expectNoAxeViolations(page);
});

test("@a11y updater install confirmation has no WCAG 2.2 A/AA violations", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "General settings" }).click();
  await page.getByRole("checkbox", { name: "Enable direct-release updates" }).check();
  await page.getByRole("button", { name: "Check for updates" }).click();
  await page.getByRole("button", { name: "Install update" }).click();
  await expect(
    page.getByRole("dialog", { name: "Install this update?" }),
  ).toBeVisible();
  await expectNoAxeViolations(page);
});

test("@a11y template and egress dialogs have no WCAG 2.2 A/AA violations", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Template settings" }).click();
  await expect(page.getByRole("dialog", { name: "Template settings" })).toBeVisible();
  await expectNoAxeViolations(page);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Provider settings" }).click();
  await page.locator("#active-adapter").selectOption("open_ai");
  await page.keyboard.press("Escape");
  await page
    .getByRole("textbox", { name: "Anonymized clinical material" })
    .fill("Synthetic accessibility fixture input.");
  await page.getByRole("button", { name: "Generate draft" }).click();
  const consent = page.getByRole("dialog", {
    name: "Confirm sending clinical material",
  });
  await expect(consent).toBeVisible();
  await expectNoAxeViolations(page);
});

test("@a11y reviewed output controls have no WCAG 2.2 A/AA violations", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Anonymized clinical material" })
    .fill("Synthetic accessibility output input.");
  await page.getByRole("button", { name: "Generate draft" }).click();
  await page.waitForFunction(
    () => window.__EPIKRISE_TEST__?.generationRequests.length === 1,
  );
  await page.evaluate(() => {
    const requestId = window.__EPIKRISE_TEST__?.generationRequests[0].requestId;
    window.__EPIKRISE_TEST__?.emit("generation://done", {
      requestId,
      content: "Synthetic reviewed output.",
      violations: [],
    });
  });
  await page
    .getByRole("checkbox", {
      name: "I have reviewed the output and take responsibility.",
    })
    .check();
  await expect(
    page.getByRole("button", { name: "Copy to medical record" }),
  ).toBeEnabled();
  await expectNoAxeViolations(page);
});

test("@a11y workspace remains usable at the supported minimum viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto("/");
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("@a11y traps settings focus and returns focus to its opener", async ({ page }) => {
  await page.goto("/");
  const opener = page.getByRole("button", { name: "General settings" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "General settings" });
  await expect(dialog).toBeVisible();

  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    const focusState = await page.evaluate(() => ({
      activeElement: document.activeElement?.tagName,
      activeId: document.activeElement?.id,
      inOpenDialog: Boolean(document.activeElement?.closest("dialog[open]")),
    }));
    expect(focusState.inOpenDialog, `Tab ${index}: ${JSON.stringify(focusState)}`).toBe(
      true,
    );
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("@a11y supports de-CH and pseudo-locale layouts at minimum width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto("/");
  await page.getByRole("button", { name: "General settings" }).click();
  await page.getByLabel("Interface language").selectOption("de-CH");
  await expect(page.locator("html")).toHaveAttribute("lang", "de-CH");
  await expect(
    page.getByRole("heading", { name: "Klinische Unterlagen" }),
  ).toBeVisible();

  await page.getByLabel("Oberflächensprache").selectOption("qps-ploc");
  await expect(page.locator("main h2")).toContainText("［");
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});
