"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Fields = {
  name: string;
  website: string;
  sitemap_url: string;
  gsc_site_url: string;
};

export function AddClientForm() {
  const router = useRouter();
  const [fields, setFields] = useState<Fields>({
    name: "",
    website: "",
    sitemap_url: "",
    gsc_site_url: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof Fields>(key: K, value: Fields[K]) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const data = (await res.json()) as { client?: { id: string }; error?: string };
      if (!res.ok || !data.client) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push(`/clients/${data.client.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="surface flex flex-col gap-4 p-6"
      style={{ background: "var(--surface)" }}
    >
      <LabeledInput
        label="Client name"
        required
        value={fields.name}
        onChange={(v) => update("name", v)}
        placeholder="e.g. Acme Corp"
      />
      <LabeledInput
        label="Website"
        required
        value={fields.website}
        onChange={(v) => update("website", v)}
        placeholder="https://www.example.com/"
      />
      <LabeledInput
        label="Sitemap URL"
        value={fields.sitemap_url}
        onChange={(v) => update("sitemap_url", v)}
        placeholder="https://www.example.com/sitemap.xml"
        help="Leave blank to auto-fill as <website>/sitemap.xml"
      />
      <LabeledInput
        label="Search Console property"
        value={fields.gsc_site_url}
        onChange={(v) => update("gsc_site_url", v)}
        placeholder="https://www.example.com/  or  sc-domain:example.com"
        help="Must match exactly what Search Console has on file."
      />

      {error ? (
        <div
          className="rounded-lg border p-3 text-sm"
          style={{
            borderColor: "rgba(251,113,133,0.3)",
            background: "rgba(251,113,133,0.08)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      ) : null}

      <button
        type="submit"
        className="btn btn-primary self-start"
        disabled={submitting}
      >
        {submitting ? "Saving…" : "Save client"}
      </button>
    </form>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  required,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  help?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span
        className="text-xs font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-soft)" }}
      >
        {label}
        {required ? (
          <span style={{ color: "var(--color-danger)" }}> *</span>
        ) : null}
      </span>
      <input
        className="input"
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {help ? (
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {help}
        </span>
      ) : null}
    </label>
  );
}
