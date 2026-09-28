<script lang="ts">
  import { onMount } from "svelte";
  import { isTauri } from "@tauri-apps/api/core";
  import { load as loadStore } from "@tauri-apps/plugin-store";
  import {
    commands,
    events,
    type ClinicalTemplate,
    type LlmError,
    type ProviderAdapter,
    type ProviderProfile,
    type TemplateError,
  } from "../bindings";

  const providerNames: Record<ProviderAdapter, string> = {
    open_ai: "OpenAI",
    anthropic: "Anthropic",
    gemini: "Gemini",
    ollama: "Ollama",
    open_ai_compatible: "OpenAI compatible",
  };

  const errorMessages: Record<LlmError["key"], string> = {
    invalid_profile: "Check the provider settings.",
    invalid_request: "The request could not be sent.",
    authentication: "The provider credentials were not accepted.",
    network: "The provider could not be reached.",
    model: "The model rejected the request or returned no text.",
    quota: "The provider quota was exceeded.",
    cancelled: "Generation was cancelled.",
    internal: "The request could not be completed.",
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
  };

  const maxTemplateBytes = 1_048_576;
  let templateStore: Awaited<ReturnType<typeof loadStore>> | null = null;
  let templateFileInput: HTMLInputElement | undefined;
  let importedTemplates = $state<ClinicalTemplate[]>([]);
  let templateLibraryReady = $state(false);
  let activeTemplateId = $state("");
  let templateValues = $state<Record<string, string | boolean>>({});
  let templateSectionStates = $state<Record<string, boolean>>({});
  let pendingTemplate = $state<ClinicalTemplate | null>(null);
  let templateMessage = $state("");
  let templateIsError = $state(false);
  let templateBusy = $state(false);

  let adapter = $state<ProviderAdapter>("ollama");
  let model = $state("llama3.2");
  let endpoint = $state("");
  let credentialId = $state("");
  let prompt = $state("");
  let draft = $state("");
  let activeRequestId = $state<string | null>(null);
  let connectionState = $state<"idle" | "checking" | "ready" | "error">("idle");
  let connectionMessage = $state("");
  let generationMessage = $state("");
  let generationIsError = $state(false);
  let isPreparingGeneration = $state(false);
  let desktopAvailable = $state(false);

  const isGenerating = $derived(activeRequestId !== null);
  const enabledSectionCount = $derived(
    Object.values(templateSectionStates).filter(Boolean).length,
  );
  const activeTemplate = $derived(
    importedTemplates.find((template) => template.metadata.id === activeTemplateId) ?? null,
  );
  const isFirstRun = $derived(
    desktopAvailable && templateLibraryReady && importedTemplates.length === 0,
  );

  function createProfile(): ProviderProfile {
    const keychainId = credentialId.trim();
    return {
      id: "active-provider",
      display_name: providerNames[adapter],
      adapter,
      model: model.trim(),
      endpoint: endpoint.trim() || (adapter === "ollama" ? "http://localhost:11434" : null),
      auth: keychainId ? { source: "keychain", credential_id: keychainId } : { source: "none" },
      capabilities: { vision: false, streaming: true, max_context: null },
      generation: { temperature: 0.2, max_tokens: 2048 },
    };
  }

  function formatError(error: LlmError): string {
    return errorMessages[error.key];
  }

  function formatTemplateError(error: TemplateError): string {
    return templateErrorMessages[error.key];
  }

  function initialTemplateValues(template: ClinicalTemplate): Record<string, string | boolean> {
    return Object.fromEntries(
      template.variables.map((variable) => [
        variable.name,
        variable.default?.value ?? (variable.kind === "boolean" ? false : ""),
      ]),
    );
  }

  function initialTemplateSectionStates(template: ClinicalTemplate): Record<string, boolean> {
    return Object.fromEntries(
      template.sections.map((section) => [section.id, section.enabled_by_default]),
    );
  }

  function activateTemplate(templateId: string) {
    activeTemplateId = templateId;
    const template = importedTemplates.find((saved) => saved.metadata.id === templateId);
    templateValues = template ? initialTemplateValues(template) : {};
    templateSectionStates = template ? initialTemplateSectionStates(template) : {};
  }

  function templateVariableLabel(variable: ClinicalTemplate["variables"][number]): string {
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

  function sectionsForRendering(template: ClinicalTemplate): string[] {
    return orderedTemplateSections(template)
      .filter((section) => templateSectionStates[section.id])
      .map((section) => section.id);
  }

  function valuesForRendering(template: ClinicalTemplate): Record<string, string | boolean> {
    return Object.fromEntries(
      template.variables
        .filter(
          (variable) =>
            variable.kind !== "select" || templateValues[variable.name] !== "",
        )
        .map((variable) => [variable.name, templateValues[variable.name]]),
    );
  }

  async function getTemplateStore() {
    templateStore ??= await loadStore("templates.json", {
      autoSave: false,
      defaults: { templates: [] },
    });
    return templateStore;
  }

  async function restoreTemplates() {
    const store = await getTemplateStore();
    const savedTemplates = (await store.get<unknown[]>("templates")) ?? [];
    const validatedTemplates: ClinicalTemplate[] = [];

    for (const savedTemplate of savedTemplates) {
      const serialized = JSON.stringify(savedTemplate);
      if (!serialized) continue;
      const bytes = new TextEncoder().encode(serialized);
      const result = await commands.validateTemplate(Array.from(bytes));
      if (result.status === "ok") validatedTemplates.push(result.data);
    }

    importedTemplates = validatedTemplates;
    activateTemplate(validatedTemplates[0]?.metadata.id ?? "");
  }

  async function importTemplate(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
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
        ...importedTemplates.filter((saved) => saved.metadata.id !== template.metadata.id),
        template,
      ];
      const store = await getTemplateStore();
      await store.set("templates", updatedTemplates);
      await store.save();
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

  function exportActiveTemplate() {
    if (!activeTemplate) return;
    try {
      const serialized = JSON.stringify(activeTemplate, null, 2);
      const blob = new Blob([serialized], { type: "application/json" });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const filename = activeTemplate.metadata.id.replace(/[^A-Za-z0-9._-]/g, "_");
      link.href = objectUrl;
      link.download = `${filename || "template"}.epitpl`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      templateMessage = "Template exported";
      templateIsError = false;
    } catch {
      templateMessage = "The template could not be exported.";
      templateIsError = true;
    }
  }

  onMount(() => {
    desktopAvailable = isTauri();
    if (!desktopAvailable) return;
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

    return () => {
      disposed = true;
      unlisten.forEach((stop) => stop());
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
    try {
      const result = await commands.testProvider(createProfile());
      connectionState = result.status === "ok" ? "ready" : "error";
      connectionMessage = result.status === "ok" ? "Connected" : formatError(result.error);
    } catch {
      connectionState = "error";
      connectionMessage = "The connection check failed.";
    }
  }

  async function generateDraft() {
    const source = prompt.trim();
    if (!source || isGenerating || isPreparingGeneration) return;
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
    generationMessage = "Preparing template";
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
    } catch {
      generationMessage = "The active template could not be rendered.";
      generationIsError = true;
      return;
    } finally {
      isPreparingGeneration = false;
    }

    const requestId = crypto.randomUUID();
    activeRequestId = requestId;
    generationMessage = "Generating";
    generationIsError = false;
    draft = "";
    try {
      const result = await commands.generate(requestId, createProfile(), [
        { role: "system", content: systemPrompt },
        { role: "user", content: source },
      ]);
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
</script>

<svelte:head>
  <title>Epikrise | Draft workspace</title>
  <meta name="theme-color" content="#f2f5f1" />
</svelte:head>

<div class="app-shell">
  <aside class="provider-rail" aria-label="Provider settings">
    <a class="brand" href="/" aria-label="Epikrise home">
      <span class="brand-mark" aria-hidden="true">E</span>
      <span class="brand-name">Epikrise</span>
    </a>

    <section class="provider-settings">
      <p class="eyebrow">Workspace</p>
      <h1>Connection</h1>

      <label for="adapter">Provider</label>
      <select id="adapter" bind:value={adapter}>
        <option value="ollama">Ollama</option>
        <option value="open_ai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
        <option value="gemini">Gemini</option>
        <option value="open_ai_compatible">OpenAI compatible</option>
      </select>

      <label for="model">Model</label>
      <input id="model" bind:value={model} autocomplete="off" />

      <label for="endpoint">Endpoint</label>
      <input
        id="endpoint"
        bind:value={endpoint}
        autocomplete="url"
        spellcheck="false"
        placeholder={adapter === "ollama" ? "http://localhost:11434" : "Provider default"}
      />

      <label for="credential">Keychain ID</label>
      <input id="credential" bind:value={credentialId} autocomplete="off" spellcheck="false" />

      <button class="connection-button" onclick={testProvider} disabled={connectionState === "checking"}>
        {connectionState === "checking" ? "Checking..." : "Check connection"}
      </button>

      {#if connectionMessage}
        <p class="connection-message" class:error={connectionState === "error"} role="status">
          <span class="status-dot" aria-hidden="true"></span>
          {connectionMessage}
        </p>
      {/if}
    </section>

    <section class="template-settings" aria-labelledby="templates-title">
      <div class="template-heading">
        <p class="eyebrow">Template library</p>
        <h2 id="templates-title">My templates</h2>
      </div>

      {#if importedTemplates.length}
        <label for="active-template">Active template</label>
        <select
          id="active-template"
          value={activeTemplateId}
          onchange={(event) => activateTemplate(event.currentTarget.value)}
        >
          {#each importedTemplates as template (template.metadata.id)}
            <option value={template.metadata.id}>{template.metadata.name}</option>
          {/each}
        </select>
        <button
          class="template-export-button"
          onclick={exportActiveTemplate}
          disabled={templateBusy || !activeTemplate}
        >
          Export .epitpl
        </button>
      {:else}
        <p class="template-empty">No templates imported</p>
      {/if}

      {#if activeTemplate?.variables.length}
        <div class="template-fields">
          <p class="eyebrow">Template fields</p>
          {#each activeTemplate.variables as variable (variable.name)}
            {@const fieldId = `template-variable-${variable.name}`}
            {#if variable.kind === "boolean"}
              <label class="template-checkbox" for={fieldId}>
                <input
                  id={fieldId}
                  type="checkbox"
                  checked={templateValues[variable.name] === true}
                  aria-required={variable.required}
                  onchange={(event) =>
                    (templateValues = {
                      ...templateValues,
                      [variable.name]: event.currentTarget.checked,
                    })}
                />
                <span
                  >{templateVariableLabel(variable)}{variable.required ? " *" : ""}</span
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
                  aria-required={variable.required}
                  onchange={(event) =>
                    (templateValues = {
                      ...templateValues,
                      [variable.name]: event.currentTarget.value,
                    })}
                >
                  <option value="" disabled={variable.required}>Select...</option>
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
                  aria-required={variable.required}
                  required={variable.required}
                  onchange={(event) =>
                    (templateValues = {
                      ...templateValues,
                      [variable.name]: event.currentTarget.value,
                    })}
                />
              {/if}
            {/if}
          {/each}
        </div>
      {/if}

      {#if activeTemplate?.sections.length}
        <div class="template-fields template-section-fields">
          <p class="eyebrow">Sections</p>
          {#each orderedTemplateSections(activeTemplate) as section (section.id)}
            {@const sectionInputId = `template-section-${section.id}`}
            <label class="template-checkbox" for={sectionInputId}>
              <input
                id={sectionInputId}
                type="checkbox"
                checked={templateSectionStates[section.id] === true}
                disabled={
                  templateSectionStates[section.id] === true && enabledSectionCount <= 1
                }
                onchange={(event) =>
                  (templateSectionStates = {
                    ...templateSectionStates,
                    [section.id]: event.currentTarget.checked,
                  })}
              />
              <span>{templateSectionLabel(section)}</span>
            </label>
          {/each}
        </div>
      {/if}

      <label class="template-file-label" for="template-file">
        {templateBusy ? "Working..." : "Import .epitpl"}
      </label>
      <input
        id="template-file"
        class="template-file-input"
        type="file"
        accept=".epitpl,application/json"
        bind:this={templateFileInput}
        onchange={importTemplate}
        disabled={templateBusy}
      />

      {#if templateMessage}
        <p class="template-message" class:error={templateIsError} role="status">{templateMessage}</p>
      {/if}

      {#if pendingTemplate && !isFirstRun}
        <div class="template-preview" aria-label="Template preview">
          <p class="eyebrow">Review import</p>
          <h3>{pendingTemplate.metadata.name}</h3>
          <p>{pendingTemplate.metadata.description}</p>
          <dl>
            <div><dt>Locale</dt><dd>{pendingTemplate.metadata.locale}</dd></div>
            <div><dt>Version</dt><dd>{pendingTemplate.metadata.version}</dd></div>
            <div><dt>Variables</dt><dd>{pendingTemplate.variables.length}</dd></div>
            <div><dt>Sections</dt><dd>{pendingTemplate.sections.length}</dd></div>
          </dl>
          {#if pendingTemplate.metadata.specialty_tags.length}
            <p class="template-tags">{pendingTemplate.metadata.specialty_tags.join(" · ")}</p>
          {/if}
          <details>
            <summary>System prompt</summary>
            <pre>{pendingTemplate.system_prompt}</pre>
          </details>
          <div class="template-preview-actions">
            <button class="connection-button" onclick={savePendingTemplate} disabled={templateBusy}>
              Save template
            </button>
            <button class="template-discard" onclick={() => (pendingTemplate = null)} disabled={templateBusy}>
              Cancel
            </button>
          </div>
        </div>
      {/if}
    </section>

    <footer class="rail-footer">
      <span class="local-indicator" aria-hidden="true"></span>
      <span>{desktopAvailable ? "Desktop session" : "Preview session"}</span>
    </footer>
  </aside>

  <main class="work-area">
    {#if isFirstRun}
      <section class="first-run-panel" aria-labelledby="first-run-title">
        <p class="eyebrow">Getting started / Template setup</p>
        <h2 id="first-run-title">Bring your clinical template</h2>
        <p>
          Institutional templates are not included. Import an .epitpl file, or use the generic
          starter and adapt it later. Case content and template field values stay in memory only.
        </p>

        {#if pendingTemplate}
          <div class="first-run-review">
            <div>
              <span class="eyebrow">Ready to save</span>
              <h3>{pendingTemplate.metadata.name}</h3>
              <p>{pendingTemplate.metadata.description}</p>
            </div>
            <dl>
              <div><dt>Locale</dt><dd>{pendingTemplate.metadata.locale}</dd></div>
              <div><dt>Sections</dt><dd>{pendingTemplate.sections.length}</dd></div>
            </dl>
            <details>
              <summary>Review system prompt</summary>
              <pre>{pendingTemplate.system_prompt}</pre>
            </details>
            <div class="onboarding-actions">
              <button class="connection-button" onclick={savePendingTemplate} disabled={templateBusy}>
                {templateBusy ? "Saving..." : "Save and continue"}
              </button>
              <button
                class="template-discard"
                onclick={() => (pendingTemplate = null)}
                disabled={templateBusy}
              >
                Choose another
              </button>
            </div>
          </div>
        {:else}
          <div class="onboarding-actions">
            <button
              class="connection-button"
              onclick={() => templateFileInput?.click()}
              disabled={templateBusy}
            >
              {templateBusy ? "Working..." : "Import .epitpl"}
            </button>
            <button
              class="onboarding-secondary"
              onclick={createGenericStarter}
              disabled={templateBusy}
            >
              Use generic starter
            </button>
          </div>
          {#if templateMessage}
            <p class="template-message" class:error={templateIsError} role="status">
              {templateMessage}
            </p>
          {/if}
        {/if}
      </section>
    {:else}
    <header class="page-header">
      <div>
        <p class="eyebrow">Clinical writing</p>
        <h2>New discharge summary</h2>
      </div>
      <span class="draft-tag"><span aria-hidden="true"></span> Draft</span>
    </header>

    <div class="writing-grid">
      <section class="source-panel" aria-labelledby="source-title">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">01 / Source</p>
            <h3 id="source-title">Clinical material</h3>
          </div>
          <span class="field-count">{prompt.length} chars</span>
        </div>

        <textarea
          id="source-material"
          bind:value={prompt}
          placeholder="Paste anonymized notes, findings, and relevant history..."
          aria-label="Anonymized clinical material"
        ></textarea>

        <div class="source-actions">
          <p>Use anonymized clinical material.</p>
          {#if isGenerating}
            <button class="cancel-button" onclick={cancelGeneration} aria-label="Cancel generation">
              Cancel
            </button>
          {:else}
            <button
              class="generate-button"
              onclick={generateDraft}
              disabled={!prompt.trim() || !activeTemplate || isPreparingGeneration}
            >
              <span aria-hidden="true">↗</span>
              {isPreparingGeneration ? "Preparing..." : "Generate draft"}
            </button>
          {/if}
        </div>
      </section>

      <section class="draft-panel" aria-labelledby="draft-title">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">02 / Review</p>
            <h3 id="draft-title">Generated summary</h3>
          </div>
          {#if generationMessage}
            <span class="generation-status" class:error={generationIsError}>
              {generationMessage}
            </span>
          {/if}
        </div>

        <article class="draft-output" aria-live="polite" aria-busy={isGenerating}>
          {#if draft}
            <pre>{draft}</pre>
          {:else if isGenerating}
            <p class="empty-state">Preparing draft<span class="typing-dots" aria-hidden="true">...</span></p>
          {:else}
            <p class="empty-state">No draft yet</p>
          {/if}
        </article>
      </section>
    </div>

    <footer class="work-footer">
      <span>Review generated text before use in the medical record.</span>
      <span>Epikrise <span class="footer-separator">/</span> Workspace</span>
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
    grid-template-columns: 278px minmax(0, 1fr);
    min-height: 100vh;
    background:
      radial-gradient(ellipse at 88% 10%, rgba(215, 229, 218, 0.55), transparent 30%),
      #f2f5f1;
  }

  .provider-rail {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    padding: 27px 22px 18px;
    border-right: 1px solid #dce4de;
    background: rgba(249, 251, 248, 0.8);
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

  .provider-settings {
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin-top: 58px;
  }

  .eyebrow {
    margin: 0;
    color: #6b7b74;
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
    margin-top: 25px;
    padding-top: 19px;
    border-top: 1px solid #dce4de;
  }

  .template-heading h2 {
    margin: 3px 0 4px;
    font-family: Georgia, serif;
    font-size: 20px;
    font-weight: 400;
  }

  .template-empty {
    margin: 0;
    color: #829088;
    font-size: 12px;
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

  .template-file-label {
    display: inline-flex;
    min-height: 36px;
    align-items: center;
    justify-content: center;
    margin-top: 4px;
    border: 1px solid #bfd1c7;
    border-radius: 5px;
    color: #285e50;
    background: #f6faf6;
    cursor: pointer;
    font-size: 12px;
    font-weight: 650;
  }

  .template-file-label:hover {
    background: #eaf3ec;
  }

  .template-file-input {
    height: auto;
    padding: 7px;
    font-size: 11px;
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

  label {
    margin-top: 7px;
    color: #495a53;
    font-size: 12px;
    font-weight: 650;
  }

  input,
  select,
  textarea {
    width: 100%;
    border: 1px solid #d4ded7;
    border-radius: 5px;
    color: #1d2926;
    background: #fff;
  }

  input,
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
    transition: background-color 160ms ease, transform 160ms ease;
  }

  .connection-button {
    margin-top: 11px;
    color: white;
    background: #236e5d;
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
    display: flex;
    width: min(100%, 1440px);
    flex-direction: column;
    margin: 0 auto;
    padding: 38px clamp(24px, 5vw, 76px) 20px;
  }

  .first-run-panel {
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

  .first-run-review {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 24px;
    padding-top: 18px;
    border-top: 1px solid #dce4de;
  }

  .first-run-review h3 {
    margin: 4px 0;
    font-family: Georgia, serif;
    font-size: 20px;
    font-weight: 400;
    overflow-wrap: anywhere;
  }

  .first-run-review p {
    margin: 0;
    color: #5e6f66;
  }

  .first-run-review dl {
    display: flex;
    gap: 28px;
    margin: 0;
  }

  .first-run-review dt {
    color: #819087;
    font-size: 11px;
  }

  .first-run-review dd {
    margin: 0;
  }

  .first-run-review details {
    padding-top: 12px;
    border-top: 1px solid #dce4de;
  }

  .first-run-review summary {
    color: #4c6258;
    cursor: pointer;
    font-weight: 650;
  }

  .first-run-review pre {
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
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

  .onboarding-secondary {
    min-height: 40px;
    padding: 0 8px;
    border: 0;
    color: #50665c;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-weight: 650;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .onboarding-secondary:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .page-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 27px;
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
    display: grid;
    grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
    gap: 20px;
    align-items: stretch;
  }

  .source-panel,
  .draft-panel {
    display: flex;
    min-width: 0;
    flex-direction: column;
    padding: 21px;
    border: 1px solid #dce4de;
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.82);
    box-shadow: 0 8px 24px rgba(40, 69, 57, 0.035);
    animation: rise-in 500ms 80ms ease-out both;
  }

  .draft-panel {
    animation-delay: 150ms;
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

  .source-panel textarea {
    min-height: 282px;
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
    min-height: 60px;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
    padding-top: 14px;
  }

  .source-actions p {
    max-width: 210px;
    margin: 0;
    color: #75847c;
    font-size: 11px;
  }

  .generate-button {
    min-width: 145px;
    padding: 0 15px;
    color: white;
    background: #236e5d;
  }

  .generate-button span {
    font-size: 17px;
    line-height: 1;
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

  .draft-output {
    min-height: 354px;
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
    display: flex;
    justify-content: space-between;
    gap: 14px;
    margin-top: auto;
    padding-top: 26px;
    color: #77857e;
    font-size: 11px;
  }

  .footer-separator {
    padding: 0 4px;
    color: #c56a4f;
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

  @media (max-width: 940px) {
    .app-shell {
      grid-template-columns: 240px minmax(0, 1fr);
    }

    .work-area {
      padding-right: 24px;
      padding-left: 24px;
    }

    .writing-grid {
      grid-template-columns: 1fr;
    }

    .draft-output {
      min-height: 260px;
    }
  }

  @media (max-width: 640px) {
    .app-shell {
      grid-template-columns: 1fr;
    }

    .provider-rail {
      min-height: auto;
      padding: 15px 18px 17px;
      border-right: 0;
      border-bottom: 1px solid #dce4de;
    }

    .provider-settings {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px 12px;
      margin-top: 19px;
    }

    .provider-settings .eyebrow,
    .provider-settings h1,
    .connection-button,
    .connection-message {
      grid-column: 1 / -1;
    }

    .provider-settings h1 {
      margin-bottom: 1px;
    }

    .template-settings {
      margin-top: 17px;
      padding-top: 15px;
    }

    .rail-footer {
      display: none;
    }

    .work-area {
      padding: 25px 16px 16px;
    }

    .page-header {
      align-items: flex-start;
      margin-bottom: 18px;
    }

    .page-header h2 {
      max-width: 250px;
      font-size: 27px;
    }

    .source-panel,
    .draft-panel {
      padding: 16px;
    }

    .source-panel textarea {
      min-height: 210px;
    }

    .source-actions p {
      max-width: 130px;
    }

    .generate-button {
      min-width: 132px;
      padding: 0 10px;
    }

    .work-footer {
      flex-direction: column;
      gap: 4px;
      padding-top: 20px;
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
