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
  await expect(helpDialog).toContainText("current case material and template");
});
