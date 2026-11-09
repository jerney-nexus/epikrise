# Security Policy

## Supported Versions

Epikrise has not published a versioned release yet. Until the first release, security fixes target the latest code on `main`. After releases begin, only the latest published release is supported; older releases may not receive security fixes.

## Reporting a Vulnerability

Report vulnerabilities privately through [GitHub's private vulnerability reporting form](https://github.com/jerney-nexus/epikrise/security/advisories/new). Do not open a public issue, discussion, or pull request, or disclose the vulnerability publicly before maintainers have had a reasonable opportunity to investigate and prepare a fix.

Do not include real patient data, clinical text, credentials, API keys, or other secrets in a report. Include the affected version or commit, platform, impact, and reproduction steps. Use only synthetic, non-sensitive examples.

## Accepted Dependency Risks

- **GHSA-gcqx-w48m-w2h4 (CVE-2026-93753, low)**: `deepmerge` `>= 4.2.0, <= 4.3.1` allows prototype poisoning in `mergeObject()` (Dependabot alert #6, tracked in [#209](https://github.com/jerney-nexus/epikrise/issues/209)). No patched version exists, and the latest `@sveltejs/vite-plugin-svelte` still depends on `^4.3.1`, so no upgrade or override can remove it. The package is reached only through the development toolchain (`@sveltejs/vite-plugin-svelte` and `@sveltejs/kit`), is not imported by application source, and does not appear in the built frontend. Risk accepted; revisit when a patched `deepmerge` or an upstream SvelteKit release drops the vulnerable range.
