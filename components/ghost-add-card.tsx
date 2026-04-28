import Link from "next/link";

export function GhostAddCard() {
  return (
    <Link href="/clients/new" className="ghost-card" aria-label="Add new client">
      <span
        aria-hidden
        className="grid h-9 w-9 place-items-center rounded-full text-lg font-bold"
        style={{
          border: "1.5px dashed currentColor",
          opacity: 0.7,
        }}
      >
        +
      </span>
      <span className="text-sm font-semibold">Add new client</span>
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
        Track another sitemap
      </span>
    </Link>
  );
}
