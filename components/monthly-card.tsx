"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { StatsStrip } from "@/components/stats-strip";
import { fmtDateTime, fmtInt } from "@/lib/format";
import type { IndexedValue } from "@/lib/supabase";

type MonthlyRow = {
  url: string;
  submitted: boolean;
  submitted_at: string | null;
  indexed: IndexedValue;
  last_checked: string | null;
  notes: string;
  attempts: number;
};

type MonthlyPayload = {
  summary: {
    submitted: number;
    indexed: number;
    pending: number;
    failed: number;
  };
  rows: MonthlyRow[];
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function lastSixMonths(): { year: number; month: number; label: string }[] {
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1;
  const out: { year: number; month: number; label: string }[] = [];
  for (let i = 0; i < 6; i++) {
    out.push({ year: y, month: m, label: `${MONTH_NAMES[m - 1]} ${y}` });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

export function MonthlyCard({ clientId, clientName }: { clientId: string; clientName: string }) {
  const months = useMemo(lastSixMonths, []);
  const [selected, setSelected] = useState(0);
  const [data, setData] = useState<MonthlyPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const sel = months[selected];

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/clients/${clientId}/monthly?year=${sel.year}&month=${sel.month}`,
        { cache: "no-store" },
      );
      const payload = (await res.json()) as MonthlyPayload | { error: string };
      if (!res.ok) {
        throw new Error(
          "error" in payload ? payload.error : `HTTP ${res.status}`,
        );
      }
      setData(payload as MonthlyPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [clientId, sel.year, sel.month]);

  useEffect(() => {
    load();
  }, [load]);

  const empty =
    data !== null &&
    data.summary.submitted === 0 &&
    data.summary.failed === 0;

  return (
    <div className="surface space-y-4 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3>Newly submitted pages</h3>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Manual URL submissions for {clientName} this month.
          </p>
        </div>
        <label
          className="flex items-center gap-2 text-xs"
          style={{ color: "var(--text-soft)" }}
        >
          <span className="caption">Month</span>
          <select
            value={selected}
            onChange={(e) => setSelected(Number.parseInt(e.target.value, 10))}
            className="rounded-lg border px-2 py-1.5 text-sm"
            style={{
              borderColor: "var(--border)",
              background: "var(--surface-alt)",
              color: "var(--text)",
            }}
          >
            {months.map((m, i) => (
              <option key={`${m.year}-${m.month}`} value={i}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </header>

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

      {loading && !data ? (
        <p className="text-sm" style={{ color: "var(--text-soft)" }}>
          Loading {sel.label}…
        </p>
      ) : null}

      {data && empty ? (
        <p className="text-sm" style={{ color: "var(--text-soft)" }}>
          No manual submissions for <strong>{clientName}</strong> in {sel.label}.
          Use <strong>Submit URLs</strong> in the sidebar to add newly published
          pages.
        </p>
      ) : null}

      {data && !empty ? (
        <>
          <StatsStrip
            items={[
              {
                label: `Submitted in ${sel.label}`,
                value: data.summary.submitted,
                tone: "accent",
              },
              {
                label: "Indexed by Google",
                value: data.summary.indexed,
                tone: "success",
              },
              {
                label: "Pending",
                value: data.summary.pending,
                tone: data.summary.pending > 0 ? "warning" : "default",
              },
              {
                label: "Failed",
                value: data.summary.failed,
                tone: data.summary.failed > 0 ? "warning" : "default",
              },
            ]}
          />

          {data.rows.length > 0 ? (
            <div>
              <button
                type="button"
                className="btn btn-ghost text-xs"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? "Hide" : "Show"} {data.rows.length} submission
                {data.rows.length === 1 ? "" : "s"} from {sel.label}
              </button>

              {expanded ? (
                <div
                  className="mt-3 max-h-[360px] overflow-auto rounded-lg border"
                  style={{ borderColor: "var(--border)" }}
                >
                  <table className="w-full text-sm">
                    <thead
                      className="sticky top-0"
                      style={{
                        background: "var(--surface-alt)",
                        color: "var(--text-muted)",
                        fontSize: "11px",
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                      }}
                    >
                      <tr style={{ borderBottom: "1px solid var(--border)" }}>
                        <th className="p-3 text-left">URL</th>
                        <th className="p-3 text-left">Submitted</th>
                        <th className="p-3 text-left">Submitted at</th>
                        <th className="p-3 text-left">Indexed</th>
                        <th className="p-3 text-left">Last checked</th>
                        <th className="p-3 text-right">Attempts</th>
                        <th className="p-3 text-left">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((r) => (
                        <tr
                          key={r.url}
                          style={{ borderBottom: "1px solid var(--border)" }}
                        >
                          <td className="max-w-[280px] truncate p-3 font-mono text-[12px]">
                            <a
                              href={r.url}
                              target="_blank"
                              rel="noreferrer"
                              title={r.url}
                            >
                              {r.url}
                            </a>
                          </td>
                          <td className="p-3">
                            {r.submitted ? (
                              <span
                                className="pill pill-success"
                                style={{ fontSize: "11px" }}
                              >
                                sent
                              </span>
                            ) : (
                              <span
                                className="pill pill-danger"
                                style={{ fontSize: "11px" }}
                              >
                                failed
                              </span>
                            )}
                          </td>
                          <td className="p-3 font-mono text-xs">
                            {r.submitted_at ? fmtDateTime(r.submitted_at) : "—"}
                          </td>
                          <td className="p-3">
                            <IndexedPill value={r.indexed} />
                          </td>
                          <td className="p-3 font-mono text-xs">
                            {r.last_checked ? fmtDateTime(r.last_checked) : "—"}
                          </td>
                          <td className="p-3 text-right font-mono">
                            {fmtInt(r.attempts)}
                          </td>
                          <td
                            className="max-w-[260px] truncate p-3 text-xs"
                            style={{ color: "var(--text-soft)" }}
                            title={r.notes}
                          >
                            {r.notes || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function IndexedPill({ value }: { value: IndexedValue }) {
  if (value === "yes")
    return (
      <span className="pill pill-success" style={{ fontSize: "11px" }}>
        indexed
      </span>
    );
  if (value === "no")
    return (
      <span className="pill pill-danger" style={{ fontSize: "11px" }}>
        not indexed
      </span>
    );
  return (
    <span className="pill pill-accent" style={{ fontSize: "11px" }}>
      pending
    </span>
  );
}
