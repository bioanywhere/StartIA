// LinkedIn DOM extractors.
//
// IMPORTANT: every function in this file is injected verbatim into a LinkedIn
// page via chrome.scripting.executeScript({ func }). Because the function
// source is serialized and re-parsed in the page's isolated world, each one
// MUST be fully self-contained: no imports, no references to module scope,
// and any helpers must be declared inside the function body.
//
// The extractors only read what is already rendered for the logged-in user
// (public / session-visible data). They never authenticate or click through.

/**
 * Extract data from an individual profile page (/in/<slug>).
 * Returns { ok, name, title, company, location, url, source }.
 */
export function extractIndividualProfile() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  const result = {
    ok: false,
    name: "",
    title: "",
    company: "",
    location: "",
    url: location.href.split("?")[0].replace(/\/+$/, ""),
    reason: "", // "" on success; else captcha | auth_wall | not_found | name_not_found
    source: "dom",
  };

  // Classify a failure page by URL, title, and body. If the background tab was
  // redirected/blocked we must NOT treat that page as the contact's profile —
  // the caller leaves the URL blank and records this reason.
  const href = location.href;
  const title = document.title || "";
  const bodyText = (document.body && document.body.innerText) || "";
  const lc = (title + " " + bodyText).toLowerCase();

  // Security checkpoint / captcha.
  if (
    /\/checkpoint\/challenge|\/checkpoint\/lg|security-verification/i.test(href) ||
    /quick security check|security verification|unusual activity|are you a (human|robot)|captcha|verificaci[oó]n de seguridad/i.test(lc)
  ) {
    result.reason = "captcha";
    return result;
  }
  // Login / auth wall / redirected off the profile.
  const onProfile = /linkedin\.com\/in\//i.test(href);
  if (
    !onProfile ||
    /\/authwall|\/login|\/uas\/login|\/signup/i.test(href) ||
    /^\s*(sign up|log in|join linkedin)\s*(\|\s*linkedin\s*)?$/i.test(title) ||
    (/join linkedin|sign in to|authwall|log in to linkedin/i.test(bodyText) &&
      !document.querySelector("main h1, h1"))
  ) {
    result.reason = "auth_wall";
    return result;
  }
  // 404 / profile not found (no HTTP status in a content script — match text).
  if (
    /page not found|page doesn.t exist|this page doesn.t exist|profile not found|esta p[aá]gina no existe|no se encontr[oó] la p[aá]gina/i.test(lc)
  ) {
    result.reason = "not_found";
    return result;
  }

  // 1) Prefer structured data (schema.org Person) when present — most stable.
  try {
    const blocks = document.querySelectorAll('script[type="application/ld+json"]');
    for (const b of blocks) {
      let json;
      try {
        json = JSON.parse(b.textContent);
      } catch {
        continue;
      }
      const graph = json["@graph"] || (Array.isArray(json) ? json : [json]);
      for (const node of graph) {
        if (node && (node["@type"] === "Person" || node.givenName || node.familyName)) {
          if (!result.name) result.name = clean(node.name);
          if (!result.title) result.title = clean(node.jobTitle || node.description);
          if (node.address) {
            const a = node.address;
            result.location = clean(
              [a.addressLocality, a.addressRegion, a.addressCountry]
                .filter(Boolean)
                .join(", ")
            );
          }
          if (node.worksFor) {
            const w = Array.isArray(node.worksFor) ? node.worksFor[0] : node.worksFor;
            if (w) result.company = clean(w.name);
          }
          result.source = "json-ld";
        }
      }
    }
  } catch {
    /* fall through to DOM scraping */
  }

  // 2) DOM fallbacks (selectors are defensive: several candidates each).
  if (!result.name) {
    const h1 = document.querySelector("main h1, h1.text-heading-xlarge, h1");
    result.name = clean(h1 && h1.textContent);
  }
  if (!result.title) {
    const t =
      document.querySelector(".text-body-medium.break-words") ||
      document.querySelector('[data-generated-suggestion-target] .text-body-medium') ||
      document.querySelector(".pv-text-details__left-panel .text-body-medium");
    result.title = clean(t && t.textContent);
  }
  if (!result.location) {
    const loc =
      document.querySelector(
        ".pv-text-details__left-panel .text-body-small.inline.t-black--light.break-words"
      ) ||
      document.querySelector(
        "span.text-body-small.inline.t-black--light.break-words"
      );
    result.location = clean(loc && loc.textContent);
  }
  if (!result.company) {
    const comp =
      document.querySelector('button[aria-label^="Current company"]') ||
      document.querySelector(".pv-text-details__right-panel button span") ||
      document.querySelector('[aria-label*="Current company" i]');
    result.company = clean(comp && comp.textContent);
  }

  // 3) Last-resort name fallback: the document title on a loaded profile is
  //    "Name | LinkedIn" or "(3) Name | LinkedIn". Ignore login/placeholder
  //    titles so we never capture a wall page as a name.
  if (!result.name) {
    let t = clean(title.replace(/\s*\|\s*LinkedIn\s*$/i, "").replace(/^\(\d+\)\s*/, ""));
    if (t && !/^(sign up|log in|join linkedin|linkedin)$/i.test(t)) result.name = t;
  }

  result.ok = !!result.name;
  if (!result.ok) result.reason = "name_not_found";
  return result;
}

