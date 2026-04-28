import { AddClientForm } from "@/components/add-client-form";
import { CopyChip } from "@/components/copy-chip";
import Link from "next/link";

// Service-account email from the existing dashboard — kept in sync so the
// alert correctly tells users what to authorise in Search Console.
const SERVICE_ACCOUNT_EMAIL =
  "indexing-monitor-bot@indexing-monitor-494117.iam.gserviceaccount.com";

export default function AddClientPage() {
  return (
    <div className="space-y-6">
      <Link href="/" className="btn btn-ghost inline-flex w-fit">
        ← All clients
      </Link>
      <header>
        <h1>Add a new client</h1>
        <p className="mt-1" style={{ color: "var(--text-soft)" }}>
          Add a client site to start tracking its Google indexing status.
        </p>
      </header>
      <div
        className="rounded-lg border p-4 text-sm"
        style={{
          borderColor: "var(--accent-border)",
          background: "var(--accent-soft)",
        }}
      >
        <strong>Heads up:</strong> before running a check on this client, their
        Search Console property must already exist, and the service-account bot{" "}
        <CopyChip value={SERVICE_ACCOUNT_EMAIL} label="service account email" />{" "}
        must be added as an <strong>Owner</strong> in that property&apos;s
        Users &amp; permissions.
      </div>
      <AddClientForm />
    </div>
  );
}
