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
