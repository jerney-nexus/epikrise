import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import type { PolicyStatus } from "../../src/bindings";

const onboardingTest = test.extend({ seedTemplates: false });
const restrictedPolicy: PolicyStatus = {
  active: true,
  localOnly: true,
  allowedProviders: ["ollama"],
  allowUrlIngestion: false,
  allowUpdater: false,
  requireReviewGate: true,
  allowTemplateImport: false,
  allowTemplateExport: false,
  allowTemplateEdit: false,
  allowedModels: [{ adapter: "ollama", model: "approved-model" }],
  maxOutputTokens: 2048,
  maxReasoningEffort: "low",
  fixedEndpoint: "http://localhost:11434",
  allowCredentialManagement: false,
  permissionsWarning: false,
};
const policyTest = test.extend({ policy: restrictedPolicy });

test("requires updater opt-in and explicit install confirmation", async ({ page }) => {
  await page.goto("/");
  expect(
    await page.evaluate(() => ({
      locale: document.documentElement.lang,
      preference: localStorage.getItem("epikrise.ui-locale"),
      fixtureInstalled: Boolean(window.__EPIKRISE_TEST__),
    })),
  ).toEqual({ locale: "en", preference: "en", fixtureInstalled: true });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__EPIKRISE_TEST__?.commands.some(
          ({ command }) => command === "get_update_settings",
        ),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "General settings" }).click();

  const optIn = page.getByRole("checkbox", {
    name: "Enable direct-release updates",
  });
  const checkButton = page.getByRole("button", { name: "Check for updates" });
  await expect(optIn).toBeEnabled();
  await expect(optIn).not.toBeChecked();
  await expect(checkButton).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        window.__EPIKRISE_TEST__?.commands.filter(
          ({ command }) => command === "check_for_update",
        ).length,
    ),
  ).toBe(0);

  await optIn.check();
  await expect(checkButton).toBeEnabled();
  await checkButton.click();
  await expect(
    page
      .getByRole("group", { name: "Software updates" })
      .getByText("Update version: 2026.11.0"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Install update" }).click();
  const confirmation = page.getByRole("dialog", { name: "Install this update?" });
  await expect(confirmation).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.__EPIKRISE_TEST__?.commands.filter(
          ({ command }) => command === "install_update",
        ).length,
    ),
  ).toBe(0);

  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Install update" }).click();
  await confirmation.getByRole("button", { name: "Confirm install" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__EPIKRISE_TEST__?.commands.filter(
          ({ command }) => command === "install_update",
        ),
      ),
    )
    .toMatchObject([{ args: { confirmed: true }, command: "install_update" }]);
});

policyTest("disables updater controls when policy denies updates", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "General settings" }).click();
  await expect(
    page.getByText("Updates are disabled by administrator policy."),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Enable direct-release updates" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Check for updates" })).toHaveCount(0);
});

onboardingTest(
  "shows first-run template guidance without stored templates",
  async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Bring your clinical template" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open template settings" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Clinical material" })).toHaveCount(
      0,
    );
  },
);

async function startSyntheticGeneration(page: Page, content: string) {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Anonymized clinical material" })
    .fill(content);
  await page.getByRole("button", { name: "Generate draft" }).click();
  await page.waitForFunction(
    () => window.__EPIKRISE_TEST__?.generationRequests.length === 1,
  );
  return page.evaluate(() => window.__EPIKRISE_TEST__?.generationRequests[0]);
}

async function completeSyntheticGeneration(page: Page, content: string) {
  const request = await startSyntheticGeneration(page, "Synthetic fixture input.");
  await page.evaluate(
    ({ requestId, output }) => {
      window.__EPIKRISE_TEST__?.emit("generation://done", {
        requestId,
        content: output,
        violations: [],
      });
    },
    { requestId: request?.requestId, output: content },
  );
}

