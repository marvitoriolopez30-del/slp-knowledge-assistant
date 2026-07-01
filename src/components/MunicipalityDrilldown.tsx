import { useEffect, useMemo, useState } from "react";
import { Clipboard, Download, X } from "lucide-react";
import { normalizeAuroraMunicipality, type DashboardParsedFile, type LivelihoodSustainabilityRecord, type MunicipalityDrilldownRecord, type MunicipalityStat } from "../utils/dashboardAnalytics";

type DrilldownSelection = {
  municipality: string;
  column: string;
  value: string | number;
  records: MunicipalityDrilldownRecord[];
};

type GurEncodingRow = {
  name: string;
  encodedLabel: string;
  notEncodedLabel: string;
  notYetDueLabel: string;
  encodedAmountLabel?: string;
  notEncodedAmountLabel?: string;
  encoded: number;
  notEncoded: number;
  notYetDue: number;
  eligibleTarget: number;
  denominator: number;
  encodedAmount: number;
  notEncodedAmount: number;
  totalAmount: number;
  encodedDetails?: MunicipalityDrilldownRecord[];
  notEncodedDetails?: MunicipalityDrilldownRecord[];
  totalAmountDisplay: string;
  encodedAmountDisplay: string;
  notEncodedAmountDisplay: string;
  completion: number;
  completionDisplay: string;
  isOverall?: boolean;
};

type MunicipalityMonitoringBreakdownRow = {
  municipality: string;
  totalGurUnits: number;
  firstVisitEligible: number;
  firstVisitEncoded: number;
  firstVisitNotEncoded: number;
  firstVisitNotYetDue: number;
  secondVisitEligible: number;
  secondVisitEncoded: number;
  secondVisitNotEncoded: number;
  secondVisitNotYetDue: number;
  thirdVisitEligible: number;
  thirdVisitEncoded: number;
  thirdVisitNotEncoded: number;
  thirdVisitNotYetDue: number;
  fourthVisitEligible: number;
  fourthVisitEncoded: number;
  fourthVisitNotEncoded: number;
  fourthVisitNotYetDue: number;
  overallMonitoringCompletion: number;
  mdAnnualAssessmentEncoded: number;
  mdAnnualAssessmentNotEncoded: number;
  mdAnnualAssessmentCompletion: number;
  orgAssessmentEncoded: number;
  orgAssessmentNotEncoded: number;
  orgAssessmentCompletion: number;
  isTotal?: boolean;
};

const auroraMunicipalities = ["Baler", "Casiguran", "Dilasag", "Dinalungan", "Dingalan", "Dipaculao", "Maria Aurora", "San Luis"];

const columnHeaders: Record<string, string[]> = {
  Municipality: ["Category", "SLP Paricipant ID", "Name", "Municipality", "Barangay", "Project ID", "Project Name", "Enterprise Type", "Status", "GUR Status", "Training Status", "Source Module", "Source File"],
  Participants: ["SLP Paricipant ID", "Name", "Municipality", "Barangay", "Project ID", "Project Name", "Enterprise Type", "Source File"],
  Associations: ["Project ID", "Project Name", "SLPA Name", "Municipality", "Barangay", "Enterprise Type", "Source File"],
  "Individual Enterprises": ["SLP Paricipant ID", "Name", "Municipality", "Barangay", "Project ID", "Project Name", "Enterprise Type", "Source File"],
  Operational: ["Monitoring Unit Name", "Name", "SLPA Name", "Type", "Municipality", "Barangay", "Project ID", "Grant Code", "SLP Paricipant ID", "Enterprise Type", "Status", "Sustainability Status", "Financial Rating Score", "Financial Rating Category", "Source Module", "Source File"],
  Closed: ["Monitoring Unit Name", "Type", "Municipality", "Barangay", "Project ID", "SLP Paricipant ID", "Enterprise Type", "Status", "Source Module", "Source File"],
  "Top Project": ["Project ID", "Project Name", "SLP Paricipant ID", "Name", "Municipality", "Barangay", "Enterprise Type", "Status", "Source File"],
  "Most Operational": ["Project ID", "Project Name", "SLP Paricipant ID", "Name", "Municipality", "Barangay", "Enterprise Type", "Status", "Source File"],
  "Most Closed": ["Project ID", "Project Name", "SLP Paricipant ID", "Name", "Municipality", "Barangay", "Enterprise Type", "Status", "Source File"],
  "With GUR": ["Project ID", "Project Name", "SLPA Name", "Municipality", "Barangay", "Enterprise Type", "GUR Status", "Source File"],
  "Without GUR": ["Project ID", "Project Name", "SLPA Name", "Municipality", "Barangay", "Enterprise Type", "GUR Status", "Source File"],
  "With Training": ["SLP Paricipant ID", "Name", "Project ID", "Project Name", "Municipality", "Barangay", "Training Title", "Training Date", "Source File"],
  "Without Training": ["SLP Paricipant ID", "Name", "Project ID", "Project Name", "Municipality", "Barangay", "Training Status", "Source File"],
};

const encodedVisitDetailColumns = ["Municipality", "Barangay", "Participant/Association Name", "Grant Code", "Source Module", "Visit", "Date Monitored", "Amount 1", "Amount Source"];
const notEncodedVisitDetailColumns = ["Municipality", "Barangay", "Participant/Association Name", "Grant Code", "Project Enterprise", "GUR Date", "DSWD Total Cost", "Amount Source", "Missing Visit"];
const gurDetailColumns = ["Grant Code", "Project Enterprise", "Unit Type", "Participant/Association Name", "Project ID", "Municipality", "Barangay", "GUR Date", "DSWD Total Cost", "1st Visit", "2nd Visit", "3rd Visit", "4th Visit", "Encoded in MdAnnualAssessment", "Encoded in OrgAssessment", "Source File"];

[
  "Total GUR Units",
  "Individual Units",
  "Association Units",
  "Encoded in 1st Visit",
  "Not Encoded in 1st Visit",
  "Not Yet Due in 1st Visit",
  "Encoded in 2nd Visit",
  "Not Encoded in 2nd Visit",
  "Not Yet Due in 2nd Visit",
  "Encoded in 3rd Visit",
  "Not Encoded in 3rd Visit",
  "Not Yet Due in 3rd Visit",
  "Encoded in 4th Visit",
  "Not Encoded in 4th Visit",
  "Not Yet Due in 4th Visit",
  "Encoded in MdAnnualAssessment",
  "Not Encoded in MdAnnualAssessment",
  "Not Yet Due in MdAnnualAssessment",
  "Encoded in OrgAssessment",
  "Not Encoded in OrgAssessment",
  "Not Yet Due in OrgAssessment",
].forEach((key) => {
  columnHeaders[key] = gurDetailColumns;
});

[
  "Encoded in 1st Visit",
  "Encoded Amount in 1st Visit",
  "Encoded in 2nd Visit",
  "Encoded Amount in 2nd Visit",
  "Encoded in 3rd Visit",
  "Encoded Amount in 3rd Visit",
  "Encoded in 4th Visit",
  "Encoded Amount in 4th Visit",
].forEach((key) => {
  columnHeaders[key] = encodedVisitDetailColumns;
});

[
  "Not Encoded in 1st Visit",
  "Not Encoded Amount in 1st Visit",
  "Not Encoded in 2nd Visit",
  "Not Encoded Amount in 2nd Visit",
  "Not Encoded in 3rd Visit",
  "Not Encoded Amount in 3rd Visit",
  "Not Encoded in 4th Visit",
  "Not Encoded Amount in 4th Visit",
].forEach((key) => {
  columnHeaders[key] = notEncodedVisitDetailColumns;
});

