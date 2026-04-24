import Link from "next/link";
import { fmtInt, fmtRelative } from "@/lib/format";
import { ProgressBar } from "@/components/progress-bar";
import type { ClientListItem } from "@/lib/supabase";

export function ClientCard({ client }: { client: ClientListItem }) {
  const { stats, current_run } = client;
  const indexedPct =
    stats && stats.total > 0
      ? Math.round((stats.indexed / stats.total) * 100)
      : null;

  return (
    <Link
      href={`/clients/${client.id}`}
      className="surface surface-hover group flex flex-col gap-4 p-5 no-underline"
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
        {current_run ? (
          <span className="pill pill-accent">
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
              style={{ background: "var(--accent)" }}
            />
            Running
          </span>
        ) : stats ? (
          <span className="pill pill-neutral">
            {fmtRelative(client.last_run_at)}
          </span>
        ) : (
          <span className="pill pill-warning">No runs yet</span>
        )}
      </div>

      {stats ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat
              label="URLs"
              value={fmtInt(stats.total)}
              color="var(--text)"
            />
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
          </div>
          {indexedPct !== null ? (
            <ProgressBar
              pct={indexedPct}
              label="Indexed coverage"
              tone={indexedPct >= 90 ? "success" : "accent"}
            />
          ) : null}
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
            <span className="font-semibold">Inspecting URLs</span>
            <span className="mono">
              {fmtInt(current_run.current)} / {fmtInt(current_run.total)}
            </span>
          </div>
          <ProgressBar pct={current_run.pct} />
        </div>
      ) : null}
    </Link>
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
