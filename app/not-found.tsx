import Link from "next/link";

export default function NotFound() {
  return (
    <div className="space-y-4 text-center">
      <p className="eyebrow">404</p>
      <h1>Page not found</h1>
      <p style={{ color: "var(--text-soft)" }}>
        The page you were looking for isn&apos;t here.
      </p>
      <Link href="/" className="btn btn-primary inline-flex">
        Back to clients
      </Link>
    </div>
  );
}
