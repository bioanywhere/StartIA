// Full LinkedIn profile enrichment extractor.
//
// Injected verbatim into a /in/<slug> page via chrome.scripting.executeScript,
// so it MUST be fully self-contained (no imports, no outer references). It reads
// only what the logged-in session already renders (public/session-visible), and
// returns a structured object — experience/education/skills as ARRAYS, not one
// blob of text.
//
// LinkedIn's DOM changes often; every selector below is defensive with
// fallbacks, and the function degrades gracefully (partial data rather than
// throwing). JSON-LD is preferred where present because it is the most stable.

export function extractProfileFull() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const textOf = (el) => clean(el && el.textContent);
  // Nudge lazy content into rendering (the background retries this repeatedly).
  try {
    window.scrollTo(0, document.body.scrollHeight);
    window.scrollTo(0, 0);
  } catch {
    /* ignore */
  }

  const result = {
    ok: false,
    reason: "", // "" | auth_wall | captcha | not_found
    url: location.href.split("?")[0].replace(/\/+$/, ""),
    name: "",
    headline: "",
    about: "",
    location: "",
    current_company: "",
    current_title: "",
    photo_url: "",
    connections: "",
    experience: [], // [{ title, company, employment_type, location, date_range, description }]
    education: [], // [{ school, degree, field, date_range }]
    skills: [], // [string]
    source: "dom",
  };

  // ---- Failure classification (same taxonomy as the light extractor) --------
  const href = location.href;
  const title = document.title || "";
  const body = (document.body && document.body.innerText) || "";
  const lc = (title + " " + body).toLowerCase();
  if (
    /\/checkpoint\/challenge|\/checkpoint\/lg|security-verification/i.test(href) ||
    /quick security check|security verification|unusual activity|are you a (human|robot)|captcha|verificaci[oó]n de seguridad/i.test(lc)
  ) {
    result.reason = "captcha";
    return result;
  }
  if (
    !/linkedin\.com\/in\//i.test(href) ||
    /\/authwall|\/login|\/uas\/login|\/signup/i.test(href) ||
    // Real login/join titles only. A bare "LinkedIn" is the transient LOADING
    // title — do NOT treat it as an auth wall, or we'd bail before the profile
    // renders (returns name_not_found instead, so the background retries).
    /^\s*(sign up|log in|join linkedin)\s*(\|\s*linkedin\s*)?$/i.test(title)
  ) {
    result.reason = "auth_wall";
    return result;
  }
  if (/page not found|this page doesn.t exist|profile not found|esta p[aá]gina no existe/i.test(lc)) {
    result.reason = "not_found";
    return result;
  }

  // ---- 1) schema.org JSON-LD (most stable for identity fields) --------------
  try {
    for (const b of document.querySelectorAll('script[type="application/ld+json"]')) {
      let json;
      try {
        json = JSON.parse(b.textContent);
      } catch {
        continue;
      }
      const graph = json["@graph"] || (Array.isArray(json) ? json : [json]);
      for (const node of graph) {
        if (!node || (node["@type"] !== "Person" && !node.givenName && !node.familyName)) continue;
        result.name = result.name || clean(node.name);
        result.headline = result.headline || clean(node.jobTitle || node.description);
        if (node.image && (node.image.contentUrl || typeof node.image === "string")) {
          result.photo_url = result.photo_url || clean(node.image.contentUrl || node.image);
        }
        if (node.address) {
          const a = node.address;
          result.location =
            result.location ||
            clean([a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(", "));
        }
        const works = node.worksFor && (Array.isArray(node.worksFor) ? node.worksFor : [node.worksFor]);
        if (works && works[0]) result.current_company = result.current_company || clean(works[0].name);
        const alma = node.alumniOf && (Array.isArray(node.alumniOf) ? node.alumniOf : [node.alumniOf]);
        if (alma) {
          for (const s of alma) {
            const school = clean(s && s.name);
            if (school) result.education.push({ school, degree: "", field: "", date_range: "" });
          }
        }
        result.source = "json-ld+dom";
      }
    }
  } catch {
    /* ignore; DOM below fills gaps */
  }

  // ---- 2) DOM: identity fallbacks ------------------------------------------
  if (!result.name) {
    result.name = textOf(
      document.querySelector("main h1, h1.text-heading-xlarge, .pv-text-details__left-panel h1, h1")
    );
  }
  // Title fallback: a loaded profile's <title> is "Name | LinkedIn" or
  // "(3) Name | LinkedIn". Ignore login/placeholder titles.
  if (!result.name) {
    const t = clean((document.title || "").replace(/\s*\|\s*LinkedIn\s*$/i, "").replace(/^\(\d+\)\s*/, ""));
    if (t && !/^(sign up|log in|join linkedin|linkedin)$/i.test(t)) result.name = t;
  }
  if (!result.headline) {
    result.headline = textOf(
      document.querySelector(".text-body-medium.break-words") ||
        document.querySelector(".pv-text-details__left-panel .text-body-medium")
    );
  }
  if (!result.location) {
    result.location = textOf(
      document.querySelector(
        ".pv-text-details__left-panel span.text-body-small.inline.t-black--light.break-words"
      ) || document.querySelector("span.text-body-small.inline.t-black--light.break-words")
    );
  }
  if (!result.photo_url) {
    const img = document.querySelector("img.pv-top-card-profile-picture__image, img.profile-photo-edit__preview, main img[width]");
    if (img && img.src && /media|licdn/i.test(img.src)) result.photo_url = img.src;
  }
  // Connections / followers.
  {
    const m = body.match(/([\d.,]+)\s*(connections|followers|contactos|seguidores)/i);
    if (m) result.connections = clean(m[0]);
  }

  // ---- 3) DOM sections: locate by anchor id, then read list items ----------
  const sectionFor = (anchorId) => {
    const anchor = document.getElementById(anchorId);
    if (anchor) return anchor.closest("section") || anchor.parentElement;
    // Fallback: a section whose header text matches.
    const heads = [...document.querySelectorAll("section h2, section .pvs-header__title span[aria-hidden='true']")];
    const h = heads.find((el) => new RegExp(anchorId, "i").test(el.textContent || ""));
    return h ? h.closest("section") : null;
  };
  const itemsIn = (section) =>
    section ? [...section.querySelectorAll("li.artdeco-list__item, li.pvs-list__paged-list-item, .pvs-entity")] : [];
  // Bold visible line inside an entity is the primary label.
  const boldLine = (li) =>
    textOf(li.querySelector(".t-bold span[aria-hidden='true'], .t-bold, .mr1.t-bold span[aria-hidden='true']"));
  const normalLines = (li) =>
    [...li.querySelectorAll(".t-14.t-normal span[aria-hidden='true'], .t-14.t-normal")]
      .map(textOf)
      .filter(Boolean);
  const lightLine = (li) =>
    textOf(li.querySelector(".t-14.t-normal.t-black--light span[aria-hidden='true'], .pvs-entity__caption-wrapper"));

  // Experience.
  for (const li of itemsIn(sectionFor("experience"))) {
    const title = boldLine(li);
    if (!title) continue;
    const lines = normalLines(li);
    const company = lines[0] || "";
    result.experience.push({
      title,
      company: company.replace(/\s*·\s*.*$/, ""), // drop "· Full-time"
      employment_type: (company.match(/·\s*(.+)$/) || [])[1] || "",
      location: lines.find((l) => /,|remote|hybrid|on-site|remoto|presencial/i.test(l)) || "",
      date_range: lightLine(li),
      description: "",
    });
  }

  // Education (merge with any JSON-LD alumniOf already added).
  for (const li of itemsIn(sectionFor("education"))) {
    const school = boldLine(li);
    if (!school) continue;
    const lines = normalLines(li);
    if (!result.education.some((e) => e.school === school)) {
      result.education.push({
        school,
        degree: lines[0] || "",
        field: lines[1] || "",
        date_range: lightLine(li),
      });
    }
  }

  // Skills.
  for (const li of itemsIn(sectionFor("skills"))) {
    const s = boldLine(li);
    if (s && !result.skills.includes(s)) result.skills.push(s);
  }

  // Current company/title from the first experience entry if not set.
  if (!result.current_title && result.experience[0]) result.current_title = result.experience[0].title;
  if (!result.current_company && result.experience[0]) result.current_company = result.experience[0].company;

  // About / summary.
  {
    const about = sectionFor("about");
    if (about) {
      const span = about.querySelector(".display-flex.full-width span[aria-hidden='true'], .pv-shared-text-with-see-more span[aria-hidden='true']");
      result.about = textOf(span);
    }
  }

  result.ok = !!result.name;
  if (!result.ok && !result.reason) result.reason = "name_not_found";

  // Diagnostics so we can see, from the app, exactly what the page exposed and
  // which section anchors exist (used to fix selectors against live LinkedIn).
  let jsonLdPerson = false;
  for (const b of document.querySelectorAll('script[type="application/ld+json"]')) {
    if (/"@type"\s*:\s*"Person"|"givenName"|"familyName"/.test(b.textContent || "")) jsonLdPerson = true;
  }
  result._debug = {
    title: document.title,
    href: location.href,
    hasMainH1: !!document.querySelector("main h1, h1"),
    jsonLdPerson,
    expSection: !!sectionFor("experience"),
    expItems: itemsIn(sectionFor("experience")).length,
    eduSection: !!sectionFor("education"),
    skillsSection: !!sectionFor("skills"),
    anchorIds: [...document.querySelectorAll("section [id], div[id]")]
      .map((e) => e.id)
      .filter((id) => id && id.length < 40)
      .slice(0, 30),
  };
  return result;
}
