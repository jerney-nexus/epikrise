---
title: Privacy Policy for Epikrise
permalink: /privacy-policy/en/
---

# Privacy Policy for Epikrise

Language: English · [Deutsch](https://jerney-nexus.github.io/epikrise/privacy-policy/de/) · [Français](https://jerney-nexus.github.io/epikrise/privacy-policy/fr/) · [Italiano](https://jerney-nexus.github.io/epikrise/privacy-policy/it/) · [Español](https://jerney-nexus.github.io/epikrise/privacy-policy/es/)

Last updated: 2026-11-08

Publisher: Pascal Jerney, Unterdorfstrasse 7, 3322 Urtenen-Schönbühl, Switzerland

Contact for privacy questions: admin@jerney.nexus

## 1. Scope

This policy applies to the Epikrise desktop app (Windows, macOS, Linux), which you install locally on your device. It takes into account the Swiss Federal Act on Data Protection (revFADP) and, where applicable, the EU General Data Protection Regulation (GDPR).

## 2. No collection by the publisher

Epikrise does not operate its own backend. There are no user accounts, no telemetry, no analytics tools, and no transmission of usage data to the publisher. The publisher therefore does not receive any personal data from your use of the app.

## 3. Processing on your device

The app processes the content you enter or import (texts, documents, images, PDF files, tables, and web page content) on your device. The only exception is sending case content to a remote AI endpoint, which happens only after you confirm it (see section 5). Cases and generated outputs are held in memory; temporary files for text recognition are covered in the next paragraph. When you discard a case or close the app, the internal case state is cleared. Not covered by this are form values, such as template field entries, and text you copied to the clipboard yourself; these remain until you change them or the clipboard is overwritten. No history is stored.

For text recognition (OCR), temporary image files may be created in private temporary directories. These are overwritten before deletion. However, the operating system and runtime environment may keep copies, so secure forensic deletion cannot be guaranteed.

## 4. Stored settings and credentials

- Imported templates are stored locally in the app.
- API keys are stored in the operating system's keychain (on Linux, via the Secret Service).
- Provider, model, endpoint, and output and reasoning settings are not permanently stored by the current interface.

## 5. Transmission to AI providers

To generate drafts, the prepared material and your template are sent to the model provider you choose. The supported providers are OpenAI, Anthropic, Google Gemini, xAI, Groq, OpenRouter, and OpenAI-compatible or Ollama endpoints. If the endpoint is local (for example, Ollama on localhost), the data does not leave your device. For remote endpoints, the privacy terms of that provider apply. Before case content is first sent to a remote endpoint, the app asks you to confirm the provider and endpoint. This confirmation applies only to that case and that provider and endpoint; for another case, provider, or endpoint, it is requested again. Without your confirmation, no case content is sent. The publisher does not receive this data and is not a party to your contract with the provider.

Independently of case confirmation, the app can run two functions that contact remote endpoints: retrieving the model list and the connection test. These send your IP address and, if configured, your stored API key to the endpoint. The connection test may also send a short test request with the fixed text "Reply with OK." No case content is sent in these requests.

## 6. Other network access

- **URL import:** A URL you specify is fetched directly and converted into readable text. Administrators can disable this.
- **Update check:** If the update feature is enabled, the app downloads update information from GitHub. This transmits your IP address to GitHub. The feature is optional.

## 7. No anonymization by the app

Epikrise does not anonymize or pseudonymize content and does not detect identifying information. You are responsible for using only material that you are lawfully permitted to process. Under the revFADP, health data is considered particularly sensitive personal data; under the GDPR, it falls within special categories (Art. 9). Therefore, use only anonymized or synthetic material.

## 8. Administrator policies

Organizations can restrict providers, endpoints, URL import, template features, and updates through a `policy.toml` file. The policy is the responsibility of the respective organization.

## 9. Your rights

Because the publisher does not collect personal data, requests for access, correction, and deletion generally cannot be directed to the publisher. For data held by a model provider, please contact that provider directly. For questions, reach us at admin@jerney.nexus.

## 10. Changes

The publisher may amend this policy. The current version is available at https://jerney-nexus.github.io/epikrise/privacy-policy/en/.
