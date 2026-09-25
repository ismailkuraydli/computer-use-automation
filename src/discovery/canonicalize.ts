/**
 * Canonical URL patterns for checkpoints: the route shape, not the record.
 *
 * - param values stay as-is (the recorder turns them into {{param}} later);
 * - other ID-like path segments become `:id` (one path segment);
 * - query keys stay, other query values become `*`.
 *
 * /member/12345 → /member/:id, so a checkpoint recorded on one member holds
 * for every member, and a tenant overlay can rewrite routes by shape.
 */

const ID_SEGMENT = [
  /^\d{3,}$/, // numeric IDs
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUIDs
  /^(?=.*\d)[0-9a-f]{12,}$/i, // long hex IDs (must contain a digit, so words stay)
];

const norm = (s: string) => s.trim().toLowerCase();

export function canonicalUrlPattern(url: string, paramValues: string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const isParam = (v: string) => paramValues.some((p) => norm(p) === norm(v));

  const path = parsed.pathname
    .split("/")
    .map((segment) => {
      const decoded = decodeURIComponent(segment);
      if (!decoded || isParam(decoded)) return segment;
      return ID_SEGMENT.some((re) => re.test(decoded)) ? ":id" : segment;
    })
    .join("/");

  const query = Array.from(parsed.searchParams.entries())
    .map(([k, v]) => `${k}=${isParam(v) ? v : "*"}`)
    .join("&");

  return query ? `${path}?${query}` : path;
}
