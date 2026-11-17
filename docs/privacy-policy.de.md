---
title: Datenschutzrichtlinie für Epikrise
permalink: /privacy-policy/de/
---

# Datenschutzrichtlinie für Epikrise

Sprache: [English](https://jerney-nexus.github.io/epikrise/privacy-policy/en/) · Deutsch · [Français](https://jerney-nexus.github.io/epikrise/privacy-policy/fr/) · [Italiano](https://jerney-nexus.github.io/epikrise/privacy-policy/it/) · [Español](https://jerney-nexus.github.io/epikrise/privacy-policy/es/)

Stand: 2026-11-08

Herausgeber: Pascal Jerney, Unterdorfstrasse 7, 3322 Urtenen-Schönbühl, Schweiz

Kontakt für Datenschutzfragen: admin@jerney.nexus

## 1. Geltungsbereich

Diese Richtlinie gilt für die Desktop-App Epikrise (Windows, macOS, Linux), die Sie lokal auf Ihrem Gerät installieren. Sie berücksichtigt das Schweizer Datenschutzgesetz (revDSG) und, soweit anwendbar, die Datenschutz-Grundverordnung (DSGVO).

## 2. Keine Erhebung durch den Herausgeber

Epikrise betreibt kein eigenes Backend. Es gibt keine Benutzerkonten, keine Telemetrie, keine Analyse-Tools und keine Übermittlung von Nutzungsdaten an den Herausgeber. Der Herausgeber erhält daher keine personenbezogenen Daten aus Ihrer Nutzung der App.

## 3. Verarbeitung auf Ihrem Gerät

Eingegebene und importierte Inhalte (Texte, Dokumente, Bilder, PDF-Dateien, Tabellen und Webseiten-Inhalte) verarbeitet die App auf Ihrem Gerät. Ausnahme ist die Übermittlung von Fallinhalten an einen entfernten KI-Endpunkt, die nur nach Ihrer Bestätigung erfolgt (siehe Abschnitt 5). Fälle und erzeugte Ausgaben werden im Arbeitsspeicher gehalten; zu temporären Dateien für die Texterkennung siehe den folgenden Absatz. Beim Verwerfen des Falls oder Beenden der App wird der interne Fallzustand gelöscht. Nicht davon erfasst sind Formularwerte wie eingegebene Vorlagenfelder sowie Texte, die Sie selbst in die Zwischenablage kopiert haben; diese bleiben erhalten, bis Sie sie ändern bzw. die Zwischenablage überschrieben wird. Eine Verlaufsspeicherung erfolgt nicht.

Für die Texterkennung (OCR) können temporäre Bilddateien in privaten temporären Verzeichnissen entstehen. Diese werden vor dem Löschen überschrieben. Betriebssystem und Laufzeitumgebung können jedoch Kopien speichern, eine forensisch sichere Löschung kann daher nicht garantiert werden.

## 4. Gespeicherte Einstellungen und Zugangsdaten

- Importierte Vorlagen werden lokal in der App gespeichert.
- API-Schlüssel werden im Schlüsselbund des Betriebssystems abgelegt (unter Linux über den Secret Service).
- Anbieter, Modell, Endpunkt sowie Ausgabe- und Denkaufwand-Einstellungen werden von der aktuellen Oberfläche nicht dauerhaft gespeichert.

## 5. Übermittlung an KI-Anbieter

Für die Erstellung von Entwürfen werden das aufbereitete Material und Ihre Vorlage an den von Ihnen gewählten Modellanbieter gesendet. Dazu gehören OpenAI, Anthropic, Google Gemini, xAI, Groq, OpenRouter sowie OpenAI-kompatible oder Ollama-Endpunkte. Ist der Endpunkt lokal (z. B. Ollama auf localhost), verlassen die Daten Ihr Gerät nicht. Bei entfernten Endpunkten gelten die Datenschutzbestimmungen des jeweiligen Anbieters. Bevor Fallinhalte erstmals an einen entfernten Endpunkt übermittelt werden, fragt die App Sie, den Anbieter und den Endpunkt zu bestätigen. Diese Bestätigung gilt nur für diesen Fall und diesen Anbieter- und Endpunktwert; für einen anderen Fall, einen anderen Anbieter oder einen anderen Endpunkt wird sie erneut eingeholt. Ohne Ihre Bestätigung werden keine Fallinhalte gesendet. Der Herausgeber ist nicht Empfänger dieser Daten und nicht Vertragspartner des Anbieters.

Unabhängig von der Fallbestätigung kann die App zwei Funktionen ausführen, die entfernte Endpunkte kontaktieren: das Abrufen der Modellliste und den Verbindungstest. Dabei werden Ihre IP-Adresse und, sofern konfiguriert, Ihr gespeicherter Zugangsschlüssel an den Endpunkt übermittelt. Der Verbindungstest kann zusätzlich eine kurze Testanfrage mit dem festen Text „Reply with OK.“ senden. Fallinhalte werden dabei nicht übermittelt.

## 6. Weitere Netzwerkzugriffe

- **URL-Import:** Eine von Ihnen angegebene URL wird direkt abgerufen und in lesbaren Text umgewandelt. Administratoren können dies deaktivieren.
- **Update-Prüfung:** Ist die Update-Funktion aktiviert, lädt die App Update-Informationen von GitHub herunter. Dabei wird Ihre IP-Adresse an GitHub übermittelt. Die Funktion ist optional.

## 7. Keine Anonymisierung durch die App

Epikrise anonymisiert oder pseudonymisiert Inhalte nicht und erkennt keine identifizierenden Angaben. Sie sind dafür verantwortlich, nur Material zu verwenden, das Sie rechtmäßig verarbeiten dürfen. Gesundheitsdaten gelten nach revDSG als besonders schützenswerte Personendaten und nach DSGVO als besondere Kategorien (Art. 9). Verwenden Sie daher nur anonymisiertes oder synthetisches Material.

## 8. Administratorrichtlinien

Organisationen können über eine `policy.toml`-Datei Anbieter, Endpunkte, URL-Import, Vorlagenfunktionen und Updates einschränken. Die Richtlinie liegt in Verantwortung der jeweiligen Organisation.

## 9. Ihre Rechte

Da der Herausgeber keine personenbezogenen Daten erhebt, können Auskunfts-, Berichtigungs- und Löschungsansprüche in der Regel nicht an den Herausgeber gerichtet werden. Für Daten bei einem Modellanbieter wenden Sie sich bitte direkt an diesen. Bei Fragen erreichen Sie uns unter admin@jerney.nexus.

## 10. Änderungen

Der Herausgeber kann diese Richtlinie anpassen. Die aktuelle Fassung ist unter https://jerney-nexus.github.io/epikrise/privacy-policy/de/ abrufbar.
