import { ThemeToggle } from "@/components/theme-toggle";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const DAILY_QUOTA = 200;
const SAFETY_BUFFER = 5;

async function getTodayQuota(): Promise<{
  usedToday: number;
  remaining: number;
  resetsAt: string;
  perClient: { client_id: string; count: number; last_submitted: string }[];
}> {
  const sb = supabase();
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const cutoff = startOfUtcDay.toISOString();

  const nextReset = new Date(startOfUtcDay);
  nextReset.setUTCDate(nextReset.getUTCDate() + 1);

  const { data } = await sb
    .from("url_status")
    .select("client_id,last_submitted")
    .gte("last_submitted", cutoff)
    .returns<{ client_id: string; last_submitted: string | null }[]>();

  const rows = (data ?? []).filter((r) => r.last_submitted);
  const usedToday = rows.length;
  const remaining = Math.max(0, DAILY_QUOTA - usedToday - SAFETY_BUFFER);

  const byClient = new Map<
    string,
    { count: number; last_submitted: string }
  >();
  for (const r of rows) {
    if (!r.last_submitted) continue;
    const cur = byClient.get(r.client_id);
    if (!cur) {
      byClient.set(r.client_id, { count: 1, last_submitted: r.last_submitted });
    } else {
      cur.count += 1;
      if (r.last_submitted > cur.last_submitted) {
        cur.last_submitted = r.last_submitted;
      }
    }
  }
  const perClient = [...byClient.entries()]
    .map(([client_id, v]) => ({ client_id, ...v }))
    .sort((a, b) => b.count - a.count);

  return { usedToday, remaining, resetsAt: nextReset.toISOString(), perClient };
}

