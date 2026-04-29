import "server-only";
import { getGoogleAccessToken, WEBMASTERS_SCOPE } from "@/lib/google-indexing";

const INSPECT_URL =
  "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

export type InspectIndexed = "yes" | "no" | "unknown";

export type InspectResult =
  | {
      ok: true;
      indexed: InspectIndexed;
      verdict: string;
      coverage: string;
      /** Best human-readable summary — coverage if present, else verdict. */
      reason: string;
    }
  | { ok: false; message: string };

/**
 * Call the Search Console URL Inspection API for a single URL.
 *
 * Mirrors gsc.py:inspect — verdict "PASS" → indexed, else not indexed; an
 * HTTP error becomes ok=false. The caller decides what to do with the result
 * (typically: write `indexed`, `last_checked`, and `notes` to url_status).
 */
export async function inspectUrl(
  url: string,
  siteUrl: string,
): Promise<InspectResult> {
  let token: string;
  try {
    token = await getGoogleAccessToken(WEBMASTERS_SCOPE);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  const res = await fetch(INSPECT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inspectionUrl: url, siteUrl }),
  });

  if (!res.ok) {
    const text = await res.text();
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      message = text.slice(0, 300) || message;
    }
    return { ok: false, message };
  }

  const data = (await res.json()) as {
    inspectionResult?: {
      indexStatusResult?: {
        verdict?: string;
        coverageState?: string;
      };
    };
  };

  const status = data.inspectionResult?.indexStatusResult ?? {};
  const verdict = status.verdict ?? "UNKNOWN";
  const coverage = status.coverageState ?? "";
  const indexed: InspectIndexed =
    verdict === "PASS" ? "yes" : verdict === "UNKNOWN" ? "unknown" : "no";
  const reason = coverage || verdict;

  return { ok: true, indexed, verdict, coverage, reason };
}