export function MunicipalityDrilldown({
  municipalities,
  records,
  parsedFiles = [],
  sustainabilityRecords = [],
  selectedMunicipality,
  onSelectMunicipality,
}: {
  municipalities: MunicipalityStat[];
  records: MunicipalityDrilldownRecord[];
  parsedFiles?: DashboardParsedFile[];
  sustainabilityRecords?: LivelihoodSustainabilityRecord[];
  selectedMunicipality?: MunicipalityStat["municipality"];
  onSelectMunicipality?: (municipality: MunicipalityStat["municipality"]) => void;
}) {
  const [selectedMunicipalityDrilldown, setSelectedMunicipalityDrilldown] = useState<DrilldownSelection | null>(null);
  const [financialOverviewRecord, setFinancialOverviewRecord] = useState<LivelihoodSustainabilityRecord | null>(null);
  const [detailSearch, setDetailSearch] = useState("");
  const [detailRowLimit, setDetailRowLimit] = useState(100);

  const openFinancialOverview = (record: MunicipalityDrilldownRecord) => {
    const match = sustainabilityRecords.find((item) => item.id && item.id === record.__sustainabilityRecordId)
      || sustainabilityRecords.find((item) =>
        sameText(item.Municipality, record.Municipality)
        && sameText(item.Barangay, record.Barangay)
        && (
          sameText(item["Project ID"], record["Project ID"])
          || sameText(item["SLP Paricipant ID"], record["SLP Paricipant ID"])
          || sameText(item.Name, record.Name)
          || sameText(item.Name, record["Monitoring Unit Name"])
          || sameText(item["SLPA Name"], record["SLPA Name"])
        ));
    console.log("FINANCIAL_OVERVIEW_OPEN", {
      municipality: record.Municipality,
      name: record.Name || record["SLPA Name"] || record["Monitoring Unit Name"],
      projectId: record["Project ID"],
      sustainabilityRecordId: record.__sustainabilityRecordId || "",
    });
    console.log("FINANCIAL_OVERVIEW_MATCH_RESULT", {
      matched: Boolean(match),
      matchId: match?.id || "",
      status: match?.["Sustainability Status"] || "No monitoring data found",
      sourceFile: match?.["Source File"] || "",
    });
    setFinancialOverviewRecord(match || {
      Name: record.Name || record["Monitoring Unit Name"] || "Not encoded",
      "SLPA Name": record["SLPA Name"] || "",
      Type: record.Type || "Not encoded",
      Municipality: record.Municipality || "Not encoded",
      Barangay: record.Barangay || "Not encoded",
      "Project ID": record["Project ID"] || "",
      "Grant Code": record["Grant Code"] || "",
      "SLP Paricipant ID": record["SLP Paricipant ID"] || "",
      "Enterprise Type": record["Enterprise Type"] || "",
      "Latest Visit": "No monitoring data found",
      "Sustainability Status": "No Monitoring Data",
      "Financial Rating Category": "Insufficient Data",
      "Rating Explanation": "No monitoring data found",
      "Positive Indicators": "",
      "Risk Indicators": "No monitoring data found",
      "Source Module": record["Source Module"] || "",
      "Source File": record["Source File"] || "",
      __noMonitoringMatch: true,
    });
  };

  function getMunicipalityCellRecords(municipality: string, column: string, value: string | number) {
    const selected = normalizeAuroraMunicipality(municipality);
    const municipalityRecords = records.filter((record) => selected ? normalizeAuroraMunicipality(record.Municipality) === selected : record.Municipality === municipality);
    const projectRecords = municipalityRecords.filter((record) => record.Category === "association" || record.Category === "individualEnterprise");
    const statusRecords = municipalityRecords.filter((record) => record.Category === "status");
    const trainingRecords = municipalityRecords.filter((record) => record.Category === "training");
    if (column === "Municipality") return municipalityRecords;
    if (column === "Participants") return municipalityRecords.filter((record) => record.Category === "participant");
    if (column === "Associations") return projectRecords.filter((record) => record.Category === "association");
    if (column === "Individual Enterprises") return uniqueBy(projectRecords.filter((record) => record.Category === "individualEnterprise"), (record) => String(record.__participantKey || record.Name || record["Project ID"]));
    if (column === "Operational") return statusRecords.filter((record) => record.__status === "operational");
    if (column === "Closed") return statusRecords.filter((record) => record.__status === "closed");
    if (column === "Top Project") return projectRecords.filter((record) => sameText(record["Enterprise Type"], value) || sameText(record["Project Name"], value));
    if (column === "Most Operational") return statusRecords.filter((record) => record.__status === "operational" && (sameText(record["Enterprise Type"], value) || sameText(record["Project Name"], value)));
    if (column === "Most Closed") return statusRecords.filter((record) => record.__status === "closed" && (sameText(record["Enterprise Type"], value) || sameText(record["Project Name"], value)));
    if (column === "With GUR") return projectRecords.filter((record) => record.__hasGur === true);
    if (column === "Without GUR") return projectRecords.filter((record) => record.__hasGur !== true);
    if (column === "With Training") return projectRecords.filter((record) => record.__hasTraining === true);
    if (column === "Without Training") return projectRecords.filter((record) => record.__hasTraining !== true).map((record) => ({ ...record, "Training Status": "Without Training" }));
    if (isGurDrilldownColumn(column)) return filterGurRecords(gurRecordsForMunicipality(gurUnits, municipality), column);
    return [];
  }

  const openDetail = (item: MunicipalityStat, column: string, value: string | number) => {
    onSelectMunicipality?.(item.municipality);
    setDetailSearch("");
    setDetailRowLimit(100);
    setSelectedMunicipalityDrilldown({
      municipality: item.municipality,
      column,
      value,
      records: getMunicipalityCellRecords(item.municipality, column, value),
    });
  };

  const filteredDetailRecords = useMemo(() => {
    const rows = selectedMunicipalityDrilldown?.records || [];
    const needle = detailSearch.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((record) => Object.values(record).some((value) => String(value ?? "").toLowerCase().includes(needle)));
  }, [detailSearch, selectedMunicipalityDrilldown]);

  const detailColumns = selectedMunicipalityDrilldown ? columnHeaders[selectedMunicipalityDrilldown.column] || columnHeaders.Municipality : [];
  const selectedGurMunicipality = selectedMunicipality || municipalities[0]?.municipality || "Baler";
  const gurSource = useMemo(() => buildGurDrilldownFromParsedFiles(parsedFiles), [parsedFiles]);
  const gurUnits = gurSource.units.length ? gurSource.units : records.filter((record) => record.Category === "gurMonitoringAssessment");
  const selectedGurUnits = useMemo(() => gurRecordsForMunicipality(gurUnits, selectedGurMunicipality), [gurUnits, selectedGurMunicipality]);
  const gurDisplay = useMemo(() => buildGurDisplay(selectedGurUnits), [selectedGurUnits]);
  const provinceGurUnits = useMemo(() => gurRecordsForProvince(gurUnits), [gurUnits]);
  const provinceGurDisplay = useMemo(() => buildGurDisplay(provinceGurUnits), [provinceGurUnits]);
  const municipalityMonitoringBreakdown = useMemo(() => buildMunicipalityMonitoringBreakdown(provinceGurUnits), [provinceGurUnits]);
  const gurSourceStatus = records.find((record) => record.Category === "__gurSourceStatus");
  const gurSourceMessages = [
    gurSource.gurRows.length === 0 && Number(gurSourceStatus?.["GUR Rows Loaded"] || 0) === 0 ? "Grant Utilization source rows are not loaded." : "",
    gurSource.monitoringIndividualRows.length + gurSource.monitoringAssociationRows.length === 0 && Number(gurSourceStatus?.["Monitoring Rows Loaded"] || 0) === 0 ? "Monitoring source rows are not loaded." : "",
    gurSource.orgAssessmentRows.length + gurSource.annualAssessmentRows.length === 0 && Number(gurSourceStatus?.["Assessment Rows Loaded"] || 0) === 0 ? "Assessment source rows are not loaded." : "",
  ].filter(Boolean);
  const openGurDetail = (column: string) => {
    const item = municipalities.find((row) => row.municipality === selectedGurMunicipality);
    if (item) onSelectMunicipality?.(item.municipality);
    const nextRecords = filterGurRecords(selectedGurUnits, column);
    setDetailSearch("");
    setDetailRowLimit(100);
    setSelectedMunicipalityDrilldown({
      municipality: selectedGurMunicipality,
      column,
      value: nextRecords.length,
      records: nextRecords,
    });
  };
  const openProvinceGurDetail = (column: string) => {
    const nextRecords = filterGurRecords(provinceGurUnits, column);
    setDetailSearch("");
    setDetailRowLimit(100);
    setSelectedMunicipalityDrilldown({
      municipality: "Province-wide",
      column,
      value: nextRecords.length,
      records: nextRecords,
    });
  };

  const gurDebug = useMemo(() => ({
    selectedMunicipality: selectedGurMunicipality,
    grantUtilizationRows: gurSource.gurRows.length,
    monitoringIndividualRows: gurSource.monitoringIndividualRows.length,
    monitoringAssociationRows: gurSource.monitoringAssociationRows.length,
    annualAssessmentRows: gurSource.annualAssessmentRows.length,
    orgAssessmentRows: gurSource.orgAssessmentRows.length,
    uniqueGurGrantCodes: gurUnits.length,
    municipalityGurUnits: selectedGurUnits.length,
    duplicateGrantCodesMerged: gurSource.duplicateGrantCodesMerged,
    missingGrantCodeRows: gurSource.missingGrantCodeRows,
    with1stVisit: selectedGurUnits.filter((record) => hasVisit(record, 1)).length,
    without1stVisit: selectedGurUnits.filter((record) => !hasVisit(record, 1)).length,
    with2ndVisit: selectedGurUnits.filter((record) => hasVisit(record, 2)).length,
    without2ndVisit: selectedGurUnits.filter((record) => !hasVisit(record, 2)).length,
    with3rdVisit: selectedGurUnits.filter((record) => hasVisit(record, 3)).length,
    without3rdVisit: selectedGurUnits.filter((record) => !hasVisit(record, 3)).length,
    with4thVisit: selectedGurUnits.filter((record) => hasVisit(record, 4)).length,
    without4thVisit: selectedGurUnits.filter((record) => !hasVisit(record, 4)).length,
    encodedInAnnualAssessment: filterGurRecords(selectedGurUnits, "Encoded in MdAnnualAssessment").length,
    notEncodedInAnnualAssessment: filterGurRecords(selectedGurUnits, "Not Encoded in MdAnnualAssessment").length,
    encodedInOrgAssessment: filterGurRecords(selectedGurUnits, "Encoded in OrgAssessment").length,
    notEncodedInOrgAssessment: filterGurRecords(selectedGurUnits, "Not Encoded in OrgAssessment").length,
    sampleGurRow: gurSource.gurRows[0],
    sampleGurUnit: gurUnits[0],
  }), [gurSource, gurUnits, selectedGurMunicipality, selectedGurUnits]);
  useEffect(() => {
    console.log("GUR GRANT CODE CROSSCHECK DEBUG", gurDebug);
  }, [gurDebug]);
  const gurEncodedVsNotEncodedCheck = useMemo(() => buildGurConsistencyCheck(selectedGurMunicipality, selectedGurUnits), [selectedGurMunicipality, selectedGurUnits]);
  useEffect(() => {
    console.log("GUR ENCODED VS NOT ENCODED CHECK", gurEncodedVsNotEncodedCheck);
  }, [gurEncodedVsNotEncodedCheck]);
  const projectEnterpriseDebug = useMemo(() => buildProjectEnterpriseDebug(selectedGurMunicipality, gurSource, gurUnits, selectedGurUnits), [gurSource, gurUnits, selectedGurMunicipality, selectedGurUnits]);
  useEffect(() => {
    console.log("GUR PROJECT ENTERPRISE CLASSIFICATION DEBUG", projectEnterpriseDebug);
  }, [projectEnterpriseDebug]);
  useEffect(() => {
    const totalCard = gurDisplay.summaryCards.find((card) => card.label === "Total GUR Units");
    const individualCard = gurDisplay.summaryCards.find((card) => card.label === "Individual Units");
    const associationCard = gurDisplay.summaryCards.find((card) => card.label === "Association Units");
    console.log("GUR_BASE_AMOUNT_SUMMARY", {
      municipality: selectedGurMunicipality,
      totalUnits: totalCard?.value || 0,
      totalAmount: totalCard?.amount || 0,
      individualUnits: individualCard?.value || 0,
      individualAmount: individualCard?.amount || 0,
      associationUnits: associationCard?.value || 0,
      associationAmount: associationCard?.amount || 0,
    });
  }, [gurDisplay, selectedGurMunicipality]);
  useEffect(() => {
    console.log("GUR_BASE_AMOUNT_TOTAL", gurDisplay.visitRows[0]?.totalAmountDisplay || "N/A");
    gurDisplay.visitRows.forEach((row, index) => {
      if (row.isOverall) {
        if (row.encoded + row.notEncoded !== row.eligibleTarget) {
          console.warn("[GUR_OVERALL_COUNT_VALIDATION_FAILED]", {
            encodedCount: row.encoded,
            notEncodedCount: row.notEncoded,
            eligibleVisitSlots: row.eligibleTarget,
            notYetDueCount: row.notYetDue,
          });
        }
        return;
      }
      const visitNumber = index + 1;
      console.log(`VISIT_${visitNumber}_ENCODED_AMOUNT`, row.encodedAmountDisplay);
      console.log(`VISIT_${visitNumber}_NOT_ENCODED_AMOUNT`, row.notEncodedAmountDisplay);
      if (row.encoded + row.notEncoded !== row.eligibleTarget) {
        console.warn("[GUR_VISIT_COUNT_VALIDATION_FAILED]", {
          visit: row.name,
          encodedCount: row.encoded,
          notEncodedCount: row.notEncoded,
          eligibleTarget: row.eligibleTarget,
          notYetDueCount: row.notYetDue,
        });
      }
      console.log("[GUR_VISIT_AMOUNT_SOURCE_VALIDATION]", {
        visit: row.name,
        encodedAmountSource: "MdMonitoring individual/association Amount 1",
        encodedAmount: row.encodedAmountDisplay,
        notEncodedAmountSource: "Grant Utilization DSWD Total Cost",
        notEncodedAmount: row.notEncodedAmountDisplay,
        totalGurAmountSource: "Grant Utilization DSWD Total Cost",
        totalGurAmount: row.totalAmountDisplay,
      });
    });
  }, [gurDisplay]);
  useEffect(() => {
    const encodedVisit1 = provinceGurUnits.filter((record) => hasVisit(record, 1)).length;
    const encodedVisit2 = provinceGurUnits.filter((record) => hasVisit(record, 2)).length;
    const encodedVisit3 = provinceGurUnits.filter((record) => hasVisit(record, 3)).length;
    const encodedVisit4 = provinceGurUnits.filter((record) => hasVisit(record, 4)).length;
    const totalGurUnits = provinceGurUnits.length;
    const totalRequiredVisits = provinceGurDisplay.visitRows.find((row) => row.isOverall)?.eligibleTarget || 0;
    const completedVisits = provinceGurDisplay.visitRows.find((row) => row.isOverall)?.encoded || 0;
    const missingVisits = provinceGurDisplay.visitRows.find((row) => row.isOverall)?.notEncoded || 0;
    const completionPercent = totalRequiredVisits ? (completedVisits / totalRequiredVisits) * 100 : 0;
    console.log("PROVINCE_MONITORING_SUMMARY_DEBUG", {
      totalGurUnits,
      totalRequiredVisits,
      encodedVisit1,
      encodedVisit2,
      encodedVisit3,
      encodedVisit4,
      completedVisits,
      missingVisits,
      completionPercent,
    });
    console.log("PROVINCE_ASSESSMENT_SUMMARY_DEBUG", {
      mdAnnualAssessmentDenominator: provinceGurDisplay.assessmentRows.find((row) => row.name === "MdAnnualAssessment")?.eligibleTarget || 0,
      mdAnnualAssessmentEncoded: provinceGurDisplay.assessmentRows.find((row) => row.name === "MdAnnualAssessment")?.encoded || 0,
      orgAssessmentDenominator: provinceGurDisplay.assessmentRows.find((row) => row.name === "OrgAssessment")?.eligibleTarget || 0,
      orgAssessmentEncoded: provinceGurDisplay.assessmentRows.find((row) => row.name === "OrgAssessment")?.encoded || 0,
    });
  }, [provinceGurDisplay, provinceGurUnits]);
  useEffect(() => {
    console.log("VISIT_DUE_DATE_DEBUG", buildVisitDueDateDebug(selectedGurMunicipality, selectedGurUnits));
    console.log("ASSESSMENT_DUE_DEBUG", buildAssessmentDueDebug(selectedGurUnits));
  }, [selectedGurMunicipality, selectedGurUnits]);
  useEffect(() => {
    console.log("MUNICIPALITY_MONITORING_BREAKDOWN_DEBUG", municipalityMonitoringBreakdown);
  }, [municipalityMonitoringBreakdown]);

  const summaryColumns = ["Municipality", "Participants", "Associations", "Individual Enterprises", "Operational", "Closed", "Top Project", "Most Operational", "Most Closed", "With GUR", "Without GUR", "With Training", "Without Training"];
  const summaryRows = municipalities.map((item) => [
    item.municipality,
    item.totalParticipants,
    item.totalAssociations,
    item.individualEnterprises,
    item.operational,
    item.closed,
    item.topEnterpriseType,
    item.mostOperationalEnterprise || "No data yet",
    item.mostClosedEnterprise || "No data yet",
    item.withGrantUtilizationReport || 0,
    item.withoutGrantUtilizationReport || 0,
    item.withTraining || 0,
    item.withoutTraining || 0,
  ]);
  const pagedDetailRecords = filteredDetailRecords.slice(0, detailRowLimit);

  return (
    <div className="rounded-xl border border-[#D8E6E1] bg-white shadow-sm overflow-hidden">
      <div className="border-b border-[#D8E6E1] p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Municipality Drill-down</p>
            <h3 className="mt-1 text-2xl font-bold text-[#064E3B]">Clickable Municipality Details</h3>
            <p className="mt-1 max-w-3xl text-sm text-[#64748B]">Aggregated from the latest parsed SLPIS and monitoring rows. Select any metric cell to open the detail panel.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => downloadProvinceMonitoringSummaryCsvV2(provinceGurDisplay, municipalityMonitoringBreakdown)} className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#F0FDF4]">
              <Download size={16} /> Export Province Monitoring Summary
            </button>
            <button type="button" onClick={() => downloadSummaryCsv(summaryRows, summaryColumns, gurDisplay, selectedGurMunicipality)} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#064E3B] px-3 py-2 text-sm font-semibold text-white hover:bg-[#047857]">
              <Download size={16} /> Export section
            </button>
          </div>
        </div>
      </div>
      <div className="border-b border-[#D8E6E1] bg-[#F8FAFC] p-4">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Selected Municipality GUR Drilldown</p>
            <h4 className="text-lg font-bold text-[#064E3B]">{selectedGurMunicipality}</h4>
          </div>
          <p className="text-sm text-[#64748B]">Starts from GUR encoded records, then checks monitoring and assessment modules.</p>
        </div>
        {gurSourceMessages.length > 0 && (
          <div className="mt-3 grid gap-2 text-sm text-amber-800">
            {gurSourceMessages.map((message) => (
              <div key={message} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">{message}</div>
            ))}
          </div>
        )}
        <div className="mt-3 space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">GUR Base Summary</p>
            <div className="mt-2 grid gap-3 md:grid-cols-3">
              {gurDisplay.summaryCards.map((card) => (
                <button
                  key={card.label}
                  type="button"
                  onClick={() => openGurDetail(card.label)}
                  className="rounded-lg border border-[#D8E6E1] bg-white p-3 text-left shadow-sm hover:border-[#047857] hover:bg-[#F0FDF4]"
                >
                  <p className="text-sm font-bold text-[#064E3B]">{card.label}</p>
                  <p className="mt-2 text-2xl font-bold text-[#0F172A]">{card.value.toLocaleString()}</p>
                  <p className="mt-1 text-xs font-semibold text-[#64748B]">Amount: <span className="text-[#064E3B]">{card.amountDisplay}</span></p>
                </button>
              ))}
            </div>
          </div>

          <GurEncodingTableV2 title="Monitoring Visit Encoding" firstColumn="Visit" rows={gurDisplay.visitRows} onOpen={openGurDetail} showAmounts />
          <p className="text-xs text-[#64748B]">Targets are eligibility-based. Records are counted as Not Encoded only when the required waiting period has already passed. Records not yet due are shown separately.</p>
          <GurEncodingTableV2 title="Assessment Encoding" firstColumn="Assessment" denominatorColumn="Denominator" rows={gurDisplay.assessmentRows} onOpen={openGurDetail} />
          <p className="text-xs text-[#64748B]">Organizational Assessment applies only to associations.</p>
          <div className="rounded-xl border border-[#D8E6E1] bg-white p-3 shadow-sm">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Province-wide Monitoring & Assessment Encoding Summary</p>
                <h4 className="text-lg font-bold text-[#064E3B]">All Aurora Municipalities</h4>
              </div>
              <p className="text-sm text-[#64748B]">Uses all GUR units from the province while retaining existing global source filters.</p>
            </div>
            <div className="mt-3 space-y-4">
              <GurEncodingTableV2 title="Province-wide Monitoring Visit Encoding" firstColumn="Visit" rows={provinceGurDisplay.visitRows} onOpen={openProvinceGurDetail} showAmounts />
              <SimpleAssessmentEncodingTable title="Province-wide Assessment Encoding" rows={provinceGurDisplay.assessmentRows} onOpen={openProvinceGurDetail} />
              <p className="text-xs text-[#64748B]">Targets are eligibility-based. Records are counted as Not Encoded only when the required waiting period has already passed. Records not yet due are shown separately.</p>
              <MunicipalityMonitoringBreakdownTable rows={municipalityMonitoringBreakdown} />
            </div>
          </div>
        </div>
      </div>
      <div className="grid gap-3 p-3 lg:hidden">
        {municipalities.map((item) => (
          <button
            key={item.municipality}
            type="button"
            onClick={() => openDetail(item, "Municipality", item.municipality)}
            className="rounded-lg border border-[#D8E6E1] bg-white p-3 text-left shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-[#0F172A]">{item.municipality}</p>
                <p className="mt-1 text-xs text-[#64748B]">{item.topEnterpriseType || "No top project yet"}</p>
              </div>
              <div className="text-right text-xs text-[#64748B]">
                <p><span className="font-semibold text-emerald-700">{item.operational}</span> operational</p>
                <p><span className="font-semibold text-rose-700">{item.closed}</span> closed</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#334155]">
              <span>Participants: <b>{item.totalParticipants}</b></span>
              <span>Associations: <b>{item.totalAssociations}</b></span>
              <span>Individual: <b>{item.individualEnterprises}</b></span>
              <span>GUR: <b>{item.withGrantUtilizationReport || 0}</b> / <b>{item.withoutGrantUtilizationReport || 0}</b></span>
              <span className="col-span-2">Training: <b>{item.withTraining || 0}</b> / <b>{item.withoutTraining || 0}</b></span>
            </div>
          </button>
        ))}
      </div>
      <div className="hidden w-full max-w-full overflow-hidden lg:block">
        <div className="max-h-[620px] w-full max-w-full overflow-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full table-auto text-sm" style={{ minWidth: 1180 }}>
            <thead className="sticky top-0 z-10 bg-[#F0FDF4] text-left text-xs uppercase tracking-wide text-[#064E3B]">
              <tr>
                {["Municipality", "Participants", "Associations", "Individual Enterprises", "Operational", "Closed", "Top Project", "Most Operational", "Most Closed", "With GUR", "Without GUR", "With Training", "Without Training"].map((header) => (
                  <th key={header} className="p-3">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {municipalities.map((item) => (
                <tr key={item.municipality} className="border-t border-[#D8E6E1] hover:bg-[#F8FAFC]">
                  <ClickableCell className="font-semibold text-[#0F172A]" value={item.municipality} onClick={() => openDetail(item, "Municipality", item.municipality)} />
                  <ClickableCell value={item.totalParticipants} onClick={() => openDetail(item, "Participants", item.totalParticipants)} />
                  <ClickableCell value={item.totalAssociations} onClick={() => openDetail(item, "Associations", item.totalAssociations)} />
                  <ClickableCell value={item.individualEnterprises} onClick={() => openDetail(item, "Individual Enterprises", item.individualEnterprises)} />
                  <ClickableCell className="text-emerald-700" value={item.operational} onClick={() => openDetail(item, "Operational", item.operational)} />
                  <ClickableCell className="text-rose-700" value={item.closed} onClick={() => openDetail(item, "Closed", item.closed)} />
                  <ClickableCell value={item.topEnterpriseType} onClick={() => openDetail(item, "Top Project", item.topEnterpriseType)} />
                  <ClickableCell value={item.mostOperationalEnterprise || "No data yet"} onClick={() => openDetail(item, "Most Operational", item.mostOperationalEnterprise || "No data yet")} />
                  <ClickableCell value={item.mostClosedEnterprise || "No data yet"} onClick={() => openDetail(item, "Most Closed", item.mostClosedEnterprise || "No data yet")} />
                  <ClickableCell value={item.withGrantUtilizationReport || 0} onClick={() => openDetail(item, "With GUR", item.withGrantUtilizationReport || 0)} />
                  <ClickableCell value={item.withoutGrantUtilizationReport || 0} onClick={() => openDetail(item, "Without GUR", item.withoutGrantUtilizationReport || 0)} />
                  <ClickableCell value={item.withTraining || 0} onClick={() => openDetail(item, "With Training", item.withTraining || 0)} />
                  <ClickableCell value={item.withoutTraining || 0} onClick={() => openDetail(item, "Without Training", item.withoutTraining || 0)} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedMunicipalityDrilldown && (
        <div className="border-t border-[#D8E6E1] bg-[#F8FAFC] p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h4 className="text-lg font-bold text-[#064E3B]">{selectedMunicipalityDrilldown.municipality} — {selectedMunicipalityDrilldown.column}</h4>
              <p className="text-sm text-[#64748B]">Showing {pagedDetailRecords.length.toLocaleString()} of {filteredDetailRecords.length.toLocaleString()} records</p>
              <p className="text-xs text-[#64748B]">Click any count to view source records. Export downloads the currently visible filtered data.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => downloadDetailCsv(pagedDetailRecords, detailColumns, selectedMunicipalityDrilldown)} className="inline-flex items-center gap-2 rounded-lg bg-[#064E3B] px-3 py-2 text-sm font-semibold text-white hover:bg-[#047857]">
                <Download size={16} /> Download CSV
              </button>
              <button type="button" onClick={() => copyDetailTable(pagedDetailRecords, detailColumns)} className="inline-flex items-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#F0FDF4]">
                <Clipboard size={16} /> Copy Table
              </button>
              <button type="button" onClick={() => setSelectedMunicipalityDrilldown(null)} className="inline-flex items-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#F0FDF4]">
                <X size={16} /> Close
              </button>
            </div>
          </div>
          <input
            type="search"
            value={detailSearch}
            onChange={(event) => setDetailSearch(event.target.value)}
            placeholder="Search detail records..."
            className="mt-3 w-full rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm outline-none focus:border-[#047857] focus:ring-2 focus:ring-[#047857]/20"
          />
          <div className="mt-3 max-h-[460px] overflow-auto rounded-xl border border-[#D8E6E1] bg-white">
            {filteredDetailRecords.length ? (
              <table className="w-full min-w-[980px] table-auto text-sm">
                <thead className="sticky top-0 bg-[#F0FDF4] text-left text-xs uppercase tracking-wide text-[#064E3B]">
                  <tr>{detailColumns.map((column) => <th key={column} className="p-3">{column}</th>)}</tr>
                </thead>
                <tbody>
                  {pagedDetailRecords.map((record, index) => (
                    <tr key={`${selectedMunicipalityDrilldown.column}-${index}`} className="border-t border-[#D8E6E1]">
                      {detailColumns.map((column) => (
                        <td key={column} className="p-3 text-[#334155]">
                          {selectedMunicipalityDrilldown.column === "Operational" && (column === "Name" || column === "SLPA Name" || column === "Monitoring Unit Name") ? (
                            <button type="button" onClick={() => openFinancialOverview(record)} className="text-left font-semibold text-[#047857] hover:underline">
                              {String(record[column] || "Not encoded")}
                            </button>
                          ) : String(record[column] || "Not Found")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="p-6 text-center text-sm text-[#64748B]">No source records found for this selection.</p>
            )}
          </div>
          {filteredDetailRecords.length > pagedDetailRecords.length && (
            <div className="mt-3 text-center">
              <button type="button" onClick={() => setDetailRowLimit((value) => value + 100)} className="rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#F0FDF4]">
                Show more records ({pagedDetailRecords.length.toLocaleString()} of {filteredDetailRecords.length.toLocaleString()})
              </button>
            </div>
          )}
        </div>
      )}
      {financialOverviewRecord && (
        <FinancialOverviewPanel record={financialOverviewRecord} onClose={() => setFinancialOverviewRecord(null)} />
      )}
    </div>
  );
}

function ClickableCell({ value, onClick, className = "" }: { value: string | number; onClick: () => void; className?: string }) {
  return (
    <td className={`p-3 break-words whitespace-normal ${className}`}>
      <button type="button" onClick={onClick} className="w-full rounded-md px-1 py-1 text-left cursor-pointer hover:bg-[#ECFDF5] hover:underline">
        {value}
      </button>
    </td>
  );
}

function encodedValue(value: unknown, noMonitoring = false) {
  if (noMonitoring) return "No monitoring data found";
  const text = String(value ?? "").trim();
  return text || "Not encoded";
}

function FinancialOverviewPanel({ record, onClose }: { record: LivelihoodSustainabilityRecord; onClose: () => void }) {
  const noMonitoring = record.__noMonitoringMatch === true || record.__matchFound === false || record["Sustainability Status"] === "No Monitoring Data";
  const issues = record["Issues/Concerns"] || [
    record["Issues/Concerns 1"],
    record["Issues/Concerns 2"],
    record["Issues/Concerns 3"],
    record["Issues/Concerns 4"],
  ].filter(Boolean).join("; ");
  const fields: Array<[string, unknown, boolean?]> = [
    ["Name / SLPA Name", record.Name || record["SLPA Name"], false],
    ["Type", record.Type, false],
    ["Municipality / Barangay", [record.Municipality, record.Barangay].filter(Boolean).join(" / "), false],
    ["Project ID", record["Project ID"], false],
    ["Grant Code", record["Grant Code"], false],
    ["SLP Paricipant ID", record["SLP Paricipant ID"], false],
    ["Enterprise Type", record["Enterprise Type"], false],
    ["Latest Visit", record["Latest Visit"], noMonitoring],
    ["Date Monitored", record["Date Monitored"], noMonitoring],
    ["Gross Sales", record["Ave. Monthly Gross Sales"], noMonitoring],
    ["Gross Profit", record["Ave. Monthly Gross Profit"], noMonitoring],
    ["Net Income/Loss", record["Ave. Monthly Net Income/Loss"], noMonitoring],
    ["Cash at Bank", record["Cash at Bank"], noMonitoring],
    ["Cash on Hand", record["Cash on Hand"], noMonitoring],
    ["Total Savings", record["Total Savings"], noMonitoring],
    ["Total Score", record["Total Score"], noMonitoring],
    ["Livelihood Status", record["Livelihood Status"], noMonitoring],
    ["Enterprise Status", record["Enterprise Status"], noMonitoring],
    ["Sustainability Status", record["Sustainability Status"], false],
    ["Financial Rating Score", record["Financial Rating Score"], noMonitoring],
    ["Financial Rating Category", record["Financial Rating Category"], false],
    ["Rating Explanation", record["Rating Explanation"], false],
    ["Positive Indicators", record["Positive Indicators"], noMonitoring],
    ["Risk Indicators", record["Risk Indicators"], false],
    ["Remarks", record.Remarks, noMonitoring],
    ["Issues/Concerns", issues, noMonitoring],
    ["Source Module", record["Source Module"], false],
    ["Source File", record["Source File"], false],
  ];
  return (
    <div className="fixed inset-0 z-[1200]">
      <button type="button" aria-label="Close financial overview" className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <aside className="absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-[#D8E6E1] pb-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Financial Overview</p>
            <h3 className="mt-1 text-xl font-bold text-[#064E3B]">{encodedValue(record.Name || record["SLPA Name"])}</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-[#D8E6E1] p-2 text-[#064E3B] hover:bg-[#F0FDF4]">
            <X size={18} />
          </button>
        </div>
        {noMonitoring && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">No monitoring data found</div>
        )}
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          {fields.map(([label, value, fieldNoMonitoring]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3">
              <dt className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{label}</dt>
              <dd className="mt-1 break-words text-sm font-semibold text-[#0F172A]">{encodedValue(value, fieldNoMonitoring)}</dd>
            </div>
          ))}
        </dl>
      </aside>
    </div>
  );
}

function GurEncodingTableV2({
  title,
  firstColumn,
  denominatorColumn = "Total GUR Units",
  rows,
  onOpen,
  showAmounts = false,
}: {
  title: string;
  firstColumn: string;
  denominatorColumn?: string;
  rows: GurEncodingRow[];
  onOpen: (label: string) => void;
  showAmounts?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">{title}</p>
      <div className="mt-2 overflow-auto rounded-lg border border-[#D8E6E1] bg-white">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-[#F0FDF4] text-left text-xs uppercase tracking-wide text-[#064E3B]">
            <tr>
              <th className="p-3">{firstColumn}</th>
              <th className="p-3">Eligible Target</th>
              <th className="p-3">Encoded Count</th>
              <th className="p-3">Not Encoded Count</th>
              <th className="p-3">Not Yet Due Count</th>
              {showAmounts && <th className="p-3">Encoded Amount</th>}
              {showAmounts && <th className="p-3">Not Encoded Amount</th>}
              {showAmounts && <th className="p-3">{denominatorColumn}</th>}
              <th className="p-3">Completion %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className={`${row.isOverall ? "border-t-2 border-[#10B981] bg-[#ECFDF5] font-bold" : "border-t border-[#D8E6E1]"}`}>
                <td className="p-3 font-semibold text-[#0F172A]">{row.name}</td>
                <td className="p-3 text-[#334155]">{row.eligibleTarget.toLocaleString()}</td>
                <td className="p-3">
                  <button type="button" onClick={() => onOpen(row.encodedLabel)} className="rounded-md px-1 py-1 font-semibold text-[#047857] hover:bg-[#DCFCE7] hover:underline">
                    {row.encoded.toLocaleString()}
                  </button>
                </td>
                <td className="p-3">
                  <button type="button" onClick={() => onOpen(row.notEncodedLabel)} className="rounded-md px-1 py-1 font-semibold text-[#B45309] hover:bg-amber-50 hover:underline">
                    {row.notEncoded.toLocaleString()}
                  </button>
                </td>
                <td className="p-3">
                  <button type="button" onClick={() => onOpen(row.notYetDueLabel)} className="rounded-md px-1 py-1 font-semibold text-[#64748B] hover:bg-slate-100 hover:underline">
                    {row.notYetDue.toLocaleString()}
                  </button>
                </td>
                {showAmounts && (
                  <td className="p-3">
                    {row.isOverall ? (
                      <span className="text-[#64748B]">--</span>
                    ) : (
                      <button type="button" onClick={() => onOpen(row.encodedAmountLabel || row.encodedLabel)} className="rounded-md px-1 py-1 font-semibold text-[#047857] hover:bg-[#DCFCE7] hover:underline">
                        {row.encodedAmountDisplay}
                      </button>
                    )}
                  </td>
                )}
                {showAmounts && (
                  <td className="p-3">
                    {row.isOverall ? (
                      <span className="text-[#64748B]">--</span>
                    ) : (
                      <button type="button" onClick={() => onOpen(row.notEncodedAmountLabel || row.notEncodedLabel)} className="rounded-md px-1 py-1 font-semibold text-[#B45309] hover:bg-amber-50 hover:underline">
                        {row.notEncodedAmountDisplay}
                      </button>
                    )}
                  </td>
                )}
                {showAmounts && <td className="p-3 text-[#334155]">{row.denominator.toLocaleString()}</td>}
                <td className="p-3 text-[#334155]">{row.completionDisplay}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SimpleAssessmentEncodingTable({ title, rows, onOpen }: { title: string; rows: GurEncodingRow[]; onOpen: (label: string) => void }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">{title}</p>
      <div className="mt-2 overflow-auto rounded-lg border border-[#D8E6E1] bg-white">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="bg-[#F0FDF4] text-left text-xs uppercase tracking-wide text-[#064E3B]">
            <tr>
              <th className="p-3">Assessment</th>
              <th className="p-3">Encoded Count</th>
              <th className="p-3">Not Encoded Count</th>
              <th className="p-3">Completion %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="border-t border-[#D8E6E1]">
                <td className="p-3 font-semibold text-[#0F172A]">{row.name}</td>
                <td className="p-3">
                  <button type="button" onClick={() => onOpen(row.encodedLabel)} className="rounded-md px-1 py-1 font-semibold text-[#047857] hover:bg-[#DCFCE7] hover:underline">
                    {row.encoded.toLocaleString()}
                  </button>
                </td>
                <td className="p-3">
                  <button type="button" onClick={() => onOpen(row.notEncodedLabel)} className="rounded-md px-1 py-1 font-semibold text-[#B45309] hover:bg-amber-50 hover:underline">
                    {row.notEncoded.toLocaleString()}
                  </button>
                </td>
                <td className="p-3 text-[#334155]">{row.completionDisplay}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GurEncodingTable({
  title,
  firstColumn,
  denominatorColumn = "Total GUR Units",
  rows,
  onOpen,
  showAmounts = false,
}: {
  title: string;
  firstColumn: string;
  denominatorColumn?: string;
  rows: GurEncodingRow[];
  onOpen: (label: string) => void;
  showAmounts?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">{title}</p>
      <div className="mt-2 overflow-auto rounded-lg border border-[#D8E6E1] bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-[#F0FDF4] text-left text-xs uppercase tracking-wide text-[#064E3B]">
            <tr>
              <th className="p-3">{firstColumn}</th>
              <th className="p-3">Eligible Target</th>
              <th className="p-3">Encoded Count</th>
              <th className="p-3">Not Encoded Count</th>
              <th className="p-3">Not Yet Due Count</th>
              {showAmounts && <th className="p-3">Encoded Amount</th>}
              {showAmounts && <th className="p-3">Not Encoded Amount</th>}
              {showAmounts && <th className="p-3">{denominatorColumn}</th>}
              {showAmounts && <th className="p-3">Total GUR Amount</th>}
              <th className="p-3">Completion %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className={`${row.isOverall ? "border-t-2 border-[#10B981] bg-[#ECFDF5] font-bold" : "border-t border-[#D8E6E1]"}`}>
                <td className="p-3 font-semibold text-[#0F172A]">{row.name}</td>
                <td className="p-3">
                  <button type="button" onClick={() => onOpen(row.encodedLabel)} className="rounded-md px-1 py-1 font-semibold text-[#047857] hover:bg-[#DCFCE7] hover:underline">
                    {row.encoded.toLocaleString()}
                  </button>
                </td>
                {showAmounts && (
                  <td className="p-3">
                    {row.isOverall ? (
                      <span className="text-[#64748B]">—</span>
                    ) : (
                      <button type="button" onClick={() => onOpen(row.encodedAmountLabel || row.encodedLabel)} className="rounded-md px-1 py-1 font-semibold text-[#047857] hover:bg-[#DCFCE7] hover:underline">
                        {row.encodedAmountDisplay}
                      </button>
                    )}
                  </td>
                )}
                <td className="p-3">
                  <button type="button" onClick={() => onOpen(row.notEncodedLabel)} className="rounded-md px-1 py-1 font-semibold text-[#B45309] hover:bg-amber-50 hover:underline">
                    {row.notEncoded.toLocaleString()}
                  </button>
                </td>
                {showAmounts && (
                  <td className="p-3">
                    {row.isOverall ? (
                      <span className="text-[#64748B]">—</span>
                    ) : (
                      <button type="button" onClick={() => onOpen(row.notEncodedAmountLabel || row.notEncodedLabel)} className="rounded-md px-1 py-1 font-semibold text-[#B45309] hover:bg-amber-50 hover:underline">
                        {row.notEncodedAmountDisplay}
                      </button>
                    )}
                  </td>
                )}
                <td className="p-3 text-[#334155]">{row.denominator.toLocaleString()}</td>
                {showAmounts && <td className="p-3 text-[#64748B]">{row.isOverall ? "—" : row.totalAmountDisplay}</td>}
                <td className="p-3 text-[#334155]">{row.completion.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MunicipalityMonitoringBreakdownTable({ rows }: { rows: MunicipalityMonitoringBreakdownRow[] }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Monitoring & Assessment Summary by Municipality</p>
      <div className="mt-2 overflow-auto rounded-lg border border-[#D8E6E1] bg-white">
        <table className="w-full min-w-[1320px] text-sm">
          <thead className="bg-[#F0FDF4] text-left text-xs uppercase tracking-wide text-[#064E3B]">
            <tr>
              <th className="sticky left-0 z-10 bg-[#F0FDF4] p-3">Municipality</th>
              <th className="p-3">1st Encoded</th>
              <th className="p-3">1st Not Encoded</th>
              <th className="p-3">1st %</th>
              <th className="p-3">2nd Encoded</th>
              <th className="p-3">2nd Not Encoded</th>
              <th className="p-3">2nd %</th>
              <th className="p-3">3rd Encoded</th>
              <th className="p-3">3rd Not Encoded</th>
              <th className="p-3">3rd %</th>
              <th className="p-3">4th Encoded</th>
              <th className="p-3">4th Not Encoded</th>
              <th className="p-3">4th %</th>
              <th className="p-3">Overall %</th>
              <th className="p-3">MdAnnualAssessment Encoded</th>
              <th className="p-3">MdAnnualAssessment Not Encoded</th>
              <th className="p-3">MdAnnualAssessment Completion %</th>
              <th className="p-3">OrgAssessment Encoded</th>
              <th className="p-3">OrgAssessment Not Encoded</th>
              <th className="p-3">OrgAssessment Completion %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.municipality} className={`${row.isTotal ? "border-t-2 border-[#10B981] bg-[#ECFDF5] font-bold" : "border-t border-[#D8E6E1]"}`}>
                <td className={`sticky left-0 p-3 font-semibold text-[#0F172A] ${row.isTotal ? "bg-[#ECFDF5]" : "bg-white"}`}>{row.municipality}</td>
                <td className="p-3 text-[#047857]">{row.firstVisitEncoded.toLocaleString()}</td>
                <td className="p-3 text-[#B45309]">{row.firstVisitNotEncoded.toLocaleString()}</td>
                <td className="p-3 text-[#334155]">{completionDisplay(row.firstVisitEncoded, row.firstVisitEligible)}</td>
                <td className="p-3 text-[#047857]">{row.secondVisitEncoded.toLocaleString()}</td>
                <td className="p-3 text-[#B45309]">{row.secondVisitNotEncoded.toLocaleString()}</td>
                <td className="p-3 text-[#334155]">{completionDisplay(row.secondVisitEncoded, row.secondVisitEligible)}</td>
                <td className="p-3 text-[#047857]">{row.thirdVisitEncoded.toLocaleString()}</td>
                <td className="p-3 text-[#B45309]">{row.thirdVisitNotEncoded.toLocaleString()}</td>
                <td className="p-3 text-[#334155]">{completionDisplay(row.thirdVisitEncoded, row.thirdVisitEligible)}</td>
                <td className="p-3 text-[#047857]">{row.fourthVisitEncoded.toLocaleString()}</td>
                <td className="p-3 text-[#B45309]">{row.fourthVisitNotEncoded.toLocaleString()}</td>
                <td className="p-3 text-[#334155]">{completionDisplay(row.fourthVisitEncoded, row.fourthVisitEligible)}</td>
                <td className="p-3 text-[#334155]">{row.overallMonitoringCompletion.toFixed(1)}%</td>
                <td className="p-3 text-[#047857]">{row.mdAnnualAssessmentEncoded.toLocaleString()}</td>
                <td className="p-3 text-[#B45309]">{row.mdAnnualAssessmentNotEncoded.toLocaleString()}</td>
                <td className="p-3 text-[#334155]">{row.mdAnnualAssessmentCompletion.toFixed(1)}%</td>
                <td className="p-3 text-[#047857]">{row.orgAssessmentEncoded.toLocaleString()}</td>
                <td className="p-3 text-[#B45309]">{row.orgAssessmentNotEncoded.toLocaleString()}</td>
                <td className="p-3 text-[#334155]">{row.orgAssessmentCompletion.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-[#64748B]">Summary percentages are based on eligible targets only. Not-yet-due records are excluded from Not Encoded counts.</p>
    </div>
  );
}

function sameText(left: unknown, right: unknown) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function completionDisplay(encoded: number, eligibleTarget: number) {
  return eligibleTarget ? `${((encoded / eligibleTarget) * 100).toFixed(1)}%` : "Not yet due";
}

function uniqueBy(records: MunicipalityDrilldownRecord[], keyFn: (record: MunicipalityDrilldownRecord) => string) {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = keyFn(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type ParsedDashboardRow = Record<string, any> & {
  __sourceFile?: string;
  __sourceModule?: string;
  __headers?: string[];
};

function normalizeLookup(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGrantCode(value: unknown) {
  return String(value ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function normalizeKey(value: unknown) {
  return normalizeLookup(value);
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function parseMoney(value: unknown) {
  const cleaned = String(value ?? "").replace(/[^\d.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDashboardDate(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return startOfDay(value);
  if (typeof value === "number" && Number.isFinite(value)) return excelSerialDate(value);
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const serialDate = excelSerialDate(Number(raw));
    if (serialDate) return serialDate;
  }
  const parsed = new Date(raw);
  if (Number.isFinite(parsed.getTime())) return startOfDay(parsed);
  const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  const date = new Date(year, month - 1, day);
  return Number.isFinite(date.getTime()) ? startOfDay(date) : null;
}

function excelSerialDate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(Date.UTC(1899, 11, 30 + Math.floor(value)));
  return Number.isFinite(date.getTime()) ? startOfDay(date) : null;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  const day = next.getDate();
  next.setMonth(next.getMonth() + months);
  if (next.getDate() < day) next.setDate(0);
  return startOfDay(next);
}

function peso(value: number) {
  return `₱${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function titleOrFallback(value: unknown, fallback = "Not Found") {
  const text = cleanText(value);
  return text || fallback;
}

function isMissingValue(value: unknown) {
  const text = normalizeLookup(value);
  return !text || text === "not found";
}

function getRowsByModule(parsedFiles: DashboardParsedFile[], moduleAliases: string[]): ParsedDashboardRow[] {
  const aliases = moduleAliases.map(normalizeLookup).filter(Boolean);
  return (parsedFiles || [])
    .filter((file) => {
      const haystack = normalizeLookup([
        file.moduleType,
        file.classification,
        file.fileName,
        file.originalName,
        file.folder,
        file.category,
        file.sourceModule,
        file.sourceFile,
      ].filter(Boolean).join(" "));
      return aliases.some((alias) => haystack.includes(alias));
    })
    .flatMap((file) => (file.rows || []).map((row) => ({
      ...row,
      __sourceFile: file.sourceFile || [file.folder || file.category, file.fileName || file.originalName].filter(Boolean).join(" / "),
      __sourceModule: file.sourceModule || file.moduleType || file.classification || "",
      __headers: file.headers || Object.keys(row || {}),
    })));
}

function rowHeaders(row: ParsedDashboardRow) {
  return Array.isArray(row.__headers) && row.__headers.length ? row.__headers : Object.keys(row || {});
}

function readCell(row: ParsedDashboardRow, aliases: string[]) {
  const headers = rowHeaders(row);
  const aliasNorms = aliases.map(normalizeLookup).filter(Boolean);
  const aliasCompacts = aliasNorms.map((alias) => alias.replace(/\s+/g, ""));
  const exact = headers.find((header) => {
    const headerNorm = normalizeLookup(header);
    return aliasNorms.includes(headerNorm) || aliasCompacts.includes(headerNorm.replace(/\s+/g, ""));
  });
  if (exact && cleanText(row[exact])) return cleanText(row[exact]);
  const partial = headers.find((header) => {
    const headerNorm = normalizeLookup(header);
    const headerCompact = headerNorm.replace(/\s+/g, "");
    return aliasNorms.some((alias, index) => headerNorm.includes(alias) || alias.includes(headerNorm) || headerCompact.includes(aliasCompacts[index]) || aliasCompacts[index].includes(headerCompact));
  });
  return partial ? cleanText(row[partial]) : "";
}

function findColumn(row: ParsedDashboardRow, aliases: string[]) {
  const headers = rowHeaders(row);
  const aliasNorms = aliases.map(normalizeLookup).filter(Boolean);
  const aliasCompacts = aliasNorms.map((alias) => alias.replace(/\s+/g, ""));
  return headers.find((header) => {
    const headerNorm = normalizeLookup(header);
    const headerCompact = headerNorm.replace(/\s+/g, "");
    return aliasNorms.includes(headerNorm) || aliasCompacts.includes(headerCompact);
  }) || "";
}

function participantNameFromRow(row: ParsedDashboardRow) {
  const direct = readCell(row, ["Participant Name", "Full Name", "Name"]);
  if (direct) return direct;
  const last = readCell(row, ["Last Name", "Surname"]);
  const first = readCell(row, ["First Name", "Given Name"]);
  const middle = readCell(row, ["Middle Name", "Middle Initial"]);
  return [first, middle, last].filter(Boolean).join(" ").trim();
}

function rowSource(row: ParsedDashboardRow) {
  return cleanText(row.__sourceFile || row["Source File"] || row["File Name"] || row.__sourceModule || "Dashboard parsed source");
}

function rowSourceModule(row: ParsedDashboardRow) {
  return cleanText(row.__sourceModule || row["Source Module"] || row["Module"] || "Dashboard parsed source");
}

function detectUnitType(row: ParsedDashboardRow) {
  const projectEnterprise = normalizeLookup(readProjectEnterprise(row));
  if (projectEnterprise) {
    if (projectEnterprise.includes("individual")) return "Individual";
    if (projectEnterprise.includes("association") || projectEnterprise.includes("slpa") || projectEnterprise.includes("group") || projectEnterprise.includes("organization")) return "Association";
  }
  const enterpriseType = normalizeLookup(readCell(row, ["Enterprise Type", "Project Type", "Enterprise / Project Type"]));
  const classification = normalizeLookup(readCell(row, ["Classification", "Type", "Unit Type"]));
  const slpaName = readCell(row, ["SLPA Name", "Association Name", "Organization Name"]);
  const participantId = readCell(row, ["SLP Paricipant ID", "SLP Participant ID", "Participant ID"]);
  if (enterpriseType.includes("association") || classification.includes("association") || slpaName) return "Association";
  if (enterpriseType.includes("individual") || classification.includes("individual") || participantId) return "Individual";
  return "Association";
}

function readGrantCode(row: ParsedDashboardRow) {
  return readCell(row, ["Grant Code", "GUR Code", "Grant Utilization Code", "Grant Utilization Report Code"]);
}

function readProjectEnterprise(row: ParsedDashboardRow) {
  return readCell(row, ["Project Enterprise", "Project/Enterprise", "Project Enterprise Type", "Enterprise Type", "Project Type"]);
}

function readAmount1(row: ParsedDashboardRow) {
  return parseMoney(readCell(row, ["Amount 1", "Amount1"]));
}

function readGurAmount(row: ParsedDashboardRow) {
  const header = findColumn(row, ["Dswd Total Cost", "DSWD Total Cost"]);
  return header ? parseMoney(row[header]) : null;
}

function readBestDate(row: ParsedDashboardRow, preferredAliases: string[], fallbackAliases: string[] = []) {
  const preferred = findColumn(row, preferredAliases);
  const preferredDate = preferred ? parseDashboardDate(row[preferred]) : null;
  if (preferredDate) return preferredDate;
  const fallback = findColumn(row, fallbackAliases);
  return fallback ? parseDashboardDate(row[fallback]) : null;
}

function readGurDate(row: ParsedDashboardRow) {
  return readBestDate(
    row,
    ["Date of Grant Utilization", "Date GUR Conducted", "Date Conducted", "Date", "Created Date"],
    ["Updated Date"],
  );
}

function readMonitoringDate(row: ParsedDashboardRow) {
  return readBestDate(row, ["Date Monitored", "Monitoring Date", "Date of Monitoring", "Date Conducted", "Date"]);
}

function projectKeys(projectId?: string, projectName?: string, slpaName?: string) {
  const keys = [];
  if (normalizeKey(projectId)) keys.push(`project-id:${normalizeKey(projectId)}`);
  if (normalizeKey(projectName)) keys.push(`project-name:${normalizeKey(projectName)}`);
  if (normalizeKey(slpaName)) keys.push(`slpa-name:${normalizeKey(slpaName)}`);
  return keys;
}

function participantKeys(participantId?: string, participantName?: string) {
  const keys = [];
  if (normalizeKey(participantId)) keys.push(`participant-id:${normalizeKey(participantId)}`);
  if (normalizeKey(participantName)) keys.push(`participant-name:${normalizeKey(participantName)}`);
  return keys;
}

function rowMatchKeys(row: ParsedDashboardRow, unitType: "Individual" | "Association" | "Any" = "Any") {
  const grantCode = normalizeGrantCode(readGrantCode(row));
  const keys = [];
  if (grantCode) keys.push(`grant:${grantCode}`);
  const participantId = readCell(row, ["SLP Paricipant ID", "SLP Participant ID", "Participant ID"]);
  if (unitType !== "Association" && normalizeKey(participantId)) keys.push(`participant-id:${normalizeKey(participantId)}`);
  return keys;
}

function warnMissingColumns(rows: ParsedDashboardRow[], sourceName: string, required: Record<string, string[]>) {
  if (!rows.length) return;
  const missing = Object.entries(required)
    .filter(([, aliases]) => !rows.some((row) => Boolean(findColumn(row, aliases))))
    .map(([label]) => label);
  if (missing.length) {
    console.warn("[GUR_DRILLDOWN_MISSING_COLUMNS]", {
      sourceModule: sourceName,
      missingColumns: missing,
      availableColumnsSample: rowHeaders(rows[0]),
    });
  }
}

function addToLookup(map: Map<string, MunicipalityDrilldownRecord[]>, key: string, unit: MunicipalityDrilldownRecord) {
  if (!key) return;
  const existing = map.get(key) || [];
  existing.push(unit);
  map.set(key, existing);
}

function mergeSource(record: MunicipalityDrilldownRecord, source: string) {
  const current = String(record["Source File"] || "");
  if (!source || current.split("; ").includes(source)) return;
  record["Source File"] = current ? `${current}; ${source}` : source;
  record.sourceFiles = record["Source File"];
}

function setVisit(record: MunicipalityDrilldownRecord, visitValue: string, row: ParsedDashboardRow, sourceModule: string) {
  const visit = normalizeLookup(visitValue);
  const amount1 = readAmount1(row);
  const monitoringDate = readMonitoringDate(row);
  if (amount1 === null) {
    console.warn("[GUR_DRILLDOWN_MISSING_AMOUNT_SOURCE]", {
      sourceModule,
      amountSource: "Amount 1",
      grantCode: record["Grant Code"] || readGrantCode(row),
      sourceFile: rowSource(row),
    });
  }
  const visits: Array<1 | 2 | 3 | 4> = [];
  const hasVisit = (n: number, ordinal: string, word: string) => visit === String(n) || visit.includes(String(n)) || visit.includes(ordinal) || visit.includes(word);
  if (hasVisit(1, "1st", "first")) {
    record.__has1stVisit = true;
    record["1st Visit"] = "With 1st Visit";
    record["Encoded in 1st Visit"] = "Yes";
    visits.push(1);
  }
  if (hasVisit(2, "2nd", "second")) {
    record.__has2ndVisit = true;
    record["2nd Visit"] = "With 2nd Visit";
    record["Encoded in 2nd Visit"] = "Yes";
    visits.push(2);
  }
  if (hasVisit(3, "3rd", "third")) {
    record.__has3rdVisit = true;
    record["3rd Visit"] = "With 3rd Visit";
    record["Encoded in 3rd Visit"] = "Yes";
    visits.push(3);
  }
  if (hasVisit(4, "4th", "fourth")) {
    record.__has4thVisit = true;
    record["4th Visit"] = "With 4th Visit";
    record["Encoded in 4th Visit"] = "Yes";
    visits.push(4);
  }
  for (const visitNumber of visits) {
    const detail = {
      "Participant/Association Name": titleOrFallback(participantNameFromRow(row) || readCell(row, ["SLPA Name", "Association Name", "Organization Name", "Project Name", "Name of Project"]) || record["Participant/Association Name"] || record["Participant Name / SLPA Name / Project Name"]),
      Municipality: titleOrFallback(readCell(row, ["Municipality", "City/Municipality", "City"]) || record.Municipality),
      Barangay: titleOrFallback(readCell(row, ["Barangay", "Brgy"]) || record.Barangay),
      "Grant Code": titleOrFallback(record["Grant Code"], ""),
      Visit: `${visitNumber}${visitNumber === 1 ? "st" : visitNumber === 2 ? "nd" : visitNumber === 3 ? "rd" : "th"} Visit`,
      "Amount 1": amount1 !== null ? peso(amount1) : "N/A",
      "Amount Source": "Amount 1 from monitoring module",
      SourceModule: sourceModule,
      "Source Module": sourceModule,
      SourceFile: rowSource(row),
      "Source File": rowSource(row),
      "Date Monitored": monitoringDate ? monitoringDate.toISOString().slice(0, 10) : "",
      __amount1: amount1 ?? 0,
      __monitoringDate: monitoringDate,
    };
    const details = Array.isArray(record.__visitDetails) ? record.__visitDetails as any[] : [];
    const duplicate = details.some((item) => item.Visit === detail.Visit && item["Source Module"] === detail["Source Module"] && item["Source File"] === detail["Source File"] && item["Amount 1"] === detail["Amount 1"]);
    if (!duplicate) details.push(detail);
    record.__visitDetails = details as any;
    const amountMap = record.__visitAmounts && typeof record.__visitAmounts === "object" ? record.__visitAmounts as Record<string, number> : {};
    if (!duplicate) amountMap[visitNumber] = (amountMap[visitNumber] || 0) + (amount1 || 0);
    record.__visitAmounts = amountMap as any;
    const dateMap = record.__visitDates && typeof record.__visitDates === "object" ? record.__visitDates as Record<string, Date> : {};
    if (monitoringDate && (!dateMap[visitNumber] || monitoringDate < dateMap[visitNumber])) dateMap[visitNumber] = monitoringDate;
    record.__visitDates = dateMap as any;
  }
}

function visitTextFromRow(row: ParsedDashboardRow) {
  const explicit = readCell(row, ["Visit", "Monitoring Visit", "Visit Count", "Visit Number", "Assessment Visit"]);
  const visitColumns = rowHeaders(row)
    .filter((header) => normalizeLookup(header).includes("visit"))
    .map((header) => `${header} ${cleanText(row[header])}`)
    .filter(Boolean);
  return [explicit, ...visitColumns].filter(Boolean).join(" ");
}

function fillMissingUnitFields(unit: MunicipalityDrilldownRecord, row: ParsedDashboardRow) {
  if (isMissingValue(unit.Municipality)) unit.Municipality = titleOrFallback(readCell(row, ["Municipality", "City/Municipality", "City"]));
  if (isMissingValue(unit.Barangay)) unit.Barangay = titleOrFallback(readCell(row, ["Barangay", "Brgy"]));
  if (isMissingValue(unit["Enterprise Type"])) unit["Enterprise Type"] = titleOrFallback(readCell(row, ["Enterprise Type", "Project Type", "Enterprise / Project Type"]));
  if (isMissingValue(unit["Project Enterprise"])) unit["Project Enterprise"] = titleOrFallback(readProjectEnterprise(row));
  if (isMissingValue(unit["Project ID"])) unit["Project ID"] = titleOrFallback(readCell(row, ["Project ID", "SLP Project ID", "Unique Project ID"]), "");
  mergeSource(unit, rowSource(row));
}

function buildGurDrilldownFromParsedFiles(parsedFiles: DashboardParsedFile[]) {
  const gurRows = getRowsByModule(parsedFiles, ["grant utilization", "gur"]);
  const monitoringIndividualRows = getRowsByModule(parsedFiles, ["mdmonitoring individual", "monitoring individual"]);
  const monitoringAssociationRows = getRowsByModule(parsedFiles, ["mdmonitoring association", "monitoring association"]);
  const orgAssessmentRows = getRowsByModule(parsedFiles, ["orgassessment", "organizational assessment", "org assessment"]);
  const annualAssessmentRows = getRowsByModule(parsedFiles, ["mdannualassessment", "annual assessment"]);
  const projectRows = getRowsByModule(parsedFiles, ["project module", "slpis project"]);

  warnMissingColumns(gurRows, "Grant Utilization module", {
    "Grant Code": ["Grant Code", "GUR Code", "Grant Utilization Code", "Grant Utilization Report Code"],
    "Dswd Total Cost": ["Dswd Total Cost", "DSWD Total Cost"],
    Municipality: ["Municipality", "City/Municipality", "City"],
    Barangay: ["Barangay", "Brgy"],
    "Project Enterprise": ["Project Enterprise", "Project/Enterprise", "Project Enterprise Type", "Enterprise Type", "Project Type"],
  });
  warnMissingColumns([...monitoringIndividualRows, ...monitoringAssociationRows], "MdMonitoring individual/association module", {
    "Grant Code": ["Grant Code", "GUR Code", "Grant Utilization Code", "Grant Utilization Report Code"],
    "Amount 1": ["Amount 1", "Amount1"],
    Municipality: ["Municipality", "City/Municipality", "City"],
    Barangay: ["Barangay", "Brgy"],
    "Project Enterprise": ["Project Enterprise", "Project/Enterprise", "Project Enterprise Type", "Enterprise Type", "Project Type"],
  });

  const unitsByKey = new Map<string, MunicipalityDrilldownRecord>();
  const unitLookup = new Map<string, MunicipalityDrilldownRecord[]>();
  let duplicateGrantCodesMerged = 0;
  let missingGrantCodeRows = 0;

  for (const row of gurRows) {
    const unitType = detectUnitType(row);
    const grantCode = normalizeGrantCode(readGrantCode(row));
    const projectEnterprise = readProjectEnterprise(row);
    const projectId = readCell(row, ["Project ID", "SLP Project ID", "Unique Project ID"]);
    const projectName = readCell(row, ["Project Name", "Name of Project", "Project Title"]);
    const slpaName = readCell(row, ["SLPA Name", "Association Name", "Organization Name"]);
    const participantId = readCell(row, ["SLP Paricipant ID", "SLP Participant ID", "Participant ID"]);
    const participantName = participantNameFromRow(row);
    const municipality = readCell(row, ["Municipality", "City/Municipality", "City"]);
    const barangay = readCell(row, ["Barangay", "Brgy"]);
    const enterpriseType = readCell(row, ["Enterprise Type", "Project Type", "Enterprise / Project Type"]);
    const gurAmount = readGurAmount(row);
    const gurDate = readGurDate(row);
    if (gurAmount === null) {
      console.warn("[GUR_DRILLDOWN_MISSING_AMOUNT_SOURCE]", {
        sourceModule: "Grant Utilization module",
        amountSource: "DSWD Total Cost",
        grantCode,
        sourceFile: rowSource(row),
      });
    }
    if (!grantCode) missingGrantCodeRows += 1;
    const primaryKey = grantCode ? `grant:${grantCode}` : unitType === "Individual" && normalizeKey(participantId) ? `participant-id:${normalizeKey(participantId)}` : "";
    if (!primaryKey) continue;

    const existing = unitsByKey.get(primaryKey);
    if (existing && grantCode) duplicateGrantCodesMerged += 1;
    const unit = existing || {
      Category: "gurMonitoringAssessment",
      key: primaryKey,
      "Grant Code": grantCode,
      grantCode,
      "Project Enterprise": titleOrFallback(projectEnterprise),
      projectEnterprise: titleOrFallback(projectEnterprise),
      __gurAmount: gurAmount ?? undefined,
      __hasGurAmount: gurAmount !== null,
      __gurDate: gurDate || undefined,
      "GUR Date": gurDate ? gurDate.toISOString().slice(0, 10) : "",
      "DSWD Total Cost": peso(gurAmount || 0),
      "Unit Type": unitType,
      unitType,
      "Participant/Association Name": titleOrFallback(unitType === "Individual" ? participantName : slpaName || projectName),
      "Participant Name / SLPA Name / Project Name": titleOrFallback(unitType === "Individual" ? participantName : slpaName || projectName),
      "SLP Paricipant ID": titleOrFallback(participantId, ""),
      "Project ID": titleOrFallback(projectId, ""),
      "Enterprise Type": titleOrFallback(enterpriseType),
      Municipality: titleOrFallback(municipality),
      __normalizedMunicipality: normalizeLookup(municipality),
      Barangay: titleOrFallback(barangay),
      "GUR Status": "Encoded in GUR",
      "Present in Monitoring Individual": "No",
      "Present in Monitoring Association": "No",
      "Present in Any Monitoring": "No",
      "1st Visit": "No 1st Visit",
      "2nd Visit": "No 2nd Visit",
      "3rd Visit": "No 3rd Visit",
      "4th Visit": "No 4th Visit",
      "Encoded in 1st Visit": "No",
      "Encoded in 2nd Visit": "No",
      "Encoded in 3rd Visit": "No",
      "Encoded in 4th Visit": "No",
      "Organizational Assessment": unitType === "Association" ? "Without Organizational Assessment" : "N/A",
      "Annual Assessment": "Without Annual Assessment",
      "Encoded in MdAnnualAssessment": "No",
      "Encoded in OrgAssessment": unitType === "Association" ? "No" : "N/A",
      SourceFile: rowSource(row),
      "Source File": rowSource(row),
      sourceFiles: rowSource(row),
      encodedInGur: true,
      presentInMonitoringIndividual: false,
      presentInMonitoringAssociation: false,
      presentInAnyMonitoring: false,
      presentInAnnualAssessment: false,
      presentInOrgAssessment: false,
      orgAssessmentStatus: unitType === "Association" ? "Not Encoded" : "N/A",
      annualAssessmentStatus: "Not Encoded",
      sourceRows: 0,
      __has1stVisit: false,
      __has2ndVisit: false,
      __has3rdVisit: false,
      __has4thVisit: false,
      __visitDetails: [],
      __visitAmounts: {},
      __visitDates: {},
      __visitSourceModules: {},
      __visitSourceFiles: {},
      __hasOrgAssessment: false,
      __hasAnnualAssessment: false,
    };
    if (!existing && gurAmount !== null) {
      unit.__gurAmount = gurAmount;
      unit.__hasGurAmount = true;
      unit["DSWD Total Cost"] = peso(gurAmount);
    }
    if (!unit.__gurDate && gurDate) {
      unit.__gurDate = gurDate;
      unit["GUR Date"] = gurDate.toISOString().slice(0, 10);
    }
    unit.sourceRows = Number(unit.sourceRows || 0) + 1;
    if (unitType === "Association" && unit["Unit Type"] !== "Association") {
      unit["Unit Type"] = "Association";
      unit.unitType = "Association";
      unit["Encoded in OrgAssessment"] = unit.presentInOrgAssessment ? "Yes" : "No";
      unit.orgAssessmentStatus = unit.presentInOrgAssessment ? "Encoded" : "Not Encoded";
    }
    fillMissingUnitFields(unit, row);
    unitsByKey.set(primaryKey, unit);
    addToLookup(unitLookup, primaryKey, unit);
    if (unitType === "Individual" && normalizeKey(participantId)) addToLookup(unitLookup, `participant-id:${normalizeKey(participantId)}`, unit);
  }

  const applyToUnits = (matches: MunicipalityDrilldownRecord[], row: ParsedDashboardRow, apply: (unit: MunicipalityDrilldownRecord) => void) => {
    for (const unit of matches) {
      fillMissingUnitFields(unit, row);
      if (!unit.__normalizedMunicipality || unit.__normalizedMunicipality === "not found") unit.__normalizedMunicipality = normalizeLookup(unit.Municipality);
      apply(unit);
      mergeSource(unit, rowSource(row));
    }
  };

  for (const row of projectRows) {
    const matches = uniqueBy(rowMatchKeys(row).flatMap((key) => unitLookup.get(key) || []), (record) => String(record.key || record["Grant Code"] || record["Project ID"] || record["Participant Name / SLPA Name / Project Name"]));
    applyToUnits(matches, row, () => undefined);
  }

  for (const row of monitoringAssociationRows) {
    const matches = uniqueBy(rowMatchKeys(row, "Association").flatMap((key) => unitLookup.get(key) || []), (record) => String(record.key || record["Grant Code"] || record["Project ID"] || record["Participant Name / SLPA Name / Project Name"]));
    applyToUnits(matches, row, (unit) => {
      unit.presentInMonitoringAssociation = true;
      unit.presentInAnyMonitoring = true;
      unit["Present in Monitoring Association"] = "Yes";
      unit["Present in Any Monitoring"] = "Yes";
      setVisit(unit, visitTextFromRow(row), row, "MdMonitoring association module");
    });
  }

  for (const row of monitoringIndividualRows) {
    const matches = uniqueBy(rowMatchKeys(row, "Individual").flatMap((key) => unitLookup.get(key) || []), (record) => String(record.key || record["Grant Code"] || record["SLP Paricipant ID"] || record["Participant Name / SLPA Name / Project Name"]));
    applyToUnits(matches, row, (unit) => {
      unit.presentInMonitoringIndividual = true;
      unit.presentInAnyMonitoring = true;
      unit["Present in Monitoring Individual"] = "Yes";
      unit["Present in Any Monitoring"] = "Yes";
      setVisit(unit, visitTextFromRow(row), row, "MdMonitoring individual module");
    });
  }

  for (const row of orgAssessmentRows) {
    const matches = uniqueBy(rowMatchKeys(row, "Association").flatMap((key) => unitLookup.get(key) || []), (record) => String(record.key || record["Grant Code"] || record["Project ID"] || record["Participant Name / SLPA Name / Project Name"]));
    applyToUnits(matches, row, (unit) => {
      if (unit["Unit Type"] !== "Association") return;
      unit.presentInOrgAssessment = true;
      unit.orgAssessmentStatus = "Encoded";
      unit.__hasOrgAssessment = true;
      unit["Organizational Assessment"] = "With Organizational Assessment";
      unit["Encoded in OrgAssessment"] = "Yes";
    });
  }

  for (const row of annualAssessmentRows) {
    const matches = uniqueBy(rowMatchKeys(row).flatMap((key) => unitLookup.get(key) || []), (record) => String(record.key || record["Grant Code"] || record["Project ID"] || record["SLP Paricipant ID"] || record["Participant Name / SLPA Name / Project Name"]));
    applyToUnits(matches, row, (unit) => {
      unit.presentInAnnualAssessment = true;
      unit.annualAssessmentStatus = "Encoded";
      unit.__hasAnnualAssessment = true;
      unit["Annual Assessment"] = "With Annual Assessment";
      unit["Encoded in MdAnnualAssessment"] = "Yes";
    });
  }

  const units = Array.from(unitsByKey.values()).map((unit) => ({
    ...unit,
    Municipality: titleOrFallback(unit.Municipality),
    __normalizedMunicipality: normalizeLookup(unit.Municipality),
  }));

  return { units, gurRows, monitoringIndividualRows, monitoringAssociationRows, orgAssessmentRows, annualAssessmentRows, duplicateGrantCodesMerged, missingGrantCodeRows };
}

function gurRecordsForMunicipality(records: MunicipalityDrilldownRecord[], municipality: string) {
  const selected = normalizeLookup(municipality);
  return records.filter((record) => record.Category === "gurMonitoringAssessment" && (normalizeLookup(record.__normalizedMunicipality || record.Municipality) === selected));
}

function gurRecordsForProvince(records: MunicipalityDrilldownRecord[]) {
  const municipalitySet = new Set(auroraMunicipalities.map(normalizeLookup));
  return records.filter((record) => record.Category === "gurMonitoringAssessment" && municipalitySet.has(normalizeLookup(record.__normalizedMunicipality || record.Municipality)));
}

function isGurDrilldownColumn(label: string) {
  return [
    "Total GUR Units",
    "Individual Units",
    "Association Units",
    "Encoded in 1st Visit",
    "Encoded Amount in 1st Visit",
    "Not Encoded in 1st Visit",
    "Not Encoded Amount in 1st Visit",
    "Not Yet Due in 1st Visit",
    "Encoded in 2nd Visit",
    "Encoded Amount in 2nd Visit",
    "Not Encoded in 2nd Visit",
    "Not Encoded Amount in 2nd Visit",
    "Not Yet Due in 2nd Visit",
    "Encoded in 3rd Visit",
    "Encoded Amount in 3rd Visit",
    "Not Encoded in 3rd Visit",
    "Not Encoded Amount in 3rd Visit",
    "Not Yet Due in 3rd Visit",
    "Encoded in 4th Visit",
    "Encoded Amount in 4th Visit",
    "Not Encoded in 4th Visit",
    "Not Encoded Amount in 4th Visit",
    "Not Yet Due in 4th Visit",
    "Encoded in MdAnnualAssessment",
    "Not Encoded in MdAnnualAssessment",
    "Not Yet Due in MdAnnualAssessment",
    "Encoded in OrgAssessment",
    "Not Encoded in OrgAssessment",
    "Not Yet Due in OrgAssessment",
  ].includes(label);
}

function visitNumberFromLabel(label: string): 1 | 2 | 3 | 4 | null {
  if (/1st Visit/.test(label)) return 1;
  if (/2nd Visit/.test(label)) return 2;
  if (/3rd Visit/.test(label)) return 3;
  if (/4th Visit/.test(label)) return 4;
  return null;
}

function hasVisit(record: MunicipalityDrilldownRecord, visit: 1 | 2 | 3 | 4) {
  return record[`__has${visit}${visit === 1 ? "st" : visit === 2 ? "nd" : visit === 3 ? "rd" : "th"}Visit`] === true;
}

function encodedVisitDetails(records: MunicipalityDrilldownRecord[], visit: 1 | 2 | 3 | 4) {
  const visitName = `${visit}${visit === 1 ? "st" : visit === 2 ? "nd" : visit === 3 ? "rd" : "th"} Visit`;
  return records.flatMap((record) => {
    const details = Array.isArray(record.__visitDetails) ? record.__visitDetails as MunicipalityDrilldownRecord[] : [];
    return details.filter((detail) => detail.Visit === visitName);
  });
}

function notEncodedVisitDetails(records: MunicipalityDrilldownRecord[], visit: 1 | 2 | 3 | 4) {
  const visitName = `${visit}${visit === 1 ? "st" : visit === 2 ? "nd" : visit === 3 ? "rd" : "th"} Visit`;
  return records.filter((record) => !hasVisit(record, visit)).map((record) => ({
    "Participant/Association Name": titleOrFallback(record["Participant/Association Name"] || record["Participant Name / SLPA Name / Project Name"]),
    Municipality: titleOrFallback(record.Municipality),
    Barangay: titleOrFallback(record.Barangay),
    "Grant Code": titleOrFallback(record["Grant Code"], ""),
    "Project Enterprise": titleOrFallback(record["Project Enterprise"]),
    "GUR Date": titleOrFallback(record["GUR Date"], "Missing GUR Date"),
    "DSWD Total Cost": peso(Number(record.__gurAmount || 0)),
    "Amount Source": "DSWD Total Cost from Grant Utilization module",
    "Missing Visit": visitName,
  }));
}

function recordDateValue(record: MunicipalityDrilldownRecord, key: string) {
  const value = record[key];
  return value instanceof Date ? value : parseDashboardDate(value);
}

function visitDate(record: MunicipalityDrilldownRecord, visit: 1 | 2 | 3 | 4) {
  const dates = record.__visitDates && typeof record.__visitDates === "object" ? record.__visitDates as Record<string, unknown> : {};
  const value = dates[visit];
  return value instanceof Date ? value : parseDashboardDate(value);
}

function visitEligibility(record: MunicipalityDrilldownRecord, visit: 1 | 2 | 3 | 4, today = startOfDay(new Date())) {
  if (visit === 1) {
    const gurDate = recordDateValue(record, "__gurDate");
    if (!gurDate) return { eligible: false, missingGurDate: true };
    return { eligible: addMonths(gurDate, 1) <= today, missingGurDate: false };
  }
  const previousVisit = (visit - 1) as 1 | 2 | 3;
  const previousDate = visitDate(record, previousVisit);
  if (!hasVisit(record, previousVisit) || !previousDate) return { eligible: false, missingGurDate: false };
  return { eligible: addMonths(previousDate, 3) <= today, missingGurDate: false };
}

function assessmentEligibility(record: MunicipalityDrilldownRecord, assessment: "MdAnnualAssessment" | "OrgAssessment") {
  if (assessment === "OrgAssessment") return record["Unit Type"] === "Association" && hasVisit(record, 2);
  return hasVisit(record, 4);
}

function filterGurRecords(records: MunicipalityDrilldownRecord[], label: string) {
  const visit = visitNumberFromLabel(label);
  if (visit && /^Encoded/.test(label)) return encodedVisitDetails(records.filter((record) => visitEligibility(record, visit).eligible && hasVisit(record, visit)), visit);
  if (visit && /^Not Encoded/.test(label)) return notEncodedVisitDetails(records.filter((record) => visitEligibility(record, visit).eligible && !hasVisit(record, visit)), visit);
  if (visit && /^Not Yet Due/.test(label)) return records.filter((record) => !visitEligibility(record, visit).eligible);
  if (label === "Total GUR Units") return records;
  if (label === "Individual Units") return records.filter((record) => record["Unit Type"] === "Individual");
  if (label === "Association Units") return records.filter((record) => record["Unit Type"] === "Association");
  if (label === "Encoded in MdAnnualAssessment") return records.filter((record) => assessmentEligibility(record, "MdAnnualAssessment") && (record.presentInAnnualAssessment === true || record.__hasAnnualAssessment === true));
  if (label === "Not Encoded in MdAnnualAssessment") return records.filter((record) => assessmentEligibility(record, "MdAnnualAssessment") && record.presentInAnnualAssessment !== true && record.__hasAnnualAssessment !== true);
  if (label === "Not Yet Due in MdAnnualAssessment") return records.filter((record) => !assessmentEligibility(record, "MdAnnualAssessment"));
  if (label === "Encoded in OrgAssessment") return records.filter((record) => assessmentEligibility(record, "OrgAssessment") && (record.presentInOrgAssessment === true || record.__hasOrgAssessment === true));
  if (label === "Not Encoded in OrgAssessment") return records.filter((record) => assessmentEligibility(record, "OrgAssessment") && record.presentInOrgAssessment !== true && record.__hasOrgAssessment !== true);
  if (label === "Not Yet Due in OrgAssessment") return records.filter((record) => record["Unit Type"] === "Association" && !assessmentEligibility(record, "OrgAssessment"));
  return [];
}

function buildGurDisplay(records: MunicipalityDrilldownRecord[]) {
  const total = records.length;
  const individualRecords = records.filter((record) => record["Unit Type"] === "Individual");
  const associationRecords = records.filter((record) => record["Unit Type"] === "Association");
  const associations = associationRecords.length;
  const totalGurAmount = records.reduce((sum, record) => sum + (record.__hasGurAmount === true ? Number(record.__gurAmount || 0) : 0), 0);
  const individualGurAmount = individualRecords.reduce((sum, record) => sum + (record.__hasGurAmount === true ? Number(record.__gurAmount || 0) : 0), 0);
  const associationGurAmount = associationRecords.reduce((sum, record) => sum + (record.__hasGurAmount === true ? Number(record.__gurAmount || 0) : 0), 0);
  const visitAmount = (record: MunicipalityDrilldownRecord, visit: 1 | 2 | 3 | 4) => {
    const amounts = record.__visitAmounts && typeof record.__visitAmounts === "object" ? record.__visitAmounts as Record<string, number> : {};
    return Number(amounts[visit] || 0);
  };
  const row = (name: string, encodedLabel: string, notEncodedLabel: string, denominator = total): GurEncodingRow => {
    const visit = visitNumberFromLabel(encodedLabel);
    const assessmentName = name === "OrgAssessment" ? "OrgAssessment" : name === "MdAnnualAssessment" ? "MdAnnualAssessment" : "";
    const eligibleRecords: MunicipalityDrilldownRecord[] = visit
      ? records.filter((record) => visitEligibility(record, visit).eligible)
      : assessmentName
        ? records.filter((record) => assessmentEligibility(record, assessmentName as "MdAnnualAssessment" | "OrgAssessment"))
        : records;
    const encodedRecords: MunicipalityDrilldownRecord[] = visit ? eligibleRecords.filter((record) => hasVisit(record, visit)) : filterGurRecords(records, encodedLabel) as MunicipalityDrilldownRecord[];
    const notEncodedRecords: MunicipalityDrilldownRecord[] = visit ? eligibleRecords.filter((record) => !hasVisit(record, visit)) : filterGurRecords(records, notEncodedLabel) as MunicipalityDrilldownRecord[];
    const notYetDueRecords: MunicipalityDrilldownRecord[] = visit
      ? records.filter((record) => !visitEligibility(record, visit).eligible)
      : assessmentName === "OrgAssessment"
        ? records.filter((record) => record["Unit Type"] === "Association" && !assessmentEligibility(record, "OrgAssessment"))
        : assessmentName === "MdAnnualAssessment"
          ? records.filter((record) => !assessmentEligibility(record, "MdAnnualAssessment"))
          : [];
    const encodedDetails = visit ? encodedVisitDetails(encodedRecords, visit) : encodedRecords;
    const notEncodedDetails = visit ? notEncodedVisitDetails(notEncodedRecords, visit) : notEncodedRecords;
    const encodedAmount = visit ? encodedRecords.reduce((sum, record) => sum + visitAmount(record, visit), 0) : 0;
    const notEncodedAmount = notEncodedRecords.reduce((sum, record) => sum + (record.__hasGurAmount === true ? Number(record.__gurAmount || 0) : 0), 0);
    const eligibleTarget = eligibleRecords.length;
    const completion = eligibleTarget ? (encodedRecords.length / eligibleTarget) * 100 : 0;
    return {
      name,
      encodedLabel,
      notEncodedLabel,
      notYetDueLabel: `Not Yet Due in ${name}`,
      encodedAmountLabel: visit ? `Encoded Amount in ${name}` : encodedLabel,
      notEncodedAmountLabel: visit ? `Not Encoded Amount in ${name}` : notEncodedLabel,
      encoded: encodedRecords.length,
      notEncoded: notEncodedRecords.length,
      notYetDue: notYetDueRecords.length,
      eligibleTarget,
      denominator,
      encodedAmount,
      notEncodedAmount,
      totalAmount: totalGurAmount,
      encodedDetails,
      notEncodedDetails,
      encodedAmountDisplay: peso(encodedAmount),
      notEncodedAmountDisplay: peso(notEncodedAmount),
      totalAmountDisplay: peso(totalGurAmount),
      completion,
      completionDisplay: eligibleTarget ? `${completion.toFixed(1)}%` : "Not yet due",
    };
  };
  const visitRows: GurEncodingRow[] = [
    row("1st Visit", "Encoded in 1st Visit", "Not Encoded in 1st Visit"),
    row("2nd Visit", "Encoded in 2nd Visit", "Not Encoded in 2nd Visit"),
    row("3rd Visit", "Encoded in 3rd Visit", "Not Encoded in 3rd Visit"),
    row("4th Visit", "Encoded in 4th Visit", "Not Encoded in 4th Visit"),
  ];
  const overallEncoded = visitRows.reduce((sum, item) => sum + item.encoded, 0);
  const overallNotEncoded = visitRows.reduce((sum, item) => sum + item.notEncoded, 0);
  const overallNotYetDue = visitRows.reduce((sum, item) => sum + item.notYetDue, 0);
  const overallEligibleTarget = visitRows.reduce((sum, item) => sum + item.eligibleTarget, 0);
  const overallDenominator = total * 4;
  const overallCompletion = overallEligibleTarget ? (overallEncoded / overallEligibleTarget) * 100 : 0;
  const overallRow = {
    name: "Overall Monitoring Accomplishment",
    encodedLabel: "Total GUR Units",
    notEncodedLabel: "Total GUR Units",
    notYetDueLabel: "Total GUR Units",
    encodedAmountLabel: "Total GUR Units",
    notEncodedAmountLabel: "Total GUR Units",
    encoded: overallEncoded,
    notEncoded: overallNotEncoded,
    notYetDue: overallNotYetDue,
    eligibleTarget: overallEligibleTarget,
    denominator: overallDenominator,
    encodedAmount: 0,
    notEncodedAmount: 0,
    totalAmount: 0,
    encodedDetails: visitRows.flatMap((item) => item.encodedDetails || []),
    notEncodedDetails: visitRows.flatMap((item) => item.notEncodedDetails || []),
    encodedAmountDisplay: "—",
    notEncodedAmountDisplay: "—",
    totalAmountDisplay: "—",
    completion: overallCompletion,
    completionDisplay: overallEligibleTarget ? `${overallCompletion.toFixed(1)}%` : "Not yet due",
    isOverall: true,
  };
  return {
    summaryCards: [
      { label: "Total GUR Units", value: total, amountLabel: "Total GUR Amount", amount: totalGurAmount, amountDisplay: peso(totalGurAmount) },
      { label: "Individual Units", value: individualRecords.length, amountLabel: "Individual GUR Amount", amount: individualGurAmount, amountDisplay: peso(individualGurAmount) },
      { label: "Association Units", value: associations, amountLabel: "Association GUR Amount", amount: associationGurAmount, amountDisplay: peso(associationGurAmount) },
    ],
    visitRows: [...visitRows, overallRow],
    assessmentRows: [
      row("MdAnnualAssessment", "Encoded in MdAnnualAssessment", "Not Encoded in MdAnnualAssessment"),
      row("OrgAssessment", "Encoded in OrgAssessment", "Not Encoded in OrgAssessment", associations),
    ],
  };
}

function buildMunicipalityMonitoringBreakdown(records: MunicipalityDrilldownRecord[]): MunicipalityMonitoringBreakdownRow[] {
  const rowFor = (municipality: string, municipalityRecords: MunicipalityDrilldownRecord[], isTotal = false): MunicipalityMonitoringBreakdownRow => {
    const totalGurUnits = municipalityRecords.length;
    const visitStats = (visit: 1 | 2 | 3 | 4) => {
      const eligible = municipalityRecords.filter((record) => visitEligibility(record, visit).eligible);
      const encoded = eligible.filter((record) => hasVisit(record, visit));
      return {
        eligible: eligible.length,
        encoded: encoded.length,
        notEncoded: eligible.length - encoded.length,
        notYetDue: municipalityRecords.length - eligible.length,
      };
    };
    const first = visitStats(1);
    const second = visitStats(2);
    const third = visitStats(3);
    const fourth = visitStats(4);
    const totalEligible = first.eligible + second.eligible + third.eligible + fourth.eligible;
    const totalEncoded = first.encoded + second.encoded + third.encoded + fourth.encoded;
    const mdAnnualAssessmentEncoded = filterGurRecords(municipalityRecords, "Encoded in MdAnnualAssessment").length;
    const mdAnnualAssessmentNotEncoded = filterGurRecords(municipalityRecords, "Not Encoded in MdAnnualAssessment").length;
    const mdAnnualAssessmentEligible = mdAnnualAssessmentEncoded + mdAnnualAssessmentNotEncoded;
    const orgAssessmentEncoded = filterGurRecords(municipalityRecords, "Encoded in OrgAssessment").length;
    const orgAssessmentNotEncoded = filterGurRecords(municipalityRecords, "Not Encoded in OrgAssessment").length;
    const orgAssessmentEligible = orgAssessmentEncoded + orgAssessmentNotEncoded;
    return {
      municipality,
      totalGurUnits,
      firstVisitEligible: first.eligible,
      firstVisitEncoded: first.encoded,
      firstVisitNotEncoded: first.notEncoded,
      firstVisitNotYetDue: first.notYetDue,
      secondVisitEligible: second.eligible,
      secondVisitEncoded: second.encoded,
      secondVisitNotEncoded: second.notEncoded,
      secondVisitNotYetDue: second.notYetDue,
      thirdVisitEligible: third.eligible,
      thirdVisitEncoded: third.encoded,
      thirdVisitNotEncoded: third.notEncoded,
      thirdVisitNotYetDue: third.notYetDue,
      fourthVisitEligible: fourth.eligible,
      fourthVisitEncoded: fourth.encoded,
      fourthVisitNotEncoded: fourth.notEncoded,
      fourthVisitNotYetDue: fourth.notYetDue,
      overallMonitoringCompletion: totalEligible ? (totalEncoded / totalEligible) * 100 : 0,
      mdAnnualAssessmentEncoded,
      mdAnnualAssessmentNotEncoded,
      mdAnnualAssessmentCompletion: mdAnnualAssessmentEligible ? (mdAnnualAssessmentEncoded / mdAnnualAssessmentEligible) * 100 : 0,
      orgAssessmentEncoded,
      orgAssessmentNotEncoded,
      orgAssessmentCompletion: orgAssessmentEligible ? (orgAssessmentEncoded / orgAssessmentEligible) * 100 : 0,
      isTotal,
    };
  };
  const rows = auroraMunicipalities.map((municipality) => rowFor(municipality, gurRecordsForMunicipality(records, municipality)));
  return [...rows, rowFor("TOTAL", records, true)];
}

function buildVisitDueDateDebug(municipality: string, records: MunicipalityDrilldownRecord[]) {
  const dueCounts = (visit: 1 | 2 | 3 | 4) => {
    const eligible = records.filter((record) => visitEligibility(record, visit).eligible).length;
    return {
      eligible,
      notYetDue: records.length - eligible,
    };
  };
  const first = dueCounts(1);
  const second = dueCounts(2);
  const third = dueCounts(3);
  const fourth = dueCounts(4);
  return {
    municipality,
    totalGurRecords: records.length,
    missingGurDate: records.filter((record) => !recordDateValue(record, "__gurDate")).length,
    firstVisitEligible: first.eligible,
    firstVisitNotYetDue: first.notYetDue,
    secondVisitEligible: second.eligible,
    secondVisitNotYetDue: second.notYetDue,
    thirdVisitEligible: third.eligible,
    thirdVisitNotYetDue: third.notYetDue,
    fourthVisitEligible: fourth.eligible,
    fourthVisitNotYetDue: fourth.notYetDue,
  };
}

function buildAssessmentDueDebug(records: MunicipalityDrilldownRecord[]) {
  const associations = records.filter((record) => record["Unit Type"] === "Association");
  const orgAssessmentEligibleAfterSecondVisit = associations.filter((record) => assessmentEligibility(record, "OrgAssessment")).length;
  const annualAssessmentEligibleAfterFourthVisit = records.filter((record) => assessmentEligibility(record, "MdAnnualAssessment")).length;
  return {
    orgAssessmentEligibleAfterSecondVisit,
    annualAssessmentEligibleAfterFourthVisit,
    orgAssessmentNotYetDue: associations.length - orgAssessmentEligibleAfterSecondVisit,
    annualAssessmentNotYetDue: records.length - annualAssessmentEligibleAfterFourthVisit,
  };
}

function buildGurConsistencyCheck(selectedMunicipality: string, records: MunicipalityDrilldownRecord[]) {
  const totalGurUnits = records.length;
  const gurIndividualUnits = filterGurRecords(records, "Individual Units").length;
  const gurAssociationUnits = filterGurRecords(records, "Association Units").length;
  const encoded1stVisit = records.filter((record) => hasVisit(record, 1)).length;
  const notEncoded1stVisit = records.filter((record) => !hasVisit(record, 1)).length;
  const encoded2ndVisit = records.filter((record) => hasVisit(record, 2)).length;
  const notEncoded2ndVisit = records.filter((record) => !hasVisit(record, 2)).length;
  const encoded3rdVisit = records.filter((record) => hasVisit(record, 3)).length;
  const notEncoded3rdVisit = records.filter((record) => !hasVisit(record, 3)).length;
  const encoded4thVisit = records.filter((record) => hasVisit(record, 4)).length;
  const notEncoded4thVisit = records.filter((record) => !hasVisit(record, 4)).length;
  const encodedAnnualAssessment = filterGurRecords(records, "Encoded in MdAnnualAssessment").length;
  const notEncodedAnnualAssessment = filterGurRecords(records, "Not Encoded in MdAnnualAssessment").length;
  const encodedOrgAssessment = filterGurRecords(records, "Encoded in OrgAssessment").length;
  const notEncodedOrgAssessment = filterGurRecords(records, "Not Encoded in OrgAssessment").length;
  return {
    selectedMunicipality,
    gurIndividualUnits,
    gurAssociationUnits,
    totalGurUnits,
    encoded1stVisit,
    notEncoded1stVisit,
    check1stVisit: encoded1stVisit + notEncoded1stVisit === totalGurUnits,
    encoded2ndVisit,
    notEncoded2ndVisit,
    check2ndVisit: encoded2ndVisit + notEncoded2ndVisit === totalGurUnits,
    encoded3rdVisit,
    notEncoded3rdVisit,
    check3rdVisit: encoded3rdVisit + notEncoded3rdVisit === totalGurUnits,
    encoded4thVisit,
    notEncoded4thVisit,
    check4thVisit: encoded4thVisit + notEncoded4thVisit === totalGurUnits,
    encodedAnnualAssessment,
    notEncodedAnnualAssessment,
    checkAnnual: encodedAnnualAssessment + notEncodedAnnualAssessment === totalGurUnits,
    encodedOrgAssessment,
    notEncodedOrgAssessment,
    checkOrg: encodedOrgAssessment + notEncodedOrgAssessment === gurAssociationUnits,
  };
}

function buildProjectEnterpriseDebug(
  selectedMunicipality: string,
  gurSource: ReturnType<typeof buildGurDrilldownFromParsedFiles>,
  gurUnits: MunicipalityDrilldownRecord[],
  municipalityUnits: MunicipalityDrilldownRecord[],
) {
  const gurIndividualUnits = filterGurRecords(municipalityUnits, "Individual Units").length;
  const gurAssociationUnits = filterGurRecords(municipalityUnits, "Association Units").length;
  const totalGurUnits = municipalityUnits.length;
  const encoded1stVisit = municipalityUnits.filter((record) => hasVisit(record, 1)).length;
  const notEncoded1stVisit = municipalityUnits.filter((record) => !hasVisit(record, 1)).length;
  const encoded2ndVisit = municipalityUnits.filter((record) => hasVisit(record, 2)).length;
  const notEncoded2ndVisit = municipalityUnits.filter((record) => !hasVisit(record, 2)).length;
  const encoded3rdVisit = municipalityUnits.filter((record) => hasVisit(record, 3)).length;
  const notEncoded3rdVisit = municipalityUnits.filter((record) => !hasVisit(record, 3)).length;
  const encoded4thVisit = municipalityUnits.filter((record) => hasVisit(record, 4)).length;
  const notEncoded4thVisit = municipalityUnits.filter((record) => !hasVisit(record, 4)).length;
  const encodedAnnual = filterGurRecords(municipalityUnits, "Encoded in MdAnnualAssessment").length;
  const notEncodedAnnual = filterGurRecords(municipalityUnits, "Not Encoded in MdAnnualAssessment").length;
  const encodedOrg = filterGurRecords(municipalityUnits, "Encoded in OrgAssessment").length;
  const notEncodedOrg = filterGurRecords(municipalityUnits, "Not Encoded in OrgAssessment").length;
  return {
    selectedMunicipality,
    gurRowsRaw: gurSource.gurRows.length,
    projectEnterpriseSamples: gurSource.gurRows.slice(0, 10).map((row) => row["Project Enterprise"] || readProjectEnterprise(row)),
    gurIndividualUnits,
    gurAssociationUnits,
    totalGurUnits,
    monitoringIndividualRows: gurSource.monitoringIndividualRows.length,
    monitoringAssociationRows: gurSource.monitoringAssociationRows.length,
    encoded1stVisit,
    notEncoded1stVisit,
    check1st: encoded1stVisit + notEncoded1stVisit === totalGurUnits,
    encoded2ndVisit,
    notEncoded2ndVisit,
    check2nd: encoded2ndVisit + notEncoded2ndVisit === totalGurUnits,
    encoded3rdVisit,
    notEncoded3rdVisit,
    check3rd: encoded3rdVisit + notEncoded3rdVisit === totalGurUnits,
    encoded4thVisit,
    notEncoded4thVisit,
    check4th: encoded4thVisit + notEncoded4thVisit === totalGurUnits,
    encodedAnnual,
    notEncodedAnnual,
    checkAnnual: encodedAnnual + notEncodedAnnual === totalGurUnits,
    encodedOrg,
    notEncodedOrg,
    checkOrg: encodedOrg + notEncodedOrg === gurAssociationUnits,
    sampleIndividualUnits: gurUnits.filter((unit) => unit.unitType === "Individual").slice(0, 5),
    sampleAssociationUnits: gurUnits.filter((unit) => unit.unitType === "Association").slice(0, 5),
  };
}

function escapeCsv(value: unknown) {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function downloadDetailCsv(records: MunicipalityDrilldownRecord[], columns: string[], selection: DrilldownSelection) {
  const csv = [columns, ...records.map((record) => columns.map((column) => record[column] || ""))]
    .map((row) => row.map(escapeCsv).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = gurCsvFilename(selection);
  link.click();
  URL.revokeObjectURL(url);
}

function copyDetailTable(records: MunicipalityDrilldownRecord[], columns: string[]) {
  const text = [columns, ...records.map((record) => columns.map((column) => record[column] || ""))]
    .map((row) => row.map((value) => String(value ?? "")).join("\t"))
    .join("\n");
  navigator.clipboard?.writeText(text);
}

function todayForFilename() {
  return new Date().toISOString().slice(0, 10);
}

function filenamePart(value: string) {
  return value.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function gurCsvFilename(selection: DrilldownSelection) {
  const filter = selection.column
    .replace(/^GUR Encoded\s*-?\s*/i, "")
    .replace(/^Association\s+/i, "")
    .replace(/\bin MdAnnualAssessment\b/i, "Annual Assessment")
    .replace(/\bin OrgAssessment\b/i, "OrgAssessment")
    .replace(/\bin\s+/i, "")
    .replace(/^Total$/i, "Total")
    .replace(/\s+/g, " ");
  return `${filenamePart(selection.municipality)}_GUR_${filenamePart(filter)}_${todayForFilename()}.csv`;
}

function downloadSummaryCsv(rows: Array<Array<string | number>>, columns: string[], gurDisplay?: ReturnType<typeof buildGurDisplay>, selectedMunicipality = "") {
  const visitColumns = ["Selected Municipality", "Visit", "Encoded Count", "Not Encoded Count", "Total GUR Units", "Completion %"];
  const visitRows = (gurDisplay?.visitRows || []).map((row) => [
    selectedMunicipality,
    row.name,
    row.encoded,
    row.notEncoded,
    row.denominator,
    `${row.completion.toFixed(1)}%`,
  ]);
  const detailColumns = ["Detail Type", "Municipality", "Barangay", "Participant/Association Name", "Grant Code", "Source Module", "Visit", "Amount 1", "Project Enterprise", "DSWD Total Cost", "Amount Source", "Missing Visit"];
  const detailRows = (gurDisplay?.visitRows || []).filter((row) => !row.isOverall).flatMap((row) => {
    const encoded = (row.encodedDetails || []).map((detail: any) => [
      row.encodedLabel,
      detail.Municipality || "",
      detail.Barangay || "",
      detail["Participant/Association Name"] || "",
      detail["Grant Code"] || "",
      detail["Source Module"] || "",
      detail.Visit || "",
      detail["Amount 1"] || "",
      "",
      "",
      detail["Amount Source"] || "",
      "",
    ]);
    const notEncoded = (row.notEncodedDetails || []).map((detail: any) => [
      row.notEncodedLabel,
      detail.Municipality || "",
      detail.Barangay || "",
      detail["Participant/Association Name"] || "",
      detail["Grant Code"] || "",
      "",
      "",
      "",
      detail["Project Enterprise"] || "",
      detail["DSWD Total Cost"] || "",
      detail["Amount Source"] || "",
      detail["Missing Visit"] || "",
    ]);
    return [...encoded, ...notEncoded];
  });
  const csvRows = [
    columns,
    ...rows,
    [],
    visitColumns,
    ...visitRows,
    [],
    detailColumns,
    ...detailRows,
  ];
  const csv = csvRows
    .map((row) => row.map(escapeCsv).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "municipality-drilldown-summary.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function downloadProvinceMonitoringSummaryCsv(gurDisplay: ReturnType<typeof buildGurDisplay>, breakdownRows: any[]) {
  const monitoringColumns = ["Visit", "Encoded Count", "Encoded Amount", "Not Encoded Count", "Not Encoded Amount", "Total GUR Units", "Total GUR Amount", "Completion %"];
  const monitoringRows = gurDisplay.visitRows.map((row) => [
    row.name,
    row.encoded,
    row.isOverall ? "—" : row.encodedAmountDisplay,
    row.notEncoded,
    row.isOverall ? "—" : row.notEncodedAmountDisplay,
    row.denominator,
    row.isOverall ? "—" : row.totalAmountDisplay,
    `${row.completion.toFixed(1)}%`,
  ]);
  const assessmentColumns = ["Assessment", "Encoded Count", "Not Encoded Count", "Denominator", "Completion %"];
  const assessmentRows = gurDisplay.assessmentRows.map((row) => [
    row.name,
    row.encoded,
    row.notEncoded,
    row.denominator,
    `${row.completion.toFixed(1)}%`,
  ]);
  const breakdownColumns = [
    "Municipality",
    "Total GUR Units",
    "Required Visits",
    "Completed Visits",
    "Missing Visits",
    "Monitoring Completion %",
    "MdAnnualAssessment Encoded",
    "MdAnnualAssessment Not Encoded",
    "MdAnnualAssessment Completion %",
    "OrgAssessment Encoded",
    "OrgAssessment Not Encoded",
    "OrgAssessment Completion %",
  ];
  const breakdownExportRows = breakdownRows.map((row) => [
    row.municipality,
    row.totalGurUnits,
    row.requiredVisits,
    row.completedVisits,
    row.missingVisits,
    `${row.monitoringCompletion.toFixed(1)}%`,
    row.mdAnnualAssessmentEncoded,
    row.mdAnnualAssessmentNotEncoded,
    `${row.mdAnnualAssessmentCompletion.toFixed(1)}%`,
    row.orgAssessmentEncoded,
    row.orgAssessmentNotEncoded,
    `${row.orgAssessmentCompletion.toFixed(1)}%`,
  ]);
  const csvRows = [
    ["Province-wide Monitoring Visit Encoding"],
    monitoringColumns,
    ...monitoringRows,
    [],
    ["Province-wide Assessment Encoding"],
    assessmentColumns,
    ...assessmentRows,
    [],
    ["Monitoring & Assessment Summary by Municipality"],
    breakdownColumns,
    ...breakdownExportRows,
  ];
  const csv = csvRows
    .map((row) => row.map(escapeCsv).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `province-monitoring-assessment-summary-${todayForFilename()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadProvinceMonitoringSummaryCsvV2(gurDisplay: ReturnType<typeof buildGurDisplay>, breakdownRows: MunicipalityMonitoringBreakdownRow[]) {
  const monitoringColumns = ["Visit", "Eligible Target", "Encoded Count", "Not Encoded Count", "Not Yet Due Count", "Encoded Amount", "Not Encoded Amount", "Total GUR Units", "Completion %"];
  const monitoringRows = gurDisplay.visitRows.map((row) => [
    row.name,
    row.eligibleTarget,
    row.encoded,
    row.notEncoded,
    row.notYetDue,
    row.isOverall ? "--" : row.encodedAmountDisplay,
    row.isOverall ? "--" : row.notEncodedAmountDisplay,
    row.denominator,
    row.completionDisplay,
  ]);
  const assessmentColumns = ["Assessment", "Eligible Target", "Encoded Count", "Not Encoded Count", "Not Yet Due Count", "Completion %"];
  const assessmentRows = gurDisplay.assessmentRows.map((row) => [
    row.name,
    row.eligibleTarget,
    row.encoded,
    row.notEncoded,
    row.notYetDue,
    row.completionDisplay,
  ]);
  const breakdownColumns = [
    "Municipality",
    "Total GUR Units",
    "1st Visit Eligible Target",
    "1st Visit Encoded",
    "1st Visit Not Encoded",
    "1st Visit Not Yet Due",
    "2nd Visit Eligible Target",
    "2nd Visit Encoded",
    "2nd Visit Not Encoded",
    "2nd Visit Not Yet Due",
    "3rd Visit Eligible Target",
    "3rd Visit Encoded",
    "3rd Visit Not Encoded",
    "3rd Visit Not Yet Due",
    "4th Visit Eligible Target",
    "4th Visit Encoded",
    "4th Visit Not Encoded",
    "4th Visit Not Yet Due",
    "Overall Monitoring Completion %",
  ];
  const breakdownExportRows = breakdownRows.map((row) => [
    row.municipality,
    row.totalGurUnits,
    row.firstVisitEligible,
    row.firstVisitEncoded,
    row.firstVisitNotEncoded,
    row.firstVisitNotYetDue,
    row.secondVisitEligible,
    row.secondVisitEncoded,
    row.secondVisitNotEncoded,
    row.secondVisitNotYetDue,
    row.thirdVisitEligible,
    row.thirdVisitEncoded,
    row.thirdVisitNotEncoded,
    row.thirdVisitNotYetDue,
    row.fourthVisitEligible,
    row.fourthVisitEncoded,
    row.fourthVisitNotEncoded,
    row.fourthVisitNotYetDue,
    `${row.overallMonitoringCompletion.toFixed(1)}%`,
  ]);
  const csvRows = [
    ["Province-wide Monitoring Visit Encoding"],
    monitoringColumns,
    ...monitoringRows,
    [],
    ["Province-wide Assessment Encoding"],
    assessmentColumns,
    ...assessmentRows,
    [],
    ["Monitoring & Assessment Summary by Municipality"],
    breakdownColumns,
    ...breakdownExportRows,
  ];
  const csv = csvRows
    .map((row) => row.map(escapeCsv).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `province-monitoring-assessment-summary-${todayForFilename()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