test("sends a synthetic generation request and gates reviewed copying", async ({
  page,
}) => {
  await page.goto("/");
  const request = await startSyntheticGeneration(page, "Synthetic test material only.");
  expect(request).toMatchObject({
    profile: {
      adapter: "ollama",
      model: "llama3.2",
      endpoint: "http://localhost:11434",
      auth: { source: "none" },
      capabilities: { vision: false, streaming: true, max_context: null },
      generation: {
        temperature: null,
        max_tokens: 8192,
        reasoning_effort: null,
      },
    },
    inputs: [{ content: "Synthetic test material only.", provenance: "RawText" }],
    systemPrompt: "Use only the synthetic fixture input.",
    outputRules: {},
    templateValues: {},
    corrections: null,
  });

  const generatedText = "Synthetic generated output.";
  await page.evaluate((content) => {
    const requestId = window.__EPIKRISE_TEST__?.generationRequests[0].requestId;
    window.__EPIKRISE_TEST__?.emit("generation://done", {
      requestId,
      content,
      violations: [],
    });
  }, generatedText);
  await expect(page.getByText(generatedText)).toBeVisible();
  const copyButton = page.getByRole("button", { name: "Copy to medical record" });
  await expect(copyButton).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "I have reviewed the output and take responsibility.",
    })
    .check();
  await expect(copyButton).toBeEnabled();
  await copyButton.click();
  await expect(page.getByText("Reviewed formatted output copied")).toBeVisible();

  const clipboardWrites = await page.evaluate(
    () => window.__EPIKRISE_TEST__?.clipboardWrites,
  );
  expect(clipboardWrites).toHaveLength(1);
  expect(clipboardWrites?.[0].command).toBe("plugin:clipboard-manager|write_html");
});

test("imports a valid synthetic file and rejects an oversized file locally", async ({
  page,
}) => {
  await page.goto("/");
  const fileInput = page.getByLabel("Choose clinical files");
  await fileInput.setInputFiles({
    name: "synthetic-input.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic file contents only."),
  });
  await expect(page.getByText("synthetic-input.txt")).toBeVisible();
  const fileCommand = await page.evaluate(() =>
    window.__EPIKRISE_TEST__?.commands.find(
      ({ command }) => command === "extract_file",
    ),
  );
  expect(fileCommand).toMatchObject({
    command: "extract_file",
    args: { fileName: "synthetic-input.txt", visionEnabled: false },
  });

  await fileInput.setInputFiles({
    name: "oversized-synthetic-input.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole("status")).toContainText("oversized-synthetic-input.txt");
  const fileCommands = await page.evaluate(() =>
    window.__EPIKRISE_TEST__?.commands.filter(
      ({ command }) => command === "extract_file",
    ),
  );
  expect(fileCommands).toHaveLength(1);
});

test("keeps copying disabled when review acknowledgement fails", async ({ page }) => {
  await completeSyntheticGeneration(page, "Synthetic review failure output.");
  await page.evaluate(() => {
    if (window.__EPIKRISE_TEST__) {
      window.__EPIKRISE_TEST__.failNextReviewAck = true;
    }
  });
  const review = page.getByRole("checkbox", {
    name: "I have reviewed the output and take responsibility.",
  });
  await review.check();
  await expect(page.getByRole("status")).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "The review acknowledgement could not be saved.",
  );
  await expect(
    page.getByRole("button", { name: "Copy to medical record" }),
  ).toBeDisabled();
});

test("ignores stale generation events and handles cancellation", async ({ page }) => {
  const request = await startSyntheticGeneration(page, "Synthetic cancellation input.");
  await page.evaluate(() => {
    window.__EPIKRISE_TEST__?.emit("generation://done", {
      requestId: "stale-request-id",
      content: "Stale output must not render.",
      violations: [],
    });
  });
  await expect(page.getByText("Stale output must not render.")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel generation" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__EPIKRISE_TEST__?.commands.some(
          ({ command }) => command === "cancel_generation",
        ),
      ),
    )
    .toBe(true);
  await page.evaluate((requestId) => {
    window.__EPIKRISE_TEST__?.emit("generation://error", {
      requestId,
      error: { key: "cancelled" },
    });
  }, request?.requestId);
  await expect(page.getByRole("button", { name: "Cancel generation" })).toHaveCount(0);
});

