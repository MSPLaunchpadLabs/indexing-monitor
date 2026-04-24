import clsx from "clsx";

export function ProgressBar({
  pct,
  label,
  tone = "accent",
}: {
  pct: number;
  label?: string;
  tone?: "accent" | "success" | "danger";
}) {
  const clamped = Math.min(100, Math.max(0, pct));
  const color =
    tone === "success"
      ? "var(--color-success)"
      : tone === "danger"
        ? "var(--color-danger)"
        : "var(--accent)";
  return (
    <div className="space-y-2">
      {label ? (
        <div
          className="flex items-center justify-between text-xs"
          style={{ color: "var(--text-soft)" }}
        >
          <span>{label}</span>
          <span className="font-mono">{clamped.toFixed(0)}%</span>
        </div>
      ) : null}
      <div
        className={clsx("h-2 w-full overflow-hidden rounded-full")}
        style={{ background: "var(--surface-alt)" }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-out"
          style={{
            width: `${clamped}%`,
            background: color,
            boxShadow: `0 0 12px ${color}`,
          }}
        />
      </div>
    </div>
  );
}
