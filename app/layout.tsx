import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarNav } from "@/components/sidebar-nav";
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
            className="sticky top-0 flex h-screen min-h-screen flex-col gap-5 border-r p-5"
            style={{
              background: "var(--sidebar)",
              borderColor: "var(--border)",
            }}
          >
            <Link
              href="/"
              aria-label="MSP Launchpad"
              className="block no-underline rounded-md px-3 py-2.5 text-center"
              style={{
                background: "#000",
                color: "#fff",
                fontFamily: "var(--font-display)",
                fontWeight: 800,
                fontSize: 15,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              MSP LAUNCHPAD<sup style={{ fontSize: 9, marginLeft: 2 }}>™</sup>
            </Link>

            <Link href="/" className="flex items-center gap-3 no-underline">
              <span
                aria-hidden
                className="grid h-10 w-10 place-items-center rounded-md text-base font-bold"
                style={{
                  background: "#f97316",
                  color: "#1a0f08",
                }}
              >
                IM
              </span>
              <div>
                <h3 className="font-display text-base leading-tight">
                  Indexing Monitor
                </h3>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontWeight: 500,
                  }}
                >
                  Internal SEO Tool · V2
                </span>
              </div>
            </Link>

            <SidebarNav />

            <div className="mt-auto flex flex-col gap-2.5">
              <p
                className="rounded-lg p-3 text-xs leading-relaxed"
                style={{
                  border: "0.5px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--text-soft)",
                }}
              >
                Each client has its own sitemap, Search Console property, and
                run history. Runs are kicked off here but executed by GitHub
                Actions.
              </p>
              <div>
                <h4 className="caption mb-2">Appearance</h4>
                <ThemeToggle />
              </div>
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
