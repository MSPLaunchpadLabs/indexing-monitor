"use client";

import { useEffect, useState } from "react";

/**
 * Inline mono chip that copies its `value` to the clipboard on click. Used in
 * the "Add new client" Heads-up banner so service-account emails can be
 * pasted straight into Google Search Console without a manual highlight.
 */
export function CopyChip({
  value,
  label,
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Older browsers / insecure contexts: fall back to a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
      } catch {
        /* swallow — user can still highlight manually */
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label ? `Copy ${label}` : "Copy"}
      className="mono inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 align-middle text-xs transition-colors"
      style={{
        borderColor: copied
          ? "rgba(74,222,128,0.4)"
          : "rgba(255,255,255,0.12)",
        background: copied
          ? "rgba(74,222,128,0.10)"
          : "rgba(255,255,255,0.04)",
        color: copied ? "var(--color-success)" : "var(--text)",
      }}
    >
      <span className="truncate">{value}</span>
      <span aria-hidden className="shrink-0 text-[11px] opacity-80">
        {copied ? "✓ Copied" : "⧉ Copy"}
      </span>
    </button>
  );
}
