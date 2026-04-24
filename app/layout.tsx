import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Indexing Monitor · MSP Launchpad",
  description:
    "Internal SEO dashboard — track each client site's Google indexing, run fresh checks, review history.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=Lexend:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <script
          // Apply the persisted theme before first paint so dark/light doesn't flash.
          dangerouslySetInnerHTML={{
            __html: `(() => { try { const t = localStorage.getItem('im-theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch {} })();`,
          }}
        />
      </head>
      <body>
        <div className="grid min-h-screen grid-cols-[260px_1fr]">
          <aside
            className="sticky top-0 flex h-screen min-h-screen flex-col gap-5 border-r p-6"
            style={{
              background: "var(--surface)",
              borderColor: "var(--border)",
            }}
          >
            <Link href="/" className="flex items-center gap-3 no-underline">
              <span
                aria-hidden
                className="grid h-11 w-11 place-items-center rounded-xl text-lg font-bold"
                style={{
                  background:
                    "linear-gradient(135deg, var(--brand-400, #ff8f4f) 0%, var(--brand-300, #ffa572) 100%)",
                  color: "#1a0f08",
                  boxShadow:
                    "0 1px 10px rgba(255,143,79,0.30), 0 0 22px rgba(255,143,79,0.12)",
                }}
              >
                IM
              </span>
              <div>
                <h3 className="font-display text-base leading-tight">
                  Indexing Monitor
                </h3>
                <span className="caption">Internal SEO tool · v2</span>
              </div>
            </Link>

            <nav className="flex flex-col gap-1.5">
              <Link
                href="/"
                className="rounded-lg border px-3 py-2 text-sm font-semibold no-underline transition hover:[background:var(--surface-hover)]"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--text)",
                }}
              >
                All clients
              </Link>
              <Link
                href="/clients/new"
                className="rounded-lg border px-3 py-2 text-sm font-semibold no-underline transition hover:[background:var(--surface-hover)]"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--text)",
                }}
              >
                Add client
              </Link>
              <Link
                href="/submit"
                className="rounded-lg border px-3 py-2 text-sm font-semibold no-underline transition hover:[background:var(--surface-hover)]"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--text)",
                }}
              >
                Submit URLs
              </Link>
            </nav>

            <p
              className="mt-2 rounded-lg border p-3 text-xs leading-relaxed"
              style={{
                borderColor: "var(--border)",
                background: "var(--surface-alt)",
                color: "var(--text-soft)",
              }}
            >
              Each client has its own sitemap, Search Console property, and run
              history. Runs are kicked off here but executed by GitHub Actions.
            </p>

            <div className="mt-auto">
              <h4 className="caption mb-2">Appearance</h4>
              <ThemeToggle />
            </div>
          </aside>

          <main className="flex min-w-0 flex-col">
            <div className="mx-auto w-full max-w-[1180px] flex-1 px-8 py-10">
              {children}
            </div>
            <footer
              className="border-t px-8 py-6 text-center text-xs"
              style={{
                borderColor: "var(--border)",
                color: "var(--text-muted)",
              }}
            >
              <strong style={{ color: "var(--text-soft)" }}>
                MSP LAUNCHPAD
              </strong>
              &nbsp;™ · Indexing Monitor · Internal SEO tooling
            </footer>
          </main>
        </div>
      </body>
    </html>
  );
}
