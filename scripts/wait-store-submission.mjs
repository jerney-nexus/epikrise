#!/usr/bin/env node
// Waits until Partner Center reports the submission created by this run as Published.
// `msstore submission get <productId>` falls back to the last Published submission
// when no draft is pending, so a Published status only counts when its ID matches the
// ID captured from the draft before publish.
// The wait polls the Partner Center REST status endpoint for the captured ID, because
// msstore cannot query a submission by ID. The access token is a client-credentials
// token obtained with a certificate client assertion (the same PFX as msstore).
// Usage:
//   STORE_PRODUCT_ID=<id> node scripts/wait-store-submission.mjs --capture-id
//   STORE_PRODUCT_ID=<id> STORE_SUBMISSION_ID=<id> AZURE_AD_TENANT_ID=<id>
//     AZURE_AD_APPLICATION_CLIENT_ID=<id> STORE_CERT_PFX_PATH=<path>
//     STORE_CERT_PASSWORD=<secret> node scripts/wait-store-submission.mjs [timeout-minutes]

import { execFile } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  randomUUID,
  sign,
  X509Certificate,
} from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MINUTES = 300;
const INTERVAL_MS = 60_000;
const FAILED_STATUS = /fail|reject|cancel/i;
const PARTNER_CENTER_RESOURCE = "https://manage.devcenter.microsoft.com";
const TOKEN_REFRESH_MS = 50 * 60_000;
const ASSERTION_LIFETIME_S = 300;

/**
 * @param {{
 *   submissionId: string,
 *   fetchSubmission: () => Promise<{ id: string | undefined, status: string | undefined }>,
 *   sleep: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   timeoutMs: number,
 *   intervalMs?: number,
 *   log?: (message: string) => void,
 * }} options
 */
