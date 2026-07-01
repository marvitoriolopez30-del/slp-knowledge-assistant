import type { SourceType } from "./dataSourceRegistry.ts";

export type DocumentType =
  | "GUIDELINES"
  | "MEMORANDUM"
  | "UNIFIED_MOA"
  | "REGIONAL_MOA"
  | "SPECIFIC_IMPLEMENTATION_AGREEMENT"
  | "OTHER_DOCUMENT"
  | "PROPOSAL"
  | "APPROVED_PROPOSAL"
  | "PROJECT_PROPOSAL_TEMPLATE"
  | "NARRATIVE_REPORT"
  | "MARKET_ASSESSMENT_TOOL"
  | "PROJECT_ASSESSMENT_TOOL"
  | "MODALITY_APPLICATION_FORM"
  | "SLPA_CONSTITUTION_BY_LAWS"
  | "GRANT_ACKNOWLEDGEMENT_RECEIPT"
  | "ACTIVITY_DESIGN"
  | "ATTENDANCE_SHEET"
  | "MONITORING_FORM"
  | "GUR_FORM"
  | "TRAINING_FORM"
  | "DISASTER_AFFECTED_CERTIFICATION"
  | "AREA_BASED_CONVERGENCE_CERTIFICATION"
  | "OTHER_TEMPLATE"
  | "C_MLAMM_MATRIX"
  | "PLAMM_MATRIX"
  | "RLAMM_MATRIX"
  | "BARANGAY_RANKING_MATRIX";

export type DocumentTypeRule = {
  documentType: DocumentType;
  displayName: string;
  allowedSourceTypes: SourceType[];
  filenamePatterns: string[];
  keywordPatterns: string[];
  synonymPatterns: string[];
  negativePatterns: string[];
  purpose: string;
  defaultKeywords: string[];
  relatedUserQuestions: string[];
  priorityScore: number;
};

const templateSources: SourceType[] = ["TEMPLATES", "OTHER_DOCUMENTS"];
const matrixSources: SourceType[] = ["TEMPLATES", "GUIDELINES", "OTHER_DOCUMENTS"];

