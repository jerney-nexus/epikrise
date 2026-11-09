# Store listing: Epikrise (English and German)

Draft for Partner Center. Source facts: README.md ("What it does", "Privacy posture"), LICENSE, src-tauri/msix/AppxManifest.xml.

## English (en-US)

### Short title

Epikrise

### Short description

Turns clinical material you have anonymized into a structured draft for clinician review. Runs on your device; content sent to a remote model provider goes only to the provider you choose, after you confirm.

### Description

Epikrise is a drafting aid for clinicians. Paste text or images, import documents, or provide a web address. Epikrise extracts the material and combines it with a template you choose to produce a structured draft, such as a discharge summary, for your review.

Epikrise does not anonymize input. Remove identifying details before use.

Generated text is a draft. A responsible clinician must review and edit it before use. Epikrise is not a medical device and not a diagnostic tool. It does not connect to a hospital information system; you copy the approved text and paste it into the target system yourself.

Case content is held in memory and is not saved as history. OCR may write temporary image files; they are overwritten before removal, but operating-system copies cannot be ruled out. Form values and text you copy to the clipboard yourself are not covered and remain until you change them or the clipboard is overwritten. The app has no hosted backend, no telemetry, and no account. The Store version sends requests only to the model endpoint you configure and to web addresses you choose to import, and does not check for updates. Before case content is first sent to a remote provider in each case, Epikrise asks you to confirm the provider and endpoint. Retrieving the model list and testing the connection do not require case confirmation.

Supported providers: OpenAI, Anthropic, Gemini, Ollama, OpenAI-compatible endpoints, OpenRouter, xAI, and Groq. Ollama is local only when its configured endpoint is local. API keys are stored in the operating system keychain.

### Features

1. Paste text or images, import PDF, DOCX, XLSX, RTF and HTML files, or fetch a web page
2. Extract text from images and scanned PDF pages with local OCR, or with vision analysis where the model supports it
3. Create structured drafts from your own templates
4. Live template preview with MiniJinja rendering
5. Template-defined output checks shown as warnings, with regeneration after corrections
6. Add findings in several rounds and integrate them cumulatively
7. Stream drafts and cancel generation at any time
8. Supports OpenAI, Anthropic, Gemini, Ollama, OpenAI-compatible endpoints, OpenRouter, xAI and Groq
9. Discover models and check provider connections
10. Inputs, output and controls in one workspace
11. Plain and formatted output preview
12. Copy output as formatted text only after clinician acknowledgment
13. Case content kept in memory, not saved as history
14. API keys stored in the operating system keychain
15. Case content sent to remote endpoints only after confirmation per case, provider and endpoint
16. Interface in German and English

### Keywords

Epikrise; discharge summary; clinical documentation; clinical notes; medical letters; drafting aid; templates

### Copyright

© 2026 Pascal Jerney

### Licensing terms

MIT License. Copyright (c) 2026 Pascal Jerney. Full text: https://github.com/jerney-nexus/epikrise/blob/main/LICENSE

## Deutsch (de-CH)

### Kurztitel

Epikrise

### Kurzbeschreibung

Erstellt aus von Ihnen anonymisierten klinischen Unterlagen einen strukturierten Entwurf zur ärztlichen Prüfung. Läuft auf Ihrem Gerät; Fallinhalte an externe Modellanbieter gehen nur an den gewählten Anbieter und erst nach Ihrer Bestätigung.

### Beschreibung

Epikrise ist eine Entwurfshilfe für medizinisches Personal. Fügen Sie Text oder Bilder ein, importieren Sie Dokumente oder geben Sie eine Webadresse an. Epikrise extrahiert das Material und erstellt mit einer von Ihnen gewählten Vorlage einen strukturierten Entwurf, zum Beispiel einen Entlassungsbericht, zur Prüfung.

Epikrise anonymisiert die Eingaben nicht. Entfernen Sie identifizierende Angaben vor der Verwendung.

Erzeugter Text ist ein Entwurf. Eine verantwortliche Ärztin oder ein verantwortlicher Arzt muss ihn vor der Verwendung prüfen und bearbeiten. Epikrise ist kein Medizinprodukt und kein Diagnoseinstrument. Die App ist nicht mit einem Krankenhausinformationssystem verbunden; den freigegebenen Text kopieren Sie selbst in das Zielsystem.

Fallinhalte werden im Arbeitsspeicher gehalten und nicht als Verlauf gespeichert. OCR kann temporäre Bilddateien anlegen; sie werden vor dem Entfernen überschrieben. Kopien durch das Betriebssystem lassen sich jedoch nicht ausschliessen. Formularwerte und Texte, die Sie selbst in die Zwischenablage kopieren, sind davon nicht erfasst und bleiben erhalten, bis Sie sie ändern oder die Zwischenablage überschrieben wird. Die App hat kein Backend, keine Telemetrie und kein Konto. Die Store-Version sendet Anfragen nur an den von Ihnen konfigurierten Modell-Endpunkt und an Webadressen, die Sie importieren, und prüft nicht auf Updates. Vor dem ersten Versand von Fallinhalten an einen externen Anbieter je Fall bittet Epikrise um Bestätigung von Anbieter und Endpunkt. Modellliste abrufen und Verbindungstest erfordern keine Fallbestätigung.

Unterstützte Anbieter: OpenAI, Anthropic, Gemini, Ollama, OpenAI-kompatible Endpunkte, OpenRouter, xAI und Groq. Ein Ollama-Endpunkt gilt nur dann als lokal, wenn der konfigurierte Endpunkt lokal ist. API-Schlüssel werden im Schlüsselbund des Betriebssystems gespeichert.

### Funktionen

1. Text oder Bilder einfügen, Dateien (PDF, DOCX, XLSX, RTF, HTML) importieren oder Webseiten abrufen
2. Text aus Bildern und gescannten PDF-Seiten lokal per OCR erkennen oder per Bildanalyse, sofern das Modell sie unterstützt
3. Strukturierte Entwürfe aus Ihren eigenen Vorlagen erstellen
4. Live-Vorschau der Vorlage mit MiniJinja
5. Vorlagenprüfungen als Warnungen, mit erneuter Erstellung nach Korrekturen
6. Befunde in mehreren Runden hinzufügen und kumulativ integrieren
7. Entwürfe streamen und die Erstellung jederzeit abbrechen
8. Unterstützt OpenAI, Anthropic, Gemini, Ollama, OpenAI-kompatible Endpunkte, OpenRouter, xAI und Groq
9. Modelle ermitteln und Anbieterverbindungen prüfen
10. Eingaben, Ergebnis und Steuerung in einem Arbeitsbereich
11. Vorschau des Ergebnisses als Klartext oder formatiert
12. Ergebnis erst nach ärztlicher Bestätigung formatiert kopieren
13. Fallinhalte im Arbeitsspeicher, nicht als Verlauf gespeichert
14. API-Schlüssel im Schlüsselbund des Betriebssystems
15. Fallinhalte an externe Endpunkte nur nach Bestätigung je Fall, Anbieter und Endpunkt
16. Oberfläche auf Deutsch und Englisch

### Schlüsselwörter

Epikrise; Entlassungsbericht; Klinische Dokumentation; Klinische Notizen; Arztbrief; Entwurfshilfe; Vorlagen

### Copyright

© 2026 Pascal Jerney

### Lizenzbedingungen

MIT-Lizenz. Copyright (c) 2026 Pascal Jerney. Volltext: https://github.com/jerney-nexus/epikrise/blob/main/LICENSE
