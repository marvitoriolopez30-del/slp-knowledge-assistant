import { canonicalHeader, normalizeHeader } from "../lib/headerNormalizer.ts";

export type SourceType =
  | "GUIDELINES"
  | "SLPIS_PERSONAL_MODULE"
  | "SLPIS_PROJECT_MODULE"
  | "SLPIS_GUR_MODULE"
  | "SLPIS_TRAINING_MODULE"
  | "MD_MONITORING_INDIVIDUAL"
  | "MD_MONITORING_ASSOCIATION"
  | "MD_ANNUAL_ASSESSMENT"
  | "ORG_ASSESSMENT"
  | "SLPIS_MONITORING_INDIVIDUAL_MODULE"
  | "SLPIS_MONITORING_ASSOCIATION_MODULE"
  | "SLPIS_ANNUAL_ASSESSMENT_MODULE"
  | "SLPIS_ORG_ASSESSMENT_MODULE"
  | "SLP_DPT_AURORA_DATABASE"
  | "PROPOSAL"
  | "TEMPLATES"
  | "IMAGE"
  | "OTHER_DOCUMENTS"
  | "UNKNOWN";

export type DataSourceRegistryEntry = {
  sourceType: SourceType;
  displayName: string;
  folderNames: string[];
  subFolderNames: string[];
  requiredHeaders: string[];
  optionalHeaders: string[];
  primaryKeys: string[];
  purpose: string;
  usedFor: string[];
  retrievalPriority: number;
};

