import { DOCUMENT_TYPE_RULES, documentTypeRule, type DocumentType } from "../config/documentTypeRegistry.ts";
import type { SourceType } from "../config/dataSourceRegistry.ts";

export type ClassifyDocumentInput = {
  fileId?: string;
  originalFileName: string;
  folder?: string;
  subFolder?: string;
  sourceType?: SourceType | string;
  extractedText?: string;
  mimeType?: string;
  sheetNames?: string[];
  detectedHeaders?: string[];
  sampleRows?: Array<Record<string, any>> | string[];
};

export type DocumentClassification = {
  documentType: DocumentType;
  documentPurpose: string;
  documentStage: string;
  keywords: string[];
  relatedTopics: string[];
  confidence: number;
  reason: string;
  matchedFilenamePatterns: string[];
  matchedKeywordPatterns: string[];
  matchedSynonymPatterns: string[];
  matchedNegativePatterns: string[];
  warnings: string[];
  matchedPatterns: Record<string, string[]>;
  scores: Record<string, number>;
};

function norm(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPattern(haystack: string, pattern: string) {
  const normalizedPattern = norm(pattern);
  if (!normalizedPattern) return false;
  return haystack.includes(normalizedPattern);
}

function matchPatterns(haystack: string, patterns: string[]) {
  return patterns.filter((pattern) => containsPattern(haystack, pattern));
}

function documentStageFromSubFolder(subFolder = "", folder = "") {
  const label = String(subFolder || "").trim();
  if (label) return label;
  const normalized = norm(folder);
  if (normalized.includes("social preparation")) return "Social Preparation Stage";
  if (normalized.includes("implementation")) return "Implementation Stage";
  if (normalized.includes("monitoring")) return "Monitoring Stage";
  if (normalized.includes("proposal")) return "Proposal";
  return "";
}

function fallbackType(sourceType = "", folder = ""): DocumentType {
  const source = String(sourceType || "").toUpperCase();
  const normalizedFolder = norm(folder);
  if (source === "TEMPLATES" || normalizedFolder.includes("template")) return "OTHER_TEMPLATE";
  if (source === "PROPOSAL" || normalizedFolder.includes("proposal")) return "PROPOSAL";
  if (source === "GUIDELINES" || normalizedFolder.includes("guideline")) return "GUIDELINES";
  return "OTHER_DOCUMENT";
}

function firstLines(text = "", count = 10) {
  if (text.trim().startsWith("{\"__slpWorkbook\"")) return "";
  return text.replace(/\r/g, "").split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, count).join(" ");
}