export async function waitForPublished({
  submissionId,
  fetchSubmission,
  sleep,
  now = Date.now,
  timeoutMs,
  intervalMs = INTERVAL_MS,
  log = () => {},
}) {
  if (!submissionId) {
    throw new Error("No submission ID was captured before publish.");
  }
  const deadline = now() + timeoutMs;
  for (;;) {
    const { id, status } = await fetchSubmission();
    if (id === undefined) {
      throw new Error(
        "msstore submission get returned no submission ID; cannot confirm which submission is Published.",
      );
    }
    if (id === submissionId) {
      log(`Submission status: ${status ?? "unknown"}`);
      if (status === "Published") return status;
      if (status !== undefined && FAILED_STATUS.test(status)) {
        throw new Error(`The Partner Center submission is ${status}.`);
      }
    } else {
      log(`Partner Center reports another submission (waiting for ${submissionId}).`);
    }
    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting for the Partner Center submission to be Published; last status ${status ?? "unknown"}.`,
      );
    }
    await sleep(intervalMs);
  }
}

/** @param {string} productId */
export function fetchSubmission(productId) {
  return new Promise((resolve, reject) => {
    execFile(
      "msstore",
      ["submission", "get", productId, "-m", "properties"],
      { shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          // Errors can carry command output; report only the exit failure.
          reject(new Error("msstore submission get (properties) failed."));
          return;
        }
        try {
          const submission = JSON.parse(stdout);
          const id = submission.id ?? submission.Id;
          const status = submission.Status ?? submission.status;
          resolve({
            id: typeof id === "string" && id !== "" ? id : undefined,
            status: typeof status === "string" ? status : undefined,
          });
        } catch {
          reject(new Error("msstore submission get returned unreadable JSON."));
        }
      },
    );
  });
}

/**
 * Reads the private key and the matching certificate from a PFX with openssl. The
 * password is passed through the environment, and the PEM output stays in memory.
 * @param {string} pfxPath
 * @param {string} password
 * @returns {Promise<{ privateKey: import("node:crypto").KeyObject, certificate: X509Certificate }>}
 */
export function readPfxIdentity(pfxPath, password) {
  return new Promise((resolve, reject) => {
    execFile(
      "openssl",
      ["pkcs12", "-in", pfxPath, "-nodes", "-passin", "env:STORE_CERT_PASSWORD"],
      {
        env: { ...process.env, STORE_CERT_PASSWORD: password },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        // openssl errors can echo file paths; report only that the read failed.
        if (error) {
          reject(new Error("openssl could not read the Partner Center certificate."));
          return;
        }
        try {
          const keyPem = stdout.match(
            /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/,
          )?.[0];
          const certPems =
            stdout.match(
              /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
            ) ?? [];
          if (!keyPem) throw new Error("no private key");
          const privateKey = createPrivateKey(keyPem);
          const certificate = certPems
            .map((pem) => new X509Certificate(pem))
            .find((cert) => cert.checkPrivateKey(privateKey));
          if (!certificate) throw new Error("no matching certificate");
          resolve({ privateKey, certificate });
        } catch {
          reject(new Error("The Partner Center certificate has no usable key pair."));
        }
      },
    );
  });
}

/**
 * Builds an RS256 client assertion signed with the certificate's private key.
 * @param {{ clientId: string, tokenUrl: string, privateKey: import("node:crypto").KeyObject, certificate: { raw: Buffer }, nowMs?: number }} options
 */
export function createClientAssertion({
  clientId,
  tokenUrl,
  privateKey,
  certificate,
  nowMs = Date.now(),
}) {
  const issued = Math.floor(nowMs / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    x5t: createHash("sha1").update(certificate.raw).digest("base64url"),
  };
  const payload = {
    aud: tokenUrl,
    iss: clientId,
    sub: clientId,
    nbf: issued,
    exp: issued + ASSERTION_LIFETIME_S,
    jti: randomUUID(),
  };
  const signingInput = [header, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
  const signature = sign("sha256", Buffer.from(signingInput), privateKey).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
}

/**
 * @param {{ tenantId: string, clientId: string, assertion: string }} options
 * @returns {Promise<string>}
 */
export async function fetchAccessToken({ tenantId, clientId, assertion }) {
  const response = await fetch(tokenEndpoint(tenantId), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
      resource: PARTNER_CENTER_RESOURCE,
    }),
  });
  if (!response.ok) {
    const detail = describeTokenError(await readBodyBestEffort(response));
    throw new Error(
      `Partner Center token request failed with HTTP ${response.status}${detail}.`,
    );
  }
  const body = await response.json();
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new Error("Partner Center token response has no access token.");
  }
  return body.access_token;
}

const ERROR_BODY_TIMEOUT_MS = 5_000;
const ERROR_BODY_MAX_BYTES = 8_192;

/**
 * Reads an error response body for diagnostics only. Returns "" when the stream is
 * unreadable, slower than the time limit, or larger than the byte limit, so the HTTP
 * status still reports the failure without delaying the polling deadline.
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readBodyBestEffort(response) {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ERROR_BODY_TIMEOUT_MS);
  });
  try {
    const chunks = [];
    let total = 0;
    for (;;) {
      const result = await Promise.race([reader.read(), timedOut]);
      if (
        result === null ||
        (!result.done && total + result.value.byteLength > ERROR_BODY_MAX_BYTES)
      ) {
        await reader.cancel().catch(() => {});
        return "";
      }
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      chunks.push(result.value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** OAuth 2.0 and Microsoft identity platform error codes that are safe to log. */
const KNOWN_TOKEN_ERRORS = new Set([
  "access_denied",
  "authorization_pending",
  "expired_token",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_resource",
  "invalid_scope",
  "interaction_required",
  "server_error",
  "temporarily_unavailable",
  "unauthorized_client",
  "unsupported_grant_type",
]);

/**
 * Extracts only the OAuth error code and the AADSTS number from an error body, so the
 * log explains the rejection without echoing tokens, assertions, or full descriptions.
 * Unknown error codes are omitted rather than logged verbatim.
 * @param {string} body
 * @returns {string} e.g. " (invalid_client, AADSTS700027)", or "" when unavailable
 */
export function describeTokenError(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }
  const error =
    typeof parsed?.error === "string" && KNOWN_TOKEN_ERRORS.has(parsed.error)
      ? parsed.error
      : "";
  const description =
    typeof parsed?.error_description === "string" ? parsed.error_description : "";
  const aadsts = description.match(/\bAADSTS\d{1,10}\b/)?.[0] ?? "";
  const parts = [error, aadsts].filter((part) => part !== "");
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** @param {string} tenantId */
export function tokenEndpoint(tenantId) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/token`;
}

/**
 * Returns the cached token, requesting a new one once it is older than the refresh age.
 * Access tokens last 60 minutes and a wait can run longer than that.
 * @param {() => Promise<string>} requestToken
 * @param {() => number} [now]
 */
export function createTokenProvider(requestToken, now = Date.now) {
  /** @type {string | undefined} */
  let token;
  let fetchedAt = 0;
  return async () => {
    if (token === undefined || now() - fetchedAt >= TOKEN_REFRESH_MS) {
      token = await requestToken();
      fetchedAt = now();
    }
    return token;
  };
}

/**
 * @param {{ applicationId: string, submissionId: string, accessToken: string }} options
 * @returns {Promise<{ id: string, status: string }>}
 */
export async function fetchSubmissionStatus({
  applicationId,
  submissionId,
  accessToken,
}) {
  const url = `https://manage.devcenter.microsoft.com/v1.0/my/applications/${encodeURIComponent(applicationId)}/submissions/${encodeURIComponent(submissionId)}/status`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Partner Center status request failed with HTTP ${response.status}.`,
    );
  }
  const body = await response.json();
  if (typeof body.status !== "string") {
    throw new Error("Partner Center status response has no status.");
  }
  // The status endpoint is queried by ID, so the requested ID is the reported one.
  return { id: submissionId, status: body.status };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const productId = process.env.STORE_PRODUCT_ID ?? "";
  const capture = process.argv[2] === "--capture-id";
  const timeoutMinutes = capture
    ? DEFAULT_TIMEOUT_MINUTES
    : Number(process.argv[2] ?? DEFAULT_TIMEOUT_MINUTES);
  const usage =
    "wait-store-submission: usage: STORE_PRODUCT_ID=<id> node scripts/wait-store-submission.mjs --capture-id | [timeout-minutes] with STORE_SUBMISSION_ID=<id>\n";
  if (!/^[A-Za-z0-9]+$/.test(productId) || !(timeoutMinutes > 0)) {
    process.stderr.write(usage);
    process.exit(1);
  }
  try {
    if (capture) {
      const { id } = await fetchSubmission(productId);
      if (id === undefined) {
        throw new Error("msstore submission get returned no submission ID.");
      }
      process.stdout.write(`${id}\n`);
    } else {
      const tenantId = process.env.AZURE_AD_TENANT_ID ?? "";
      const clientId = process.env.AZURE_AD_APPLICATION_CLIENT_ID ?? "";
      const pfxPath = process.env.STORE_CERT_PFX_PATH ?? "";
      const password = process.env.STORE_CERT_PASSWORD ?? "";
      const submissionId = process.env.STORE_SUBMISSION_ID ?? "";
      if (!/^[A-Za-z0-9-]+$/.test(tenantId) || !/^[A-Za-z0-9-]+$/.test(clientId)) {
        throw new Error(
          "AZURE_AD_TENANT_ID and AZURE_AD_APPLICATION_CLIENT_ID are required.",
        );
      }
      if (!pfxPath || !password) {
        throw new Error("STORE_CERT_PFX_PATH and STORE_CERT_PASSWORD are required.");
      }
      const { privateKey, certificate } = await readPfxIdentity(pfxPath, password);
      const getAccessToken = createTokenProvider(async () =>
        fetchAccessToken({
          tenantId,
          clientId,
          assertion: createClientAssertion({
            clientId,
            tokenUrl: tokenEndpoint(tenantId),
            privateKey,
            certificate,
          }),
        }),
      );
      await waitForPublished({
        submissionId,
        fetchSubmission: async () =>
          fetchSubmissionStatus({
            applicationId: productId,
            submissionId,
            accessToken: await getAccessToken(),
          }),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        timeoutMs: timeoutMinutes * 60_000,
        log: (message) => process.stdout.write(`${message}\n`),
      });
      process.stdout.write("The Partner Center submission is Published.\n");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`wait-store-submission: ${message}\n`);
    process.exit(1);
  }
}
