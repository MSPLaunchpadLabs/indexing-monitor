import { headers } from "next/headers";
import { ClientsGridView } from "@/components/clients-grid-view";
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

export default async function ClientsPage() {
  const payload = await fetchClients();
  return (
    <div className="space-y-6">
      <header>
        <p className="eyebrow">Clients</p>
        <h1>All clients</h1>
        <p className="mt-2" style={{ color: "var(--text-soft)" }}>
          Search a property, kick off a fresh indexing check, or open a
          client&apos;s detail report.
        </p>
      </header>

      <ClientsGridView clients={payload.clients} />
    </div>
  );
}

async function fetchClients(): Promise<Payload> {
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
