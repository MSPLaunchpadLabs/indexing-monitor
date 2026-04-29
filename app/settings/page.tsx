import { ThemeToggle } from "@/components/theme-toggle";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const DAILY_QUOTA = 200;
const SAFETY_BUFFER = 5;

async function getTodayQuota() {
  const sb = supabase();
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);

  const nextReset = new Date(startOfUtcDay);
  nextReset.setUTCDate(nextReset.getUTCDate() + 1);

  const { data } = await sb
    .from("url_status")
    .select("client_id,last_submitted")
    .gte("last_submitted", startOfUtcDay.toISOString())
    .returns<{ client_id: string; last_submitted: string | null }[]>();

  const used = (data ?? []).filter((r) => r.last_submitted).length;
  return {
    used,
    remaining: Math.max(0, DAILY_QUOTA - used - SAFETY_BUFFER),
    resetsAt: nextReset.toISOString(),
  };
}

export default async function SettingsPage() {
  const quota = await getTodayQuota();
  const pct = Math.min(100, Math.round((quota.used / DAILY_QUOTA) * 100));

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Settings</p>
        <h1>Settings &amp; how it works</h1>
      </header>

      {/* ─── Theme ─────────────────────────────────────── */}
      <section className="surface p-5">
        <h3 className="text-base font-semibold">Appearance</h3>
        <p className="mt-1 text-xs" style={{ color: "var(--text-soft)" }}>
          Light or dark mode.
        </p>
        <div className="mt-4 max-w-xs">
          <ThemeToggle />
        </div>
      </section>

      {/* ─── Today's quota ─────────────────────────────── */}
      <section className="surface p-5">
        <h3 className="text-base font-semibold">Today&apos;s Google quota</h3>
        <p className="mt-1 text-xs" style={{ color: "var(--text-soft)" }}>
          Google lets us push <strong>{DAILY_QUOTA}</strong> pages per day,
          shared across all clients. Resets at midnight UTC.
        </p>

        <div className="mt-4 flex items-baseline gap-3">
          <span
            className="font-display text-3xl font-semibold"
            style={{ color: "var(--accent)" }}
          >
            {quota.used}
          </span>
          <span style={{ color: "var(--text-soft)" }}>used</span>
          <span style={{ color: "var(--text-muted)" }}>·</span>
          <span
            className="font-display text-3xl font-semibold"
            style={{ color: "var(--color-success)" }}
          >
            {quota.remaining}
          </span>
          <span style={{ color: "var(--text-soft)" }}>left today</span>
        </div>

        <div
          className="mt-3 h-2 w-full overflow-hidden rounded-full"
          style={{ background: "var(--surface-alt)" }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background: "var(--accent)",
            }}
          />
        </div>
      </section>

      {/* ─── How it works (plain English) ──────────────── */}
      <section className="surface space-y-4 p-5">
        <h3 className="text-base font-semibold">How this tool works</h3>

        <Block title="What it does">
          Keeps your client websites visible on Google. It looks at every
          page, sees which ones Google has &amp; which it&apos;s missing,
          and asks Google to add the missing ones.
        </Block>

        <Block title="How often">
          It runs by itself <strong>every hour</strong> — picking the client
          that hasn&apos;t been checked the longest. With ~25 minutes per
          run, every client gets visited <strong>multiple times a day</strong>,
          so new pages and any not-indexed backlog get pushed to Google fast.
        </Block>

        <Block title="The daily limit">
          Google caps us at <strong>{DAILY_QUOTA} pages a day</strong>{" "}
          (across <em>all</em> clients combined). The tool splits that
          fairly across clients and keeps dispatching every hour until the
          200 is used up — that way none of the daily allowance is wasted.
        </Block>

        <Block title="New pages first">
          When you publish a new page, the next run notices it and pushes
          it to Google <em>before</em> any older pages — so fresh content
          gets seen fast.
        </Block>

        <Block title="The 3 buttons next to each URL">
          <ul
            className="mt-2 space-y-1.5"
            style={{ color: "var(--text-soft)" }}
          >
            <li>
              <span aria-hidden>🔍</span>{" "}
              <strong style={{ color: "var(--text)" }}>Search Google</strong>{" "}
              — see if the page actually shows up.
            </li>
            <li>
              <span aria-hidden>↑</span>{" "}
              <strong style={{ color: "var(--text)" }}>Push to Google</strong>{" "}
              — ask Google to crawl this page now (uses 1 of the daily
              200).
            </li>
            <li>
              <span aria-hidden>🔄</span>{" "}
              <strong style={{ color: "var(--text)" }}>Refresh status</strong>{" "}
              — re-check whether Google has indexed it (free, instant).
            </li>
          </ul>
        </Block>

        <Block title="If something breaks">
          If a client&apos;s run fails (usually because the bot isn&apos;t
          added as Owner in Google Search Console), the tool waits{" "}
          <strong>12 hours</strong> before trying again — so we don&apos;t
          waste quota on broken setups.
        </Block>
      </section>
    </div>
  );
}

function Block({
  title,
  children,
}: {
  title: string;
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
      <div
        className="mb-1.5 text-sm font-semibold"
        style={{ color: "var(--text)" }}
      >
        {title}
      </div>
      <div
        className="text-sm leading-relaxed"
        style={{ color: "var(--text-soft)" }}
      >
        {children}
      </div>
    </div>
  );
}
