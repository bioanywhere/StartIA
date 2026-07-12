// Central configuration and constants for the StartIA → LinkedIn extractor.

export const STARTIA_ORIGIN = "https://startia.com.co";

// Each StartIA "tab" maps to an API endpoint, a human-readable category label
// (per the required data structure), and the front-end URL segment used to
// build the organization detail URL.
export const CATEGORIES = [
  {
    key: "startups",
    apiEndpoint: "/back/api/organizations/startups",
    label: "Startup",
    urlSegment: "startups",
  },
  {
    key: "investors",
    apiEndpoint: "/back/api/organizations/investors",
    label: "Investor",
    urlSegment: "investors",
  },
  {
    // The "Ecosystem Actors" tab (Entidades de Apoyo) is served by /supports.
    key: "supports",
    apiEndpoint: "/back/api/organizations/supports",
    label: "Actor",
    urlSegment: "actors",
  },
  {
    key: "labs",
    apiEndpoint: "/back/api/organizations/labs",
    label: "Lab",
    urlSegment: "labs",
  },
];

// How many organizations to request per API page.
export const API_PAGE_SIZE = 100;

// Timing (milliseconds). Kept deliberately generous to be polite to both
// StartIA and LinkedIn and to avoid triggering anti-automation defenses.
export const DELAYS = {
  betweenOrgs: 2500, // pause after finishing one organization
  betweenApiPages: 800, // pause between StartIA API pages
  linkedinTabLoad: 20000, // max time to wait for a LinkedIn tab to be usable
  afterTabReady: 3500, // settle time after the tab reports "complete"
  scrollStep: 1200, // pause between scroll steps on company People pages
};

// Maximum number of scroll iterations when loading a company People page.
export const MAX_PEOPLE_SCROLLS = 8;

// Titles that identify decision-makers. Used to prioritize/flag contacts.
export const DECISION_MAKER_TERMS = [
  "founder",
  "co-founder",
  "cofounder",
  "ceo",
  "chief executive",
  "president",
  "presidente",
  "managing director",
  "director general",
  "gerente general",
  "partner",
  "socio",
  "general manager",
  "cto",
  "coo",
  "cfo",
  "chief",
  "head of",
  "head ",
  "director",
  "directora",
  "vp ",
  "vice president",
  "owner",
  "fundador",
  "fundadora",
];

// Storage keys.
export const STORAGE_KEYS = {
  state: "startia_extractor_state",
};

// The full record shape, in the exact order required for export.
export const RECORD_FIELDS = [
  "category", // StartIA category: Startup, Investor, Actor, Lab
  "org_name", // Organization name
  "org_detail_url", // StartIA organization detail URL
  "linkedin_source_type", // Individual | Company
  "linkedin_company_url", // LinkedIn company URL (when applicable)
  "contact_full_name", // Contact full name
  "contact_title", // Contact job title / headline
  "contact_linkedin_url", // Contact LinkedIn profile URL
  "contact_location", // Contact location
  "is_decision_maker", // heuristic flag (bonus, not required but useful)
  "status", // Extraction status
  "error", // Error details, when applicable
  "extracted_at", // Extraction date & time (ISO)
];
