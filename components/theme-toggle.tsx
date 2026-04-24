"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";

type Theme = "dark" | "light";

/**
 * Tiny two-button toggle. The initial theme is applied by the inline script in
 * `app/layout.tsx` so we don't flash — this component just mirrors that state
 * after hydration.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") setTheme(attr);
  }, []);

  function apply(next: Theme) {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("im-theme", next);
    } catch {
      // localStorage disabled — in-memory only is fine.
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex w-full overflow-hidden rounded-lg border text-xs font-semibold"
      style={{ borderColor: "var(--border)", background: "var(--surface-alt)" }}
    >
      {(["dark", "light"] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          onClick={() => apply(t)}
          className={clsx(
            "flex-1 px-3 py-1.5 transition",
            theme === t ? "" : "hover:opacity-80",
          )}
          style={{
            background:
              theme === t ? "var(--accent)" : "transparent",
            color:
              theme === t ? "#1a0f08" : "var(--text-soft)",
          }}
        >
          {t === "dark" ? "Dark" : "Light"}
        </button>
      ))}
    </div>
  );
}
