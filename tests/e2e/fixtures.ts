import { expect, test as base } from "@playwright/test";
import type {
  ClinicalTemplate,
  CredentialSummary,
  PolicyStatus,
  ProviderAdapter,
} from "../../src/bindings";

type FixtureOptions = {
  seedTemplates: boolean;
  allSectionsDisabled: boolean;
  uiLocale: string;
  policy: PolicyStatus;
};

type FixtureSetup = {
  seedTemplates: boolean;
  allSectionsDisabled: boolean;
  uiLocale: string;
  template: ClinicalTemplate;
  policy: PolicyStatus;
};

type InvokeArguments = Record<string, unknown>;

type BrowserFixture = {
  commands: { command: string; args: InvokeArguments }[];
  generationRequests: InvokeArguments[];
  clipboardWrites: { command: string; args: InvokeArguments }[];
  failNextReviewAck: boolean;
  failHtmlClipboard: boolean;
  templateExportCancelled: boolean;
  emit: (event: string, payload: unknown) => void;
};

declare global {
  interface Window {
    __EPIKRISE_TEST__?: BrowserFixture;
    __TAURI_INTERNALS__?: {
      invoke: (command: string, args?: InvokeArguments) => Promise<unknown>;
      transformCallback: (callback: (payload: unknown) => void) => number;
      unregisterCallback: (callbackId: number) => void;
    };
  }
}

const syntheticTemplate: ClinicalTemplate = {
  schema_version: 1,
  metadata: {
    id: "synthetic-test-template",
    name: "Synthetic test template",
    description: "Synthetic fixture only",
    locale: "en",
    specialty_tags: [],
    version: "1.0.0",
    author: "Playwright fixture",
  },
  system_prompt: "Use only the synthetic fixture input.",
  variables: [],
  sections: [
    {
      id: "summary",
      heading: "Summary",
      order: 0,
      enabled_by_default: true,
      labels: { en: "Summary" },
    },
    {
      id: "findings",
      heading: "Findings",
      order: 1,
      enabled_by_default: true,
      labels: { en: "Findings" },
    },
  ],
  output_rules: {},
};

const syntheticPolicy: PolicyStatus = {
  active: false,
  localOnly: false,
  allowedProviders: null,
  allowUrlIngestion: true,
  allowUpdater: true,
  requireReviewGate: true,
  allowTemplateImport: true,
  allowTemplateExport: true,
  allowTemplateEdit: true,
  allowTemplateCreation: true,
  allowTemplateDeletion: true,
  allowedModels: null,
  maxOutputTokens: null,
  maxReasoningEffort: null,
  fixedEndpoint: null,
  allowCredentialManagement: true,
  permissionsWarning: false,
};

