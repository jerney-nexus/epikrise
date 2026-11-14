---
title: Informativa sulla privacy di Epikrise
permalink: /privacy-policy/it/
---

# Informativa sulla privacy di Epikrise

Lingua: [English](https://jerney-nexus.github.io/epikrise/privacy-policy/en/) · [Deutsch](https://jerney-nexus.github.io/epikrise/privacy-policy/de/) · [Français](https://jerney-nexus.github.io/epikrise/privacy-policy/fr/) · Italiano · [Español](https://jerney-nexus.github.io/epikrise/privacy-policy/es/)

Ultimo aggiornamento: 2026-11-08

Titolare: Pascal Jerney, Unterdorfstrasse 7, 3322 Urtenen-Schönbühl, Svizzera

Contatto per questioni di privacy: admin@jerney.nexus

## 1. Ambito di applicazione

La presente informativa si applica all’app desktop Epikrise (Windows, macOS, Linux), che Lei installa localmente sul Suo dispositivo. Tiene conto della Legge federale svizzera sulla protezione dei dati (revLPD) e, ove applicabile, del Regolamento generale sulla protezione dei dati dell’UE (GDPR).

## 2. Nessuna raccolta da parte del titolare

Epikrise non gestisce un proprio backend. Non esistono account utente, telemetria, strumenti di analisi né trasmissione di dati di utilizzo al titolare. Il titolare non riceve quindi alcun dato personale derivante dall’uso dell’app.

## 3. Trattamento sul Suo dispositivo

L’app tratta sul Suo dispositivo i contenuti che inserisce o importa (testi, documenti, immagini, file PDF, tabelle e contenuti di pagine web). L’unica eccezione è l’invio del contenuto di un caso a un endpoint di IA remoto, che avviene solo dopo la Sua conferma (si veda la sezione 5). I casi e i risultati generati sono conservati in memoria; i file temporanei per il riconoscimento del testo sono trattati nel paragrafo successivo. Quando scarta un caso o chiude l’app, lo stato interno del caso viene cancellato. Non rientrano in questa disciplina i valori inseriti nei moduli, come le voci dei campi dei modelli di documento, né il testo che copia negli appunti: questi restano finché non li modifica o finché gli appunti non vengono sovrascritti. Non viene memorizzata alcuna cronologia.

Per il riconoscimento del testo (OCR), possono essere creati file immagine temporanei in directory temporanee private. Vengono sovrascritti prima di essere eliminati. Tuttavia, il sistema operativo e l’ambiente di esecuzione possono conservare copie; non è quindi possibile garantire una cancellazione forense sicura.

## 4. Impostazioni e credenziali memorizzate

- I modelli di documento importati sono memorizzati localmente nell’app.
- Le chiavi API sono memorizzate nel portachiavi del sistema operativo (su Linux, tramite Secret Service).
- Fornitore, modello, endpoint e impostazioni di output e di ragionamento non sono memorizzati in modo permanente dall’interfaccia attuale.

## 5. Trasmissione ai fornitori di IA

Per generare le bozze, il materiale preparato e il Suo modello di documento vengono inviati al fornitore di modelli scelto. I fornitori supportati sono OpenAI, Anthropic, Google Gemini, xAI, Groq, OpenRouter, nonché endpoint compatibili con OpenAI o Ollama. Se l’endpoint è locale (ad esempio Ollama su localhost), i dati non lasciano il Suo dispositivo. Per gli endpoint remoti si applicano le condizioni sulla privacy di tale fornitore. Prima del primo invio del contenuto di un caso a un endpoint remoto, l’app Le chiede di confermare fornitore ed endpoint. Questa conferma vale solo per quel caso, quel fornitore e quell’endpoint; per un altro caso, fornitore o endpoint, viene richiesta di nuovo. Senza la Sua conferma, nessun contenuto di caso viene inviato. Il titolare non riceve questi dati e non è parte del Suo contratto con il fornitore.

Indipendentemente dalla conferma del caso, l’app può eseguire due funzioni che contattano endpoint remoti: il recupero dell’elenco dei modelli e il test di connessione. Queste trasmettono il Suo indirizzo IP e, se configurata, la Sua chiave API memorizzata all’endpoint. Il test di connessione può inoltre inviare una breve richiesta di prova con il testo fisso « Reply with OK. ». Nessun contenuto di caso viene inviato in queste richieste.

## 6. Altri accessi di rete

- **Importazione da URL:** un URL da Lei indicato viene recuperato direttamente e convertito in testo leggibile. Gli amministratori possono disattivare questa funzione.
- **Verifica degli aggiornamenti:** se la funzione di aggiornamento è attiva, l’app scarica le informazioni sugli aggiornamenti da GitHub. Ciò trasmette il Suo indirizzo IP a GitHub. La funzione è facoltativa.

## 7. Nessuna anonimizzazione da parte dell’app

Epikrise non anonimizza né pseudonimizza i contenuti e non rileva informazioni identificative. Lei è responsabile di utilizzare solo materiale che è autorizzato a trattare per legge. Ai sensi della revLPD i dati sanitari sono considerati dati personali particolarmente sensibili; ai sensi del GDPR rientrano nelle categorie particolari (art. 9). Utilizzi quindi solo materiale anonimizzato o sintetico.

## 8. Politiche amministrative

Le organizzazioni possono limitare fornitori, endpoint, importazione da URL, funzioni dei modelli di documento e aggiornamenti tramite un file `policy.toml`. La politica è di responsabilità della rispettiva organizzazione.

## 9. I Suoi diritti

Poiché il titolare non raccoglie dati personali, le richieste di accesso, rettifica e cancellazione generalmente non possono essere rivolte al titolare. Per i dati detenuti da un fornitore di modelli, La preghiamo di contattare direttamente tale fornitore. Per domande, ci scriva a admin@jerney.nexus.

## 10. Modifiche

Il titolare può modificare la presente informativa. La versione attuale è disponibile all’indirizzo https://jerney-nexus.github.io/epikrise/privacy-policy/it/.
