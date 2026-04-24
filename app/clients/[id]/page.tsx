import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ClientDetailView } from "@/components/client-detail-view";
import type { ClientRow, RunStats, RunStatus } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Reason = { reason: string; count: number };
type DetailPayload = {
  client: ClientRow;
  stats: RunStats | null;
  last_run_at: string | null;
  reason_breakdown: Reason[];
  current_run: null | {
    id: string;
    status: RunStatus;
    current: number;
    total: number;
    pct: number;
    started_at: string;
  };
};

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await fetchDetail(id);
  if (!data) return notFound();
  return <ClientDetailView initial={data} />;
}

async function fetchDetail(id: string): Promise<DetailPayload | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const res = await fetch(
    `${proto}://${host}/api/clients/${encodeURIComponent(id)}`,
    { cache: "no-store" },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load client: ${res.status}`);
  return (await res.json()) as DetailPayload;
}
