import { sourceDisplayName, type SourceType } from "../config/dataSourceRegistry.ts";
import { AURORA_MUNICIPALITIES, normalizeMunicipality, normalizePersonName, normalizeText, type AuroraMunicipality } from "./headerNormalizer.ts";

type MonitoringSource = {
  sourceType: SourceType;
  sourceLabel: string;
  fileName?: string;
  file_name?: string;
  sheetName?: string;
  sheet_name?: string;
  headerRowIndex?: number;
  headers?: string[];
  rows?: Array<Record<string, any>>;
};

export type MonitoringCoverageStatus = "Completed" | "Missing" | "Not Applicable";
export type MonitoringCoverageType = "Individual" | "Association";

export type MonitoringCoverageRow = {
  unitKey: string;
  monitoringUnitName: string;
  municipality: AuroraMunicipality | "Not Found";
  barangay: string;
  type: MonitoringCoverageType;
  countUnit: "Participant" | "Association";
  slpParticipantId: string;
  projectIdAssociationName: string;
  visits: Record<1 | 2 | 3 | 4, MonitoringCoverageStatus>;
  organizationalAssessment: MonitoringCoverageStatus;
  annualAssessment: MonitoringCoverageStatus;
  missingRequirement: string;
  sourceModule: string;
  sourceFile: string;
  proofModules: string[];
  proofFiles: string[];
};

export type MonitoringCoverageSummary = {
  firstVisit: number;
  secondVisit: number;
  thirdVisit: number;
  fourthVisit: number;
  organizationalAssessment: number;
  annualAssessment: number;
  missingMonitoringVisits: number;
  missingAssessments: number;
  totalUnits: number;
};

export type MonitoringCoverageAnalytics = {
  summary: MonitoringCoverageSummary;
  byMunicipality: Array<{
    municipality: AuroraMunicipality;
    totalUnits: number;
    firstVisit: number;
    secondVisit: number;
    thirdVisit: number;
    fourthVisit: number;
    organizationalAssessment: number;
    annualAssessment: number;
    missingMonitoringVisits: number;
    missingAssessments: number;
  }>;
  rows: MonitoringCoverageRow[];
  debug: {
    detectedSources: Array<{ sourceModule: string; sourceFile: string; rowsProcessed: number; keyColumns: string[] }>;
    availableFiles?: Array<{ fileName: string; detectedModuleType: string; rowCount: number; headersDetected: string[]; accepted: boolean; rejectedReason: string }>;
    apiFilesLoadedCount?: number;
    parsedFilesCount?: number;
    parsedRowsCount?: number;
    filesScanned: number;
    headerRowUsed: number;
    headersDetected: Record<string, string[]>;
    rowsReadPerModule: Record<string, number>;
    exactColumnsFound: Record<string, Record<string, boolean>>;
    monitoringRowsBeforeFilter: number;
    rowsProcessed: number;
    monitoringUnitsCreated: number;
    monitoringUnitsAfterMerge: number;
    associationUnits: number;
    individualUnits: number;
    matchedRecords: number;
    unmatchedRecords: number;
    visitCounts: Record<string, number>;
    organizationalAssessmentCounts: number;
    annualAssessmentCounts: number;
    orgAssessmentMatches: number;
    annualAssessmentMatches: number;
    barangayCount: number;
    barangayCountByMunicipality?: Record<string, number>;
    sourceProof?: Record<string, any>;
    activeFilters: Record<string, string>;
  };
};

type MutableCoverageRow = MonitoringCoverageRow & {
  visitProofs: Record<1 | 2 | 3 | 4, Set<string>>;
  annualProofs: Set<string>;
  orgProofs: Set<string>;
  sourceModulesSet: Set<string>;
  sourceFilesSet: Set<string>;
};

type UnitIdentity = {
  key: string;
  name: string;
  municipality: AuroraMunicipality | "";
  barangay: string;
  participantId: string;
  projectId: string;
  associationName: string;
};