function installTauriFixture({
  seedTemplates,
  allSectionsDisabled,
  uiLocale,
  template,
  policy,
}: FixtureSetup) {
  const callbacks = new Map<number, (payload: unknown) => void>();
  const listeners = new Map<string, Map<number, number>>();
  const authorizedCases = new Set<string>();
  const credentials = new Map<string, CredentialSummary>();
  let nextCallbackId = 1;
  let nextListenerId = 1;
  let updaterEnabled = false;
  const fixture: BrowserFixture = {
    commands: [],
    generationRequests: [],
    clipboardWrites: [],
    failNextReviewAck: false,
    failHtmlClipboard: false,
    templateExportCancelled: false,
    emit(event, payload) {
      const eventListeners = listeners.get(event);
      if (!eventListeners) return;
      for (const [eventId, callbackId] of eventListeners) {
        callbacks.get(callbackId)?.({ event, id: eventId, payload });
      }
    },
  };
  window.__EPIKRISE_TEST__ = fixture;
  Object.assign(globalThis, { isTauri: true });
  window.localStorage.setItem("epikrise.ui-locale", uiLocale);

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, eventId) {
      listeners.get(event)?.delete(eventId);
    },
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback) {
      const callbackId = nextCallbackId++;
      callbacks.set(callbackId, callback);
      return callbackId;
    },
    unregisterCallback(callbackId) {
      callbacks.delete(callbackId);
    },
    async invoke(command, args = {}) {
      fixture.commands.push({ command, args });
      const templateData = seedTemplates
        ? [
            {
              ...template,
              sections: template.sections.map((section) => ({
                ...section,
                enabled_by_default: allSectionsDisabled
                  ? false
                  : section.enabled_by_default,
              })),
            },
          ]
        : [];
      switch (command) {
        case "get_update_settings":
          return {
            available: true,
            enabled: updaterEnabled,
            policyAllowed: policy.allowUpdater,
          };
        case "set_update_enabled":
          updaterEnabled = args.enabled === true;
          return {
            available: true,
            enabled: updaterEnabled,
            policyAllowed: policy.allowUpdater,
          };
        case "check_for_update":
          return {
            version: "2026.11.0",
            notes: "Synthetic update notes.",
            target: "synthetic-test-target",
          };
        case "install_update":
          return null;
        case "get_policy_status":
          return policy;
        case "load_templates":
          return templateData;
        case "list_provider_credentials":
          return [...credentials.values()];
        case "create_case_session":
          return {
            id: args.id,
            template_id: args.templateId,
            template_values: {},
            inputs: [],
            current_output: null,
            reviewed_output_hash: null,
            generation_in_progress: false,
          };
        case "render_template_system_prompt":
          return template.system_prompt;
        case "authorize_provider_egress": {
          const caseId = String(args.caseId);
          if (args.confirmed === true) authorizedCases.add(caseId);
          return (
            authorizedCases.has(caseId) ||
            (args.profile as { adapter?: string } | undefined)?.adapter === "ollama"
          );
        }
        case "generate":
          fixture.generationRequests.push(args.request as InvokeArguments);
          return null;
        case "set_case_review":
          if (fixture.failNextReviewAck) {
            fixture.failNextReviewAck = false;
            throw { key: "internal" };
          }
          return true;
        case "copy_case_output":
          return "Synthetic reviewed output\n";
        case "clear_case_session":
        case "cancel_generation":
        case "save_templates":
          return true;
        case "set_provider_credential": {
          const adapter = args.adapter as ProviderAdapter;
          const label = String(args.label ?? "");
          const summary: CredentialSummary = {
            id: `${adapter}:${label}`,
            adapter,
            label,
          };
          credentials.set(summary.id, summary);
          return summary;
        }
        case "delete_provider_credential":
          credentials.delete(String(args.credentialId ?? ""));
          return null;
        case "create_template":
        case "delete_template":
          return null;
        case "test_provider":
        case "list_models":
          return [];
        case "validate_template": {
          const bytes = args.bytes;
          if (Array.isArray(bytes)) {
            const serialized = new TextDecoder().decode(
              Uint8Array.from(bytes as number[]),
            );
            if (serialized.trimStart().startsWith("{")) {
              return JSON.parse(serialized) as ClinicalTemplate;
            }
          }
          return template;
        }
        case "export_template":
          return fixture.templateExportCancelled ? "" : "synthetic template";
        case "extract_raw_text":
        case "extract_text_file":
        case "extract_file":
        case "extract_image":
        case "extract_url":
          return {
            id: crypto.randomUUID(),
            round: 0,
            provenance:
              command === "extract_file"
                ? { File: { name: String(args.fileName) } }
                : command === "extract_url"
                  ? { Url: { address: String(args.address) } }
                  : "RawText",
            content: "Synthetic extracted content",
            extraction_method: command === "extract_file" ? "parsed" : "manual",
            images: [],
          };
        case "plugin:event|listen": {
          const event = String(args.event);
          const callbackId = Number(args.handler);
          const eventId = nextListenerId++;
          const eventListeners = listeners.get(event) ?? new Map<number, number>();
          eventListeners.set(eventId, callbackId);
          listeners.set(event, eventListeners);
          return eventId;
        }
        case "plugin:event|unlisten":
          listeners.get(String(args.event))?.delete(Number(args.eventId));
          return null;
        case "plugin:clipboard-manager|write_text":
          fixture.clipboardWrites.push({ command, args });
          return null;
        case "plugin:clipboard-manager|write_html":
          if (fixture.failHtmlClipboard) {
            return Promise.reject(new Error("Synthetic HTML clipboard failure"));
          }
          fixture.clipboardWrites.push({ command, args });
          return null;
        default:
          throw new Error(`Unexpected IPC command: ${command}`);
      }
    },
  };
}

export const test = base.extend<FixtureOptions>({
  seedTemplates: [true, { option: true }],
  allSectionsDisabled: [false, { option: true }],
  uiLocale: ["en", { option: true }],
  policy: [syntheticPolicy, { option: true }],
  page: async ({ page, seedTemplates, allSectionsDisabled, uiLocale, policy }, use) => {
    const origin = new URL("http://127.0.0.1:1420").origin;
    const unexpectedRequests: string[] = [];
    await page.addInitScript(installTauriFixture, {
      seedTemplates,
      allSectionsDisabled,
      uiLocale,
      template: syntheticTemplate,
      policy,
    });
    await page.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin === origin) {
        await route.continue();
        return;
      }
      unexpectedRequests.push(requestUrl.href);
      await route.abort();
    });
    await use(page);
    expect(unexpectedRequests).toEqual([]);
  },
});

export { expect };
