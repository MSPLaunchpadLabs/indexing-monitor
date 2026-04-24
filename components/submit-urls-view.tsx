"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import type { ClientRow } from "@/lib/supabase";

type RoutedUrl = {
  url: string;
  client_id: string | null;
  reason: string;
};

type SubmissionOutcome = {
  url: string;
  client_id: string;
  ok: boolean;
  message: string;
};

type Stage = "idle" | "routed" | "submitting" | "done";

const PLACEHOLDER =
  "https://www.msplaunchpad.com/blog/new-post\nhttps://www.techlocity.com/locations/dallas\nhttps://www.ajtc.net/blog/security-update";

export function SubmitUrlsView({ clients }: { clients: ClientRow[] }) {
  const [input, setInput] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [routed, setRouted] = useState<RoutedUrl[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [results, setResults] = useState<SubmissionOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function analyze() {
    setError(null);
    setResults(null);
    setOverrides({});
    setBusy(true);
    try {
      const urls = input
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (urls.length === 0) {
        setError("Paste at least one URL.");
        return;
      }
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "route", urls }),
      });
      const data = (await res.json()) as { routed?: RoutedUrl[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setRouted(data.routed ?? []);
      setStage("routed");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function clearAll() {
    setInput("");
    setRouted([]);
    setOverrides({});
    setResults(null);
    setStage("idle");
    setError(null);
  }

  // Effective routing after manual overrides are applied.
  const effective = useMemo(() => {
    return routed.map((r) => ({
      ...r,
      client_id: overrides[r.url] ?? r.client_id,
    }));
  }, [routed, overrides]);

  const grouped = useMemo(() => {
    const g: Record<string, string[]> = {};
    for (const r of effective) {
      if (!r.client_id) continue;
      if (r.reason === "Not a valid URL") continue;
      g[r.client_id] ??= [];
      g[r.client_id].push(r.url);
    }
    return g;
  }, [effective]);

  const matchedCount = useMemo(
    () => Object.values(grouped).reduce((n, arr) => n + arr.length, 0),
    [grouped],
  );
  const invalidCount = routed.filter((r) => r.reason === "Not a valid URL").length;
  const unknowns = effective.filter(
    (r) => !r.client_id && r.reason !== "Not a valid URL",
  );

  const clientById = useMemo(
    () => new Map(clients.map((c) => [c.id, c])),
    [clients],
  );

  async function dispatch() {
    if (matchedCount === 0) return;
    setError(null);
    setBusy(true);
    setStage("submitting");
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dispatch", urls_by_client: grouped }),
      });
      const data = (await res.json()) as {
        results?: SubmissionOutcome[];
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        setStage("routed");
        return;
      }
      setResults(data.results ?? []);
      setStage("done");
    } catch (e) {
      setError((e as Error).message);
      setStage("routed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <Link href="/" className="btn btn-ghost inline-flex w-fit">
        ← All clients
      </Link>

      <header>
        <p className="eyebrow">Manual submissions</p>
        <h1>Submit URLs for indexing</h1>
        <p className="mt-2" style={{ color: "var(--text-soft)" }}>
          Paste newly-published pages from any client. We&apos;ll auto-route
          each URL to its Search Console property and submit it to
          Google&apos;s Indexing API.
        </p>
      </header>

      {clients.length === 0 ? (
        <div className="surface p-5 text-sm" style={{ color: "var(--text-soft)" }}>
          Add a client first — the Submit URLs flow needs at least one Search
          Console property.
        </div>
      ) : null}

      {/* STAGE 1 — Paste */}
      <section className="surface space-y-3 p-5">
        <h3>1. Paste URLs</h3>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          One URL per line. Mix and match clients — we&apos;ll sort them.
        </p>
        <textarea
          className="input w-full"
          style={{ minHeight: 180, fontFamily: "var(--font-mono, monospace)" }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={PLACEHOLDER}
          disabled={busy && stage !== "submitting"}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={analyze}
            disabled={busy || !input.trim() || clients.length === 0}
          >
            {busy && stage === "idle" ? "Analyzing…" : "Analyze URLs"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={clearAll}
            disabled={busy}
          >
            Clear
          </button>
        </div>
      </section>

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

      {/* STAGE 2 — Review routing */}
      {stage !== "idle" ? (
        <section className="surface space-y-4 p-5">
          <h3>2. Review routing</h3>

          <div className="grid gap-3 sm:grid-cols-3">
            <Tile label="Ready to submit" value={matchedCount} tone="success" />
            <Tile
              label="Unknown domain"
              value={unknowns.length}
              tone={unknowns.length > 0 ? "warning" : "default"}
            />
            <Tile
              label="Invalid URLs"
              value={invalidCount}
              tone={invalidCount > 0 ? "danger" : "default"}
            />
          </div>

          {Object.entries(grouped).map(([cid, urls]) => {
            const client = clientById.get(cid);
            return (
              <div
                key={cid}
                className="rounded-lg border p-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--surface-alt)",
                }}
              >
                <div className="mb-2 flex items-center justify-between">
                  <strong>{client?.name ?? cid}</strong>
                  <span className="pill pill-neutral">{urls.length} URL(s)</span>
                </div>
                {client ? (
                  <p
                    className="mono mb-2 truncate text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {client.gsc_site_url}
                  </p>
                ) : null}
                <ul className="space-y-1 text-xs">
                  {urls.map((u) => (
                    <li key={u} className="mono truncate">
                      {u}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}

          {unknowns.length > 0 ? (
            <div
              className="rounded-lg border p-3"
              style={{
                borderColor: "var(--color-warning-border, var(--border))",
                background: "var(--surface-alt)",
              }}
            >
              <strong className="mb-1 block">
                Unknown domain — {unknowns.length} URL(s)
              </strong>
              <p
                className="mb-3 text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                Pick a client manually, or leave as &quot;skip&quot; to drop
                the URL.
              </p>
              <ul className="space-y-2">
                {unknowns.map((r) => (
                  <li
                    key={r.url}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <code
                      className="mono flex-1 min-w-0 truncate text-[12px]"
                      style={{ color: "var(--text)" }}
                    >
                      {r.url}
                    </code>
                    <select
                      className="input"
                      value={overrides[r.url] ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        setOverrides((prev) => {
                          const next = { ...prev };
                          if (v === "") delete next[r.url];
                          else next[r.url] = v;
                          return next;
                        });
                      }}
                    >
                      <option value="">(skip)</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {invalidCount > 0 ? (
            <ul
              className="space-y-1 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              {routed
                .filter((r) => r.reason === "Not a valid URL")
                .map((r) => (
                  <li key={r.url}>
                    <span style={{ color: "var(--color-danger)" }}>✗</span>{" "}
                    <code className="mono">{r.url}</code> — invalid, will be
                    skipped
                  </li>
                ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {/* STAGE 3 — Submit */}
      {stage === "routed" || stage === "submitting" || stage === "done" ? (
        <section className="surface space-y-3 p-5">
          <h3>3. Submit</h3>
          {matchedCount === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-soft)" }}>
              Nothing ready to submit. Assign unknowns above or paste new URLs.
            </p>
          ) : (
            <>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Each URL is sent to Google&apos;s Indexing API as
                <code className="mono"> URL_UPDATED</code>. Default quota is
                200 per day per project.
              </p>
              <button
                type="button"
                className="btn btn-primary w-full"
                onClick={dispatch}
                disabled={busy}
              >
                {stage === "submitting"
                  ? `Submitting ${matchedCount} URL(s)…`
                  : `Submit ${matchedCount} URL(s) to Google`}
              </button>
            </>
          )}
        </section>
      ) : null}

      {/* STAGE 4 — Results */}
      {stage === "done" && results ? (
        <ResultsPanel
          results={results}
          clients={clients}
          onReset={clearAll}
        />
      ) : null}
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "danger" | "default";
}) {
  const color =
    tone === "success"
      ? "var(--color-success)"
      : tone === "warning"
        ? "var(--color-warning)"
        : tone === "danger"
          ? "var(--color-danger)"
          : "var(--text)";
  return (
    <div
      className="rounded-lg border p-3"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface-alt)",
      }}
    >
      <div
        className="text-[11px] font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </div>
      <div
        className="font-display text-2xl font-semibold"
        style={{ color }}
      >
        {value}
      </div>
    </div>
  );
}

function ResultsPanel({
  results,
  clients,
  onReset,
}: {
  results: SubmissionOutcome[];
  clients: ClientRow[];
  onReset: () => void;
}) {
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;

  const byClient = new Map<string, SubmissionOutcome[]>();
  for (const r of results) {
    const arr = byClient.get(r.client_id) ?? [];
    arr.push(r);
    byClient.set(r.client_id, arr);
  }

  const clientById = new Map(clients.map((c) => [c.id, c]));

  return (
    <section className="surface space-y-4 p-5">
      <h3>4. Results</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Tile
          label="Submitted successfully"
          value={ok}
          tone={ok > 0 ? "success" : "default"}
        />
        <Tile
          label="Failed"
          value={fail}
          tone={fail > 0 ? "danger" : "default"}
        />
      </div>

      {[...byClient.entries()].map(([cid, rs]) => {
        const c = clientById.get(cid);
        const clientOk = rs.filter((r) => r.ok).length;
        return (
          <details
            key={cid}
            className={clsx("rounded-lg border p-3")}
            open={clientOk !== rs.length}
            style={{
              borderColor: "var(--border)",
              background: "var(--surface-alt)",
            }}
          >
            <summary className="cursor-pointer text-sm font-semibold">
              {c?.name ?? cid} — {clientOk}/{rs.length} succeeded
            </summary>
            <ul className="mt-2 space-y-1 text-xs">
              {rs.map((r, i) => (
                <li key={`${r.url}-${i}`}>
                  <span
                    style={{
                      color: r.ok
                        ? "var(--color-success)"
                        : "var(--color-danger)",
                    }}
                  >
                    {r.ok ? "✓" : "✗"}
                  </span>{" "}
                  <code className="mono">{r.url}</code> — {r.message}
                </li>
              ))}
            </ul>
          </details>
        );
      })}

      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
        Successful submissions are stored in each client&apos;s{" "}
        <code className="mono">url_status</code> table with source=&quot;manual&quot;.
      </p>

      <button type="button" className="btn btn-ghost" onClick={onReset}>
        Submit another batch
      </button>
    </section>
  );
}