const MONITORING_SOURCE_TYPES: SourceType[] = [
  "MD_MONITORING_INDIVIDUAL",
  "MD_MONITORING_ASSOCIATION",
  "MD_ANNUAL_ASSESSMENT",
  "ORG_ASSESSMENT",
  "SLPIS_MONITORING_INDIVIDUAL_MODULE",
  "SLPIS_MONITORING_ASSOCIATION_MODULE",
  "SLPIS_ANNUAL_ASSESSMENT_MODULE",
  "SLPIS_ORG_ASSESSMENT_MODULE",
];

function canonicalMonitoringSourceType(sourceType: SourceType): SourceType {
  if (sourceType === "MD_MONITORING_INDIVIDUAL") return "SLPIS_MONITORING_INDIVIDUAL_MODULE";
  if (sourceType === "MD_MONITORING_ASSOCIATION") return "SLPIS_MONITORING_ASSOCIATION_MODULE";
  if (sourceType === "MD_ANNUAL_ASSESSMENT") return "SLPIS_ANNUAL_ASSESSMENT_MODULE";
  if (sourceType === "ORG_ASSESSMENT") return "SLPIS_ORG_ASSESSMENT_MODULE";
  return sourceType;
}

const PARTICIPANT_ID_HEADERS = ["slp participant id", "participant id", "slpis id", "slp id", "slp paricipant id", "paricipant id", "beneficiary id"];
const PROJECT_ID_HEADERS = ["project id", "slp project id", "unique project id", "association id", "organization id", "organisation id"];
const MUNICIPALITY_HEADERS = ["municipality", "city municipality", "city municipality address", "mun", "address municipality", "city"];
const BARANGAY_HEADERS = ["barangay", "brgy", "village"];
const ENTERPRISE_TYPE_HEADERS = ["enterprise type", "enterprise", "project type", "enterprise / project type", "enterprise project type"];
const FULL_NAME_HEADERS = ["full name", "participant name", "beneficiary name", "client name", "member name", "name of participant"];
const FIRST_NAME_HEADERS = ["first name", "firstname", "given name"];
const MIDDLE_NAME_HEADERS = ["middle name", "middle initial", "mi", "middle"];
const LAST_NAME_HEADERS = ["last name", "lastname", "surname", "family name"];
const EXTENSION_HEADERS = ["extension name", "extension", "suffix", "ext name"];
const ASSOCIATION_NAME_HEADERS = ["association name", "slpa name", "organization name", "organisation name", "project name", "name of project", "project title", "enterprise name", "livelihood project", "livelihood activity"];
const VISIT_VALUE_HEADERS = ["visit", "visit no", "visit number", "monitoring visit", "monitoring visit no", "monitoring visit number"];
const ASSESSMENT_VISIT_HEADERS = ["assessment visit"];

function compactHeader(value = "") {
  return normalizeText(value).replace(/\s+/g, "");
}

function findHeader(headers: string[], aliases: string[]) {
  const normalizedAliases = aliases.map(normalizeText);
  const compactAliases = aliases.map(compactHeader);
  return headers.find((header) => {
    const normalized = normalizeText(header);
    const compact = compactHeader(header);
    return normalizedAliases.includes(normalized) || compactAliases.includes(compact);
  }) || headers.find((header) => {
    const normalized = normalizeText(header);
    const compact = compactHeader(header);
    return normalizedAliases.some((alias) => alias.length > 3 && (normalized.includes(alias) || alias.includes(normalized))) ||
      compactAliases.some((alias) => alias.length > 3 && (compact.includes(alias) || alias.includes(compact)));
  }) || "";
}

function value(row: Record<string, any>, headers: string[], aliases: string[]) {
  const header = findHeader(headers, aliases);
  return header ? String(row[header] ?? "").trim() : "";
}

