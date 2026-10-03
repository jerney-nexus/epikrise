<script lang="ts">
  import { onMount, tick } from "svelte";
  import { resolve } from "$app/paths";
  import { isTauri } from "@tauri-apps/api/core";
  import { renderOutputHtml } from "$lib/output-format";
  import {
    defaultLocale,
    initializeLocale,
    localePreferenceKey,
    pseudoLocale,
    setLocale,
    supportedLocales,
    translate,
  } from "$lib/i18n";
  import {
    readText as readClipboardText,
    writeHtml as writeClipboardHtml,
    writeText as writeClipboardText,
  } from "@tauri-apps/plugin-clipboard-manager";
  import {
    commands,
    events,
    type ClinicalTemplate,
    type CredentialSummary,
    type AllowedModel,
    type ExtractedBlock,
    type ExtractionMethod,
    type IngestError,
    type LlmError,
    type OutputViolation,
    type ProviderAdapter,
    type ProviderProfile,
    type ReasoningEffort,
    type TemplateError,
    type UpdateCandidate,
    type UpdateSettings,
  } from "../bindings";

  type PolicyStatus = {
    active: boolean;
    localOnly: boolean;
    allowedProviders: ProviderAdapter[] | null;
    allowUrlIngestion: boolean;
    allowUpdater: boolean;
    requireReviewGate: boolean;
    allowTemplateImport: boolean;
    allowTemplateExport: boolean;
    allowTemplateEdit: boolean;
    allowedModels: AllowedModel[] | null;
    maxOutputTokens: number | null;
    maxReasoningEffort: ReasoningEffort | null;
    fixedEndpoint: string | null;
    allowCredentialManagement: boolean;
    permissionsWarning: boolean;
  };

  type PendingEgressConfirmation = {
    caseId: string;
    profile: ProviderProfile;
    corrections: string;
  };

  const providerNames: Record<ProviderAdapter, string> = {
    open_ai: "OpenAI",
    anthropic: "Anthropic",
    gemini: "Gemini",
    ollama: "Ollama",
    open_ai_compatible: "OpenAI compatible",
    open_router: "OpenRouter",
    xai: "xAI",
    groq: "Groq",
  };

  const errorMessages: Record<LlmError["key"], string> = {
    invalid_profile: "Check the provider settings.",
    invalid_request: "The request could not be sent.",
    authentication: "The provider credentials were not accepted.",
    network: "The provider could not be reached.",
    model: "The model rejected the request or returned no text.",
    provider_rejected: "The provider rejected the request.",
    quota: "The provider quota was exceeded.",
    cancelled: "Generation was cancelled.",
    internal: "The request could not be completed.",
    policy_restricted: "Credential changes are restricted by administrator policy.",
  };

  const templateErrorMessages: Record<TemplateError["key"], string> = {
    unsupported_schema_version: "This template version is not supported.",
    invalid_template: "The template is missing required information.",
    invalid_variable_name: "A template variable name is invalid.",
    duplicate_variable: "The template contains duplicate variables.",
    invalid_variable_definition: "A template variable definition is invalid.",
    invalid_section: "A template section is invalid.",
    invalid_section_selection: "Choose at least one valid template section.",
    invalid_serialized_template: "The selected file is not a valid template.",
    template_too_large: "Template files must be 1 MB or smaller.",
    missing_required_variable: "A required template value is missing.",
    invalid_variable_value: "A template value is invalid.",
    unknown_variable: "The template contains an unknown variable.",
    invalid_system_prompt: "The template prompt is invalid.",
    rendering_failed: "The template could not be rendered.",
    storage_failed: "The template library could not be saved or loaded.",
    policy_restricted: "This template action is restricted by administrator policy.",
  };

  const outputViolationMessages: Record<OutputViolation["kind"], string> = {
    forbidden_term: "Forbidden term",
    missing_required_term: "Required term is missing",
    code_fence: "Code fence is not allowed",
    leading_whitespace: "Leading whitespace is not allowed",
    parenthesized_date: "Date should not be in parentheses",
    bullet_character: "Bullet character is not allowed",
  };

  const maxTemplateBytes = 1_048_576;
  let templateFileInput: HTMLInputElement | undefined;
  let importedTemplates = $state<ClinicalTemplate[]>([]);
  let templateLibraryReady = $state(false);
  let activeTemplateId = $state("");
  let templateValues = $state<Record<string, string | boolean>>({});
  let templateSectionStates = $state<Record<string, boolean>>({});
  let caseSessionId = $state<string | null>(null);
  let caseSessionTemplateId = $state("");
  let reviewedOutputCaseId = $state<string | null>(null);
  let pendingTemplate = $state<ClinicalTemplate | null>(null);
  let templateMessage = $state("");
  let templateIsError = $state(false);
  let templateBusy = $state(false);
  let providerSettingsDialog: HTMLDialogElement | undefined;
  let generalSettingsDialog: HTMLDialogElement | undefined;
  let modelSettingsDialog: HTMLDialogElement | undefined;
  let templateSettingsDialog: HTMLDialogElement | undefined;
  let addCredentialDialog: HTMLDialogElement | undefined;
  let templateEditorDialog: HTMLDialogElement | undefined;
  let templateEditDraft = $state<ClinicalTemplate | null>(null);
  let templatePreview = $state("");
  let templatePreviewMessage = $state("");
  let templatePreviewIsError = $state(false);
  let templateSaveBusy = $state(false);
  let templatePreviewTimer: ReturnType<typeof setTimeout> | undefined;
  let templatePreviewRevision = 0;
  let egressConfirmationDialog: HTMLDialogElement | undefined;
  let pendingEgressConfirmation = $state<PendingEgressConfirmation | null>(null);
  let egressConfirmationBusy = $state(false);
  let policyStatus = $state<PolicyStatus | null>(null);
  let updateSettings = $state<UpdateSettings | null>(null);
  let updateCandidate = $state<UpdateCandidate | null>(null);
  let updateStatus = $state<"idle" | "checking" | "installing" | "error">("idle");
  let updateMessage = $state("");
  let updateDownloadedBytes = $state(0);
  let updateTotalBytes = $state<number | null>(null);
  let updateBusy = $state(false);
  let updateConfirmationDialog: HTMLDialogElement | undefined;

  let adapter = $state<ProviderAdapter>("ollama");
  let model = $state("llama3.2");
  let availableModels = $state<string[]>([]);
  let modelsForProfile = $state("");
  let modelListLoading = $state(false);
  let modelListMessage = $state("");
  let modelListIsError = $state(false);
  let endpoint = $state("");
  let credentialId = $state("");
  let providerCredentials = $state<CredentialSummary[]>([]);
  let newCredentialLabel = $state("");
  let credentialSecret = $state("");
  let credentialMessage = $state("");
  let credentialIsError = $state(false);
  let credentialBusy = $state(false);
  let credentialRemovalPending = $state(false);
  let visionEnabled = $state(false);
  let outputTokenLimit = $state<number | undefined>(8192);
  let reasoningEffort = $state<ReasoningEffort | "provider_default">(
    "provider_default",
  );
  let prompt = $state("");
  let sourceBlocks = $state<ExtractedBlock[]>([]);
  let sourceUrl = $state("");
  let ingestMessage = $state("");
  let ingestIsError = $state(false);
  let ingestBusy = $state(false);
  let sourceFileInput = $state<HTMLInputElement>();
  let draft = $state("");
  let outputPreviewMode = $state<"plain" | "formatted">("formatted");
  let outputViolations = $state<OutputViolation[]>([]);
  let activeRequestId = $state<string | null>(null);
  let connectionState = $state<"idle" | "checking" | "ready" | "error">("idle");
  let connectionMessage = $state("");
  let generationMessage = $state("");
  let generationIsError = $state(false);
  let copyReviewMessage = $state("");
  let isPreparingGeneration = $state(false);
  let isInvalidatingReview = $state(false);
  let desktopAvailable = $state(false);
  let uiLocale = $state(defaultLocale);

  const t = $derived.by(() => {
    const locale = uiLocale;
    return (source: string, args: Record<string, string | number> = {}): string =>
      translate(locale, source, args);
  });

  function changeUiLocale(locale: string) {
    setLocale(locale);
    uiLocale = locale;
    document.documentElement.lang = locale === pseudoLocale ? "en" : locale;
  }

  const isGenerating = $derived(activeRequestId !== null);
  const inputCharacterCount = $derived(
    prompt.length +
      sourceBlocks.reduce((count, block) => count + block.content.length, 0),
  );
  const draftLines = $derived(draft.split("\n"));
  const formattedOutput = $derived(
    renderOutputHtml(
      draft,
      outputViolations.map((violation) => violation.line),
    ),
  );
  const maxOutputTokenLimit = $derived(
    policyStatus?.active ? (policyStatus.maxOutputTokens ?? 1_000_000) : 1_000_000,
  );
  const isOutputTokenLimitValid = $derived(
    typeof outputTokenLimit === "number" &&
      Number.isInteger(outputTokenLimit) &&
      outputTokenLimit >= 1 &&
      outputTokenLimit <= maxOutputTokenLimit,
  );
  const outputTokenLimitIssue = $derived.by(() => {
    if (isOutputTokenLimitValid) return "";
    return policyStatus?.active &&
      policyStatus.maxOutputTokens !== null &&
      typeof outputTokenLimit === "number" &&
      outputTokenLimit > maxOutputTokenLimit
      ? "Output token limit exceeds administrator policy."
      : "Set an output token limit between 1 and 1,000,000.";
  });
  const canCopyOutput = $derived(
    Boolean(
      draft &&
      caseSessionId &&
      reviewedOutputCaseId === caseSessionId &&
      !isGenerating &&
      !isPreparingGeneration &&
      !isInvalidatingReview,
    ),
  );
  const enabledSectionCount = $derived(
    Object.values(templateSectionStates).filter(Boolean).length,
  );
  const editorEnabledSectionCount = $derived(
    templateEditDraft?.sections.filter((section) => section.enabled_by_default)
      .length ?? 0,
  );
  const activeTemplate = $derived(
    importedTemplates.find((template) => template.metadata.id === activeTemplateId) ??
      null,
  );
  const modelProfileKey = $derived(
    JSON.stringify([adapter, endpoint.trim(), credentialId.trim()]),
  );
  const currentModels = $derived.by(() => {
    const providerModels = modelsForProfile === modelProfileKey ? availableModels : [];
    if (!policyStatus?.active || !policyStatus.allowedModels) return providerModels;
    const allowedForAdapter = policyStatus.allowedModels
      .filter((allowed) => allowed.adapter === adapter)
      .map((allowed) => allowed.model);
    return [
      ...new Set([
        ...providerModels.filter((name) => isModelAllowed(adapter, name)),
        ...allowedForAdapter,
      ]),
    ];
  });
  const isCurrentModelAllowed = $derived(isModelAllowed(adapter, model));
  const generationConfigurationIssue = $derived.by(() => {
    if (!isProviderAllowed(adapter)) {
      return "Selected provider or endpoint is not allowed by administrator policy.";
    }
    if (!isCurrentModelAllowed) {
      return "Selected model is not allowed by administrator policy.";
    }
    if (outputTokenLimitIssue) return outputTokenLimitIssue;
    return "";
  });
  const credentialsForProvider = $derived(
    providerCredentials.filter((credential) => credential.adapter === adapter),
  );
  const selectedCredential = $derived(
    credentialsForProvider.find((credential) => credential.id === credentialId) ?? null,
  );
  const isFirstRun = $derived(
    desktopAvailable && templateLibraryReady && importedTemplates.length === 0,
  );
  const currentEndpoint = $derived(displayedEndpoint(adapter, endpoint));
  const currentProviderIsLocal = $derived(isLoopbackEndpoint(currentEndpoint));

  function createProfile(): ProviderProfile {
    const keychainId = credentialId.trim();
    return {
      id: "active-provider",
      display_name: providerNames[adapter],
      adapter,
      model: model.trim(),
      endpoint:
        policyStatus?.active && policyStatus.fixedEndpoint !== null
          ? policyStatus.fixedEndpoint
          : endpoint.trim() || (adapter === "ollama" ? "http://localhost:11434" : null),
      auth: keychainId
        ? { source: "keychain", credential_id: keychainId }
        : { source: "none" },
      capabilities: { vision: visionEnabled, streaming: true, max_context: null },
      generation: {
        temperature: null,
        max_tokens: outputTokenLimit ?? null,
        reasoning_effort:
          reasoningEffort === "provider_default" ? null : reasoningEffort,
      },
    };
  }

  function displayedEndpoint(
    selectedAdapter: ProviderAdapter,
    configuredEndpoint: string,
  ): string {
    if (policyStatus?.active && policyStatus.fixedEndpoint !== null) {
      return policyStatus.fixedEndpoint;
    }
    if (configuredEndpoint.trim()) return configuredEndpoint.trim();
    const defaults: Record<ProviderAdapter, string> = {
      open_ai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com/v1",
      gemini: "https://generativelanguage.googleapis.com/v1beta",
      ollama: "http://localhost:11434",
      open_ai_compatible: "https://api.openai.com/v1",
      open_router: "https://openrouter.ai/api/v1",
      xai: "https://api.x.ai/v1",
      groq: "https://api.groq.com/openai/v1",
    };
    return defaults[selectedAdapter];
  }

  function isLoopbackEndpoint(value: string): boolean {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return (
        host === "localhost" ||
        host === "::1" ||
        host.startsWith("127.") ||
        host === "[::1]"
      );
    } catch {
      return false;
    }
  }

  function isProviderAllowed(selectedAdapter: ProviderAdapter): boolean {
    if (!policyStatus?.active) return true;
    if (
      policyStatus.allowedProviders &&
      !policyStatus.allowedProviders.includes(selectedAdapter)
    ) {
      return false;
    }
    return (
      !policyStatus.localOnly ||
      ((selectedAdapter === "ollama" || selectedAdapter === "open_ai_compatible") &&
        isLoopbackEndpoint(displayedEndpoint(selectedAdapter, endpoint)))
    );
  }

  function isModelAllowed(
    selectedAdapter: ProviderAdapter,
    selectedModel: string,
  ): boolean {
    if (!policyStatus?.active || !policyStatus.allowedModels) return true;
    return policyStatus.allowedModels.some(
      (allowed) =>
        allowed.adapter === selectedAdapter && allowed.model === selectedModel,
    );
  }

  function selectAllowedModelForAdapter() {
    if (isModelAllowed(adapter, model)) return;
    const firstAllowedModel = policyStatus?.allowedModels?.find(
      (allowed) => allowed.adapter === adapter,
    )?.model;
    if (!firstAllowedModel) return;
    model = firstAllowedModel;
    availableModels = [];
    modelsForProfile = "";
  }

  function reasoningEffortRank(effort: ReasoningEffort): number {
    return ["none", "minimal", "low", "medium", "high", "x_high", "max"].indexOf(
      effort,
    );
  }

  function isReasoningEffortAllowed(effort: ReasoningEffort): boolean {
    const maximum = policyStatus?.active ? policyStatus.maxReasoningEffort : null;
    return (
      maximum === null || reasoningEffortRank(effort) <= reasoningEffortRank(maximum)
    );
  }

  function applyPolicyStatus(status: PolicyStatus) {
    policyStatus = status;
    if (!status.active) return;
    if (status.fixedEndpoint !== null) {
      endpoint = status.fixedEndpoint;
      availableModels = [];
      modelsForProfile = "";
      connectionState = "idle";
      connectionMessage = "";
    }
    if (!status.allowCredentialManagement) {
      credentialRemovalPending = false;
      credentialSecret = "";
      newCredentialLabel = "";
      addCredentialDialog?.close();
    }
    selectAllowedModelForAdapter();
    if (
      status.maxOutputTokens !== null &&
      typeof outputTokenLimit === "number" &&
      outputTokenLimit > status.maxOutputTokens
    ) {
      outputTokenLimit = status.maxOutputTokens;
    }
    const maximumEffort = status.maxReasoningEffort;
    if (
      maximumEffort !== null &&
      reasoningEffort !== "provider_default" &&
      reasoningEffortRank(reasoningEffort) > reasoningEffortRank(maximumEffort)
    ) {
      reasoningEffort = maximumEffort;
    }
  }

  function formatError(error: LlmError): string {
    if (error.key === "provider_rejected") {
      return t("provider-rejected", { status: error.status });
    }
    return t(errorMessages[error.key]);
  }

  function formatTemplateError(error: TemplateError): string {
    return t(templateErrorMessages[error.key]);
  }

  async function refreshUpdateSettings() {
    try {
      const result = await commands.getUpdateSettings();
      if (result.status === "ok") updateSettings = result.data;
    } catch {
      updateMessage = "Update settings could not be loaded.";
    }
  }

  async function setUpdaterEnabled(enabled: boolean) {
    if (!updateSettings || updateBusy) return;
    updateBusy = true;
    updateMessage = "";
    try {
      const result = await commands.setUpdateEnabled(enabled);
      if (result.status === "error") {
        updateMessage = "Update settings could not be saved.";
      } else {
        updateSettings = result.data;
        if (!enabled) {
          updateCandidate = null;
          updateStatus = "idle";
          updateMessage = "";
        }
      }
    } catch {
      updateMessage = "Update settings could not be saved.";
    } finally {
      updateBusy = false;
    }
  }

  async function checkForUpdate() {
    if (
      !updateSettings?.available ||
      !updateSettings.enabled ||
      !updateSettings.policyAllowed ||
      updateBusy
    ) {
      return;
    }
    updateBusy = true;
    updateStatus = "checking";
    updateMessage = "";
    try {
      const result = await commands.checkForUpdate();
      if (result.status === "error") {
        updateStatus = "error";
        updateMessage = "The update check failed.";
      } else {
        updateCandidate = result.data;
        updateStatus = "idle";
        updateMessage = result.data
          ? "An update is available."
          : "Epikrise is up to date.";
      }
    } catch {
      updateStatus = "error";
      updateMessage = "The update check failed.";
    } finally {
      updateBusy = false;
    }
  }

  async function installConfirmedUpdate() {
    if (!updateCandidate || updateBusy) return;
    updateConfirmationDialog?.close();
    updateBusy = true;
    updateStatus = "installing";
    updateMessage = "Installing update...";
    updateDownloadedBytes = 0;
    updateTotalBytes = null;
    try {
      const result = await commands.installUpdate(true);
      if (result.status === "error") {
        updateStatus = "error";
        updateMessage = "The update could not be installed.";
      } else {
        updateCandidate = null;
        updateStatus = "idle";
        updateMessage = "Update installed. Restart Epikrise to complete the update.";
      }
    } catch {
      updateStatus = "error";
      updateMessage = "The update could not be installed.";
    } finally {
      updateBusy = false;
    }
  }

  function formatIngestError(error: IngestError): string {
    const messages: Partial<Record<IngestError["key"], string>> = {
      unsafe_url: "This URL resolves to a private or reserved network address.",
      invalid_url: "Enter an HTTP or HTTPS URL without embedded credentials.",
      url_response_too_large: "The URL response exceeds the 5 MB limit.",
      url_ingestion_disabled: "URL ingestion is disabled by administrator policy.",
      image_ocr_unavailable:
        "Local image OCR is unavailable and vision fallback is disabled.",
      image_ocr_failed: "Image OCR returned no text and vision fallback is disabled.",
      pdf_ocr_required: "This PDF contains scanned pages that could not be extracted.",
      pdf_vision_too_many_pages:
        "This PDF has more than 12 scanned pages. Split it or provide fewer pages.",
      pdf_vision_too_large: "The scanned pages exceed the 20 MB vision limit.",
    };
    const message = messages[error.key];
    return message
      ? t(message)
      : t("input-extraction-failed", { error: error.key.replaceAll("_", " ") });
  }

  function appendSourceBlock(block: ExtractedBlock) {
    sourceBlocks = [...sourceBlocks, block];
    ingestMessage =
      (block.images?.length ?? 0) > 0
        ? "Added image for provider vision analysis"
        : "Input extracted and added";
    ingestIsError = false;
    void invalidateOutputReview();
  }

  function removeSourceBlock(blockId: string) {
    sourceBlocks = sourceBlocks.filter((block) => block.id !== blockId);
    void invalidateOutputReview();
  }

  function sourceProvenanceLabel(block: ExtractedBlock): string {
    const provenance = block.provenance;
    if (typeof provenance === "string") {
      return t(provenance === "Clipboard" ? "Clipboard" : "Clinical text");
    }
    if ("File" in provenance && provenance.File) return provenance.File.name;
    if ("Url" in provenance && provenance.Url) return provenance.Url.address;
    return t("Clinical input");
  }

  function extractionMethodLabel(method: ExtractionMethod | undefined): string {
    const labels: Record<ExtractionMethod, string> = {
      manual: "Manual entry",
      parsed: "Parsed",
      ocr: "Local OCR",
      vision: "Model vision",
    };
    return t(labels[method ?? "parsed"]);
  }

  async function importFiles(files: FileList | File[]) {
    if (ingestBusy || !files.length) return;
    ingestBusy = true;
    ingestMessage = "Extracting input";
    ingestIsError = false;
    try {
      for (const file of Array.from(files)) {
        if (file.size > 20 * 1024 * 1024) {
          ingestMessage = t("input-file-too-large", { name: file.name });
          ingestIsError = true;
          continue;
        }
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        const result = file.type.startsWith("image/")
          ? await commands.extractImage(file.name, bytes, visionEnabled)
          : await commands.extractFile(file.name, bytes, visionEnabled);
        if (result.status === "error") {
          ingestMessage = t("file-extraction-failed", {
            name: file.name,
            error: formatIngestError(result.error),
          });
          ingestIsError = true;
          continue;
        }
        appendSourceBlock(result.data);
      }
    } catch {
      ingestMessage = "The selected input could not be read.";
      ingestIsError = true;
    } finally {
      ingestBusy = false;
    }
  }

  function handleFileSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = "";
    void importFiles(files);
  }

  function handleInputDrop(event: DragEvent) {
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (files?.length) void importFiles(files);
  }

  function handleInputPaste(event: ClipboardEvent) {
    const images = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (images.length) {
      event.preventDefault();
      void importFiles(images);
      return;
    }
    if (!desktopAvailable) return;
    event.preventDefault();
    const textarea = event.currentTarget as HTMLTextAreaElement;
    void pasteClipboardText(textarea, textarea.selectionStart, textarea.selectionEnd);
  }

  async function pasteClipboardText(
    textarea: HTMLTextAreaElement,
    selectionStart: number,
    selectionEnd: number,
  ) {
    try {
      const text = await readClipboardText();
      if (!text) return;
      textarea.setRangeText(text, selectionStart, selectionEnd, "end");
      prompt = textarea.value;
    } catch {
      ingestMessage = "The clipboard text could not be read.";
      ingestIsError = true;
    }
  }

  async function importUrl() {
    const address = sourceUrl.trim();
    if (!address || ingestBusy) return;
    ingestBusy = true;
    ingestMessage = "Fetching URL";
    ingestIsError = false;
    try {
      const result = await commands.extractUrl(address);
      if (result.status === "error") {
        ingestMessage = formatIngestError(result.error);
        ingestIsError = true;
      } else {
        appendSourceBlock(result.data);
        sourceUrl = "";
      }
    } catch {
      ingestMessage = "The URL could not be fetched.";
      ingestIsError = true;
    } finally {
      ingestBusy = false;
    }
  }

  async function confirmProviderEgress() {
    const pending = pendingEgressConfirmation;
    if (!pending || egressConfirmationBusy) return;
    egressConfirmationBusy = true;
    try {
      const result = await commands.authorizeProviderEgress(
        pending.caseId,
        pending.profile,
        true,
      );
      if (result.status === "error") {
        generationMessage = formatError(result.error);
        generationIsError = true;
        return;
      }
      if (!result.data) {
        generationMessage = "Provider authorization was not recorded.";
        generationIsError = true;
        return;
      }
      pendingEgressConfirmation = null;
      egressConfirmationDialog?.close();
      await generateDraft(pending.corrections || null);
    } catch {
      generationMessage = "Provider authorization could not be recorded.";
      generationIsError = true;
    } finally {
      egressConfirmationBusy = false;
    }
  }

  function initialTemplateValues(
    template: ClinicalTemplate,
  ): Record<string, string | boolean> {
    return Object.fromEntries(
      template.variables.map((variable) => [
        variable.name,
        variable.default?.value ?? (variable.kind === "boolean" ? false : ""),
      ]),
    );
  }

  function initialTemplateSectionStates(
    template: ClinicalTemplate,
  ): Record<string, boolean> {
    return Object.fromEntries(
      template.sections.map((section) => [section.id, section.enabled_by_default]),
    );
  }

  function activateTemplate(templateId: string) {
    const previousCaseId = caseSessionId;
    if (previousCaseId && desktopAvailable) {
      void commands
        .clearCaseSession(previousCaseId)
        .then((result) => {
          if (result.status === "error") {
            templateMessage = "The previous case could not be cleared.";
            templateIsError = true;
          }
        })
        .catch(() => {
          templateMessage = "The previous case could not be cleared.";
          templateIsError = true;
        });
    }
    activeTemplateId = templateId;
    const template = importedTemplates.find(
      (saved) => saved.metadata.id === templateId,
    );
    templateValues = template ? initialTemplateValues(template) : {};
    templateSectionStates = template ? initialTemplateSectionStates(template) : {};
    caseSessionId = null;
    caseSessionTemplateId = "";
    reviewedOutputCaseId = null;
    copyReviewMessage = "";
    prompt = "";
    sourceBlocks = [];
    draft = "";
    outputViolations = [];
  }

  async function discardCase() {
    if (isGenerating || isPreparingGeneration) return;
    const currentCaseId = caseSessionId;
    if (currentCaseId && desktopAvailable) {
      try {
        const result = await commands.clearCaseSession(currentCaseId);
        if (result.status === "error") {
          generationMessage = "The case could not be cleared.";
          generationIsError = true;
          return;
        }
      } catch {
        generationMessage = "The case could not be cleared.";
        generationIsError = true;
        return;
      }
    }
    caseSessionId = null;
    caseSessionTemplateId = "";
    reviewedOutputCaseId = null;
    copyReviewMessage = "";
    prompt = "";
    sourceBlocks = [];
    draft = "";
    outputViolations = [];
    generationMessage = "";
    generationIsError = false;
  }

  async function setOutputReview(event: Event) {
    const caseId = caseSessionId;
    if (!caseId || !draft || isGenerating) return;
    const reviewed = (event.currentTarget as HTMLInputElement).checked;
    copyReviewMessage = "";
    try {
      const result = await commands.setCaseReview(caseId, reviewed);
      if (result.status === "error") {
        reviewedOutputCaseId = null;
        generationMessage = "The review acknowledgement could not be saved.";
        generationIsError = true;
        return;
      }
      reviewedOutputCaseId = reviewed ? caseId : null;
      generationMessage = "";
      generationIsError = false;
    } catch {
      reviewedOutputCaseId = null;
      generationMessage = "The review acknowledgement could not be saved.";
      generationIsError = true;
    }
  }

  async function invalidateOutputReview() {
    const caseId = caseSessionId;
    reviewedOutputCaseId = null;
    if (!caseId || !draft || !desktopAvailable) return;

    isInvalidatingReview = true;
    try {
      const result = await commands.setCaseReview(caseId, false);
      if (result.status === "error" && caseSessionId === caseId) {
        generationMessage = "The review acknowledgement could not be reset.";
        generationIsError = true;
      }
    } catch {
      if (caseSessionId === caseId) {
        generationMessage = "The review acknowledgement could not be reset.";
        generationIsError = true;
      }
    } finally {
      isInvalidatingReview = false;
    }
  }

  function updateTemplateValue(name: string, value: string | boolean) {
    templateValues = { ...templateValues, [name]: value };
    void invalidateOutputReview();
  }

  function updateTemplateSection(id: string, enabled: boolean) {
    if (policyStatus?.active && !policyStatus.allowTemplateEdit) return;
    templateSectionStates = { ...templateSectionStates, [id]: enabled };
    void invalidateOutputReview();
  }

  async function copyReviewedOutput() {
    const caseId = caseSessionId;
    if (!caseId || !canCopyOutput) return;
    try {
      const result = await commands.copyCaseOutput(caseId);
      if (result.status === "error") {
        reviewedOutputCaseId = null;
        generationMessage = "Review the current output before copying.";
        generationIsError = true;
        return;
      }
      try {
        await writeClipboardHtml(renderOutputHtml(result.data), result.data);
        copyReviewMessage = "Reviewed formatted output copied";
      } catch {
        await writeClipboardText(result.data);
        copyReviewMessage = "Reviewed output copied as plain text";
      }
      generationMessage = "";
      generationIsError = false;
    } catch {
      generationMessage = "The output could not be copied.";
      generationIsError = true;
    }
  }

  function preventUnreviewedOutputCopy(event: ClipboardEvent) {
    if (canCopyOutput) return;
    const output = document.querySelector(".draft-output");
    const selection = window.getSelection();
    if (!output || !selection || selection.isCollapsed) return;

    for (let index = 0; index < selection.rangeCount; index += 1) {
      if (selection.getRangeAt(index).intersectsNode(output)) {
        event.preventDefault();
        copyReviewMessage = "Review the output before copying.";
        return;
      }
    }
  }

  function scrollToOutputLine(line: number) {
    const plainLine = document.getElementById(`draft-line-${line}`);
    if (plainLine) {
      plainLine.scrollIntoView({ behavior: "auto", block: "center" });
      return;
    }

    const formattedBlocks = Array.from(
      document.querySelectorAll<HTMLElement>(".rich-output [data-source-start-line]"),
    )
      .filter((block) => {
        const startLine = Number(block.dataset.sourceStartLine);
        const endLine = Number(block.dataset.sourceEndLine);
        return line >= startLine && line <= endLine;
      })
      .sort(
        (left, right) =>
          Number(left.dataset.sourceEndLine) -
          Number(left.dataset.sourceStartLine) -
          (Number(right.dataset.sourceEndLine) - Number(right.dataset.sourceStartLine)),
      );

    formattedBlocks[0]?.scrollIntoView({ behavior: "auto", block: "center" });
  }

  function templateVariableLabel(
    variable: ClinicalTemplate["variables"][number],
  ): string {
    const locale = activeTemplate?.metadata.locale ?? "";
    const language = locale.split("-")[0];
    return variable.labels[locale] ?? variable.labels[language] ?? variable.name;
  }

  function templateSectionLabel(section: ClinicalTemplate["sections"][number]): string {
    const locale = activeTemplate?.metadata.locale ?? "";
    const language = locale.split("-")[0];
    return section.labels[locale] ?? section.labels[language] ?? section.heading;
  }

  function orderedTemplateSections(template: ClinicalTemplate) {
    return [...template.sections].sort((left, right) => left.order - right.order);
  }

  function openProviderSettings() {
    providerSettingsDialog?.showModal();
  }

  function openGeneralSettings() {
    generalSettingsDialog?.showModal();
  }

  function openModelSettings() {
    modelSettingsDialog?.showModal();
  }

  function openTemplateSettings() {
    templateSettingsDialog?.showModal();
  }

  function openAddCredential() {
    if (policyStatus?.active && !policyStatus.allowCredentialManagement) return;
    newCredentialLabel = "";
    credentialSecret = "";
    credentialMessage = "";
    addCredentialDialog?.showModal();
  }

  function changeProvider(value: string) {
    const previousCredentialId = credentialId;
    adapter = value as ProviderAdapter;
    credentialRemovalPending = false;
    const matchingCredentials = providerCredentials.filter(
      (credential) => credential.adapter === adapter,
    );
    credentialId = matchingCredentials.some(
      (credential) => credential.id === previousCredentialId,
    )
      ? previousCredentialId
      : matchingCredentials.length === 1
        ? matchingCredentials[0].id
        : "";
    availableModels = [];
    modelsForProfile = "";
    connectionState = "idle";
    connectionMessage = "";
  }

  function handleDialogKeydown(event: KeyboardEvent) {
    const topDialog = [
      addCredentialDialog,
      templateEditorDialog,
      providerSettingsDialog,
      generalSettingsDialog,
      modelSettingsDialog,
      templateSettingsDialog,
    ].find((dialog) => dialog?.open);
    if (!topDialog) return;

    if (event.key === "Tab") {
      const focusable = Array.from(
        topDialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      if (
        !topDialog.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    if (event.key !== "Escape") return;
    const target = event.target;
    if (
      !(target instanceof HTMLElement) ||
      !topDialog.contains(target) ||
      target === templateFileInput
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    topDialog.close();
  }

  function openTemplateEditor() {
    if (!activeTemplate) return;
    const snapshot = structuredClone($state.snapshot(activeTemplate));
    templateEditDraft = {
      ...snapshot,
      sections: orderedTemplateSections(snapshot).map((section, order) => ({
        ...section,
        order,
      })),
    };
    templatePreview = "";
    templatePreviewMessage = "Rendering preview...";
    templatePreviewIsError = false;
    templateEditorDialog?.showModal();
    queueTemplatePreview();
  }

  function updateTemplateMetadata(
    field: "name" | "description" | "locale" | "version" | "author",
    value: string,
  ) {
    if (!templateEditDraft) return;
    templateEditDraft = {
      ...templateEditDraft,
      metadata: { ...templateEditDraft.metadata, [field]: value },
    };
    queueTemplatePreview();
  }

  function updateTemplatePrompt(value: string) {
    if (!templateEditDraft) return;
    templateEditDraft = { ...templateEditDraft, system_prompt: value };
    queueTemplatePreview();
  }

  function updateTemplateOutputRules(
    updates: Partial<NonNullable<ClinicalTemplate["output_rules"]>>,
  ) {
    if (!templateEditDraft) return;
    templateEditDraft = {
      ...templateEditDraft,
      output_rules: { ...templateEditDraft.output_rules, ...updates },
    };
  }

  function updateTemplateOutputTerms(
    field: "forbidden_terms" | "required_terms",
    value: string,
  ) {
    updateTemplateOutputRules({
      [field]: value
        .split(/\r?\n/)
        .map((term) => term.trim())
        .filter(Boolean),
    });
  }

  function setTemplateEditorSections(sections: ClinicalTemplate["sections"]) {
    if (!templateEditDraft) return;
    templateEditDraft = {
      ...templateEditDraft,
      sections: sections.map((section, order) => ({ ...section, order })),
    };
    queueTemplatePreview();
  }

  function updateTemplateEditorSection(
    index: number,
    updates: Partial<ClinicalTemplate["sections"][number]>,
  ) {
    if (!templateEditDraft) return;
    setTemplateEditorSections(
      templateEditDraft.sections.map((section, sectionIndex) =>
        sectionIndex === index ? { ...section, ...updates } : section,
      ),
    );
  }

  function templateSectionEditorLabel(
    section: ClinicalTemplate["sections"][number],
  ): string {
    const locale = templateEditDraft?.metadata.locale ?? "";
    const language = locale.split("-")[0];
    return section.labels[locale] ?? section.labels[language] ?? section.heading;
  }

  function updateTemplateEditorSectionLabel(index: number, value: string) {
    const locale = templateEditDraft?.metadata.locale.trim();
    const section = templateEditDraft?.sections[index];
    if (!locale || !section) return;
    updateTemplateEditorSection(index, {
      labels: { ...section.labels, [locale]: value },
    });
  }

  function addTemplateEditorSection() {
    if (!templateEditDraft) return;
    const sections = templateEditDraft.sections;
    const sectionIds = new Set(sections.map((section) => section.id));
    let id = "new_section";
    let suffix = 2;
    while (sectionIds.has(id)) {
      id = `new_section_${suffix}`;
      suffix += 1;
    }
    const heading = "New section";
    const locale = templateEditDraft.metadata.locale.trim();
    setTemplateEditorSections([
      ...sections,
      {
        id,
        heading,
        order: sections.length,
        enabled_by_default: true,
        labels: locale ? { [locale]: heading } : {},
      },
    ]);
  }

  function deleteTemplateEditorSection(index: number) {
    if (!templateEditDraft) return;
    setTemplateEditorSections(
      templateEditDraft.sections.filter((_, sectionIndex) => sectionIndex !== index),
    );
  }

  function moveTemplateEditorSection(index: number, direction: -1 | 1) {
    if (!templateEditDraft) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= templateEditDraft.sections.length) return;
    const sections = [...templateEditDraft.sections];
    [sections[index], sections[targetIndex]] = [sections[targetIndex], sections[index]];
    setTemplateEditorSections(sections);
  }

  function queueTemplatePreview() {
    if (templatePreviewTimer) clearTimeout(templatePreviewTimer);
    templatePreviewTimer = setTimeout(() => void renderTemplatePreview(), 180);
  }

  async function renderTemplatePreview() {
    const template = templateEditDraft;
    if (!template || !desktopAvailable) return;
    const revision = ++templatePreviewRevision;
    const values = Object.fromEntries(
      template.variables.map((variable) => [
        variable.name,
        templateValues[variable.name] ??
          variable.default?.value ??
          (variable.kind === "boolean" ? false : ""),
      ]),
    );
    const enabledSections = template.sections
      .filter((section) => section.enabled_by_default)
      .map((section) => section.id);

    try {
      const result = await commands.renderTemplateSystemPrompt(
        template,
        values,
        enabledSections,
      );
      if (revision !== templatePreviewRevision) return;
      if (result.status === "error") {
        templatePreview = "";
        templatePreviewMessage = formatTemplateError(result.error);
        templatePreviewIsError = true;
        return;
      }
      templatePreview = result.data;
      templatePreviewMessage = "Preview updates as you edit.";
      templatePreviewIsError = false;
    } catch {
      if (revision === templatePreviewRevision) {
        templatePreview = "";
        templatePreviewMessage = "The template preview could not be rendered.";
        templatePreviewIsError = true;
      }
    }
  }

  async function saveEditedTemplate() {
    const template = templateEditDraft;
    if (!template || templateSaveBusy) return;
    templateSaveBusy = true;
    templateMessage = "";
    templateIsError = false;
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(template));
      const validated = await commands.validateTemplate(Array.from(bytes));
      if (validated.status === "error") {
        templateMessage = formatTemplateError(validated.error);
        templateIsError = true;
        return;
      }
      const updatedTemplates = importedTemplates.map((saved) =>
        saved.metadata.id === validated.data.metadata.id ? validated.data : saved,
      );
      const result = await commands.saveTemplates(updatedTemplates);
      if (result.status === "error") {
        templateMessage = formatTemplateError(result.error);
        templateIsError = true;
        return;
      }
      importedTemplates = updatedTemplates;
      activateTemplate(validated.data.metadata.id);
      templateMessage = "Template saved";
      templateEditorDialog?.close();
      templateEditDraft = null;
    } catch {
      templateMessage = "The template could not be saved.";
      templateIsError = true;
    } finally {
      templateSaveBusy = false;
    }
  }

  function sectionsForRendering(template: ClinicalTemplate): string[] {
    return orderedTemplateSections(template)
      .filter((section) => templateSectionStates[section.id])
      .map((section) => section.id);
  }

  function valuesForRendering(
    template: ClinicalTemplate,
  ): Record<string, string | boolean> {
    return Object.fromEntries(
      template.variables
        .filter(
          (variable) =>
            variable.kind !== "select" || templateValues[variable.name] !== "",
        )
        .map((variable) => [variable.name, templateValues[variable.name]]),
    );
  }

  async function restoreTemplates() {
    const result = await commands.loadTemplates();
    if (result.status === "error") throw new Error("Template library unavailable");
    importedTemplates = result.data;
    activateTemplate(result.data[0]?.metadata.id ?? "");
  }

  async function importTemplate(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (policyStatus?.active && !policyStatus.allowTemplateImport) return;
    if (!file) return;

    pendingTemplate = null;
    templateMessage = "";
    templateIsError = false;
    if (!desktopAvailable) {
      templateMessage = "Template import is available in the desktop app.";
      templateIsError = true;
      return;
    }
    if (!file.name.toLowerCase().endsWith(".epitpl")) {
      templateMessage = "Choose a .epitpl file.";
      templateIsError = true;
      return;
    }
    if (file.size > maxTemplateBytes) {
      templateMessage = "Template files must be 1 MB or smaller.";
      templateIsError = true;
      return;
    }

    templateBusy = true;
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const result = await commands.validateTemplate(bytes);
      if (result.status === "error") {
        templateMessage = formatTemplateError(result.error);
        templateIsError = true;
      } else {
        pendingTemplate = result.data;
      }
    } catch {
      templateMessage = "The selected template could not be read.";
      templateIsError = true;
    } finally {
      templateBusy = false;
    }
  }

  async function createGenericStarter() {
    if (templateBusy) return;
    templateBusy = true;
    templateMessage = "";
    templateIsError = false;
    const starter: ClinicalTemplate = {
      schema_version: 1,
      metadata: {
        id: "generic-starter",
        name: "Generic clinical summary",
        description: "A minimal starting point without institutional rules.",
        locale: "de-CH",
        specialty_tags: [],
        version: "1.0.0",
        author: "Epikrise",
      },
      system_prompt:
        "Create a concise, structured clinical summary in German from the supplied anonymized material. Use only documented facts, preserve uncertainty, and do not invent diagnoses, findings, or recommendations. Organize the result under the enabled sections.",
      variables: [],
      sections: [
        {
          id: "summary",
          heading: "Clinical summary",
          order: 0,
          enabled_by_default: true,
          labels: { "de-CH": "Klinische Zusammenfassung" },
        },
      ],
      output_rules: {
        forbidden_terms: [],
        required_terms: [],
        forbid_code_fences: true,
        forbid_leading_whitespace: true,
        forbid_bullet_characters: false,
        forbid_parenthesized_dates: false,
      },
    };

    try {
      const bytes = new TextEncoder().encode(JSON.stringify(starter));
      const result = await commands.validateTemplate(Array.from(bytes));
      if (result.status === "error") {
        templateMessage = formatTemplateError(result.error);
        templateIsError = true;
      } else {
        pendingTemplate = result.data;
      }
    } catch {
      templateMessage = "The starter template could not be prepared.";
      templateIsError = true;
    } finally {
      templateBusy = false;
    }
  }

  async function savePendingTemplate() {
    const template = pendingTemplate;
    if (!template || templateBusy) return;

    templateBusy = true;
    try {
      const updatedTemplates = [
        ...importedTemplates.filter(
          (saved) => saved.metadata.id !== template.metadata.id,
        ),
        template,
      ];
      const result = await commands.saveTemplates(updatedTemplates);
      if (result.status === "error") {
        templateMessage = formatTemplateError(result.error);
        templateIsError = true;
        return;
      }
      importedTemplates = updatedTemplates;
      activateTemplate(template.metadata.id);
      pendingTemplate = null;
      templateMessage = "Template saved";
      templateIsError = false;
    } catch {
      templateMessage = "The template could not be saved.";
      templateIsError = true;
    } finally {
      templateBusy = false;
    }
  }

  async function exportActiveTemplate() {
    if (!activeTemplate) return;
    try {
      const result = await commands.exportTemplate(activeTemplate);
      if (result.status === "error") {
        templateMessage = formatTemplateError(result.error);
        templateIsError = true;
        return;
      }
      if (!result.data) return;
      templateMessage = "Template exported";
      templateIsError = false;
    } catch {
      templateMessage = "The template could not be exported.";
      templateIsError = true;
    }
  }

  onMount(() => {
    let storedLocale: string | null = null;
    try {
      storedLocale = localStorage.getItem(localePreferenceKey);
    } catch {
      // Storage can be unavailable in restricted webviews.
    }
    const detectedLocale = navigator.languages[0] ?? navigator.language;
    const locale = initializeLocale(storedLocale, detectedLocale);
    void tick().then(() => {
      uiLocale = locale;
      document.documentElement.lang = locale;
    });
    desktopAvailable = isTauri();
    if (!desktopAvailable) return;
    void commands.getPolicyStatus().then((status) => {
      if (status.status === "ok") applyPolicyStatus(status.data);
    });
    void refreshUpdateSettings();
    void restoreTemplates()
      .catch(() => {
        templateMessage = "Saved templates could not be loaded.";
        templateIsError = true;
      })
      .finally(() => {
        templateLibraryReady = true;
      });

    let disposed = false;
    let unlisten: (() => void)[] = [];
    void Promise.all([
      events.generationDelta.listen(({ payload }) => {
        if (payload.requestId === activeRequestId) draft += payload.content;
      }),
      events.generationDone.listen(({ payload }) => {
        if (payload.requestId !== activeRequestId) return;
        draft = payload.content;
        outputViolations = payload.violations;
        reviewedOutputCaseId = null;
        prompt = "";
        sourceBlocks = [];
        activeRequestId = null;
        generationMessage = "Draft ready";
        generationIsError = false;
      }),
      events.generationError.listen(({ payload }) => {
        if (payload.requestId !== activeRequestId) return;
        activeRequestId = null;
        generationMessage = formatError(payload.error);
        generationIsError = true;
      }),
      events.updaterProgress.listen(({ payload }) => {
        updateDownloadedBytes = payload.downloadedBytes ?? 0;
        updateTotalBytes = payload.totalBytes;
        if (payload.finished) {
          updateMessage = "Update installed. Restart Epikrise to complete the update.";
        }
      }),
    ])
      .then((listeners) => {
        if (disposed) listeners.forEach((stop) => stop());
        else unlisten = listeners;
      })
      .catch(() => {
        if (!disposed) {
          generationMessage = "Generation events are unavailable.";
          generationIsError = true;
        }
      });

    void loadProviderCredentials();

    const blockContextMenu = (event: MouseEvent) => event.preventDefault();
    if (!import.meta.env.DEV) {
      document.addEventListener("contextmenu", blockContextMenu);
    }

    return () => {
      disposed = true;
      unlisten.forEach((stop) => stop());
      document.removeEventListener("contextmenu", blockContextMenu);
    };
  });

  async function testProvider() {
    if (!desktopAvailable) {
      connectionState = "error";
      connectionMessage = "Desktop runtime unavailable.";
      return;
    }

    connectionState = "checking";
    connectionMessage = "";
    if (policyStatus === null) {
      try {
        const result = await commands.getPolicyStatus();
        if (result.status === "error") {
          connectionState = "error";
          connectionMessage = formatError(result.error);
          return;
        }
        applyPolicyStatus(result.data);
      } catch {
        connectionState = "error";
        connectionMessage = "The connection check failed.";
        return;
      }
    }
    selectAllowedModelForAdapter();
    if (!(await loadProviderCredentials())) {
      connectionState = "error";
      connectionMessage =
        credentialMessage || "Saved provider credentials could not be loaded.";
      return;
    }

    const requestedProfileKey = modelProfileKey;
    try {
      const result = await commands.testProvider(createProfile());
      if (requestedProfileKey !== modelProfileKey) return;
      if (result.status === "error") {
        connectionState = "error";
        connectionMessage = formatError(result.error);
        return;
      }
      availableModels = result.data;
      modelsForProfile = requestedProfileKey;
      if (result.data.length > 0 && !result.data.includes(model)) {
        model = result.data[0];
      }
      connectionState = "ready";
      connectionMessage = result.data.length
        ? "provider-models-available"
        : "connected-no-models-returned";
    } catch {
      if (requestedProfileKey === modelProfileKey) {
        connectionState = "error";
        connectionMessage = "The connection check failed.";
      }
    }
  }

  async function loadProviderCredentials(preferredId = ""): Promise<boolean> {
    if (!desktopAvailable) return false;
    try {
      const result = await commands.listProviderCredentials();
      if (result.status === "error") {
        credentialMessage = formatError(result.error);
        credentialIsError = true;
        return false;
      }
      providerCredentials = result.data;
      const matchingCredentials = result.data.filter(
        (credential) => credential.adapter === adapter,
      );
      const requestedId = preferredId || credentialId;
      credentialId = matchingCredentials.some(
        (credential) => credential.id === requestedId,
      )
        ? requestedId
        : matchingCredentials.length === 1
          ? matchingCredentials[0].id
          : "";
      return true;
    } catch {
      credentialMessage = "Saved provider credentials could not be loaded.";
      credentialIsError = true;
      return false;
    }
  }

  async function saveProviderCredential() {
    const label = newCredentialLabel.trim();
    if (policyStatus?.active && !policyStatus.allowCredentialManagement) {
      credentialSecret = "";
      credentialMessage = "Credential changes are restricted by administrator policy.";
      credentialIsError = true;
      return;
    }
    if (!desktopAvailable || !label || !credentialSecret.trim()) {
      credentialMessage = !desktopAvailable
        ? "Credentials can only be added in the desktop app."
        : "Enter a label and API key.";
      credentialIsError = true;
      credentialSecret = "";
      return;
    }

    credentialBusy = true;
    credentialMessage = "";
    try {
      const result = await commands.setProviderCredential(
        adapter,
        label,
        credentialSecret,
      );
      if (result.status === "error") {
        credentialMessage = formatError(result.error);
        credentialIsError = true;
      } else {
        credentialId = result.data.id;
        addCredentialDialog?.close();
        const loaded = await loadProviderCredentials(result.data.id);
        credentialMessage = loaded
          ? "Provider credential added to the OS keychain."
          : "Credential saved, but the list could not be refreshed.";
        credentialIsError = !loaded;
      }
    } catch {
      credentialMessage = "The API key could not be saved.";
      credentialIsError = true;
    } finally {
      credentialSecret = "";
      credentialBusy = false;
    }
  }

  async function deleteProviderCredential() {
    const keychainId = selectedCredential?.id ?? "";
    if (policyStatus?.active && !policyStatus.allowCredentialManagement) return;
    if (!desktopAvailable || !keychainId || credentialBusy) return;

    credentialBusy = true;
    credentialMessage = "";
    try {
      const result = await commands.deleteProviderCredential(keychainId);
      if (result.status === "error") {
        credentialMessage = formatError(result.error);
        credentialIsError = true;
      } else {
        credentialRemovalPending = false;
        const loaded = await loadProviderCredentials();
        credentialMessage = loaded
          ? "Provider credential removed from the OS keychain."
          : "Credential removed, but the list could not be refreshed.";
        credentialIsError = !loaded;
      }
    } catch {
      credentialMessage = "The API key could not be removed.";
      credentialIsError = true;
    } finally {
      credentialBusy = false;
    }
  }

  async function refreshModels() {
    if (modelListLoading) return;
    if (!desktopAvailable) {
      modelListMessage = "Desktop runtime unavailable.";
      modelListIsError = true;
      return;
    }

    const requestedProfileKey = modelProfileKey;
    modelListLoading = true;
    modelListMessage = "";
    modelListIsError = false;
    try {
      const result = await commands.listModels(createProfile());
      if (requestedProfileKey !== modelProfileKey) return;
      if (result.status === "error") {
        modelListMessage = formatError(result.error);
        modelListIsError = true;
        return;
      }

      availableModels = result.data;
      modelsForProfile = requestedProfileKey;
      if (result.data.length > 0 && !result.data.includes(model)) {
        model = result.data[0];
      }
      modelListMessage =
        result.data.length === 0 ? "No models were returned by this provider." : "";
    } catch {
      if (requestedProfileKey === modelProfileKey) {
        modelListMessage = "The model list could not be loaded.";
        modelListIsError = true;
      }
    } finally {
      modelListLoading = false;
    }
  }

  async function generateDraft(correctionInstructions: string | null = null) {
    const corrections = correctionInstructions?.trim() ?? "";
    const source = corrections ? "" : prompt.trim();
    if (
      (!source && sourceBlocks.length === 0 && !corrections) ||
      isGenerating ||
      isPreparingGeneration
    )
      return;
    if (generationConfigurationIssue) {
      generationMessage = generationConfigurationIssue;
      generationIsError = true;
      return;
    }
    if (!activeTemplate) {
      generationMessage = "Import and select a template before generating.";
      generationIsError = true;
      return;
    }
    if (!desktopAvailable) {
      generationMessage = "Desktop runtime unavailable.";
      generationIsError = true;
      return;
    }

    isPreparingGeneration = true;
    copyReviewMessage = "";
    generationMessage = "preparing-template";
    generationIsError = false;
    let systemPrompt: string;
    try {
      const rendered = await commands.renderTemplateSystemPrompt(
        activeTemplate,
        valuesForRendering(activeTemplate),
        sectionsForRendering(activeTemplate),
      );
      if (rendered.status === "error") {
        generationMessage = formatTemplateError(rendered.error);
        generationIsError = true;
        return;
      }
      systemPrompt = rendered.data;
      let currentCaseId = caseSessionId;
      if (!currentCaseId || caseSessionTemplateId !== activeTemplate.metadata.id) {
        const created = await commands.createCaseSession(
          crypto.randomUUID(),
          activeTemplate.metadata.id,
        );
        if (created.status === "error") {
          generationMessage = formatError(created.error);
          generationIsError = true;
          return;
        }
        currentCaseId = created.data.id;
        caseSessionId = currentCaseId;
        caseSessionTemplateId = activeTemplate.metadata.id;
      }
    } catch {
      generationMessage = "The active template could not be rendered.";
      generationIsError = true;
      return;
    } finally {
      isPreparingGeneration = false;
    }

    const requestId = crypto.randomUUID();
    const currentCaseId = caseSessionId;
    if (!currentCaseId) {
      generationMessage = "The case session could not be started.";
      generationIsError = true;
      return;
    }
    const profile = createProfile();
    try {
      const authorization = await commands.authorizeProviderEgress(
        currentCaseId,
        profile,
        false,
      );
      if (authorization.status === "error") {
        generationMessage = formatError(authorization.error);
        generationIsError = true;
        return;
      }
      if (!authorization.data) {
        pendingEgressConfirmation = { caseId: currentCaseId, profile, corrections };
        egressConfirmationDialog?.showModal();
        return;
      }
    } catch {
      generationMessage = "Provider authorization could not be checked.";
      generationIsError = true;
      return;
    }
    activeRequestId = requestId;
    generationMessage = "Generating";
    generationIsError = false;
    draft = "";
    outputViolations = [];
    reviewedOutputCaseId = null;
    try {
      const result = await commands.generate({
        requestId,
        caseId: currentCaseId,
        profile,
        systemPrompt,
        outputRules: activeTemplate.output_rules ?? {},
        templateValues: valuesForRendering(activeTemplate),
        inputs: [
          ...sourceBlocks,
          ...(source
            ? [
                {
                  id: crypto.randomUUID(),
                  round: 0,
                  provenance: "RawText" as const,
                  content: source,
                  images: [],
                },
              ]
            : []),
        ],
        corrections: corrections || null,
      });
      if (result.status === "error" && activeRequestId === requestId) {
        activeRequestId = null;
        generationMessage = formatError(result.error);
        generationIsError = true;
      }
    } catch {
      if (activeRequestId === requestId) {
        activeRequestId = null;
        generationMessage = "The generation request failed.";
        generationIsError = true;
      }
    }
  }

  async function cancelGeneration() {
    const requestId = activeRequestId;
    if (!requestId) return;
    try {
      await commands.cancelGeneration(requestId);
    } catch {
      generationMessage = "The request could not be cancelled.";
      generationIsError = true;
    }
  }

  async function regenerateWithCorrections() {
    const corrections = outputViolations
      .map((violation) => {
        const term = violation.term?.replace(/[\r\n]+/g, " ").slice(0, 160);
        return `Line ${violation.line}: ${outputViolationMessages[violation.kind]}${term ? ` (${term})` : ""}`;
      })
      .join("\n");
    if (!corrections) return;
    await generateDraft(
      `Revise the existing output to resolve these checks. Preserve documented facts and uncertainty.\n${corrections}`,
    );
  }