test("requires explicit consent before the first remote send", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Provider settings" }).click();
  await page.locator("#active-adapter").selectOption("open_ai");
  await page.keyboard.press("Escape");
  await page
    .getByRole("textbox", { name: "Anonymized clinical material" })
    .fill("Synthetic remote-consent input only.");
  await page.getByRole("button", { name: "Generate draft" }).click();
  const consent = page.getByRole("dialog", {
    name: "Confirm sending clinical material",
  });
  await expect(consent).toBeVisible();
  await expect(consent).toContainText("https://api.openai.com/v1");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(consent).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => window.__EPIKRISE_TEST__?.generationRequests.length),
    )
    .toBe(0);

  await page.getByRole("button", { name: "Generate draft" }).click();
  await expect(consent).toBeVisible();
  await page.getByRole("button", { name: "Send to provider" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__EPIKRISE_TEST__?.generationRequests.length),
    )
    .toBe(1);
  const request = await page.evaluate(
    () => window.__EPIKRISE_TEST__?.generationRequests[0],
  );
  expect(request).toMatchObject({
    profile: { adapter: "open_ai", endpoint: null },
    inputs: [{ content: "Synthetic remote-consent input only." }],
  });
});

test("invalidates reviewed output after a template change", async ({ page }) => {
  await completeSyntheticGeneration(page, "Synthetic reviewed template output.");
  const review = page.getByRole("checkbox", {
    name: "I have reviewed the output and take responsibility.",
  });
  await review.check();
  const copyButton = page.getByRole("button", { name: "Copy to medical record" });
  await expect(copyButton).toBeEnabled();

  await page.getByRole("button", { name: "Template settings" }).click();
  await page.locator("#template-section-summary").uncheck();
  await expect(copyButton).toBeDisabled();
  await expect(review).not.toBeChecked();
});

test("keeps template settings open when the file picker is canceled", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Template settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Template settings" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Import template (.epitpl)" }),
  ).toBeVisible();

  await page.locator("#template-file").focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("heading", { name: "Template settings" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("keeps template settings centered and stacked at medium widths", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  await page.getByRole("button", { name: "Template settings" }).click();

  const dialog = page.getByRole("dialog", { name: "Template settings" });
  await expect(dialog).toBeVisible();
  const initialLayout = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const content = element.querySelector(".template-settings");
    const style = content ? getComputedStyle(content) : null;
    return {
      left: rect.left,
      width: rect.width,
      display: style?.display,
      flexDirection: style?.flexDirection,
    };
  });

  expect(initialLayout.width).toBeLessThan(600);
  expect(initialLayout.display).toBe("flex");
  expect(initialLayout.flexDirection).toBe("column");

  await page.mouse.click(1016, 384);
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => dialog.evaluate((element) => element.getBoundingClientRect().left))
    .toBe(initialLayout.left);
});

test("orders template settings controls with import before export", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Template settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Template settings" });

  const controlOrder = await dialog
    .locator("#active-template, .template-export-button, .template-import-button")
    .evaluateAll((controls) =>
      controls.map((control) => control.id || control.textContent?.trim()),
    );
  expect(controlOrder).toEqual([
    "active-template",
    "Edit template",
    "Import template (.epitpl)",
    "Export template (.epitpl)",
  ]);
});

test("keeps one enabled-by-default section in the template editor", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Template settings" }).click();
  await page.getByRole("button", { name: "Edit template" }).click();

  const editor = page.locator(".template-editor-dialog");
  const sectionToggles = editor.getByRole("checkbox", {
    name: "Enabled by default",
  });
  await expect(sectionToggles).toHaveCount(2);
  await sectionToggles.nth(0).uncheck();

  await expect(sectionToggles.nth(0)).not.toBeChecked();
  await expect(sectionToggles.nth(1)).toBeChecked();
  await expect(sectionToggles.nth(1)).toBeDisabled();
});

test("reflects active section selections in the template editor", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Template settings" }).click();
  await page.locator("#template-section-summary").uncheck();
  await page.getByRole("button", { name: "Edit template" }).click();

  const sectionToggles = page
    .locator(".template-editor-dialog")
    .getByRole("checkbox", { name: "Enabled by default" });
  await expect(sectionToggles.nth(0)).not.toBeChecked();
  await expect(sectionToggles.nth(1)).toBeChecked();
});

test.describe("templates with no enabled defaults", () => {
  test.use({ allSectionsDisabled: true });

  test("starts with the first section enabled in settings and editor", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Template settings" }).click();
    await expect(page.locator("#template-section-summary")).toBeChecked();
    await expect(page.locator("#template-section-findings")).not.toBeChecked();

    await page.getByRole("button", { name: "Edit template" }).click();
    const sectionToggles = page
      .locator(".template-editor-dialog")
      .getByRole("checkbox", { name: "Enabled by default" });
    await expect(sectionToggles.nth(0)).toBeChecked();
    await expect(sectionToggles.nth(1)).not.toBeChecked();
  });
});

