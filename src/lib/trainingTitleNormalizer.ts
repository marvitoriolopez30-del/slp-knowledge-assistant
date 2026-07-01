import { normalizeText } from "./headerNormalizer.ts";

export const OFFICIAL_TRAINING_TITLES = [
  "SLP ORIENTATION",
  "FINANCIAL LITERACY",
  "Microenterprise Development Training I",
  "Microenterprise Development Training II",
  "Organizational Development Leadership Training",
  "Leadership Training",
] as const;

export type OfficialTrainingTitle = typeof OFFICIAL_TRAINING_TITLES[number];

function compact(value = "") {
  return normalizeText(value).replace(/\s+/g, " ").trim();
}

export function normalizeTrainingTitle(value: unknown): OfficialTrainingTitle | "" {
  const normalized = compact(String(value ?? ""));
  if (!normalized) return "";

  if (/^(slp orientation|sustainable livelihood program orientation|program orientation|orientation)$/.test(normalized)) {
    return "SLP ORIENTATION";
  }

  if (/^(financial literacy|financial literacy training|financial education literacy|financial education literacy i|financial education and literacy|financial education|fel|fel i)$/.test(normalized)) {
    return "FINANCIAL LITERACY";
  }

  if (/^(microenterprise development training i|microenterprise development training 1|microenterprise development training medt|microenterprise development training|medt|medt i|medt 1|mdt i|mdt 1)$/.test(normalized)) {
    return "Microenterprise Development Training I";
  }

  if (/^(microenterprise development training ii|microenterprise development training 2|medt ii|medt 2|mdt ii|mdt 2)$/.test(normalized)) {
    return "Microenterprise Development Training II";
  }

  if (/^(organizational development leadership training|organizational development and leadership training|organizational leadership training|odlt|od leadership training)$/.test(normalized)) {
    return "Organizational Development Leadership Training";
  }

  if (/^(leadership training|basic leadership training|leadership|leaders training)$/.test(normalized)) {
    return "Leadership Training";
  }

  return "";
}