export function classifyDocument(input: ClassifyDocumentInput): DocumentClassification {
  const sourceType = String(input.sourceType || "UNKNOWN").toUpperCase();
  const filename = norm(input.originalFileName || "");
  const folder = norm(input.folder || "");
  const subFolder = norm(input.subFolder || "");
  const text = norm(String(input.extractedText || "").slice(0, 60000));
  const titleAndHeadings = norm(firstLines(input.extractedText || "", 14));
  const sheetText = norm([
    ...(input.sheetNames || []),
    ...(input.detectedHeaders || []),
    ...(input.sampleRows || []).map((row) => typeof row === "string" ? row : Object.values(row || {}).join(" ")),
  ].join(" "));
  const isSpreadsheet = /spreadsheet|excel|csv|xlsx|xls/i.test(String(input.mimeType || input.originalFileName || ""));
  const stage = documentStageFromSubFolder(input.subFolder, input.folder);

  const candidates = DOCUMENT_TYPE_RULES.map((rule) => {
    let score = 0;
    const reasons: string[] = [];
    const sourceAllowed = rule.allowedSourceTypes.includes(sourceType as SourceType);
    if (sourceAllowed) {
      score += 20;
      reasons.push(`source_type matched ${sourceType}`);
    } else if (rule.documentType.startsWith("OTHER_")) {
      score += 5;
    } else if (rule.allowedSourceTypes.length) {
      score -= 25;
    }

    const filenameMatches = matchPatterns(filename, rule.filenamePatterns);
    if (filenameMatches.length) {
      const strong = filenameMatches.some((pattern) => {
        const p = norm(pattern);
        return filename === p || filename.includes(p) || p.split(" ").filter(Boolean).length >= 2;
      });
      score += strong ? 50 : 25;
      reasons.push(`filename matched ${filenameMatches.join(", ")}`);
    }

    const headingMatches = matchPatterns(titleAndHeadings, [...rule.filenamePatterns, ...rule.keywordPatterns]);
    if (headingMatches.length) {
      score += 30;
      reasons.push(`title/heading matched ${headingMatches.slice(0, 4).join(", ")}`);
    }

    const keywordMatches = matchPatterns(text, rule.keywordPatterns);
    if (keywordMatches.length) {
      score += Math.min(40, keywordMatches.length * 5);
      reasons.push(`keywords matched ${keywordMatches.slice(0, 6).join(", ")}`);
    }

    const synonymMatches = matchPatterns(text, rule.synonymPatterns);
    if (synonymMatches.length) {
      score += Math.min(30, synonymMatches.length * 3);
      reasons.push(`synonyms matched ${synonymMatches.slice(0, 5).join(", ")}`);
    }

    const sheetMatches = isSpreadsheet ? matchPatterns(sheetText, [...rule.filenamePatterns, ...rule.keywordPatterns, ...rule.synonymPatterns]) : [];
    if (sheetMatches.length) {
      score += 30;
      reasons.push(`sheet/header matched ${sheetMatches.slice(0, 5).join(", ")}`);
    }

    if (subFolder && [...rule.filenamePatterns, ...rule.keywordPatterns].some((pattern) => containsPattern(subFolder, pattern))) {
      score += 10;
      reasons.push("subfolder/stage matched");
    }

    const negativeMatches = matchPatterns(`${filename} ${titleAndHeadings} ${text} ${sheetText}`, rule.negativePatterns);
    if (negativeMatches.length) {
      score -= 50 * negativeMatches.length;
      reasons.push(`negative pattern hit ${negativeMatches.join(", ")}`);
    }

    return {
      rule,
      score,
      tieBreaker: rule.priorityScore,
      reasons,
      filenameMatches,
      keywordMatches,
      synonymMatches,
      negativeMatches,
      sheetMatches,
      headingMatches,
    };
  }).sort((a, b) => b.score - a.score || b.tieBreaker - a.tieBreaker);

  let best = candidates[0];
  const warnings: string[] = [];
  if (!best || best.score < 45) {
    const fallback = fallbackType(sourceType, input.folder || "");
    const fallbackRule = documentTypeRule(fallback) || DOCUMENT_TYPE_RULES.find((rule) => rule.documentType === "OTHER_DOCUMENT")!;
    best = {
      rule: fallbackRule,
      score: Math.max(20, best?.score || 0),
      tieBreaker: fallbackRule.priorityScore,
      reasons: ["Low confidence; used source folder fallback."],
      filenameMatches: [],
      keywordMatches: [],
      synonymMatches: [],
      negativeMatches: [],
      sheetMatches: [],
      headingMatches: [],
    };
    warnings.push("Classification needs review.");
  } else if (candidates[1] && best.score - candidates[1].score < 12 && candidates[1].score >= 45) {
    warnings.push(`Classification needs review. Alternative: ${candidates[1].rule.displayName}.`);
  }

  const matchedKeywords = Array.from(new Set([...best.rule.defaultKeywords, ...best.keywordMatches, ...best.synonymMatches].map((item) => item.trim()).filter(Boolean))).slice(0, 14);
  const relatedTopics = Array.from(new Set([...best.rule.relatedUserQuestions, ...matchedKeywords].map((item) => item.trim()).filter(Boolean))).slice(0, 12);
  const confidence = Math.max(0, Math.min(100, Math.round(best.score)));

  return {
    documentType: best.rule.documentType,
    documentPurpose: best.rule.purpose,
    documentStage: stage,
    keywords: matchedKeywords,
    relatedTopics,
    confidence,
    reason: best.reasons.join("; ") || "Classified by source folder and registry fallback.",
    matchedFilenamePatterns: best.filenameMatches,
    matchedKeywordPatterns: best.keywordMatches,
    matchedSynonymPatterns: best.synonymMatches,
    matchedNegativePatterns: best.negativeMatches,
    warnings,
    matchedPatterns: {
      filename: best.filenameMatches,
      keyword: best.keywordMatches,
      synonym: best.synonymMatches,
      negative: best.negativeMatches,
      heading: best.headingMatches,
      spreadsheet: best.sheetMatches,
    },
    scores: Object.fromEntries(candidates.slice(0, 8).map((candidate) => [candidate.rule.documentType, candidate.score])),
  };
}

export function documentTypeDisplayName(documentType = "") {
  return documentTypeRule(documentType)?.displayName || documentType || "Other Document";
}