test("styles settings actions consistently in light and dark themes", async ({
  page,
}) => {
  await page.goto("/");

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.getByRole("button", { name: "Template settings" }).click();
    const templateDialog = page.getByRole("dialog", { name: "Template settings" });
    const templateActions = await templateDialog
      .locator(".template-settings-action")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const style = getComputedStyle(button);
          const bounds = button.getBoundingClientRect();
          return {
            width: bounds.width,
            height: bounds.height,
            color: style.color,
            background: style.backgroundColor,
            border: style.borderTopColor,
          };
        }),
      );
    expect(templateActions).toHaveLength(3);
    expect(new Set(templateActions.map(({ width }) => width)).size).toBe(1);
    expect(new Set(templateActions.map(({ height }) => height)).size).toBe(1);
    expect(new Set(templateActions.map(({ color }) => color)).size).toBe(1);
    expect(new Set(templateActions.map(({ background }) => background)).size).toBe(1);
    expect(new Set(templateActions.map(({ border }) => border)).size).toBe(1);

    const templateWidth = await templateDialog.evaluate(
      (dialog) => dialog.getBoundingClientRect().width,
    );
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Model settings" }).click();
    const modelDialog = page.getByRole("dialog", { name: "Model settings" });
    const refreshStyle = await modelDialog
      .getByRole("button", { name: "Refresh models" })
      .evaluate((button) => {
        const style = getComputedStyle(button);
        return {
          color: style.color,
          background: style.backgroundColor,
          border: style.borderTopColor,
        };
      });
    expect(refreshStyle).toEqual({
      color: templateActions[0].color,
      background: templateActions[0].background,
      border: templateActions[0].border,
    });
    await expect
      .poll(() =>
        modelDialog.evaluate((dialog) => dialog.getBoundingClientRect().width),
      )
      .toBe(templateWidth);
    await page.keyboard.press("Escape");
  }
});

test("exports the active template through the native save flow", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Template settings" }).click();
  await page.getByRole("button", { name: "Export template (.epitpl)" }).click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__EPIKRISE_TEST__?.commands.some(
          ({ command }) => command === "export_template",
        ),
      ),
    )
    .toBe(true);
  await expect(page.getByRole("status")).toContainText("Template exported");
});

test("does not report an export when the save dialog is canceled", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    if (window.__EPIKRISE_TEST__) {
      window.__EPIKRISE_TEST__.templateExportCancelled = true;
    }
  });
  await page.getByRole("button", { name: "Template settings" }).click();
  await page.getByRole("button", { name: "Export template (.epitpl)" }).click();

  await expect(page.getByText("Template exported", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Template settings" })).toBeVisible();
});

test("falls back to plain text when reviewed HTML copying fails", async ({ page }) => {
  await completeSyntheticGeneration(page, "Synthetic plain-text output.");
  await page.evaluate(() => {
    if (window.__EPIKRISE_TEST__) {
      window.__EPIKRISE_TEST__.failHtmlClipboard = true;
    }
  });
  await page
    .getByRole("checkbox", {
      name: "I have reviewed the output and take responsibility.",
    })
    .check();
  await page.getByRole("button", { name: "Copy to medical record" }).click();
  await expect(page.getByText("Reviewed output copied as plain text")).toBeVisible();
  const clipboardWrites = await page.evaluate(
    () => window.__EPIKRISE_TEST__?.clipboardWrites,
  );
  expect(clipboardWrites?.map(({ command }) => command)).toEqual([
    "plugin:clipboard-manager|write_text",
  ]);
});

policyTest("shows administrator-managed settings as restricted", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Provider settings" }).click();
  await expect(
    page.getByRole("option", { name: "OpenAI", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Endpoint")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Add provider credential" }),
  ).toBeDisabled();
  await expect(page.getByText("Administrator managed").first()).toBeVisible();

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Model settings" }).click();
  await expect(page.getByLabel("Output token limit")).toHaveAttribute("max", "2048");
  await expect(
    page.getByRole("option", { name: "Medium", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#active-model")).toHaveValue("approved-model");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Template settings" }).click();
  await expect(page.getByRole("button", { name: "Edit template" })).toBeDisabled();
  await expect(page.locator("#template-section-summary")).toBeDisabled();
});