export default async function SettingsPage() {
  const quota = await getTodayQuota();
  const pctUsed = Math.min(100, Math.round((quota.usedToday / DAILY_QUOTA) * 100));

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Settings</p>
        <h1>Workspace settings &amp; tool info</h1>
        <p className="mt-2" style={{ color: "var(--text-soft)" }}>
          What this dashboard does, how the automation rotates between
          clients, and where today&apos;s daily quota stands.
        </p>
      </header>

      <section className="surface p-5">
        <h3 className="text-base font-semibold">Appearance</h3>
        <p className="mt-1 text-xs" style={{ color: "var(--text-soft)" }}>
          Toggle dark / light theme. Stored locally on this device.
        </p>
        <div className="mt-4 max-w-xs">
          <ThemeToggle />
        </div>
      </section>

      {/* ─── Live quota strip ─────────────────────────────────────────── */}
      <section className="surface p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="text-base font-semibold">
            Today&apos;s indexing quota
          </h3>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Resets at the next UTC midnight
          </span>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <QuotaTile
            label="Used today"
            value={`${quota.usedToday}`}
            sub={`of ${DAILY_QUOTA} (${pctUsed}%)`}
            color="var(--accent)"
          />
          <QuotaTile
            label="Remaining"
            value={`${quota.remaining}`}
            sub={`after ${SAFETY_BUFFER}-URL safety buffer`}
            color="var(--color-success)"
          />
          <QuotaTile
            label="Window resets"
            value={fmtTimeUtc(quota.resetsAt)}
            sub="UTC midnight"
            color="var(--text)"
          />
        </div>

        <div
          className="mt-4 h-2 w-full overflow-hidden rounded-full"
          style={{ background: "var(--surface-alt)" }}
          role="progressbar"
          aria-valuenow={quota.usedToday}
          aria-valuemin={0}
          aria-valuemax={DAILY_QUOTA}
        >
          <div
            style={{
              width: `${pctUsed}%`,
              height: "100%",
              background: "var(--accent)",
              transition: "width 200ms",
            }}
          />
        </div>

        {quota.perClient.length > 0 ? (
          <div className="mt-4">
            <p className="caption mb-2">Per-client (today, UTC)</p>
            <ul className="space-y-1.5 text-xs">
              {quota.perClient.map((c) => (
                <li
                  key={c.client_id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-1.5"
                  style={{
                    borderColor: "var(--border)",
                    background: "var(--surface-alt)",
                  }}
                >
                  <span className="mono">{c.client_id}</span>
                  <span style={{ color: "var(--text-soft)" }}>
                    {c.count} URL{c.count === 1 ? "" : "s"} · last{" "}
                    {fmtTimeUtc(c.last_submitted)} UTC
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p
            className="mt-4 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            No URL submissions today yet — the next 6h scheduler tick will pick
            the staleest client.
          </p>
        )}
      </section>

      {/* ─── How the tool works ───────────────────────────────────────── */}
      <section className="surface space-y-4 p-5">
        <h3 className="text-base font-semibold">How this tool works</h3>

        <InfoBlock
          title="1 · URL Inspection"
          subtitle="Google Search Console URL Inspection API"
        >
          For every URL in a client&apos;s sitemap, the engine asks Google
          &ldquo;is this indexed?&rdquo; and parses the response. The{" "}
          <code className="mono">verdict</code> field becomes the{" "}
          <strong>Indexed / Not Indexed / Unknown</strong> pill on the URL
          row, and <code className="mono">coverageState</code> becomes the
          coverage note (e.g. <em>Submitted and indexed</em>,{" "}
          <em>Page with redirect</em>, <em>Crawled — currently not
          indexed</em>). Inspection is rate-limited to{" "}
          <strong>~600/min per property</strong> — pacing 100 ms between
          calls keeps us safely below.
        </InfoBlock>

        <InfoBlock
          title="2 · Indexing submission"
          subtitle="Google Indexing API · type = URL_UPDATED"
        >
          For not-indexed URLs, the engine pings Google&apos;s Indexing API
          to nudge a crawl. Daily limit:{" "}
          <strong>{DAILY_QUOTA} URL submissions per project, per day</strong>,
          shared across <em>all</em> clients on this dashboard. We hold a{" "}
          <strong>{SAFETY_BUFFER}-URL safety buffer</strong> aside for manual
          submissions via the <em>Submit URLs</em> page so the auto-scheduler
          never races a human operator into a 429.
        </InfoBlock>

        <InfoBlock
          title="3 · Auto-scheduler"
          subtitle="Vercel Cron — every 6h at 00/06/12/18 UTC"
        >
          On each tick the scheduler:
          <ol
            className="mt-2 list-decimal space-y-1 pl-5"
            style={{ color: "var(--text-soft)" }}
          >
            <li>Reads how many URLs were submitted since UTC midnight.</li>
            <li>
              Computes <code className="mono">remaining = 200 − used − 5</code>.
            </li>
            <li>
              Filters out clients with a <em>running</em> run, or whose last
              run failed within the last <strong>12h</strong> (cooldown — gives
              you time to fix onboarding without burning quota on a broken
              client every tick).
            </li>
            <li>Picks the client with the oldest finished run.</li>
            <li>
              Fair-shares the remaining quota across the clients still due
              today: <code className="mono">cap = max(20, remaining ÷
              due_today)</code>.
            </li>
            <li>
              Dispatches a GitHub Actions run with{" "}
              <code className="mono">max_submissions = cap</code>.
            </li>
          </ol>
        </InfoBlock>

        <InfoBlock
          title="4 · New pages get priority"
          subtitle="Two-pass submission inside each run"
        >
          When a sitemap changes, the engine flags fresh URLs as{" "}
          <code className="mono">is_new = true</code>. Step 4 of the run then
          submits in two passes: <strong>Pass 1</strong> sends the freshly
          added URLs first (so a new blog post doesn&apos;t get stuck behind
          a 200-item backlog), and <strong>Pass 2</strong> fills any
          remaining cap with the existing not-indexed URLs in sitemap order.
          If quota runs out mid-run, the leftover URLs get a{" "}
          <em>&ldquo;deferred: daily quota&rdquo;</em> note and roll into the
          next tick.
        </InfoBlock>

        <InfoBlock
          title="5 · Per-URL row actions"
          subtitle="Click the icons next to any URL"
        >
          <ul
            className="mt-2 space-y-1.5 text-sm"
            style={{ color: "var(--text-soft)" }}
          >
            <li>
              <span aria-hidden>🔍</span>{" "}
              <strong style={{ color: "var(--text)" }}>View on Google</strong>
              {" "}— opens a <code className="mono">site:&lt;url&gt;</code>{" "}
              search in a new tab so you can see exactly what Google is
              showing for that page.
            </li>
            <li>
              <span aria-hidden>↑</span>{" "}
              <strong style={{ color: "var(--text)" }}>Re-submit</strong> —
              fires the Indexing API for that single URL and updates the row
              with the result. <em>Costs 1 of the daily 200 quota.</em>
            </li>
            <li>
              <span aria-hidden>🔄</span>{" "}
              <strong style={{ color: "var(--text)" }}>Re-inspect</strong> —
              calls URL Inspection right now and refreshes the
              Indexed/Coverage cells without waiting for the next full run.{" "}
              <em>Free — separate quota from indexing.</em>
            </li>
          </ul>
        </InfoBlock>

        <InfoBlock
          title="6 · Self-healing"
          subtitle="Sweep cron — every 15 min"
        >
          A second cron auto-fails any run still in <em>running</em> after{" "}
          <strong>65 minutes</strong> (60 min GHA timeout + 5 min grace), so
          a crashed runner can&apos;t leave a phantom &ldquo;in
          progress&rdquo; banner blocking the next dispatch.
        </InfoBlock>
      </section>

      <section className="surface p-5">
        <h3 className="text-base font-semibold">Runtime</h3>
        <ul
          className="mt-3 space-y-2 text-sm"
          style={{ color: "var(--text-soft)" }}
        >
          <li>
            <strong style={{ color: "var(--text)" }}>Runner:</strong> GitHub
            Actions (<code className="mono">workflow_dispatch</code> on{" "}
            <code className="mono">indexing-monitor.yml</code>, 60-min
            timeout per run).
          </li>
          <li>
            <strong style={{ color: "var(--text)" }}>Database:</strong>{" "}
            Supabase — clients, runs, per-URL state, run snapshots.
          </li>
          <li>
            <strong style={{ color: "var(--text)" }}>Auth:</strong> Google
            service account (JWT bearer flow), Supabase service-role key,
            GitHub fine-grained PAT — all server-side env vars only.
          </li>
          <li>
            <strong style={{ color: "var(--text)" }}>Daily quota:</strong>{" "}
            {DAILY_QUOTA} URL submissions per day (Google Indexing API),
            with a {SAFETY_BUFFER}-URL buffer reserved for manual use.
          </li>
        </ul>
      </section>
    </div>
  );
}

function QuotaTile({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div
      className="rounded-lg border p-3"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface-alt)",
      }}
    >
      <div className="caption">{label}</div>
      <div
        className="font-display text-2xl font-semibold leading-tight"
        style={{ color }}
      >
        {value}
      </div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>
        {sub}
      </div>
    </div>
  );
}

function InfoBlock({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface-alt)",
      }}
    >
      <div className="mb-2">
        <div className="text-sm font-semibold" style={{ color: "var(--text)" }}>
          {title}
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          {subtitle}
        </div>
      </div>
      <div className="text-sm leading-relaxed" style={{ color: "var(--text-soft)" }}>
        {children}
      </div>
    </div>
  );
}

function fmtTimeUtc(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  } catch {
    return "—";
  }
}