</script>

<svelte:head>
  <title>{t("Epikrise | Draft workspace")}</title>
  <meta name="theme-color" content="#f2f5f1" />
</svelte:head>

<svelte:window oncopy={preventUnreviewedOutputCopy} onkeydown={handleDialogKeydown} />

<div class="app-shell">
  <aside class="provider-rail" aria-labelledby="controls-heading">
    <a class="brand" href={resolve("/")} aria-label={t("Epikrise home")}>
      <span class="brand-mark" aria-hidden="true">E</span>
      <span class="brand-name">Epikrise</span>
    </a>

    <dialog
      class="settings-dialog"
      bind:this={providerSettingsDialog}
      aria-labelledby="provider-settings-title"
      onkeydown={handleDialogKeydown}
      oncancel={(event) => {
        event.preventDefault();
        providerSettingsDialog?.close();
      }}
    >
      <section class="provider-settings" aria-labelledby="provider-settings-title">
        <p class="eyebrow">{t("Workspace")}</p>
        <div class="dialog-heading">
          <div>
            <h1 id="provider-settings-title">{t("Provider settings")}</h1>
            <p>{t("Choose a provider endpoint and saved keychain credential.")}</p>
          </div>
          <button
            class="dialog-close"
            type="button"
            aria-label={t("Close provider settings")}
            onclick={() => providerSettingsDialog?.close()}
          >
            ×
          </button>
        </div>

        <label for="active-adapter">
          {t("Provider")}
          {#if policyStatus?.active && (policyStatus.localOnly || policyStatus.allowedProviders !== null)}
            <span class="policy-badge">{t("Administrator managed")}</span>
          {/if}
        </label>
        <select
          id="active-adapter"
          value={adapter}
          disabled={isGenerating || isPreparingGeneration}
          onchange={(event) => changeProvider(event.currentTarget.value)}
        >
          <option value="ollama" disabled={!isProviderAllowed("ollama")}>Ollama</option>
          <option value="open_ai" disabled={!isProviderAllowed("open_ai")}
            >OpenAI</option
          >
          <option value="anthropic" disabled={!isProviderAllowed("anthropic")}
            >Anthropic</option
          >
          <option value="gemini" disabled={!isProviderAllowed("gemini")}>Gemini</option>
          <option
            value="open_ai_compatible"
            disabled={!isProviderAllowed("open_ai_compatible")}
            >OpenAI compatible</option
          >
          <option value="open_router" disabled={!isProviderAllowed("open_router")}
            >OpenRouter</option
          >
          <option value="xai" disabled={!isProviderAllowed("xai")}>xAI</option>
          <option value="groq" disabled={!isProviderAllowed("groq")}>Groq</option>
        </select>

        <label for="endpoint">
          {t("Endpoint")}
          {#if policyStatus?.active && (policyStatus.localOnly || policyStatus.fixedEndpoint !== null)}
            <span class="policy-badge">{t("Administrator managed")}</span>
          {/if}
        </label>
        <input
          id="endpoint"
          bind:value={endpoint}
          autocomplete="url"
          spellcheck="false"
          disabled={policyStatus?.active && policyStatus.fixedEndpoint !== null}
          placeholder={adapter === "ollama"
            ? "http://localhost:11434"
            : t("Provider default")}
        />
        {#if policyStatus?.active && policyStatus.localOnly}
          <p class="setting-hint">
            {t("Only localhost and loopback endpoints are allowed.")}
          </p>
        {/if}

        <label for="provider-credential">
          {t("Provider credential")}
          {#if policyStatus?.active && !policyStatus.allowCredentialManagement}
            <span class="policy-badge">{t("Administrator managed")}</span>
          {/if}
        </label>
        <select
          id="provider-credential"
          bind:value={credentialId}
          onchange={() => (credentialRemovalPending = false)}
          disabled={credentialBusy}
        >
          <option value="">{t("None")}</option>
          {#each credentialsForProvider as credential (credential.id)}
            <option value={credential.id}>{credential.label}</option>
          {/each}
        </select>
        <div class="credential-actions">
          <button
            class="connection-button"
            type="button"
            onclick={openAddCredential}
            disabled={!desktopAvailable ||
              credentialBusy ||
              isGenerating ||
              (policyStatus?.active && !policyStatus.allowCredentialManagement)}
          >
            {t("Add provider credential")}
          </button>
          <button
            class="credential-remove-button"
            type="button"
            onclick={() => (credentialRemovalPending = true)}
            disabled={!selectedCredential ||
              credentialBusy ||
              (policyStatus?.active && !policyStatus.allowCredentialManagement)}
          >
            {t("Remove provider credential")}
          </button>
        </div>
        {#if credentialRemovalPending && selectedCredential}
          <div
            class="credential-confirmation"
            role="group"
            aria-label={t("Confirm credential removal")}
          >
            <p>
              {t("Remove selected credential from the OS keychain", {
                label: selectedCredential.label,
              })}
            </p>
            <div>
              <button
                class="credential-remove-button"
                type="button"
                onclick={deleteProviderCredential}
                disabled={credentialBusy ||
                  (policyStatus?.active && !policyStatus.allowCredentialManagement)}
              >
                {credentialBusy ? t("Removing...") : t("Confirm removal")}
              </button>
              <button
                class="credential-cancel-button"
                type="button"
                onclick={() => (credentialRemovalPending = false)}
                disabled={credentialBusy}
              >
                {t("Cancel")}
              </button>
            </div>
          </div>
        {/if}
        {#if credentialMessage}
          <p class="model-list-message" class:error={credentialIsError} role="status">
            {t(credentialMessage)}
          </p>
        {/if}

        <button
          class="connection-button"
          type="button"
          onclick={testProvider}
          disabled={connectionState === "checking"}
        >
          {connectionState === "checking" ? t("Checking...") : t("Check connection")}
        </button>

        {#if connectionMessage}
          <p
            class="connection-message"
            class:error={connectionState === "error"}
            role="status"
          >
            <span class="status-dot" aria-hidden="true"></span>
            {t(connectionMessage, { count: availableModels.length })}
          </p>
        {/if}
      </section>
    </dialog>

    <dialog
      class="settings-dialog general-settings-dialog"
      bind:this={generalSettingsDialog}
      aria-labelledby="general-settings-title"
      onkeydown={handleDialogKeydown}
      oncancel={(event) => {
        event.preventDefault();
        generalSettingsDialog?.close();
      }}
    >
      <section class="provider-settings" aria-labelledby="general-settings-title">
        <p class="eyebrow">{t("Workspace")}</p>
        <div class="dialog-heading">
          <div>
            <h2 id="general-settings-title">{t("General settings")}</h2>
          </div>
          <button
            class="dialog-close"
            type="button"
            aria-label={t("Close general settings")}
            onclick={() => generalSettingsDialog?.close()}
          >
            ×
          </button>
        </div>

        <label for="interface-language">{t("language")}</label>
        <select
          id="interface-language"
          value={uiLocale}
          onchange={(event) => changeUiLocale(event.currentTarget.value)}
        >
          {#each supportedLocales as locale (locale)}
            <option value={locale}>
              {t(locale === "de-CH" ? "language-de-ch" : "language-en")}
            </option>
          {/each}
          {#if import.meta.env.DEV}
            <option value={pseudoLocale}>{t("language-pseudo")}</option>
          {/if}
        </select>
        <fieldset class="update-settings">
          <legend>{t("Software updates")}</legend>
          <label class="update-opt-in">
            <input
              type="checkbox"
              checked={updateSettings?.enabled ?? false}
              disabled={!updateSettings?.available ||
                !updateSettings.policyAllowed ||
                updateBusy}
              onchange={(event) => setUpdaterEnabled(event.currentTarget.checked)}
            />
            <span>{t("Enable direct-release updates")}</span>
          </label>
          {#if updateSettings === null}
            <p role="status">{t("Update settings are loading...")}</p>
          {:else if !updateSettings.available}
            <p role="status">{t("Updates are unavailable for this build.")}</p>
          {:else if !updateSettings.policyAllowed}
            <p role="status">{t("Updates are disabled by administrator policy.")}</p>
          {:else}
            <p>{t("Update checks contact GitHub Releases only when requested.")}</p>
            <button
              class="connection-button"
              type="button"
              disabled={!updateSettings.enabled || updateBusy}
              onclick={checkForUpdate}
            >
              {updateStatus === "checking" ? t("Checking...") : t("Check for updates")}
            </button>
          {/if}
          {#if updateMessage}
            <p class="model-list-message" role="status" aria-live="polite">
              {t(updateMessage)}
            </p>
          {/if}
          {#if updateStatus === "installing"}
            <progress
              max="100"
              value={updateTotalBytes && updateTotalBytes > 0
                ? Math.min(100, (updateDownloadedBytes / updateTotalBytes) * 100)
                : undefined}
              aria-label={t("Update download progress")}
            ></progress>
          {/if}
          {#if updateCandidate}
            <div class="update-candidate">
              <p><strong>{t("Update version")}: {updateCandidate.version}</strong></p>
              {#if updateCandidate.notes}
                <p>{updateCandidate.notes}</p>
              {/if}
              <button
                class="connection-button"
                type="button"
                disabled={updateBusy ||
                  Boolean(caseSessionId) ||
                  Boolean(activeRequestId)}
                onclick={() => updateConfirmationDialog?.showModal()}
              >
                {t("Install update")}
              </button>
            </div>
          {/if}
        </fieldset>
      </section>
    </dialog>

    <dialog
      class="settings-dialog"
      bind:this={updateConfirmationDialog}
      aria-labelledby="update-confirmation-title"
      onkeydown={handleDialogKeydown}
      oncancel={(event) => {
        event.preventDefault();
        updateConfirmationDialog?.close();
      }}
    >
      <section class="provider-settings" aria-labelledby="update-confirmation-title">
        <p class="eyebrow">{t("Software updates")}</p>
        <div class="dialog-heading">
          <div>
            <h2 id="update-confirmation-title">{t("Install this update?")}</h2>
            {#if updateCandidate}
              <p>{t("Update version")}: {updateCandidate.version}</p>
            {/if}
          </div>
          <button
            class="dialog-close"
            type="button"
            aria-label={t("Close update confirmation")}
            onclick={() => updateConfirmationDialog?.close()}
          >
            ×
          </button>
        </div>
        <p>{t("Epikrise will close while the update is installed.")}</p>
        <div class="settings-actions">
          <button
            class="connection-button"
            type="button"
            onclick={() => updateConfirmationDialog?.close()}
          >
            {t("Cancel")}
          </button>
          <button
            class="connection-button"
            type="button"
            disabled={updateBusy || Boolean(caseSessionId) || Boolean(activeRequestId)}
            onclick={installConfirmedUpdate}
          >
            {t("Confirm install")}
          </button>
        </div>
      </section>
    </dialog>

    <dialog
      class="settings-dialog"
      bind:this={addCredentialDialog}
      aria-labelledby="add-credential-title"
      onkeydown={handleDialogKeydown}
      oncancel={(event) => {
        event.preventDefault();
        addCredentialDialog?.close();
      }}
    >
      <form
        class="provider-settings"
        onsubmit={(event) => {
          event.preventDefault();
          void saveProviderCredential();
        }}
      >
        <p class="eyebrow">{providerNames[adapter]}</p>
        <div class="dialog-heading">
          <div>
            <h2 id="add-credential-title">{t("Add provider credential")}</h2>
            <p>{t("The API key is stored in the OS keychain.")}</p>
          </div>
          <button
            class="dialog-close"
            type="button"
            aria-label={t("Close add credential dialog")}
            onclick={() => addCredentialDialog?.close()}
          >
            ×
          </button>
        </div>
        <label for="new-credential-label">{t("Credential label")}</label>
        <input
          id="new-credential-label"
          bind:value={newCredentialLabel}
          autocomplete="off"
          maxlength="109"
          required
          disabled={credentialBusy ||
            (policyStatus?.active && !policyStatus.allowCredentialManagement)}
        />
        <label for="credential-secret">{t("API key")}</label>
        <input
          id="credential-secret"
          type="password"
          bind:value={credentialSecret}
          autocomplete="new-password"
          spellcheck="false"
          required
          disabled={credentialBusy ||
            (policyStatus?.active && !policyStatus.allowCredentialManagement)}
        />
        {#if credentialMessage}
          <p class="model-list-message" class:error={credentialIsError} role="status">
            {t(credentialMessage)}
          </p>
        {/if}
        <button
          class="connection-button"
          type="submit"
          disabled={credentialBusy ||
            (policyStatus?.active && !policyStatus.allowCredentialManagement)}
        >
          {credentialBusy ? t("Saving...") : t("Add credential")}
        </button>
      </form>
    </dialog>

    <section class="active-provider" aria-label={t("Active model and settings")}>
      <p class="eyebrow">{t("Active configuration")}</p>
      <dl class="provider-summary">
        <div>
          <dt>{t("Provider")}</dt>
          <dd>{providerNames[adapter]}</dd>
        </div>
        <div>
          <dt>{t("Credential")}</dt>
          <dd>{selectedCredential?.label ?? t("None")}</dd>
        </div>
        <div>
          <dt>{t("Model")}</dt>
          <dd>{model || t("No model selected")}</dd>
        </div>
        <div>
          <dt>{t("Template")}</dt>
          <dd>{activeTemplate?.metadata.name ?? t("None")}</dd>
        </div>
      </dl>
      <div class="egress-indicator" aria-label={t("Data recipient")}>
        <span class="eyebrow">{t("Data recipient")}</span>
        <strong>{providerNames[adapter]}</strong>
        <span class="egress-endpoint">{currentEndpoint}</span>
        <span class:local={currentProviderIsLocal} class="egress-state">
          {currentProviderIsLocal ? t("Stays on this machine") : t("Remote provider")}
        </span>
        {#if policyStatus?.active}
          <span class="policy-badge">{t("Administrator managed")}</span>
        {/if}
        {#if policyStatus?.permissionsWarning}
          <p class="policy-warning" role="alert">
            {t("Policy file permissions could allow non-admin changes. Contact IT.")}
          </p>
        {/if}
      </div>
      <div class="settings-actions">
        <button class="settings-trigger" type="button" onclick={openGeneralSettings}>
          {t("General settings")}
        </button>
        <button class="settings-trigger" type="button" onclick={openProviderSettings}>
          {t("Provider settings")}
        </button>
        <button class="settings-trigger" type="button" onclick={openModelSettings}>
          {t("Model settings")}
        </button>
        <button class="settings-trigger" type="button" onclick={openTemplateSettings}>
          {t("Template settings")}
        </button>
      </div>
    </section>

    {#if importedTemplates.length}
      <div class="rail-template-picker">
        <label for="active-template-rail">{t("Active template")}</label>
        <select
          id="active-template-rail"
          value={activeTemplateId}
          disabled={isGenerating || isPreparingGeneration}
          onchange={(event) => activateTemplate(event.currentTarget.value)}
        >
          {#each importedTemplates as template (template.metadata.id)}
            <option value={template.metadata.id}>{template.metadata.name}</option>
          {/each}
        </select>
      </div>
    {:else}
      <p class="template-empty">{t("No templates imported")}</p>
    {/if}

    {#if caseSessionId || prompt || draft}
      <section
        class="controls-actions rail-generation-actions"
        aria-label={t("Case actions")}
      >
        <button
          class="case-discard-button"
          type="button"
          onclick={discardCase}
          disabled={isGenerating || isPreparingGeneration}
        >
          {t("Discard case")}
        </button>
      </section>
    {/if}
    {#if generationMessage}
      <p class="generation-status" class:error={generationIsError} role="status">
        {t(generationMessage)}
      </p>
    {/if}

    <dialog
      class="settings-dialog"
      bind:this={modelSettingsDialog}
      aria-labelledby="model-settings-title"
      onkeydown={handleDialogKeydown}
      oncancel={(event) => {
        event.preventDefault();
        modelSettingsDialog?.close();
      }}
    >
      <section class="provider-settings" aria-labelledby="model-settings-title">
        <p class="eyebrow">{t("Generation")}</p>
        <div class="dialog-heading">
          <div>
            <h2 id="model-settings-title">{t("Model settings")}</h2>
            <p>{providerNames[adapter]} · {model || t("No model selected")}</p>
          </div>
          <button
            class="dialog-close"
            type="button"
            aria-label={t("Close model settings")}
            onclick={() => modelSettingsDialog?.close()}
          >
            ×
          </button>
        </div>

        <label for="active-model">
          {t("Model")}
          {#if policyStatus?.active && policyStatus.allowedModels !== null}
            <span class="policy-badge">{t("Administrator managed")}</span>
          {/if}
        </label>
        <div class="model-picker">
          <select
            id="active-model"
            bind:value={model}
            disabled={modelListLoading || isGenerating}
          >
            {#if !currentModels.includes(model)}
              <option value={model} disabled={!isModelAllowed(adapter, model)}
                >{model} ({t("current")})</option
              >
            {/if}
            {#each currentModels as availableModel (availableModel)}
              <option value={availableModel}>{availableModel}</option>
            {/each}
          </select>
          <button
            class="model-refresh-button"
            type="button"
            onclick={refreshModels}
            disabled={modelListLoading || isGenerating || isPreparingGeneration}
          >
            {modelListLoading ? t("Loading...") : t("Refresh models")}
          </button>
        </div>
        {#if modelListMessage}
          <p class="model-list-message" class:error={modelListIsError} role="status">
            {t(modelListMessage)}
          </p>
        {/if}

        <label for="output-token-limit">
          {t("Output token limit")}
          {#if policyStatus?.active && policyStatus.maxOutputTokens !== null}
            <span class="policy-badge">{t("Administrator managed")}</span>
          {/if}
        </label>
        <input
          id="output-token-limit"
          type="number"
          bind:value={outputTokenLimit}
          min="1"
          max={maxOutputTokenLimit}
          step="1"
          required
          aria-describedby={outputTokenLimitIssue
            ? "output-token-limit-hint output-token-limit-error"
            : "output-token-limit-hint"}
          aria-invalid={!isOutputTokenLimitValid}
          disabled={isGenerating || isPreparingGeneration}
        />
        <p id="output-token-limit-hint" class="setting-hint">
          {t("token-limit-hint")}
        </p>
        {#if outputTokenLimitIssue}
          <p id="output-token-limit-error" class="generation-status error" role="alert">
            {t(outputTokenLimitIssue)}
          </p>
        {/if}

        <label for="reasoning-effort">
          {t("Reasoning effort")}
          {#if policyStatus?.active && policyStatus.maxReasoningEffort !== null}
            <span class="policy-badge">{t("Administrator managed")}</span>
          {/if}
        </label>
        <select
          id="reasoning-effort"
          bind:value={reasoningEffort}
          disabled={isGenerating || isPreparingGeneration}
        >
          <option value="provider_default">{t("Provider default")}</option>
          <option value="none">{t("None")}</option>
          <option value="minimal" disabled={!isReasoningEffortAllowed("minimal")}
            >{t("Minimal")}</option
          >
          <option value="low" disabled={!isReasoningEffortAllowed("low")}
            >{t("Low")}</option
          >
          <option value="medium" disabled={!isReasoningEffortAllowed("medium")}
            >{t("Medium")}</option
          >
          <option value="high" disabled={!isReasoningEffortAllowed("high")}
            >{t("High")}</option
          >
          <option value="x_high" disabled={!isReasoningEffortAllowed("x_high")}
            >{t("Extra high")}</option
          >
          <option value="max" disabled={!isReasoningEffortAllowed("max")}
            >{t("Maximum")}</option
          >
        </select>

        <label class="vision-setting" for="vision-enabled">
          <input id="vision-enabled" type="checkbox" bind:checked={visionEnabled} />
          <span>{t("Allow image input for this model")}</span>
        </label>
      </section>
    </dialog>

    <dialog
      class="settings-dialog template-settings-dialog"
      bind:this={templateSettingsDialog}
      aria-labelledby="template-settings-title"
      onkeydown={handleDialogKeydown}
      oncancel={(event) => {
        event.preventDefault();
      }}
    >
      <section class="template-settings" aria-label={t("Template settings")}>
        <div class="template-heading">
          <p class="eyebrow">{t("Workspace")}</p>
          <div class="dialog-heading">
            <div>
              <h2 id="template-settings-title">{t("Template settings")}</h2>
              <p>{t("Select, import, and configure the active template.")}</p>
            </div>
            <button
              class="dialog-close"
              type="button"
              aria-label={t("Close template settings")}
              onclick={() => templateSettingsDialog?.close()}
            >
              ×
            </button>
          </div>
        </div>

        {#if importedTemplates.length}
          <label for="active-template">{t("Active template")}</label>
          <select
            id="active-template"
            value={activeTemplateId}
            disabled={isGenerating || isPreparingGeneration}
            onchange={(event) => activateTemplate(event.currentTarget.value)}
          >
            {#each importedTemplates as template (template.metadata.id)}
              <option value={template.metadata.id}>{template.metadata.name}</option>
            {/each}
          </select>
          <button
            class="template-export-button"
            type="button"
            onclick={openTemplateEditor}
            disabled={!activeTemplate ||
              isGenerating ||
              isPreparingGeneration ||
              (policyStatus?.active && !policyStatus.allowTemplateEdit)}
          >
            {t("Edit template")}
            {#if policyStatus?.active && !policyStatus.allowTemplateEdit}
              <span class="policy-badge">{t("Administrator managed")}</span>
            {/if}
          </button>
        {:else}
          <p class="template-empty">{t("No templates imported")}</p>
          <button
            class="template-export-button"
            type="button"
            onclick={createGenericStarter}
            disabled={templateBusy ||
              (policyStatus?.active && !policyStatus.allowTemplateImport)}
          >
            {t("Use generic starter")}
            {#if policyStatus?.active && !policyStatus.allowTemplateImport}
              <span class="policy-badge">{t("Administrator managed")}</span>
            {/if}
          </button>
        {/if}

        <button
          class="template-import-button"
          type="button"
          onclick={() => templateFileInput?.click()}
          disabled={templateBusy ||
            (policyStatus?.active && !policyStatus.allowTemplateImport)}
        >
          {templateBusy ? t("Working...") : t("Import template (.epitpl)")}
          {#if policyStatus?.active && !policyStatus.allowTemplateImport}
            <span class="policy-badge">{t("Administrator managed")}</span>
          {/if}
        </button>
        <input
          id="template-file"
          class="template-file-input"
          type="file"
          aria-hidden="true"
          tabindex="-1"
          accept=".epitpl,text/plain,application/toml,application/json"
          bind:this={templateFileInput}
          onchange={importTemplate}
          disabled={templateBusy ||
            (policyStatus?.active && !policyStatus.allowTemplateImport)}
        />
        {#if activeTemplate}
          <button
            class="template-export-button"
            type="button"
            onclick={exportActiveTemplate}
            disabled={templateBusy ||
              (policyStatus?.active && !policyStatus.allowTemplateExport)}
          >
            {t("Export template (.epitpl)")}
            {#if policyStatus?.active && !policyStatus.allowTemplateExport}
              <span class="policy-badge">{t("Administrator managed")}</span>
            {/if}
          </button>
        {/if}

        {#if activeTemplate?.variables.length}
          <div class="template-fields">
            <p class="eyebrow">{t("Template fields")}</p>
            {#each activeTemplate.variables as variable (variable.name)}
              {@const fieldId = `template-variable-${variable.name}`}
              {#if variable.kind === "boolean"}
                <label class="template-checkbox" for={fieldId}>
                  <input
                    id={fieldId}
                    type="checkbox"
                    disabled={isGenerating || isPreparingGeneration}
                    checked={templateValues[variable.name] === true}
                    aria-required={variable.required}
                    onchange={(event) =>
                      updateTemplateValue(variable.name, event.currentTarget.checked)}
                  />
                  <span
                    >{templateVariableLabel(variable)}{variable.required
                      ? " *"
                      : ""}</span
                  >
                </label>
              {:else}
                <label for={fieldId}>
                  {templateVariableLabel(variable)}{variable.required ? " *" : ""}
                </label>
                {#if variable.kind === "select"}
                  <select
                    id={fieldId}
                    value={typeof templateValues[variable.name] === "string"
                      ? templateValues[variable.name]
                      : ""}
                    disabled={isGenerating || isPreparingGeneration}
                    aria-required={variable.required}
                    onchange={(event) =>
                      updateTemplateValue(variable.name, event.currentTarget.value)}
                  >
                    <option value="" disabled={variable.required}
                      >{t("Select...")}</option
                    >
                    {#each variable.options as option (option)}
                      <option value={option}>{option}</option>
                    {/each}
                  </select>
                {:else}
                  <input
                    id={fieldId}
                    type={variable.kind === "date" ? "date" : "text"}
                    value={typeof templateValues[variable.name] === "string"
                      ? templateValues[variable.name]
                      : ""}
                    disabled={isGenerating || isPreparingGeneration}
                    aria-required={variable.required}
                    required={variable.required}
                    onchange={(event) =>
                      updateTemplateValue(variable.name, event.currentTarget.value)}
                  />
                {/if}
              {/if}
            {/each}
          </div>
        {/if}

        {#if activeTemplate?.sections.length}
          <div class="template-fields template-section-fields">
            <p class="eyebrow">{t("Sections")}</p>
            {#each orderedTemplateSections(activeTemplate) as section (section.id)}
              {@const sectionInputId = `template-section-${section.id}`}
              <label class="template-checkbox" for={sectionInputId}>
                <input
                  id={sectionInputId}
                  type="checkbox"
                  disabled={isGenerating ||
                    isPreparingGeneration ||
                    (policyStatus?.active && !policyStatus.allowTemplateEdit) ||
                    (templateSectionStates[section.id] === true &&
                      enabledSectionCount <= 1)}
                  checked={templateSectionStates[section.id] === true}
                  onchange={(event) =>
                    updateTemplateSection(section.id, event.currentTarget.checked)}
                />
                <span>{templateSectionLabel(section)}</span>
              </label>
            {/each}
          </div>
        {/if}

        {#if templateMessage}
          <p class="template-message" class:error={templateIsError} role="status">
            {t(templateMessage)}
          </p>
        {/if}

        {#if pendingTemplate}
          <div class="template-preview" aria-label={t("Template preview")}>
            <p class="eyebrow">{t("Review import")}</p>
            <h3>{pendingTemplate.metadata.name}</h3>
            <p>{pendingTemplate.metadata.description}</p>
            <dl>
              <div>
                <dt>{t("Locale")}</dt>
                <dd>{pendingTemplate.metadata.locale}</dd>
              </div>
              <div>
                <dt>{t("Version")}</dt>
                <dd>{pendingTemplate.metadata.version}</dd>
              </div>
              <div>
                <dt>{t("Variables")}</dt>
                <dd>{pendingTemplate.variables.length}</dd>
              </div>
              <div>
                <dt>{t("Sections")}</dt>
                <dd>{pendingTemplate.sections.length}</dd>
              </div>
            </dl>
            {#if pendingTemplate.metadata.specialty_tags.length}
              <p class="template-tags">
                {pendingTemplate.metadata.specialty_tags.join(" · ")}
              </p>
            {/if}
            <details>
              <summary>{t("System prompt")}</summary>
              <pre>{pendingTemplate.system_prompt}</pre>
            </details>
            <div class="template-preview-actions">
              <button
                class="connection-button"
                onclick={savePendingTemplate}
                disabled={templateBusy ||
                  (policyStatus?.active && !policyStatus.allowTemplateImport)}
              >
                {t("Save template")}
              </button>
              <button
                class="template-discard"
                onclick={() => (pendingTemplate = null)}
                disabled={templateBusy}
              >
                {t("Cancel")}
              </button>
            </div>
          </div>
        {/if}
      </section>
    </dialog>

    <footer class="rail-footer">
      <span class="local-indicator" aria-hidden="true"></span>
      <span>{t(desktopAvailable ? "Desktop session" : "Preview session")}</span>
    </footer>
  </aside>

  <dialog
    class="template-editor-dialog"
    bind:this={templateEditorDialog}
    aria-labelledby="template-editor-title"
    onkeydown={handleDialogKeydown}
    oncancel={(event) => {
      event.preventDefault();
      templateEditorDialog?.close();
    }}
    onclose={() => {
      templateEditDraft = null;
      if (templatePreviewTimer) clearTimeout(templatePreviewTimer);
    }}
  >
    {#if templateEditDraft}
      <form
        class="template-editor"
        onsubmit={(event) => {
          event.preventDefault();
          void saveEditedTemplate();
        }}
      >
        <div class="dialog-heading">
          <div>
            <p class="eyebrow">{t("Template editor")}</p>
            <h2 id="template-editor-title">
              {templateEditDraft.metadata.name || t("Untitled template")}
            </h2>
          </div>
          <button
            class="dialog-close"
            type="button"
            aria-label={t("Close template editor")}
            onclick={() => templateEditorDialog?.close()}
          >
            ×
          </button>
        </div>

        <div class="template-editor-meta">
          <label>
            {t("Template name")}
            <input
              value={templateEditDraft.metadata.name}
              required
              oninput={(event) =>
                updateTemplateMetadata("name", event.currentTarget.value)}
            />
          </label>
          <label>
            {t("Description")}
            <input
              value={templateEditDraft.metadata.description}
              oninput={(event) =>
                updateTemplateMetadata("description", event.currentTarget.value)}
            />
          </label>
          <label>
            {t("Locale")}
            <input
              value={templateEditDraft.metadata.locale}
              required
              oninput={(event) =>
                updateTemplateMetadata("locale", event.currentTarget.value)}
            />
          </label>
          <label>
            {t("Version")}
            <input
              value={templateEditDraft.metadata.version}
              required
              oninput={(event) =>
                updateTemplateMetadata("version", event.currentTarget.value)}
            />
          </label>
          <label>
            {t("Author")}
            <input
              value={templateEditDraft.metadata.author}
              oninput={(event) =>
                updateTemplateMetadata("author", event.currentTarget.value)}
            />
          </label>
        </div>

        <section class="template-output-rules" aria-labelledby="output-rules-title">
          <p class="eyebrow" id="output-rules-title">{t("Output rules")}</p>
          <div class="template-output-rule-terms">
            <label>
              {t("Forbidden terms")}
              <textarea
                rows="3"
                value={(templateEditDraft.output_rules?.forbidden_terms ?? []).join(
                  "\n",
                )}
                disabled={templateSaveBusy}
                oninput={(event) =>
                  updateTemplateOutputTerms(
                    "forbidden_terms",
                    event.currentTarget.value,
                  )}></textarea>
            </label>
            <label>
              {t("Required terms")}
              <textarea
                rows="3"
                value={(templateEditDraft.output_rules?.required_terms ?? []).join(
                  "\n",
                )}
                disabled={templateSaveBusy}
                oninput={(event) =>
                  updateTemplateOutputTerms(
                    "required_terms",
                    event.currentTarget.value,
                  )}></textarea>
            </label>
          </div>
          <div class="template-output-rule-flags">
            <label class="template-checkbox">
              <input
                type="checkbox"
                checked={templateEditDraft.output_rules?.forbid_code_fences ?? false}
                disabled={templateSaveBusy}
                onchange={(event) =>
                  updateTemplateOutputRules({
                    forbid_code_fences: event.currentTarget.checked,
                  })}
              />
              <span>{t("Forbid code fences")}</span>
            </label>
            <label class="template-checkbox">
              <input
                type="checkbox"
                checked={templateEditDraft.output_rules?.forbid_leading_whitespace ??
                  false}
                disabled={templateSaveBusy}
                onchange={(event) =>
                  updateTemplateOutputRules({
                    forbid_leading_whitespace: event.currentTarget.checked,
                  })}
              />
              <span>{t("Forbid leading whitespace")}</span>
            </label>
            <label class="template-checkbox">
              <input
                type="checkbox"
                checked={templateEditDraft.output_rules?.forbid_bullet_characters ??
                  false}
                disabled={templateSaveBusy}
                onchange={(event) =>
                  updateTemplateOutputRules({
                    forbid_bullet_characters: event.currentTarget.checked,
                  })}
              />
              <span>{t("Forbid bullet characters")}</span>
            </label>
            <label class="template-checkbox">
              <input
                type="checkbox"
                checked={templateEditDraft.output_rules?.forbid_parenthesized_dates ??
                  false}
                disabled={templateSaveBusy}
                onchange={(event) =>
                  updateTemplateOutputRules({
                    forbid_parenthesized_dates: event.currentTarget.checked,
                  })}
              />
              <span>{t("Forbid parenthesized dates")}</span>
            </label>
          </div>
        </section>

        <section
          class="template-sections-editor"
          aria-labelledby="sections-editor-title"
        >
          <div class="template-sections-heading">
            <p class="eyebrow" id="sections-editor-title">{t("Sections editor")}</p>
            <button
              class="template-export-button"
              type="button"
              onclick={addTemplateEditorSection}
              disabled={templateSaveBusy}
            >
              {t("Add section")}
            </button>
          </div>
          {#if templateEditDraft.sections.length}
            <ol class="template-section-list" aria-label={t("Template sections")}>
              {#each templateEditDraft.sections as section, index (section.order)}
                <li class="template-section-item">
                  <div class="template-section-item-fields">
                    <label>
                      {t("Section ID")}
                      <input
                        value={section.id}
                        required
                        disabled={templateSaveBusy}
                        oninput={(event) =>
                          updateTemplateEditorSection(index, {
                            id: event.currentTarget.value,
                          })}
                      />
                    </label>
                    <label>
                      {t("Heading")}
                      <input
                        value={section.heading}
                        required
                        disabled={templateSaveBusy}
                        oninput={(event) =>
                          updateTemplateEditorSection(index, {
                            heading: event.currentTarget.value,
                          })}
                      />
                    </label>
                    <label>
                      {t("Display label")} ({templateEditDraft.metadata.locale ||
                        t("Locale")})
                      <input
                        value={templateSectionEditorLabel(section)}
                        disabled={templateSaveBusy}
                        oninput={(event) =>
                          updateTemplateEditorSectionLabel(
                            index,
                            event.currentTarget.value,
                          )}
                      />
                    </label>
                  </div>
                  <div class="template-section-item-controls">
                    <label class="template-checkbox">
                      <input
                        type="checkbox"
                        checked={section.enabled_by_default}
                        disabled={templateSaveBusy ||
                          (section.enabled_by_default &&
                            editorEnabledSectionCount <= 1)}
                        onchange={(event) =>
                          updateTemplateEditorSection(index, {
                            enabled_by_default: event.currentTarget.checked,
                          })}
                      />
                      <span>{t("Enabled by default")}</span>
                    </label>
                    <div class="template-section-order">
                      <button
                        type="button"
                        onclick={() => moveTemplateEditorSection(index, -1)}
                        disabled={templateSaveBusy || index === 0}
                      >
                        {t("Move up")}
                      </button>
                      <button
                        type="button"
                        onclick={() => moveTemplateEditorSection(index, 1)}
                        disabled={templateSaveBusy ||
                          index === templateEditDraft.sections.length - 1}
                      >
                        {t("Move down")}
                      </button>
                      <button
                        class="template-section-delete"
                        type="button"
                        onclick={() => deleteTemplateEditorSection(index)}
                        disabled={templateSaveBusy}
                      >
                        {t("Delete")}
                      </button>
                    </div>
                  </div>
                </li>
              {/each}
            </ol>
          {:else}
            <p class="setting-hint">
              {t("No sections. Add one to include a heading.")}
            </p>
          {/if}
        </section>

        <div class="template-editor-body">
          <label for="template-system-prompt">{t("System prompt · MiniJinja")}</label>
          <textarea
            id="template-system-prompt"
            spellcheck="false"
            bind:value={templateEditDraft.system_prompt}
            oninput={(event) => updateTemplatePrompt(event.currentTarget.value)}
          ></textarea>
          <section
            class="template-live-preview"
            aria-labelledby="template-preview-title"
          >
            <div class="preview-heading">
              <h3 id="template-preview-title">{t("Rendered preview")}</h3>
              <span class:error={templatePreviewIsError} role="status">
                {t(templatePreviewMessage)}
              </span>
            </div>
            <pre>{templatePreview || t("Preview output will appear here.")}</pre>
          </section>
        </div>

        <div class="template-editor-actions">
          <button
            class="template-discard"
            type="button"
            onclick={() => templateEditorDialog?.close()}
            disabled={templateSaveBusy}
          >
            {t("Cancel")}
          </button>
          <button
            class="connection-button"
            type="submit"
            disabled={templateSaveBusy ||
              (policyStatus?.active && !policyStatus.allowTemplateEdit)}
          >
            {templateSaveBusy ? t("Validating...") : t("Validate and save")}
          </button>
        </div>
      </form>
    {/if}
  </dialog>

  <dialog
    class="settings-dialog egress-confirmation-dialog"
    bind:this={egressConfirmationDialog}
    aria-labelledby="egress-confirmation-title"
    onkeydown={handleDialogKeydown}
    oncancel={(event) => {
      event.preventDefault();
      pendingEgressConfirmation = null;
      egressConfirmationDialog?.close();
    }}
  >
    <section class="provider-settings" aria-labelledby="egress-confirmation-title">
      <p class="eyebrow">{t("Data transfer")}</p>
      <div class="dialog-heading">
        <div>
          <h2 id="egress-confirmation-title">
            {t("Confirm sending clinical material")}
          </h2>
          <p>{t("Remote endpoint confirmation details")}</p>
        </div>
      </div>
      {#if pendingEgressConfirmation}
        <dl class="provider-summary egress-target">
          <div>
            <dt>{t("Provider")}</dt>
            <dd>{pendingEgressConfirmation.profile.display_name}</dd>
          </div>
          <div>
            <dt>{t("Endpoint")}</dt>
            <dd>
              {displayedEndpoint(
                pendingEgressConfirmation.profile.adapter,
                pendingEgressConfirmation.profile.endpoint ?? "",
              )}
            </dd>
          </div>
        </dl>
      {/if}
      <p>{t("Current case material and template will be sent to this endpoint.")}</p>
      <div class="template-editor-actions">
        <button
          class="template-discard"
          type="button"
          onclick={() => {
            pendingEgressConfirmation = null;
            egressConfirmationDialog?.close();
          }}
          disabled={egressConfirmationBusy}
        >
          {t("Cancel")}
        </button>
        <button
          class="connection-button"
          type="button"
          onclick={confirmProviderEgress}
          disabled={egressConfirmationBusy}
        >
          {egressConfirmationBusy ? t("Checking...") : t("Send to provider")}
        </button>
      </div>
    </section>
  </dialog>

  <main class="work-area">
    {#if isFirstRun}
      <section class="first-run-panel" aria-labelledby="first-run-title">
        <p class="eyebrow">{t("Getting started / Template setup")}</p>
        <h2 id="first-run-title">{t("Bring your clinical template")}</h2>
        <p>
          {t("first-run-template-guidance")}
        </p>

        <div class="onboarding-actions">
          <button class="connection-button" onclick={openTemplateSettings}>
            {t("Open template settings")}
          </button>
        </div>
      </section>
    {:else}
      <header class="page-header">
        <div>
          <p class="eyebrow">{t("Clinical writing")}</p>
          <h2>{t("New discharge summary")}</h2>
        </div>
        <span class="draft-tag"><span aria-hidden="true"></span> {t("Draft")}</span>
      </header>

      <div class="writing-grid">
        <section
          class="source-panel"
          aria-labelledby="source-title"
          ondragover={(event) => event.preventDefault()}
          ondrop={handleInputDrop}
        >
          <div class="panel-heading">
            <div>
              <p class="eyebrow">{t("01 / Source")}</p>
              <h3 id="source-title">{t("Clinical material")}</h3>
            </div>
            <span class="field-count">{inputCharacterCount} chars</span>
          </div>

          <input
            class="source-file-input"
            type="file"
            accept=".txt,.md,.csv,.pdf,.docx,.xlsx,.rtf,.html,.htm,image/png,image/jpeg"
            multiple
            bind:this={sourceFileInput}
            onchange={handleFileSelection}
            aria-label={t("Choose clinical files")}
          />
          <div class="input-tools">
            <button
              class="input-tool-button"
              type="button"
              onclick={() => sourceFileInput?.click()}
              disabled={ingestBusy || isGenerating || isPreparingGeneration}
            >
              {t("Add files or screenshots")}
            </button>
            <form
              class="url-import"
              onsubmit={(event) => {
                event.preventDefault();
                void importUrl();
              }}
            >
              <input
                type="url"
                bind:value={sourceUrl}
                placeholder="https://..."
                aria-label={t("Clinical source URL")}
                disabled={ingestBusy ||
                  isGenerating ||
                  isPreparingGeneration ||
                  (policyStatus?.active && !policyStatus.allowUrlIngestion)}
              />
              <button
                class="input-tool-button"
                type="submit"
                disabled={!sourceUrl.trim() ||
                  (policyStatus?.active && !policyStatus.allowUrlIngestion) ||
                  ingestBusy ||
                  isGenerating ||
                  isPreparingGeneration}
              >
                {t("Add URL")}
              </button>
            </form>
          </div>
          {#if policyStatus?.active && !policyStatus.allowUrlIngestion}
            <p class="policy-note">
              <span class="policy-badge">{t("Administrator managed")}</span>
              {t("URL ingestion is disabled by administrator policy.")}
            </p>
          {/if}
          {#if ingestMessage}
            <p class="ingest-message" class:error={ingestIsError} role="status">
              {t(ingestMessage)}
            </p>
          {/if}
          {#if sourceBlocks.length}
            <ul class="source-input-list" aria-label={t("Inputs for this round")}>
              {#each sourceBlocks as block (block.id)}
                {@const provenanceLabel = sourceProvenanceLabel(block)}
                <li class="source-input-item">
                  <div class="source-input-meta">
                    <span title={provenanceLabel}>{provenanceLabel}</span>
                    <span>{block.content.length} chars</span>
                  </div>
                  <div class="source-input-details">
                    <span
                      >{block.round + 1 === 1
                        ? t("New round")
                        : t("round-number", { round: block.round + 1 })}</span
                    >
                    <span>{extractionMethodLabel(block.extraction_method)}</span>
                    <span>{block.images?.[0]?.mime_type ?? t("Extracted text")}</span>
                  </div>
                  <button
                    class="source-input-remove"
                    type="button"
                    aria-label={t("remove-input", { name: provenanceLabel })}
                    onclick={() => removeSourceBlock(block.id)}
                    disabled={isGenerating || isPreparingGeneration}
                  >
                    {t("Remove")}
                  </button>
                  <details>
                    <summary>{t("Preview input")}</summary>
                    <pre>{block.content}</pre>
                  </details>
                </li>
              {/each}
            </ul>
          {/if}

          <textarea
            id="source-material"
            bind:value={prompt}
            placeholder={t("Paste anonymized notes, findings, and relevant history...")}
            aria-label={t("Anonymized clinical material")}
            onpaste={handleInputPaste}></textarea>

          <div class="source-actions">
            {#if isGenerating}
              <button class="cancel-button" type="button" onclick={cancelGeneration}>
                {t("Cancel generation")}
              </button>
            {:else}
              <button
                class="generate-button"
                type="button"
                onclick={() => generateDraft()}
                disabled={(!prompt.trim() && sourceBlocks.length === 0) ||
                  !activeTemplate ||
                  isPreparingGeneration ||
                  generationConfigurationIssue !== ""}
              >
                {isPreparingGeneration ? t("Preparing...") : t("Generate draft")}
              </button>
            {/if}
            {#if generationConfigurationIssue && generationConfigurationIssue !== outputTokenLimitIssue}
              <p class="generation-status error" role="alert">
                {t(generationConfigurationIssue)}
              </p>
            {/if}
            <p>{t("Use anonymized clinical material.")}</p>
          </div>
        </section>

        <section class="draft-panel" aria-labelledby="draft-title">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">{t("02 / Review")}</p>
              <h3 id="draft-title">{t("Generated summary")}</h3>
            </div>
            {#if copyReviewMessage}
              <span class="generation-status">{t(copyReviewMessage)}</span>
            {:else if generationMessage}
              <span class="generation-status" class:error={generationIsError}>
                {t(generationMessage)}
              </span>
            {/if}
          </div>

          <div class="output-toolbar">
            <span>{t("Output view")}</span>
            <div
              class="preview-toggle"
              role="group"
              aria-label={t("Output preview format")}
            >
              <button
                type="button"
                aria-pressed={outputPreviewMode === "plain"}
                class:active={outputPreviewMode === "plain"}
                onclick={() => (outputPreviewMode = "plain")}
              >
                {t("Plain text")}
              </button>
              <button
                type="button"
                aria-pressed={outputPreviewMode === "formatted"}
                class:active={outputPreviewMode === "formatted"}
                onclick={() => (outputPreviewMode = "formatted")}
              >
                {t("Formatted")}
              </button>
            </div>
          </div>

          <article class="draft-output" aria-live="polite" aria-busy={isGenerating}>
            {#if draft}
              {#if outputPreviewMode === "plain"}
                <pre>{#each draftLines as line, index (index)}<span
                      id={`draft-line-${index + 1}`}
                      class:linted-line={outputViolations.some(
                        (violation) => violation.line === index + 1,
                      )}>{line}{index < draftLines.length - 1 ? "\n" : ""}</span
                    >{/each}</pre>
              {:else}
                <div class="rich-output">
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                  {@html formattedOutput}
                </div>
              {/if}
            {:else if isGenerating}
              <p class="empty-state">
                {t("Preparing draft")}<span class="typing-dots" aria-hidden="true"
                  >...</span
                >
              </p>
            {:else}
              <p class="empty-state">{t("No draft yet")}</p>
            {/if}
          </article>
          {#if outputViolations.length}
            <aside class="lint-warnings" aria-label={t("Output checks")} role="status">
              <p>
                {t("output-checks-need-review", { count: outputViolations.length })}
              </p>
              <ul>
                {#each outputViolations as violation, index (`${violation.line}-${violation.kind}-${index}`)}
                  <li>
                    <button
                      class="lint-jump"
                      onclick={() => scrollToOutputLine(violation.line)}
                    >
                      {t("line", { line: violation.line })}: {t(
                        outputViolationMessages[violation.kind],
                      )}{violation.term ? `: ${violation.term}` : ""}
                    </button>
                  </li>
                {/each}
              </ul>
              <button
                class="lint-regenerate-button"
                onclick={regenerateWithCorrections}
                disabled={isGenerating ||
                  isPreparingGeneration ||
                  generationConfigurationIssue !== ""}
              >
                {t("Regenerate with corrections")}
              </button>
            </aside>
          {/if}
          {#if draft && caseSessionId}
            <div class="review-controls">
              <label class="review-confirmation">
                <input
                  type="checkbox"
                  checked={reviewedOutputCaseId === caseSessionId}
                  disabled={isGenerating ||
                    isPreparingGeneration ||
                    isInvalidatingReview}
                  onchange={setOutputReview}
                />
                <span>{t("I have reviewed the output and take responsibility.")}</span>
              </label>
              <button
                class="review-copy-button"
                onclick={copyReviewedOutput}
                disabled={!canCopyOutput}
              >
                {t("Copy to medical record")}
              </button>
            </div>
          {/if}
        </section>
      </div>

      <footer class="work-footer">
        <span>{t("Review generated text before use in the medical record.")}</span>
        <span>{t("Epikrise / Workspace")}</span>
      </footer>
    {/if}
  </main>
</div>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    min-width: 320px;
    color: #1d2926;
    background: #f2f5f1;
    font-family: "Avenir Next", "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  :global(button),
  :global(input),
  :global(select),
  :global(textarea) {
    font: inherit;
  }

  .app-shell {
    display: grid;
    grid-template-columns: minmax(260px, 0.78fr) minmax(400px, 1.35fr) minmax(
        270px,
        0.82fr
      );
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "header header controls"
      "inputs output controls"
      "footer footer controls";
    align-items: stretch;
    gap: 0 18px;
    padding: 0 22px;
    height: 100dvh;
    overflow: hidden;
    background:
      radial-gradient(ellipse at 88% 10%, rgba(215, 229, 218, 0.55), transparent 30%),
      #f2f5f1;
  }

  .provider-rail {
    display: flex;
    grid-area: controls;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 24px 0 18px 18px;
    border-left: 1px solid #dce4de;
    background: rgba(249, 251, 248, 0.62);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 11px;
    color: inherit;
    text-decoration: none;
  }

  .brand-mark {
    display: grid;
    width: 36px;
    height: 36px;
    place-items: center;
    border-radius: 10px 10px 10px 3px;
    color: #f8fbf7;
    background: #176c5c;
    font-family: Georgia, serif;
    font-size: 22px;
  }

  .brand-name {
    font-family: Georgia, serif;
    font-size: 20px;
  }

  .active-provider {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 24px;
    padding: 12px 13px;
    border-left: 2px solid #d46b4d;
    background: #f7faf6;
  }

  .provider-summary {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 7px 12px;
    margin: 0;
  }

  .provider-summary dt {
    color: #65766e;
    font-size: 10px;
  }

  .provider-summary dd {
    margin: 1px 0 0;
    color: #30473d;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .egress-indicator {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 3px 8px;
    padding: 8px 0;
    border-top: 1px solid #dce4de;
    border-bottom: 1px solid #dce4de;
    font-size: 11px;
  }

  .egress-indicator > .eyebrow,
  .egress-indicator > strong,
  .egress-endpoint {
    grid-column: 1 / -1;
  }

  .egress-indicator > strong {
    color: #30473d;
  }

  .egress-endpoint {
    overflow-wrap: anywhere;
    color: #65766e;
  }

  .egress-state {
    color: #9a4e35;
  }

  .egress-state.local {
    color: #236e5d;
  }

  .policy-badge {
    display: inline-flex;
    width: fit-content;
    align-items: center;
    margin-left: 6px;
    padding: 2px 5px;
    border: 1px solid #d7c6a3;
    border-radius: 3px;
    color: #72551e;
    background: #fbf7ed;
    font-size: 10px;
    font-weight: 650;
  }

  .policy-warning {
    grid-column: 1 / -1;
    margin: 3px 0 0;
    color: #9a3d2e;
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .policy-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px;
    color: #72551e;
    font-size: 11px;
  }

  .egress-target {
    margin: 14px 0;
  }

  .egress-confirmation-dialog .provider-settings > p:not(.eyebrow) {
    color: #53665d;
    line-height: 1.5;
  }

  .settings-actions,
  .credential-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 14px;
  }

  .credential-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: stretch;
    gap: 8px;
  }

  .credential-actions > .connection-button,
  .credential-actions > .credential-remove-button {
    width: 100%;
    min-width: 0;
    min-height: 44px;
    margin-top: 0;
    padding: 6px 8px;
    font-size: 12px;
    line-height: 1.25;
    white-space: normal;
  }

  .credential-remove-button,
  .credential-cancel-button {
    min-height: 36px;
    padding: 0 11px;
    border: 1px solid #b95848;
    border-radius: 4px;
    color: #8f3428;
    background: #fff8f5;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 650;
  }

  .credential-remove-button:hover:not(:disabled) {
    color: #fff;
    background: #a94435;
  }

  .credential-cancel-button {
    border-color: #cbd8cf;
    color: #52665c;
    background: transparent;
  }

  .credential-confirmation {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 11px;
    border-left: 2px solid #b95848;
    background: #fff3ef;
  }

  .credential-confirmation p {
    margin: 0;
    color: #73392f;
    font-size: 12px;
  }

  .credential-confirmation > div {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }

  .settings-trigger {
    min-height: 33px;
    margin: 0;
    padding: 0;
    border: 0;
    color: #236e5d;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    text-align: left;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  :global(dialog) {
    max-height: min(90dvh, 900px);
    padding: 0;
    border: 1px solid #cbd8cf;
    border-radius: 7px;
    color: #1d2926;
    background: #f9fbf8;
    box-shadow: 0 22px 70px rgba(18, 36, 29, 0.24);
  }

  :global(dialog::backdrop) {
    background: rgba(18, 36, 29, 0.48);
    backdrop-filter: blur(3px);
  }

  .settings-dialog {
    width: min(510px, calc(100vw - 28px));
    overflow: auto;
    padding: 24px;
  }

  .settings-dialog.general-settings-dialog {
    height: 19rem;
    max-height: calc(100vh - 2rem);
  }

  .settings-dialog.template-settings-dialog {
    width: min(760px, calc(100vw - 28px));
  }

  .settings-dialog .template-settings {
    margin: 0;
    padding: 0;
    border: 0;
  }

  .settings-dialog .template-heading {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }

  .dialog-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
  }

  .dialog-heading h1,
  .dialog-heading h2 {
    margin: 3px 0 0;
    font-family: Georgia, serif;
    font-size: 25px;
    font-weight: 400;
    line-height: 1.2;
  }

  .dialog-heading p:not(.eyebrow) {
    margin: 7px 0 0;
    color: #65766e;
    font-size: 12px;
  }

  .dialog-close {
    display: grid;
    width: 36px;
    height: 36px;
    flex: 0 0 36px;
    place-items: center;
    border: 1px solid #d4ded7;
    border-radius: 4px;
    color: #4b6157;
    background: transparent;
    cursor: pointer;
    font-size: 22px;
    line-height: 1;
  }

  .settings-dialog .provider-settings {
    margin: 0;
    gap: 9px;
  }

  .settings-dialog .provider-settings > .eyebrow {
    margin: 0;
  }

  .provider-settings {
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin-top: 0;
  }

  .eyebrow {
    margin: 0;
    color: #51645b;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  p {
    margin-top: 0;
  }

  .provider-settings h1 {
    margin: 0 0 14px;
    font-family: Georgia, serif;
    font-size: 25px;
    font-weight: 400;
  }

  .template-settings {
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin-top: 22px;
    padding-top: 17px;
    border-top: 1px solid #dce4de;
  }

  .update-settings {
    display: flex;
    flex-direction: column;
    gap: 9px;
    min-width: 0;
    margin: 12px 0 0;
    padding: 12px 0 0;
    border: 0;
    border-top: 1px solid #dce4de;
  }

  .update-settings legend {
    padding: 0;
    font-weight: 700;
  }

  .update-settings p {
    margin: 0;
  }

  .update-opt-in {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    min-width: 0;
    margin-top: 0;
  }

  .update-opt-in input {
    flex: 0 0 18px;
    width: 18px;
    height: 18px;
    margin: 2px 0 0;
    padding: 0;
  }

  .update-opt-in span {
    min-width: 0;
  }

  .update-candidate {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 9px;
    padding-top: 10px;
    border-top: 1px solid #dce4de;
  }

  .update-settings progress {
    width: 100%;
  }

  .template-heading h2 {
    margin: 3px 0 4px;
    font-family: Georgia, serif;
    font-size: 20px;
    font-weight: 400;
  }

  .setting-hint {
    margin: -4px 0 0;
    color: #75847c;
    font-size: 10px;
  }

  .controls-actions {
    display: grid;
    gap: 8px;
    margin-top: 13px;
    padding-top: 12px;
    border-top: 1px solid #dce4de;
  }

  .controls-actions .case-discard-button {
    width: 100%;
  }

  .template-empty {
    margin: 0;
    color: #829088;
    font-size: 12px;
  }

  .provider-rail > .template-empty {
    margin-top: 12px;
  }

  .rail-template-picker {
    margin-top: 12px;
  }

  .template-export-button {
    min-height: 34px;
    border: 1px solid #bfd1c7;
    border-radius: 5px;
    color: #285e50;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 650;
  }

  .template-export-button:hover:not(:disabled) {
    background: #eaf3ec;
  }

  .template-fields {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-top: 3px;
    padding-top: 10px;
    border-top: 1px solid #dce4de;
  }

  .template-fields .eyebrow {
    margin-bottom: 2px;
  }

  .template-fields > label {
    margin-top: 3px;
  }

  .template-checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    cursor: pointer;
  }

  .template-checkbox input {
    width: 15px;
    height: 15px;
    flex: 0 0 15px;
    margin: 0;
    accent-color: #287562;
  }

  .template-checkbox span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .template-import-button {
    display: flex;
    width: 100%;
    min-height: 44px;
    align-items: center;
    justify-content: center;
    margin-top: 4px;
    padding: 8px 12px;
    border: 1px solid #bfd1c7;
    border-radius: 5px;
    color: #285e50;
    background: #f6faf6;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    font-weight: 650;
  }

  .template-import-button:hover:not(:disabled) {
    background: #eaf3ec;
  }

  .template-import-button:disabled {
    color: #78877f;
    background: #f0f3f1;
    cursor: not-allowed;
    opacity: 0.7;
  }

  .template-file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    clip-path: inset(50%);
    border: 0;
  }

  .template-message {
    margin: 0;
    color: #236e5d;
    font-size: 11px;
  }

  .template-message.error {
    color: #a64231;
  }

  .template-preview {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 5px;
    padding: 12px;
    border-left: 2px solid #d46b4d;
    background: #f8faf7;
  }

  .template-preview h3 {
    margin: -4px 0 0;
    font-family: Georgia, serif;
    font-size: 17px;
    font-weight: 400;
    overflow-wrap: anywhere;
  }

  .template-preview > p:not(.eyebrow) {
    margin: 0;
    color: #5e6f66;
    font-size: 11px;
  }

  .template-preview dl {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 7px 10px;
    margin: 0;
  }

  .template-preview dl div {
    min-width: 0;
  }

  .template-preview dt {
    color: #819087;
    font-size: 10px;
  }

  .template-preview dd {
    margin: 0;
    color: #31443b;
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .template-preview .template-tags {
    color: #8b513d;
    overflow-wrap: anywhere;
  }

  .template-preview details {
    border-top: 1px solid #dce4de;
    padding-top: 7px;
  }

  .template-preview summary {
    color: #4c6258;
    cursor: pointer;
    font-size: 11px;
    font-weight: 650;
  }

  .template-preview pre {
    max-height: 180px;
    overflow: auto;
    margin: 8px 0 0;
    color: #44554c;
    font-family: "Avenir Next", "Segoe UI", sans-serif;
    font-size: 10px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .template-preview-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .template-preview-actions .connection-button {
    min-height: 35px;
    margin: 0;
    font-size: 11px;
  }

  .template-discard {
    min-height: 30px;
    border: 0;
    color: #65766e;
    background: transparent;
    cursor: pointer;
    font-size: 11px;
  }

  .template-discard:hover {
    color: #1d2926;
    text-decoration: underline;
  }

  .template-editor-dialog {
    width: min(1080px, calc(100vw - 32px));
    overflow: auto;
  }

  .template-editor {
    display: flex;
    flex-direction: column;
    gap: 17px;
    padding: 24px;
  }

  .template-editor-meta {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px 14px;
  }

  .template-editor-meta label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
  }

  .template-output-rules {
    display: grid;
    gap: 8px 16px;
  }

  .template-output-rules > .eyebrow {
    margin: 0;
  }

  .template-output-rule-terms {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 12px;
  }

  .template-output-rule-terms label {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    color: #51645b;
    font-size: 11px;
  }

  .template-output-rule-terms textarea {
    min-height: 66px;
    resize: vertical;
    padding: 7px 9px;
    font-size: 11px;
    line-height: 1.4;
  }

  .template-output-rule-flags {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px 12px;
  }

  .template-sections-editor {
    display: flex;
    min-height: 0;
    flex-direction: column;
    gap: 8px;
  }

  .template-sections-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .template-sections-heading .eyebrow {
    margin: 0;
  }

  .template-section-list {
    display: grid;
    max-height: min(30dvh, 280px);
    overflow: auto;
    margin: 0;
    padding: 0 4px 0 0;
    border-top: 1px solid #dce4de;
    list-style: none;
  }

  .template-section-item {
    display: grid;
    gap: 8px;
    padding: 9px 0;
    border-bottom: 1px solid #dce4de;
  }

  .template-section-item-fields {
    display: grid;
    grid-template-columns: minmax(0, 0.8fr) repeat(2, minmax(0, 1fr));
    gap: 8px 12px;
  }

  .template-section-item-fields label {
    display: grid;
    min-width: 0;
    gap: 4px;
    margin: 0;
    color: #51645b;
    font-size: 11px;
  }

  .template-section-item-fields input {
    width: 100%;
    min-width: 0;
  }

  .template-section-item-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .template-section-order {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .template-section-order button,
  .template-section-delete {
    min-height: 30px;
    padding: 0 9px;
    border: 1px solid #cbd7d0;
    border-radius: 4px;
    color: #335248;
    background: #f8faf8;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 650;
  }

  .template-section-order .template-section-delete {
    border-color: #e4b6a8;
    color: #9a4938;
    background: #fff8f5;
  }

  .template-editor-body {
    display: grid;
    min-height: 0;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: auto minmax(240px, min(36dvh, 340px));
    gap: 7px 16px;
  }

  .template-editor-body > label {
    grid-column: 1 / -1;
    margin: 0;
  }

  .template-editor-body > textarea {
    min-height: 240px;
    resize: vertical;
    padding: 12px;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 12px;
    line-height: 1.55;
  }

  .template-live-preview {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    border-left: 2px solid #d7e7dd;
    background: #f3f8f3;
  }

  .preview-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 11px;
    border-bottom: 1px solid #dce4de;
  }

  .preview-heading h3 {
    margin: 0;
    font-family: Georgia, serif;
    font-size: 16px;
    font-weight: 400;
  }

  .preview-heading span {
    color: #718078;
    font-size: 10px;
    text-align: right;
  }

  .preview-heading .error {
    color: #a64231;
  }

  .template-live-preview pre {
    min-height: 0;
    flex: 1;
    overflow: auto;
    margin: 0;
    padding: 12px;
    color: #34473e;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .template-editor-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }

  .template-editor-actions .connection-button {
    min-width: 160px;
    margin: 0;
    padding: 0 14px;
  }

  .template-editor-actions .template-discard {
    min-height: 40px;
    padding: 0 14px;
    border: 1px solid #cbd7d0;
    border-radius: 5px;
    color: #335248;
    background: #f8faf8;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    text-decoration: none;
  }

  .template-editor-actions .template-discard:hover:not(:disabled) {
    background: #edf3ef;
  }

  label {
    margin-top: 7px;
    color: #495a53;
    font-size: 12px;
    font-weight: 650;
  }

  input:not([type="checkbox"]):not([type="radio"]),
  select,
  textarea {
    width: 100%;
    border: 1px solid #d4ded7;
    border-radius: 5px;
    color: #1d2926;
    background: #fff;
  }

  input:not([type="checkbox"]):not([type="radio"]),
  select {
    height: 39px;
    padding: 0 10px;
  }

  input:focus,
  select:focus,
  textarea:focus {
    border-color: #348c77;
    outline: 3px solid rgba(52, 140, 119, 0.14);
  }

  .connection-button,
  .generate-button,
  .cancel-button {
    display: inline-flex;
    min-height: 40px;
    align-items: center;
    justify-content: center;
    gap: 9px;
    border: 0;
    border-radius: 5px;
    cursor: pointer;
    font-weight: 650;
    transition:
      background-color 160ms ease,
      transform 160ms ease;
  }

  .connection-button {
    margin-top: 11px;
    color: white;
    background: #236e5d;
  }

  .model-picker {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px;
    align-items: center;
  }

  .model-picker select {
    min-width: 0;
  }

  .model-refresh-button {
    min-height: 36px;
    padding: 0 9px;
    border: 1px solid #cbd7d0;
    border-radius: 5px;
    color: #335248;
    background: #f8faf8;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 650;
    white-space: nowrap;
  }

  .model-refresh-button:hover:not(:disabled) {
    background: #edf3ef;
  }

  .model-list-message {
    margin: 5px 0 0;
    color: #236e5d;
    font-size: 11px;
  }

  .model-list-message.error {
    color: #a64231;
  }

  .connection-button:hover:not(:disabled),
  .generate-button:hover:not(:disabled) {
    background: #165747;
    transform: translateY(-1px);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .connection-message {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 2px 0 0;
    color: #236e5d;
    font-size: 12px;
  }

  .connection-message.error,
  .generation-status.error {
    color: #a64231;
  }

  .status-dot,
  .local-indicator {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: currentColor;
  }

  .rail-footer {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-top: auto;
    padding-top: 20px;
    color: #65766e;
    font-size: 12px;
  }

  .local-indicator {
    background: #d46b4d;
    box-shadow: 0 0 0 4px rgba(212, 107, 77, 0.12);
  }

  .work-area {
    display: contents;
    width: 100%;
  }

  .first-run-panel {
    grid-column: 1 / 3;
    grid-row: 1 / 4;
    width: min(100%, 720px);
    margin: auto;
    padding: clamp(24px, 5vw, 48px);
    border-top: 4px solid #d46b4d;
    background: rgba(255, 255, 255, 0.62);
    animation: rise-in 420ms ease-out both;
  }

  .first-run-panel h2 {
    max-width: 12ch;
    margin: 8px 0 12px;
    font-family: Georgia, serif;
    font-size: 30px;
    font-weight: 400;
    line-height: 1.2;
  }

  .first-run-panel > p:not(.eyebrow) {
    max-width: 58ch;
    color: #5e6f66;
  }

  .onboarding-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 18px;
    margin-top: 20px;
  }

  .onboarding-actions .connection-button {
    min-height: 42px;
    margin: 0;
    padding: 0 18px;
  }

  .page-header {
    grid-area: header;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 18px;
    margin: 26px 0 18px;
    animation: rise-in 420ms ease-out both;
  }

  .page-header h2 {
    margin: 5px 0 0;
    font-family: Georgia, serif;
    font-size: 31px;
    font-weight: 400;
    line-height: 1.2;
  }

  .draft-tag {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 6px 10px;
    border: 1px solid #e1c7b8;
    border-radius: 4px;
    color: #96503b;
    background: #fbf1eb;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .draft-tag span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #c66b4e;
  }

  .writing-grid {
    display: contents;
  }

  .source-panel,
  .draft-panel {
    display: flex;
    min-height: 0;
    min-width: 0;
    flex-direction: column;
    overflow-y: auto;
    margin: 0 0 18px;
    padding: 18px;
    border: 1px solid #dce4de;
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.82);
    box-shadow: 0 8px 24px rgba(40, 69, 57, 0.035);
    animation: rise-in 500ms 80ms ease-out both;
  }

  .draft-panel {
    grid-area: output;
    animation-delay: 150ms;
  }

  .source-panel {
    grid-area: inputs;
  }

  .panel-heading {
    display: flex;
    min-height: 49px;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
  }

  .panel-heading h3 {
    margin: 3px 0 0;
    font-family: Georgia, serif;
    font-size: 20px;
    font-weight: 400;
  }

  .field-count,
  .generation-status {
    padding-top: 3px;
    color: #74837b;
    font-size: 11px;
    white-space: nowrap;
  }

  .generation-status {
    color: #236e5d;
    text-align: right;
  }

  .output-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: -3px 0 11px;
    color: #74837b;
    font-size: 11px;
  }

  .preview-toggle {
    display: inline-flex;
    flex: 0 0 auto;
    padding: 2px;
    border: 1px solid #d4ded7;
    border-radius: 5px;
    background: #f4f7f3;
  }

  .preview-toggle button {
    min-height: 29px;
    padding: 0 10px;
    border: 0;
    border-radius: 3px;
    color: #586a61;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 650;
  }

  .preview-toggle button.active {
    color: #1d5547;
    background: white;
    box-shadow: 0 1px 3px rgba(25, 54, 41, 0.14);
  }

  .vision-setting {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-top: 6px;
    color: #496258;
    cursor: pointer;
    font-size: 12px;
  }

  .vision-setting input {
    width: 15px;
    height: 15px;
    flex: 0 0 15px;
    margin: 2px 0 0;
    accent-color: #287562;
  }

  .source-file-input {
    display: none;
  }

  .input-tools {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    margin: 0 0 12px;
  }

  .url-import {
    display: grid;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 7px;
  }

  .input-tool-button {
    min-height: 37px;
    padding: 0 11px;
    border: 1px solid #bfd1c7;
    border-radius: 5px;
    color: #285e50;
    background: #f6faf6;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 650;
    white-space: nowrap;
  }

  .input-tool-button:hover:not(:disabled) {
    background: #eaf3ec;
  }

  .input-tool-button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .url-import input {
    min-width: 0;
    width: 100%;
  }

  .ingest-message {
    margin: 0 0 10px;
    color: #236e5d;
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .ingest-message.error {
    color: #a64231;
  }

  .source-input-list {
    display: grid;
    gap: 7px;
    max-height: 210px;
    overflow: auto;
    margin: 0 0 12px;
    padding: 0;
    list-style: none;
  }

  .source-input-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 5px 10px;
    min-width: 0;
    padding: 9px 10px;
    border-left: 2px solid #d46b4d;
    background: #f7faf6;
  }

  .source-input-meta {
    display: flex;
    min-width: 0;
    justify-content: space-between;
    gap: 8px;
    color: #50665c;
    font-size: 11px;
  }

  .source-input-meta span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-input-meta span:last-child {
    flex: 0 0 auto;
    color: #819087;
  }

  .source-input-details {
    display: flex;
    grid-column: 1 / -1;
    flex-wrap: wrap;
    gap: 5px 10px;
    color: #718078;
    font-size: 10px;
  }

  .source-input-details span {
    overflow-wrap: anywhere;
  }

  .source-input-remove {
    grid-column: 2;
    grid-row: 1;
    align-self: start;
    padding: 0;
    border: 0;
    color: #96503b;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: 10px;
  }

  .source-input-item details {
    grid-column: 1 / -1;
    min-width: 0;
  }

  .source-input-item summary {
    color: #64766d;
    cursor: pointer;
    font-size: 10px;
  }

  .source-input-item pre {
    max-height: 130px;
    overflow: auto;
    margin: 7px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
    font-size: 11px;
  }

  .source-panel textarea {
    min-height: 120px;
    flex: 1;
    resize: vertical;
    padding: 13px 14px;
    font-family: inherit;
    line-height: 1.65;
  }

  textarea::placeholder {
    color: #9aa69f;
  }

  .source-actions {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding-top: 14px;
  }

  .source-actions p {
    max-width: none;
    margin: 0;
    color: #75847c;
    font-size: 11px;
  }

  .source-actions .generate-button,
  .source-actions .cancel-button {
    width: 100%;
  }

  .generate-button {
    min-width: 145px;
    padding: 0 15px;
    color: white;
    background: #236e5d;
  }

  .cancel-button {
    min-width: 100px;
    padding: 0 14px;
    border: 1px solid #e4b6a8;
    color: #9a4938;
    background: #fff8f5;
  }

  .cancel-button:hover {
    background: #f9e9e3;
  }

  .case-discard-button {
    min-height: 34px;
    padding: 0 10px;
    border: 1px solid #e4b6a8;
    border-radius: 5px;
    color: #9a4938;
    background: #fff8f5;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 650;
  }

  .case-discard-button:hover:not(:disabled) {
    background: #f9e9e3;
  }

  .draft-output {
    min-height: 0;
    flex: 1;
    overflow: auto;
    padding: 15px 16px;
    border-left: 2px solid #d7e7dd;
    background: linear-gradient(90deg, #f8fbf8, #fff 30%);
  }

  .draft-output pre {
    margin: 0;
    color: #293a34;
    font-family: "Avenir Next", "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.75;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .rich-output {
    color: #293a34;
    font-family: "Avenir Next", "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.75;
    overflow-wrap: anywhere;
  }

  .rich-output :global(p) {
    margin: 0 0 0.75em;
    white-space: pre-wrap;
  }

  .rich-output :global(h1),
  .rich-output :global(h2),
  .rich-output :global(h3),
  .rich-output :global(h4),
  .rich-output :global(h5),
  .rich-output :global(h6) {
    margin: 1em 0 0.45em;
    color: #243a32;
    font-size: 1.05em;
    line-height: 1.4;
  }

  .rich-output :global(ul),
  .rich-output :global(ol) {
    margin: 0.25em 0 0.75em;
    padding-left: 1.5em;
  }

  .rich-output :global(li) {
    padding-left: 0.2em;
  }

  .rich-output :global(blockquote) {
    margin: 0.5em 0 0.75em;
    padding-left: 0.9em;
    border-left: 2px solid #b7cfc0;
    color: #53675f;
  }

  .rich-output :global(code),
  .rich-output :global(pre) {
    font-family: ui-monospace, monospace;
    overflow-wrap: anywhere;
  }

  .draft-output .linted-line {
    text-decoration: underline wavy #d46b4d;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }

  .lint-warnings {
    margin-top: 12px;
    padding: 12px 14px;
    border-left: 3px solid #d46b4d;
    color: #704838;
    background: #fbf1eb;
  }

  .lint-warnings p {
    margin: 0 0 5px;
    font-size: 12px;
    font-weight: 700;
  }

  .lint-warnings ul {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .lint-jump {
    padding: 0;
    border: 0;
    color: #704838;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    text-align: left;
    overflow-wrap: anywhere;
  }

  .lint-jump:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .lint-regenerate-button {
    min-height: 34px;
    margin-top: 9px;
    padding: 0 10px;
    border: 1px solid #d3a390;
    border-radius: 5px;
    color: #704838;
    background: rgba(255, 255, 255, 0.65);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 700;
  }

  .lint-regenerate-button:hover:not(:disabled) {
    background: white;
  }

  .review-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 16px;
  }

  .review-confirmation {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    gap: 9px;
    margin: 0;
    color: #354b41;
    cursor: pointer;
    font-size: 12px;
    font-weight: 650;
  }

  .review-confirmation input {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
    margin: 2px 0 0;
    accent-color: #287562;
  }

  .review-confirmation span {
    overflow-wrap: anywhere;
  }

  .review-copy-button {
    min-height: 42px;
    max-width: 100%;
    padding: 8px 14px;
    border: 0;
    border-radius: 5px;
    color: white;
    background: #236e5d;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    overflow-wrap: anywhere;
  }

  .review-copy-button:hover:not(:disabled) {
    background: #165747;
  }

  .review-copy-button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .empty-state {
    margin: 4px 0;
    color: #95a29b;
    font-family: Georgia, serif;
    font-size: 17px;
    font-style: italic;
  }

  .typing-dots {
    display: inline-block;
    width: 22px;
    overflow: hidden;
    vertical-align: bottom;
    animation: ellipsis 1.1s steps(4, end) infinite;
  }

  .work-footer {
    grid-area: footer;
    display: flex;
    justify-content: space-between;
    gap: 14px;
    margin-top: auto;
    padding: 26px 0 16px;
    color: #77857e;
    font-size: 11px;
  }

  @keyframes rise-in {
    from {
      opacity: 0;
      transform: translateY(7px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes ellipsis {
    to {
      width: 0;
    }
  }

  @media (max-width: 1120px) {
    .app-shell {
      height: auto;
      min-height: 100vh;
      overflow: visible;
      grid-template-columns: minmax(250px, 0.9fr) minmax(0, 1.1fr);
      grid-template-rows: auto auto auto auto;
      grid-template-areas:
        "header header"
        "inputs output"
        "controls controls"
        "footer footer";
      padding: 0 20px;
    }

    .provider-rail {
      min-height: auto;
      overflow: visible;
      padding: 18px 0;
      border-top: 1px solid #dce4de;
      border-left: 0;
    }

    .active-provider {
      margin-top: 16px;
    }

    .template-settings {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: start;
      gap: 9px 14px;
    }

    .template-heading,
    .template-fields,
    .template-section-fields,
    .template-preview,
    .controls-actions,
    .template-message,
    .generation-status {
      grid-column: 1 / -1;
    }

    .first-run-panel {
      grid-column: 1 / -1;
      grid-row: 1 / 4;
    }

    .draft-output {
      min-height: 354px;
    }
  }

  @media (max-width: 720px) {
    .app-shell {
      height: auto;
      min-height: 100vh;
      overflow: visible;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto auto auto auto auto;
      grid-template-areas:
        "header"
        "inputs"
        "output"
        "controls"
        "footer";
      gap: 0;
      padding: 0 14px;
    }

    .provider-rail {
      min-height: auto;
      overflow: visible;
      padding: 17px 0;
      border-top: 1px solid #dce4de;
    }

    .template-settings {
      grid-template-columns: minmax(0, 1fr);
      margin-top: 18px;
      padding-top: 15px;
    }

    .template-section-item-fields {
      grid-template-columns: minmax(0, 1fr);
    }

    .template-section-item-controls {
      align-items: stretch;
      flex-direction: column;
    }

    .template-section-order {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .template-heading,
    .template-fields,
    .template-section-fields,
    .template-preview,
    .controls-actions,
    .template-message,
    .generation-status {
      grid-column: 1;
    }

    .rail-footer {
      display: none;
    }

    .page-header {
      align-items: flex-start;
      margin: 20px 0 14px;
    }

    .page-header h2 {
      max-width: 250px;
      font-size: 27px;
    }

    .source-panel,
    .draft-panel {
      min-height: 0;
      margin-bottom: 13px;
      padding: 14px;
    }

    .source-panel textarea {
      min-height: 210px;
    }

    .input-tools {
      grid-template-columns: 1fr;
    }

    .work-footer {
      flex-direction: column;
      gap: 4px;
      padding: 10px 0 16px;
    }

    .first-run-panel {
      grid-column: 1;
      grid-row: 1;
      width: 100%;
      margin: 18px 0;
      padding: 22px;
    }

    .template-editor {
      padding: 17px;
    }

    .template-editor-meta {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .template-output-rule-terms,
    .template-output-rule-flags {
      grid-template-columns: minmax(0, 1fr);
    }

    .template-editor-body {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(220px, min(32dvh, 320px)) minmax(
          220px,
          min(32dvh, 320px)
        );
    }

    .template-editor-body > label {
      grid-column: 1;
    }

    .settings-dialog {
      padding: 18px;
    }

    .template-editor-actions {
      flex-wrap: wrap;
    }

    .template-editor-actions .connection-button {
      flex: 1 1 170px;
    }
  }

  @media (prefers-color-scheme: dark) {
    :global(body) {
      color: #e3ebe5;
      background: #151f1a;
    }

    .app-shell {
      color: #e3ebe5;
      background:
        radial-gradient(ellipse at 88% 10%, rgba(54, 82, 66, 0.34), transparent 30%),
        #151f1a;
    }

    .provider-rail {
      border-color: #34463b;
      background: rgba(24, 36, 29, 0.62);
    }

    .active-provider,
    .source-input-item,
    .preview-toggle {
      background: #1d2c23;
    }

    .provider-summary dd,
    .template-preview dd,
    .draft-output pre,
    .rich-output,
    .review-confirmation,
    .source-input-item pre {
      color: #dce7df;
    }

    .provider-summary dt,
    .template-empty,
    .source-input-meta,
    .source-input-details,
    .source-input-item summary,
    .source-actions p,
    .work-footer {
      color: #a7b7ad;
    }

    .brand,
    .provider-settings h1,
    .template-heading h2,
    .page-header h2,
    .panel-heading h3,
    .first-run-panel h2 {
      color: #eef3ef;
    }

    .source-panel,
    .draft-panel,
    .first-run-panel {
      border-color: #34463b;
      color: #e3ebe5;
      background: rgba(27, 41, 33, 0.94);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
    }

    input,
    select,
    textarea {
      border-color: #45584c;
      color: #e3ebe5;
      background: #18251d;
    }

    input:focus,
    select:focus,
    textarea:focus {
      border-color: #75b29b;
      outline-color: rgba(117, 178, 155, 0.22);
    }

    .draft-output {
      border-color: #476454;
      background: linear-gradient(90deg, #1b2a21, #202e26 30%);
    }

    .empty-state,
    .field-count,
    .generation-status,
    .setting-hint {
      color: #a1b0a7;
    }

    .template-fields,
    .template-section-fields,
    .template-settings,
    .template-section-list,
    .template-section-item,
    .template-preview details,
    .provider-settings,
    .controls-actions {
      border-color: #34463b;
    }

    .template-section-item-fields label,
    .template-output-rule-terms label {
      color: #a7b7ad;
    }

    .template-section-order button {
      border-color: #45584c;
      color: #dce7df;
      background: #1d2c23;
    }

    .template-section-order .template-section-delete {
      border-color: #8a574b;
      color: #f2b6a8;
      background: #382922;
    }

    .template-preview,
    .template-live-preview {
      background: #1b2a21;
    }

    .template-preview h3,
    .template-preview pre,
    .template-live-preview pre {
      color: #dce7df;
    }

    .template-preview > p:not(.eyebrow),
    .template-preview summary,
    .first-run-panel > p:not(.eyebrow) {
      color: #a7b7ad;
    }

    .settings-dialog,
    .template-editor-dialog {
      border-color: #45584c;
      color: #e3ebe5;
      background: #1a2820;
    }

    .dialog-heading p:not(.eyebrow),
    .preview-heading span {
      color: #a7b7ad;
    }

    .preview-heading {
      border-color: #34463b;
    }

    .preview-heading h3 {
      color: #e3ebe5;
    }

    .preview-toggle {
      border-color: #45584c;
    }

    .preview-toggle button {
      color: #b2c1b7;
    }

    .preview-toggle button.active {
      color: #1d5547;
      background: #dcebe1;
    }

    .input-tool-button,
    .model-refresh-button,
    .template-export-button {
      border-color: #496354;
      color: #c5e0d1;
      background: #203329;
    }

    .input-tool-button:hover:not(:disabled),
    .model-refresh-button:hover:not(:disabled),
    .template-export-button:hover:not(:disabled) {
      background: #294637;
    }

    .draft-tag {
      border-color: #805640;
      color: #f0b89a;
      background: #3b2b22;
    }

    .case-discard-button,
    .cancel-button {
      border-color: #805447;
      color: #ffc2ae;
      background: #38251f;
    }

    .lint-warnings {
      border-color: #c77b59;
      color: #f1c6ae;
      background: #382921;
    }

    .lint-jump {
      color: #f1c6ae;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
