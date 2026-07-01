import { useEffect, useMemo, useState } from "react";
import { Download, X } from "lucide-react";
import {
  Bar,
  BarChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ReactNode } from "react";
import {
  AURORA_MUNICIPALITIES,
  logMunicipalityNormalizationDebug,
  normalizeAuroraMunicipality,
  type DashboardAnalytics,
  type DashboardParsedFile,
  type LivelihoodSustainabilityRecord,
  type MunicipalityDrilldownRecord,
} from "../utils/dashboardAnalytics";

const STATUS_OPTIONS = ["Stable Income", "At Risk", "Possible Business Failure", "No Monitoring Data"];
const RATING_OPTIONS = ["Excellent / Success Project", "Good / Stable", "Fair / Needs Assistance", "At Risk / Low Earning", "Critical / Close to Bankruptcy", "Insufficient Data"];

function escapeCsv(value: unknown) {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function downloadCsv(fileName: string, headers: string[], rows: Array<Array<unknown>>) {
  const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function num(value: unknown) {
  const parsed = parseMoney(value);
  return parsed ?? 0;
}

function parseMoney(value: unknown) {
  const raw = String(value ?? "").replace(/[₱,]/g, "").trim();
  if (!raw) return null;
  const parsed = Number(raw.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: unknown) {
  const parsed = parseMoney(value);
  return parsed !== null ? `PHP ${parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Not encoded";
}

function display(value: unknown) {
  const text = String(value ?? "").trim();
  return text || "Not encoded";
}

function normalizeKey(value: unknown, removeCommas = false) {
  const raw = String(value ?? "");
  return (removeCommas ? raw.replace(/,/g, " ") : raw)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

function normalizeNameKey(value: unknown) {
  return normalizeKey(value, true);
}

function headersOfDataset(dataset: DashboardParsedFile) {
  return Array.isArray(dataset.headers) && dataset.headers.length
    ? dataset.headers
    : Object.keys(dataset.rows?.[0] || {});
}

function datasetLabel(dataset: DashboardParsedFile) {
  return [dataset.folder, dataset.moduleType, dataset.classification, dataset.sourceModule, dataset.fileName || dataset.originalName || dataset.sourceFile].filter(Boolean).join(" / ");
}

function headerMatches(headers: string[], aliases: string[]) {
  const normalizedHeaders = headers.map((header) => normalizeKey(header));
  return aliases.some((alias) => {
    const wanted = normalizeKey(alias);
    return normalizedHeaders.some((header) => header === wanted || header.includes(wanted) || wanted.includes(header));
  });
}

function readCell(row: Record<string, any>, headers: string[], aliases: string[]) {
  const normalizedAliases = aliases.map((alias) => normalizeKey(alias));
  const exact = headers.find((header) => normalizedAliases.includes(normalizeKey(header)));
  if (exact) return String(row[exact] ?? "").trim();
  const partial = headers.find((header) => {
    const normalized = normalizeKey(header);
    return normalizedAliases.some((alias) => normalized.includes(alias) || alias.includes(normalized));
  });
  return partial ? String(row[partial] ?? "").trim() : "";
}

function rowsFromDatasets(parsedFiles: DashboardParsedFile[], detector: (dataset: DashboardParsedFile, headers: string[]) => boolean) {
  return (parsedFiles || [])
    .filter((dataset) => detector(dataset, headersOfDataset(dataset)))
    .flatMap((dataset) => {
      const headers = headersOfDataset(dataset);
      return (dataset.rows || []).map((row) => ({
        row,
        headers,
        sourceName: datasetLabel(dataset) || "Parsed dashboard source",
        dataset,
      }));
    });
}

function isPersonalDataset(dataset: DashboardParsedFile, headers: string[]) {
  const label = normalizeKey(datasetLabel(dataset));
  return label.includes("PERSONAL MODULE") || label.includes("SLPIS PERSONAL") || headerMatches(headers, ["SLP Paricipant ID", "SLP Participant ID"]);
}

function isProjectDataset(dataset: DashboardParsedFile, headers: string[]) {
  const label = normalizeKey(datasetLabel(dataset));
  return label.includes("PROJECT MODULE") || (
    headerMatches(headers, ["Project ID"])
    && headerMatches(headers, ["Project Name"])
    && headerMatches(headers, ["Enterprise Type"])
    && headerMatches(headers, ["Grant Code"])
    && headerMatches(headers, ["Municipality"])
    && headerMatches(headers, ["Barangay"])
  );
}

function isMdIndividualDataset(_dataset: DashboardParsedFile, headers: string[]) {
  return headerMatches(headers, ["SLP Paricipant ID", "SLP Participant ID"])
    && headerMatches(headers, ["Ave. Monthly Net Income/Loss"])
    && headerMatches(headers, ["Cash at Bank"])
    && headerMatches(headers, ["Total Savings"])
    && headerMatches(headers, ["Date Monitored"])
    && headerMatches(headers, ["Visit"]);
}

function isMdAssociationDataset(_dataset: DashboardParsedFile, headers: string[]) {
  return headerMatches(headers, ["SLPA Name"])
    && headerMatches(headers, ["Grant Code"])
    && headerMatches(headers, ["Ave. Monthly Net Income/Loss"])
    && headerMatches(headers, ["Cash at Bank"])
    && headerMatches(headers, ["Total Savings"])
    && headerMatches(headers, ["Date Monitored"])
    && headerMatches(headers, ["Visit"]);
}

function visitNumber(value: unknown) {
  const normalized = normalizeKey(value);
  if (/\b(4|4TH|FOURTH)\b/.test(normalized)) return 4;
  if (/\b(3|3RD|THIRD)\b/.test(normalized)) return 3;
  if (/\b(2|2ND|SECOND)\b/.test(normalized)) return 2;
  if (/\b(1|1ST|FIRST)\b/.test(normalized)) return 1;
  return 0;
}

function dateValue(value: unknown) {
  const parsed = Date.parse(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function isLatestMonitoring(next: FallbackMonitoringRow, current?: FallbackMonitoringRow) {
  if (!current) return true;
  if (next.visit !== current.visit) return next.visit > current.visit;
  if (next.dateMonitored !== current.dateMonitored) return next.dateMonitored > current.dateMonitored;
  return next.updatedDate > current.updatedDate;
}

type FallbackMonitoringRow = {
  row: Record<string, any>;
  headers: string[];
  sourceName: string;
  visit: number;
  dateMonitored: number;
  updatedDate: number;
};

const FINANCIAL_COLUMNS = [
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
];

const FAILURE_RE = /\b(FAILED|FAILURE|CLOSED|STOPPED|DISCONTINUED|NOT OPERATING|BANKRUPT|INACTIVE|DISSOLVED|ABANDONED|TERMINATED|CEASED OPERATION)\b/;
const RISK_RE = /\b(RISK|LOW EARNING|LOSS|NEGATIVE|ISSUE|CONCERN|NEEDS ASSISTANCE|UNSTABLE|PENDING)\b/;

function monitoringKeys(row: Record<string, any>, headers: string[], type: "Individual" | "Association") {
  const participantId = readCell(row, headers, ["SLP Paricipant ID", "SLP Participant ID", "Participant ID"]);
  const grantCode = readCell(row, headers, ["Grant Code"]);
  const projectId = readCell(row, headers, ["Project ID"]);
  const name = readCell(row, headers, ["Name", "Participant Name", "Full Name"]);
  const slpaName = readCell(row, headers, ["SLPA Name", "Project Name", "Name of Project"]);
  const municipality = readCell(row, headers, ["Municipality"]);
  const barangay = readCell(row, headers, ["Barangay", "Brgy"]);
  return [
    type === "Individual" && participantId ? `PID:${normalizeKey(participantId)}` : "",
    grantCode ? `GRANT:${normalizeKey(grantCode)}` : "",
    projectId ? `PROJECT:${normalizeKey(projectId)}` : "",
    type === "Individual" && name && municipality && barangay ? `PERSON:${normalizeNameKey(name)}|${normalizeKey(municipality)}|${normalizeKey(barangay)}` : "",
    type === "Association" && slpaName && municipality && barangay ? `SLPA:${normalizeNameKey(slpaName)}|${normalizeKey(municipality)}|${normalizeKey(barangay)}` : "",
  ].filter(Boolean);
}

function operationalKeys(record: MunicipalityDrilldownRecord, type: "Individual" | "Association") {
  const name = record.Name || record["Monitoring Unit Name"];
  const slpaName = record["SLPA Name"] || record["Project Name"] || record["Monitoring Unit Name"];
  return [
    type === "Individual" && record["SLP Paricipant ID"] ? `PID:${normalizeKey(record["SLP Paricipant ID"])}` : "",
    record["Grant Code"] ? `GRANT:${normalizeKey(record["Grant Code"])}` : "",
    record["Project ID"] ? `PROJECT:${normalizeKey(record["Project ID"])}` : "",
    type === "Individual" && name && record.Municipality && record.Barangay ? `PERSON:${normalizeNameKey(name)}|${normalizeKey(record.Municipality)}|${normalizeKey(record.Barangay)}` : "",
    type === "Association" && slpaName && record.Municipality && record.Barangay ? `SLPA:${normalizeNameKey(slpaName)}|${normalizeKey(record.Municipality)}|${normalizeKey(record.Barangay)}` : "",
  ].filter(Boolean);
}

function buildMonitoringLookup(rows: Array<{ row: Record<string, any>; headers: string[]; sourceName: string }>, type: "Individual" | "Association") {
  const lookup = new Map<string, FallbackMonitoringRow>();
  for (const item of rows) {
    const monitoring: FallbackMonitoringRow = {
      ...item,
      visit: visitNumber(readCell(item.row, item.headers, ["Visit", "Monitoring Visit"])),
      dateMonitored: dateValue(readCell(item.row, item.headers, ["Date Monitored"])),
      updatedDate: dateValue(readCell(item.row, item.headers, ["Updated Date", "Updated At"])),
    };
    for (const key of monitoringKeys(item.row, item.headers, type)) {
      if (isLatestMonitoring(monitoring, lookup.get(key))) lookup.set(key, monitoring);
    }
  }
  return lookup;
}

function ratingCategory(score: number | null) {
  if (score === null) return "Insufficient Data";
  if (score >= 80) return "Excellent / Success Project";
  if (score >= 60) return "Good / Stable";
  if (score >= 40) return "Fair / Needs Assistance";
  if (score >= 20) return "At Risk / Low Earning";
  return "Critical / Close to Bankruptcy";
}

function fallbackRecordFromOperational(record: MunicipalityDrilldownRecord, match?: FallbackMonitoringRow, index = 0): LivelihoodSustainabilityRecord {
  const type = String(record.Type || "").toUpperCase().includes("ASSOCIATION") ? "Association" : "Individual";
  const financial = Object.fromEntries(FINANCIAL_COLUMNS.map((column) => [column, match ? readCell(match.row, match.headers, [column]) : ""]));
  const riskText = normalizeKey([
    financial["Livelihood Status"],
    financial["Enterprise Status"],
    financial["Enterprise Status 1"],
    financial.Remarks,
    financial.Reason,
    financial["Reason 1"],
    financial["Issues/Concerns 1"],
    financial["Issues/Concerns 2"],
    financial["Issues/Concerns 3"],
    financial["Issues/Concerns 4"],
  ].join(" "));
  const netIncome = parseMoney(financial["Ave. Monthly Net Income/Loss"]);
  const grossProfit = parseMoney(financial["Ave. Monthly Gross Profit"]);
  const cashAtBank = parseMoney(financial["Cash at Bank"]);
  const cashOnHand = parseMoney(financial["Cash on Hand"]);
  const totalSavings = parseMoney(financial["Total Savings"]);
  const totalScore = parseMoney(financial["Total Score"]);
  const hasFailure = FAILURE_RE.test(riskText);
  const hasPositiveIncome = (netIncome ?? 0) > 0 || (grossProfit ?? 0) > 0;
  const hasRisk = RISK_RE.test(riskText) || (totalScore !== null && totalScore < 40) || !hasPositiveIncome;
  const sustainabilityStatus = !match ? "No Monitoring Data" : hasFailure ? "Possible Business Failure" : hasPositiveIncome && !hasRisk ? "Stable Income" : "At Risk";
  const hasFinancial = [netIncome, grossProfit, cashAtBank, cashOnHand, totalSavings, totalScore].some((value) => value !== null);
  const score = hasFinancial ? Math.max(0, Math.min(100,
    ((netIncome ?? 0) > 0 ? 35 : 0)
    + ((grossProfit ?? 0) > 0 ? 20 : 0)
    + (((cashAtBank ?? 0) > 0 || (cashOnHand ?? 0) > 0 || (totalSavings ?? 0) > 0) ? 20 : 0)
    + (totalScore !== null ? Math.min(15, totalScore > 15 ? (totalScore / 100) * 15 : totalScore) : 0)
    - (hasFailure ? 30 : RISK_RE.test(riskText) ? 15 : 0),
  )) : null;
  return {
    id: `ls-fallback-${index}`,
    Name: type === "Association" ? String(record["SLPA Name"] || record["Project Name"] || record["Monitoring Unit Name"] || "Not encoded") : String(record.Name || record["Monitoring Unit Name"] || "Not encoded"),
    "SLPA Name": String(record["SLPA Name"] || ""),
    Type: type,
    Municipality: normalizeAuroraMunicipality(record.Municipality) || String(record.Municipality || ""),
    Barangay: String(record.Barangay || ""),
    "Project ID": String(record["Project ID"] || ""),
    "Grant Code": String(record["Grant Code"] || ""),
    "SLP Paricipant ID": String(record["SLP Paricipant ID"] || ""),
    "Enterprise Type": String(record["Enterprise Type"] || record["Project Name"] || record["Monitoring Unit Name"] || ""),
    "Latest Visit": match ? String(match.visit || "Not encoded") : "No monitoring data found",
    "Date Monitored": match ? readCell(match.row, match.headers, ["Date Monitored"]) : "",
    ...financial,
    "Issues/Concerns": [financial["Issues/Concerns 1"], financial["Issues/Concerns 2"], financial["Issues/Concerns 3"], financial["Issues/Concerns 4"]].filter(Boolean).join("; "),
    "Sustainability Status": sustainabilityStatus,
    "Financial Rating Score": score,
    "Financial Rating Category": ratingCategory(score),
    "Rating Explanation": match ? "Calculated from matched MDMonitoring row." : "No monitoring data found",
    "Positive Indicators": hasPositiveIncome ? "Positive income or gross profit" : "",
    "Risk Indicators": !match ? "No monitoring data found" : hasRisk ? "Risk, low score, or missing/zero income" : "",
    "With Savings / Bank Account": (cashAtBank ?? 0) > 0 || (cashOnHand ?? 0) > 0 || (totalSavings ?? 0) > 0 || /\b(STABLE|GOOD|YES|WITH|AVAILABLE|ADEQUATE)\b/.test(normalizeKey(financial["Financial Stability and Savings"])) ? "Yes" : "No",
    "Source Module": match ? `MDMonitoring ${type}` : String(record["Source Module"] || ""),
    "Source File": match?.sourceName || String(record["Source File"] || ""),
    __matchFound: Boolean(match),
  };
}

function buildFallbackSustainability(analytics: DashboardAnalytics) {
  const allDatasets = analytics.parsedFiles || [];
  console.log("LS_ALL_DATASETS_AVAILABLE", allDatasets.map((d) => ({
    name: d.fileName || d.originalName || d.sourceFile,
    folder: d.folder,
    module: d.moduleType || d.classification || d.sourceModule,
    rowCount: d.rows?.length,
    headers: headersOfDataset(d).slice(0, 20),
  })));
  const personalRows = rowsFromDatasets(allDatasets, isPersonalDataset);
  const projectRows = rowsFromDatasets(allDatasets, isProjectDataset);
  const mdIndividualRows = rowsFromDatasets(allDatasets, isMdIndividualDataset);
  const mdAssociationRows = rowsFromDatasets(allDatasets, isMdAssociationDataset);
  const operationalRows = (analytics.municipalityDrilldownRecords || []).filter((record) => record.Category === "status" && record.__status === "operational");
  console.log("LS_OPERATIONAL_SOURCE_USED", {
    sourceName: "analytics.municipalityDrilldownRecords Category=status __status=operational",
    operationalRowsCount: operationalRows.length,
    sample: operationalRows.slice(0, 3),
  });
  console.log("LS_MD_DETECTION", {
    mdIndividualRows: mdIndividualRows.length,
    mdAssociationRows: mdAssociationRows.length,
    mdIndividualHeaders: mdIndividualRows[0]?.headers || [],
    mdAssociationHeaders: mdAssociationRows[0]?.headers || [],
  });
  const individualLookup = buildMonitoringLookup(mdIndividualRows, "Individual");
  const associationLookup = buildMonitoringLookup(mdAssociationRows, "Association");
  const records = operationalRows.map((record, index) => {
    const type = String(record.Type || "").toUpperCase().includes("ASSOCIATION") ? "Association" : "Individual";
    const lookup = type === "Association" ? associationLookup : individualLookup;
    const match = operationalKeys(record, type).map((key) => lookup.get(key)).find(Boolean);
    return fallbackRecordFromOperational(record, match, index + 1);
  });
  const matchedRows = records.filter((record) => record.__matchFound === true);
  const noMonitoringRows = records.filter((record) => record.__matchFound !== true);
  console.log("LS_FINAL_COUNTS", {
    baseOperational: operationalRows.length,
    matchedMonitoring: matchedRows.length,
    noMonitoring: noMonitoringRows.length,
    stableIncome: records.filter((record) => record["Sustainability Status"] === "Stable Income").length,
    atRisk: records.filter((record) => record["Sustainability Status"] === "At Risk").length,
    possibleBusinessFailure: records.filter((record) => record["Sustainability Status"] === "Possible Business Failure").length,
  });
  return {
    records,
    debug: {
      slpisPersonalRows: personalRows.length,
      slpisProjectRows: projectRows.length,
      mdMonitoringIndividualRows: mdIndividualRows.length,
      mdMonitoringAssociationRows: mdAssociationRows.length,
      municipalityDrilldownOperationalRows: operationalRows.length,
      sustainabilityBaseOperationalRows: operationalRows.length,
      matchedMonitoringRows: matchedRows.length,
      noMonitoringMatchRows: noMonitoringRows.length,
    },
  };
}

function shortName(value: unknown) {
  const text = display(value);
  return text.length > 18 ? `${text.slice(0, 16)}...` : text;
}

function statusTone(value: unknown) {
  const text = String(value || "");
  if (text === "Stable Income" || text === "Excellent / Success Project" || text === "Good / Stable" || text === "Yes") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (text === "At Risk" || text === "At Risk / Low Earning" || text === "Fair / Needs Assistance") return "bg-amber-50 text-amber-700 border-amber-200";
  if (text === "Possible Business Failure" || text === "Critical / Close to Bankruptcy") return "bg-rose-50 text-rose-700 border-rose-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function Badge({ value }: { value: unknown }) {
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${statusTone(value)}`}>{display(value)}</span>;
}

function ChartCard({ title, description, hasData, children }: { title: string; description: string; hasData: boolean; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[#D8E6E1] bg-white p-4 shadow-sm">
      <h4 className="text-sm font-bold uppercase tracking-wide text-[#064E3B]">{title}</h4>
      <p className="mt-1 min-h-10 text-sm text-[#64748B]">{description}</p>
      <div className="mt-3 h-64 min-h-[256px]">
        {hasData ? children : (
          <div className="flex h-full items-center justify-center rounded-lg bg-[#F8FAFC] text-sm font-semibold text-[#64748B]">
            No records found for the selected filters.
          </div>
        )}
      </div>
    </div>
  );
}

function SelectFilter({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="block min-w-0 text-[11px] font-semibold uppercase leading-[1.2] tracking-[0.04em] text-[#64748B] whitespace-normal">
      <span className="mb-1.5 block whitespace-normal leading-[1.2]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full min-w-0 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-[#0F172A]">
        <option value="">All</option>
        {options.filter(Boolean).map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function Kpi({ label, value, subtitle, tone = "emerald" }: { label: string; value: number; subtitle: string; tone?: "emerald" | "teal" | "amber" | "rose" | "slate" }) {
  const tones = {
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    teal: "border-cyan-200 bg-cyan-50 text-cyan-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
    slate: "border-slate-200 bg-slate-50 text-slate-700",
  };
  return (
    <div className={`rounded-xl border bg-white p-4 shadow-sm ${tones[tone]}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#334155]">{label}</p>
        <span className={`mt-0.5 h-2.5 w-2.5 rounded-full ${tone === "rose" ? "bg-rose-500" : tone === "amber" ? "bg-amber-500" : tone === "teal" ? "bg-cyan-500" : tone === "slate" ? "bg-slate-400" : "bg-emerald-500"}`} />
      </div>
      <p className="mt-2 text-4xl font-bold text-[#0F172A]">{value.toLocaleString()}</p>
      <p className="mt-2 text-xs leading-snug text-[#475569]">{subtitle}</p>
    </div>
  );
}

export function LivelihoodSustainabilitySection({
  analytics,
  onViewSlpaMembers,
}: {
  analytics: DashboardAnalytics;
  onViewSlpaMembers?: (target: { municipality?: string; slpaName?: string; grantCode?: string; projectId?: string }) => void;
}) {
  const fallback = useMemo(() => buildFallbackSustainability(analytics), [analytics]);
  const apiRecords = analytics.livelihoodSustainability.records || [];
  const allRecords = apiRecords.length ? apiRecords : fallback.records;
  const debugCounts = {
    slpisPersonalRows: fallback.debug.slpisPersonalRows,
    slpisProjectRows: fallback.debug.slpisProjectRows,
    mdMonitoringIndividualRows: fallback.debug.mdMonitoringIndividualRows,
    mdMonitoringAssociationRows: fallback.debug.mdMonitoringAssociationRows,
    municipalityDrilldownOperationalRows: fallback.debug.municipalityDrilldownOperationalRows,
    sustainabilityBaseOperationalRows: apiRecords.length ? apiRecords.length : fallback.debug.sustainabilityBaseOperationalRows,
    matchedMonitoringRows: apiRecords.length ? apiRecords.filter((record) => record.__matchFound === true).length : fallback.debug.matchedMonitoringRows,
    noMonitoringMatchRows: apiRecords.length ? apiRecords.filter((record) => record.__matchFound !== true || record["Sustainability Status"] === "No Monitoring Data").length : fallback.debug.noMonitoringMatchRows,
  };
  const [municipality, setMunicipality] = useState("");
  const [type, setType] = useState("");
  const [enterpriseType, setEnterpriseType] = useState("");
  const [sustainabilityStatus, setSustainabilityStatus] = useState("");
  const [ratingCategory, setRatingCategory] = useState("");
  const [latestVisit, setLatestVisit] = useState("");
  const [withSavings, setWithSavings] = useState("");
  const [selectedRecord, setSelectedRecord] = useState<LivelihoodSustainabilityRecord | null>(null);

  useEffect(() => {
    logMunicipalityNormalizationDebug(allRecords.map((row) => row.Municipality));
  }, [allRecords]);

  const filterOptions = useMemo(() => ({
    municipalities: AURORA_MUNICIPALITIES,
    enterpriseTypes: Array.from(new Set(allRecords.map((row) => String(row["Enterprise Type"] || "")).filter(Boolean))).sort(),
    latestVisits: Array.from(new Set(allRecords.map((row) => String(row["Latest Visit"] || "")).filter(Boolean))).sort(),
  }), [allRecords]);

  const records = useMemo(() => allRecords.filter((row) => {
    if (municipality && normalizeAuroraMunicipality(row.Municipality) !== municipality) return false;
    if (type && row.Type !== type) return false;
    if (enterpriseType && row["Enterprise Type"] !== enterpriseType) return false;
    if (sustainabilityStatus && row["Sustainability Status"] !== sustainabilityStatus) return false;
    if (ratingCategory && row["Financial Rating Category"] !== ratingCategory) return false;
    if (latestVisit && row["Latest Visit"] !== latestVisit) return false;
    if (withSavings && row["With Savings / Bank Account"] !== withSavings) return false;
    return true;
  }), [allRecords, municipality, type, enterpriseType, sustainabilityStatus, ratingCategory, latestVisit, withSavings]);

  const summary = useMemo(() => ({
    operationalTracked: records.length,
    stableIncome: records.filter((row) => row["Sustainability Status"] === "Stable Income").length,
    withSavingsBankAccount: records.filter((row) => row["With Savings / Bank Account"] === "Yes").length,
    atRisk: records.filter((row) => row["Sustainability Status"] === "At Risk").length,
    possibleBusinessFailure: records.filter((row) => row["Sustainability Status"] === "Possible Business Failure").length,
    noMonitoringData: records.filter((row) => row["Sustainability Status"] === "No Monitoring Data").length,
  }), [records]);

  const byMunicipality = useMemo(() => filterOptions.municipalities.map((name) => {
    const rows = records.filter((row) => normalizeAuroraMunicipality(row.Municipality) === name);
    const scored = rows.filter((row) => row["Financial Rating Score"] !== null && row["Financial Rating Score"] !== "");
    return {
      municipality: name,
      Stable: rows.filter((row) => row["Sustainability Status"] === "Stable Income").length,
      "At Risk": rows.filter((row) => row["Sustainability Status"] === "At Risk").length,
      Failure: rows.filter((row) => row["Sustainability Status"] === "Possible Business Failure").length,
      "No Data": rows.filter((row) => row["Sustainability Status"] === "No Monitoring Data").length,
      "Avg Rating": scored.length ? Math.round(scored.reduce((sum, row) => sum + Number(row["Financial Rating Score"] || 0), 0) / scored.length) : 0,
      "Avg Net Income": rows.length ? Math.round(rows.reduce((sum, row) => sum + num(row["Ave. Monthly Net Income/Loss"]), 0) / rows.length) : 0,
      "Total Savings": rows.reduce((sum, row) => sum + num(row["Cash at Bank"]) + num(row["Cash on Hand"]) + num(row["Total Savings"]), 0),
    };
  }), [filterOptions.municipalities, records]);

  const scoredRecords = records.filter((row) => row["Financial Rating Score"] !== null && row["Financial Rating Score"] !== "");
  const topSuccess = [...scoredRecords].sort((a, b) =>
    Number(b["Financial Rating Score"] || 0) - Number(a["Financial Rating Score"] || 0)
    || num(b["Ave. Monthly Net Income/Loss"]) - num(a["Ave. Monthly Net Income/Loss"])
    || (num(b["Cash at Bank"]) + num(b["Cash on Hand"]) + num(b["Total Savings"])) - (num(a["Cash at Bank"]) + num(a["Cash on Hand"]) + num(a["Total Savings"])),
  ).slice(0, 10);
  const criticalRecords = records.filter((row) => row["Financial Rating Category"] === "Critical / Close to Bankruptcy");
  const criticalByMunicipality = filterOptions.municipalities.map((name) => ({ municipality: name, Critical: criticalRecords.filter((row) => normalizeAuroraMunicipality(row.Municipality) === name).length }));
  const executive = useMemo(() => {
    const avgScore = scoredRecords.length ? Math.round(scoredRecords.reduce((sum, row) => sum + Number(row["Financial Rating Score"] || 0), 0) / scoredRecords.length) : null;
    const best = [...byMunicipality].sort((a, b) => b["Avg Rating"] - a["Avg Rating"])[0];
    const mostRisk = [...byMunicipality].sort((a, b) => b["At Risk"] - a["At Risk"])[0];
    const mostCritical = [...criticalByMunicipality].sort((a, b) => b.Critical - a.Critical)[0];
    return [
      ["Best Performing Municipality", best?.["Avg Rating"] ? `${best.municipality} (${best["Avg Rating"]})` : "Not encoded"],
      ["Municipality with Most At Risk Projects", mostRisk?.["At Risk"] ? `${mostRisk.municipality} (${mostRisk["At Risk"]})` : "Not encoded"],
      ["Municipality with Most Critical Projects", mostCritical?.Critical ? `${mostCritical.municipality} (${mostCritical.Critical})` : "Not encoded"],
      ["Average Financial Rating Score", avgScore !== null ? avgScore : "Not encoded"],
      ["Total Projects with Savings/Bank", summary.withSavingsBankAccount],
      ["Total Projects with No Monitoring Data", summary.noMonitoringData],
    ];
  }, [byMunicipality, criticalByMunicipality, scoredRecords, summary]);
  const ranking = filterOptions.municipalities.map((name) => {
    const rows = records.filter((row) => normalizeAuroraMunicipality(row.Municipality) === name);
    const scored = rows.filter((row) => row["Financial Rating Score"] !== null && row["Financial Rating Score"] !== "");
    return {
      municipality: name,
      best: [...scored].sort((a, b) => Number(b["Financial Rating Score"]) - Number(a["Financial Rating Score"])).slice(0, 5),
      bottom: [...scored].sort((a, b) => Number(a["Financial Rating Score"]) - Number(b["Financial Rating Score"])).slice(0, 5),
      critical: rows.filter((row) => row["Financial Rating Category"] === "Critical / Close to Bankruptcy"),
    };
  });

  const detailHeaders = ["Name", "SLPA Name", "Type", "Municipality", "Barangay", "Enterprise Type", "Latest Visit", "Ave. Monthly Gross Profit", "Ave. Monthly Net Income/Loss", "Total Savings", "Sustainability Status", "Financial Rating Score", "Financial Rating Category", "With Savings / Bank Account", "Remarks", "Source Module", "Source File"];
  const rankingHeaders = ["Municipality", "Ranking Type", "Name", "Type", "Enterprise Type", "Financial Rating Score", "Financial Rating Category", "Net Income/Loss", "Sustainability Status", "Source File"];
  const resetFilters = () => {
    setMunicipality("");
    setType("");
    setEnterpriseType("");
    setSustainabilityStatus("");
    setRatingCategory("");
    setLatestVisit("");
    setWithSavings("");
  };

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Livelihood Sustainability</p>
          <h3 className="mt-1 text-2xl font-bold text-[#064E3B]">Financial Overview</h3>
          <p className="mt-1 max-w-3xl text-sm text-[#64748B]">Operational records only, excluding closed records, with latest MDMonitoring financial details where encoded.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => downloadCsv("sustainability-detailed-table.csv", detailHeaders, records.map((row) => detailHeaders.map((header) => row[header] ?? "")))} className="inline-flex items-center gap-2 rounded-lg bg-[#064E3B] px-3 py-2 text-sm font-semibold text-white hover:bg-[#047857]">
            <Download size={16} /> Export details
          </button>
          <button type="button" onClick={() => downloadCsv("municipality-financial-ranking.csv", rankingHeaders, ranking.flatMap((item) => [
            ...item.best.map((row) => [item.municipality, "Top 5 Best Financial Rating / Success Projects", row.Name, row.Type, row["Enterprise Type"], row["Financial Rating Score"], row["Financial Rating Category"], row["Ave. Monthly Net Income/Loss"], row["Sustainability Status"], row["Source File"]]),
            ...item.bottom.map((row) => [item.municipality, "Bottom 5 Low Earning / Needs Assistance", row.Name, row.Type, row["Enterprise Type"], row["Financial Rating Score"], row["Financial Rating Category"], row["Ave. Monthly Net Income/Loss"], row["Sustainability Status"], row["Source File"]]),
            ...item.critical.map((row) => [item.municipality, "Critical / Close to Bankruptcy", row.Name, row.Type, row["Enterprise Type"], row["Financial Rating Score"], row["Financial Rating Category"], row["Ave. Monthly Net Income/Loss"], row["Sustainability Status"], row["Source File"]]),
          ]))} className="inline-flex items-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#F0FDF4]">
            <Download size={16} /> Export ranking
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-[#D8E6E1] bg-[#F8FAFC] p-4 text-sm leading-relaxed text-[#334155]">
        <p className="font-bold text-[#064E3B]">How to read this</p>
        <p className="mt-1">Financial Overview uses operational records only. Latest MDMonitoring data is used to classify projects as Stable Income, At Risk, Possible Business Failure, or No Monitoring Data. Financial Rating is based on income, gross profit, savings, assessment score, and risk indicators.</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        {executive.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-[#D8E6E1] bg-white p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{label}</p>
            <p className="mt-2 text-lg font-bold leading-snug text-[#0F172A]">{display(value)}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-3 rounded-xl border border-[#D8E6E1] bg-[#F8FAFC] p-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))] items-end">
        <SelectFilter label="Municipality" value={municipality} options={filterOptions.municipalities} onChange={setMunicipality} />
        <SelectFilter label="Type" value={type} options={["Individual", "Association"]} onChange={setType} />
        <SelectFilter label="Enterprise Type" value={enterpriseType} options={filterOptions.enterpriseTypes} onChange={setEnterpriseType} />
        <SelectFilter label="Status" value={sustainabilityStatus} options={STATUS_OPTIONS} onChange={setSustainabilityStatus} />
        <SelectFilter label="Rating" value={ratingCategory} options={RATING_OPTIONS} onChange={setRatingCategory} />
        <SelectFilter label="Latest Visit" value={latestVisit} options={filterOptions.latestVisits} onChange={setLatestVisit} />
        <SelectFilter label="Savings/Bank" value={withSavings} options={["Yes", "No"]} onChange={setWithSavings} />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-[#334155] shadow-sm">
        <p className="mb-2 font-bold uppercase tracking-wide text-[#064E3B]">Livelihood Sustainability Debug</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <DebugMetric label="SLPIS Personal rows" value={debugCounts.slpisPersonalRows} />
          <DebugMetric label="SLPIS Project rows" value={debugCounts.slpisProjectRows} />
          <DebugMetric label="MDMonitoring Individual rows" value={debugCounts.mdMonitoringIndividualRows} />
          <DebugMetric label="MDMonitoring Association rows" value={debugCounts.mdMonitoringAssociationRows} />
          <DebugMetric label="Municipality Drill-down Operational rows" value={debugCounts.municipalityDrilldownOperationalRows} />
          <DebugMetric label="Sustainability base operational rows" value={debugCounts.sustainabilityBaseOperationalRows} />
          <DebugMetric label="Matched monitoring rows" value={debugCounts.matchedMonitoringRows} />
          <DebugMetric label="No monitoring match rows" value={debugCounts.noMonitoringMatchRows} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Kpi label="Operational Tracked" value={summary.operationalTracked} subtitle="Operational base records included in this view." tone="emerald" />
        <Kpi label="Stable Income" value={summary.stableIncome} subtitle="Positive income or gross profit without risk flags." tone="emerald" />
        <Kpi label="With Savings / Bank Account" value={summary.withSavingsBankAccount} subtitle="Cash, savings, or stable savings indicator encoded." tone="teal" />
        <Kpi label="At Risk" value={summary.atRisk} subtitle="Low, missing, zero, or negative income indicators." tone="amber" />
        <Kpi label="Possible Business Failure" value={summary.possibleBusinessFailure} subtitle="Failure keywords in status, remarks, reason, or issues." tone="rose" />
        <Kpi label="No Monitoring Data" value={summary.noMonitoringData} subtitle="Operational records without matched monitoring data." tone="slate" />
      </div>

      {records.length === 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
          No livelihood sustainability records found. Check source rows and matching keys.
        </div>
      ) : (
      <>
      <section className="space-y-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Municipality Performance</p>
          <h4 className="text-xl font-bold text-[#064E3B]">Financial Health by Municipality</h4>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Sustainability Status by Municipality" description="Shows how many operational projects are stable, at risk, possible failures, or without monitoring data." hasData={byMunicipality.some((row) => row.Stable || row["At Risk"] || row.Failure || row["No Data"])}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byMunicipality} margin={{ bottom: 36 }}>
              <XAxis dataKey="municipality" tickFormatter={shortName} angle={-25} textAnchor="end" interval={0} tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="Stable" fill="#10B981" />
              <Bar dataKey="At Risk" fill="#F59E0B" />
              <Bar dataKey="Failure" fill="#EF4444" />
              <Bar dataKey="No Data" fill="#94A3B8" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Financial Rating by Municipality" description="Compares average financial rating score for operational records with encoded rating data." hasData={byMunicipality.some((row) => row["Avg Rating"] > 0)}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byMunicipality} margin={{ bottom: 36 }}>
              <XAxis dataKey="municipality" tickFormatter={shortName} angle={-25} textAnchor="end" interval={0} tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 100]} />
              <Tooltip />
              <Bar dataKey="Avg Rating" fill="#0F766E" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Average Net Income by Municipality" description="Shows average net income or loss from matched monitoring records by municipality." hasData={byMunicipality.some((row) => row["Avg Net Income"] !== 0)}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byMunicipality} margin={{ bottom: 36 }}>
              <XAxis dataKey="municipality" tickFormatter={shortName} angle={-25} textAnchor="end" interval={0} tick={{ fontSize: 11 }} />
              <YAxis />
              <Tooltip />
              <Bar dataKey="Avg Net Income" fill="#2563EB" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Savings Overview by Municipality" description="Totals encoded savings, cash on hand, and bank balances for operational projects." hasData={byMunicipality.some((row) => row["Total Savings"] > 0)}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byMunicipality} margin={{ bottom: 36 }}>
              <XAxis dataKey="municipality" tickFormatter={shortName} angle={-25} textAnchor="end" interval={0} tick={{ fontSize: 11 }} />
              <YAxis />
              <Tooltip />
              <Bar dataKey="Total Savings" fill="#0891B2" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Priority Projects</p>
          <h4 className="text-xl font-bold text-[#064E3B]">Success and Critical Monitoring</h4>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Top Success Projects" description="Top 10 projects sorted by financial rating, then net income, then savings." hasData={topSuccess.length > 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topSuccess.map((row) => ({ name: row.Name || row["SLPA Name"], municipality: row.Municipality, netIncome: row["Ave. Monthly Net Income/Loss"], savings: num(row["Cash at Bank"]) + num(row["Cash on Hand"]) + num(row["Total Savings"]), Score: row["Financial Rating Score"] }))} layout="vertical" margin={{ left: 28, right: 16 }}>
              <XAxis type="number" domain={[0, 100]} />
              <YAxis type="category" dataKey="name" tickFormatter={shortName} width={150} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(value, name, item) => [value, `${name} (${item.payload.municipality})`]} />
              <Bar dataKey="Score" fill="#16A34A" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Critical Projects by Municipality" description="Counts projects categorized as Critical / Close to Bankruptcy by municipality." hasData={criticalByMunicipality.some((row) => row.Critical > 0)}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={criticalByMunicipality} margin={{ bottom: 36 }}>
              <XAxis dataKey="municipality" tickFormatter={shortName} angle={-25} textAnchor="end" interval={0} tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="Critical" fill="#B91C1C" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        </div>
      </section>

      <div className="rounded-xl border border-[#D8E6E1] bg-white p-4 shadow-sm">
        <h4 className="text-sm font-bold uppercase tracking-wide text-[#064E3B]">Municipality Financial Ranking</h4>
        <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ranking.map((item) => (
            <div key={item.municipality} className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3 shadow-sm">
              <h5 className="font-bold text-[#064E3B]">{item.municipality}</h5>
              <RankingList title="Top Success Projects" rows={item.best} defaultOpen onOpenRecord={setSelectedRecord} />
              <RankingList title="Low Earning / Needs Assistance" rows={item.bottom} onOpenRecord={setSelectedRecord} />
              <RankingList title="Critical / Close to Bankruptcy" rows={item.critical} onOpenRecord={setSelectedRecord} />
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-[#D8E6E1] bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h4 className="text-sm font-bold uppercase tracking-wide text-[#064E3B]">Sustainability Detailed Table</h4>
            <p className="mt-1 text-sm text-[#64748B]">Filtered operational records with financial status, rating, and source details.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <QuickButton label="Show Stable Income" onClick={() => { setSustainabilityStatus("Stable Income"); setRatingCategory(""); setWithSavings(""); }} />
            <QuickButton label="Show With Savings" onClick={() => { setWithSavings("Yes"); setSustainabilityStatus(""); setRatingCategory(""); }} />
            <QuickButton label="Show At Risk" onClick={() => { setSustainabilityStatus("At Risk"); setRatingCategory(""); setWithSavings(""); }} />
            <QuickButton label="Show Critical" onClick={() => { setRatingCategory("Critical / Close to Bankruptcy"); setSustainabilityStatus(""); setWithSavings(""); }} />
            <QuickButton label="Show No Monitoring Data" onClick={() => { setSustainabilityStatus("No Monitoring Data"); setRatingCategory(""); setWithSavings(""); }} />
            <QuickButton label="Reset Filters" onClick={resetFilters} />
          </div>
        </div>
        <div className="mt-3 max-h-[520px] overflow-auto rounded-xl border border-slate-200">
          <table className="w-full table-auto text-sm" style={{ minWidth: 1280 }}>
            <thead className="sticky top-0 z-20 bg-[#F0FDF4] text-left text-xs uppercase tracking-wide text-[#064E3B]">
              <tr>{detailHeaders.map((header, index) => <th key={header} className={`p-3 ${index === 0 ? "sticky left-0 z-30 bg-[#F0FDF4]" : ""}`}>{header}</th>)}</tr>
            </thead>
            <tbody>
              {records.length ? records.map((row, index) => (
                <tr key={`${row.id || index}`} className="group border-t border-[#D8E6E1] hover:bg-[#F8FAFC]">
                  {detailHeaders.map((header, cellIndex) => (
                    <td key={header} className={`max-w-sm p-3 align-top text-[#334155] ${cellIndex === 0 ? "sticky left-0 z-10 bg-white font-semibold group-hover:bg-[#F8FAFC]" : ""}`}>
                      {cellIndex === 0 ? (
                        <button type="button" onClick={() => setSelectedRecord(row)} className="text-left font-bold text-[#047857] hover:underline">{display(row.Name || row["SLPA Name"])}</button>
                      ) : header === "Sustainability Status" || header === "Financial Rating Category" || header === "With Savings / Bank Account" ? (
                        <Badge value={row[header]} />
                      ) : header.includes("Income") || header.includes("Profit") || header.includes("Savings") ? money(row[header]) : display(row[header])}
                    </td>
                  ))}
                </tr>
              )) : (
                <tr><td className="p-6 text-center text-[#64748B]" colSpan={detailHeaders.length}>No records match the active filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      </>
      )}
      {selectedRecord && <FinancialOverviewPopup record={selectedRecord} onClose={() => setSelectedRecord(null)} onViewSlpaMembers={onViewSlpaMembers} />}
    </section>
  );
}

function DebugMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-[#F8FAFC] px-3 py-2">
      <span className="block text-[#64748B]">{label}</span>
      <span className="mt-1 block text-lg font-bold text-[#0F172A]">{Number(value || 0).toLocaleString()}</span>
    </div>
  );
}

function QuickButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-full border border-[#D8E6E1] bg-white px-3 py-1.5 text-xs font-semibold text-[#064E3B] hover:bg-[#F0FDF4]">
      {label}
    </button>
  );
}

