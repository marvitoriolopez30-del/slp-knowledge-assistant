import type { SourceType } from "../config/dataSourceRegistry.ts";
import { normalizeText } from "./headerNormalizer.ts";

export type RetrievalPlan = {
  intent: string;
  sourceTypes: SourceType[];
  reason: string;
};

export type QueryRoute = {
  intent: string;
  confidence: "high" | "medium" | "low";
  confidenceScore: number;
  primarySourceTypes: SourceType[];
  secondarySourceTypes: SourceType[];
  retrievalMode: "structured" | "classified_document" | "rag_text" | "download" | "cross_check" | "clarify";
  reason: string;
  extractedEntities: Record<string, string>;
  fallbackStrategy: string;
};

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

export function routeUserQuery(question: string, conversationContext: { previousSources?: string[] } = {}): QueryRoute {
  const q = normalizeText(question);
  const has = (pattern: RegExp) => pattern.test(q);
  const previous = (conversationContext.previousSources || []).join(" ");
  const extractedEntities: Record<string, string> = {};
  const fileMatch = question.match(/([A-Za-z0-9][^"'`\n\r]*?\.(?:docx?|pdf|xlsx?|csv|txt|png|jpe?g|webp))/i);
  if (fileMatch) extractedEntities.fileName = fileMatch[1].trim();
  const municipalityMatch = question.match(/\b(Baler|Casiguran|Dilasag|Dinalungan|Dingalan|Dipaculao|Maria Aurora|San Luis)\b/i);
  if (municipalityMatch) extractedEntities.municipality = municipalityMatch[1];

  const route = (
    intent: string,
    confidence: QueryRoute["confidence"],
    primarySourceTypes: SourceType[],
    secondarySourceTypes: SourceType[],
    retrievalMode: QueryRoute["retrievalMode"],
    reason: string,
    fallbackStrategy = "If no verified answer is found, report relevant sources checked and missing source types."
  ): QueryRoute => ({
    intent,
    confidence,
    confidenceScore: confidence === "high" ? 0.92 : confidence === "medium" ? 0.68 : 0.35,
    primarySourceTypes: unique(primarySourceTypes),
    secondarySourceTypes: unique(secondarySourceTypes),
    retrievalMode,
    reason,
    extractedEntities,
    fallbackStrategy,
  });

  if (has(/\b(copy|download|send me|give me|have a copy|file|docx|pdf|xlsx|document)\b/) && has(/\b(copy|download|send|give|file|document|template|proposal|guideline|annex|memo|pdf|docx|xlsx)\b/)) {
    return route("document_download", "high", [], [], "download", "Copy/download request must search original uploaded file metadata first.", "Use previous cited source only for follow-up wording such as that/this/previous document.");
  }
  if (has(/duplicate|cross check|cross-check|compare|match between|check duplicate|possible duplicate/)) return route("duplicate_check", "high", ["SLPIS_PERSONAL_MODULE", "SLP_DPT_AURORA_DATABASE"], [], "cross_check", "Duplicate and cross-check questions compare Personal Module against SLP DPT/Aurora records.");
  if (has(/guideline|guidelines|policy|rules|implementation process|mc 03|mc03|omnibus|eligibility|definition|define|meaning|what is slp|what are slp|sustainable livelihood program|phase|phases|program process/)) return route("guideline_question", "high", ["GUIDELINES", "OTHER_DOCUMENTS"], [], "rag_text", "Policy, definition, phases, eligibility, and implementation-process questions route to Guidelines and supporting documents.");
  if (has(/template|form|tool|annex|format|market map|market assessment|assessment tool|report format|buyers|suppliers/)) return route("template_question", "high", ["TEMPLATES"], [], "classified_document", "Template/form/tool questions route to Templates using document classification metadata first.");
  if (has(/proposal|narrative|approved project document|fishpond proposal|proposal about|proposal for/)) return route("proposal_question", "high", ["PROPOSAL"], [], "classified_document", "Proposal content questions route to Proposal documents and proposal metadata.");
  if (has(/photo|image|picture|activity photo|monitoring photo|project photo/)) return route("image_question", "high", ["IMAGE"], [], "rag_text", "Photo/image questions route to Image sources.");
  if (has(/memo|memorandum|reference|supporting document|advisory/)) return route("other_document_question", "high", ["OTHER_DOCUMENTS"], ["GUIDELINES"], "rag_text", "Memo/reference/supporting-document questions route to Other Documents first.");
  if (has(/fund source|fundsource|slp unique id|aurora database|slp dpt|local database|dpt gur|dpt monitoring/)) return route("dpt_question", "high", ["SLP_DPT_AURORA_DATABASE"], [], "structured", "SLP DPT/local database questions route to SLP DPT Aurora Database.");
  if (has(/gur|grant utilization|conducted gur|not conducted gur/)) return route("gur_status", "high", ["SLPIS_GUR_MODULE", "SLPIS_PROJECT_MODULE"], [], "structured", "GUR conducted/not conducted questions require GUR Module with Project Module context.");
  if (has(/training|training title|capability building|trained|orientation/) && !has(/program orientation|slp orientation|sustainable livelihood program orientation/)) return route("training_question", "high", ["SLPIS_TRAINING_MODULE"], ["SLPIS_PERSONAL_MODULE", "SLPIS_PROJECT_MODULE"], "structured", "Training participation/title questions route to Training Module.");
  if (has(/operational|closed|not operational|non operational|monitoring|status gur|in operation|functional|inactive/)) return route("monitoring_status", "high", ["SLPIS_MONITORING_INDIVIDUAL_MODULE", "SLPIS_MONITORING_ASSOCIATION_MODULE", "SLPIS_PROJECT_MODULE"], [], "structured", "Operational/closed status comes from Monitoring modules, joined to Project Module when names are needed.");
  if (has(/top project|top projects|project count|project name|enterprise|association enterprise|individual enterprise|project type|livelihood project|grant code/)) return route("project_analytics", "high", ["SLPIS_PROJECT_MODULE"], [], "structured", "Project/enterprise questions route to Project Module.");
  if (has(/participant|beneficiary|pwd|4ps|pantawid|sex|civil status|encoded|target participant|profile|participants in|participants are/)) {
    const intent = has(/\b(find|lookup|search|profile|record|details|named|called)\b/) ? "participant_lookup" : "participant_count";
    return route(intent, "high", ["SLPIS_PERSONAL_MODULE"], [], "structured", "Participant count/profile questions route to Personal Module.");
  }

  const previousLower = normalizeText(previous);
  if (previousLower.includes("proposal")) return route("proposal_question", "medium", ["PROPOSAL"], ["OTHER_DOCUMENTS"], "classified_document", "Conversation context mentions proposal; route to Proposal documents.");
  if (previousLower.includes("template") || previousLower.includes("annex")) return route("template_question", "medium", ["TEMPLATES"], ["OTHER_DOCUMENTS"], "classified_document", "Conversation context mentions template/annex; route to classified templates.");
  if (previousLower.includes("guideline") || previousLower.includes("mc")) return route("guideline_question", "medium", ["GUIDELINES", "OTHER_DOCUMENTS"], [], "rag_text", "Conversation context mentions guidelines; route to Guidelines and supporting documents.");

  return route("unclear", "low", [], [], "clarify", "No confident source route detected. Do not default to Personal Module or global random RAG.", "Search classified metadata across all documents first; if still unclear, list possible sources checked.");
}

export function createRetrievalPlan(question: string): RetrievalPlan {
  const route = routeUserQuery(question);
  return { intent: route.intent, sourceTypes: [...route.primarySourceTypes, ...route.secondarySourceTypes], reason: route.reason };
}
