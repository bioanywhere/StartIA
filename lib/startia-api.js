// StartIA ecosystem API client.
//
// The public ecosystem directory is backed by a JSON API:
//   POST https://startia.com.co/back/api/organizations/<endpoint>
//   body: { limit, offset }  ->  { items: [...], total: <number> }
//
// Each organization item already contains its social links (including the
// LinkedIn URL) in `links[]`, so we never need to open a StartIA detail page.
// Paging through this API is exactly equivalent to walking every pagination
// page of every tab, but far more reliable than scraping async HTML.

import { STARTIA_ORIGIN, API_PAGE_SIZE, CATEGORIES } from "./config.js";

async function fetchPage(endpoint, offset, limit) {
  const res = await fetch(STARTIA_ORIGIN + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ limit, offset }),
  });
  if (!res.ok) {
    throw new Error(`StartIA API ${endpoint} returned HTTP ${res.status}`);
  }
  const data = await res.json();
  return {
    items: Array.isArray(data.items) ? data.items : [],
    total: typeof data.total === "number" ? data.total : null,
  };
}

// Get the reported total number of organizations for a category.
export async function fetchCategoryTotal(category) {
  const { total, items } = await fetchPage(category.apiEndpoint, 0, 1);
  return total ?? items.length;
}

/**
 * Fetch ALL organizations for a category, following pagination to the end.
 * Detects the final page via the reported `total` and guards against
 * infinite loops (empty pages / runaway page counts).
 *
 * @param {object} category one of CATEGORIES
 * @param {(pageInfo: {page:number,pages:number,fetched:number,total:number}) => void} onPage
 * @returns {Promise<Array>} normalized org descriptors
 */
export async function fetchAllOrganizations(category, onPage) {
  const first = await fetchPage(category.apiEndpoint, 0, API_PAGE_SIZE);
  const total = first.total ?? first.items.length;
  const pages = Math.max(1, Math.ceil(total / API_PAGE_SIZE));

  const orgs = [];
  const seen = new Set();
  const pushItems = (items) => {
    for (const it of items) {
      const id = it.id || it.slug;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      orgs.push(toOrg(category, it));
    }
  };

  pushItems(first.items);
  if (onPage) onPage({ page: 1, pages, fetched: orgs.length, total });

  for (let page = 2; page <= pages; page++) {
    const offset = (page - 1) * API_PAGE_SIZE;
    const { items } = await fetchPage(category.apiEndpoint, offset, API_PAGE_SIZE);
    if (!items.length) break; // final page reached / defensive stop
    pushItems(items);
    if (onPage) onPage({ page, pages, fetched: orgs.length, total });
    // Hard guard against an unexpected runaway loop.
    if (page > total + 5) break;
  }

  return orgs;
}

/**
 * Enumerate every organization across ALL four categories into one flat list.
 * Used by the incremental planner to diff the full ecosystem against the saved
 * dataset before any LinkedIn scraping happens (API only — no LinkedIn tabs).
 *
 * @param {(info: {categoryLabel:string, page:number, pages:number, fetched:number, total:number, totalSoFar:number}) => void} onProgress
 * @returns {Promise<Array>} flat list of org descriptors across all categories
 */
export async function enumerateAllCategories(onProgress) {
  const all = [];
  for (const category of CATEGORIES) {
    const orgs = await fetchAllOrganizations(category, (p) => {
      if (onProgress) {
        onProgress({
          categoryLabel: category.label,
          page: p.page,
          pages: p.pages,
          fetched: p.fetched,
          total: p.total,
          totalSoFar: all.length + p.fetched,
        });
      }
    });
    all.push(...orgs);
  }
  return all;
}

// Reduce a raw API item to just what the extractor needs.
function toOrg(category, item) {
  const links = Array.isArray(item.links) ? item.links : [];
  const linkedinLink = links.find(
    (l) => l && l.link_type_code === "linkedin" && l.url && l.url.trim()
  );
  return {
    id: item.id || item.slug,
    name: item.name || item.legal_name || "(unnamed)",
    slug: item.slug || "",
    categoryKey: category.key,
    categoryLabel: category.label,
    detailUrl: item.slug
      ? `${STARTIA_ORIGIN}/ecosystem/${category.urlSegment}/detail?slug=${item.slug}`
      : `${STARTIA_ORIGIN}/ecosystem?tab=${category.urlSegment}`,
    linkedinUrl: linkedinLink ? linkedinLink.url.trim() : "",
    // StartIA sometimes lists named people directly; used as a fallback source.
    people: Array.isArray(item.people) ? item.people : [],
    city: item.city && item.city.name ? item.city.name : "",
  };
}
