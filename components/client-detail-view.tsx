"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { StatsStrip } from "@/components/stats-strip";
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

type Tab = "overview" | "run" | "history";

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
              : "Start a new check"}
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
        <RunPanel run={runStatus} />
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
  const { client, stats, reason_breakdown } = detail;
  return (
    <div className="space-y-6">
      <MonthlyCard clientId={client.id} clientName={client.name} />

      {stats ? (
        <StatsStrip
          items={[
            { label: "Total URLs", value: stats.total },
            {
              label: "Indexed",
              value: stats.indexed,
              tone: "success",
            },
            {
              label: "Not indexed",
              value: stats.not_indexed,
              tone: stats.not_indexed > 0 ? "warning" : "default",
            },
            {
              label: "Submitted",
              value: stats.submitted,
              tone: "accent",
              hint: "last run",
            },
          ]}
        />
      ) : (
        <div
          className="surface p-6 text-sm"
          style={{ color: "var(--text-soft)" }}
        >
          No completed run yet. Click <strong>Start a new check</strong> to
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

      {reason_breakdown.length > 0 ? (
        <div className="surface space-y-3 p-5">
          <h3>Why URLs are not indexed</h3>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Grouped by Google&apos;s reason, from the last completed run.
          </p>
          <ul className="space-y-2">
            {reason_breakdown.map((r) => (
              <li
                key={r.reason}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--surface-alt)",
                }}
              >
                <span className="truncate text-sm">{r.reason}</span>
                <span className="pill pill-warning">{fmtInt(r.count)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
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
function RunPanel({ run }: { run: RunStatusPayload["run"] }) {
  if (!run) {
    return (
      <div
        className="surface p-6 text-sm"
        style={{ color: "var(--text-soft)" }}
      >
        No run has been started yet for this client. Click{" "}
        <strong>Start a new check</strong> above.
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
    </div>
  );
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