export const DATA_SOURCE_REGISTRY: DataSourceRegistryEntry[] = [
  { sourceType: "GUIDELINES", displayName: "Guidelines", folderNames: ["guidelines"], subFolderNames: [], requiredHeaders: [], optionalHeaders: [], primaryKeys: [], purpose: "Official policy and implementation guidance", usedFor: ["policy", "rules", "implementation process"], retrievalPriority: 90 },
  { sourceType: "SLPIS_PERSONAL_MODULE", displayName: "SLPIS Personal Module", folderNames: ["slpis"], subFolderNames: ["personal module", "personal"], requiredHeaders: ["participant_id", "municipality"], optionalHeaders: ["full_name", "first_name", "last_name", "barangay"], primaryKeys: ["participant_id"], purpose: "Participant profile and participant counts", usedFor: ["participants", "4ps", "pwd", "person lookup"], retrievalPriority: 100 },
  { sourceType: "SLPIS_PROJECT_MODULE", displayName: "SLPIS Project Module", folderNames: ["slpis"], subFolderNames: ["project module", "project"], requiredHeaders: ["project_id"], optionalHeaders: ["participant_id", "enterprise_type", "grant_code", "municipality"], primaryKeys: ["project_id"], purpose: "Projects, enterprises, project types, Project ID joins", usedFor: ["projects", "enterprise", "project type", "association", "individual enterprise"], retrievalPriority: 100 },
  { sourceType: "SLPIS_GUR_MODULE", displayName: "SLPIS GUR Module", folderNames: ["slpis"], subFolderNames: ["gur module", "grant utilization", "gur"], requiredHeaders: ["project_id"], optionalHeaders: ["grant_code", "municipality"], primaryKeys: ["project_id", "grant_code"], purpose: "Grant Utilization Report matching", usedFor: ["gur", "grant utilization"], retrievalPriority: 95 },
  { sourceType: "SLPIS_TRAINING_MODULE", displayName: "SLPIS Training Module", folderNames: ["slpis"], subFolderNames: ["training module", "training"], requiredHeaders: ["participant_id"], optionalHeaders: ["training_title", "municipality"], primaryKeys: ["participant_id"], purpose: "Training participation", usedFor: ["training"], retrievalPriority: 90 },
  { sourceType: "MD_MONITORING_INDIVIDUAL", displayName: "MD Monitoring Individual", folderNames: [], subFolderNames: ["mdmonitoringindividual"], requiredHeaders: [], optionalHeaders: ["participant_id", "project_id", "municipality", "barangay", "visit"], primaryKeys: ["participant_id"], purpose: "Individual monitoring visit coverage", usedFor: ["monitoring coverage", "visits"], retrievalPriority: 95 },
  { sourceType: "MD_MONITORING_ASSOCIATION", displayName: "MD Monitoring Association", folderNames: [], subFolderNames: ["mdmonitoringassociation"], requiredHeaders: [], optionalHeaders: ["project_id", "project_name", "municipality", "barangay", "visit"], primaryKeys: ["project_id"], purpose: "Association monitoring visit coverage", usedFor: ["monitoring coverage", "visits"], retrievalPriority: 95 },
  { sourceType: "MD_ANNUAL_ASSESSMENT", displayName: "MD Annual Assessment", folderNames: [], subFolderNames: ["mdannualassessment"], requiredHeaders: [], optionalHeaders: ["participant_id", "project_id", "municipality", "barangay"], primaryKeys: ["participant_id", "project_id"], purpose: "Annual assessment coverage", usedFor: ["annual assessment", "assessment coverage"], retrievalPriority: 95 },
  { sourceType: "ORG_ASSESSMENT", displayName: "Org Assessment", folderNames: [], subFolderNames: ["orgassessment"], requiredHeaders: [], optionalHeaders: ["project_id", "project_name", "municipality", "barangay"], primaryKeys: ["project_id"], purpose: "Organizational assessment coverage", usedFor: ["organizational assessment", "assessment coverage"], retrievalPriority: 95 },
  { sourceType: "SLPIS_MONITORING_INDIVIDUAL_MODULE", displayName: "SLPIS Monitoring Individual", folderNames: ["slpis"], subFolderNames: ["monitoring individual", "mdmonitoring individual", "md monitoring individual"], requiredHeaders: ["status_gur"], optionalHeaders: ["project_id", "grant_code", "municipality"], primaryKeys: ["project_id", "grant_code"], purpose: "Individual enterprise operational/closed status", usedFor: ["operational", "closed", "monitoring"], retrievalPriority: 95 },
  { sourceType: "SLPIS_MONITORING_ASSOCIATION_MODULE", displayName: "SLPIS Monitoring Association", folderNames: ["slpis"], subFolderNames: ["monitoring association", "mdmonitoring association", "md monitoring association"], requiredHeaders: ["status_gur"], optionalHeaders: ["project_id", "grant_code", "municipality"], primaryKeys: ["project_id", "grant_code"], purpose: "Association enterprise operational/closed status", usedFor: ["operational", "closed", "monitoring"], retrievalPriority: 95 },
  { sourceType: "SLPIS_ANNUAL_ASSESSMENT_MODULE", displayName: "MDAnnualAssessment", folderNames: ["slpis"], subFolderNames: ["mdannualassessment", "md annual assessment", "annual assessment"], requiredHeaders: [], optionalHeaders: ["participant_id", "project_id", "project_name", "municipality"], primaryKeys: ["participant_id", "project_id"], purpose: "Annual assessment coverage for monitoring units", usedFor: ["annual assessment", "assessment coverage"], retrievalPriority: 95 },
  { sourceType: "SLPIS_ORG_ASSESSMENT_MODULE", displayName: "OrgAssessment", folderNames: ["slpis"], subFolderNames: ["orgassessment", "org assessment", "organizational assessment", "organisation assessment"], requiredHeaders: [], optionalHeaders: ["project_id", "project_name", "municipality"], primaryKeys: ["project_id"], purpose: "Organizational assessment coverage for association projects", usedFor: ["organizational assessment", "assessment coverage"], retrievalPriority: 95 },
  { sourceType: "SLP_DPT_AURORA_DATABASE", displayName: "SLP DPT Aurora Database", folderNames: ["slp dpt"], subFolderNames: ["aurora database", "slp aurora database"], requiredHeaders: [], optionalHeaders: ["slp_unique_id", "fund_source", "full_name", "project_id"], primaryKeys: ["slp_unique_id", "project_id"], purpose: "Aurora local database and duplicate reference data", usedFor: ["fund source", "slp unique id", "duplicates", "cross check"], retrievalPriority: 85 },
  { sourceType: "PROPOSAL", displayName: "Proposal Documents", folderNames: ["proposal", "proposals"], subFolderNames: [], requiredHeaders: [], optionalHeaders: [], primaryKeys: [], purpose: "Project proposals and narratives", usedFor: ["proposal"], retrievalPriority: 80 },
  { sourceType: "TEMPLATES", displayName: "Templates", folderNames: ["templates"], subFolderNames: [], requiredHeaders: [], optionalHeaders: [], primaryKeys: [], purpose: "Forms, tools, report templates", usedFor: ["template", "form", "download"], retrievalPriority: 80 },
  { sourceType: "IMAGE", displayName: "Images", folderNames: ["image", "images"], subFolderNames: [], requiredHeaders: [], optionalHeaders: [], primaryKeys: [], purpose: "Photos and image evidence", usedFor: ["photos", "images"], retrievalPriority: 60 },
  { sourceType: "OTHER_DOCUMENTS", displayName: "Other Documents", folderNames: ["other documents", "other"], subFolderNames: [], requiredHeaders: [], optionalHeaders: [], primaryKeys: [], purpose: "Memos, references, supporting documents", usedFor: ["memo", "reference"], retrievalPriority: 50 },
];