export const DOCUMENT_TYPE_RULES: DocumentTypeRule[] = [
  {
    documentType: "GUIDELINES",
    displayName: "Guidelines",
    allowedSourceTypes: ["GUIDELINES", "OTHER_DOCUMENTS"],
    filenamePatterns: ["guideline", "guidelines", "manual", "memorandum circular", "mc"],
    keywordPatterns: ["policy", "implementation process", "eligibility", "rules", "procedures", "standards"],
    synonymPatterns: ["program guide", "implementation guide", "circular"],
    negativePatterns: [],
    purpose: "Official policy, rules, and implementation guidance.",
    defaultKeywords: ["policy", "implementation", "guidelines", "eligibility", "procedures"],
    relatedUserQuestions: ["what are the guidelines", "implementation process", "policy for SLP"],
    priorityScore: 80,
  },
  {
    documentType: "MEMORANDUM",
    displayName: "Memorandum",
    allowedSourceTypes: ["OTHER_DOCUMENTS", "GUIDELINES"],
    filenamePatterns: ["memo", "memorandum", "advisory"],
    keywordPatterns: ["memorandum", "for compliance", "for information", "subject", "regional director"],
    synonymPatterns: ["notice", "advisory", "reference memo"],
    negativePatterns: [],
    purpose: "Official memo, advisory, or reference communication.",
    defaultKeywords: ["memo", "memorandum", "advisory", "subject"],
    relatedUserQuestions: ["do you have a memo", "memorandum about SLP"],
    priorityScore: 75,
  },
  {
    documentType: "UNIFIED_MOA",
    displayName: "Unified Memorandum of Agreement",
    allowedSourceTypes: templateSources,
    filenamePatterns: ["unified memorandum of agreement", "unified moa"],
    keywordPatterns: ["unified memorandum of agreement", "DSWD", "C/MLGU", "partnership", "social protection programs", "responsibilities of the parties", "local government unit"],
    synonymPatterns: ["LGU partnership agreement", "unified agreement"],
    negativePatterns: [],
    purpose: "Used as a partnership agreement between DSWD and the City/Municipal LGU for social protection programs and PPAs.",
    defaultKeywords: ["MOA", "DSWD", "LGU", "partnership", "social protection"],
    relatedUserQuestions: ["what agreement should be used with LGU", "unified moa", "partnership agreement"],
    priorityScore: 95,
  },
  {
    documentType: "REGIONAL_MOA",
    displayName: "Regional Memorandum of Agreement",
    allowedSourceTypes: templateSources,
    filenamePatterns: ["regional memorandum of agreement", "regional moa"],
    keywordPatterns: ["regional memorandum of agreement", "Sustainable Livelihood Program", "SLP", "DSWD Field Office", "C/MLGU", "partnership", "implementation of SLP"],
    synonymPatterns: ["regional agreement", "regional SLP MOA"],
    negativePatterns: [],
    purpose: "Used as a regional-level SLP partnership agreement between DSWD Field Office and LGU.",
    defaultKeywords: ["regional MOA", "SLP", "DSWD Field Office", "LGU"],
    relatedUserQuestions: ["regional moa", "regional level SLP agreement"],
    priorityScore: 95,
  },
  {
    documentType: "SPECIFIC_IMPLEMENTATION_AGREEMENT",
    displayName: "Specific Implementation Agreement",
    allowedSourceTypes: templateSources,
    filenamePatterns: ["specific implementation agreement", "sia"],
    keywordPatterns: ["specific implementation agreement", "implementation arrangements", "roles and responsibilities", "capability-building", "partnership engagement", "monitoring and evaluation", "SLP implementation"],
    synonymPatterns: ["SIA", "implementation agreement", "specific arrangements"],
    negativePatterns: [],
    purpose: "Used to detail the specific implementation arrangements, roles, responsibilities, monitoring, and support commitments for SLP.",
    defaultKeywords: ["SIA", "implementation agreement", "roles", "responsibilities", "monitoring"],
    relatedUserQuestions: ["what document should I use for SIA", "specific implementation agreement"],
    priorityScore: 95,
  },
  {
    documentType: "PROPOSAL",
    displayName: "Project Proposal",
    allowedSourceTypes: ["PROPOSAL"],
    filenamePatterns: ["proposal", "slpa", "fish", "fishpond", "hog", "rice", "sari", "vending", "farming", "livelihood"],
    keywordPatterns: ["proposal", "project cost", "beneficiaries", "livelihood", "implementation", "enterprise", "project description", "budget"],
    synonymPatterns: ["project plan", "livelihood proposal", "enterprise proposal"],
    negativePatterns: [],
    purpose: "Project proposal document containing proposed livelihood enterprise details.",
    defaultKeywords: ["proposal", "project cost", "beneficiaries", "livelihood", "enterprise"],
    relatedUserQuestions: ["do you have proposal for fish", "proposal about hog", "fishpond proposal"],
    priorityScore: 90,
  },
  {
    documentType: "APPROVED_PROPOSAL",
    displayName: "Approved Proposal",
    allowedSourceTypes: ["PROPOSAL"],
    filenamePatterns: ["approved proposal", "approved", "signed proposal"],
    keywordPatterns: ["approved", "funded", "grant", "project cost", "implementation"],
    synonymPatterns: ["signed project proposal", "funded proposal"],
    negativePatterns: [],
    purpose: "Approved or signed project proposal for livelihood implementation.",
    defaultKeywords: ["approved", "proposal", "funded", "grant"],
    relatedUserQuestions: ["approved proposal", "signed proposal"],
    priorityScore: 90,
  },
  {
    documentType: "PROJECT_PROPOSAL_TEMPLATE",
    displayName: "Project Proposal Template",
    allowedSourceTypes: ["TEMPLATES"],
    filenamePatterns: ["project proposal template", "mungkahing proyekto", "proposal template"],
    keywordPatterns: ["project title", "project description", "project cost", "target participants", "expected output"],
    synonymPatterns: ["proposal form", "proposal format"],
    negativePatterns: [],
    purpose: "Template used to prepare livelihood project proposals.",
    defaultKeywords: ["proposal template", "project title", "project cost"],
    relatedUserQuestions: ["proposal template", "template for project proposal"],
    priorityScore: 90,
  },
  {
    documentType: "MARKET_ASSESSMENT_TOOL",
    displayName: "Market Assessment Tool",
    allowedSourceTypes: ["TEMPLATES"],
    filenamePatterns: ["market", "market map", "market assessment", "market mapping", "assessment tool"],
    keywordPatterns: ["market", "buyers", "suppliers", "competitors", "demand", "pricing", "feasibility", "product", "customer", "market linkage"],
    synonymPatterns: ["consumer", "client", "purchaser", "local buyers", "target market", "market outlet", "selling area", "nearby barangays", "traders", "retailer", "wholesaler", "product outlet", "where to sell", "selling price", "source of supply", "raw materials", "available supplier", "existing business", "similar business", "competition", "product demand", "community demand", "viability", "marketing strategy", "who will buy", "where will the product be sold", "availability of supplies"],
    negativePatterns: [],
    purpose: "Used to assess market, buyers, suppliers, competitors, demand, pricing, product outlet, and feasibility of the livelihood project.",
    defaultKeywords: ["market map", "market assessment", "buyers", "suppliers", "pricing", "demand"],
    relatedUserQuestions: ["what template should I use for market map", "market map template", "form for market assessment", "buyers and suppliers template", "what document is used for market mapping"],
    priorityScore: 100,
  },
  {
    documentType: "PROJECT_ASSESSMENT_TOOL",
    displayName: "Project Assessment Tool",
    allowedSourceTypes: ["TEMPLATES"],
    filenamePatterns: ["project assessment", "assessment tool", "annex q", "q.3", "cblaf", "scf"],
    keywordPatterns: ["project assessment", "feasibility", "market", "buyers", "suppliers", "project viability", "resources", "livelihood project"],
    synonymPatterns: ["viability assessment", "project feasibility", "enterprise assessment"],
    negativePatterns: [],
    purpose: "Used to assess the proposed livelihood project including project viability, resources, and market feasibility.",
    defaultKeywords: ["project assessment", "feasibility", "viability", "resources", "market"],
    relatedUserQuestions: ["project assessment tool", "livelihood project viability"],
    priorityScore: 95,
  },
  {
    documentType: "MODALITY_APPLICATION_FORM",
    displayName: "Modality Application Form",
    allowedSourceTypes: ["TEMPLATES"],
    filenamePatterns: ["modality application", "application form", "annex k"],
    keywordPatterns: ["modality", "application", "applicant", "proposed project"],
    synonymPatterns: ["modality form"],
    negativePatterns: ["market map", "market assessment"],
    purpose: "Used for modality application documentation.",
    defaultKeywords: ["modality", "application", "applicant"],
    relatedUserQuestions: ["modality application form", "annex k"],
    priorityScore: 60,
  },
  {
    documentType: "SLPA_CONSTITUTION_BY_LAWS",
    displayName: "SLPA Constitution and By-Laws",
    allowedSourceTypes: ["TEMPLATES"],
    filenamePatterns: ["constitution", "by-laws", "by laws", "annex i"],
    keywordPatterns: ["constitution", "by-laws", "association", "officers", "membership"],
    synonymPatterns: ["bylaws", "organization rules"],
    negativePatterns: [],
    purpose: "Used for SLPA constitution and by-laws.",
    defaultKeywords: ["constitution", "by-laws", "association", "membership"],
    relatedUserQuestions: ["constitution and by laws", "SLPA by-laws"],
    priorityScore: 70,
  },
  {
    documentType: "GRANT_ACKNOWLEDGEMENT_RECEIPT",
    displayName: "Grant Acknowledgement Receipt",
    allowedSourceTypes: ["TEMPLATES"],
    filenamePatterns: ["grant acknowledgement", "acknowledgement receipt", "annex r"],
    keywordPatterns: ["grant", "acknowledgement", "receipt", "released", "received"],
    synonymPatterns: ["grant receipt", "acknowledgment receipt"],
    negativePatterns: [],
    purpose: "Used to acknowledge receipt of livelihood grant.",
    defaultKeywords: ["grant", "acknowledgement", "receipt"],
    relatedUserQuestions: ["annex r", "grant acknowledgement receipt"],
    priorityScore: 75,
  },
  {
    documentType: "DISASTER_AFFECTED_CERTIFICATION",
    displayName: "Certification of Disaster-Affected Individuals",
    allowedSourceTypes: templateSources,
    filenamePatterns: ["certification of disaster-affected individuals", "disaster-affected", "MC 3 S. 2025"],
    keywordPatterns: ["disaster-affected", "affected livelihood", "target participants", "SLP assistance", "certified list", "livelihood affected by disaster"],
    synonymPatterns: ["disaster affected participants", "certification for disaster victims"],
    negativePatterns: [],
    purpose: "Used to certify disaster-affected individuals as target participants for SLP assistance.",
    defaultKeywords: ["disaster-affected", "certification", "target participants", "SLP assistance"],
    relatedUserQuestions: ["certification for disaster affected participants", "disaster affected individuals"],
    priorityScore: 90,
  },
  {
    documentType: "AREA_BASED_CONVERGENCE_CERTIFICATION",
    displayName: "Certification for Area-Based Convergence Participants",
    allowedSourceTypes: templateSources,
    filenamePatterns: ["certification for area-based convergence participants", "area-based convergence"],
    keywordPatterns: ["area-based convergence", "eligible", "endorsed", "target program participants", "partner agency"],
    synonymPatterns: ["ABC participants", "area based convergence certification"],
    negativePatterns: [],
    purpose: "Used to certify and endorse area-based convergence participants as eligible target participants for SLP.",
    defaultKeywords: ["area-based convergence", "certification", "eligible", "endorsed"],
    relatedUserQuestions: ["certification for area based convergence participants"],
    priorityScore: 90,
  },
  {
    documentType: "C_MLAMM_MATRIX",
    displayName: "City/Municipal LAMM Matrix",
    allowedSourceTypes: matrixSources,
    filenamePatterns: ["C_MLAMM", "C MLAMM", "City MLAMM", "Municipal MLAMM"],
    keywordPatterns: ["LAMM", "city", "municipal", "matrix", "assessment", "planning"],
    synonymPatterns: ["CMLAMM", "city municipal LAMM"],
    negativePatterns: [],
    purpose: "Used as a city/municipal-level LAMM planning or assessment matrix.",
    defaultKeywords: ["C_MLAMM", "LAMM", "city", "municipal", "matrix"],
    relatedUserQuestions: ["C MLAMM", "municipal LAMM matrix"],
    priorityScore: 85,
  },
  {
    documentType: "PLAMM_MATRIX",
    displayName: "Provincial LAMM Matrix",
    allowedSourceTypes: matrixSources,
    filenamePatterns: ["PLAMM", "Provincial LAMM"],
    keywordPatterns: ["PLAMM", "provincial", "matrix", "assessment", "planning"],
    synonymPatterns: ["provincial matrix"],
    negativePatterns: [],
    purpose: "Used as a provincial-level LAMM planning or assessment matrix.",
    defaultKeywords: ["PLAMM", "provincial", "matrix"],
    relatedUserQuestions: ["PLAMM", "provincial LAMM"],
    priorityScore: 85,
  },
  {
    documentType: "RLAMM_MATRIX",
    displayName: "Regional LAMM Matrix",
    allowedSourceTypes: matrixSources,
    filenamePatterns: ["RLAMM", "Regional LAMM"],
    keywordPatterns: ["RLAMM", "regional", "matrix", "assessment", "planning"],
    synonymPatterns: ["regional matrix"],
    negativePatterns: [],
    purpose: "Used as a regional-level LAMM planning or assessment matrix.",
    defaultKeywords: ["RLAMM", "regional", "matrix"],
    relatedUserQuestions: ["RLAMM", "regional LAMM"],
    priorityScore: 85,
  },
  {
    documentType: "BARANGAY_RANKING_MATRIX",
    displayName: "Barangay Ranking Matrix",
    allowedSourceTypes: matrixSources,
    filenamePatterns: ["barangay ranking matrix", "annex e", "ranking matrix"],
    keywordPatterns: ["barangay", "ranking", "prioritization", "matrix", "score", "criteria"],
    synonymPatterns: ["barangay prioritization", "ranking tool"],
    negativePatterns: [],
    purpose: "Used to rank or prioritize barangays based on assessment criteria.",
    defaultKeywords: ["barangay", "ranking", "prioritization", "matrix", "criteria"],
    relatedUserQuestions: ["barangay prioritization matrix", "barangay ranking"],
    priorityScore: 90,
  },
  {
    documentType: "ACTIVITY_DESIGN",
    displayName: "Activity Design",
    allowedSourceTypes: templateSources,
    filenamePatterns: ["activity design", "ad"],
    keywordPatterns: ["activity title", "rationale", "objectives", "participants", "budgetary requirement"],
    synonymPatterns: ["activity proposal"],
    negativePatterns: [],
    purpose: "Used to prepare activity design for SLP-related activities.",
    defaultKeywords: ["activity design", "rationale", "objectives", "participants", "budget"],
    relatedUserQuestions: ["activity design", "activity proposal"],
    priorityScore: 80,
  },
  {
    documentType: "ATTENDANCE_SHEET",
    displayName: "Attendance Sheet",
    allowedSourceTypes: templateSources,
    filenamePatterns: ["attendance", "attendance sheet"],
    keywordPatterns: ["name", "signature", "sex", "age", "contact number"],
    synonymPatterns: ["attendance form", "sign-in sheet"],
    negativePatterns: [],
    purpose: "Used to document participant attendance.",
    defaultKeywords: ["attendance", "name", "signature", "participants"],
    relatedUserQuestions: ["attendance sheet", "participant attendance"],
    priorityScore: 80,
  },
  {
    documentType: "MONITORING_FORM",
    displayName: "Monitoring Form",
    allowedSourceTypes: templateSources,
    filenamePatterns: ["monitoring", "monitoring form"],
    keywordPatterns: ["status", "operational", "closed", "project visit", "monitoring"],
    synonymPatterns: ["validation form", "project monitoring"],
    negativePatterns: [],
    purpose: "Used for project monitoring and validation.",
    defaultKeywords: ["monitoring", "status", "operational", "closed"],
    relatedUserQuestions: ["monitoring form", "project visit form"],
    priorityScore: 80,
  },
  {
    documentType: "GUR_FORM",
    displayName: "Grant Utilization Report Form",
    allowedSourceTypes: templateSources,
    filenamePatterns: ["gur", "grant utilization"],
    keywordPatterns: ["grant utilization", "utilization", "project status", "operational", "closed"],
    synonymPatterns: ["GUR form", "utilization report"],
    negativePatterns: [],
    purpose: "Used for Grant Utilization Report documentation.",
    defaultKeywords: ["GUR", "grant utilization", "project status"],
    relatedUserQuestions: ["GUR form", "grant utilization report"],
    priorityScore: 80,
  },
  {
    documentType: "TRAINING_FORM",
    displayName: "Training Form",
    allowedSourceTypes: templateSources,
    filenamePatterns: ["training", "capability building"],
    keywordPatterns: ["training title", "training date", "participants", "resource person"],
    synonymPatterns: ["capability-building form", "training report"],
    negativePatterns: [],
    purpose: "Used for training or capability-building documentation.",
    defaultKeywords: ["training", "capability building", "participants", "resource person"],
    relatedUserQuestions: ["training form", "capability building form"],
    priorityScore: 80,
  },
  {
    documentType: "NARRATIVE_REPORT",
    displayName: "Narrative Report",
    allowedSourceTypes: ["PROPOSAL", "OTHER_DOCUMENTS"],
    filenamePatterns: ["narrative report", "narrative"],
    keywordPatterns: ["accomplishment", "narrative", "summary", "results", "highlights"],
    synonymPatterns: ["report narrative"],
    negativePatterns: [],
    purpose: "Narrative report or supporting write-up related to SLP implementation.",
    defaultKeywords: ["narrative", "report", "accomplishment"],
    relatedUserQuestions: ["narrative report", "project narrative"],
    priorityScore: 65,
  },
  {
    documentType: "OTHER_TEMPLATE",
    displayName: "Other Template",
    allowedSourceTypes: ["TEMPLATES"],
    filenamePatterns: [],
    keywordPatterns: [],
    synonymPatterns: [],
    negativePatterns: [],
    purpose: "Template or form not confidently classified under another type.",
    defaultKeywords: ["template", "form"],
    relatedUserQuestions: [],
    priorityScore: 20,
  },
  {
    documentType: "OTHER_DOCUMENT",
    displayName: "Other Document",
    allowedSourceTypes: ["OTHER_DOCUMENTS", "GUIDELINES"],
    filenamePatterns: [],
    keywordPatterns: [],
    synonymPatterns: [],
    negativePatterns: [],
    purpose: "Supporting document not confidently classified under another type.",
    defaultKeywords: ["document", "reference"],
    relatedUserQuestions: [],
    priorityScore: 20,
  },
];

export function documentTypeRule(documentType = "") {
  return DOCUMENT_TYPE_RULES.find((rule) => rule.documentType === documentType);
}

