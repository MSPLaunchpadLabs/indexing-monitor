"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ClientCard } from "@/components/client-card";
import { StatsStrip } from "@/components/stats-strip";
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
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return initial.clients;
    return initial.clients.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.domain.toLowerCase().includes(q),
    );
  }, [initial.clients, search]);

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
            label: "Total clients",
            value: initial.dashboard.total_clients,
            hint: `${
              initial.clients.filter((c) => c.stats).length
            } with run data`,
          },
          {
            label: "URLs tracked",
            value: initial.dashboard.urls_tracked,
            hint: "Across all sitemaps",
          },
          {
            label: "Indexed",
            value: initial.dashboard.indexed,
            tone: "success",
            hint:
              initial.dashboard.urls_tracked > 0
                ? `${initial.dashboard.indexed} of ${initial.dashboard.urls_tracked} · ${Math.round(
                    (initial.dashboard.indexed /
                      initial.dashboard.urls_tracked) *
                      100,
                  )}%`
                : "No runs yet",
          },
          {
            label: "Active runs",
            value: initial.dashboard.active_runs,
            tone: initial.dashboard.active_runs > 0 ? "accent" : "default",
            hint: initial.dashboard.active_runs > 0 ? "Live now" : "Idle",
          },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <span
          className="mr-auto text-sm"
          style={{ color: "var(--text-soft)" }}
        >
          Showing{" "}
          <strong style={{ color: "var(--text)" }}>{filtered.length}</strong>{" "}
          of{" "}
          <strong style={{ color: "var(--text)" }}>
            {initial.clients.length}
          </strong>
        </span>
        <input
          className="input max-w-sm"
          placeholder="Search by name or domain…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Link href="/clients/new" className="btn btn-primary">
          + Add new client
        </Link>
      </div>

      <hr />

      {filtered.length === 0 ? (
        <EmptyState hasClients={initial.clients.length > 0} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((c) => (
            <ClientCard key={c.id} client={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ hasClients }: { hasClients: boolean }) {
  return (
    <div
      className="surface flex flex-col items-center gap-4 p-10 text-center"
      style={{ background: "var(--surface)" }}
    >
      <h3>{hasClients ? "No matches" : "No clients yet"}</h3>
      <p className="max-w-md" style={{ color: "var(--text-soft)" }}>
        {hasClients
          ? "Nothing matches the search. Try a different query."
          : "Add your first client to start tracking Google indexing."}
      </p>
      {!hasClients ? (
        <Link href="/clients/new" className="btn btn-primary">
          Add client
        </Link>
      ) : null}
    </div>
  );
}