export type DataSourceClassification = {
  sourceType: SourceType;
  confidence: number;
  matchedHeaders: string[];
  missingHeaders: string[];
  reason: string;
};

function norm(value = "") {
  return normalizeHeader(value);
}

function compactFileKey(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function classifyByNormalizedFilename(fileName = ""): DataSourceClassification | null {
  const file = compactFileKey(fileName);
  if (file.includes("mdmonitoringassociation")) {
    return { sourceType: "MD_MONITORING_ASSOCIATION", confidence: 100, matchedHeaders: [], missingHeaders: [], reason: "normalized filename matched mdmonitoringassociation" };
  }
  if (file.includes("mdmonitoringindividual")) {
    return { sourceType: "MD_MONITORING_INDIVIDUAL", confidence: 100, matchedHeaders: [], missingHeaders: [], reason: "normalized filename matched mdmonitoringindividual" };
  }
  if (file.includes("orgassessment")) {
    return { sourceType: "ORG_ASSESSMENT", confidence: 100, matchedHeaders: [], missingHeaders: [], reason: "normalized filename matched orgassessment" };
  }
  if (file.includes("mdannualassessment")) {
    return { sourceType: "MD_ANNUAL_ASSESSMENT", confidence: 100, matchedHeaders: [], missingHeaders: [], reason: "normalized filename matched mdannualassessment" };
  }
  return null;
}

function headerScore(headers: string[], entry: DataSourceRegistryEntry) {
  const canonical = headers.map(canonicalHeader).filter((header) => header !== "unknown");
  const matchedHeaders = [...entry.requiredHeaders, ...entry.optionalHeaders].filter((header) => canonical.includes(header as any));
  const missingHeaders = entry.requiredHeaders.filter((header) => !canonical.includes(header as any));
  const requiredMatches = entry.requiredHeaders.length - missingHeaders.length;
  const score = (requiredMatches * 25) + Math.min(35, matchedHeaders.length * 7);
  return { score, matchedHeaders, missingHeaders };
}

export function classifyDataSource(fileName = "", folderName = "", subFolderName = "", detectedHeaders: string[] = [], fileType = ""): DataSourceClassification {
  const filenameClassification = classifyByNormalizedFilename(fileName);
  if (filenameClassification) return filenameClassification;

  const folder = norm(folderName);
  const subFolder = norm(subFolderName);
  const file = norm(fileName);
  const type = norm(fileType);
  let best: DataSourceClassification = { sourceType: "UNKNOWN", confidence: 0, matchedHeaders: [], missingHeaders: [], reason: "No registry rule matched with enough confidence." };

  for (const entry of DATA_SOURCE_REGISTRY) {
    const folderMatch = entry.folderNames.some((name) => folder === norm(name) || folder.includes(norm(name)));
    const subFolderMatch = entry.subFolderNames.some((name) => subFolder.includes(norm(name)) || file.includes(norm(name)));
    const { score, matchedHeaders, missingHeaders } = headerScore(detectedHeaders, entry);
    let confidence = score;
    const reasons: string[] = [];
    if (folderMatch) { confidence += 55; reasons.push(`folder matched ${entry.displayName}`); }
    if (subFolderMatch) { confidence += 35; reasons.push("subfolder/file name matched"); }
    if (matchedHeaders.length) reasons.push(`headers matched: ${matchedHeaders.join(", ")}`);
    if (entry.sourceType === "IMAGE" && /image|png|jpg|jpeg|webp/.test(type)) confidence += 55;
    if (entry.sourceType === "GUIDELINES" && folderMatch) confidence = Math.max(confidence, 95);
    if (entry.sourceType === "PROPOSAL" && folderMatch) confidence = Math.max(confidence, 90);
    if (entry.sourceType === "TEMPLATES" && folderMatch) confidence = Math.max(confidence, 90);
    if (confidence > best.confidence) {
      best = { sourceType: entry.sourceType, confidence: Math.min(100, confidence), matchedHeaders, missingHeaders, reason: reasons.join("; ") || "header-based classification" };
    }
  }

  if (best.confidence < 45) return { ...best, sourceType: "UNKNOWN", confidence: best.confidence, reason: `Low confidence classification. ${best.reason}` };
  return best;
}

export function sourceDisplayName(sourceType: SourceType) {
  return DATA_SOURCE_REGISTRY.find((entry) => entry.sourceType === sourceType)?.displayName || sourceType;
}