function exactValue(row: Record<string, any>, headers: string[], headerName: string) {
  const header = headers.find((item) => normalizeText(item) === normalizeText(headerName));
  return header ? String(row[header] ?? "").trim() : "";
}

function moduleName(sourceType: SourceType) {
  return sourceDisplayName(sourceType);
}

function sourceFile(source: MonitoringSource) {
  return source.sourceLabel || [source.fileName || source.file_name, source.sheetName || source.sheet_name].filter(Boolean).join(" / ") || "No matching record";
}

export function normalizeMonitoringId(value = "") {
  return normalizeText(value).replace(/\s+/g, "");
}

export function normalizeMonitoringName(value = "") {
  return normalizePersonName(value);
}

export function normalizeAssociationName(value = "") {
  return normalizeText(value).replace(/\b(slpa|association|assoc|organization|organisation|project)\b/g, "").replace(/\s+/g, " ").trim();
}

export function normalizeMonitoringMunicipality(value = "") {
  return normalizeMunicipality(value);
}

export function normalizeMonitoringBarangay(value = "") {
  const normalized = normalizeText(value);
  if (!normalized) return "Barangay not available";
  return normalized.split(" ").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export function normalizeVisitNumber(input = ""): 1 | 2 | 3 | 4 | null {
  const normalized = normalizeText(input);
  if (!normalized) return null;
  if (/\b(first|one|1|1st)\b/.test(normalized) || /visit\s*1\b/.test(normalized)) return 1;
  if (/\b(second|two|2|2nd)\b/.test(normalized) || /visit\s*2\b/.test(normalized)) return 2;
  if (/\b(third|three|3|3rd)\b/.test(normalized) || /visit\s*3\b/.test(normalized)) return 3;
  if (/\b(fourth|four|4|4th)\b/.test(normalized) || /visit\s*4\b/.test(normalized)) return 4;
  return null;
}

function isAffirmative(value: any) {
  const raw = String(value ?? "").trim();
  const normalized = normalizeText(raw);
  if (!normalized) return false;
  if (/^(no|none|not applicable|na|n a|missing|not found|0|false)$/i.test(normalized)) return false;
  return true;
}

function visitNumbersFromRow(row: Record<string, any>, headers: string[]) {
  const visits = new Set<1 | 2 | 3 | 4>();
  for (const header of headers) {
    const headerVisit = normalizeVisitNumber(header);
    if (headerVisit && /visit|monitor/i.test(header) && isAffirmative(row[header])) visits.add(headerVisit);
  }
  const visitValue = value(row, headers, VISIT_VALUE_HEADERS);
  const valueVisit = normalizeVisitNumber(visitValue);
  if (valueVisit) visits.add(valueVisit);
  for (const header of headers) {
    const cellValue = row[header];
    const cellVisit = normalizeVisitNumber(String(cellValue ?? ""));
    if (cellVisit && /visit|first|second|third|fourth|\b[1-4](st|nd|rd|th)?\b/i.test(String(cellValue ?? ""))) visits.add(cellVisit);
  }
  return visits;
}

function fullName(row: Record<string, any>, headers: string[]) {
  const direct = value(row, headers, FULL_NAME_HEADERS);
  if (direct) return normalizeMonitoringName(direct);
  return normalizeMonitoringName([
    value(row, headers, LAST_NAME_HEADERS),
    value(row, headers, FIRST_NAME_HEADERS),
    value(row, headers, MIDDLE_NAME_HEADERS),
    value(row, headers, EXTENSION_HEADERS),
  ].filter(Boolean).join(" "));
}

function individualIdentity(row: Record<string, any>, headers: string[]): UnitIdentity {
  const participantId = value(row, headers, PARTICIPANT_ID_HEADERS);
  const name = fullName(row, headers);
  const municipality = normalizeMonitoringMunicipality(value(row, headers, MUNICIPALITY_HEADERS));
  const barangay = normalizeMonitoringBarangay(value(row, headers, BARANGAY_HEADERS));
  const key = participantId
    ? `individual:pid:${normalizeMonitoringId(participantId)}`
    : name && municipality
      ? `individual:name:${name}|${municipality}`
      : "";
  return { key, name: name || participantId || "No matching record", municipality, barangay, participantId, projectId: "", associationName: "" };
}

function associationIdentity(row: Record<string, any>, headers: string[]): UnitIdentity {
  const projectId = value(row, headers, PROJECT_ID_HEADERS);
  const associationName = value(row, headers, ASSOCIATION_NAME_HEADERS);
  const normalizedAssociation = normalizeAssociationName(associationName);
  const municipality = normalizeMonitoringMunicipality(value(row, headers, MUNICIPALITY_HEADERS));
  const barangay = normalizeMonitoringBarangay(value(row, headers, BARANGAY_HEADERS));
  const key = projectId
    ? `association:project:${normalizeMonitoringId(projectId)}`
    : normalizedAssociation && municipality
      ? `association:name:${normalizedAssociation}|${municipality}`
      : "";
  return { key, name: associationName || projectId || "No matching record", municipality, barangay, participantId: "", projectId, associationName };
}

function annualIdentity(row: Record<string, any>, headers: string[]): { type: MonitoringCoverageType; identity: UnitIdentity } {
  const participant = individualIdentity(row, headers);
  const association = associationIdentity(row, headers);
  const enterpriseType = normalizeText(value(row, headers, ENTERPRISE_TYPE_HEADERS));
  if (enterpriseType.includes("association")) return { type: "Association", identity: association };
  if (enterpriseType.includes("individual")) return { type: "Individual", identity: participant };
  if (participant.key && !association.projectId && !association.associationName) return { type: "Individual", identity: participant };
  if (association.key) return { type: "Association", identity: association };
  if (participant.key) return { type: "Individual", identity: participant };
  return { type: "Association", identity: association };
}

function createCoverageRow(type: MonitoringCoverageType, identity: UnitIdentity, source: MonitoringSource): MutableCoverageRow {
  const sourceModule = moduleName(source.sourceType);
  const file = sourceFile(source);
  return {
    unitKey: identity.key,
    monitoringUnitName: identity.name || "Not Found",
    municipality: identity.municipality || "Not Found",
    barangay: identity.barangay || "Barangay not available",
    type,
    countUnit: type === "Individual" ? "Participant" : "Association",
    slpParticipantId: type === "Individual" ? identity.participantId || "Not Found" : "Not Applicable",
    projectIdAssociationName: type === "Association" ? identity.projectId || identity.associationName || "Not Found" : "Not Applicable",
    visits: { 1: "Missing", 2: "Missing", 3: "Missing", 4: "Missing" },
    organizationalAssessment: type === "Individual" ? "Not Applicable" : "Missing",
    annualAssessment: "Missing",
    missingRequirement: "",
    sourceModule,
    sourceFile: file,
    proofModules: [sourceModule],
    proofFiles: [file],
    visitProofs: { 1: new Set(), 2: new Set(), 3: new Set(), 4: new Set() },
    annualProofs: new Set(),
    orgProofs: new Set(),
    sourceModulesSet: new Set([sourceModule]),
    sourceFilesSet: new Set([file]),
  };
}

function getOrCreateUnit(units: Map<string, MutableCoverageRow>, type: MonitoringCoverageType, identity: UnitIdentity, source: MonitoringSource) {
  if (!identity.key) return null;
  if (!units.has(identity.key)) units.set(identity.key, createCoverageRow(type, identity, source));
  const unit = units.get(identity.key)!;
  const sourceModule = moduleName(source.sourceType);
  const file = sourceFile(source);
  unit.sourceModulesSet.add(sourceModule);
  unit.sourceFilesSet.add(file);
  if (unit.monitoringUnitName === "Not Found" && identity.name) unit.monitoringUnitName = identity.name;
  if (unit.municipality === "Not Found" && identity.municipality) unit.municipality = identity.municipality;
  if (unit.barangay === "Barangay not available" && identity.barangay && identity.barangay !== "Barangay not available") unit.barangay = identity.barangay;
  if (unit.slpParticipantId === "Not Found" && identity.participantId) unit.slpParticipantId = identity.participantId;
  if (unit.projectIdAssociationName === "Not Found" && (identity.projectId || identity.associationName)) unit.projectIdAssociationName = identity.projectId || identity.associationName;
  return unit;
}

function sourceKeyColumns(headers: string[]) {
  return [
    findHeader(headers, PARTICIPANT_ID_HEADERS),
    findHeader(headers, PROJECT_ID_HEADERS),
    findHeader(headers, ASSOCIATION_NAME_HEADERS),
    findHeader(headers, FULL_NAME_HEADERS),
    findHeader(headers, MUNICIPALITY_HEADERS),
    findHeader(headers, BARANGAY_HEADERS),
    findHeader(headers, VISIT_VALUE_HEADERS),
    findHeader(headers, ASSESSMENT_VISIT_HEADERS),
    findHeader(headers, ENTERPRISE_TYPE_HEADERS),
  ].filter(Boolean);
}

function exactColumnMap(headers: string[]) {
  const has = (header: string) => headers.some((item) => normalizeText(item) === normalizeText(header));
  return {
    projectId: has("Project ID"),
    projectName: has("Project Name"),
    slpaName: has("SLPA Name"),
    enterpriseType: has("Enterprise Type"),
    slpParticipantId: has("SLP Paricipant ID"),
    participantName: has("Name") || (has("Last Name") && has("First Name")),
    municipality: has("Municipality"),
    barangay: has("Barangay"),
    monitoringVisit: has("Visit"),
    annualAssessmentVisit: has("Assessment Visit"),
  };
}

function projectIdIdentity(row: Record<string, any>, headers: string[]) {
  const identity = associationIdentity(row, headers);
  if (!identity.projectId) return { ...identity, key: "" };
  return { ...identity, key: `association:project:${normalizeMonitoringId(identity.projectId)}` };
}

function participantIdIdentity(row: Record<string, any>, headers: string[]) {
  const identity = individualIdentity(row, headers);
  if (!identity.participantId) return { ...identity, key: "" };
  return { ...identity, key: `individual:pid:${normalizeMonitoringId(identity.participantId)}` };
}

function headerHasMonitoringKeys(headers: string[]) {
  return Boolean(
    findHeader(headers, PARTICIPANT_ID_HEADERS) ||
      findHeader(headers, PROJECT_ID_HEADERS) ||
      findHeader(headers, ASSOCIATION_NAME_HEADERS) ||
      findHeader(headers, MUNICIPALITY_HEADERS) ||
      findHeader(headers, VISIT_VALUE_HEADERS),
  );
}

function rowValuesLookLikeHeaders(row: Record<string, any>, currentHeaders: string[]) {
  const values = currentHeaders.map((header) => String(row[header] ?? "").trim()).filter(Boolean);
  return headerHasMonitoringKeys(values);
}

function withSecondRowHeaders(source: MonitoringSource): MonitoringSource {
  if (!MONITORING_SOURCE_TYPES.includes(source.sourceType)) return source;
  const currentHeaders = (source.headers || []).filter((header) => !/^__/.test(header));
  const rows = source.rows || [];
  if (!rows.length || !currentHeaders.length) return source;
  const exact = exactColumnMap(currentHeaders);
  const sourceType = canonicalMonitoringSourceType(source.sourceType);
  const hasExactUsableHeaders = sourceType === "SLPIS_MONITORING_INDIVIDUAL_MODULE"
    ? exact.slpParticipantId && exact.monitoringVisit && exact.municipality
    : sourceType === "SLPIS_MONITORING_ASSOCIATION_MODULE"
      ? exact.projectId && exact.monitoringVisit && exact.municipality
      : sourceType === "SLPIS_ANNUAL_ASSESSMENT_MODULE"
        ? exact.enterpriseType && exact.annualAssessmentVisit && exact.municipality
        : sourceType === "SLPIS_ORG_ASSESSMENT_MODULE"
          ? exact.projectId && exact.municipality
          : headerHasMonitoringKeys(currentHeaders);
  if (hasExactUsableHeaders) return source;
  const headerRow = rows[0];
  if (!rowValuesLookLikeHeaders(headerRow, currentHeaders)) return source;
  const nextHeaders = currentHeaders.map((header, index) => String(headerRow[header] || `Column ${index + 1}`).trim());
  const nextRows = rows.slice(1).map((row) => {
    const nextRow: Record<string, any> = {};
    currentHeaders.forEach((oldHeader, index) => {
      nextRow[nextHeaders[index]] = row[oldHeader] ?? "";
    });
    if (row.__rowNumber) nextRow.__rowNumber = row.__rowNumber;
    if (row.__rowText) nextRow.__rowText = row.__rowText;
    return nextRow;
  });
  return { ...source, headers: nextHeaders, rows: nextRows };
}

function applyMissingRequirement(row: MutableCoverageRow) {
  const missing: string[] = [];
  ([1, 2, 3, 4] as const).forEach((visit) => {
    if (row.visits[visit] !== "Completed") missing.push(`${visit}${visit === 1 ? "st" : visit === 2 ? "nd" : visit === 3 ? "rd" : "th"} Visit`);
  });
  if (row.type === "Association" && row.organizationalAssessment !== "Completed") missing.push("Organizational Assessment");
  if (row.annualAssessment !== "Completed") missing.push("Annual Assessment");
  row.missingRequirement = missing.length ? missing.join(", ") : "Complete";
  row.sourceModule = Array.from(row.sourceModulesSet).join("; ") || "Not Found";
  row.sourceFile = Array.from(row.sourceFilesSet).join("; ") || "Not Found";
  row.proofModules = Array.from(new Set([
    ...row.proofModules,
    ...Array.from(row.visitProofs[1]),
    ...Array.from(row.visitProofs[2]),
    ...Array.from(row.visitProofs[3]),
    ...Array.from(row.visitProofs[4]),
    ...Array.from(row.annualProofs),
    ...Array.from(row.orgProofs),
  ]));
  row.proofFiles = Array.from(row.sourceFilesSet);
}

function publicRow(row: MutableCoverageRow): MonitoringCoverageRow {
  applyMissingRequirement(row);
  const { visitProofs, annualProofs, orgProofs, sourceModulesSet, sourceFilesSet, ...rest } = row;
  return rest;
}

export function buildMonitoringCoverage(sources: MonitoringSource[]): MonitoringCoverageAnalytics {
  const monitoringSources = sources.filter((source) => MONITORING_SOURCE_TYPES.includes(source.sourceType)).map(withSecondRowHeaders);
  const units = new Map<string, MutableCoverageRow>();
  let rowsProcessed = 0;
  let matchedRecords = 0;
  let unmatchedRecords = 0;
  let orgAssessmentMatches = 0;
  let annualAssessmentMatches = 0;
  let monitoringRowsBeforeFilter = 0;
  const monitoringAssociationKeys = new Set<string>();
  const monitoringIndividualKeys = new Set<string>();
  const detectedSources: MonitoringCoverageAnalytics["debug"]["detectedSources"] = [];
  const headersDetected: Record<string, string[]> = {};
  const rowsReadPerModule: Record<string, number> = {};
  const exactColumnsFound: Record<string, Record<string, boolean>> = {};

  for (const source of monitoringSources) {
    const headers = source.headers || [];
    const rows = source.rows || [];
    const sourceModuleForDebug = moduleName(source.sourceType);
    headersDetected[sourceModuleForDebug] = Array.from(new Set([...(headersDetected[sourceModuleForDebug] || []), ...headers]));
    rowsReadPerModule[sourceModuleForDebug] = (rowsReadPerModule[sourceModuleForDebug] || 0) + rows.length;
    exactColumnsFound[sourceModuleForDebug] = exactColumnMap(headers);
    detectedSources.push({
      sourceModule: sourceModuleForDebug,
      sourceFile: sourceFile(source),
      rowsProcessed: rows.length,
      keyColumns: sourceKeyColumns(headers),
    });
    for (const row of rows) {
      rowsProcessed += 1;
      const sourceModule = moduleName(source.sourceType);
      const file = sourceFile(source);
      const sourceType = canonicalMonitoringSourceType(source.sourceType);
      if (sourceType === "SLPIS_MONITORING_INDIVIDUAL_MODULE") {
        monitoringRowsBeforeFilter += 1;
        const identity = participantIdIdentity(row, headers);
        if (identity.key) monitoringIndividualKeys.add(identity.key);
        const unit = getOrCreateUnit(units, "Individual", identity, source);
        if (!unit) { unmatchedRecords += 1; continue; }
        matchedRecords += 1;
        const visit = normalizeVisitNumber(exactValue(row, headers, "Visit") || value(row, headers, VISIT_VALUE_HEADERS));
        const visits = visit ? new Set<1 | 2 | 3 | 4>([visit]) : visitNumbersFromRow(row, headers);
        for (const visit of visits) {
          unit.visits[visit] = "Completed";
          unit.visitProofs[visit].add(sourceModule);
          unit.sourceFilesSet.add(file);
        }
        continue;
      }
      if (sourceType === "SLPIS_MONITORING_ASSOCIATION_MODULE") {
        monitoringRowsBeforeFilter += 1;
        const identity = projectIdIdentity(row, headers);
        if (identity.key) monitoringAssociationKeys.add(identity.key);
        const unit = getOrCreateUnit(units, "Association", identity, source);
        if (!unit) { unmatchedRecords += 1; continue; }
        matchedRecords += 1;
        const visit = normalizeVisitNumber(exactValue(row, headers, "Visit") || value(row, headers, VISIT_VALUE_HEADERS));
        const visits = visit ? new Set<1 | 2 | 3 | 4>([visit]) : visitNumbersFromRow(row, headers);
        for (const visit of visits) {
          unit.visits[visit] = "Completed";
          unit.visitProofs[visit].add(sourceModule);
          unit.sourceFilesSet.add(file);
        }
        continue;
      }
      if (sourceType === "SLPIS_ANNUAL_ASSESSMENT_MODULE") {
        const { type } = annualIdentity(row, headers);
        const keyedIdentity = type === "Association" ? projectIdIdentity(row, headers) : participantIdIdentity(row, headers);
        const assessmentVisit = exactValue(row, headers, "Assessment Visit") || value(row, headers, ASSESSMENT_VISIT_HEADERS);
        if (!isAffirmative(assessmentVisit)) { unmatchedRecords += 1; continue; }
        const unit = getOrCreateUnit(units, type, keyedIdentity, source);
        if (!unit) { unmatchedRecords += 1; continue; }
        matchedRecords += 1;
        annualAssessmentMatches += 1;
        unit.annualAssessment = "Completed";
        unit.annualProofs.add(sourceModule);
        unit.sourceFilesSet.add(file);
        continue;
      }
      if (sourceType === "SLPIS_ORG_ASSESSMENT_MODULE") {
        const identity = projectIdIdentity(row, headers);
        const unit = getOrCreateUnit(units, "Association", identity, source);
        if (!unit) { unmatchedRecords += 1; continue; }
        matchedRecords += 1;
        orgAssessmentMatches += 1;
        unit.organizationalAssessment = "Completed";
        unit.orgProofs.add(sourceModule);
        unit.sourceFilesSet.add(file);
      }
    }
  }

  const rows = Array.from(units.values()).map(publicRow).sort((a, b) => {
    const muni = String(a.municipality).localeCompare(String(b.municipality));
    if (muni) return muni;
    return a.monitoringUnitName.localeCompare(b.monitoringUnitName);
  });

  const summary: MonitoringCoverageSummary = {
    firstVisit: rows.filter((row) => row.visits[1] === "Completed").length,
    secondVisit: rows.filter((row) => row.visits[2] === "Completed").length,
    thirdVisit: rows.filter((row) => row.visits[3] === "Completed").length,
    fourthVisit: rows.filter((row) => row.visits[4] === "Completed").length,
    organizationalAssessment: rows.filter((row) => row.type === "Association" && row.organizationalAssessment === "Completed").length,
    annualAssessment: rows.filter((row) => row.annualAssessment === "Completed").length,
    missingMonitoringVisits: rows.filter((row) => ([1, 2, 3, 4] as const).some((visit) => row.visits[visit] !== "Completed")).length,
    missingAssessments: rows.filter((row) => row.annualAssessment !== "Completed" || (row.type === "Association" && row.organizationalAssessment !== "Completed")).length,
    totalUnits: rows.length,
  };

  const byMunicipality = AURORA_MUNICIPALITIES.map((municipality) => {
    const municipalityRows = rows.filter((row) => row.municipality === municipality);
    return {
      municipality,
      totalUnits: municipalityRows.length,
      firstVisit: municipalityRows.filter((row) => row.visits[1] === "Completed").length,
      secondVisit: municipalityRows.filter((row) => row.visits[2] === "Completed").length,
      thirdVisit: municipalityRows.filter((row) => row.visits[3] === "Completed").length,
      fourthVisit: municipalityRows.filter((row) => row.visits[4] === "Completed").length,
      organizationalAssessment: municipalityRows.filter((row) => row.type === "Association" && row.organizationalAssessment === "Completed").length,
      annualAssessment: municipalityRows.filter((row) => row.annualAssessment === "Completed").length,
      missingMonitoringVisits: municipalityRows.filter((row) => ([1, 2, 3, 4] as const).some((visit) => row.visits[visit] !== "Completed")).length,
      missingAssessments: municipalityRows.filter((row) => row.annualAssessment !== "Completed" || (row.type === "Association" && row.organizationalAssessment !== "Completed")).length,
    };
  });

  const debug = {
    detectedSources,
    filesScanned: monitoringSources.length,
    headerRowUsed: monitoringSources.map((source) => Number(source.headerRowIndex ?? 0)).sort((a, b) => a - b)[0] ?? 0,
    headersDetected,
    rowsReadPerModule,
    exactColumnsFound,
    monitoringRowsBeforeFilter,
    rowsProcessed,
    monitoringUnitsCreated: rows.length,
    monitoringUnitsAfterMerge: monitoringAssociationKeys.size + monitoringIndividualKeys.size,
    associationUnits: monitoringAssociationKeys.size,
    individualUnits: monitoringIndividualKeys.size,
    matchedRecords,
    unmatchedRecords,
    visitCounts: {
      "1st Visit": summary.firstVisit,
      "2nd Visit": summary.secondVisit,
      "3rd Visit": summary.thirdVisit,
      "4th Visit": summary.fourthVisit,
    },
    organizationalAssessmentCounts: summary.organizationalAssessment,
    annualAssessmentCounts: summary.annualAssessment,
    orgAssessmentMatches,
    annualAssessmentMatches,
    barangayCount: new Set(rows.map((row) => `${row.municipality}|${row.barangay}`)).size,
    activeFilters: {
      municipality: "all",
      type: "all",
      visitStatus: "all",
      assessmentStatus: "all",
      sourceModule: "all",
    },
  };

  console.log("monitoringCoverageDebug", debug);

  return { summary, byMunicipality, rows, debug };
}
