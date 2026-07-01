export const AURORA_MUNICIPALITIES = [
  "Baler",
  "Casiguran",
  "Dilasag",
  "Dinalungan",
  "Dingalan",
  "Dipaculao",
  "Maria Aurora",
  "San Luis",
] as const;

export type AuroraMunicipality = (typeof AURORA_MUNICIPALITIES)[number];

export type CanonicalHeader =
  | "municipality"
  | "barangay"
  | "participant_id"
  | "slp_unique_id"
  | "project_id"
  | "grant_code"
  | "fund_source"
  | "full_name"
  | "first_name"
  | "middle_name"
  | "last_name"
  | "extension_name"
  | "enterprise_type"
  | "project_name"
  | "status_gur"
  | "training_title"
  | "visit"
  | "sex"
  | "birthdate"
  | "unknown";

const aliasMap: Record<CanonicalHeader, string[]> = {
  municipality: ["municipality", "city municipality", "city municipality address", "mun", "address municipality", "city"],
  barangay: ["barangay", "brgy", "village"],
  participant_id: ["slp participant id", "participant id", "slpis id", "slp id", "slp paricipant id", "paricipant id"],
  slp_unique_id: ["slp unique id", "unique id", "slp uniqueid", "slp unique"],
  project_id: ["project id", "slp project id", "unique project id"],
  grant_code: ["grant code", "code", "grant_code", "grant id", "project code"],
  fund_source: ["fundsource", "fund source", "fund_source", "funding source"],
  full_name: ["full name", "name", "participant name", "beneficiary name", "client name", "member name"],
  first_name: ["first name", "firstname", "given name"],
  middle_name: ["middle name", "middle initial", "mi", "middle"],
  last_name: ["last name", "lastname", "surname", "family name"],
  extension_name: ["extension name", "extension", "suffix", "ext name"],
  enterprise_type: ["enterprise", "enterprise type", "project type", "enterprise / project type", "enterprise project type", "type of project", "business type", "microenterprise"],
  project_name: ["project name", "name of project", "project title", "enterprise name", "livelihood project", "livelihood activity", "project enterprise"],
  status_gur: ["status gur", "gur status", "operational status", "project status", "enterprise status", "livelihood status", "monitoring status", "status"],
  training_title: ["training", "training title", "training name", "capability building", "training batch name", "type"],
  visit: ["visit", "visit count", "monitoring visit", "date monitored", "monitoring date"],
  sex: ["sex", "gender"],
  birthdate: ["birthdate", "birth date", "date of birth", "birthday"],
  unknown: [],
};

export function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeHeader(header = "") {
  return normalizeText(header.replace(/[\r\n]+/g, " "));
}

export function canonicalHeader(header = ""): CanonicalHeader {
  const normalized = normalizeHeader(header);
  for (const [canonical, aliases] of Object.entries(aliasMap) as Array<[CanonicalHeader, string[]]>) {
    if (canonical === "unknown") continue;
    if (aliases.some((alias) => normalized === normalizeHeader(alias))) return canonical;
  }
  for (const [canonical, aliases] of Object.entries(aliasMap) as Array<[CanonicalHeader, string[]]>) {
    if (canonical === "unknown") continue;
    if (aliases.some((alias) => {
      const a = normalizeHeader(alias);
      if (a.length < 4) return false;
      if (a === "name" && normalized !== "name") return false;
      return normalized.includes(a) || a.includes(normalized);
    })) return canonical;
  }
  return "unknown";
}

export function findHeader(headers: string[], candidates: CanonicalHeader[]) {
  const key = `${headers.join("\u001f")}::${candidates.join("|")}`;
  const cached = headerLookupCache.get(key);
  if (cached !== undefined) return cached;
  const found = headers.find((header) => candidates.includes(canonicalHeader(header))) || "";
  headerLookupCache.set(key, found);
  return found;
}

const headerLookupCache = new Map<string, string>();

export function cell(row: Record<string, any>, headers: string[], candidates: CanonicalHeader[]) {
  const header = findHeader(headers, candidates);
  return header ? String(row[header] ?? "").trim() : "";
}

export function normalizeMunicipality(value = ""): AuroraMunicipality | "" {
  const normalized = normalizeText(value);
  return AURORA_MUNICIPALITIES.find((municipality) => normalizeText(municipality) === normalized) || "";
}

export function normalizePersonName(value = "") {
  return normalizeText(value)
    .replace(/\b(jr|junior|sr|senior|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildFullName(row: Record<string, any>, headers: string[]) {
  const full = cell(row, headers, ["full_name"]);
  if (full) return normalizePersonName(full);
  const last = cell(row, headers, ["last_name"]);
  const first = cell(row, headers, ["first_name"]);
  const middle = cell(row, headers, ["middle_name"]);
  const ext = cell(row, headers, ["extension_name"]);
  return normalizePersonName([last, first, middle, ext].filter(Boolean).join(" "));
}

export function normalizeStatus(value = ""): "operational" | "closed" | "unknown" {
  const normalized = normalizeText(value);
  if (!normalized) return "unknown";
  if (/\b(closed|close|not operational|non operational|nonoperational|stopped|inactive|ceased|terminated|dissolved|not operating)\b/.test(normalized)) return "closed";
  if (/\b(operational|operating|active|functional|ongoing|in operation)\b/.test(normalized)) return "operational";
  return "unknown";
}

export function normalizeEnterpriseStatus(value = ""): "operational" | "closed" | "unknown" {
  return normalizeStatus(value);
}

export function normalizeEnterpriseType(value = "") {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  const compact = normalized.replace(/\s+/g, "");
  const aliases: Record<string, string> = {
    sarisarivending: "Sari-Sari Vending",
    hograising: "Hog Raising",
    pigraising: "Pig Raising",
    goatraising: "Goat Raising",
    fishvending: "Fish Vending",
    foodvending: "Food Vending",
  };
  return aliases[compact] || normalized.split(" ").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export function normalizedHeaders(headers: string[]) {
  return headers.map((header) => ({ original: header, canonical: canonicalHeader(header) }));
}
