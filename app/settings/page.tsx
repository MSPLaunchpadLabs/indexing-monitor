import { ThemeToggle } from "@/components/theme-toggle";

export const dynamic = "force-static";

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow">Settings</p>
        <h1>Workspace settings</h1>
        <p className="mt-2" style={{ color: "var(--text-soft)" }}>
          Workspace preferences for the Indexing Monitor dashboard. Backend
          credentials (Google service account, Supabase, GitHub Actions
          dispatch token) are configured via environment variables.
        </p>
      </header>

      <section
        className="surface p-5"
        style={{ background: "var(--surface)" }}
      >
        <h3 className="text-base font-semibold">Appearance</h3>
        <p
          className="mt-1 text-xs"
          style={{ color: "var(--text-soft)" }}
        >
          Toggle dark / light theme. Stored locally on this device.
        </p>
        <div className="mt-4 max-w-xs">
          <ThemeToggle />
        </div>
      </section>

      <section
        className="surface p-5"
        style={{ background: "var(--surface)" }}
      >
        <h3 className="text-base font-semibold">Runtime</h3>
        <ul
          className="mt-3 space-y-2 text-sm"
          style={{ color: "var(--text-soft)" }}
        >
          <li>
            <strong style={{ color: "var(--text)" }}>Runner:</strong> GitHub
            Actions (workflow_dispatch on{" "}
            <code className="mono">indexing-monitor.yml</code>).
          </li>
          <li>
            <strong style={{ color: "var(--text)" }}>Database:</strong>{" "}
            Supabase — clients + runs + per-URL state.
          </li>
          <li>
            <strong style={{ color: "var(--text)" }}>Daily quota:</strong>{" "}
            200 URL submissions per day (Google Indexing API).
          </li>
        </ul>
      </section>
    </div>
  );
}
