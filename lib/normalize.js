// URL normalization and LinkedIn URL classification helpers.

const TRACKING_PARAM_PREFIXES = ["utm_", "trk", "original", "mini", "lipi", "ref"];
const TRACKING_PARAMS = new Set([
  "originalSubdomain",
  "original_referer",
  "originalReferer",
  "trk",
  "trkInfo",
  "refId",
  "miniProfileUrn",
  "lipi",
  "licu",
  "src",
  "source",
  "fromSignIn",
  "session_redirect",
]);

function isTrackingParam(name) {
  if (TRACKING_PARAMS.has(name)) return true;
  const lower = name.toLowerCase();
  return TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Normalize a LinkedIn (or generic) URL:
 *  - force https
 *  - lower-case host
 *  - strip tracking query params (utm_*, trk, originalSubdomain, ...)
 *  - drop the query entirely if nothing meaningful remains
 *  - remove trailing slash
 * Returns the cleaned URL string, or the trimmed input if it cannot be parsed.
 */
export function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  let input = rawUrl.trim();
  if (!input) return "";
  if (!/^https?:\/\//i.test(input)) input = "https://" + input;

  let u;
  try {
    u = new URL(input);
  } catch {
    return rawUrl.trim().replace(/\/+$/, "");
  }

  u.protocol = "https:";
  u.host = u.host.toLowerCase();
  u.hash = "";

  const kept = [];
  for (const [key, value] of u.searchParams.entries()) {
    if (!isTrackingParam(key)) kept.push([key, value]);
  }
  u.search = "";
  for (const [key, value] of kept) u.searchParams.append(key, value);

  let out = u.toString();
  // Remove trailing slash (but keep it if the path is just "/").
  out = out.replace(/\/+$/, (m, offset, s) => (s.endsWith("://") ? m : ""));
  return out;
}

/**
 * Classify a LinkedIn URL.
 * Returns { type: 'individual' | 'company' | 'search' | 'unknown', slug }.
 */
export function classifyLinkedin(rawUrl) {
  const norm = normalizeUrl(rawUrl);
  let u;
  try {
    u = new URL(norm);
  } catch {
    return { type: "unknown", slug: null, url: norm };
  }
  if (!/linkedin\.com$/i.test(u.host.replace(/^www\./, ""))) {
    return { type: "unknown", slug: null, url: norm };
  }
  const path = u.pathname.replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);

  // Search-result URLs must never be saved.
  if (parts[0] === "search") return { type: "search", slug: null, url: norm };

  if (parts[0] === "in" && parts[1]) {
    return { type: "individual", slug: parts[1], url: norm };
  }
  if ((parts[0] === "company" || parts[0] === "school") && parts[1]) {
    return { type: "company", slug: parts[1], url: norm };
  }
  return { type: "unknown", slug: null, url: norm };
}

/**
 * Build the canonical "People" URL for a LinkedIn company page.
 * e.g. https://www.linkedin.com/company/4minds-colombia/  ->
 *      https://www.linkedin.com/company/4minds-colombia/people/
 */
export function companyPeopleUrl(rawUrl) {
  const { type, slug } = classifyLinkedin(rawUrl);
  if (type !== "company" || !slug) return null;
  const base = rawUrl.includes("/school/") ? "school" : "company";
  return `https://www.linkedin.com/${base}/${slug}/people/`;
}

/**
 * Canonicalize an individual profile URL to https://www.linkedin.com/in/<slug>.
 * Returns the normalized canonical URL, or null when not an individual profile.
 */
export function canonicalProfileUrl(rawUrl) {
  const { type, slug } = classifyLinkedin(rawUrl);
  if (type !== "individual" || !slug) return null;
  return `https://www.linkedin.com/in/${slug}`;
}

/**
 * Normalize an organization name for use as a stable identity key:
 * lower-case, strip diacritics, drop punctuation, collapse whitespace.
 */
export function normalizeName(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ") // punctuation/symbols -> space
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Stable identity for an organization.
 *  - Primary:  "url:" + normalized StartIA detail URL (when it carries ?slug=).
 *  - Fallback: "name:" + normalizedName + "|" + category label/key.
 * Both an enumerated org descriptor and a stored result row must map to the
 * same key, so keep this and orgIdentityFromRow() in lock-step.
 */
export function orgIdentity(org) {
  const detailUrl = org && (org.detailUrl || org.org_detail_url);
  if (detailUrl && /[?&]slug=/.test(detailUrl)) {
    try {
      const u = new URL(/^https?:\/\//i.test(detailUrl) ? detailUrl : "https://" + detailUrl);
      const slug = (u.searchParams.get("slug") || "").replace(/\/+$/, "").toLowerCase();
      const host = u.host.toLowerCase().replace(/^www\./, "");
      const path = u.pathname.replace(/\/+$/, "").toLowerCase();
      if (slug) return `url:${host}${path}?slug=${slug}`;
    } catch {
      /* fall through to name-based identity */
    }
  }
  const cat = org.categoryLabel || org.categoryKey || org.category || "";
  return "name:" + normalizeName(org.name || "") + "|" + normalizeName(cat);
}

/**
 * Identity for a stored result row. Mirrors orgIdentity() using the row's
 * persisted fields (org_detail_url, org_name, category).
 */
export function orgIdentityFromRow(row) {
  return orgIdentity({
    detailUrl: row.org_detail_url,
    name: row.org_name,
    categoryLabel: row.category,
  });
}
