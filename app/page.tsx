import { headers } from "next/headers";
import { ClientListView } from "@/components/client-list-view";
import type { ClientListItem } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Payload = {
  clients: ClientListItem[];
  dashboard: {
    total_clients: number;
    urls_tracked: number;
    indexed: number;
    active_runs: number;
  };
};

export default async function HomePage() {
  const payload = await fetchClients();
  return <ClientListView initial={payload} />;
}

async function fetchClients(): Promise<Payload> {
  // Server-side fetch: reuse the same Route Handler so list + detail pages
  // share one data path. Using the request's host keeps this working on
  // Vercel preview URLs and in local dev without hardcoding VERCEL_URL.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const res = await fetch(`${proto}://${host}/api/clients`, {
    cache: "no-store",
    headers: { "x-internal": "1" },
  });
  if (!res.ok) {
    throw new Error(`Failed to load clients: ${res.status}`);
  }
  return (await res.json()) as Payload;
}
