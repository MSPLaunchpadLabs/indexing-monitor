"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fmtInt, fmtRelative } from "@/lib/format";
import { ProgressBar } from "@/components/progress-bar";
import type { ClientListItem } from "@/lib/supabase";

export function ClientCard({
  client,
  showDelete = false,
}: {
  client: ClientListItem;
  showDelete?: boolean;
}) {
  const router = useRouter();
  const [dispatching, setDispatching] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { stats, current_run } = client;
  const isRunning = !!current_run;
  const detailHref = `/clients/${client.id}`;

  function goToDetail() {
    router.push(detailHref);
  }

  function handleOpen(e: React.MouseEvent) {
    e.stopPropagation();
    goToDetail();
  }

  async function handleRunNow(e: React.MouseEvent) {
    e.stopPropagation();
    if (dispatching || isRunning) return;
    setDispatching(true);
    try {
      const res = await fetch(`/api/clients/${client.id}/run`, {
        method: "POST",
      });
      // Navigate to the detail page so the user sees live progress regardless
      // of whether dispatch succeeded or was rejected (409 = already running).
      if (res.ok || res.status === 409) {
        router.push(detailHref);
      } else {
        router.push(detailHref);
      }
    } catch {
      router.push(detailHref);
    } finally {
      setDispatching(false);
    }
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (deleting) return;
    const ok = window.confirm(
      `Delete "${client.name}"?\n\nThis removes the client and ALL run history, URL status, and submissions. This cannot be undone.`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        window.alert(`Delete failed: ${data?.error ?? `HTTP ${res.status}`}`);
        setDeleting(false);
        return;
      }
      router.refresh();
    } catch (err) {
      window.alert(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      setDeleting(false);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={goToDetail}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          goToDetail();
        }
      }}
      className="surface surface-hover group flex cursor-pointer flex-col gap-4 p-5"
      style={{ color: "var(--text)" }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{client.name}</h3>
          <p
            className="truncate text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            {client.domain}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {current_run ? (
            <span className="pill pill-accent">
              <span
                aria-hidden
                className="animate-pulse"
                style={{ color: "var(--accent)", lineHeight: 1 }}
              >
                ●
              </span>
              Running
            </span>
          ) : stats ? (
            <span className="pill pill-neutral">
              {fmtRelative(client.last_run_at)}
            </span>
          ) : (
            <span className="pill pill-warning">No runs yet</span>
          )}
          {showDelete ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              aria-label={`Delete ${client.name}`}
              className="grid h-7 w-7 cursor-pointer place-items-center rounded-md border border-white/10 bg-white/[0.03] text-xs text-slate-400 opacity-0 transition-colors hover:border-[rgba(251,113,133,0.4)] hover:bg-[rgba(251,113,133,0.12)] hover:text-[var(--color-danger)] focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {deleting ? "…" : "✕"}
            </button>
          ) : null}
        </div>
      </div>

      {stats ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat
              label="Indexed"
              value={fmtInt(stats.indexed)}
              color="var(--color-success)"
            />
            <Stat
              label="Not indexed"
              value={fmtInt(stats.not_indexed)}
              color={
                stats.not_indexed > 0
                  ? "var(--color-warning)"
                  : "var(--text-muted)"
              }
            />
            <Stat
              label="Submitted"
              value={fmtInt(stats.submitted)}
              color="var(--accent)"
            />
          </div>
          <p
            className="text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            {client.last_run_at
              ? `Last run ${fmtRelative(client.last_run_at)} · ${fmtInt(
                  stats.total,
                )} URLs tracked`
              : `${fmtInt(stats.total)} URLs tracked`}
          </p>
        </>
      ) : (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Click to run the first check against this property.
        </p>
      )}

      {current_run ? (
        <div
          className="rounded-lg border p-3 text-xs"
          style={{
            borderColor: "var(--accent-border)",
            background: "var(--accent-soft)",
          }}
        >
          <div
            className="mb-1.5 flex items-center justify-between"
            style={{ color: "var(--accent)" }}
          >
            <span className="font-semibold">Submitting URLs</span>
            <span className="mono">
              {fmtInt(current_run.current)} / {fmtInt(current_run.total)}
            </span>
          </div>
          <ProgressBar pct={current_run.pct} />
        </div>
      ) : null}

      <div
        className="mt-4 flex gap-2 border-t pt-3.5"
        style={{ borderTopColor: "rgba(255,255,255,0.06)" }}
      >
        <button
          type="button"
          onClick={handleOpen}
          className="flex-1 cursor-pointer rounded-lg border border-white/15 bg-transparent px-3 py-2 text-[13px] font-medium text-slate-200 transition-colors hover:bg-white/5 active:scale-[0.99]"
        >
          Open
        </button>
        <button
          type="button"
          onClick={handleRunNow}
          disabled={dispatching || isRunning}
          className="flex-[2] cursor-pointer rounded-lg border-0 bg-[#f97316] px-3 py-2 text-[13px] font-medium text-white shadow-[0_1px_8px_rgba(249,115,22,0.35)] transition-colors hover:bg-[#e86a10] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55"
        >
          {dispatching ? "Dispatching…" : "▶ Run Now"}
        </button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div>
      <div
        className="text-[11px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </div>
      <div
        className="font-display text-lg font-semibold leading-tight"
        style={{ color }}
      >
        {value}
      </div>
    </div>
  );
}
