import { fmtInt } from "@/lib/format";

type Item = {
  label: string;
  value: number;
  hint?: string;
  tone?: "default" | "accent" | "success" | "warning";
};

export function StatsStrip({ items }: { items: Item[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {items.map((item) => {
        const accentColor =
          item.tone === "accent"
            ? "var(--accent)"
            : item.tone === "success"
              ? "var(--color-success)"
              : item.tone === "warning"
                ? "var(--color-warning)"
                : "var(--text)";
        return (
          <div
            key={item.label}
            className="surface flex flex-col gap-1 p-4"
            style={{ background: "var(--surface)" }}
          >
            <span className="caption">{item.label}</span>
            <span
              className="font-display text-2xl font-semibold leading-tight"
              style={{ color: accentColor }}
            >
              {fmtInt(item.value)}
            </span>
            {item.hint ? (
              <span
                className="text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                {item.hint}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
