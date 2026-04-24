import "server-only";
import { createPrivateKey, createSign, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

type ServiceAccount = {
  client_email: string;
  private_key: string;
};

type CachedToken = { token: string; expires_at: number };

const INDEXING_SCOPE = "https://www.googleapis.com/auth/indexing";
const INDEXING_PUBLISH_URL =
  "https://indexing.googleapis.com/v3/urlNotifications:publish";

let cachedSa: ServiceAccount | null = null;
let cachedToken: CachedToken | null = null;

/**
 * Resolve GOOGLE_CREDENTIALS the same way the Streamlit app does:
 *   - If it looks like JSON (starts with `{`), parse it directly.
 *   - Otherwise treat it as a file path and read the file.
 */
function loadServiceAccount(): ServiceAccount {
  if (cachedSa) return cachedSa;
  const value = process.env.GOOGLE_CREDENTIALS;
  if (!value) {
    throw new Error(
      "GOOGLE_CREDENTIALS is not set. Point it at a service-account JSON path " +
        "or paste the JSON directly.",
    );
  }
  const raw = value.trimStart().startsWith("{")
    ? value
    : readFileSync(value, "utf-8");
  const parsed = JSON.parse(raw) as ServiceAccount;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      "Service account JSON is missing client_email or private_key.",
    );
  }
  cachedSa = parsed;
  return cachedSa;
}

function base64UrlEncode(input: string | Buffer): string {
  const b = typeof input === "string" ? Buffer.from(input) : input;
  return b
    .toString("base64")
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

/** Sign a JWT assertion asking Google for an access token scoped to the Indexing API. */
function signAssertion(sa: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: INDEXING_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    jti: randomUUID(),
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(claims),
  )}`;
  const key = createPrivateKey({ key: sa.private_key, format: "pem" });
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key);
  return `${unsigned}.${base64UrlEncode(sig)}`;
}

async function fetchAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires_at - 60 > Date.now() / 1000) {
    return cachedToken.token;
  }
  const sa = loadServiceAccount();
  const assertion = signAssertion(sa);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
  };
  return cachedToken.token;
}

export type SubmitResult = { ok: true } | { ok: false; message: string };

/**
 * Submit one URL to Google's Indexing API as type=URL_UPDATED.
 * Quota: 200 requests/day per default project. We stop at the first quota
 * error so subsequent batch URLs fail fast with a clear message.
 */
export async function submitUrlForIndexing(url: string): Promise<SubmitResult> {
  let token: string;
  try {
    token = await fetchAccessToken();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  const res = await fetch(INDEXING_PUBLISH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, type: "URL_UPDATED" }),
  });

  if (res.ok) return { ok: true };

  const text = await res.text();
  // Surface the most useful bit of the Google error body.
  let message = `${res.status} ${res.statusText}`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    message = text.slice(0, 300) || message;
  }
  return { ok: false, message };
}
