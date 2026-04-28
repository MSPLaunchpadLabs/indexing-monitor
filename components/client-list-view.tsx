"use client";

import { ClientsGridView } from "@/components/clients-grid-view";
import { StatsStrip } from "@/components/stats-strip";
import { QuotaCard } from "@/components/quota-card";
import type { ClientListItem } from "@/lib/supabase";

type Payload = {
  clients: ClientListItem[];
  dashboard: {
    total_clients: number;
    urls_tracked: number;
    indexed: number;
    active_runs: number;
  };
};

export function ClientListView({ initial }: { initial: Payload }) {
  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Dashboard</p>
        <h1>Website Page Indexing</h1>
        <p className="mt-2" style={{ color: "var(--text-soft)" }}>
          Track every client site&apos;s Google indexing status, kick off a
          fresh check, or review past reports.
        </p>
      </header>

      <StatsStrip
        items={[
          {
            label: "Total Clients",
            value: initial.dashboard.total_clients,
            hint: `${
              initial.clients.filter((c) => c.stats).length
            } with run data`,
          },
          {
            label: "URLs Tracked",
            value: initial.dashboard.urls_tracked,
            hint: "Across all sitemaps",
          },
          {
            label: "Indexed",
            value: initial.dashboard.indexed,
            tone: "success",
            hint:
              initial.dashboard.urls_tracked > 0
                ? `${Math.round(
                    (initial.dashboard.indexed /
                      initial.dashboard.urls_tracked) *
                      100,
                  )}% of tracked URLs`
                : "No runs yet",
          },
          {
            label: "Active Runs",
            value: initial.dashboard.active_runs,
            tone: initial.dashboard.active_runs > 0 ? "accent" : "default",
            hint: initial.dashboard.active_runs > 0 ? "Live now" : "Idle",
          },
        ]}
      />

      <QuotaCard clients={initial.clients} />

      <ClientsGridView clients={initial.clients} variant="preview" limit={4} />
    </div>
  );
}
