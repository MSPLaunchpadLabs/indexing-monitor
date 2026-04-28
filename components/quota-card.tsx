"use client";

import { useEffect, useMemo, useState } from "react";
import { fmtInt, fmtRelative } from "@/lib/format";
import type { ClientListItem } from "@/lib/supabase";

const DAILY_LIMIT = 200;

type Props = {
  usedToday?: number;
  clients?: ClientListItem[];
};

export function QuotaCard({ usedToday, clients = [] }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Today-window filter — anything whose latest run finished within the last
  // 24h counts toward "today's" submissions. Lets the breakdown panel match
  // the headline numbers without needing a new API.
  const todayBreakdown = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return clients
      .map((c) => {
        const submitted = c.stats?.submitted ?? 0;
        const ts = c.last_run_at ? new Date(c.last_run_at).getTime() : 0;
        const within24h = ts >= cutoff;
        return {
          id: c.id,
          name: c.name,
          submitted: within24h ? submitted : 0,
          last_run_at: c.last_run_at,
          fresh: within24h,
        };
      })
      .sort((a, b) => b.submitted - a.submitted);
  }, [clients]);

  const derivedUsed = useMemo(
    () => todayBreakdown.reduce((sum, r) => sum + r.submitted, 0),
    [todayBreakdown],
  );

  const used = Math.max(
    0,
    Math.min(usedToday ?? derivedUsed, DAILY_LIMIT),
  );
  const remaining = Math.max(0, DAILY_LIMIT - used);
  const pct = Math.round((used / DAILY_LIMIT) * 100);

  const safe = pct < 80;
  const resetCountdown = useResetCountdown();

  const contributing = todayBreakdown.filter((r) => r.submitted > 0);

  return (
    <section
      className="surface surface-hover p-5"
      style={{ background: "var(--surface)" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">
            Google Indexing API — Daily Quota
          </h3>
          <p
            className="mt-0.5 text-xs"
            style={{ color: "var(--text-soft)" }}
          >
            URL submissions reset every 24h
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="text-xs"
            style={{ color: "var(--text-soft)" }}
          >
            Resets in <span className="mono">{resetCountdown}</span>
          </span>
          <span
            className="pill"
            style={{
              background: safe
                ? "rgba(74,222,128,0.12)"
                : "rgba(249,115,22,0.12)",
              color: safe ? "var(--color-success)" : "var(--accent)",
              border: safe
                ? "1px solid rgba(74,222,128,0.25)"
                : "1px solid var(--accent-border)",
            }}
          >
            ● {safe ? "Safe" : "High"}
          </span>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-4">
        <QuotaStat label="Used Today" value={used} color="var(--accent)" />
        <QuotaStat
          label="Remaining"
          value={remaining}
          color="var(--color-success)"
        />
        <QuotaStat
          label="Daily Limit"
          value={DAILY_LIMIT}
          color="var(--text)"
        />
      </div>

      <div className="mt-5">
        <div
          className="h-2 w-full overflow-hidden rounded-full"
          style={{ background: "var(--surface-alt)" }}
        >
          <div
            className="h-full rounded-full transition-[width] duration-500 ease-out"
            style={{
              width: `${pct}%`,
              background: "var(--accent)",
              boxShadow: `0 0 12px var(--accent)`,
            }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs">
          <span style={{ color: "var(--text-soft)" }}>
            {pct}% of daily quota used
          </span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="cursor-pointer font-semibold transition-colors hover:opacity-80"
            style={{
              color: "var(--accent)",
              background: "transparent",
              border: 0,
              padding: 0,
            }}
          >
            Breakdown {expanded ? "↑" : "↓"}
          </button>
        </div>
      </div>

      {expanded ? (
        <div
          className="mt-5 rounded-lg border p-4"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-alt)",
          }}
        >
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h4 className="text-sm font-semibold">
              Per-client submissions (last 24h)
            </h4>
            <span
              className="text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              {contributing.length} of {clients.length} contributed
            </span>
          </div>
          {contributing.length === 0 ? (
            <p
              className="text-xs"
              style={{ color: "var(--text-soft)" }}
            >
              No URL submissions in the last 24 hours. The quota will fully
              reset at midnight UTC.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {contributing.map((row) => {
                const rowPct = used > 0 ? (row.submitted / used) * 100 : 0;
                return (
                  <li
                    key={row.id}
                    className="flex items-center gap-3 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">{row.name}</span>
                    <div
                      className="h-1.5 w-24 overflow-hidden rounded-full"
                      style={{ background: "var(--surface)" }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${rowPct}%`,
                          background: "var(--accent)",
                        }}
                      />
                    </div>
                    <span
                      className="mono w-12 text-right"
                      style={{ color: "var(--text)" }}
                    >
                      {fmtInt(row.submitted)}
                    </span>
                    <span
                      className="w-16 text-right text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {fmtRelative(row.last_run_at)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function QuotaStat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
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
        className="font-display text-2xl font-semibold leading-tight"
        style={{ color }}
      >
        {fmtInt(value)}
      </div>
    </div>
  );
}

function useResetCountdown() {
  const [text, setText] = useState("--:--:--");

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const next = new Date(now);
      next.setUTCHours(24, 0, 0, 0);
      const diff = Math.max(0, next.getTime() - now.getTime());
      const hrs = Math.floor(diff / 3_600_000);
      const mins = Math.floor((diff % 3_600_000) / 60_000);
      const secs = Math.floor((diff % 60_000) / 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      setText(`${pad(hrs)}:${pad(mins)}:${pad(secs)}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return text;
}
