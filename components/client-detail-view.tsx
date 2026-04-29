"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ProgressBar } from "@/components/progress-bar";
import { MonthlyCard } from "@/components/monthly-card";
import {
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtInt,
  fmtRelative,
} from "@/lib/format";
import type { ClientRow, RunStats, RunStatus } from "@/lib/supabase";

type UrlFilter = "all" | "indexed" | "not_indexed" | "submitted";

type UrlListMode =
  | { kind: "filter"; filter: UrlFilter }
  | { kind: "reason"; reason: string };

type UrlListRow = {
  url: string;
  indexed: "yes" | "no" | "unknown" | null;
  last_checked: string | null;
  submitted: boolean;
  last_submitted: string | null;
  notes: string | null;
};

type Reason = { reason: string; count: number };
type CurrentRun = {
  id: string;
  status: RunStatus;
  current: number;
  total: number;
  pct: number;
  started_at: string;
};
type DetailPayload = {
  client: ClientRow;
  stats: RunStats | null;
  last_run_at: string | null;
  reason_breakdown: Reason[];
  current_run: CurrentRun | null;
};

type RunStatusPayload = {
  run: null | {
    id: string;
    status: RunStatus;
    started_at: string;
    finished_at: string | null;
    total: number;
    current: number;
    pct: number;
    error: string | null;
    log_tail: string[];
    stats: RunStats;
  };
};

type HistoryItem = {
  id: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  stats: RunStats;
};

type HistoryPayload = { runs: HistoryItem[] };

type Tab = "overview" | "run" | "coverage" | "history";