function TypeBadge({ value }: { value: unknown }) {
  const text = display(value);
  return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">{text}</span>;
}

function RankingList({ title, rows, defaultOpen = false, onOpenRecord }: { title: string; rows: LivelihoodSustainabilityRecord[]; defaultOpen?: boolean; onOpenRecord: (record: LivelihoodSustainabilityRecord) => void }) {
  return (
    <details className="mt-3 rounded-lg border border-slate-200 bg-white" open={defaultOpen}>
      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[#64748B]">{title} ({rows.length})</summary>
      <div className="space-y-2 border-t border-slate-100 p-2">
        {rows.length ? rows.slice(0, 5).map((row, index) => (
          <button key={`${title}-${index}-${row.id}`} type="button" onClick={() => onOpenRecord(row)} className="w-full rounded-md bg-[#F8FAFC] px-2 py-2 text-left text-xs text-[#334155] hover:bg-[#ECFDF5]">
            <span className="block font-semibold text-[#0F172A]">{display(row.Name || row["SLPA Name"])}</span>
            <span className="mt-1 flex flex-wrap items-center gap-2">
              <TypeBadge value={row.Type} />
              <span className="font-bold text-[#047857]">{display(row["Financial Rating Score"])}</span>
              <Badge value={row["Financial Rating Category"]} />
            </span>
          </button>
        )) : <p className="text-xs text-[#94A3B8]">No matching records.</p>}
      </div>
    </details>
  );
}

function FinancialOverviewPopup({
  record,
  onClose,
  onViewSlpaMembers,
}: {
  record: LivelihoodSustainabilityRecord;
  onClose: () => void;
  onViewSlpaMembers?: (target: { municipality?: string; slpaName?: string; grantCode?: string; projectId?: string }) => void;
}) {
  const isAssociation = String(record.Type || "").toLowerCase().includes("association") || Boolean(record["SLPA Name"]);
  const fields: Array<[string, unknown]> = [
    ["Name / SLPA Name", record.Name || record["SLPA Name"]],
    ["Type", record.Type],
    ["Municipality / Barangay", [record.Municipality, record.Barangay].filter(Boolean).join(" / ")],
    ["Enterprise Type", record["Enterprise Type"]],
    ["Financial Rating Score", record["Financial Rating Score"]],
    ["Financial Rating Category", record["Financial Rating Category"]],
    ["Sustainability Status", record["Sustainability Status"]],
    ["Net Income/Loss", money(record["Ave. Monthly Net Income/Loss"])],
    ["Gross Profit", money(record["Ave. Monthly Gross Profit"])],
    ["Total Savings", money(record["Total Savings"])],
    ["With Savings / Bank Account", record["With Savings / Bank Account"]],
    ["Latest Visit", record["Latest Visit"]],
    ["Remarks", record.Remarks],
    ["Issues/Concerns", record["Issues/Concerns"]],
    ["Source Module", record["Source Module"]],
    ["Source File", record["Source File"]],
  ];
  return (
    <div className="fixed inset-0 z-[1200]">
      <button type="button" aria-label="Close financial overview" className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <aside className="absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-[#D8E6E1] pb-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Financial Overview</p>
            <h3 className="mt-1 text-xl font-bold text-[#064E3B]">{display(record.Name || record["SLPA Name"])}</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-[#D8E6E1] p-2 text-[#064E3B] hover:bg-[#F0FDF4]"><X size={18} /></button>
        </div>
        <div className="mt-4">
          {isAssociation ? (
            <button
              type="button"
              onClick={() => {
                onViewSlpaMembers?.({
                  municipality: normalizeAuroraMunicipality(record.Municipality) || String(record.Municipality || ""),
                  slpaName: String(record["SLPA Name"] || record.Name || ""),
                  grantCode: String(record["Grant Code"] || ""),
                  projectId: String(record["Project ID"] || ""),
                });
                onClose();
              }}
              className="rounded-lg bg-[#064E3B] px-3 py-2 text-sm font-semibold text-white hover:bg-[#047857]"
            >
              View SLPA Members
            </button>
          ) : (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
              This record is an individual project. SLPA member demographics are available only for association/SLPA records.
            </div>
          )}
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          {fields.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{label}</dt>
              <dd className="mt-1 break-words text-sm font-semibold text-[#0F172A]">{display(value)}</dd>
            </div>
          ))}
        </dl>
      </aside>
    </div>
  );
}
