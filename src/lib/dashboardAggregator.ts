import { classifyDataSource, sourceDisplayName, type SourceType } from "../config/dataSourceRegistry.ts";
import {
  AURORA_MUNICIPALITIES,
  buildFullName,
  cell,
  normalizeEnterpriseType,
  normalizeMunicipality,
  normalizeEnterpriseStatus,
  normalizeText,
  normalizedHeaders,
  type AuroraMunicipality,
} from "./headerNormalizer.ts";
import { OFFICIAL_TRAINING_TITLES, normalizeTrainingTitle } from "./trainingTitleNormalizer.ts";
import { buildMonitoringCoverage } from "./monitoringCoverage.ts";

type SourceInput = {
  folder?: string;
  fileName?: string;
  file_name?: string;
  sheetName?: string;
  sheet_name?: string;
  file_type?: string;
  headers?: string[];
  rows?: Array<Record<string, any>>;
  source?: string;
  updated_at?: string;
  created_at?: string;
};

type ClassifiedSource = SourceInput & {
  sourceType: SourceType;
  confidence: number;
  matchedHeaders: string[];
  missingHeaders: string[];
  sourceLabel: string;
};

function compactSourceFileKey(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function monitoringSourceTypeFromFilename(fileName = ""): SourceType | "" {
  const file = compactSourceFileKey(fileName);
  if (file.includes("mdmonitoringassociation")) return "SLPIS_MONITORING_ASSOCIATION_MODULE";
  if (file.includes("mdmonitoringindividual")) return "SLPIS_MONITORING_INDIVIDUAL_MODULE";
  if (file.includes("orgassessment")) return "SLPIS_ORG_ASSESSMENT_MODULE";
  if (file.includes("mdannualassessment")) return "SLPIS_ANNUAL_ASSESSMENT_MODULE";
  return "";
}

function canonicalDashboardSourceType(sourceType: SourceType): SourceType {
  if (sourceType === "MD_MONITORING_ASSOCIATION") return "SLPIS_MONITORING_ASSOCIATION_MODULE";
  if (sourceType === "MD_MONITORING_INDIVIDUAL") return "SLPIS_MONITORING_INDIVIDUAL_MODULE";
  if (sourceType === "ORG_ASSESSMENT") return "SLPIS_ORG_ASSESSMENT_MODULE";
  if (sourceType === "MD_ANNUAL_ASSESSMENT") return "SLPIS_ANNUAL_ASSESSMENT_MODULE";
  return sourceType;
}

function monitoringDebugModuleType(sourceType: SourceType) {
  const canonical = canonicalDashboardSourceType(sourceType);
  if (canonical === "SLPIS_MONITORING_INDIVIDUAL_MODULE") return "MD_MONITORING_INDIVIDUAL";
  if (canonical === "SLPIS_MONITORING_ASSOCIATION_MODULE") return "MD_MONITORING_ASSOCIATION";
  if (canonical === "SLPIS_ORG_ASSESSMENT_MODULE") return "ORG_ASSESSMENT";
  if (canonical === "SLPIS_ANNUAL_ASSESSMENT_MODULE") return "MD_ANNUAL_ASSESSMENT";
  return canonical;
}

function isMonitoringCoverageSource(sourceType: SourceType) {
  return [
    "SLPIS_MONITORING_INDIVIDUAL_MODULE",
    "SLPIS_MONITORING_ASSOCIATION_MODULE",
    "SLPIS_ORG_ASSESSMENT_MODULE",
    "SLPIS_ANNUAL_ASSESSMENT_MODULE",
    "MD_MONITORING_INDIVIDUAL",
    "MD_MONITORING_ASSOCIATION",
    "ORG_ASSESSMENT",
    "MD_ANNUAL_ASSESSMENT",
  ].includes(sourceType);
}

function sourceName(source: SourceInput) {
  return [source.folder, source.fileName || source.file_name, source.sheetName || source.sheet_name].filter(Boolean).join(" / ") || source.source || "Indexed source";
}

function classifySources(sources: SourceInput[]): ClassifiedSource[] {
  return sources.map((source) => {
    const headers = source.headers || [];
    const folder = source.folder || "";
    const fileName = source.fileName || source.file_name || "";
    const sheetName = source.sheetName || source.sheet_name || "";
    const label = normalizeText(`${folder} ${fileName} ${sheetName}`);
    const filenameType = monitoringSourceTypeFromFilename(fileName);
    const explicitType: SourceType | "" = filenameType || (
      /\bslpis\b/.test(label) && /slp association module|slpa module|association module/.test(label) && !/monitoring|mdmonitoring|md monitoring/.test(label) ? "UNKNOWN" :
      /\bslpis\b/.test(label) && /personal module/.test(label) ? "SLPIS_PERSONAL_MODULE" :
      /\bslpis\b/.test(label) && /project module/.test(label) ? "SLPIS_PROJECT_MODULE" :
      /\bslpis\b/.test(label) && /grant utilization|gur module/.test(label) ? "SLPIS_GUR_MODULE" :
      /\bslpis\b/.test(label) && /training module/.test(label) ? "SLPIS_TRAINING_MODULE" :
      /\bslpis\b/.test(label) && /monitoring individual|mdmonitoring individual|md monitoring individual/.test(label) ? "SLPIS_MONITORING_INDIVIDUAL_MODULE" :
      /\bslpis\b/.test(label) && /monitoring association|mdmonitoring association|md monitoring association/.test(label) ? "SLPIS_MONITORING_ASSOCIATION_MODULE" :
      /\bslpis\b/.test(label) && /mdannualassessment|md annual assessment|annual assessment/.test(label) ? "SLPIS_ANNUAL_ASSESSMENT_MODULE" :
      /\bslpis\b/.test(label) && /orgassessment|org assessment|organizational assessment|organisation assessment/.test(label) ? "SLPIS_ORG_ASSESSMENT_MODULE" :
      /\bslp dpt\b|aurora database/.test(label) ? "SLP_DPT_AURORA_DATABASE" :
      "");
    const legacyModule = String((source as any).module || "");
    const legacyMap: Record<string, SourceType> = {
      PERSONAL: "SLPIS_PERSONAL_MODULE",
      PROJECT: "SLPIS_PROJECT_MODULE",
      GRANT_UTILIZATION: "SLPIS_GUR_MODULE",
      TRAINING: "SLPIS_TRAINING_MODULE",
      MDMONITORING_INDIVIDUAL: "SLPIS_MONITORING_INDIVIDUAL_MODULE",
      MDMONITORING_ASSOCIATION: "SLPIS_MONITORING_ASSOCIATION_MODULE",
      MDANNUALASSESSMENT: "SLPIS_ANNUAL_ASSESSMENT_MODULE",
      ORGASSESSMENT: "SLPIS_ORG_ASSESSMENT_MODULE",
      SLP_DPT_DATABASE: "SLP_DPT_AURORA_DATABASE",
      GUIDELINES_MC03: "GUIDELINES",
    };
    const detected = classifyDataSource(fileName, folder, sheetName, headers, source.file_type || "");
    const classification = explicitType
      ? { sourceType: explicitType, confidence: 100, matchedHeaders: detected.matchedHeaders, missingHeaders: detected.missingHeaders, reason: `explicit folder/file mapping to ${explicitType}` }
      : legacyMap[legacyModule]
      ? { sourceType: legacyMap[legacyModule], confidence: 100, matchedHeaders: detected.matchedHeaders, missingHeaders: detected.missingHeaders, reason: `backend module detector mapped ${legacyModule}` }
      : detected;
    return {
      ...source,
      sourceType: canonicalDashboardSourceType(classification.sourceType),
      confidence: classification.confidence,
      matchedHeaders: classification.matchedHeaders,
      missingHeaders: classification.missingHeaders,
      sourceLabel: sourceName(source),
    };
  });
}

function rowsOf(sources: ClassifiedSource[], sourceTypes: SourceType[]) {
  return sources
    .filter((source) => sourceTypes.includes(source.sourceType))
    .flatMap((source) => (source.rows || []).map((row) => ({ row, source, headers: source.headers || [] })));
}

function sourceDetectionText(source: ClassifiedSource) {
  return normalizeText([
    source.folder,
    source.fileName || source.file_name,
    source.sheetName || source.sheet_name,
    source.source,
    source.sourceLabel,
    source.sourceType,
    source.headers?.join(" "),
  ].filter(Boolean).join(" "));
}

function hasAnyHeader(headers: string[], aliases: string[]) {
  const haystack = headers.map((header) => normalizeText(header));
  return aliases.some((alias) => {
    const wanted = normalizeText(alias);
    return haystack.some((header) => header === wanted || header.includes(wanted) || wanted.includes(header));
  });
}

function rowsOfDetected(sources: ClassifiedSource[], sourceTypes: SourceType[], detector: (source: ClassifiedSource) => boolean) {
  const seen = new Set<string>();
  const rows: Array<{ row: Record<string, any>; source: ClassifiedSource; headers: string[] }> = [];
  for (const source of sources) {
    if (!sourceTypes.includes(source.sourceType) && !detector(source)) continue;
    const headers = source.headers || [];
    for (const row of source.rows || []) {
      const key = `${source.sourceLabel}::${row.__rowNumber || row.__row || JSON.stringify(row).slice(0, 240)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ row, source, headers });
    }
  }
  return rows;
}

function rowsOfClassifiedOrDetected(sources: ClassifiedSource[], sourceTypes: SourceType[], detector: (source: ClassifiedSource) => boolean) {
  const classified = rowsOf(sources, sourceTypes);
  return classified.length ? classified : rowsOfDetected(sources, sourceTypes, detector);
}

function isDetectedPersonalSource(source: ClassifiedSource) {
  const text = sourceDetectionText(source);
  return /\bpersonal module\b|\bslpis personal\b/.test(text) || (hasAnyHeader(source.headers || [], ["SLP Paricipant ID", "SLP Participant ID"]) && hasAnyHeader(source.headers || [], ["Last Name", "First Name", "Full Name", "Name"]));
}

function isDetectedProjectSource(source: ClassifiedSource) {
  const text = sourceDetectionText(source);
  return /\bproject module\b|\bslpis project\b/.test(text) || (hasAnyHeader(source.headers || [], ["Project ID", "Grant Code", "Project Name"]) && hasAnyHeader(source.headers || [], ["Enterprise Type", "Project Type", "SLPA Name"]));
}

function isDetectedMdMonitoringIndividualSource(source: ClassifiedSource) {
  const text = sourceDetectionText(source);
  const headers = source.headers || [];
  return /mdmonitoring individual|md monitoring individual|monitoring individual|mdmonitoring individual module/.test(text)
    || (hasAnyHeader(headers, ["SLP Paricipant ID", "SLP Participant ID"]) && hasAnyHeader(headers, ["Ave. Monthly Net Income/Loss", "Cash at Bank", "Total Savings"]));
}

function isDetectedMdMonitoringAssociationSource(source: ClassifiedSource) {
  const text = sourceDetectionText(source);
  const headers = source.headers || [];
  return /mdmonitoring association|md monitoring association|monitoring association|mdmonitoring association module/.test(text)
    || (hasAnyHeader(headers, ["SLPA Name"]) && hasAnyHeader(headers, ["Grant Code"]) && hasAnyHeader(headers, ["Ave. Monthly Net Income/Loss", "Cash at Bank", "Total Savings"]));
}

function participantKey(row: Record<string, any>, headers: string[]) {
  const id = cell(row, headers, ["participant_id"]);
  if (id) return `pid:${normalizeText(id)}`;
  const fullName = buildFullName(row, headers);
  const municipality = normalizeMunicipality(cell(row, headers, ["municipality"]));
  return fullName && municipality ? `name:${fullName}|${municipality}` : "";
}

const PROJECT_NAME_OR_TYPE_HEADERS = [
  "name",
  "project name",
  "name of project",
  "project title",
  "enterprise name",
  "enterprise / project type",
  "project type",
  "type of project",
  "livelihood project",
  "livelihood activity",
  "business type",
  "enterprise",
];

function isGenericEnterpriseLabel(value = "") {
  return /^(individual enterprise|association enterprise)$/i.test(normalizeEnterpriseType(value));
}

function getCellByHeaderAliases(row: Record<string, any>, headers: string[], aliases: string[]) {
  const wanted = aliases.map(normalizeText);
  const exact = headers.find((header) => wanted.includes(normalizeText(header)));
  if (exact) return String(row[exact] ?? "").trim();
  const partial = headers.find((header) => {
    const normalized = normalizeText(header);
    return wanted.some((alias) => normalized.includes(alias) || alias.includes(normalized));
  });
  return partial ? String(row[partial] ?? "").trim() : "";
}

function titleCaseNormalized(value = "") {
  return normalizeText(value).split(" ").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function normalizeBarangayLabel(row: Record<string, any>, headers: string[]) {
  return titleCaseNormalized(cell(row, headers, ["barangay"]) || getCellByHeaderAliases(row, headers, ["barangay", "brgy", "village"])) || "Barangay not available";
}

function firstValidProjectLabel(row: Record<string, any>, headers: string[], aliases: string[]) {
  for (const header of aliases) {
    const raw = getCellByHeaderAliases(row, headers, [header]);
    if (!raw) continue;
    const label = normalizeEnterpriseType(raw);
    if (!label) continue;
    if (isGenericEnterpriseLabel(label)) continue;
    return label;
  }
  return "";
}

export function getProjectDisplayName(row: Record<string, any>, headers: string[], sourceType: SourceType) {
  if (sourceType === "SLPIS_PROJECT_MODULE") {
    const name = firstValidProjectLabel(row, headers, ["name"]);
    if (name) return name;
    return firstValidProjectLabel(row, headers, PROJECT_NAME_OR_TYPE_HEADERS.filter((header) => header !== "enterprise type")) || "Unspecified Project Name";
  }
  if (sourceType === "SLPIS_GUR_MODULE") {
    const projectName = firstValidProjectLabel(row, headers, ["project name"]);
    if (projectName) return projectName;
    return firstValidProjectLabel(row, headers, PROJECT_NAME_OR_TYPE_HEADERS.filter((header) => header !== "enterprise type")) || "Unspecified Project Name";
  }
  return firstValidProjectLabel(row, headers, PROJECT_NAME_OR_TYPE_HEADERS.filter((header) => header !== "enterprise type")) || "Unspecified Project Name";
}

export function getProjectNameOrType(row: Record<string, any>, headers: string[]) {
  return getProjectDisplayName(row, headers, "SLPIS_PROJECT_MODULE");
}

function projectName(row: Record<string, any>, headers: string[], sourceType: SourceType = "SLPIS_PROJECT_MODULE") {
  return getProjectDisplayName(row, headers, sourceType);
}

function projectKey(row: Record<string, any>, headers: string[], sourceType: SourceType = "SLPIS_PROJECT_MODULE") {
  const id = cell(row, headers, ["project_id"]);
  if (id) return `project:${normalizeText(id)}`;
  const grant = cell(row, headers, ["grant_code"]);
  if (grant) return `grant:${normalizeText(grant)}`;
  const name = projectName(row, headers, sourceType);
  const municipality = normalizeMunicipality(cell(row, headers, ["municipality"]));
  return name && municipality ? `name:${normalizeText(name)}|${municipality}` : "";
}

function projectMatchKeys(row: Record<string, any>, headers: string[], sourceType: SourceType = "SLPIS_PROJECT_MODULE") {
  return [
    cell(row, headers, ["project_id"]),
    cell(row, headers, ["grant_code"]),
    [projectName(row, headers, sourceType), normalizeMunicipality(cell(row, headers, ["municipality"]))].filter(Boolean).join("|"),
  ].filter(Boolean).map(normalizeText);
}

function inc(map: Map<string, number>, key: string, amount = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + amount);
}

function topRows(map: Map<string, number>, limit = 10) {
  return Array.from(map.entries()).filter(([name]) => name && name !== "Unspecified" && name !== "Unspecified Project Type").sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function uniqueProjectDedupeKey(row: Record<string, any>, headers: string[]) {
  const id = cell(row, headers, ["project_id"]);
  if (id) return `project:${normalizeText(id)}`;
  const grant = cell(row, headers, ["grant_code"]);
  if (grant) return `grant:${normalizeText(grant)}`;
  return `row:${normalizeText(JSON.stringify(row))}`;
}

function isTrainingTitleHeader(header = "") {
  const normalized = normalizeText(header).replace(/\s+/g, "");
  return normalized.includes("trainingtitle");
}

function extractTrainingTitleValues(row: Record<string, any>, headers: string[]) {
  const titles = new Map<string, string>();
  for (const header of headers) {
    if (!isTrainingTitleHeader(header)) continue;
    const title = String(row[header] ?? "").trim();
    if (!title) continue;
    titles.set(normalizeText(title), title);
  }
  if (!titles.size) {
    const fallback = String(cell(row, headers, ["training_title"]) || "").trim();
    if (fallback) titles.set(normalizeText(fallback), fallback);
  }
  return Array.from(titles.values());
}

function drilldownBaseRecord(row: Record<string, any>, headers: string[], source: ClassifiedSource) {
  const projectNameValue = projectName(row, headers, source.sourceType);
  return {
    "SLP Paricipant ID": cell(row, headers, ["participant_id"]),
    Name: buildFullName(row, headers) || getCellByHeaderAliases(row, headers, ["Name", "Participant Name"]),
    Municipality: normalizeMunicipality(cell(row, headers, ["municipality"])) || cell(row, headers, ["municipality"]),
    Barangay: normalizeBarangayLabel(row, headers),
    "Project ID": cell(row, headers, ["project_id"]),
    "Grant Code": exactOrAliasValue(row, headers, "Grant Code", ["GUR Code", "Grant ID", "Project Code"]),
    "Project Name": projectNameValue === "Unspecified Project Name" ? "" : projectNameValue,
    "SLPA Name": getCellByHeaderAliases(row, headers, ["SLPA Name", "Association Name"]),
    "Enterprise Type": normalizeEnterpriseType(cell(row, headers, ["enterprise_type"])) || projectNameValue,
    "Source Module": sourceDisplayName(source.sourceType),
    "Source File": source.sourceLabel,
    __sourceType: source.sourceType,
    __participantKey: participantKey(row, headers),
    __projectKey: projectKey(row, headers, source.sourceType),
    __projectMatchKeys: projectMatchKeys(row, headers, source.sourceType).join("|"),
  };
}

type GurDrilldownUnit = {
  unitType: "Individual" | "Association";
  key: string;
  projectId: string;
  projectName: string;
  slpaName: string;
  participantId: string;
  participantName: string;
  municipality: string;
  barangay: string;
  enterpriseType: string;
  encodedInGur: true;
  has1stVisit: boolean;
  has2ndVisit: boolean;
  has3rdVisit: boolean;
  has4thVisit: boolean;
  hasOrgAssessment: boolean;
  hasAnnualAssessment: boolean;
  sourceFiles: Set<string>;
};

function exactOrAliasValue(row: Record<string, any>, headers: string[], exact: string, aliases: string[] = []) {
  const exactHeader = headers.find((header) => normalizeText(header) === normalizeText(exact));
  if (exactHeader) return String(row[exactHeader] ?? "").trim();
  return getCellByHeaderAliases(row, headers, [exact, ...aliases]);
}

function gurProjectName(row: Record<string, any>, headers: string[], sourceType: SourceType) {
  return exactOrAliasValue(row, headers, "Project Name", ["Name of Project", "Project Title", "Name"]) || projectName(row, headers, sourceType);
}

function gurSlpaName(row: Record<string, any>, headers: string[]) {
  return exactOrAliasValue(row, headers, "SLPA Name", ["Association Name", "Organization Name"]);
}

function gurParticipantId(row: Record<string, any>, headers: string[]) {
  return exactOrAliasValue(row, headers, "SLP Paricipant ID", ["SLP Participant ID", "Participant ID"]);
}

function gurParticipantName(row: Record<string, any>, headers: string[]) {
  return exactOrAliasValue(row, headers, "Name", ["Participant Name", "Full Name"]) || buildFullName(row, headers);
}

function gurEnterpriseType(row: Record<string, any>, headers: string[]) {
  return normalizeEnterpriseType(exactOrAliasValue(row, headers, "Enterprise Type", ["Project Type", "Enterprise / Project Type", "Livelihood Project"]));
}

function gurProjectId(row: Record<string, any>, headers: string[]) {
  return exactOrAliasValue(row, headers, "Project ID", ["SLP Project ID", "Unique Project ID"]);
}

function normalizedUnitName(value = "") {
  return normalizeText(value).replace(/\b(association|slpa|group|organization|organisation)\b/g, "").replace(/\s+/g, " ").trim();
}

function inferGurUnitType(row: Record<string, any>, headers: string[]) {
  const enterprise = normalizeText(gurEnterpriseType(row, headers));
  const slpaName = gurSlpaName(row, headers);
  const participantId = gurParticipantId(row, headers);
  const participantName = gurParticipantName(row, headers);
  if (enterprise.includes("association") || slpaName) return "Association" as const;
  if (enterprise.includes("individual") || participantId || participantName) return "Individual" as const;
  return "Association" as const;
}

function gurUnitKey(type: "Individual" | "Association", row: Record<string, any>, headers: string[], sourceType: SourceType) {
  if (type === "Individual") {
    const participantId = gurParticipantId(row, headers);
    if (participantId) return `individual:pid:${normalizeText(participantId)}`;
    const name = gurParticipantName(row, headers);
    const municipality = normalizeMunicipality(cell(row, headers, ["municipality"]));
    return name && municipality ? `individual:name:${normalizeText(name)}|${municipality}` : "";
  }
  const projectId = gurProjectId(row, headers);
  if (projectId) return `association:project:${normalizeText(projectId)}`;
  const projectNameValue = gurProjectName(row, headers, sourceType);
  if (projectNameValue) return `association:project-name:${normalizedUnitName(projectNameValue)}`;
  const slpaName = gurSlpaName(row, headers);
  if (slpaName) return `association:slpa:${normalizedUnitName(slpaName)}`;
  return "";
}

function gurAssociationMatchKeys(unit: Pick<GurDrilldownUnit, "projectId" | "projectName" | "slpaName">) {
  return [
    unit.projectId ? `project:${normalizeText(unit.projectId)}` : "",
    unit.projectName ? `project-name:${normalizedUnitName(unit.projectName)}` : "",
    unit.slpaName ? `slpa:${normalizedUnitName(unit.slpaName)}` : "",
  ].filter(Boolean);
}

function gurIndividualMatchKeys(unit: Pick<GurDrilldownUnit, "participantId" | "participantName" | "municipality">) {
  return [
    unit.participantId ? `pid:${normalizeText(unit.participantId)}` : "",
    unit.participantName && unit.municipality ? `name:${normalizeText(unit.participantName)}|${unit.municipality}` : "",
  ].filter(Boolean);
}

function associationKeysFromRow(row: Record<string, any>, headers: string[], sourceType: SourceType) {
  const projectId = gurProjectId(row, headers);
  const projectNameValue = gurProjectName(row, headers, sourceType);
  const slpaName = gurSlpaName(row, headers);
  return [
    projectId ? `project:${normalizeText(projectId)}` : "",
    projectNameValue ? `project-name:${normalizedUnitName(projectNameValue)}` : "",
    slpaName ? `slpa:${normalizedUnitName(slpaName)}` : "",
  ].filter(Boolean);
}

function individualKeysFromRow(row: Record<string, any>, headers: string[]) {
  const participantId = gurParticipantId(row, headers);
  const participantName = gurParticipantName(row, headers);
  const municipality = normalizeMunicipality(cell(row, headers, ["municipality"]));
  return [
    participantId ? `pid:${normalizeText(participantId)}` : "",
    participantName && municipality ? `name:${normalizeText(participantName)}|${municipality}` : "",
  ].filter(Boolean);
}

function visitNumberFromValue(value = "") {
  const normalized = normalizeText(value);
  if (/\b(1|1st|first)\b/.test(normalized)) return 1;
  if (/\b(2|2nd|second)\b/.test(normalized)) return 2;
  if (/\b(3|3rd|third)\b/.test(normalized)) return 3;
  if (/\b(4|4th|fourth)\b/.test(normalized)) return 4;
  return 0;
}

function visitNumberFromRow(row: Record<string, any>, headers: string[]) {
  const visitValue = exactOrAliasValue(row, headers, "Visit", ["Monitoring Visit", "Visit Count"]);
  return visitNumberFromValue(visitValue);
}

function parseDashboardNumber(value: unknown) {
  const cleaned = String(value ?? "").replace(/[^\d.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDateTimeValue(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getFinancialCell(row: Record<string, any>, headers: string[], label: string, aliases: string[] = []) {
  return exactOrAliasValue(row, headers, label, aliases);
}

function rowTextForRisk(row: Record<string, any>, headers: string[]) {
  return [
    "Livelihood Status",
    "Enterprise Status",
    "Enterprise Status 1",
    "Remarks",
    "Reason",
    "Reason 1",
    "Issues/Concerns 1",
    "Issues/Concerns 2",
    "Issues/Concerns 3",
    "Issues/Concerns 4",
  ].map((label) => getFinancialCell(row, headers, label)).join(" ");
}

const FAILURE_KEYWORDS = /\b(failed|failure|closed|stopped|discontinued|not operating|bankrupt|inactive|dissolved|abandoned|terminated|ceased operation)\b/i;
const RISK_KEYWORDS = /\b(risk|low earning|loss|negative|problem|issue|concern|struggling|delayed|declining|needs assistance|insufficient|unstable)\b/i;

function latestMonitoringRank(row: Record<string, any>, headers: string[]) {
  return {
    visit: visitNumberFromRow(row, headers),
    monitored: normalizeDateTimeValue(getFinancialCell(row, headers, "Date Monitored", ["Monitoring Date", "Date of Monitoring"])),
    updated: normalizeDateTimeValue(getFinancialCell(row, headers, "Updated Date", ["Date Updated", "Updated At", "Last Updated"])),
  };
}

function isBetterMonitoringRow(next: { row: Record<string, any>; headers: string[] }, current?: { row: Record<string, any>; headers: string[] }) {
  if (!current) return true;
  const a = latestMonitoringRank(next.row, next.headers);
  const b = latestMonitoringRank(current.row, current.headers);
  if (a.visit !== b.visit) return a.visit > b.visit;
  if (a.monitored !== b.monitored) return a.monitored > b.monitored;
  return a.updated > b.updated;
}

function monitoringMatchKeys(row: Record<string, any>, headers: string[], sourceType: SourceType) {
  const participantId = exactOrAliasValue(row, headers, "SLP Paricipant ID", ["SLP Participant ID", "Participant ID"]);
  const grantCode = exactOrAliasValue(row, headers, "Grant Code", ["GUR Code"]);
  const projectId = exactOrAliasValue(row, headers, "Project ID", ["SLP Project ID"]);
  const fullName = buildFullName(row, headers) || exactOrAliasValue(row, headers, "Name", ["Participant Name", "Full Name"]);
  const municipality = normalizeMunicipality(cell(row, headers, ["municipality"])) || exactOrAliasValue(row, headers, "Municipality");
  const barangay = normalizeBarangayLabel(row, headers);
  const slpaName = exactOrAliasValue(row, headers, "SLPA Name", ["Association Name", "Organization Name"]);
  const projectLabel = projectName(row, headers, sourceType);
  return [
    participantId ? `participant:${normalizeText(participantId)}` : "",
    grantCode ? `grant:${normalizeText(grantCode)}` : "",
    projectId ? `project:${normalizeText(projectId)}` : "",
    fullName && municipality && barangay ? `person-place:${normalizeText(fullName)}|${municipality}|${normalizeText(barangay)}` : "",
    slpaName && municipality && barangay ? `slpa-place:${normalizedUnitName(slpaName)}|${municipality}|${normalizeText(barangay)}` : "",
    projectLabel && municipality && barangay ? `project-place:${normalizedUnitName(projectLabel)}|${municipality}|${normalizeText(barangay)}` : "",
  ].filter(Boolean);
}

function financialRatingCategory(score: number | null) {
  if (score === null) return "Insufficient Data";
  if (score >= 80) return "Excellent / Success Project";
  if (score >= 60) return "Good / Stable";
  if (score >= 40) return "Fair / Needs Assistance";
  if (score >= 20) return "At Risk / Low Earning";
  return "Critical / Close to Bankruptcy";
}

function buildFinancialRating(financial: Record<string, any>, riskText: string) {
  const netIncome = parseDashboardNumber(financial["Ave. Monthly Net Income/Loss"]);
  const grossProfit = parseDashboardNumber(financial["Ave. Monthly Gross Profit"]);
  const cashAtBank = parseDashboardNumber(financial["Cash at Bank"]);
  const cashOnHand = parseDashboardNumber(financial["Cash on Hand"]);
  const totalSavings = parseDashboardNumber(financial["Total Savings"]);
  const totalScore = parseDashboardNumber(financial["Total Score"]);
  const hasAnyFinancialData = [netIncome, grossProfit, cashAtBank, cashOnHand, totalSavings, totalScore].some((value) => value !== null);
  if (!hasAnyFinancialData) {
    return {
      score: null,
      category: "Insufficient Data",
      explanation: "Missing financial data",
      positiveIndicators: [] as string[],
      riskIndicators: ["Financial fields are blank or not encoded"],
    };
  }
  const savings = Math.max(0, cashAtBank || 0) + Math.max(0, cashOnHand || 0) + Math.max(0, totalSavings || 0);
  const positiveIndicators: string[] = [];
  const riskIndicators: string[] = [];
  let score = 0;
  if (netIncome !== null) {
    if (netIncome > 0) {
      score += 35;
      positiveIndicators.push("Positive net income");
    } else {
      score += netIncome === 0 ? 12 : 0;
      riskIndicators.push(netIncome < 0 ? "Negative net income" : "Zero net income");
    }
  }
  if (grossProfit !== null) {
    if (grossProfit > 0) {
      score += 20;
      positiveIndicators.push("Positive gross profit");
    } else {
      score += grossProfit === 0 ? 7 : 0;
      riskIndicators.push(grossProfit < 0 ? "Negative gross profit" : "Zero gross profit");
    }
  }
  if (savings > 0) {
    score += 20;
    positiveIndicators.push("Has savings or cash balance");
  } else {
    riskIndicators.push("No savings or cash encoded");
  }
  if (totalScore !== null) {
    score += Math.max(0, Math.min(15, totalScore > 15 ? (totalScore / 100) * 15 : totalScore));
    if (totalScore < 40) riskIndicators.push("Low monitoring total score");
  } else {
    const assessmentSignals = ["Financial Stability and Savings", "Market Demand", "Market Supply", "Enterprise Plan"]
      .map((key) => normalizeText(financial[key]))
      .filter(Boolean);
    const positiveAssessments = assessmentSignals.filter((value) => /\b(good|stable|high|yes|available|adequate|excellent|success)\b/.test(value)).length;
    score += Math.min(15, positiveAssessments * 4);
  }
  let penalty = 0;
  if (FAILURE_KEYWORDS.test(riskText)) penalty = 30;
  else if (RISK_KEYWORDS.test(riskText)) penalty = 15;
  if (penalty) {
    score -= penalty;
    riskIndicators.push(`Risk/failure keyword penalty: -${penalty}`);
  }
  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: finalScore,
    category: financialRatingCategory(finalScore),
    explanation: `Score uses net income, gross profit, savings/cash, monitoring score or assessment signals, and a ${penalty}-point risk penalty.`,
    positiveIndicators,
    riskIndicators,
  };
}

function hasAssessmentVisit(row: Record<string, any>, headers: string[]) {
  return Boolean(exactOrAliasValue(row, headers, "Assessment Visit", ["Assessment", "Assessment Date", "Date Assessed"]));
}

function mergeProjectContext(unit: GurDrilldownUnit, projectLookup: Map<string, any>) {
  const keys = unit.unitType === "Association" ? gurAssociationMatchKeys(unit) : [
    ...gurIndividualMatchKeys(unit),
    unit.projectId ? `project:${normalizeText(unit.projectId)}` : "",
  ].filter(Boolean);
  const project = keys.map((key) => projectLookup.get(key)).find(Boolean);
  if (!project) return;
  unit.municipality ||= project.municipality || "";
  unit.barangay ||= project.barangay || "";
  unit.enterpriseType ||= project.enterpriseType || "";
  unit.projectName ||= project.projectName || "";
  unit.slpaName ||= project.slpaName || "";
  unit.sourceFiles.add(project.sourceFile);
}

function buildGurMonitoringAssessmentUnits(sources: ClassifiedSource[]) {
  const projectLookup = new Map<string, any>();
  for (const { row, headers, source } of rowsOf(sources, ["SLPIS_PROJECT_MODULE"])) {
    const context = {
      municipality: normalizeMunicipality(cell(row, headers, ["municipality"])),
      barangay: normalizeBarangayLabel(row, headers),
      enterpriseType: gurEnterpriseType(row, headers) || projectName(row, headers, source.sourceType),
      projectName: gurProjectName(row, headers, source.sourceType),
      slpaName: gurSlpaName(row, headers),
      sourceFile: source.sourceLabel,
    };
    const keys = [
      ...associationKeysFromRow(row, headers, source.sourceType),
      ...individualKeysFromRow(row, headers),
      gurProjectId(row, headers) ? `project:${normalizeText(gurProjectId(row, headers))}` : "",
    ].filter(Boolean);
    keys.forEach((key) => { if (!projectLookup.has(key)) projectLookup.set(key, context); });
  }

  const units = new Map<string, GurDrilldownUnit>();
  const gurRows = rowsOf(sources, ["SLPIS_GUR_MODULE"]);
  const monitoringIndividualRows = rowsOf(sources, ["SLPIS_MONITORING_INDIVIDUAL_MODULE"]);
  const monitoringAssociationRows = rowsOf(sources, ["SLPIS_MONITORING_ASSOCIATION_MODULE"]);
  const orgAssessmentRows = rowsOf(sources, ["SLPIS_ORG_ASSESSMENT_MODULE"]);
  const annualAssessmentRows = rowsOf(sources, ["SLPIS_ANNUAL_ASSESSMENT_MODULE"]);

  for (const { row, headers, source } of gurRows) {
    const unitType = inferGurUnitType(row, headers);
    const key = gurUnitKey(unitType, row, headers, source.sourceType);
    if (!key) continue;
    if (!units.has(key)) {
      const unit: GurDrilldownUnit = {
        unitType,
        key,
        projectId: gurProjectId(row, headers),
        projectName: gurProjectName(row, headers, source.sourceType),
        slpaName: gurSlpaName(row, headers),
        participantId: unitType === "Individual" ? gurParticipantId(row, headers) : "",
        participantName: unitType === "Individual" ? gurParticipantName(row, headers) : "",
        municipality: normalizeMunicipality(cell(row, headers, ["municipality"])),
        barangay: normalizeBarangayLabel(row, headers),
        enterpriseType: gurEnterpriseType(row, headers),
        encodedInGur: true,
        has1stVisit: false,
        has2ndVisit: false,
        has3rdVisit: false,
        has4thVisit: false,
        hasOrgAssessment: false,
        hasAnnualAssessment: false,
        sourceFiles: new Set([source.sourceLabel]),
      };
      mergeProjectContext(unit, projectLookup);
      units.set(key, unit);
    } else {
      const unit = units.get(key)!;
      unit.sourceFiles.add(source.sourceLabel);
      unit.projectId ||= gurProjectId(row, headers);
      unit.projectName ||= gurProjectName(row, headers, source.sourceType);
      unit.slpaName ||= gurSlpaName(row, headers);
      unit.participantId ||= unit.unitType === "Individual" ? gurParticipantId(row, headers) : "";
      unit.participantName ||= unit.unitType === "Individual" ? gurParticipantName(row, headers) : "";
      unit.municipality ||= normalizeMunicipality(cell(row, headers, ["municipality"]));
      unit.barangay ||= normalizeBarangayLabel(row, headers);
      unit.enterpriseType ||= gurEnterpriseType(row, headers);
      mergeProjectContext(unit, projectLookup);
    }
  }

  const byAssociationKey = new Map<string, GurDrilldownUnit[]>();
  const byIndividualKey = new Map<string, GurDrilldownUnit[]>();
  for (const unit of units.values()) {
    if (unit.unitType === "Association") gurAssociationMatchKeys(unit).forEach((key) => {
      if (!byAssociationKey.has(key)) byAssociationKey.set(key, []);
      byAssociationKey.get(key)!.push(unit);
    });
    else gurIndividualMatchKeys(unit).forEach((key) => {
      if (!byIndividualKey.has(key)) byIndividualKey.set(key, []);
      byIndividualKey.get(key)!.push(unit);
    });
  }

  const markVisit = (unit: GurDrilldownUnit, visit: number, sourceLabel: string) => {
    if (visit === 1) unit.has1stVisit = true;
    if (visit === 2) unit.has2ndVisit = true;
    if (visit === 3) unit.has3rdVisit = true;
    if (visit === 4) unit.has4thVisit = true;
    unit.sourceFiles.add(sourceLabel);
  };
  for (const { row, headers, source } of monitoringIndividualRows) {
    const visit = visitNumberFromRow(row, headers);
    if (!visit) continue;
    const matched = individualKeysFromRow(row, headers).flatMap((key) => byIndividualKey.get(key) || []);
    matched.forEach((unit) => markVisit(unit, visit, source.sourceLabel));
  }
  for (const { row, headers, source } of monitoringAssociationRows) {
    const visit = visitNumberFromRow(row, headers);
    if (!visit) continue;
    const matched = associationKeysFromRow(row, headers, source.sourceType).flatMap((key) => byAssociationKey.get(key) || []);
    matched.forEach((unit) => markVisit(unit, visit, source.sourceLabel));
  }
  for (const { row, headers, source } of orgAssessmentRows) {
    const matched = associationKeysFromRow(row, headers, source.sourceType).flatMap((key) => byAssociationKey.get(key) || []);
    matched.forEach((unit) => {
      unit.hasOrgAssessment = true;
      unit.sourceFiles.add(source.sourceLabel);
    });
  }
  for (const { row, headers, source } of annualAssessmentRows) {
    const associationMatches = associationKeysFromRow(row, headers, source.sourceType).flatMap((key) => byAssociationKey.get(key) || []);
    const individualMatches = individualKeysFromRow(row, headers).flatMap((key) => byIndividualKey.get(key) || []);
    const matched = Array.from(new Set([...associationMatches, ...individualMatches]));
    if (!matched.length && !hasAssessmentVisit(row, headers)) continue;
    matched.forEach((unit) => {
      unit.hasAnnualAssessment = true;
      unit.sourceFiles.add(source.sourceLabel);
    });
  }

  return {
    units: Array.from(units.values()),
    sourceStatus: {
      gurRows: gurRows.length,
      monitoringRows: monitoringIndividualRows.length + monitoringAssociationRows.length,
      assessmentRows: orgAssessmentRows.length + annualAssessmentRows.length,
      gurFiles: Array.from(new Set(gurRows.map(({ source }) => source.sourceLabel))),
      monitoringFiles: Array.from(new Set([...monitoringIndividualRows, ...monitoringAssociationRows].map(({ source }) => source.sourceLabel))),
      assessmentFiles: Array.from(new Set([...orgAssessmentRows, ...annualAssessmentRows].map(({ source }) => source.sourceLabel))),
    },
  };
}

function trainingDate(row: Record<string, any>, headers: string[]) {
  return getCellByHeaderAliases(row, headers, ["Training Date", "Date of Training", "Date Conducted", "Conducted Date"]);
}

function sourceDiagnostics(sources: ClassifiedSource[]) {
  const grouped = new Map<SourceType, ClassifiedSource[]>();
  for (const source of sources) {
    if (!grouped.has(source.sourceType)) grouped.set(source.sourceType, []);
    grouped.get(source.sourceType)!.push(source);
  }
  return Array.from(grouped.entries()).map(([sourceType, items]) => ({
    sourceType,
    displayName: sourceDisplayName(sourceType),
    fileCount: new Set(items.map((source) => source.fileName || source.file_name || source.sourceLabel)).size,
    totalRows: items.reduce((sum, source) => sum + (source.rows?.length || 0), 0),
    detectedHeaders: Array.from(new Set(items.flatMap((source) => normalizedHeaders(source.headers || []).map((header) => header.canonical)).filter((header) => header !== "unknown"))),
    projectNameColumn: sourceType === "SLPIS_PROJECT_MODULE"
      ? "Name"
      : sourceType === "SLPIS_GUR_MODULE"
        ? "Project Name"
        : "",
    projectIdColumn: ["SLPIS_PROJECT_MODULE", "SLPIS_GUR_MODULE"].includes(sourceType) ? "Project ID" : "",
    municipalityColumn: ["SLPIS_PROJECT_MODULE", "SLPIS_GUR_MODULE"].includes(sourceType) ? "Municipality" : "",
    participantIdColumn: sourceType === "SLPIS_PROJECT_MODULE" ? "SLP Participant ID" : "",
    grantCodeColumn: sourceType === "SLPIS_GUR_MODULE" ? "Grant Code" : "",
    enterpriseCategoryColumn: sourceType === "SLPIS_PROJECT_MODULE" ? "Enterprise Type" : "",
    classificationConfidence: Math.round(items.reduce((sum, source) => sum + source.confidence, 0) / Math.max(1, items.length)),
    lastIndexed: items.map((source) => source.updated_at || source.created_at || "").sort().at(-1) || "",
    usedBy: items[0]?.sourceType === "UNKNOWN" ? ["Admin upload review"] : [],
  }));
}

export function buildUnifiedDashboardAnalytics(inputSources: SourceInput[]) {
  const profile = /^true|1|yes$/i.test(String(process.env.PROFILE_DASHBOARD || ""));
  const mark = (label: string) => { if (profile) console.time(label); };
  const done = (label: string) => { if (profile) console.timeEnd(label); };
  mark("dashboard:classify");
  const sources = classifySources(inputSources);
  const allParsedDashboardRows = sources.flatMap((source) =>
    (source.rows || []).map((row) => ({
      row,
      headers: source.headers || [],
      source,
    })),
  );
  done("dashboard:classify");
  const sourceTrace = (types: SourceType[]) => Array.from(new Set(sources.filter((source) => types.includes(source.sourceType)).map((source) => source.sourceLabel)));
  const monitoringCoverage = buildMonitoringCoverage(sources);
  monitoringCoverage.debug.availableFiles = sources.map((source) => {
    const accepted = isMonitoringCoverageSource(source.sourceType);
    return {
      fileName: source.fileName || source.file_name || source.sourceLabel,
      detectedModuleType: monitoringDebugModuleType(source.sourceType),
      rowCount: source.rows?.length || 0,
      headersDetected: source.headers || [],
      accepted,
      rejectedReason: accepted ? "" : "Not a monitoring or assessment coverage module",
    };
  });
  monitoringCoverage.debug.apiFilesLoadedCount = sources.length;
  monitoringCoverage.debug.parsedFilesCount = sources.filter((source) => (source.rows || []).length > 0).length;
  monitoringCoverage.debug.parsedRowsCount = allParsedDashboardRows.length;
  if (!monitoringCoverage.debug.filesScanned) {
    console.warn("Monitoring files are not reaching the dashboard parser. Check upload registry or parsedFiles source.", monitoringCoverage.debug.availableFiles);
  }
  const notes: string[] = [];
  const hasSource = (type: SourceType) => sources.some((source) => source.sourceType === type && (source.rows || []).length);
  const require = (type: SourceType, note: string) => { if (!hasSource(type)) notes.push(note); };
  require("SLPIS_PERSONAL_MODULE", "No SLPIS Personal Module uploaded yet.");
  require("SLPIS_PROJECT_MODULE", "No SLPIS Project Module uploaded yet.");
  if (!hasSource("SLPIS_GUR_MODULE")) notes.push("No SLPIS GUR Module uploaded yet.");
  if (!hasSource("SLPIS_MONITORING_INDIVIDUAL_MODULE") && !hasSource("SLPIS_MONITORING_ASSOCIATION_MODULE")) notes.push("No Monitoring Individual or Association data found.");
  const personalRows = rowsOfClassifiedOrDetected(sources, ["SLPIS_PERSONAL_MODULE", "SLP_DPT_AURORA_DATABASE"], isDetectedPersonalSource);
  const projectRows = rowsOfClassifiedOrDetected(sources, ["SLPIS_PROJECT_MODULE"], isDetectedProjectSource);
  const monitoringIndividualRows = rowsOfClassifiedOrDetected(sources, ["SLPIS_MONITORING_INDIVIDUAL_MODULE"], isDetectedMdMonitoringIndividualSource);
  const monitoringAssociationRows = rowsOfClassifiedOrDetected(sources, ["SLPIS_MONITORING_ASSOCIATION_MODULE"], isDetectedMdMonitoringAssociationSource);

  mark("dashboard:participants");
  const participants = new Map<string, { municipality: AuroraMunicipality | ""; barangay: string; source: string; detail: Record<string, string | number | boolean | undefined> }>();
  for (const { row, headers, source } of personalRows) {
    const key = participantKey(row, headers);
    if (!key) continue;
    participants.set(key, {
      municipality: normalizeMunicipality(cell(row, headers, ["municipality"])),
      barangay: normalizeBarangayLabel(row, headers),
      source: source.sourceLabel,
      detail: drilldownBaseRecord(row, headers, source),
    });
  }
  done("dashboard:participants");

  mark("dashboard:projects");
  const projectOccurrence = new Map<string, number>();
  for (const { row, headers, source } of projectRows) {
    const key = projectKey(row, headers, source.sourceType);
    if (key) inc(projectOccurrence, key);
  }
  const projects = new Map<string, { municipality: AuroraMunicipality | ""; barangay: string; name: string; keys: string[]; source: string; association: boolean; participantKey: string; detail: Record<string, string | number | boolean | undefined> }>();
  const projectByAnyKey = new Map<string, { municipality: AuroraMunicipality | ""; barangay: string; name: string; keys: string[]; source: string }>();
  const topOverall = new Map<string, number>();
  const topByMunicipality = new Map<string, Map<string, number>>();
  const seenImplementedProjects = new Set<string>();
  const sampleProjectNames: string[] = [];
  for (const { row, headers, source } of projectRows) {
    const key = projectKey(row, headers, source.sourceType);
    if (!key || projects.has(key)) continue;
    const municipality = normalizeMunicipality(cell(row, headers, ["municipality"]));
    const barangay = normalizeBarangayLabel(row, headers);
    const name = projectName(row, headers, source.sourceType);
    if (sampleProjectNames.length < 10 && name && name !== "Unspecified Project Name") sampleProjectNames.push(name);
    const associationIndicators = normalizeText([cell(row, headers, ["enterprise_type"]), getCellByHeaderAliases(row, headers, ["name"])].join(" "));
    const association = (projectOccurrence.get(key) || 0) > 1 || /\b(slpa|association|group|organization)\b/.test(associationIndicators);
    const keys = projectMatchKeys(row, headers, source.sourceType);
    const project = { municipality, barangay, name, keys, source: source.sourceLabel, association, participantKey: participantKey(row, headers), detail: drilldownBaseRecord(row, headers, source) };
    projects.set(key, project);
    keys.forEach((matchKey) => {
      if (!projectByAnyKey.has(matchKey)) projectByAnyKey.set(matchKey, project);
    });
    const dedupeKey = uniqueProjectDedupeKey(row, headers);
    if (!seenImplementedProjects.has(dedupeKey)) {
      seenImplementedProjects.add(dedupeKey);
      inc(topOverall, name);
      if (municipality) {
        if (!topByMunicipality.has(municipality)) topByMunicipality.set(municipality, new Map());
        inc(topByMunicipality.get(municipality)!, name);
      }
    }
  }
  done("dashboard:projects");

  mark("dashboard:gur-training");
  const gurKeys = new Set<string>();
  for (const { row, headers, source } of rowsOf(sources, ["SLPIS_GUR_MODULE"])) {
    projectMatchKeys(row, headers, source.sourceType).forEach((key) => gurKeys.add(key));
  }

  const trainingRows = rowsOf(sources, ["SLPIS_TRAINING_MODULE"]);
  const trainingTitleColumnsDetected = Array.from(new Set(trainingRows.flatMap(({ headers }) => headers.filter(isTrainingTitleHeader))));
  const rawTrainingTitles = new Map<string, { rawTitle: string; normalizedCategory: string; count: number; sourceRows: Array<string | number>; municipalities: Set<string> }>();
  const unmappedTrainingTitles = new Map<string, { rawTitle: string; count: number; sourceRows: Array<string | number>; municipalities: Set<string> }>();
  const trainingKeys = new Set<string>();
  const trainingDetailByKey = new Map<string, { title: string; date: string; source: string }>();
  const trainingTitleParticipants = new Map<string, Set<string>>();
  const trainingTitleSourceRows = new Map<string, Set<string | number>>();
  const trainingTitleMunicipalities = new Map<string, Set<string>>();
  const trainingTitleRawMerged = new Map<string, Set<string>>();
  for (const title of OFFICIAL_TRAINING_TITLES) {
    trainingTitleParticipants.set(title, new Set());
    trainingTitleSourceRows.set(title, new Set());
    trainingTitleMunicipalities.set(title, new Set());
    trainingTitleRawMerged.set(title, new Set());
  }
  for (const { row, headers, source } of trainingRows) {
    const id = cell(row, headers, ["participant_id"]);
    const fullName = buildFullName(row, headers);
    const municipality = normalizeMunicipality(cell(row, headers, ["municipality"]));
    const participantKeys = [id, fullName && municipality ? `${fullName}|${municipality}` : ""].filter(Boolean).map(normalizeText);
    participantKeys.forEach((key) => trainingKeys.add(key));
    const participantDedupe = participantKeys[0] || normalizeText(JSON.stringify(row));
    const rowCategories = new Set<string>();
    const rowTitles = extractTrainingTitleValues(row, headers);
    participantKeys.forEach((key) => {
      if (!trainingDetailByKey.has(key)) trainingDetailByKey.set(key, { title: rowTitles.join("; "), date: trainingDate(row, headers), source: source.sourceLabel });
    });
    for (const rawTitle of rowTitles) {
      const normalizedCategory = normalizeTrainingTitle(rawTitle);
      const rawKey = normalizeText(rawTitle);
      if (normalizedCategory) {
        rowCategories.add(normalizedCategory);
        if (!rawTrainingTitles.has(rawKey)) rawTrainingTitles.set(rawKey, { rawTitle, normalizedCategory, count: 0, sourceRows: [], municipalities: new Set() });
        const rawItem = rawTrainingTitles.get(rawKey)!;
        rawItem.count += 1;
        rawItem.sourceRows.push(row.__rowNumber || row.__row || "");
        if (municipality) rawItem.municipalities.add(municipality);
        trainingTitleRawMerged.get(normalizedCategory)!.add(rawTitle);
      } else {
        if (!unmappedTrainingTitles.has(rawKey)) unmappedTrainingTitles.set(rawKey, { rawTitle, count: 0, sourceRows: [], municipalities: new Set() });
        const unmapped = unmappedTrainingTitles.get(rawKey)!;
        unmapped.count += 1;
        unmapped.sourceRows.push(row.__rowNumber || row.__row || "");
        if (municipality) unmapped.municipalities.add(municipality);
      }
    }
    for (const category of rowCategories) {
      trainingTitleParticipants.get(category)!.add(participantDedupe);
      trainingTitleSourceRows.get(category)!.add(row.__rowNumber || row.__row || participantDedupe);
      if (municipality) trainingTitleMunicipalities.get(category)!.add(municipality);
    }
  }
  done("dashboard:gur-training");

  mark("dashboard:gur-monitoring-assessment-drilldown");
  const gurMonitoringAssessment = buildGurMonitoringAssessmentUnits(sources);
  done("dashboard:gur-monitoring-assessment-drilldown");

  mark("dashboard:status");
  const statusByProject = new Map<string, { status: "operational" | "closed" | "unknown"; municipality: AuroraMunicipality | ""; barangay: string; name: string; source: string; detail: Record<string, string | number | boolean | undefined> }>();
  let matchedMonitoringRows = 0;
  let unmatchedMonitoringRows = 0;
  for (const { row, headers, source } of [...monitoringIndividualRows, ...monitoringAssociationRows]) {
    const keys = projectMatchKeys(row, headers, source.sourceType);
    const matchedProject = keys.map((key) => projectByAnyKey.get(key)).find(Boolean);
    if (matchedProject) matchedMonitoringRows += 1;
    else unmatchedMonitoringRows += 1;
    const key = keys[0] || normalizeText([buildFullName(row, headers), projectName(row, headers, source.sourceType), cell(row, headers, ["municipality"])].join("|"));
    if (!key) continue;
    const statusValue = exactOrAliasValue(row, headers, "Enterprise Status", ["Enterprise Status 1", "Livelihood Status", "Project Status", "Operational Status", "Monitoring Status", "Status GUR", "Status", "Remarks"]);
    const status = normalizeEnterpriseStatus(statusValue);
    const name = matchedProject?.name || projectName(row, headers, source.sourceType);
    const municipality = matchedProject?.municipality || normalizeMunicipality(cell(row, headers, ["municipality"]));
    const barangay = matchedProject?.barangay || normalizeBarangayLabel(row, headers);
    const existing = statusByProject.get(key);
    if (!existing || existing.status === "unknown" || (existing.status === "operational" && status === "closed")) {
      const isAssociation = source.sourceType === "SLPIS_MONITORING_ASSOCIATION_MODULE";
      statusByProject.set(key, {
        status,
        municipality,
        barangay,
        name,
        source: source.sourceLabel,
        detail: {
          ...drilldownBaseRecord(row, headers, source),
          "Monitoring Unit Name": matchedProject?.name || projectName(row, headers, source.sourceType),
          Type: isAssociation ? "Association" : "Individual",
          Municipality: municipality,
          Barangay: barangay,
          "Enterprise Type": name,
          Status: status === "unknown" ? "Pending/Unknown" : status.charAt(0).toUpperCase() + status.slice(1),
          __status: status,
        },
      });
    }
  }
  type MonitoringMatchRow = { row: Record<string, any>; headers: string[]; source: ClassifiedSource; moduleKind: "Individual" | "Association" };
  const latestIndividualMonitoringByKey = new Map<string, MonitoringMatchRow>();
  const latestAssociationMonitoringByKey = new Map<string, MonitoringMatchRow>();
  for (const item of monitoringIndividualRows.map((row) => ({ ...row, moduleKind: "Individual" as const }))) {
    for (const key of monitoringMatchKeys(item.row, item.headers, item.source.sourceType)) {
      const current = latestIndividualMonitoringByKey.get(key);
      if (isBetterMonitoringRow(item, current)) latestIndividualMonitoringByKey.set(key, item);
    }
  }
  for (const item of monitoringAssociationRows.map((row) => ({ ...row, moduleKind: "Association" as const }))) {
    for (const key of monitoringMatchKeys(item.row, item.headers, item.source.sourceType)) {
      const current = latestAssociationMonitoringByKey.get(key);
      if (isBetterMonitoringRow(item, current)) latestAssociationMonitoringByKey.set(key, item);
    }
  }
  const sustainabilitySourceCounts = {
    slpisPersonalModule: personalRows.length,
    slpisProjectModule: projectRows.length,
    mdMonitoringIndividualModule: monitoringIndividualRows.length,
    mdMonitoringAssociationModule: monitoringAssociationRows.length,
    operationalBaseRecords: Array.from(statusByProject.values()).filter((item) => item.status === "operational").length,
  };
  const sustainabilityColumnMapping = {
    financialColumns: [
      "Ave. Monthly Gross Sales",
      "Ave. Monthly Cost of Sales",
      "Ave. Monthly Gross Profit",
      "Ave. Operating Expenses",
      "Ave. Monthly Net Income/Loss",
      "Cash at Bank",
      "Cash on Hand",
      "Total Savings",
      "Financial Stability and Savings",
      "Market Demand",
      "Market Supply",
      "Enterprise Plan",
      "Total Score",
      "Livelihood Status",
      "Enterprise Status",
      "Enterprise Status 1",
      "Remarks",
      "Reason",
      "Reason 1",
      "Issues/Concerns 1",
      "Issues/Concerns 2",
      "Issues/Concerns 3",
      "Issues/Concerns 4",
    ],
    latestMonitoringOrder: ["4th Visit", "3rd Visit", "2nd Visit", "1st Visit", "Date Monitored", "Updated Date"],
    individualMatchOrder: ["SLP Paricipant ID or SLP Participant ID", "Grant Code", "Full name + municipality + barangay"],
    associationMatchOrder: ["Grant Code", "Project ID", "SLPA Name or Project Name + municipality + barangay"],
  };
  const operationalRows = Array.from(statusByProject.values()).filter((item) => item.status === "operational");
  let matchedIndividualCount = 0;
  let matchedAssociationCount = 0;
  const sustainabilityRecords = operationalRows
    .filter((item) => item.status === "operational")
    .map((item, index) => {
      const detail = item.detail;
      const type = String(detail.Type || "").toLowerCase().includes("association") ? "Association" : "Individual";
      const recordKeys = [
        detail["SLP Paricipant ID"] ? `participant:${normalizeText(String(detail["SLP Paricipant ID"]))}` : "",
        detail["Project ID"] ? `project:${normalizeText(String(detail["Project ID"]))}` : "",
        detail["Grant Code"] ? `grant:${normalizeText(String(detail["Grant Code"]))}` : "",
        detail.Name && detail.Municipality && detail.Barangay ? `person-place:${normalizeText(String(detail.Name))}|${detail.Municipality}|${normalizeText(String(detail.Barangay))}` : "",
        detail["SLPA Name"] && detail.Municipality && detail.Barangay ? `slpa-place:${normalizedUnitName(String(detail["SLPA Name"]))}|${detail.Municipality}|${normalizeText(String(detail.Barangay))}` : "",
        detail["Project Name"] && detail.Municipality && detail.Barangay ? `project-place:${normalizedUnitName(String(detail["Project Name"]))}|${detail.Municipality}|${normalizeText(String(detail.Barangay))}` : "",
        detail["Monitoring Unit Name"] && detail.Municipality && detail.Barangay ? `project-place:${normalizedUnitName(String(detail["Monitoring Unit Name"]))}|${detail.Municipality}|${normalizeText(String(detail.Barangay))}` : "",
      ].filter(Boolean);
      const matchMap = type === "Association" ? latestAssociationMonitoringByKey : latestIndividualMonitoringByKey;
      const match = recordKeys.map((key) => matchMap.get(key)).find(Boolean);
      if (match?.moduleKind === "Individual") matchedIndividualCount += 1;
      if (match?.moduleKind === "Association") matchedAssociationCount += 1;
      const monitoringRow = match?.row;
      const monitoringHeaders = match?.headers || [];
      const financial = monitoringRow ? Object.fromEntries(sustainabilityColumnMapping.financialColumns.map((label) => [label, getFinancialCell(monitoringRow, monitoringHeaders, label)])) : {};
      const riskText = monitoringRow ? rowTextForRisk(monitoringRow, monitoringHeaders) : "";
      const netIncome = parseDashboardNumber(financial["Ave. Monthly Net Income/Loss"]);
      const grossProfit = parseDashboardNumber(financial["Ave. Monthly Gross Profit"]);
      const savingsStabilityText = normalizeText(financial["Financial Stability and Savings"]);
      const savings = (parseDashboardNumber(financial["Cash at Bank"]) || 0) + (parseDashboardNumber(financial["Cash on Hand"]) || 0) + (parseDashboardNumber(financial["Total Savings"]) || 0);
      const totalScore = parseDashboardNumber(financial["Total Score"]);
      const rating = buildFinancialRating(financial, riskText);
      const hasFailure = FAILURE_KEYWORDS.test(riskText);
      const hasPositiveIncome = (netIncome !== null && netIncome > 0) || (grossProfit !== null && grossProfit > 0);
      const hasRisk = RISK_KEYWORDS.test(riskText) || (totalScore !== null && totalScore < 40) || !hasPositiveIncome;
      const sustainabilityStatus = !match
        ? "No Monitoring Data"
        : hasFailure
        ? "Possible Business Failure"
        : hasPositiveIncome && !hasRisk
        ? "Stable Income"
        : "At Risk";
      const name = type === "Association"
        ? String(detail["SLPA Name"] || detail["Project Name"] || detail["Monitoring Unit Name"] || "Not encoded")
        : String(detail.Name || detail["Monitoring Unit Name"] || "Not encoded");
      const issues = ["Issues/Concerns 1", "Issues/Concerns 2", "Issues/Concerns 3", "Issues/Concerns 4"].map((key) => financial[key]).filter(Boolean).join("; ");
      const output = {
        id: `sustainability-${index + 1}`,
        Name: name,
        "SLPA Name": String(detail["SLPA Name"] || ""),
        Type: type,
        Municipality: String(detail.Municipality || ""),
        Barangay: String(detail.Barangay || ""),
        "Project ID": String(detail["Project ID"] || ""),
        "Grant Code": match ? getFinancialCell(match.row, match.headers, "Grant Code", ["GUR Code"]) : String(detail["Grant Code"] || ""),
        "SLP Paricipant ID": String(detail["SLP Paricipant ID"] || ""),
        "Enterprise Type": String(detail["Enterprise Type"] || detail["Project Name"] || detail["Monitoring Unit Name"] || ""),
        "Latest Visit": match ? `${latestMonitoringRank(match.row, match.headers).visit || "Not encoded"}` : "No monitoring data found",
        "Date Monitored": match ? getFinancialCell(match.row, match.headers, "Date Monitored", ["Monitoring Date", "Date of Monitoring"]) : "",
        "Ave. Monthly Gross Sales": financial["Ave. Monthly Gross Sales"] || "",
        "Ave. Monthly Cost of Sales": financial["Ave. Monthly Cost of Sales"] || "",
        "Ave. Monthly Gross Profit": financial["Ave. Monthly Gross Profit"] || "",
        "Ave. Operating Expenses": financial["Ave. Operating Expenses"] || "",
        "Ave. Monthly Net Income/Loss": financial["Ave. Monthly Net Income/Loss"] || "",
        "Cash at Bank": financial["Cash at Bank"] || "",
        "Cash on Hand": financial["Cash on Hand"] || "",
        "Total Savings": financial["Total Savings"] || "",
        "Total Score": financial["Total Score"] || "",
        "Livelihood Status": financial["Livelihood Status"] || "",
        "Enterprise Status": financial["Enterprise Status"] || "",
        "Enterprise Status 1": financial["Enterprise Status 1"] || "",
        Remarks: financial.Remarks || "",
        Reason: financial.Reason || "",
        "Reason 1": financial["Reason 1"] || "",
        "Issues/Concerns": issues,
        "Sustainability Status": sustainabilityStatus,
        "Financial Rating Score": rating.score,
        "Financial Rating Category": rating.category,
        "Rating Explanation": rating.explanation,
        "Positive Indicators": rating.positiveIndicators.join("; "),
        "Risk Indicators": rating.riskIndicators.join("; "),
        "With Savings / Bank Account": savings > 0 || /\b(stable|positive|good|yes|with|adequate|available)\b/.test(savingsStabilityText) ? "Yes" : "No",
        "Source Module": match ? `MDMonitoring ${match.moduleKind}` : String(detail["Source Module"] || ""),
        "Source File": match?.source.sourceLabel || String(detail["Source File"] || ""),
        __matchFound: Boolean(match),
        __scoreValue: rating.score,
        __netIncome: netIncome,
        __grossProfit: grossProfit,
        __savings: savings,
      };
      Object.assign(detail, {
        "Financial Rating Score": output["Financial Rating Score"] ?? "",
        "Financial Rating Category": output["Financial Rating Category"],
        "Sustainability Status": output["Sustainability Status"],
        __sustainabilityRecordId: output.id,
      });
      return output;
    });
  const sustainabilitySummary = {
    operationalTracked: sustainabilityRecords.length,
    stableIncome: sustainabilityRecords.filter((row) => row["Sustainability Status"] === "Stable Income").length,
    withSavingsBankAccount: sustainabilityRecords.filter((row) => row["With Savings / Bank Account"] === "Yes").length,
    atRisk: sustainabilityRecords.filter((row) => row["Sustainability Status"] === "At Risk").length,
    possibleBusinessFailure: sustainabilityRecords.filter((row) => row["Sustainability Status"] === "Possible Business Failure").length,
    noMonitoringData: sustainabilityRecords.filter((row) => row["Sustainability Status"] === "No Monitoring Data").length,
  };
  const sustainabilityDebugSources = {
    slpisPersonalRows: personalRows.length,
    slpisProjectRows: projectRows.length,
    mdMonitoringIndividualRows: monitoringIndividualRows.length,
    mdMonitoringAssociationRows: monitoringAssociationRows.length,
    operationalSourceRows: operationalRows.length,
  };
  const sustainabilityByMunicipality = AURORA_MUNICIPALITIES.map((municipality) => {
    const rows = sustainabilityRecords.filter((row) => row.Municipality === municipality);
    const scored = rows.filter((row) => row.__scoreValue !== null) as typeof rows;
    return {
      municipality,
      operationalTracked: rows.length,
      stableIncome: rows.filter((row) => row["Sustainability Status"] === "Stable Income").length,
      atRisk: rows.filter((row) => row["Sustainability Status"] === "At Risk").length,
      possibleBusinessFailure: rows.filter((row) => row["Sustainability Status"] === "Possible Business Failure").length,
      noMonitoringData: rows.filter((row) => row["Sustainability Status"] === "No Monitoring Data").length,
      withSavingsBankAccount: rows.filter((row) => row["With Savings / Bank Account"] === "Yes").length,
      averageFinancialRating: scored.length ? Math.round(scored.reduce((sum, row) => sum + Number(row.__scoreValue || 0), 0) / scored.length) : null,
      averageNetIncome: rows.filter((row) => row.__netIncome !== null).length ? Math.round(rows.reduce((sum, row) => sum + Number(row.__netIncome || 0), 0) / rows.filter((row) => row.__netIncome !== null).length) : null,
      totalSavings: Math.round(rows.reduce((sum, row) => sum + Number(row.__savings || 0), 0)),
    };
  });
  const municipalityFinancialRanking = AURORA_MUNICIPALITIES.map((municipality) => {
    const rows = sustainabilityRecords.filter((row) => row.Municipality === municipality);
    const scored = rows.filter((row) => row.__scoreValue !== null);
    return {
      municipality,
      topBestFinancialRating: [...scored].sort((a, b) => Number(b.__scoreValue) - Number(a.__scoreValue)).slice(0, 5),
      bottomLowEarningNeedsAssistance: [...scored].sort((a, b) => Number(a.__scoreValue) - Number(b.__scoreValue)).slice(0, 5),
      criticalCloseToBankruptcy: scored.filter((row) => row["Financial Rating Category"] === "Critical / Close to Bankruptcy"),
    };
  });
  console.log("SUSTAINABILITY_SOURCE_COUNTS", sustainabilitySourceCounts);
  console.log("SUSTAINABILITY_COLUMN_MAPPING", sustainabilityColumnMapping);
  console.log("SUSTAINABILITY_RESULT_COUNTS", sustainabilitySummary);
  console.log("FINANCIAL_RATING_SCORE_SAMPLE", sustainabilityRecords.slice(0, 5).map((row) => ({ name: row.Name, score: row["Financial Rating Score"], category: row["Financial Rating Category"], status: row["Sustainability Status"] })));
  console.log("MUNICIPALITY_FINANCIAL_RANKING_COUNTS", municipalityFinancialRanking.map((row) => ({ municipality: row.municipality, best: row.topBestFinancialRating.length, bottom: row.bottomLowEarningNeedsAssistance.length, critical: row.criticalCloseToBankruptcy.length })));
  console.log("SUSTAINABILITY_DEBUG_SOURCES", sustainabilityDebugSources);
  console.log("SUSTAINABILITY_DEBUG_SAMPLE_OPERATIONAL", operationalRows.slice(0, 3));
  console.log("SUSTAINABILITY_DEBUG_SAMPLE_MD_INDIVIDUAL", monitoringIndividualRows.slice(0, 3).map((item) => item.row));
  console.log("SUSTAINABILITY_DEBUG_SAMPLE_MD_ASSOCIATION", monitoringAssociationRows.slice(0, 3).map((item) => item.row));
  console.log("SUSTAINABILITY_DEBUG_MATCHING", {
    operationalCount: operationalRows.length,
    matchedIndividualCount,
    matchedAssociationCount,
    noMonitoringCount: sustainabilitySummary.noMonitoringData,
  });
  console.log("SUSTAINABILITY_DEBUG_RESULTS", {
    operationalTracked: sustainabilitySummary.operationalTracked,
    stableIncome: sustainabilitySummary.stableIncome,
    withSavingsBank: sustainabilitySummary.withSavingsBankAccount,
    atRisk: sustainabilitySummary.atRisk,
    possibleBusinessFailure: sustainabilitySummary.possibleBusinessFailure,
    noMonitoringData: sustainabilitySummary.noMonitoringData,
  });
  done("dashboard:status");

  mark("dashboard:municipalities");
  const municipalityBreakdown = AURORA_MUNICIPALITIES.map((municipality) => {
    const participantCount = Array.from(participants.values()).filter((item) => item.municipality === municipality).length;
    const projectList = Array.from(projects.values()).filter((item) => item.municipality === municipality);
    const statusList = Array.from(statusByProject.values()).filter((item) => item.municipality === municipality);
    const withGur = projectList.filter((project) => project.keys.some((key) => gurKeys.has(key))).length;
    const withoutGur = projectList.length - withGur;
    const withTraining = projectList.filter((project) => {
      const keys = [project.participantKey, project.participantKey.replace(/^pid:/, "")].filter(Boolean).map(normalizeText);
      return keys.some((key) => trainingKeys.has(key));
    }).length;
    const withoutTraining = projectList.length - withTraining;
    const top = topRows(topByMunicipality.get(municipality) || new Map(), 1)[0];
    const opCounts = new Map<string, number>();
    const closedCounts = new Map<string, number>();
    statusList.forEach((item) => {
      if (item.status === "operational") inc(opCounts, item.name);
      else if (item.status === "closed") inc(closedCounts, item.name);
    });
    const topOperational = topRows(opCounts, 1)[0];
    const topClosed = topRows(closedCounts, 1)[0];
    const operational = statusList.filter((item) => item.status === "operational").length;
    const closed = statusList.filter((item) => item.status === "closed").length;
    const unknown = statusList.length - operational - closed;
    const sourceFilesUsed = Array.from(new Set([
      ...sourceTrace(["SLPIS_PERSONAL_MODULE", "SLPIS_PROJECT_MODULE"]),
      ...sourceTrace(["SLPIS_MONITORING_INDIVIDUAL_MODULE", "SLPIS_MONITORING_ASSOCIATION_MODULE"]),
      ...sourceTrace(["SLPIS_GUR_MODULE", "SLPIS_TRAINING_MODULE"]),
    ])).slice(0, 12);
    return {
      municipality,
      totalParticipants: participantCount,
      associations: projectList.filter((item) => item.association).length,
      individualEnterprises: projectList.filter((item) => !item.association).length,
      operational,
      closed,
      unknown,
      topEnterprise: top?.[0] || "No data yet",
      topEnterpriseCount: top?.[1] || 0,
      mostOperationalEnterprise: topOperational?.[0] || "No data yet",
      mostOperationalEnterpriseCount: Number(topOperational?.[1] || 0),
      mostClosedEnterprise: topClosed?.[0] || "No data yet",
      mostClosedEnterpriseCount: Number(topClosed?.[1] || 0),
      withGrantUtilizationReport: withGur,
      withoutGrantUtilizationReport: withoutGur,
      gurRate: projectList.length ? Math.round((withGur / projectList.length) * 100) : 0,
      withTraining,
      withoutTraining,
      sourceFilesUsed,
    };
  });
  done("dashboard:municipalities");

  mark("dashboard:municipality-drilldown-records");
  const municipalityDrilldownRecords: Array<Record<string, string | number | boolean>> = [];
  const pushRecord = (category: string, record: Record<string, string | number | boolean | undefined>) => {
    municipalityDrilldownRecords.push(Object.fromEntries(Object.entries({ Category: category, ...record }).map(([key, value]) => [key, value ?? ""])));
  };

  pushRecord("__gurSourceStatus", {
    "GUR Rows Loaded": gurMonitoringAssessment.sourceStatus.gurRows,
    "Monitoring Rows Loaded": gurMonitoringAssessment.sourceStatus.monitoringRows,
    "Assessment Rows Loaded": gurMonitoringAssessment.sourceStatus.assessmentRows,
    "GUR Source Files": gurMonitoringAssessment.sourceStatus.gurFiles.join("; "),
    "Monitoring Source Files": gurMonitoringAssessment.sourceStatus.monitoringFiles.join("; "),
    "Assessment Source Files": gurMonitoringAssessment.sourceStatus.assessmentFiles.join("; "),
  });

  for (const unit of gurMonitoringAssessment.units) {
    if (!unit.municipality) continue;
    pushRecord("gurMonitoringAssessment", {
      "Unit Type": unit.unitType,
      "Participant Name / SLPA Name / Project Name": unit.unitType === "Individual"
        ? unit.participantName || "Not Found"
        : unit.slpaName || unit.projectName || "Not Found",
      "SLP Paricipant ID": unit.unitType === "Individual" ? unit.participantId : "Not Applicable",
      "Project ID": unit.projectId,
      "Project Name": unit.projectName,
      "SLPA Name": unit.slpaName,
      "Enterprise Type": unit.enterpriseType,
      Municipality: unit.municipality,
      Barangay: unit.barangay,
      "GUR Status": "Encoded in GUR",
      "1st Visit": unit.has1stVisit ? "With 1st Visit" : "No 1st Visit",
      "2nd Visit": unit.has2ndVisit ? "With 2nd Visit" : "No 2nd Visit",
      "3rd Visit": unit.has3rdVisit ? "With 3rd Visit" : "No 3rd Visit",
      "4th Visit": unit.has4thVisit ? "With 4th Visit" : "No 4th Visit",
      "Organizational Assessment": unit.unitType === "Individual" ? "Not Applicable" : unit.hasOrgAssessment ? "With Organizational Assessment" : "Without Organizational Assessment",
      "Annual Assessment": unit.hasAnnualAssessment ? "With Annual Assessment" : "Without Annual Assessment",
      "Source File": Array.from(unit.sourceFiles).join("; "),
      __gurUnitKey: unit.key,
      __unitType: unit.unitType,
      __encodedInGur: true,
      __has1stVisit: unit.has1stVisit,
      __has2ndVisit: unit.has2ndVisit,
      __has3rdVisit: unit.has3rdVisit,
      __has4thVisit: unit.has4thVisit,
      __hasOrgAssessment: unit.hasOrgAssessment,
      __hasAnnualAssessment: unit.hasAnnualAssessment,
    });
  }

  for (const participant of participants.values()) {
    if (!participant.municipality) continue;
    pushRecord("participant", participant.detail);
  }

  for (const project of projects.values()) {
    if (!project.municipality) continue;
    const base = project.detail;
    const hasGur = project?.keys.some((matchKey) => gurKeys.has(matchKey)) || false;
    const projectTrainingKeys = [project?.participantKey || String(base.__participantKey || ""), String(base.__participantKey || "").replace(/^pid:/, "")].filter(Boolean).map(normalizeText);
    const hasTraining = projectTrainingKeys.some((matchKey) => trainingKeys.has(matchKey));
    const trainingDetail = projectTrainingKeys.map((matchKey) => trainingDetailByKey.get(matchKey)).find(Boolean);
    pushRecord(project?.association ? "association" : "individualEnterprise", {
      ...base,
      Type: project?.association ? "Association" : "Individual",
      Status: "",
      "GUR Status": hasGur ? "With GUR" : "Without GUR",
      "Training Status": hasTraining ? "With Training" : "Without Training",
      "Training Title": trainingDetail?.title || "",
      "Training Date": trainingDetail?.date || "",
      __hasGur: hasGur,
      __hasTraining: hasTraining,
    });
  }

  for (const statusItem of statusByProject.values()) {
    if (!statusItem.municipality) continue;
    pushRecord("status", statusItem.detail);
  }

  for (const { row, headers, source } of trainingRows) {
    const municipality = normalizeMunicipality(cell(row, headers, ["municipality"]));
    if (!municipality) continue;
    const base = drilldownBaseRecord(row, headers, source);
    const titles = extractTrainingTitleValues(row, headers);
    pushRecord("training", {
      ...base,
      "Training Title": titles.join("; ") || getCellByHeaderAliases(row, headers, ["Training Title", "Training"]),
      "Training Date": trainingDate(row, headers),
      "Training Status": "With Training",
    });
  }
  done("dashboard:municipality-drilldown-records");

  mark("dashboard:barangays");
  const barangayKeys = new Set<string>();
  const barangayKey = (municipality: AuroraMunicipality | "", barangay: string) => municipality ? `${municipality}::${normalizeText(barangay || "Barangay not available")}` : "";
  const addBarangayKey = (municipality: AuroraMunicipality | "", barangay: string) => {
    const key = barangayKey(municipality, barangay);
    if (key) barangayKeys.add(key);
    return key;
  };

  Array.from(participants.values()).forEach((item) => addBarangayKey(item.municipality, item.barangay));
  Array.from(projects.values()).forEach((item) => addBarangayKey(item.municipality, item.barangay));
  monitoringCoverage.rows.forEach((row) => {
    if (row.municipality !== "Not Found") addBarangayKey(row.municipality, row.barangay || "Barangay not available");
  });

  const detectedBarangayColumns = Array.from(new Set(sources.flatMap((source) => (source.headers || []).filter((header) => normalizeText(header).includes("barangay") || normalizeText(header) === "brgy" || normalizeText(header).includes("village")))));
  const rowsProcessedPerBarangay = new Map<string, number>();
  const countProcessed = (municipality: AuroraMunicipality | "", barangay: string) => {
    const key = addBarangayKey(municipality, barangay);
    if (key) rowsProcessedPerBarangay.set(key, (rowsProcessedPerBarangay.get(key) || 0) + 1);
  };
  Array.from(participants.values()).forEach((item) => countProcessed(item.municipality, item.barangay));
  Array.from(projects.values()).forEach((item) => countProcessed(item.municipality, item.barangay));
  monitoringCoverage.rows.forEach((row) => {
    if (row.municipality !== "Not Found") countProcessed(row.municipality, row.barangay || "Barangay not available");
  });

  const barangayAnalytics = Array.from(barangayKeys).map((key) => {
    const [municipality, normalizedBarangay] = key.split("::") as [AuroraMunicipality, string];
    const participantList = Array.from(participants.values()).filter((item) => item.municipality === municipality && normalizeText(item.barangay) === normalizedBarangay);
    const projectList = Array.from(projects.values()).filter((item) => item.municipality === municipality && normalizeText(item.barangay) === normalizedBarangay);
    const statusList = Array.from(statusByProject.values()).filter((item) => item.municipality === municipality && normalizeText(item.barangay) === normalizedBarangay);
    const coverageList = monitoringCoverage.rows.filter((row) => row.municipality === municipality && normalizeText(row.barangay || "Barangay not available") === normalizedBarangay);
    const barangay = participantList[0]?.barangay || projectList[0]?.barangay || coverageList[0]?.barangay || "Barangay not available";
    const withGur = projectList.filter((project) => project.keys.some((matchKey) => gurKeys.has(matchKey))).length;
    const withTraining = projectList.filter((project) => {
      const keys = [project.participantKey, project.participantKey.replace(/^pid:/, "")].filter(Boolean).map(normalizeText);
      return keys.some((matchKey) => trainingKeys.has(matchKey));
    }).length;
    const topCounts = new Map<string, number>();
    projectList.forEach((project) => inc(topCounts, project.name));
    const opCounts = new Map<string, number>();
    const closedCounts = new Map<string, number>();
    statusList.forEach((item) => {
      if (item.status === "operational") inc(opCounts, item.name);
      else if (item.status === "closed") inc(closedCounts, item.name);
    });
    const top = topRows(topCounts, 1)[0];
    const topOperational = topRows(opCounts, 1)[0];
    const topClosed = topRows(closedCounts, 1)[0];
    const operationalCount = statusList.filter((item) => item.status === "operational").length;
    const closedCount = statusList.filter((item) => item.status === "closed").length;
    const sourceFiles = Array.from(new Set([
      ...participantList.map((item) => item.source),
      ...projectList.map((item) => item.source),
      ...statusList.map((item) => item.source),
      ...coverageList.flatMap((item) => item.proofFiles || [item.sourceFile]),
    ].filter(Boolean)));
    return {
      municipality,
      barangay,
      normalizedBarangay,
      totalParticipants: participantList.length,
      totalAssociations: projectList.filter((item) => item.association).length,
      totalEnterprises: projectList.length,
      individualEnterprises: projectList.filter((item) => !item.association).length,
      withGrantUtilizationReport: withGur,
      withoutGrantUtilizationReport: Math.max(0, projectList.length - withGur),
      withTraining,
      withoutTraining: Math.max(0, projectList.length - withTraining),
      operational: operationalCount,
      closed: closedCount,
      pendingUnknown: Math.max(0, statusList.length - operationalCount - closedCount),
      topEnterpriseType: top?.[0] || "No data yet",
      mostOperationalEnterprise: topOperational?.[0] || "No data yet",
      mostClosedEnterprise: topClosed?.[0] || "No data yet",
      monitoringFirstVisit: coverageList.filter((row) => row.visits[1] === "Completed").length,
      monitoringSecondVisit: coverageList.filter((row) => row.visits[2] === "Completed").length,
      monitoringThirdVisit: coverageList.filter((row) => row.visits[3] === "Completed").length,
      monitoringFourthVisit: coverageList.filter((row) => row.visits[4] === "Completed").length,
      organizationalAssessment: coverageList.filter((row) => row.type === "Association" && row.organizationalAssessment === "Completed").length,
      annualAssessment: coverageList.filter((row) => row.annualAssessment === "Completed").length,
      sourceModules: Array.from(new Set([
        participantList.length ? sourceDisplayName("SLPIS_PERSONAL_MODULE") : "",
        projectList.length ? sourceDisplayName("SLPIS_PROJECT_MODULE") : "",
        statusList.length ? `${sourceDisplayName("SLPIS_MONITORING_INDIVIDUAL_MODULE")} / ${sourceDisplayName("SLPIS_MONITORING_ASSOCIATION_MODULE")}` : "",
        ...coverageList.flatMap((item) => item.proofModules || [item.sourceModule]),
      ].filter(Boolean))),
      sourceFiles,
    };
  }).sort((a, b) => a.municipality.localeCompare(b.municipality) || b.totalParticipants + b.totalEnterprises - (a.totalParticipants + a.totalEnterprises) || a.barangay.localeCompare(b.barangay));
  monitoringCoverage.debug.barangayCountByMunicipality = Object.fromEntries(
    AURORA_MUNICIPALITIES.map((municipality) => [
      municipality,
      new Set(barangayAnalytics.filter((row) => row.municipality === municipality).map((row) => row.normalizedBarangay || normalizeText(row.barangay))).size,
    ]),
  );

  const barangayDebug = {
    selectedMunicipality: "all",
    detectedBarangayColumns,
    barangaysFound: barangayAnalytics.length,
    rowsProcessedPerBarangay: Array.from(rowsProcessedPerBarangay.entries()).map(([key, rowsProcessed]) => ({ key, rowsProcessed })),
    missingBarangayRecords: barangayAnalytics.filter((row) => row.barangay === "Barangay not available").reduce((sum, row) => sum + row.totalParticipants + row.totalEnterprises, 0),
  };
  console.log("[barangayAnalytics]", JSON.stringify(barangayDebug));
  done("dashboard:barangays");

  const dashboardSourceProof = {
    workingSourceRowsCount: allParsedDashboardRows.length,
    personalRowsCount: rowsOf(sources, ["SLPIS_PERSONAL_MODULE", "SLP_DPT_AURORA_DATABASE"]).length,
    projectRowsCount: projectRows.length,
    monitoringRowsCount: monitoringIndividualRows.length + monitoringAssociationRows.length,
    monitoringIndividualRowsCount: monitoringIndividualRows.length,
    monitoringAssociationRowsCount: monitoringAssociationRows.length,
    orgAssessmentRowsCount: rowsOf(sources, ["SLPIS_ORG_ASSESSMENT_MODULE"]).length,
    annualAssessmentRowsCount: rowsOf(sources, ["SLPIS_ANNUAL_ASSESSMENT_MODULE"]).length,
    monitoringCoverageSourceRowsCount: monitoringCoverage.debug.rowsProcessed,
    barangaySourceRowsCount: barangayAnalytics.reduce((sum, row) => sum + row.totalParticipants + row.totalEnterprises, 0),
    drilldownSourceRowsCount: municipalityDrilldownRecords.length,
    sampleSourceRow: allParsedDashboardRows[0]?.row,
    sampleProjectRow: projectRows[0]?.row,
    sampleMonitoringRow: monitoringIndividualRows[0]?.row || monitoringAssociationRows[0]?.row,
  };
  monitoringCoverage.debug.sourceProof = dashboardSourceProof;
  console.log("DASHBOARD SOURCE PROOF", dashboardSourceProof);

  const operational = municipalityBreakdown.reduce((sum, item) => sum + item.operational, 0);
  const closed = municipalityBreakdown.reduce((sum, item) => sum + item.closed, 0);
  const associations = Array.from(projects.values()).filter((item) => item.association).length;
  const individualEnterprises = Array.from(projects.values()).filter((item) => !item.association).length;
  const totalWithGur = municipalityBreakdown.reduce((sum, item) => sum + item.withGrantUtilizationReport, 0);
  const totalWithoutGur = municipalityBreakdown.reduce((sum, item) => sum + item.withoutGrantUtilizationReport, 0);
  const totalWithTraining = municipalityBreakdown.reduce((sum, item) => sum + item.withTraining, 0);
  const totalWithoutTraining = municipalityBreakdown.reduce((sum, item) => sum + item.withoutTraining, 0);
  const titleRows = OFFICIAL_TRAINING_TITLES
    .map((trainingTitle) => {
      const participants = trainingTitleParticipants.get(trainingTitle) || new Set<string>();
      return {
      trainingTitle,
      participantCount: participants.size,
      sourceRows: Array.from(trainingTitleSourceRows.get(trainingTitle) || []),
      municipalities: Array.from(trainingTitleMunicipalities.get(trainingTitle) || []).sort(),
      rawTitlesMerged: Array.from(trainingTitleRawMerged.get(trainingTitle) || []).sort(),
    };
    })
    .filter((item) => item.participantCount > 0)
    .sort((a, b) => b.participantCount - a.participantCount);
  const widgetDiagnostics = [
    {
      widgetName: "Top 10 Most Implemented Enterprise / Project Types",
      source_type: "SLPIS_PROJECT_MODULE",
      files_used: sourceTrace(["SLPIS_PROJECT_MODULE"]).length,
      rows_before: projectRows.length,
      rows_after: seenImplementedProjects.size,
      join_key_used: "Project ID",
      missing_required_columns: hasSource("SLPIS_PROJECT_MODULE") ? [] : ["Project Module"],
      final_result_count: topRows(topOverall, 10).length,
    },
    {
      widgetName: "Most Operational Enterprises",
      source_type: "SLPIS_MONITORING_INDIVIDUAL_MODULE + SLPIS_MONITORING_ASSOCIATION_MODULE + SLPIS_PROJECT_MODULE",
      files_used: sourceTrace(["SLPIS_MONITORING_INDIVIDUAL_MODULE", "SLPIS_MONITORING_ASSOCIATION_MODULE", "SLPIS_PROJECT_MODULE"]).length,
      rows_before: rowsOf(sources, ["SLPIS_MONITORING_INDIVIDUAL_MODULE", "SLPIS_MONITORING_ASSOCIATION_MODULE"]).length,
      rows_after: Array.from(statusByProject.values()).filter((item) => item.status === "operational").length,
      join_key_used: "Project ID",
      missing_required_columns: !hasSource("SLPIS_PROJECT_MODULE") ? ["Project Module"] : [],
      final_result_count: topRows(new Map(Array.from(statusByProject.values()).filter((item) => item.status === "operational").reduce((rows, item) => rows.set(item.name, (rows.get(item.name) || 0) + 1), new Map<string, number>())), 10).length,
    },
    {
      widgetName: "Most Closed Enterprises",
      source_type: "SLPIS_MONITORING_INDIVIDUAL_MODULE + SLPIS_MONITORING_ASSOCIATION_MODULE + SLPIS_PROJECT_MODULE",
      files_used: sourceTrace(["SLPIS_MONITORING_INDIVIDUAL_MODULE", "SLPIS_MONITORING_ASSOCIATION_MODULE", "SLPIS_PROJECT_MODULE"]).length,
      rows_before: rowsOf(sources, ["SLPIS_MONITORING_INDIVIDUAL_MODULE", "SLPIS_MONITORING_ASSOCIATION_MODULE"]).length,
      rows_after: Array.from(statusByProject.values()).filter((item) => item.status === "closed").length,
      join_key_used: "Project ID",
      missing_required_columns: !hasSource("SLPIS_PROJECT_MODULE") ? ["Project Module"] : [],
      final_result_count: topRows(new Map(Array.from(statusByProject.values()).filter((item) => item.status === "closed").reduce((rows, item) => rows.set(item.name, (rows.get(item.name) || 0) + 1), new Map<string, number>())), 10).length,
    },
    {
      widgetName: "Training Title Participation",
      source_type: "SLPIS_TRAINING_MODULE",
      files_used: sourceTrace(["SLPIS_TRAINING_MODULE"]).length,
      rows_before: trainingRows.length,
      rows_after: trainingRows.length,
      join_key_used: "Participant ID",
      missing_required_columns: !hasSource("SLPIS_TRAINING_MODULE") ? ["Training Module"] : [],
      final_result_count: titleRows.length,
      training_title_columns_detected: trainingTitleColumnsDetected,
      raw_training_titles_found: Array.from(rawTrainingTitles.values()).map((item) => ({ rawTitle: item.rawTitle, normalizedCategory: item.normalizedCategory, count: item.count, sourceRows: item.sourceRows.slice(0, 20), municipalities: Array.from(item.municipalities).sort() })),
      unmapped_training_titles: Array.from(unmappedTrainingTitles.values()).map((item) => ({ rawTitle: item.rawTitle, count: item.count, sourceRows: item.sourceRows.slice(0, 20), municipalities: Array.from(item.municipalities).sort() })),
      participant_count_per_category: titleRows.map((item) => ({ trainingTitle: item.trainingTitle, participantCount: item.participantCount })),
    },
  ];
  const dashboardDebug = {
    projectModuleRowsLoaded: projectRows.length,
    projectNameColumnUsed: "Name",
    sampleProjectNames,
    projectNameColumnError: sampleProjectNames.length ? "" : "Project Module column 'Name' was not found or has no values.",
    monitoringIndividualRowsLoaded: monitoringIndividualRows.length,
    monitoringAssociationRowsLoaded: monitoringAssociationRows.length,
    joinKeyUsed: "Project ID",
    matchedMonitoringRowsToProjectRows: matchedMonitoringRows,
    unmatchedMonitoringRows,
    trainingTitleDiagnostics: {
      totalTrainingRowsLoaded: trainingRows.length,
      trainingTitleColumnsDetected,
      rawTrainingTitlesFound: Array.from(rawTrainingTitles.values()).map((item) => ({ rawTitle: item.rawTitle, normalizedCategory: item.normalizedCategory, count: item.count, sourceRows: item.sourceRows.slice(0, 20), municipalities: Array.from(item.municipalities).sort() })),
      unmappedTrainingTitles: Array.from(unmappedTrainingTitles.values()).map((item) => ({ rawTitle: item.rawTitle, count: item.count, sourceRows: item.sourceRows.slice(0, 20), municipalities: Array.from(item.municipalities).sort() })),
      participantCountPerCategory: titleRows.map((item) => ({ trainingTitle: item.trainingTitle, participantCount: item.participantCount, rawTitlesMerged: item.rawTitlesMerged })),
    },
    widgetSources: widgetDiagnostics.map((item) => ({
      widgetName: item.widgetName,
      sourceType: item.source_type,
      filesUsed: item.files_used,
      joinKeyUsed: item.join_key_used,
      resultCount: item.final_result_count,
    })),
    barangayAnalytics: barangayDebug,
  };

  return {
    success: true,
    lastUpdated: new Date().toISOString(),
    lastIndexed: sources.map((source) => source.updated_at || source.created_at || "").sort().at(-1) || new Date().toISOString(),
    summary: {
      totalParticipants: participants.size,
      associations,
      individualEnterprises,
      operational,
      closed,
    },
    operationalClosedByMunicipality: municipalityBreakdown.map((item) => ({ municipality: item.municipality, operational: item.operational, closed: item.closed, unknown: item.unknown, total: item.operational + item.closed + item.unknown })),
    topEnterprisesOverall: topRows(topOverall, 10).map(([enterpriseProjectType, count], index) => ({ rank: index + 1, enterpriseProjectType, count })),
    topEnterprisesByMunicipality: municipalityBreakdown.map((item) => ({ municipality: item.municipality, enterpriseProjectType: item.topEnterprise, count: item.topEnterpriseCount, sharePercent: item.associations + item.individualEnterprises ? Math.round((item.topEnterpriseCount / (item.associations + item.individualEnterprises)) * 100) : 0 })),
    mostOperationalEnterprises: topRows(new Map(Array.from(statusByProject.values()).filter((item) => item.status === "operational").reduce((rows, item) => rows.set(item.name, (rows.get(item.name) || 0) + 1), new Map<string, number>())), 10).map(([enterpriseProjectType, operationalCount], index) => ({ rank: index + 1, enterpriseProjectType, operationalCount })),
    mostOperationalEnterprisesByMunicipality: municipalityBreakdown.map((item) => ({ municipality: item.municipality, enterpriseProjectType: item.mostOperationalEnterprise, operationalCount: item.mostOperationalEnterpriseCount })),
    mostClosedEnterprises: topRows(new Map(Array.from(statusByProject.values()).filter((item) => item.status === "closed").reduce((rows, item) => rows.set(item.name, (rows.get(item.name) || 0) + 1), new Map<string, number>())), 10).map(([enterpriseProjectType, closedCount], index) => ({ rank: index + 1, enterpriseProjectType, closedCount })),
    mostClosedEnterprisesByMunicipality: municipalityBreakdown.map((item) => ({ municipality: item.municipality, enterpriseProjectType: item.mostClosedEnterprise, closedCount: item.mostClosedEnterpriseCount })),
    grantUtilization: {
      withReport: totalWithGur,
      withoutReport: totalWithoutGur,
      byMunicipality: municipalityBreakdown.map((item) => ({ municipality: item.municipality, totalProjects: item.associations + item.individualEnterprises, withGur: item.withGrantUtilizationReport, withoutGur: item.withoutGrantUtilizationReport, gurRate: item.gurRate, sourceUsed: "SLPIS Project Module + SLPIS GUR Module" })),
    },
    training: {
      withTraining: totalWithTraining,
      withoutTraining: totalWithoutTraining,
      byMunicipality: municipalityBreakdown.map((item) => ({ municipality: item.municipality, projectParticipants: item.withTraining + item.withoutTraining, withTraining: item.withTraining, withoutTraining: item.withoutTraining })),
      byTrainingTitle: titleRows.map((item) => ({ trainingTitle: item.trainingTitle, participants: item.participantCount, participantCount: item.participantCount, sourceRows: item.sourceRows.slice(0, 100), sourceRowCount: item.sourceRows.length, municipalities: item.municipalities, rawTitlesMerged: item.rawTitlesMerged })),
      diagnostics: {
        totalTrainingRowsLoaded: trainingRows.length,
        trainingTitleColumnsDetected,
        rawTrainingTitlesFound: Array.from(rawTrainingTitles.values()).map((item) => ({ rawTitle: item.rawTitle, normalizedCategory: item.normalizedCategory, count: item.count, sourceRows: item.sourceRows.slice(0, 20), municipalities: Array.from(item.municipalities).sort() })),
        unmappedTrainingTitles: Array.from(unmappedTrainingTitles.values()).map((item) => ({ rawTitle: item.rawTitle, count: item.count, sourceRows: item.sourceRows.slice(0, 20), municipalities: Array.from(item.municipalities).sort() })),
        participantCountPerCategory: titleRows.map((item) => ({ trainingTitle: item.trainingTitle, participantCount: item.participantCount, rawTitlesMerged: item.rawTitlesMerged })),
      },
    },
    municipalityDrilldown: municipalityBreakdown,
    municipalityDrilldownRecords,
    livelihoodSustainability: {
      summary: sustainabilitySummary,
      byMunicipality: sustainabilityByMunicipality,
      records: sustainabilityRecords,
      municipalityFinancialRanking,
      sourceCounts: sustainabilitySourceCounts,
      columnMapping: sustainabilityColumnMapping,
    },
    mapData: municipalityBreakdown,
    monitoringCoverage,
    barangayAnalytics,
    sourceDiagnostics: sourceDiagnostics(sources),
    widgetDiagnostics,
    dashboardDebug,
    dataQualityNotes: notes,
  };
}
