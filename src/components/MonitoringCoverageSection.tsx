import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Download, Filter, MinusCircle } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AURORA_MUNICIPALITIES,
  normalizeAuroraMunicipality,
  type DashboardAnalytics,
  type MonitoringCoverageRow,
  type MonitoringCoverageStatus,
} from "../utils/dashboardAnalytics";

type QuickFilter =
  | "all"
  | "visit1"
  | "visit2"
  | "visit3"
  | "visit4"
  | "orgAssessment"
  | "annualAssessment"
  | "missingVisits"
  | "missingAssessments";

const visitLabels: Record<1 | 2 | 3 | 4, string> = {
  1: "1st Visit",
  2: "2nd Visit",
  3: "3rd Visit",
  4: "4th Visit",
};

const chartColors = {
  firstVisit: "#047857",
  secondVisit: "#10B981",
  thirdVisit: "#0F766E",
  fourthVisit: "#D4AF37",
  missing: "#F97316",
};

function statusText(status: MonitoringCoverageStatus) {
  if (status === "Completed") return "Completed";
  if (status === "Not Applicable") return "Not Applicable";
  if (status === "Missing") return "Missing";
  return String(status || "");
}

function StatusCell({ status }: { status: MonitoringCoverageStatus }) {
  if (status === "Completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
        <CheckCircle2 size={14} /> Completed
      </span>
    );
  }
  if (status === "Not Applicable") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
        <MinusCircle size={14} /> Not Applicable
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">
      <AlertTriangle size={14} /> Missing
    </span>
  );
}

