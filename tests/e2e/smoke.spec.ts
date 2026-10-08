import { expect, test } from "./fixtures";

test("renders the workspace using the synthetic desktop bridge", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "New discharge summary" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Anonymized clinical material" }),
  ).toBeVisible();
});

test("opens help with workflow and privacy details", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Help" }).click();

  const helpDialog = page.getByRole("dialog", { name: "Using Epikrise" });
  await expect(helpDialog).toBeVisible();
  await expect(helpDialog).toContainText("not saved as history");
  await expect(helpDialog).toContainText("OS/runtime may retain copies");
  await expect(helpDialog).toContainText("current case material and template");
  await expect(helpDialog).toContainText(
    "first send to each remote endpoint in each case",
  );
});

test("help text inherits the dark-mode dialog foreground", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await page.getByRole("button", { name: "Help" }).click();

  const helpDialog = page.getByRole("dialog", { name: "Using Epikrise" });
  const dialogColor = await helpDialog.evaluate(
    (dialog) => getComputedStyle(dialog).color,
  );
  const headingColor = await helpDialog
    .getByRole("heading", { name: "Workflow" })
    .evaluate((heading) => getComputedStyle(heading).color);
  const bodyColor = await helpDialog
    .locator(".help-copy p")
    .first()
    .evaluate((paragraph) => getComputedStyle(paragraph).color);

  expect(headingColor).toBe(dialogColor);
  expect(bodyColor).toBe(dialogColor);
});
