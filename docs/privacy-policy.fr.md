---
title: Politique de confidentialité d’Epikrise
permalink: /privacy-policy/fr/
---

# Politique de confidentialité d’Epikrise

Langue : [English](https://jerney-nexus.github.io/epikrise/privacy-policy/en/) · [Deutsch](https://jerney-nexus.github.io/epikrise/privacy-policy/de/) · Français · [Italiano](https://jerney-nexus.github.io/epikrise/privacy-policy/it/) · [Español](https://jerney-nexus.github.io/epikrise/privacy-policy/es/)

Dernière mise à jour : 2026-11-08

Éditeur : Pascal Jerney, Unterdorfstrasse 7, 3322 Urtenen-Schönbühl, Suisse

Contact pour les questions de confidentialité : admin@jerney.nexus

## 1. Champ d’application

Cette politique s’applique à l’application de bureau Epikrise (Windows, macOS, Linux), que vous installez localement sur votre appareil. Elle tient compte de la loi fédérale suisse sur la protection des données (nLPD) et, le cas échéant, du règlement général sur la protection des données de l’UE (RGPD).

## 2. Absence de collecte par l’éditeur

Epikrise n’exploite pas de backend propre. Il n’existe ni compte utilisateur, ni télémétrie, ni outil d’analyse, ni transmission de données d’utilisation à l’éditeur. L’éditeur ne reçoit donc aucune donnée personnelle issue de votre utilisation de l’application.

## 3. Traitement sur votre appareil

L’application traite sur votre appareil le contenu que vous saisissez ou importez (textes, documents, images, fichiers PDF, tableaux et contenus de pages web). La seule exception est l’envoi du contenu d’un cas à un point d’accès d’IA distant, qui n’a lieu qu’après votre confirmation (voir la section 5). Les cas et les résultats générés sont conservés en mémoire ; les fichiers temporaires de reconnaissance de texte sont traités dans le paragraphe suivant. Lorsque vous abandonnez un cas ou fermez l’application, l’état interne du cas est effacé. Ne sont pas concernées les valeurs saisies dans les formulaires, comme les entrées des champs de modèle, ni le texte que vous avez copié vous-même dans le presse-papiers ; celles-ci restent en place jusqu’à ce que vous les modifiiez ou que le presse-papiers soit écrasé. Aucun historique n’est conservé.

Pour la reconnaissance de texte (OCR), des fichiers image temporaires peuvent être créés dans des répertoires temporaires privés. Ils sont écrasés avant d’être supprimés. Toutefois, le système d’exploitation et l’environnement d’exécution peuvent conserver des copies ; une suppression forensique sécurisée ne peut donc pas être garantie.

## 4. Réglages et identifiants enregistrés

- Les modèles de document importés sont stockés localement dans l’application.
- Les clés API sont stockées dans le trousseau du système d’exploitation (sous Linux, via le Secret Service).
- Le fournisseur, le modèle, le point d’accès ainsi que les réglages de sortie et de raisonnement ne sont pas enregistrés de manière permanente par l’interface actuelle.

## 5. Transmission aux fournisseurs d’IA

Pour générer des projets de rédaction, le matériel préparé et votre modèle de document sont envoyés au fournisseur de modèle que vous choisissez. Les fournisseurs pris en charge sont OpenAI, Anthropic, Google Gemini, xAI, Groq, OpenRouter, ainsi que les points d’accès compatibles OpenAI ou Ollama. Si le point d’accès est local (par exemple Ollama sur localhost), les données ne quittent pas votre appareil. Pour les points d’accès distants, les conditions de confidentialité de ce fournisseur s’appliquent. Avant la première transmission du contenu d’un cas à un point d’accès distant, l’application vous demande de confirmer le fournisseur et le point d’accès. Cette confirmation ne s’applique qu’à ce cas, à ce fournisseur et à ce point d’accès ; pour un autre cas, un autre fournisseur ou un autre point d’accès, elle est redemandée. Sans votre confirmation, aucun contenu de cas n’est envoyé. L’éditeur ne reçoit pas ces données et n’est pas partie à votre contrat avec le fournisseur.

Indépendamment de la confirmation par cas, l’application peut exécuter deux fonctions qui contactent des points d’accès distants : la récupération de la liste des modèles et le test de connexion. Elles transmettent votre adresse IP et, si elle est configurée, votre clé API enregistrée au point d’accès. Le test de connexion peut également envoyer une courte requête de test au texte fixe « Reply with OK. ». Aucun contenu de cas n’est envoyé dans ces requêtes.

## 6. Autres accès réseau

- **Import par URL :** une URL que vous indiquez est récupérée directement et convertie en texte lisible. Les administrateurs peuvent désactiver cette fonction.
- **Vérification des mises à jour :** si la fonction de mise à jour est activée, l’application télécharge les informations de mise à jour depuis GitHub. Cela transmet votre adresse IP à GitHub. Cette fonction est facultative.

## 7. Absence d’anonymisation par l’application

Epikrise n’anonymise ni ne pseudonymise le contenu et ne détecte pas les informations identifiantes. Vous êtes responsable de n’utiliser que des documents que vous êtes légalement autorisé à traiter. Selon la nLPD, les données de santé sont considérées comme des données personnelles particulièrement sensibles ; selon le RGPD, elles relèvent des catégories particulières (art. 9). N’utilisez donc que des documents anonymisés ou synthétiques.

## 8. Politiques d’administration

Les organisations peuvent restreindre les fournisseurs, les points d’accès, l’import par URL, les fonctions de modèles et les mises à jour au moyen d’un fichier `policy.toml`. La politique relève de la responsabilité de l’organisation concernée.

## 9. Vos droits

Comme l’éditeur ne collecte pas de données personnelles, les demandes d’accès, de rectification et de suppression ne peuvent généralement pas lui être adressées. Pour les données détenues par un fournisseur de modèle, veuillez contacter directement ce fournisseur. Pour toute question, écrivez-nous à admin@jerney.nexus.

## 10. Modifications

L’éditeur peut modifier cette politique. La version actuelle est disponible à l’adresse https://jerney-nexus.github.io/epikrise/privacy-policy/fr/.