export function ClientDetailView({ initial }: { initial: DetailPayload }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [detail, setDetail] = useState<DetailPayload>(initial);
  const [runStatus, setRunStatus] = useState<RunStatusPayload["run"]>(
    initial.current_run
      ? {
          ...initial.current_run,
          finished_at: null,
          error: null,
          log_tail: [],
          stats: { total: 0, indexed: 0, not_indexed: 0, submitted: 0 },
        }
      : null,
  );
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const clientId = initial.client.id;

  // ------------------------------------------------------------------
  // Polling: hit /run-status every 2s while a run is live.
  // ------------------------------------------------------------------
  const shouldPoll = runStatus?.status === "running";
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const tick = useCallback(async () => {
    try {
      const res = await fetch(`/api/clients/${clientId}/run-status`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as RunStatusPayload;
      setRunStatus(data.run);

      // When the run transitions out of 'running', refresh the detail page
      // so the overview stats reflect the new snapshot without a full reload.
      if (data.run && data.run.status !== "running") {
        const fresh = await fetch(`/api/clients/${clientId}`, {
          cache: "no-store",
        });
        if (fresh.ok) setDetail((await fresh.json()) as DetailPayload);
        // Invalidate history cache if we were viewing that tab.
        setHistory(null);
      }
    } catch {
      // Transient network error — the next tick will retry.
    }
  }, [clientId]);

  useEffect(() => {
    if (!shouldPoll) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    tick();
    pollRef.current = setInterval(tick, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [shouldPoll, tick]);

  // ------------------------------------------------------------------
  // Load history lazily the first time the tab is opened.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (tab !== "history" || history !== null) return;
    (async () => {
      try {
        const res = await fetch(`/api/clients/${clientId}/history`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as HistoryPayload;
        setHistory(data.runs);
      } catch (err) {
        console.warn("history fetch failed", err);
        setHistory([]);
      }
    })();
  }, [tab, history, clientId]);

  async function startRun() {
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/run`, {
        method: "POST",
      });
      const data = (await res.json()) as {
        error?: string;
        run_id?: string;
        status?: string;
      };
      if (!res.ok) {
        setStartError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setTab("run");
      // Seed a placeholder run state so the UI shows "queued…" immediately.
      setRunStatus({
        id: data.run_id ?? "",
        status: "running",
        started_at: new Date().toISOString(),
        finished_at: null,
        total: 0,
        current: 0,
        pct: 0,
        error: null,
        log_tail: ["queued · waiting for GitHub Actions runner"],
        stats: { total: 0, indexed: 0, not_indexed: 0, submitted: 0 },
      });
      tick();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/" className="btn btn-ghost inline-flex w-fit">
        ← All clients
      </Link>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>{detail.client.name}</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-soft)" }}>
            <span className="mono">{detail.client.domain}</span> ·
            {detail.last_run_at
              ? ` last run ${fmtRelative(detail.last_run_at)}`
              : " no completed runs yet"}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={starting || runStatus?.status === "running"}
          onClick={startRun}
        >
          {runStatus?.status === "running"
            ? "Run in progress"
            : starting
              ? "Dispatching…"
              : "Run now"}
        </button>
      </header>

      {startError ? (
        <div
          className="rounded-lg border p-3 text-sm"
          style={{
            borderColor: "rgba(251,113,133,0.3)",
            background: "rgba(251,113,133,0.08)",
            color: "var(--color-danger)",
          }}
        >
          {startError}
        </div>
      ) : null}

      <TabNav tab={tab} onChange={setTab} />

      {tab === "overview" ? (
        <OverviewPanel detail={detail} />
      ) : tab === "run" ? (
        <RunPanel run={runStatus} clientId={detail.client.id} />
      ) : tab === "coverage" ? (
        <CoveragePanel
          clientId={detail.client.id}
          reasonBreakdown={detail.reason_breakdown}
        />
      ) : (
        <HistoryPanel runs={history} />
      )}
    </div>
  );
}

// ===========================================================================
// Tab bar
// ===========================================================================
function TabNav({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "run", label: "Run" },
    { id: "coverage", label: "Coverage" },
    { id: "history", label: "History" },
  ];
  return (
    <div
      className="flex gap-1 rounded-lg border p-1"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface-alt)",
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          aria-selected={tab === t.id}
          className={clsx(
            "flex-1 rounded-md px-3 py-2 text-sm font-semibold transition",
            tab === t.id ? "" : "hover:opacity-80",
          )}
          style={{
            background: tab === t.id ? "var(--surface)" : "transparent",
            color: tab === t.id ? "var(--text)" : "var(--text-soft)",
            boxShadow: tab === t.id ? "var(--shadow)" : "none",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ===========================================================================
// Overview
// ===========================================================================
function OverviewPanel({ detail }: { detail: DetailPayload }) {
  const { client, stats } = detail;
  const [filter, setFilter] = useState<UrlFilter | null>(null);

  function toggle(next: UrlFilter) {
    setFilter((cur) => (cur === next ? null : next));
  }

  return (
    <div className="space-y-6">
      <MonthlyCard clientId={client.id} clientName={client.name} />

      {stats ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <GoogleLogo />
            <h3 className="text-base font-semibold">Google Search</h3>
            <span className="pill pill-success">Active</span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
            <StatTile
              label="Total URLs"
              value={stats.total}
              color="var(--text)"
              icon="#"
              selected={filter === "all"}
              onClick={() => toggle("all")}
            />
            <StatTile
              label="Indexed"
              value={stats.indexed}
              color="var(--color-success)"
              icon="✓"
              selected={filter === "indexed"}
              onClick={() => toggle("indexed")}
            />
            <StatTile
              label="Not Indexed"
              value={stats.not_indexed}
              color="var(--color-danger)"
              icon="✕"
              selected={filter === "not_indexed"}
              onClick={() => toggle("not_indexed")}
            />
            <StatTile
              label="Submitted for Indexing"
              value={stats.submitted}
              color="var(--accent)"
              icon="↑"
              selected={filter === "submitted"}
              onClick={() => toggle("submitted")}
            />
          </div>

          {filter ? (
            <UrlListPanel
              clientId={client.id}
              mode={{ kind: "filter", filter }}
              onClose={() => setFilter(null)}
            />
          ) : null}
        </div>
      ) : (
        <div
          className="surface p-6 text-sm"
          style={{ color: "var(--text-soft)" }}
        >
          No completed run yet. Click <strong>Run now</strong> to
          generate the first report.
        </div>
      )}

      <div className="surface space-y-2 p-5">
        <h3>Property</h3>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Field label="Domain" value={client.domain} mono />
          <Field label="Sitemap" value={client.sitemap_url} mono link />
          <Field
            label="Search Console"
            value={client.gsc_site_url}
            mono
          />
          <Field label="Added" value={fmtDate(client.created_at)} />
        </dl>
      </div>

    </div>
  );
}

// ===========================================================================
// Coverage — "Why URLs are not indexed" with clickable reason → URL list.
// Kept as its own tab so the Overview stays focused on the headline numbers.
// ===========================================================================
function CoveragePanel({
  clientId,
  reasonBreakdown,
}: {
  clientId: string;
  reasonBreakdown: Reason[];
}) {
  const [selectedReason, setSelectedReason] = useState<string | null>(null);

  function toggleReason(next: string) {
    setSelectedReason((cur) => (cur === next ? null : next));
  }

  if (reasonBreakdown.length === 0) {
    return (
      <div
        className="surface p-6 text-sm"
        style={{ color: "var(--text-soft)" }}
      >
        No coverage breakdown yet. Run a check to pull Google&apos;s reasons
        for any pages that aren&apos;t indexed.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="surface space-y-3 p-5">
        <h3>Why URLs are not indexed</h3>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Grouped by Google&apos;s reason, from the last completed run. Click
          a reason to see the URLs.
        </p>
        <ul className="space-y-2">
          {reasonBreakdown.map((r) => {
            const isSelected = selectedReason === r.reason;
            return (
              <li key={r.reason}>
                <button
                  type="button"
                  onClick={() => toggleReason(r.reason)}
                  aria-pressed={isSelected}
                  className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-white/5"
                  style={{
                    borderColor: isSelected
                      ? "var(--accent-border)"
                      : "var(--border)",
                    background: "var(--surface-alt)",
                    boxShadow: isSelected
                      ? "0 0 0 1px var(--accent-border)"
                      : undefined,
                  }}
                >
                  <span className="truncate text-sm">{r.reason}</span>
                  <span className="pill pill-warning">{fmtInt(r.count)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {selectedReason ? (
        <UrlListPanel
          clientId={clientId}
          mode={{ kind: "reason", reason: selectedReason }}
          onClose={() => setSelectedReason(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat tile — clickable card under the Google Search header
// ---------------------------------------------------------------------------
function StatTile({
  label,
  value,
  color,
  icon,
  selected,
  onClick,
}: {
  label: string;
  value: number;
  color: string;
  icon: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <div className="flex items-center justify-between">
        <span className="caption">{label}</span>
        <span
          aria-hidden
          className="grid h-6 w-6 place-items-center rounded-md text-sm font-semibold"
          style={{
            background: `color-mix(in srgb, ${color} 18%, transparent)`,
            color,
          }}
        >
          {icon}
        </span>
      </div>
      <span
        className="font-display text-2xl font-semibold leading-tight"
        style={{ color }}
      >
        {fmtInt(value)}
      </span>
    </>
  );

  const tileStyle: React.CSSProperties = {
    background: "var(--surface)",
    borderColor: selected ? "var(--accent-border)" : undefined,
    boxShadow: selected
      ? "0 0 0 1px var(--accent-border), var(--shadow)"
      : undefined,
  };

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={!!selected}
        className="surface surface-hover flex cursor-pointer flex-col gap-2 p-4 text-left"
        style={tileStyle}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      className="surface flex flex-col gap-2 p-4"
      style={tileStyle}
    >
      {inner}
    </div>
  );
}

// ---------------------------------------------------------------------------
// URL list — opens under the stat cards when one is selected
// ---------------------------------------------------------------------------
function UrlListPanel({
  clientId,
  mode,
  onClose,
}: {
  clientId: string;
  mode: UrlListMode;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<UrlListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const fetchUrl =
    mode.kind === "filter"
      ? `/api/clients/${clientId}/urls?status=${mode.filter}`
      : `/api/clients/${clientId}/urls-by-reason?reason=${encodeURIComponent(
          mode.reason,
        )}`;

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(fetchUrl, { cache: "no-store" });
        const data = (await res.json()) as { urls?: UrlListRow[]; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? `HTTP ${res.status}`);
          setRows([]);
          return;
        }
        setRows(data.urls ?? []);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchUrl]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => r.url.toLowerCase().includes(q))
      : rows;
    const isAllFilter = mode.kind === "filter" && mode.filter === "all";
    if (!isAllFilter) return filtered;
    // For "All URLs" view: group by indexed status with Indexed on top, then
    // Not Indexed, then Unknown — and within each group, freshest first.
    const rank = (r: UrlListRow) =>
      r.indexed === "yes" ? 0 : r.indexed === "no" ? 1 : 2;
    return [...filtered].sort((a, b) => {
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      const at = a.last_checked ? new Date(a.last_checked).getTime() : 0;
      const bt = b.last_checked ? new Date(b.last_checked).getTime() : 0;
      return bt - at;
    });
  }, [rows, search, mode]);

  const heading =
    mode.kind === "reason"
      ? mode.reason
      : mode.filter === "all"
        ? "All URLs"
        : mode.filter === "indexed"
          ? "Indexed URLs"
          : mode.filter === "not_indexed"
            ? "Not Indexed URLs"
            : "Submitted URLs";

  return (
    <div className="surface space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto flex items-baseline gap-2">
          <h3>{heading}</h3>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {rows ? `${visible.length} of ${rows.length}` : "loading…"}
          </span>
        </div>
        <input
          className="input max-w-xs"
          placeholder="Search URLs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          onClick={onClose}
          className="btn btn-ghost"
          aria-label="Close URL list"
        >
          Close ✕
        </button>
      </div>

      {error ? (
        <div
          className="rounded-lg border p-3 text-sm"
          style={{
            borderColor: "rgba(251,113,133,0.3)",
            background: "rgba(251,113,133,0.08)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      ) : null}

      {rows === null ? (
        <p className="text-sm" style={{ color: "var(--text-soft)" }}>
          Loading…
        </p>
      ) : visible.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-soft)" }}>
          {rows.length === 0
            ? "No URLs match this filter yet."
            : "Nothing matches the search."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr
                className="text-left"
                style={{
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  fontSize: "11px",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                <th className="px-3 py-2">URL</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Submitted</th>
                <th className="px-3 py-2">Last Checked</th>
                <th className="px-3 py-2">Coverage</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <UrlRow
                  key={r.url}
                  row={r}
                  clientId={clientId}
                  onUpdate={(updated) =>
                    setRows((prev) =>
                      prev
                        ? prev.map((p) =>
                            p.url === updated.url ? { ...p, ...updated } : p,
                          )
                        : prev,
                    )
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type UrlActionUpdate = Partial<UrlListRow> & { url: string };

// Google's typical indexing window after a URL is submitted to the
// Indexing API. There's no SLA — these numbers come from the Search
// Console docs as a rough operator expectation.
const INDEX_EXPECTED_DAYS_MIN = 1;
const INDEX_EXPECTED_DAYS_MAX = 7;

function SubmittedCell({
  lastSubmitted,
  submitted,
  indexed,
}: {
  lastSubmitted: string | null;
  submitted: boolean;
  indexed: "yes" | "no" | "unknown" | null;
}) {
  if (!lastSubmitted) {
    return <span style={{ color: "var(--text-muted)" }}>—</span>;
  }
  const sentMs = new Date(lastSubmitted).getTime();
  const ageDays = (Date.now() - sentMs) / (1000 * 60 * 60 * 24);
  const isIndexed = indexed === "yes";

  // Pending: not yet confirmed indexed → estimate a window.
  // Confirmed indexed: just say "Indexed".
  // Late (still not indexed past the window): nudge.
  let hint: { label: string; tone: string };
  if (isIndexed) {
    hint = { label: "Indexed by Google", tone: "var(--color-success)" };
  } else if (!submitted) {
    hint = { label: "submission failed", tone: "var(--color-danger)" };
  } else if (ageDays > INDEX_EXPECTED_DAYS_MAX) {
    hint = {
      label: `still pending after ${Math.floor(ageDays)}d — try Re-inspect`,
      tone: "var(--color-warning)",
    };
  } else {
    const remainingMin = Math.max(0, INDEX_EXPECTED_DAYS_MIN - ageDays);
    const remainingMax = Math.max(0, INDEX_EXPECTED_DAYS_MAX - ageDays);
    if (remainingMax === 0) {
      hint = {
        label: "expected indexing soon",
        tone: "var(--text-muted)",
      };
    } else {
      const lo = Math.max(1, Math.ceil(remainingMin));
      const hi = Math.max(lo, Math.ceil(remainingMax));
      hint = {
        label: `expected in ${lo === hi ? `${hi}d` : `${lo}–${hi}d`}`,
        tone: "var(--text-muted)",
      };
    }
  }

  const tooltip = `Submitted ${fmtDateTime(lastSubmitted)} — Google typically indexes URLs within ${INDEX_EXPECTED_DAYS_MIN}–${INDEX_EXPECTED_DAYS_MAX} days after submission.`;

  return (
    <span title={tooltip} className="inline-flex flex-col gap-0.5">
      <span style={{ color: "var(--text)" }}>
        {fmtRelative(lastSubmitted)}
      </span>
      <span className="text-[11px]" style={{ color: hint.tone }}>
        {hint.label}
      </span>
    </span>
  );
}

function UrlRow({
  row,
  clientId,
  onUpdate,
}: {
  row: UrlListRow;
  clientId: string;
  onUpdate: (next: UrlActionUpdate) => void;
}) {
  const [busy, setBusy] = useState<"submit" | "inspect" | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "ok" | "err";
    message: string;
  } | null>(null);

  const indexedTone =
    row.indexed === "yes"
      ? "pill-success"
      : row.indexed === "no"
        ? "pill-danger"
        : "pill-neutral";
  const indexedLabel =
    row.indexed === "yes"
      ? "Indexed"
      : row.indexed === "no"
        ? "Not Indexed"
        : "Unknown";

  async function runAction(action: "submit" | "inspect") {
    if (busy) return;
    setBusy(action);
    setFeedback(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/url-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: row.url, action }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        message?: string;
        row?: UrlActionUpdate | null;
        error?: string;
      };
      if (!res.ok) {
        setFeedback({
          tone: "err",
          message: data.error ?? data.message ?? `HTTP ${res.status}`,
        });
        return;
      }
      if (data.row) onUpdate(data.row);
      setFeedback({
        tone: data.ok ? "ok" : "err",
        message:
          data.message ??
          (action === "submit" ? "Submitted" : "Inspected"),
      });
    } catch (err) {
      setFeedback({
        tone: "err",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <tr style={{ borderBottom: "1px solid var(--border)" }}>
      <td className="px-3 py-2">
        <a
          href={row.url}
          target="_blank"
          rel="noreferrer"
          className="mono text-[12.5px]"
          style={{ color: "var(--text)" }}
          onClick={(e) => e.stopPropagation()}
        >
          {row.url}
        </a>
      </td>
      <td className="px-3 py-2">
        <span className={`pill ${indexedTone}`}>{indexedLabel}</span>
      </td>
      <td className="px-3 py-2 text-xs" style={{ color: "var(--text-soft)" }}>
        <SubmittedCell
          lastSubmitted={row.last_submitted}
          submitted={row.submitted}
          indexed={row.indexed}
        />
      </td>
      <td className="px-3 py-2 mono" style={{ color: "var(--text-soft)" }}>
        {row.last_checked ? fmtDateTime(row.last_checked) : "—"}
      </td>
      <td className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
        {feedback ? (
          <span
            style={{
              color:
                feedback.tone === "ok"
                  ? "var(--color-success)"
                  : "var(--color-danger)",
            }}
            title={feedback.message}
          >
            {feedback.message}
          </span>
        ) : (
          row.notes || (row.submitted ? "Submitted to Indexing API" : "—")
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex justify-end gap-1">
          <a
            href={`https://www.google.com/search?q=site:${encodeURIComponent(row.url)}`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost"
            title="View on Google"
            aria-label="View on Google"
            style={{ padding: "0.3rem 0.55rem", fontSize: "13px" }}
          >
            🔍
          </a>
          <button
            type="button"
            className="btn btn-ghost"
            title="Re-submit to Indexing API"
            aria-label="Re-submit to Indexing API"
            disabled={busy !== null}
            onClick={() => runAction("submit")}
            style={{ padding: "0.3rem 0.55rem", fontSize: "13px" }}
          >
            {busy === "submit" ? "…" : "↑"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            title="Re-inspect with URL Inspection API"
            aria-label="Re-inspect with URL Inspection API"
            disabled={busy !== null}
            onClick={() => runAction("inspect")}
            style={{ padding: "0.3rem 0.55rem", fontSize: "13px" }}
          >
            {busy === "inspect" ? "…" : "🔄"}
          </button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Google logo (multi-color G)
// ---------------------------------------------------------------------------
function GoogleLogo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-label="Google"
      role="img"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
  );
}

function Field({
  label,
  value,
  mono,
  link,
}: {
  label: string;
  value: string;
  mono?: boolean;
  link?: boolean;
}) {
  return (
    <div>
      <dt className="caption mb-1">{label}</dt>
      <dd
        className={clsx(
          "break-all",
          mono ? "font-mono text-[12.5px]" : "text-sm",
        )}
        style={{ color: "var(--text)" }}
      >
        {link ? (
          <a href={value} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

// ===========================================================================
// Run tab
// ===========================================================================
function RunPanel({
  run,
  clientId,
}: {
  run: RunStatusPayload["run"];
  clientId: string;
}) {
  if (!run) {
    return (
      <div className="space-y-5">
        <div
          className="surface p-6 text-sm"
          style={{ color: "var(--text-soft)" }}
        >
          No run has been started yet for this client. Click{" "}
          <strong>Run now</strong> above.
        </div>
        <ActivityLog clientId={clientId} />
      </div>
    );
  }

  const isRunning = run.status === "running";
  const isFailed = run.status === "failed";
  const isDone = run.status === "done";

  return (
    <div className="space-y-5">
      <div
        className="surface space-y-4 p-5"
        style={{
          borderColor: isFailed
            ? "rgba(251,113,133,0.35)"
            : isRunning
              ? "var(--accent-border)"
              : "var(--border)",
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-2">
              Run{" "}
              <span className="mono text-xs" style={{ color: "var(--text-muted)" }}>
                {run.id.slice(0, 8)}
              </span>
            </h3>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Started {fmtDateTime(run.started_at)} ·{" "}
              {fmtDuration(run.started_at, run.finished_at)}
            </p>
          </div>
          <span
            className={clsx(
              "pill",
              isRunning
                ? "pill-accent"
                : isFailed
                  ? "pill-danger"
                  : "pill-success",
            )}
          >
            {run.status}
          </span>
        </div>

        <ProgressBar
          pct={run.total ? (run.current / run.total) * 100 : run.pct}
          tone={isFailed ? "danger" : isDone ? "success" : "accent"}
          label={`${fmtInt(run.current)} / ${fmtInt(run.total)} URLs inspected`}
        />

        {run.error ? (
          <pre
            className="overflow-auto rounded-lg border p-3 text-xs"
            style={{
              borderColor: "rgba(251,113,133,0.3)",
              background: "rgba(251,113,133,0.08)",
              color: "var(--color-danger)",
            }}
          >
            {run.error}
          </pre>
        ) : null}
      </div>

      <div className="surface p-5">
        <h3 className="mb-3">Log tail</h3>
        <pre
          className="max-h-96 overflow-auto rounded-lg border p-3 text-xs leading-relaxed"
          style={{
            borderColor: "var(--border)",
            background: "var(--code-bg)",
            color: "var(--text-soft)",
          }}
        >
          {run.log_tail.length
            ? run.log_tail.join("\n")
            : "(no log output yet)"}
        </pre>
      </div>

      <ActivityLog clientId={clientId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity Log — recent URL submission events for this client. Polls every
// 15s. Source rows come from url_status (last_submitted, notes), so anything
// that gets pushed to the Indexing API surfaces here within one tick.
// ---------------------------------------------------------------------------
type ActivityEvent = {
  url: string;
  last_submitted: string | null;
  notes: string | null;
  submit_attempts: number;
  source: "sitemap" | "manual";
};

const ACTIVITY_REFRESH_MS = 15_000;

function ActivityLog({ clientId }: { clientId: string }) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [, setTickNow] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/clients/${clientId}/activity?limit=100`,
          { cache: "no-store" },
        );
        const data = (await res.json()) as {
          events?: ActivityEvent[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? `HTTP ${res.status}`);
          return;
        }
        setEvents(data.events ?? []);
        setError(null);
        setLastUpdated(Date.now());
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    tick();
    const id = setInterval(tick, ACTIVITY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [clientId]);

  // Drives the "Last updated: Ns ago" label so it ticks every second between
  // refreshes — without this it would only update on each fetch.
  useEffect(() => {
    const id = setInterval(() => setTickNow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const lastUpdatedLabel = lastUpdated
    ? `Last updated: ${formatAgo(Date.now() - lastUpdated)}`
    : "Last updated: --";

  return (
    <div className="surface p-5">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3>Activity Log</h3>
      </div>
      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Recent automation events · {lastUpdatedLabel} · refreshes every 15s
      </p>

      {error ? (
        <div
          className="mt-3 rounded-lg border p-3 text-sm"
          style={{
            borderColor: "rgba(251,113,133,0.3)",
            background: "rgba(251,113,133,0.08)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        {events === null ? (
          <p className="text-sm" style={{ color: "var(--text-soft)" }}>
            Loading…
          </p>
        ) : events.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-soft)" }}>
            No URL submission activity yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr
                className="text-left"
                style={{
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  fontSize: "11px",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">URL</th>
                <th className="px-3 py-2">Message</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <ActivityRow key={`${e.url}-${e.last_submitted}-${i}`} event={e} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  return (
    <tr
      className="align-middle"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <td
        className="whitespace-nowrap px-3 py-2"
        style={{ color: "var(--text-soft)" }}
      >
        {fmtDateTime(event.last_submitted)}
      </td>
      <td className="px-3 py-2">
        <span className="pill pill-success">Submit</span>
      </td>
      <td
        className="mono max-w-[24rem] truncate px-3 py-2 text-xs"
        style={{ color: "var(--text-soft)" }}
        title={event.url}
      >
        <a
          href={event.url}
          target="_blank"
          rel="noreferrer"
          style={{ color: "inherit" }}
        >
          {event.url}
        </a>
      </td>
      <td className="px-3 py-2" style={{ color: "var(--text)" }}>
        {event.notes?.trim() || "Submitted URL for indexing"}
      </td>
    </tr>
  );
}

function formatAgo(ms: number): string {
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

// ===========================================================================
// History tab
// ===========================================================================
function HistoryPanel({ runs }: { runs: HistoryItem[] | null }) {
  if (runs === null) {
    return (
      <div
        className="surface p-6 text-sm"
        style={{ color: "var(--text-soft)" }}
      >
        Loading history…
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div
        className="surface p-6 text-sm"
        style={{ color: "var(--text-soft)" }}
      >
        No runs yet. Start a check to record the first report.
      </div>
    );
  }
  return (
    <div className="surface overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr
            className="text-left"
            style={{
              borderBottom: "1px solid var(--border)",
              color: "var(--text-muted)",
              fontSize: "11px",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            <th className="p-3">Started</th>
            <th className="p-3">Status</th>
            <th className="p-3">Duration</th>
            <th className="p-3">Indexed</th>
            <th className="p-3">Not indexed</th>
            <th className="p-3">Submitted</th>
            <th className="p-3 text-right">CSV</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunRow({ run }: { run: HistoryItem }) {
  const tone =
    run.status === "done"
      ? "pill-success"
      : run.status === "failed"
        ? "pill-danger"
        : "pill-accent";
  return (
    <tr style={{ borderBottom: "1px solid var(--border)" }}>
      <td className="p-3">
        <div className="font-semibold">{fmtDateTime(run.started_at)}</div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          {fmtRelative(run.started_at)}
        </div>
      </td>
      <td className="p-3">
        <span className={`pill ${tone}`}>{run.status}</span>
      </td>
      <td className="p-3 mono">
        {fmtDuration(run.started_at, run.finished_at)}
      </td>
      <td className="p-3 mono" style={{ color: "var(--color-success)" }}>
        {fmtInt(run.stats.indexed)}
      </td>
      <td
        className="p-3 mono"
        style={{
          color:
            run.stats.not_indexed > 0
              ? "var(--color-warning)"
              : "var(--text-muted)",
        }}
      >
        {fmtInt(run.stats.not_indexed)}
      </td>
      <td className="p-3 mono">{fmtInt(run.stats.submitted)}</td>
      <td className="p-3 text-right">
        {run.status === "done" ? (
          <a
            className="btn btn-secondary text-xs"
            href={`/api/runs/${run.id}/csv`}
          >
            Download
          </a>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>—</span>
        )}
      </td>
    </tr>
  );
}
