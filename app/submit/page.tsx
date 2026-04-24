import { supabase, type ClientRow } from "@/lib/supabase";
import { SubmitUrlsView } from "@/components/submit-urls-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function SubmitPage() {
  const sb = supabase();
  const { data, error } = await sb
    .from("clients")
    .select("*")
    .order("name", { ascending: true });
  if (error) {
    return (
      <div className="surface p-5 text-sm" style={{ color: "var(--color-danger)" }}>
        Failed to load clients: {error.message}
      </div>
    );
  }
  return <SubmitUrlsView clients={(data ?? []) as ClientRow[]} />;
}
