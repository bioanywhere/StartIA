// Contact-info enrichment providers (email / phone by LinkedIn URL).
//
// Each adapter takes a normalized profile URL + API key and returns a NORMALIZED
// result so the rest of the app is provider-agnostic:
//   { ok, status, error, emails:[{value,type,confidence}], phones:[{value,type}] }
// Runs in the background service worker (host_permissions grant the fetch).
//
// NOTE: Apollo and ContactOut response shapes change over time; these adapters
// target the documented shapes and are defensive, but may need tuning against a
// live key. They never throw — failures come back as { ok:false, status,error }.

export const PROVIDERS = [
  { id: "apollo", name: "Apollo", keyField: "apolloKey", keyHelp: "Apollo API key (Settings → API)" },
  { id: "contactout", name: "ContactOut", keyField: "contactoutKey", keyHelp: "ContactOut API token" },
];

export function providerKeyField(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  return p ? p.keyField : null;
}

export async function findContactInfo(providerId, url, apiKey) {
  if (!apiKey) return { ok: false, status: "no_key", error: `No API key configured for ${providerId}` };
  try {
    if (providerId === "apollo") return await apollo(url, apiKey);
    if (providerId === "contactout") return await contactout(url, apiKey);
    return { ok: false, status: "error", error: "unknown provider: " + providerId };
  } catch (e) {
    return { ok: false, status: "error", error: String((e && e.message) || e) };
  }
}

// ---- Apollo (POST /api/v1/people/match) -----------------------------------
async function apollo(url, apiKey) {
  const res = await fetch(
    "https://api.apollo.io/api/v1/people/match?reveal_personal_emails=true&reveal_phone_number=true",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": apiKey },
      body: JSON.stringify({ linkedin_url: url }),
    }
  );
  if (!res.ok) return { ok: false, status: "http_" + res.status, error: "Apollo HTTP " + res.status };
  const j = await res.json();
  const p = j.person || j.contact || {};
  const emails = [];
  if (p.email) emails.push({ value: p.email, type: "work", confidence: p.email_status || "" });
  for (const e of p.personal_emails || []) emails.push({ value: e, type: "personal", confidence: "" });
  const phones = (p.phone_numbers || []).map((x) => ({
    value: (x && (x.sanitized_number || x.raw_number)) || String(x || ""),
    type: (x && x.type) || "",
  }));
  return { ok: emails.length > 0 || phones.length > 0, status: emails.length || phones.length ? "ok" : "not_found", emails, phones };
}

// ---- ContactOut (GET /v1/people/linkedin) ---------------------------------
async function contactout(url, apiKey) {
  const res = await fetch(
    "https://api.contactout.com/v1/people/linkedin?profile=" + encodeURIComponent(url) + "&include_phone=true",
    { headers: { authorization: "basic", token: apiKey, "Content-Type": "application/json" } }
  );
  if (!res.ok) return { ok: false, status: "http_" + res.status, error: "ContactOut HTTP " + res.status };
  const j = await res.json();
  const prof = j.profile || j.data || j || {};
  const emailVals = [].concat(prof.email || [], prof.work_email || [], prof.personal_email || []);
  const phoneVals = [].concat(prof.phone || [], prof.phone_number || []);
  const emails = [...new Set(emailVals.filter(Boolean))].map((v) => ({ value: v, type: "", confidence: "" }));
  const phones = [...new Set(phoneVals.filter(Boolean))].map((v) => ({ value: v, type: "" }));
  return { ok: emails.length > 0 || phones.length > 0, status: emails.length || phones.length ? "ok" : "not_found", emails, phones };
}