/**
 * Extract visible people from a company People page (/company/<slug>/people/).
 * Scrolls to load lazily-rendered cards, then reads each card.
 *
 * @param {number} maxScrolls
 * @param {number} scrollPauseMs
 * @returns {Promise<{ ok, people: Array, authWall: boolean, count: number }>}
 */
export async function extractCompanyPeople(maxScrolls, scrollPauseMs) {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const bodyText = (document.body && document.body.innerText) || "";
  const authWall =
    /join linkedin to see|sign in to see|authwall/i.test(bodyText) &&
    !document.querySelector('a[href*="/in/"]');
  if (authWall) {
    return { ok: false, people: [], authWall: true, count: 0 };
  }

  // Load lazy content by scrolling to the bottom repeatedly, and click any
  // "Show more" style button if present.
  let lastHeight = 0;
  for (let i = 0; i < (maxScrolls || 6); i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(scrollPauseMs || 1000);
    const showMore = [...document.querySelectorAll("button")].find((b) =>
      /show more|ver más|mostrar más/i.test(b.textContent || "")
    );
    if (showMore) {
      try {
        showMore.click();
      } catch {
        /* ignore */
      }
      await sleep(scrollPauseMs || 1000);
    }
    const h = document.body.scrollHeight;
    if (h === lastHeight && i > 1) break; // nothing new loaded
    lastHeight = h;
  }

  // Person cards on the People tab.
  const cardSelectors = [
    ".org-people-profile-card",
    "li.grid.grid__col--lg-8",
    ".artdeco-entity-lockup",
  ];
  let cards = [];
  for (const sel of cardSelectors) {
    cards = [...document.querySelectorAll(sel)];
    if (cards.length) break;
  }

  const people = [];
  const seen = new Set();

  const readCard = (card) => {
    const link = card.querySelector('a[href*="/in/"]');
    let profileUrl = "";
    if (link) {
      try {
        const u = new URL(link.href, location.origin);
        profileUrl = (u.origin + u.pathname).replace(/\/+$/, "");
      } catch {
        profileUrl = link.href;
      }
    }

    const nameEl =
      card.querySelector(".org-people-profile-card__profile-title") ||
      card.querySelector(".artdeco-entity-lockup__title") ||
      card.querySelector('[class*="profile-title"]');
    let name = clean(nameEl && nameEl.textContent);

    const titleEl =
      card.querySelector(".artdeco-entity-lockup__subtitle") ||
      card.querySelector(".org-people-profile-card__profile-info") ||
      card.querySelector('[class*="subtitle"]');
    const title = clean(titleEl && titleEl.textContent);

    // Skip anonymized "LinkedIn Member" entries with no usable identity.
    if (/^linkedin member$/i.test(name)) name = "LinkedIn Member";
    if (!name && !profileUrl) return;

    const dedupeKey = profileUrl || name + "|" + title;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    people.push({
      name,
      title,
      profileUrl,
      location: "",
    });
  };

  cards.forEach(readCard);

  // Fallback: if card selectors matched nothing, harvest bare /in/ anchors.
  if (!people.length) {
    const anchors = [...document.querySelectorAll('a[href*="/in/"]')];
    for (const a of anchors) {
      let profileUrl;
      try {
        const u = new URL(a.href, location.origin);
        profileUrl = (u.origin + u.pathname).replace(/\/+$/, "");
      } catch {
        continue;
      }
      if (seen.has(profileUrl)) continue;
      seen.add(profileUrl);
      const name = clean(a.textContent);
      if (!name) continue;
      people.push({ name, title: "", profileUrl, location: "" });
    }
  }

  return { ok: true, people, authWall: false, count: people.length };
}
