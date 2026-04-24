const SLUG_RE = /[^a-z0-9]+/g;

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(SLUG_RE, "-").replace(/^-+|-+$/g, "");
  return slug || "client";
}

export function normalizeWebsite(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function domainOf(website: string): string {
  try {
    return new URL(website).host || website;
  } catch {
    return website;
  }
}