function CoverageKpi({
  label,
  value,
  active,
  tone = "green",
  onClick,
}: {
  label: string;
  value: number;
  active: boolean;
  tone?: "green" | "amber";
  onClick: () => void;
}) {
  const activeClass = active ? "border-[#D4AF37] bg-[#FFFBEB]" : "border-[#D8E6E1] bg-white hover:bg-[#F0FDF4]";
  const valueClass = tone === "amber" ? "text-[#B45309]" : "text-[#064E3B]";
  return (
    <button type="button" onClick={onClick} className={`rounded-xl border p-4 text-left shadow-sm transition ${activeClass}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{label}</p>
      <p className={`mt-2 text-3xl font-bold ${valueClass}`}>{value.toLocaleString()}</p>
      <p className="mt-1 text-xs text-[#64748B]">Monitoring Units</p>
    </button>
  );
}

function selectValue(row: MonitoringCoverageRow, quickFilter: QuickFilter) {
  if (quickFilter === "visit1") return row.visits[1] === "Completed";
  if (quickFilter === "visit2") return row.visits[2] === "Completed";
  if (quickFilter === "visit3") return row.visits[3] === "Completed";
  if (quickFilter === "visit4") return row.visits[4] === "Completed";
  if (quickFilter === "orgAssessment") return row.type === "Association" && row.organizationalAssessment === "Completed";
  if (quickFilter === "annualAssessment") return row.annualAssessment === "Completed";
  if (quickFilter === "missingVisits") return ([1, 2, 3, 4] as const).some((visit) => row.visits[visit] !== "Completed");
  if (quickFilter === "missingAssessments") return row.annualAssessment !== "Completed" || (row.type === "Association" && row.organizationalAssessment !== "Completed");
  return true;
}

type CoverageExportFormat = "xlsx" | "csv" | "pdf";

type CoverageActiveFilters = {
  municipality: string;
  type: string;
  visitStatus: string;
  assessmentStatus: string;
  sourceModule: string;
  quickFilter: QuickFilter;
};

const coverageExportColumns = [
  { header: "Monitoring Unit Name", value: (row: MonitoringCoverageRow) => cleanCell(row.monitoringUnitName) },
  { header: "Municipality", value: (row: MonitoringCoverageRow) => cleanCell(row.municipality) },
  { header: "Type", value: (row: MonitoringCoverageRow) => cleanCell(row.type) },
  { header: "Count Unit", value: (row: MonitoringCoverageRow) => cleanCell(row.countUnit) },
  { header: "SLP Participant ID", value: (row: MonitoringCoverageRow) => cleanCell(row.slpParticipantId) },
  { header: "Project ID / Association Name", value: (row: MonitoringCoverageRow) => cleanCell(row.projectIdAssociationName) },
  { header: "1st Visit", value: (row: MonitoringCoverageRow) => statusText(row.visits[1]) },
  { header: "2nd Visit", value: (row: MonitoringCoverageRow) => statusText(row.visits[2]) },
  { header: "3rd Visit", value: (row: MonitoringCoverageRow) => statusText(row.visits[3]) },
  { header: "4th Visit", value: (row: MonitoringCoverageRow) => statusText(row.visits[4]) },
  { header: "Organizational Assessment", value: (row: MonitoringCoverageRow) => statusText(row.organizationalAssessment) },
  { header: "Source Module", value: (row: MonitoringCoverageRow) => cleanCell(row.sourceModule) },
  { header: "Source File", value: (row: MonitoringCoverageRow) => cleanCell(row.sourceFile) },
];

const quickFilterLabels: Record<QuickFilter, string> = {
  all: "All",
  visit1: "Monitoring Units with 1st Visit",
  visit2: "Monitoring Units with 2nd Visit",
  visit3: "Monitoring Units with 3rd Visit",
  visit4: "Monitoring Units with 4th Visit",
  orgAssessment: "Associations with Organizational Assessment",
  annualAssessment: "Monitoring Units with Annual Assessment",
  missingVisits: "Missing Monitoring Visits",
  missingAssessments: "Missing Assessments",
};

const visitStatusLabels: Record<string, string> = {
  all: "All",
  withAny: "With any visit",
  complete: "Complete visits",
  missing: "Missing any visit",
};

const assessmentStatusLabels: Record<string, string> = {
  all: "All",
  complete: "Complete assessments",
  missing: "Missing assessments",
};

function cleanCell(value: unknown) {
  const text = String(value ?? "").trim();
  return text || "Not Found";
}

function coverageExportRows(rows: MonitoringCoverageRow[]) {
  return rows.map((row) => coverageExportColumns.map((column) => column.value(row)));
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function reportTimestamp(date = new Date()) {
  const datePart = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const timePart = `${pad2(date.getHours())}-${pad2(date.getMinutes())}`;
  return {
    filename: `${datePart}_${timePart}`,
    display: date.toLocaleString(),
  };
}

function coverageFileName(extension: string) {
  return `coverage_matrix_${reportTimestamp().filename}.${extension}`;
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function activeFilterLines(filters: CoverageActiveFilters) {
  const items = [
    ["Municipality", filters.municipality === "all" ? "All" : filters.municipality],
    ["Type", filters.type === "all" ? "All" : filters.type],
    ["Visit Status", visitStatusLabels[filters.visitStatus] || filters.visitStatus],
    ["Assessment Status", assessmentStatusLabels[filters.assessmentStatus] || filters.assessmentStatus],
    ["Source Module", filters.sourceModule === "all" ? "All" : filters.sourceModule],
    ["KPI Filter", quickFilterLabels[filters.quickFilter]],
  ];
  return items.map(([label, value]) => `${label}: ${value}`);
}

function escapeCsv(value: string | number) {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function downloadCoverageCsv(rows: MonitoringCoverageRow[]) {
  const headers = coverageExportColumns.map((column) => column.header);
  const csv = [headers, ...coverageExportRows(rows)].map((line) => line.map(escapeCsv).join(",")).join("\n");
  saveBlob(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }), coverageFileName("csv"));
}

async function downloadCoverageExcel(rows: MonitoringCoverageRow[]) {
  const { default: ExcelJS } = await import("exceljs");
  const timestamp = reportTimestamp();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SLP Knowledge Assistant";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("Coverage Matrix", {
    views: [{ state: "frozen", ySplit: 4 }],
  });

  worksheet.addRow(["Coverage Matrix"]);
  worksheet.addRow([`Generated: ${timestamp.display}`]);
  worksheet.addRow([]);
  worksheet.addRow(coverageExportColumns.map((column) => column.header));
  coverageExportRows(rows).forEach((row) => worksheet.addRow(row));

  worksheet.mergeCells(1, 1, 1, coverageExportColumns.length);
  const titleCell = worksheet.getCell("A1");
  titleCell.font = { bold: true, size: 18, color: { argb: "FF064E3B" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };

  const generatedCell = worksheet.getCell("A2");
  generatedCell.font = { italic: true, size: 10, color: { argb: "FF64748B" } };

  const headerRow = worksheet.getRow(4);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF047857" } };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD8E6E1" } },
      bottom: { style: "thin", color: { argb: "FFD8E6E1" } },
      left: { style: "thin", color: { argb: "FFD8E6E1" } },
      right: { style: "thin", color: { argb: "FFD8E6E1" } },
    };
    cell.alignment = { vertical: "middle", wrapText: true };
  });

  worksheet.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: 4, column: coverageExportColumns.length },
  };

  worksheet.columns.forEach((column, index) => {
    const headerLength = coverageExportColumns[index]?.header.length ?? 12;
    let maxLength = headerLength;
    column.eachCell({ includeEmpty: true }, (cell) => {
      maxLength = Math.max(maxLength, String(cell.value ?? "").length);
    });
    column.width = Math.min(Math.max(maxLength + 2, 14), index >= 11 ? 46 : 32);
  });

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 4) return;
    row.eachCell((cell) => {
      cell.numFmt = "@";
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = {
        bottom: { style: "hair", color: { argb: "FFE2E8F0" } },
      };
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  saveBlob(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `coverage_matrix_${timestamp.filename}.xlsx`);
}

async function downloadCoveragePdf(rows: MonitoringCoverageRow[], filters: CoverageActiveFilters) {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const timestamp = reportTimestamp();
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a3" });
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor("#064E3B");
  doc.text("Coverage Matrix", 36, 36);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor("#475569");
  doc.text(`Generated: ${timestamp.display}`, 36, 54);
  doc.text(`Rows exported: ${rows.length.toLocaleString()}`, pageWidth - 36, 54, { align: "right" });

  const filterText = activeFilterLines(filters).join("   |   ");
  const filterLines = doc.splitTextToSize(`Active filters: ${filterText}`, pageWidth - 72);
  doc.text(filterLines, 36, 72);

  autoTable(doc, {
    head: [coverageExportColumns.map((column) => column.header)],
    body: coverageExportRows(rows),
    startY: 76 + filterLines.length * 11,
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 7,
      cellPadding: 3,
      overflow: "linebreak",
      valign: "top",
      lineColor: "#D8E6E1",
      lineWidth: 0.5,
    },
    headStyles: {
      fillColor: "#047857",
      textColor: "#FFFFFF",
      fontStyle: "bold",
      halign: "left",
    },
    alternateRowStyles: {
      fillColor: "#F8FAFC",
    },
    margin: { left: 24, right: 24 },
  });

  doc.save(`coverage_matrix_${timestamp.filename}.pdf`);
}

export function MonitoringCoverageSection({ analytics }: { analytics: DashboardAnalytics }) {
  const coverage = analytics.monitoringCoverage;
  const [municipalityFilter, setMunicipalityFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [visitStatusFilter, setVisitStatusFilter] = useState("all");
  const [assessmentStatusFilter, setAssessmentStatusFilter] = useState("all");
  const [sourceModuleFilter, setSourceModuleFilter] = useState("all");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);

  const sourceModules = useMemo(() => {
    return Array.from(new Set(coverage.rows.flatMap((row) => row.sourceModule.split(";").map((item) => item.trim()).filter(Boolean)))).sort();
  }, [coverage.rows]);

  const filteredRows = useMemo(() => {
    return coverage.rows.filter((row) => {
      if (municipalityFilter !== "all" && normalizeAuroraMunicipality(row.municipality) !== municipalityFilter) return false;
      if (typeFilter !== "all" && row.type !== typeFilter) return false;
      if (sourceModuleFilter !== "all" && !row.sourceModule.includes(sourceModuleFilter)) return false;
      if (!selectValue(row, quickFilter)) return false;
      const hasMissingVisit = ([1, 2, 3, 4] as const).some((visit) => row.visits[visit] !== "Completed");
      const hasAnyVisit = ([1, 2, 3, 4] as const).some((visit) => row.visits[visit] === "Completed");
      if (visitStatusFilter === "complete" && hasMissingVisit) return false;
      if (visitStatusFilter === "missing" && !hasMissingVisit) return false;
      if (visitStatusFilter === "withAny" && !hasAnyVisit) return false;
      const missingAssessment = row.annualAssessment !== "Completed" || (row.type === "Association" && row.organizationalAssessment !== "Completed");
      if (assessmentStatusFilter === "complete" && missingAssessment) return false;
      if (assessmentStatusFilter === "missing" && !missingAssessment) return false;
      return true;
    });
  }, [assessmentStatusFilter, coverage.rows, municipalityFilter, quickFilter, sourceModuleFilter, typeFilter, visitStatusFilter]);

  const activeFilters = useMemo(() => ({
    municipality: municipalityFilter,
    type: typeFilter,
    visitStatus: visitStatusFilter,
    assessmentStatus: assessmentStatusFilter,
    sourceModule: sourceModuleFilter,
    quickFilter,
  }), [assessmentStatusFilter, municipalityFilter, quickFilter, sourceModuleFilter, typeFilter, visitStatusFilter]);

  const zeroResultDebug = useMemo(() => ({
    ...(coverage.debug || {}),
    activeFilters,
    monitoringRowsBeforeFilter: coverage.debug?.monitoringRowsBeforeFilter ?? coverage.rows.length,
    monitoringUnitsAfterMerge: coverage.debug?.monitoringUnitsAfterMerge ?? coverage.summary.totalUnits,
    visitCounts: coverage.debug?.visitCounts || {
      "1st Visit": coverage.summary.firstVisit,
      "2nd Visit": coverage.summary.secondVisit,
      "3rd Visit": coverage.summary.thirdVisit,
      "4th Visit": coverage.summary.fourthVisit,
    },
  }), [activeFilters, coverage.debug, coverage.rows.length, coverage.summary]);

  useEffect(() => {
    if (coverage.summary.totalUnits === 0 || filteredRows.length === 0) {
      console.log("monitoringCoverageDebug", zeroResultDebug);
    }
  }, [coverage.summary.totalUnits, filteredRows.length, zeroResultDebug]);

  const kpis = [
    { key: "visit1" as const, label: "Monitoring Units with 1st Visit", value: coverage.summary.firstVisit },
    { key: "visit2" as const, label: "Monitoring Units with 2nd Visit", value: coverage.summary.secondVisit },
    { key: "visit3" as const, label: "Monitoring Units with 3rd Visit", value: coverage.summary.thirdVisit },
    { key: "visit4" as const, label: "Monitoring Units with 4th Visit", value: coverage.summary.fourthVisit },
    { key: "orgAssessment" as const, label: "Associations with Organizational Assessment", value: coverage.summary.organizationalAssessment },
    { key: "annualAssessment" as const, label: "Monitoring Units with Annual Assessment", value: coverage.summary.annualAssessment },
    { key: "missingVisits" as const, label: "Missing Monitoring Visits", value: coverage.summary.missingMonitoringVisits, tone: "amber" as const },
    { key: "missingAssessments" as const, label: "Missing Assessments", value: coverage.summary.missingAssessments, tone: "amber" as const },
  ];

  const handleCoverageDownload = (format: CoverageExportFormat) => {
    setDownloadMenuOpen(false);
    if (format === "xlsx") {
      void downloadCoverageExcel(filteredRows);
      return;
    }
    if (format === "pdf") {
      void downloadCoveragePdf(filteredRows, activeFilters);
      return;
    }
    downloadCoverageCsv(filteredRows);
  };

  return (
    <section className="space-y-5 rounded-2xl border border-[#D8E6E1] bg-white/95 p-4 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Monitoring Units</p>
          <h3 className="mt-1 text-2xl font-bold text-[#064E3B]">Monitoring & Assessment Coverage</h3>
          <p className="mt-1 max-w-3xl text-sm text-[#64748B]">
            Counts one individual enterprise participant or one association project as a monitoring unit.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => (
          <CoverageKpi
            key={kpi.key}
            label={kpi.label}
            value={kpi.value}
            tone={kpi.tone}
            active={quickFilter === kpi.key}
            onClick={() => setQuickFilter(quickFilter === kpi.key ? "all" : kpi.key)}
          />
        ))}
      </div>

      {(coverage.summary.totalUnits === 0 || filteredRows.length === 0) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-bold">Monitoring coverage debug summary</p>
          {(zeroResultDebug.filesScanned ?? 0) === 0 && (
            <p className="mt-2 rounded-lg bg-white/80 px-3 py-2 font-semibold">
              Monitoring files are not reaching the dashboard parser. Check upload registry or parsedFiles source.
            </p>
          )}
          {(zeroResultDebug.sourceProof?.workingSourceRowsCount || 0) > 0 && (zeroResultDebug.sourceProof?.monitoringCoverageSourceRowsCount || 0) === 0 && (
            <p className="mt-2 rounded-lg bg-white/80 px-3 py-2 font-semibold">
              Working dashboard rows exist, but Monitoring Coverage received 0 rows.
            </p>
          )}
          {(zeroResultDebug.sourceProof?.workingSourceRowsCount || 0) > 0 && (zeroResultDebug.sourceProof?.barangaySourceRowsCount || 0) === 0 && (
            <p className="mt-2 rounded-lg bg-white/80 px-3 py-2 font-semibold">
              Working dashboard rows exist, but Barangay Breakdown received 0 rows.
            </p>
          )}
          {(zeroResultDebug.sourceProof?.workingSourceRowsCount || 0) > 0 && (zeroResultDebug.sourceProof?.drilldownSourceRowsCount || 0) === 0 && (
            <p className="mt-2 rounded-lg bg-white/80 px-3 py-2 font-semibold">
              Working dashboard rows exist, but Drilldown Details received 0 rows.
            </p>
          )}
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <DebugMetric label="Files scanned" value={zeroResultDebug.filesScanned ?? coverage.debug?.detectedSources?.length ?? 0} />
            <DebugMetric label="API files loaded" value={zeroResultDebug.apiFilesLoadedCount ?? 0} />
            <DebugMetric label="Parsed files" value={zeroResultDebug.parsedFilesCount ?? 0} />
            <DebugMetric label="Parsed rows" value={zeroResultDebug.parsedRowsCount ?? 0} />
            <DebugMetric label="Working rows" value={zeroResultDebug.sourceProof?.workingSourceRowsCount ?? 0} />
            <DebugMetric label="Monitoring source rows" value={zeroResultDebug.sourceProof?.monitoringCoverageSourceRowsCount ?? 0} />
            <DebugMetric label="Barangay source rows" value={zeroResultDebug.sourceProof?.barangaySourceRowsCount ?? 0} />
            <DebugMetric label="Drilldown source rows" value={zeroResultDebug.sourceProof?.drilldownSourceRowsCount ?? 0} />
            <DebugMetric label="Header row used" value={zeroResultDebug.headerRowUsed === 0 ? "Row 1" : zeroResultDebug.headerRowUsed === 1 ? "Row 2" : zeroResultDebug.headerRowUsed ?? "Unknown"} />
            <DebugMetric label="Rows before filter" value={zeroResultDebug.monitoringRowsBeforeFilter ?? 0} />
            <DebugMetric label="Units after merge" value={zeroResultDebug.monitoringUnitsAfterMerge ?? 0} />
            <DebugMetric label="Association units" value={zeroResultDebug.associationUnits ?? 0} />
            <DebugMetric label="Individual units" value={zeroResultDebug.individualUnits ?? 0} />
            <DebugMetric label="Org matches" value={zeroResultDebug.orgAssessmentMatches ?? 0} />
            <DebugMetric label="Annual matches" value={zeroResultDebug.annualAssessmentMatches ?? 0} />
            <DebugMetric label="Barangays" value={zeroResultDebug.barangayCount ?? 0} />
          </div>
          <p className="mt-2 text-xs">
            Active filters: Municipality {activeFilters.municipality}, Type {activeFilters.type}, Visit {activeFilters.visitStatus}, Assessment {activeFilters.assessmentStatus}, Source {activeFilters.sourceModule}.
          </p>
          <div className="mt-3 overflow-auto rounded-lg border border-amber-200 bg-white">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="bg-amber-100 text-amber-950">
                <tr>
                  <th className="p-2">File name</th>
                  <th className="p-2">Module type detected</th>
                  <th className="p-2">Rows</th>
                  <th className="p-2">Accepted</th>
                  <th className="p-2">Headers detected</th>
                  <th className="p-2">Reason if rejected</th>
                </tr>
              </thead>
              <tbody>
                {(zeroResultDebug.availableFiles || []).map((file: any, index: number) => (
                  <tr key={`${file.fileName}-${index}`} className="border-t border-amber-100">
                    <td className="p-2 font-semibold">{file.fileName || "Unknown file"}</td>
                    <td className="p-2">{file.detectedModuleType || "Not detected"}</td>
                    <td className="p-2">{Number(file.rowCount || 0).toLocaleString()}</td>
                    <td className="p-2">{file.accepted ? "Yes" : "No"}</td>
                    <td className="p-2">{(file.headersDetected || []).slice(0, 12).join(", ") || "No headers"}</td>
                    <td className="p-2">{file.rejectedReason || ""}</td>
                  </tr>
                ))}
                {!(zeroResultDebug.availableFiles || []).length && (
                  <tr>
                    <td colSpan={6} className="p-3 text-center">No parsed dashboard files were reported.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-xl border border-[#D8E6E1] bg-[#F8FAFC] p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="font-bold text-[#064E3B]">Visit Coverage by Municipality</h4>
              <p className="text-sm text-[#64748B]">Click a municipality bar group to filter the matrix.</p>
            </div>
            {municipalityFilter !== "all" && (
              <button type="button" onClick={() => setMunicipalityFilter("all")} className="rounded-lg border border-[#D8E6E1] bg-white px-3 py-1.5 text-xs font-semibold text-[#064E3B]">
                Clear municipality
              </button>
            )}
          </div>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={coverage.byMunicipality}
                margin={{ left: 0, right: 12, top: 12, bottom: 42 }}
                onClick={(state) => {
                  const municipality = normalizeAuroraMunicipality(state?.activeLabel);
                  if (municipality) setMunicipalityFilter(municipality);
                }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#D8E6E1" />
                <XAxis dataKey="municipality" angle={-25} textAnchor="end" interval={0} tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Bar dataKey="firstVisit" name="1st Visit" stackId="visits" fill={chartColors.firstVisit} radius={[4, 4, 0, 0]} />
                <Bar dataKey="secondVisit" name="2nd Visit" stackId="visits" fill={chartColors.secondVisit} />
                <Bar dataKey="thirdVisit" name="3rd Visit" stackId="visits" fill={chartColors.thirdVisit} />
                <Bar dataKey="fourthVisit" name="4th Visit" stackId="visits" fill={chartColors.fourthVisit} />
                <Bar dataKey="missingMonitoringVisits" name="Missing Visits" fill={chartColors.missing} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl border border-[#D8E6E1] bg-white p-4">
          <div className="mb-3 flex items-center gap-2 text-[#064E3B]">
            <Filter size={18} />
            <h4 className="font-bold">Coverage Filters</h4>
          </div>
          <div className="space-y-3">
            <FilterSelect label="Municipality" value={municipalityFilter} onChange={setMunicipalityFilter} options={["all", ...AURORA_MUNICIPALITIES]} />
            <FilterSelect label="Type" value={typeFilter} onChange={setTypeFilter} options={["all", "Individual", "Association"]} />
            <FilterSelect label="Visit Status" value={visitStatusFilter} onChange={setVisitStatusFilter} options={["all", "withAny", "complete", "missing"]} labels={{ withAny: "With any visit", complete: "Complete visits", missing: "Missing any visit" }} />
            <FilterSelect label="Assessment Status" value={assessmentStatusFilter} onChange={setAssessmentStatusFilter} options={["all", "complete", "missing"]} labels={{ complete: "Complete assessments", missing: "Missing assessments" }} />
            <FilterSelect label="Source Module" value={sourceModuleFilter} onChange={setSourceModuleFilter} options={["all", ...sourceModules]} />
          </div>
          <div className="mt-4 rounded-lg bg-[#F0FDF4] p-3 text-sm text-[#064E3B]">
            <strong>{filteredRows.length.toLocaleString()}</strong> of {coverage.summary.totalUnits.toLocaleString()} monitoring units shown.
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[#D8E6E1] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#D8E6E1] bg-[#F0FDF4] px-4 py-3">
          <div>
            <h4 className="font-bold text-[#064E3B]">Coverage Matrix</h4>
            <p className="text-sm text-[#64748B]">Every row includes the module and source file supporting the result.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {quickFilter !== "all" && (
              <button type="button" onClick={() => setQuickFilter("all")} className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-[#064E3B]">
                Clear KPI filter
              </button>
            )}
            <div className="relative">
              <button
                type="button"
                onClick={() => setDownloadMenuOpen((open) => !open)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#064E3B] px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#047857] sm:w-auto"
                aria-haspopup="menu"
                aria-expanded={downloadMenuOpen}
              >
                <Download size={16} />
                Download Coverage Matrix
                <ChevronDown size={16} />
              </button>
              {downloadMenuOpen && (
                <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-lg border border-[#D8E6E1] bg-white text-sm shadow-lg" role="menu">
                  <button type="button" onClick={() => handleCoverageDownload("xlsx")} className="block w-full px-4 py-2 text-left font-semibold text-[#064E3B] hover:bg-[#F0FDF4]" role="menuitem">
                    Download Excel (.xlsx)
                  </button>
                  <button type="button" onClick={() => handleCoverageDownload("csv")} className="block w-full px-4 py-2 text-left font-semibold text-[#064E3B] hover:bg-[#F0FDF4]" role="menuitem">
                    Download CSV
                  </button>
                  <button type="button" onClick={() => handleCoverageDownload("pdf")} className="block w-full px-4 py-2 text-left font-semibold text-[#064E3B] hover:bg-[#F0FDF4]" role="menuitem">
                    Download PDF
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full min-w-[1500px] table-auto text-sm">
            <thead className="sticky top-0 z-10 bg-white text-left text-xs uppercase tracking-wide text-[#064E3B] shadow-sm">
              <tr>
                {[
                  "Monitoring Unit Name",
                  "Municipality",
                  "Type",
                  "Count Unit",
                  "SLP Participant ID",
                  "Project ID / Association Name",
                  "1st Visit",
                  "2nd Visit",
                  "3rd Visit",
                  "4th Visit",
                  "Organizational Assessment",
                  "Annual Assessment",
                  "Missing Requirement",
                  "Source Module",
                  "Source File",
                ].map((header) => <th key={header} className="p-3 align-top">{header}</th>)}
              </tr>
            </thead>
            <tbody>
              {filteredRows.length ? filteredRows.map((row) => (
                <tr key={row.unitKey} className="border-t border-[#D8E6E1]">
                  <td className="p-3 font-semibold text-[#0F172A]">{row.monitoringUnitName || "Not Found"}</td>
                  <td className="p-3 text-[#334155]">{row.municipality || "Not Found"}</td>
                  <td className="p-3 text-[#334155]">{row.type}</td>
                  <td className="p-3 text-[#334155]">{row.countUnit}</td>
                  <td className="p-3 text-[#334155]">{row.slpParticipantId || "Not Found"}</td>
                  <td className="p-3 text-[#334155]">{row.projectIdAssociationName || "Not Found"}</td>
                  <td className="p-3"><StatusCell status={row.visits[1]} /></td>
                  <td className="p-3"><StatusCell status={row.visits[2]} /></td>
                  <td className="p-3"><StatusCell status={row.visits[3]} /></td>
                  <td className="p-3"><StatusCell status={row.visits[4]} /></td>
                  <td className="p-3"><StatusCell status={row.organizationalAssessment} /></td>
                  <td className="p-3"><StatusCell status={row.annualAssessment} /></td>
                  <td className="max-w-[260px] p-3 text-[#334155]">{row.missingRequirement || "No matching record"}</td>
                  <td className="max-w-[240px] p-3 text-[#334155]">{row.sourceModule || "Not Found"}</td>
                  <td className="max-w-[320px] p-3 text-[#334155]">{row.sourceFile || "Not Found"}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={15} className="p-6 text-center text-[#64748B]">No matching record for the current monitoring coverage filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function DebugMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-white/80 px-3 py-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">{label}</p>
      <p className="font-bold text-amber-950">{typeof value === "number" ? value.toLocaleString() : value}</p>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  labels = {},
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  labels?: Record<string, string>;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm">
        {options.map((option) => (
          <option key={option} value={option}>{option === "all" ? "All" : labels[option] || option}</option>
        ))}
      </select>
    </label>
  );
}
