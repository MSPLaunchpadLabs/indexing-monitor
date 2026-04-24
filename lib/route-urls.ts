import type { ClientRow } from "@/lib/supabase";

export type RoutedUrl = {
  url: string;
  client_id: string | null;
  reason: string;
};

function normaliseHost(host: string | null | undefined): string {
  if (!host) return "";
  const lower = host.trim().toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

function hostsFor(client: ClientRow): string[] {
  const out = new Set<string>();
  for (const field of [
    client.sitemap_url,
    client.gsc_site_url,
    client.domain,
  ]) {
    if (!field) continue;
    if (field.startsWith("sc-domain:")) {
      out.add(normaliseHost(field.split(":", 2)[1]));
      continue;
    }
    try {
      const url = new URL(field.includes("://") ? field : `https://${field}`);
      const host = normaliseHost(url.hostname);
      if (host) out.add(host);
    } catch {
      // Not parseable — skip.
    }
  }
  return [...out].filter(Boolean);
}

/**
 * Match every input URL to a client by hostname. Duplicates and blanks
 * are dropped. Unknown hosts come back with client_id = null so the UI
 * can offer a manual override.
 */
export function routeUrls(urls: string[], clients: ClientRow[]): RoutedUrl[] {
  const hostToClient = new Map<string, string>();
  for (const c of clients) {
    for (const h of hostsFor(c)) hostToClient.set(h, c.id);
  }

  const seen = new Set<string>();
  const out: RoutedUrl[] = [];
  for (const raw of urls) {
    const url = (raw ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    let host: string;
    try {
      const parsed = new URL(url);
      if (!parsed.protocol || !parsed.hostname) throw new Error("no host");
      host = normaliseHost(parsed.hostname);
    } catch {
      out.push({ url, client_id: null, reason: "Not a valid URL" });
      continue;
    }

    const clientId = hostToClient.get(host);
    if (clientId) {
      out.push({ url, client_id: clientId, reason: `Matched ${host}` });
    } else {
      out.push({ url, client_id: null, reason: `Unknown domain: ${host}` });
    }
  }
  return out;
}
