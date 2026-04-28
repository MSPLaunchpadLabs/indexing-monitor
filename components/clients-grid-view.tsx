"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ClientCard } from "@/components/client-card";
import { GhostAddCard } from "@/components/ghost-add-card";
import type { ClientListItem } from "@/lib/supabase";

type Variant = "full" | "preview";

type Props = {
  clients: ClientListItem[];
  variant?: Variant;
  /** Limit shown clients (used by the dashboard preview). */
  limit?: number;
};

export function ClientsGridView({
  clients,
  variant = "full",
  limit,
}: Props) {
  const [search, setSearch] = useState("");
  const isPreview = variant === "preview";

  const filtered = useMemo(() => {
    if (isPreview) {
      const sorted = [...clients].sort(
        (a, b) => (b.stats?.indexed ?? 0) - (a.stats?.indexed ?? 0),
      );
      return typeof limit === "number" ? sorted.slice(0, limit) : sorted;
    }
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.domain.toLowerCase().includes(q),
    );
  }, [clients, search, isPreview, limit]);

  return (
    <section id="clients" className="space-y-4 scroll-mt-8">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto flex items-baseline gap-2">
          <h2>Clients</h2>
          <span className="text-sm" style={{ color: "var(--text-soft)" }}>
            {isPreview
              ? `top ${filtered.length} by indexed`
              : `(${filtered.length} of ${clients.length})`}
          </span>
        </div>
        {isPreview ? (
          <Link href="/clients" className="btn btn-primary">
            View all clients →
          </Link>
        ) : (
          <>
            <input
              className="input max-w-sm"
              placeholder="Search by name or domain…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Link href="/clients/new" className="btn btn-primary">
              + Add new client
            </Link>
          </>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState hasClients={clients.length > 0} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((c) => (
            <ClientCard key={c.id} client={c} showDelete={!isPreview} />
          ))}
          {isPreview ? null : <GhostAddCard />}
        </div>
      )}
    </section>
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
