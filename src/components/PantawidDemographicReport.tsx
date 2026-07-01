import { useEffect, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Clipboard, Download, X } from "lucide-react";
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AURORA_MUNICIPALITIES,
  logMunicipalityNormalizationDebug,
  normalizeAuroraMunicipality,
  type DashboardParsedFile,
} from "../utils/dashboardAnalytics";

type ParsedRow = Record<string, any> & {
  __sourceFile?: string;
  __headers?: string[];
};

type PantawidStatus = "Pantawid" | "Non-Pantawid" | "Unknown";

type Participant = {
  key: string;
  participantId: string;
  fullName: string;
  municipality: string;
  barangay: string;
  yearServed: string;
  pantawidStatus: PantawidStatus;
  isPantawid: string;
  sex: string;
  gender: string;
  civilStatus: string;
  sector: string;
  sectorRaw: string;
  ipGroupName: string;
  ipGroupNameRaw: string;
  isPwd: string;
  isPwdRaw: string;
  disability: string;
  hea: string;
  sourceFile: string;
};

type DetailSelection = {
  title: string;
  records: Participant[];
};

type SlpaDemographicsTarget = {
  municipality?: string;
  slpaName?: string;
  grantCode?: string;
  projectId?: string;
};

type SlpaMember = {
  key: string;
  fullName: string;
  sex: "Male" | "Female" | "Unknown Sex" | "Not matched";
  pantawidStatus: "Pantawid" | "Non-Pantawid" | "Unknown Pantawid Status" | "Not matched";
  householdId: string;
  participantId: string;
  slpaName: string;
  grantCode: string;
  projectId: string;
  municipality: string;
  barangay: string;
  sector: string;
  contactNumber: string;
  sourceModule: string;
  sourceFile: string;
  personalMatchStatus: "Matched to Personal Module" | "Personal Record Not Matched";
  sexSource: "Personal Module" | "Personal Record Not Matched";
  pantawidSource: "Personal Module" | "Personal Record Not Matched";
  personal?: Record<string, any>;
  personalMatchConfidence?: "ID" | "Name + Municipality" | "Name + Municipality + Barangay" | "Name Only" | "Not Matched";
  matchMethod?: string;
  projectFullName?: string;
  projectParticipantId?: string;
};

type SlpaFilterOptions = {
  municipalities: string[];
  slpaNames: string[];
  barangays: string[];
  sectors: string[];
  validSlpaKeys: string[];
  validSlpaNames: string[];
  debug: {
    selectedMunicipality: string;
    normalizedSelectedMunicipality: string;
    totalProjectRows: number;
    projectRowsInMunicipality: number;
    associationRows: number;
    excludedIndividualRows: number;
    excludedPersonNameOptions: string[];
    finalSlpaOptionsCount: number;
    finalSlpaOptionsSample: Array<{ label: string; value: string; municipality: string; grantCode: string; projectId: string }>;
    personNamesFoundInDropdown: Array<{ label: string; value: string; municipality: string; grantCode: string; projectId: string }>;
    municipalitiesInOptions: string[];
    invalidOptions: Array<{ label: string; value: string; municipality: string; grantCode: string; projectId: string }>;
    enterpriseTypeSamples: string[];
    invalidOptionsRemovedCount: number;
    selectedSlpaProjectRows: number;
    uniqueMemberCount: number;
  };
};

type DistributionRow = {
  label: string;
  count: number;
  percentage: number;
  records: Participant[];
};

type PantawidTableRow = {
  municipality: string;
  yearServed: string;
  records: Participant[];
  totalServed: number;
  pantawidServed: number;
  nonPantawidServed: number;
  unknownPantawidStatus: number;
  male: number;
  female: number;
  pwd: number;
  ip: number;
  soloParent: number;
  youth: number;
  seniorCitizen: number;
  topSector: string;
  topCivilStatus: string;
  topHea: string;
};

const detailColumns = [
  "SLP Participant ID",
  "Full Name",
  "Municipality",
  "Barangay",
  "Year Served",
  "Is Pantawid?",
  "Civil Status",
  "HEA",
  "Sex",
  "Gender",
  "Sector",
  "IP Group Name",
  "Is PWD",
  "Disability",
  "Source File",
];

const slpaMemberColumns = [
  "Full Name",
  "Sex",
  "Pantawid Status",
  "Household ID",
  "SLP Participant ID",
  "Municipality",
  "Barangay",
  "Sector",
  "Contact Number",
  "Personal Match Status",
  "Sex Source",
  "Pantawid Source",
  "Source Module",
  "Source File",
];

const mainTableColumns = [
  "Municipality",
  "Year Served",
  "Total Served",
  "Pantawid Served",
  "Non-Pantawid Served",
  "Unknown Pantawid Status",
  "Male",
  "Female",
  "PWD",
  "IP",
  "Solo Parent",
  "Youth",
  "Senior Citizen",
  "Top Sector",
  "Top Civil Status",
  "Top HEA",
];

const chartColors = ["#047857", "#F59E0B", "#0F766E", "#38BDF8", "#8B5CF6", "#EF4444"];

export function PantawidDemographicReport({ parsedFiles, slpaTarget }: { parsedFiles: DashboardParsedFile[]; slpaTarget?: SlpaDemographicsTarget | null }) {
  const [filters, setFilters] = useState({
    municipality: "All",
    yearServed: "All",
    pantawidStatus: "All",
    sex: "All",
    gender: "All",
    civilStatus: "All",
    sector: "All",
    ipGroupName: "All",
    isPwd: "All",
    disability: "All",
    hea: "All",
  });
  const [detail, setDetail] = useState<DetailSelection | null>(null);
  const [detailSearch, setDetailSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [mainRowLimit, setMainRowLimit] = useState(100);
  const [detailRowLimit, setDetailRowLimit] = useState(100);
  const [slpaFilters, setSlpaFilters] = useState({
    municipality: "All",
    slpaName: "All",
    barangay: "All",
    sex: "All",
    pantawidStatus: "All",
    sector: "All",
    search: "",
  });

  const personalRows = useMemo(() => getRowsByModule(parsedFiles, ["personal", "personal module", "slpis personal"]), [parsedFiles]);
  const slpaSources = useMemo(() => buildSlpaDemographicsSources(parsedFiles), [parsedFiles]);
  const slpaMembers = useMemo(() => buildSlpaMembers(slpaSources), [slpaSources]);
  const slpaOptions = useMemo(() => buildSlpaFilterOptions(slpaMembers, slpaSources, slpaFilters), [slpaMembers, slpaSources, slpaFilters]);
  const filteredSlpaMembers = useMemo(() => filterSlpaMembers(slpaMembers, slpaFilters, slpaTarget, slpaOptions.validSlpaKeys, slpaOptions.validSlpaNames), [slpaMembers, slpaFilters, slpaTarget, slpaOptions.validSlpaKeys, slpaOptions.validSlpaNames]);
  const slpaSummary = useMemo(() => summarizeSlpaMembers(filteredSlpaMembers), [filteredSlpaMembers]);
  const uniqueParticipants = useMemo(() => buildParticipants(personalRows), [personalRows]);
  const filteredParticipants = useMemo(() => filterParticipants(uniqueParticipants, filters), [uniqueParticipants, filters]);
  const options = useMemo(() => buildFilterOptions(uniqueParticipants), [uniqueParticipants]);
  const summary = useMemo(() => summarizeParticipants(filteredParticipants), [filteredParticipants]);
  const groupedRows = useMemo(() => groupByMunicipalityYear(filteredParticipants), [filteredParticipants]);
  const totalRow = useMemo(() => buildTotalRow(groupedRows), [groupedRows]);
  const visibleGroupedRows = useMemo(() => groupedRows.slice(0, mainRowLimit), [groupedRows, mainRowLimit]);
  const distributions = useMemo(() => buildDistributions(filteredParticipants), [filteredParticipants]);
  const charts = useMemo(() => buildCharts(filteredParticipants), [filteredParticipants]);
  const visibleDetailRecords = useMemo(() => {
    const rows = detail?.records || [];
    const needle = detailSearch.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(needle)));
  }, [detail, detailSearch]);
  const pagedDetailRecords = useMemo(() => visibleDetailRecords.slice(0, detailRowLimit), [detailRowLimit, visibleDetailRecords]);

  useEffect(() => {
    if (!slpaTarget) return;
    setShowFilters(true);
    setSlpaFilters((current) => ({
      ...current,
      municipality: normalizeAuroraMunicipality(slpaTarget.municipality) || current.municipality,
      slpaName: slpaTarget.slpaName || current.slpaName,
      barangay: "All",
      sex: "All",
      pantawidStatus: "All",
      sector: "All",
      search: "",
    }));
  }, [slpaTarget]);

  useEffect(() => {
    console.log("SLPA_DEMOGRAPHICS_SOURCE_COUNTS", {
      personalRows: slpaSources.personalRows.length,
      projectRows: slpaSources.projectRows.length,
      dptRows: slpaSources.dptRows.length,
    });
    logMunicipalityNormalizationDebug([
      ...personalRows.map((row) => readCell(row, ["Municipality", "City/Municipality", "City"])),
      ...slpaSources.projectRows.map((row) => readCell(row, ["Municipality", "City/Municipality", "City"])),
      ...slpaSources.dptRows.map((row) => readCell(row, ["Municipality", "City/Municipality", "City"])),
    ]);
  }, [personalRows, slpaSources]);

  useEffect(() => {
    const selectedMunicipality = normalizeAuroraMunicipality(slpaFilters.municipality) || "All";
    console.log("SLPA_DROPDOWN_DEBUG", {
      selectedMunicipality: slpaOptions.debug.selectedMunicipality,
      totalProjectRows: slpaOptions.debug.totalProjectRows,
      associationCandidateRows: slpaOptions.debug.associationRows,
      slpaOptionsCount: slpaOptions.debug.finalSlpaOptionsCount,
      slpaOptionsSample: slpaOptions.debug.finalSlpaOptionsSample.slice(0, 10),
    });
    console.log("SLPA_OPTIONS_SOURCE_DEBUG", {
      selectedMunicipality: slpaOptions.debug.selectedMunicipality,
      normalizedSelectedMunicipality: slpaOptions.debug.normalizedSelectedMunicipality,
      totalProjectRows: slpaOptions.debug.totalProjectRows,
      projectRowsInMunicipality: slpaOptions.debug.projectRowsInMunicipality,
      associationRows: slpaOptions.debug.associationRows,
      excludedIndividualRows: slpaOptions.debug.excludedIndividualRows,
      excludedPersonNameOptions: slpaOptions.debug.excludedPersonNameOptions.slice(0, 20),
      finalSlpaOptionsCount: slpaOptions.debug.finalSlpaOptionsCount,
      finalSlpaOptionsSample: slpaOptions.debug.finalSlpaOptionsSample.slice(0, 20),
    });
    console.log("SLPA_OPTIONS_INVALID_SAMPLE", {
      personNamesFoundInDropdown: slpaOptions.debug.personNamesFoundInDropdown.slice(0, 20),
      municipalitiesInOptions: slpaOptions.debug.municipalitiesInOptions,
    });
    console.log("SLPA_DEMO_PROJECT_SOURCE_DEBUG", {
      selectedMunicipality: slpaOptions.debug.normalizedSelectedMunicipality,
      totalProjectRows: slpaOptions.debug.totalProjectRows,
      projectRowsInMunicipality: slpaOptions.debug.projectRowsInMunicipality,
      associationRowsInMunicipality: slpaOptions.debug.associationRows,
      enterpriseTypeSamples: slpaOptions.debug.enterpriseTypeSamples.slice(0, 30),
      slpaOptionsCount: slpaOptions.debug.finalSlpaOptionsCount,
      slpaOptionsSample: slpaOptions.debug.finalSlpaOptionsSample.slice(0, 20),
      optionMunicipalities: slpaOptions.debug.municipalitiesInOptions,
    });
    console.log("SLPA_STRICT_SOURCE_DEBUG", {
      selectedMunicipality: slpaOptions.debug.normalizedSelectedMunicipality,
      totalProjectRows: slpaOptions.debug.totalProjectRows,
      projectRowsInMunicipality: slpaOptions.debug.projectRowsInMunicipality,
      associationRowsInMunicipality: slpaOptions.debug.associationRows,
      finalSlpaOptionsCount: slpaOptions.debug.finalSlpaOptionsCount,
      optionMunicipalities: slpaOptions.debug.municipalitiesInOptions,
      finalSlpaOptionsSample: slpaOptions.debug.finalSlpaOptionsSample.slice(0, 20),
    });
    console.log("SLPA_STRICT_INVALID_OPTIONS_REMOVED", slpaOptions.debug.invalidOptions);
    console.log("SLPA_DROPDOWN_STRICT_DEBUG", {
      selectedMunicipality: slpaOptions.debug.selectedMunicipality,
      normalizedSelectedMunicipality: slpaOptions.debug.normalizedSelectedMunicipality,
      projectRowsTotal: slpaOptions.debug.totalProjectRows,
      rowsInSelectedMunicipality: slpaOptions.debug.projectRowsInMunicipality,
      associationRowsInSelectedMunicipality: slpaOptions.debug.associationRows,
      finalOptionsCount: slpaOptions.debug.finalSlpaOptionsCount,
      optionMunicipalities: slpaOptions.debug.municipalitiesInOptions,
      finalOptionsSample: slpaOptions.debug.finalSlpaOptionsSample.slice(0, 20),
    });
    console.log("SLPA_DROPDOWN_CROSS_MUNICIPALITY_CHECK", {
      selectedMunicipality: slpaOptions.debug.selectedMunicipality,
      invalidOptions: slpaOptions.debug.invalidOptions,
    });
    console.log("SLPA_FILTER_DEBUG", {
      selectedMunicipality,
      selectedSlpaName: slpaFilters.slpaName,
      selectedBarangay: slpaFilters.barangay,
      filteredMembersCount: filteredSlpaMembers.length,
      sampleMembers: filteredSlpaMembers.slice(0, 5),
    });
    console.log("SLPA_DEMOGRAPHICS_SELECTED", {
      municipality: slpaFilters.municipality,
      slpaName: slpaFilters.slpaName,
      grantCode: slpaTarget?.grantCode || "",
      projectId: slpaTarget?.projectId || "",
    });
    console.log("SLPA_DEMOGRAPHICS_COUNTS", {
      totalMembers: slpaSummary.totalMembers,
      male: slpaSummary.male,
      female: slpaSummary.female,
      unknownSex: slpaSummary.unknownSex,
      pantawid: slpaSummary.pantawid,
      nonPantawid: slpaSummary.nonPantawid,
      unknownPantawid: slpaSummary.unknownPantawidStatus,
    });
    const matchedMembers = filteredSlpaMembers.filter((member) => member.personalMatchStatus === "Matched to Personal Module");
    const unmatchedMembers = filteredSlpaMembers.filter((member) => member.personalMatchStatus === "Personal Record Not Matched");
    console.log("SLPA_PERSONAL_MATCH_ACCURACY", {
      selectedMunicipality: slpaOptions.debug.normalizedSelectedMunicipality,
      selectedSlpa: slpaFilters.slpaName,
      projectMemberRows: filteredSlpaMembers.length,
      matchedToPersonal: matchedMembers.length,
      notMatchedToPersonal: unmatchedMembers.length,
      matchRate: matchedMembers.length / Math.max(filteredSlpaMembers.length, 1),
      personalSexValues: [...new Set(matchedMembers.map((member) => member.personal?.Sex).filter(Boolean))],
      personalPantawidValues: [...new Set(matchedMembers.map((member) => member.personal?.["Is Pantawid"] || member.personal?.["Is Pantawid?"]).filter(Boolean))],
    });
    console.log("SLPA_NOT_MATCHED_SAMPLE", unmatchedMembers.slice(0, 20));
    console.log("SLPA_MATCHED_SAMPLE", matchedMembers.slice(0, 20));
    console.log("SLPA_DEMO_MEMBER_MATCH_DEBUG", {
      selectedMunicipality: slpaOptions.debug.normalizedSelectedMunicipality,
      selectedSlpa: slpaFilters.slpaName,
      projectMemberRows: filteredSlpaMembers.length,
      matchedPersonalRows: matchedMembers.length,
      notMatchedPersonalRows: unmatchedMembers.length,
      male: slpaSummary.male,
      female: slpaSummary.female,
      pantawid: slpaSummary.pantawid,
      nonPantawid: slpaSummary.nonPantawid,
    });
    console.log("SLPA_MEMBER_PERSONAL_MATCH_DEBUG", {
      selectedMunicipality: slpaOptions.debug.normalizedSelectedMunicipality,
      selectedSlpa: slpaFilters.slpaName,
      projectMemberRows: filteredSlpaMembers.length,
      matchedToPersonal: matchedMembers.length,
      notMatchedToPersonal: unmatchedMembers.length,
      male: slpaSummary.male,
      female: slpaSummary.female,
      pantawid: slpaSummary.pantawid,
      nonPantawid: slpaSummary.nonPantawid,
    });
    console.log("SLPA_DEMO_SOURCE_ACCURACY", {
      selectedMunicipality: slpaOptions.debug.normalizedSelectedMunicipality,
      selectedSlpa: slpaFilters.slpaName,
      totalProjectRows: slpaOptions.debug.totalProjectRows,
      projectRowsInMunicipality: slpaOptions.debug.projectRowsInMunicipality,
      associationRowsInMunicipality: slpaOptions.debug.associationRows,
      slpaOptionsCount: slpaOptions.debug.finalSlpaOptionsCount,
      selectedSlpaProjectRows: slpaOptions.debug.selectedSlpaProjectRows,
      uniqueMemberCount: slpaOptions.debug.uniqueMemberCount,
    });
    console.log("SLPA_DEMO_PERSONAL_MATCH_ACCURACY", {
      matchedToPersonal: matchedMembers.length,
      notMatchedToPersonal: unmatchedMembers.length,
      male: slpaSummary.male,
      female: slpaSummary.female,
      pantawid: slpaSummary.pantawid,
      nonPantawid: slpaSummary.nonPantawid,
      matchRate: matchedMembers.length / Math.max(filteredSlpaMembers.length, 1),
      sampleMatched: matchedMembers.slice(0, 20),
      sampleNotMatched: unmatchedMembers.slice(0, 20),
    });
    console.log("SLPA_MEMBER_MATCH_DEBUG", {
      selectedSlpa: slpaFilters.slpaName,
      selectedGrantCode: slpaTarget?.grantCode || "",
      projectMemberRows: filteredSlpaMembers.length,
      personalRows: slpaSources.personalRows.length,
      matchedToPersonal: matchedMembers.length,
      notMatchedToPersonal: unmatchedMembers.length,
      male: slpaSummary.male,
      female: slpaSummary.female,
      pantawid: slpaSummary.pantawid,
      nonPantawid: slpaSummary.nonPantawid,
      unknownSex: slpaSummary.unknownSex,
      unknownPantawid: slpaSummary.unknownPantawidStatus,
    });
    const pantawidSexCounts = summarizePantawidBySex(filteredSlpaMembers);
    console.log("SLPA_PANTAWID_BY_SEX_DEBUG", {
      selectedMunicipality: slpaOptions.debug.normalizedSelectedMunicipality,
      selectedSlpa: slpaFilters.slpaName,
      filteredMembers: filteredSlpaMembers.length,
      matchedPersonalMembers: pantawidSexCounts.matchedPersonalMembers,
      malePantawid: pantawidSexCounts.malePantawid,
      maleNonPantawid: pantawidSexCounts.maleNonPantawid,
      femalePantawid: pantawidSexCounts.femalePantawid,
      femaleNonPantawid: pantawidSexCounts.femaleNonPantawid,
    });
    console.log("SLPA_MEMBER_UNMATCHED_SAMPLE", unmatchedMembers.slice(0, 10));
    console.log("SLPA_MEMBER_PERSONAL_SAMPLE", matchedMembers.slice(0, 10));
  }, [filteredSlpaMembers, slpaFilters, slpaOptions.debug, slpaSources.personalRows.length, slpaSummary, slpaTarget]);

  useEffect(() => {
    console.log("PANTAWID DEMOGRAPHIC REPORT DEBUG", {
      personalRows: personalRows.length,
      uniqueParticipants: uniqueParticipants.length,
      selectedMunicipality: filters.municipality,
      selectedYearServed: filters.yearServed,
      totalServed: summary.totalServed,
      pantawidServed: summary.pantawidServed,
      nonPantawidServed: summary.nonPantawidServed,
      unknownPantawidStatus: summary.unknownPantawidStatus,
      pwdServed: summary.pwdServed,
      ipServed: summary.ipServed,
      samplePersonalRow: personalRows[0],
      sampleParticipant: uniqueParticipants[0],
    });
  }, [filters.municipality, filters.yearServed, personalRows, summary, uniqueParticipants]);

  useEffect(() => {
    console.log("PANTAWID_DEMOGRAPHIC_COUNT_CHECK", {
      totalRows: filteredParticipants.length,
      pwdYesCount: filteredParticipants.filter(isPwdParticipant).length,
      pwdNoCount: filteredParticipants.filter((item) => isNo(item.isPwdRaw) || isBlankLike(item.isPwdRaw)).length,
      ipWithGroupNameCount: filteredParticipants.filter(isIpParticipant).length,
      ipBlankCount: filteredParticipants.filter((item) => !isIpParticipant(item)).length,
      selectedMunicipality: filters.municipality,
      selectedYear: filters.yearServed,
    });
  }, [filteredParticipants, filters.municipality, filters.yearServed]);

  useEffect(() => {
    const sectorCounts = {
      soloParent: filteredParticipants.filter(isSoloParentParticipant).length,
      youth: filteredParticipants.filter(isYouthParticipant).length,
      seniorCitizen: filteredParticipants.filter(isSeniorCitizenParticipant).length,
    };
    console.log("PANTAWID_REPORT_SOURCE_ROWS", {
      totalRows: personalRows.length,
      sourceModule: "Personal Module",
    });
    console.log("PANTAWID_REPORT_FILTERED_ROWS", {
      totalRows: filteredParticipants.length,
      selectedMunicipality: filters.municipality,
      selectedYear: filters.yearServed,
    });
    console.log("PANTAWID_REPORT_TOTAL_ROW", totalRow);
    console.log("PANTAWID_REPORT_SECTOR_COUNTS", sectorCounts);
  }, [filteredParticipants, filters.municipality, filters.yearServed, personalRows.length, totalRow]);

  useEffect(() => {
    console.log("PANTAWID DEMOGRAPHIC DISTRIBUTION DEBUG", {
      personalRows: personalRows.length,
      uniqueParticipants: uniqueParticipants.length,
      totalServed: summary.totalServed,
      pantawidServed: summary.pantawidServed,
      nonPantawidServed: summary.nonPantawidServed,
      unknownPantawidStatus: summary.unknownPantawidStatus,
      civilStatusDistribution: distributions.civilStatus.map(({ label, count, percentage }) => ({ civilStatus: label, count, percentage })),
      heaDistribution: distributions.hea.map(({ label, count, percentage }) => ({ hea: label, count, percentage })),
      sexDistribution: distributions.sex.map(({ label, count, percentage }) => ({ sex: label, count, percentage })),
      genderDistribution: distributions.gender.map(({ label, count, percentage }) => ({ gender: label, count, percentage })),
      sectorDistribution: distributions.sector.map(({ label, count, percentage }) => ({ sector: label, count, percentage })),
      pwdDistribution: distributions.isPwd.map(({ label, count, percentage }) => ({ isPwd: label, count, percentage })),
      ipDistribution: distributions.ipGroupName.map(({ label, count, percentage }) => ({ ipGroupName: label, count, percentage })),
      sampleRow: personalRows[0],
      sampleParticipant: uniqueParticipants[0],
    });
  }, [distributions, personalRows, summary, uniqueParticipants]);

  const openDetail = (title: string, records: Participant[]) => {
    setDetailSearch("");
    setDetailRowLimit(100);
    setDetail({ title, records });
  };

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Personal Module</p>
          <h3 className="mt-1 text-2xl font-bold text-[#064E3B]">Pantawid Served Demographic Report</h3>
          <p className="mt-1 max-w-3xl text-sm text-[#64748B]">Aggregated from the Personal Module by municipality, year served, Pantawid status, and demographic profile.</p>
          <p className="mt-1 text-xs text-[#64748B]">Click any count to view source records. Export downloads the currently visible filtered data.</p>
        </div>
        <button type="button" onClick={() => downloadMainTableCsv(groupedRows, totalRow, "pantawid-served-main-table.csv")} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#064E3B] px-3 py-2 text-sm font-semibold text-white hover:bg-[#047857]">
          <Download size={16} /> Export filtered
        </button>
      </div>

      {personalRows.length === 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">Personal Module source rows are not loaded.</div>
      )}

      <div className="rounded-xl border border-[#D8E6E1] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Filters</p>
            <p className="mt-1 text-xs text-[#64748B]">Use filters to narrow the report.</p>
          </div>
          <button type="button" onClick={() => setShowFilters((value) => !value)} className="rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#F0FDF4]">
            {showFilters ? "Hide Filters" : "Show Filters"}
          </button>
        </div>
        <div className={`${showFilters ? "grid" : "hidden"} mt-3 gap-3 md:grid md:grid-cols-2 xl:grid-cols-5`}>
          <FilterSelect label="Municipality" value={filters.municipality} options={options.municipalities} onChange={(value) => setFilters((current) => ({ ...current, municipality: value }))} />
          <FilterSelect label="Year Served" value={filters.yearServed} options={options.years} onChange={(value) => setFilters((current) => ({ ...current, yearServed: value }))} />
          <FilterSelect label="Pantawid Status" value={filters.pantawidStatus} options={["All", "Pantawid", "Non-Pantawid", "Unknown"]} onChange={(value) => setFilters((current) => ({ ...current, pantawidStatus: value }))} />
          <FilterSelect label="Sex" value={filters.sex} options={options.sex} onChange={(value) => setFilters((current) => ({ ...current, sex: value }))} />
          <FilterSelect label="Gender" value={filters.gender} options={options.gender} onChange={(value) => setFilters((current) => ({ ...current, gender: value }))} />
          <FilterSelect label="Civil Status" value={filters.civilStatus} options={options.civilStatus} onChange={(value) => setFilters((current) => ({ ...current, civilStatus: value }))} />
          <FilterSelect label="Sector" value={filters.sector} options={options.sector} onChange={(value) => setFilters((current) => ({ ...current, sector: value }))} />
          <FilterSelect label="IP Group Name" value={filters.ipGroupName} options={options.ipGroupName} onChange={(value) => setFilters((current) => ({ ...current, ipGroupName: value }))} />
          <FilterSelect label="Is PWD" value={filters.isPwd} options={options.isPwd} onChange={(value) => setFilters((current) => ({ ...current, isPwd: value }))} />
          <FilterSelect label="Disability" value={filters.disability} options={options.disability} onChange={(value) => setFilters((current) => ({ ...current, disability: value }))} />
          <FilterSelect label="HEA" value={filters.hea} options={options.hea} onChange={(value) => setFilters((current) => ({ ...current, hea: value }))} />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <SummaryCard label="Total Served" value={summary.totalServed} onClick={() => openDetail("Total Served", filteredParticipants)} />
        <SummaryCard label="Pantawid Served" value={summary.pantawidServed} onClick={() => openDetail("Pantawid Served", filteredParticipants.filter((item) => item.pantawidStatus === "Pantawid"))} />
        <SummaryCard label="Non-Pantawid Served" value={summary.nonPantawidServed} onClick={() => openDetail("Non-Pantawid Served", filteredParticipants.filter((item) => item.pantawidStatus === "Non-Pantawid"))} />
        <SummaryCard label="PWD Served" value={summary.pwdServed} onClick={() => openDetail("PWD Served", filteredParticipants.filter(isPwdParticipant))} />
        <SummaryCard label="IP Served" value={summary.ipServed} onClick={() => openDetail("IP Served", filteredParticipants.filter(isIpParticipant))} />
      </div>
      {summary.unknownPantawidStatus > 0 && (
        <button type="button" onClick={() => openDetail("Unknown Pantawid Status", filteredParticipants.filter((item) => item.pantawidStatus === "Unknown"))} className="w-full rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-left text-sm font-semibold text-amber-800 hover:bg-amber-100">
          Some records have blank or invalid Is Pantawid? values. Click to view {summary.unknownPantawidStatus.toLocaleString()} record(s).
        </button>
      )}

      <SlpaMemberDemographicsSection
        filters={slpaFilters}
        setFilters={setSlpaFilters}
        options={slpaOptions}
        members={filteredSlpaMembers}
        summary={slpaSummary}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Pantawid vs Non-Pantawid by Municipality">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={charts.byMunicipality} margin={{ left: 0, right: 12, top: 8, bottom: 36 }}>
              <XAxis dataKey="municipality" angle={-25} textAnchor="end" interval={0} tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="Pantawid" fill="#047857" radius={[5, 5, 0, 0]} />
              <Bar dataKey="Non-Pantawid" fill="#F59E0B" radius={[5, 5, 0, 0]} />
              <Bar dataKey="Unknown" fill="#94A3B8" radius={[5, 5, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Pantawid Served by Year Served">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={charts.byYear} margin={{ left: 0, right: 12, top: 8, bottom: 28 }}>
              <XAxis dataKey="yearServed" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="Pantawid" fill="#047857" radius={[5, 5, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <DistributionChart title="Civil Status Chart" data={distributions.civilStatus} />
        <DistributionChart title="HEA Chart" data={distributions.hea} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Sex / Gender Distribution">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={charts.sexGender} dataKey="value" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={2}>
                {charts.sexGender.map((entry, index) => <Cell key={entry.name} fill={chartColors[index % chartColors.length]} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="PWD and IP Distribution">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={charts.pwdIp} margin={{ left: 0, right: 12, top: 8, bottom: 8 }}>
              <XAxis dataKey="name" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="value" fill="#047857" radius={[5, 5, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <DistributionSection title="Civil Status Distribution" labelHeader="Civil Status" rows={distributions.civilStatus} onOpen={openDetail} />
        <DistributionSection title="Highest Educational Attainment Distribution" labelHeader="HEA" rows={distributions.hea} onOpen={openDetail} />
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Other Demographic Distribution</p>
          <p className="mt-1 text-sm text-[#64748B]">Counts below respect the active report filters.</p>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <DistributionSection title="Sex Distribution" labelHeader="Category" rows={distributions.sex} onOpen={openDetail} />
          <DistributionSection title="Gender Distribution" labelHeader="Category" rows={distributions.gender} onOpen={openDetail} />
          <DistributionSection title="Sector Distribution" labelHeader="Category" rows={distributions.sector} onOpen={openDetail} />
          <DistributionSection title="IP Group Name Distribution" labelHeader="Category" rows={distributions.ipGroupName} onOpen={openDetail} />
          <DistributionSection title="Is PWD Distribution" labelHeader="Category" rows={distributions.isPwd} onOpen={openDetail} />
          <DistributionSection title="Disability Distribution" labelHeader="Category" rows={distributions.disability} onOpen={openDetail} />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[#D8E6E1] bg-white shadow-sm">
        <div className="border-b border-[#D8E6E1] p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Grouped by Municipality and Year Served</p>
          <h4 className="mt-1 text-lg font-bold text-[#064E3B]">Pantawid Served Main Table</h4>
        </div>
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full text-sm" style={{ minWidth: 1500 }}>
            <thead className="sticky top-0 z-10 bg-[#F0FDF4] text-left text-xs uppercase tracking-wide text-[#064E3B]">
              <tr>
                {mainTableColumns.map((header) => <th key={header} className="p-3">{header}</th>)}
              </tr>
            </thead>
            <tbody>
              {visibleGroupedRows.length ? (
                <>
                  {visibleGroupedRows.map((row) => (
                    <tr key={`${row.municipality}-${row.yearServed}`} className="border-t border-[#D8E6E1]">
                      <td className="p-3 font-semibold text-[#0F172A]">{row.municipality}</td>
                      <td className="p-3 text-[#334155]">{row.yearServed}</td>
                      <CountCell value={row.totalServed} onClick={() => openDetail(`${row.municipality} ${row.yearServed} Total Served`, row.records)} />
                      <CountCell value={row.pantawidServed} onClick={() => openDetail(`${row.municipality} ${row.yearServed} Pantawid Served`, row.records.filter((item) => item.pantawidStatus === "Pantawid"))} />
                      <CountCell value={row.nonPantawidServed} onClick={() => openDetail(`${row.municipality} ${row.yearServed} Non-Pantawid Served`, row.records.filter((item) => item.pantawidStatus === "Non-Pantawid"))} />
                      <CountCell value={row.unknownPantawidStatus} onClick={() => openDetail(`${row.municipality} ${row.yearServed} Unknown Pantawid Status`, row.records.filter((item) => item.pantawidStatus === "Unknown"))} />
                      <CountCell value={row.male} onClick={() => openDetail(`${row.municipality} ${row.yearServed} Male`, row.records.filter(isMaleParticipant))} />
                      <CountCell value={row.female} onClick={() => openDetail(`${row.municipality} ${row.yearServed} Female`, row.records.filter(isFemaleParticipant))} />
                      <CountCell value={row.pwd} onClick={() => openDetail(`${row.municipality} ${row.yearServed} PWD`, row.records.filter(isPwdParticipant))} />
                      <CountCell value={row.ip} onClick={() => openDetail(`${row.municipality} ${row.yearServed} IP`, row.records.filter(isIpParticipant))} />
                      <CountCell value={row.soloParent} onClick={() => openDetail(`${row.municipality} ${row.yearServed} Solo Parent`, row.records.filter(isSoloParentParticipant))} />
                      <CountCell value={row.youth} onClick={() => openDetail(`${row.municipality} ${row.yearServed} Youth`, row.records.filter(isYouthParticipant))} />
                      <CountCell value={row.seniorCitizen} onClick={() => openDetail(`${row.municipality} ${row.yearServed} Senior Citizen`, row.records.filter(isSeniorCitizenParticipant))} />
                      <td className="p-3 text-[#334155]">{row.topSector}</td>
                      <td className="p-3 text-[#334155]">{row.topCivilStatus}</td>
                      <td className="p-3 text-[#334155]">{row.topHea}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-[#86EFAC] bg-[#F0FDF4] font-bold text-[#064E3B]">
                    <td className="p-3">{totalRow.municipality}</td>
                    <td className="p-3">{totalRow.yearServed}</td>
                    <TotalCell value={totalRow.totalServed} />
                    <TotalCell value={totalRow.pantawidServed} />
                    <TotalCell value={totalRow.nonPantawidServed} />
                    <TotalCell value={totalRow.unknownPantawidStatus} />
                    <TotalCell value={totalRow.male} />
                    <TotalCell value={totalRow.female} />
                    <TotalCell value={totalRow.pwd} />
                    <TotalCell value={totalRow.ip} />
                    <TotalCell value={totalRow.soloParent} />
                    <TotalCell value={totalRow.youth} />
                    <TotalCell value={totalRow.seniorCitizen} />
                    <td className="p-3">{totalRow.topSector}</td>
                    <td className="p-3">{totalRow.topCivilStatus}</td>
                    <td className="p-3">{totalRow.topHea}</td>
                  </tr>
                </>
              ) : (
                <tr><td colSpan={mainTableColumns.length} className="p-6 text-center text-sm text-[#64748B]">No participant records match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {groupedRows.length > visibleGroupedRows.length && (
          <div className="border-t border-[#D8E6E1] p-3 text-center">
            <button type="button" onClick={() => setMainRowLimit((value) => value + 100)} className="rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#F0FDF4]">
              Show more rows ({visibleGroupedRows.length.toLocaleString()} of {groupedRows.length.toLocaleString()})
            </button>
          </div>
        )}
      </div>

      {detail && (
        <div className="rounded-xl border border-[#D8E6E1] bg-[#F8FAFC] p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h4 className="text-lg font-bold text-[#064E3B]">{detail.title}</h4>
              <p className="text-sm text-[#64748B]">Showing {pagedDetailRecords.length.toLocaleString()} of {visibleDetailRecords.length.toLocaleString()} participant records</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => downloadParticipantsCsv(pagedDetailRecords, `${filenamePart(detail.title)}.csv`)} className="inline-flex items-center gap-2 rounded-lg bg-[#064E3B] px-3 py-2 text-sm font-semibold text-white hover:bg-[#047857]">
                <Download size={16} /> Download CSV
              </button>
              <button type="button" onClick={() => copyParticipants(pagedDetailRecords)} className="inline-flex items-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#F0FDF4]">
                <Clipboard size={16} /> Copy Table
              </button>
              <button type="button" onClick={() => setDetail(null)} className="inline-flex items-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#F0FDF4]">
                <X size={16} /> Close
              </button>
            </div>
          </div>
          <input value={detailSearch} onChange={(event) => setDetailSearch(event.target.value)} placeholder="Search participant records..." className="mt-3 w-full rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm outline-none focus:border-[#047857] focus:ring-2 focus:ring-[#047857]/20" />
          <div className="mt-3 max-h-[460px] overflow-auto rounded-xl border border-[#D8E6E1] bg-white">
            <table className="w-full text-sm" style={{ minWidth: 1240 }}>
              <thead className="sticky top-0 bg-[#F0FDF4] text-left text-xs uppercase tracking-wide text-[#064E3B]">
                <tr>{detailColumns.map((column) => <th key={column} className="p-3">{column}</th>)}</tr>
              </thead>
              <tbody>
                {pagedDetailRecords.length ? pagedDetailRecords.map((row) => (
                  <tr key={row.key} className="border-t border-[#D8E6E1]">
                    {participantCsvRow(row).map((cell, index) => <td key={`${row.key}-${detailColumns[index]}`} className="p-3 text-[#334155]">{cell || "Not Found"}</td>)}
                  </tr>
                )) : (
                  <tr><td colSpan={detailColumns.length} className="p-6 text-center text-sm text-[#64748B]">No participant records found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {visibleDetailRecords.length > pagedDetailRecords.length && (
            <div className="mt-3 text-center">
              <button type="button" onClick={() => setDetailRowLimit((value) => value + 100)} className="rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#F0FDF4]">
                Show more records ({pagedDetailRecords.length.toLocaleString()} of {visibleDetailRecords.length.toLocaleString()})
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SlpaMemberDemographicsSection({
  filters,
  setFilters,
  options,
  members,
  summary,
}: {
  filters: Record<string, string>;
  setFilters: Dispatch<SetStateAction<any>>;
  options: SlpaFilterOptions;
  members: SlpaMember[];
  summary: ReturnType<typeof summarizeSlpaMembers>;
}) {
  const sexChart = [
    { name: "Male", value: summary.male },
    { name: "Female", value: summary.female },
  ];
  const pantawidChart = [
    { name: "Pantawid", value: summary.pantawid },
    { name: "Non-Pantawid", value: summary.nonPantawid },
  ];
  const pantawidSexCounts = summarizePantawidBySex(members);
  const showPantawidSeries = filters.pantawidStatus !== "Non-Pantawid";
  const showNonPantawidSeries = filters.pantawidStatus !== "Pantawid";
  const pantawidBySexRows = (filters.sex === "Male" ? ["Male"] : filters.sex === "Female" ? ["Female"] : ["Male", "Female"]).map((sex) => ({
    sex,
    Pantawid: sex === "Male" ? pantawidSexCounts.malePantawid : pantawidSexCounts.femalePantawid,
    "Non-Pantawid": sex === "Male" ? pantawidSexCounts.maleNonPantawid : pantawidSexCounts.femaleNonPantawid,
  }));
  const pantawidBySexVisibleTotal = pantawidBySexRows.reduce((total, row) => (
    total
    + (showPantawidSeries ? row.Pantawid : 0)
    + (showNonPantawidSeries ? row["Non-Pantawid"] : 0)
  ), 0);
  return (
    <section className="space-y-4 rounded-xl border border-[#D8E6E1] bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">SLPA Member Demographics</p>
          <h4 className="mt-1 text-xl font-bold text-[#064E3B]">Association Member Profile</h4>
          <p className="mt-1 max-w-3xl text-sm text-[#64748B]">Select a municipality and SLPA to inspect member names, sex, Pantawid status, and Household ID where available.</p>
        </div>
        <button type="button" onClick={() => downloadSlpaMembersCsv(members, "slpa-member-demographics.csv")} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#064E3B] px-3 py-2 text-sm font-semibold text-white hover:bg-[#047857]">
          <Download size={16} /> Export selected SLPA member list
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <FilterSelect label="Municipality" value={filters.municipality} options={options.municipalities} onChange={(value) => setFilters((current: any) => ({ ...current, municipality: value, slpaName: "All", barangay: "All" }))} />
        <FilterSelect label="SLPA Name" value={filters.slpaName} options={options.slpaNames} onChange={(value) => setFilters((current: any) => ({ ...current, slpaName: value, barangay: "All" }))} />
        <FilterSelect label="Barangay" value={filters.barangay} options={options.barangays} onChange={(value) => setFilters((current: any) => ({ ...current, barangay: value }))} />
        <FilterSelect label="Sex" value={filters.sex} options={["All", "Male", "Female"]} onChange={(value) => setFilters((current: any) => ({ ...current, sex: value }))} />
        <FilterSelect label="Pantawid Status" value={filters.pantawidStatus} options={["All", "Pantawid", "Non-Pantawid"]} onChange={(value) => setFilters((current: any) => ({ ...current, pantawidStatus: value }))} />
        <FilterSelect label="Sector" value={filters.sector} options={options.sectors} onChange={(value) => setFilters((current: any) => ({ ...current, sector: value }))} />
      </div>
      <div className="max-h-64 overflow-auto rounded-lg border border-[#D8E6E1] bg-white text-xs">
        <table className="w-full min-w-[980px] text-left">
          <thead className="sticky top-0 bg-[#F0FDF4] uppercase tracking-wide text-[#064E3B]">
            <tr>
              {["Project SLP Participant ID", "Project Full Name", "Project Municipality", "Project Barangay", "Matched Personal ID", "Match Method", "Match Confidence", "Personal Sex", "Personal Is Pantawid", "Personal Household ID"].map((header) => <th key={header} className="p-2">{header}</th>)}
            </tr>
          </thead>
          <tbody>
            {members.slice(0, 50).map((member) => (
              <tr key={`${member.key}-debug`} className="border-t border-[#D8E6E1]">
                <td className="p-2">{member.projectParticipantId || "Not encoded"}</td>
                <td className="p-2">{member.projectFullName || member.fullName || "Not encoded"}</td>
                <td className="p-2">{member.municipality || "Not encoded"}</td>
                <td className="p-2">{member.barangay || "Not encoded"}</td>
                <td className="p-2">{member.personal?.["SLP Participant ID"] || member.personal?.["SLP Paricipant ID"] || member.participantId || "Not matched"}</td>
                <td className="p-2">{member.matchMethod || "Not Matched"}</td>
                <td className="p-2">{member.personalMatchConfidence || "Not Matched"}</td>
                <td className="p-2">{member.personal?.Sex || "Not matched"}</td>
                <td className="p-2">{member.personal?.["Is Pantawid"] || member.personal?.["Is Pantawid?"] || "Not matched"}</td>
                <td className="p-2">{member.personal?.["Household ID"] || "Not encoded"}</td>
              </tr>
            ))}
            {!members.length && (
              <tr><td colSpan={10} className="p-3 text-center text-[#64748B]">No selected SLPA member rows.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <input
        value={filters.search}
        onChange={(event) => setFilters((current: any) => ({ ...current, search: event.target.value }))}
        placeholder="Search member name..."
        className="w-full rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm outline-none focus:border-[#047857] focus:ring-2 focus:ring-[#047857]/20"
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <SummaryBox label="Total Members" value={summary.totalMembers} />
        <SummaryBox label="Male" value={summary.male} />
        <SummaryBox label="Female" value={summary.female} />
        <SummaryBox label="Pantawid" value={summary.pantawid} />
        <SummaryBox label="Non-Pantawid" value={summary.nonPantawid} />
        <SummaryBox label="Personal Record Not Matched" value={summary.personalRecordNotMatched} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Sex Distribution">
          {members.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={sexChart} dataKey="value" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={2}>
                  {sexChart.map((entry, index) => <Cell key={entry.name} fill={chartColors[index % chartColors.length]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : <EmptySlpaMessage />}
        </ChartCard>
        <ChartCard title="Pantawid Distribution">
          {members.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pantawidChart} dataKey="value" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={2}>
                  {pantawidChart.map((entry, index) => <Cell key={entry.name} fill={chartColors[index % chartColors.length]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : <EmptySlpaMessage />}
        </ChartCard>
      </div>

      <div className="grid gap-4">
        <ChartCard title="Pantawid by Sex">
          {pantawidBySexVisibleTotal > 0 ? (
            <div className="flex h-full flex-col gap-3">
              <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <SummaryBox label="Male Pantawid" value={pantawidSexCounts.malePantawid} />
                <SummaryBox label="Male Non-Pantawid" value={pantawidSexCounts.maleNonPantawid} />
                <SummaryBox label="Female Pantawid" value={pantawidSexCounts.femalePantawid} />
                <SummaryBox label="Female Non-Pantawid" value={pantawidSexCounts.femaleNonPantawid} />
              </div>
              <div className="min-h-0 flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={pantawidBySexRows} margin={{ left: 0, right: 12, top: 8, bottom: 8 }}>
                    <XAxis dataKey="sex" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    {showPantawidSeries && <Bar dataKey="Pantawid" fill="#047857" radius={[6, 6, 0, 0]} />}
                    {showNonPantawidSeries && <Bar dataKey="Non-Pantawid" fill="#0F766E" radius={[6, 6, 0, 0]} />}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center rounded-lg bg-[#F8FAFC] text-center text-sm font-semibold text-[#64748B]">
              No matched Personal Module records available for Pantawid by Sex.
            </div>
          )}
        </ChartCard>
      </div>

      {members.length === 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
          No member records found for this SLPA. Check SLP Participant ID, Grant Code, or SLPA Name matching.
        </div>
      )}

      <div className="max-h-[520px] overflow-auto rounded-xl border border-[#D8E6E1]">
        <table className="w-full text-sm" style={{ minWidth: 1180 }}>
          <thead className="sticky top-0 z-10 bg-[#F0FDF4] text-left text-xs uppercase tracking-wide text-[#064E3B]">
            <tr>{slpaMemberColumns.map((column) => <th key={column} className="p-3">{column}</th>)}</tr>
          </thead>
          <tbody>
            {members.length ? members.map((member) => (
              <tr key={member.key} className="border-t border-[#D8E6E1] hover:bg-[#F8FAFC]">
                {slpaMemberCsvRow(member).map((cell, index) => <td key={`${member.key}-${slpaMemberColumns[index]}`} className="p-3 text-[#334155]">{cell || "Not Found"}</td>)}
              </tr>
            )) : (
              <tr><td colSpan={slpaMemberColumns.length} className="p-6 text-center text-sm text-[#64748B]">No member records found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SummaryBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[#D8E6E1] bg-[#F8FAFC] p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{label}</p>
      <p className="mt-1 text-2xl font-bold text-[#064E3B]">{value.toLocaleString()}</p>
    </div>
  );
}

function EmptySlpaMessage() {
  return <div className="flex h-full items-center justify-center rounded-lg bg-[#F8FAFC] text-center text-sm font-semibold text-[#64748B]">No member records found for this SLPA.</div>;
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="text-sm">
      <span className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm text-[#334155]">
        {options.map((option) => <option key={`${label}-${option}`} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function SummaryCard({ label, value, onClick }: { label: string; value: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-xl border border-[#D8E6E1] bg-white p-4 text-left shadow-sm hover:border-[#047857] hover:bg-[#F0FDF4]">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{label}</p>
      <p className="mt-2 text-3xl font-bold text-[#064E3B]">{value.toLocaleString()}</p>
    </button>
  );
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#D8E6E1] bg-white p-4 shadow-sm">
      <h4 className="mb-3 text-sm font-bold uppercase tracking-wide text-[#064E3B]">{title}</h4>
      <div className="h-72 min-h-[280px]">{children}</div>
    </div>
  );
}

function CountCell({ value, onClick }: { value: number; onClick: () => void }) {
  return (
    <td className="p-3">
      <button type="button" onClick={onClick} className="rounded-md px-1 py-1 font-semibold text-[#047857] hover:bg-[#ECFDF5] hover:underline">
        {value.toLocaleString()}
      </button>
    </td>
  );
}

function TotalCell({ value }: { value: number }) {
  return <td className="p-3">{value.toLocaleString()}</td>;
}

function DistributionSection({
  title,
  labelHeader,
  rows,
  onOpen,
}: {
  title: string;
  labelHeader: string;
  rows: DistributionRow[];
  onOpen: (title: string, records: Participant[]) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#D8E6E1] bg-white shadow-sm">
      <div className="border-b border-[#D8E6E1] p-4">
        <h4 className="text-sm font-bold uppercase tracking-wide text-[#064E3B]">{title}</h4>
      </div>
      <div className="max-h-[420px] overflow-auto">
        <table className="w-full text-sm" style={{ minWidth: 520 }}>
          <thead className="sticky top-0 bg-[#F0FDF4] text-left text-xs uppercase tracking-wide text-[#064E3B]">
            <tr>
              <th className="p-3">{labelHeader}</th>
              <th className="p-3">Count</th>
              <th className="p-3">Percentage</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr key={`${title}-${row.label}`} className="border-t border-[#D8E6E1]">
                <td className="p-3 font-semibold text-[#0F172A]">{row.label}</td>
                <td className="p-3">
                  <button type="button" onClick={() => onOpen(`${title}: ${row.label}`, row.records)} className="rounded-md px-1 py-1 font-semibold text-[#047857] hover:bg-[#ECFDF5] hover:underline">
                    {row.count.toLocaleString()}
                  </button>
                </td>
                <td className="p-3 text-[#334155]">{row.percentage.toFixed(1)}%</td>
              </tr>
            )) : (
              <tr><td colSpan={3} className="p-4 text-sm text-[#64748B]">No records available.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DistributionChart({ title, data }: { title: string; data: DistributionRow[] }) {
  return (
    <ChartCard title={title}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data.slice(0, 10)} layout="vertical" margin={{ left: 24, right: 16, top: 8, bottom: 8 }}>
          <XAxis type="number" allowDecimals={false} />
          <YAxis type="category" dataKey="label" width={150} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Bar dataKey="count" fill="#0F766E" radius={[0, 5, 5, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeValue(value: unknown) {
  return normalizeText(value).replace(/\s+/g, " ").trim().toUpperCase();
}

function isBlankLike(value: unknown) {
  const normalized = normalizeValue(value);
  return !normalized || ["-", "N/A", "NA", "NONE", "UNKNOWN / BLANK", "UNKNOWN", "NULL", "NOT FOUND"].includes(normalized);
}

function isYes(value: unknown) {
  return normalizeValue(value) === "YES";
}

function isNo(value: unknown) {
  return normalizeValue(value) === "NO";
}

function hasRealText(value: unknown) {
  return !isBlankLike(value) && !["NO"].includes(normalizeValue(value));
}

function normalizeLookup(value: unknown) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeIdKey(value: unknown) {
  return String(value ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^'+|'+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\.0$/, "")
    .toUpperCase();
}

function normalizePersonLookup(value: unknown) {
  return normalizeText(value).replace(/,/g, " ").toUpperCase().replace(/\s+/g, " ").trim();
}

function titleCase(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (["ip", "pwd", "hea", "hs", "als", "n/a"].includes(word.toLowerCase())) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function normalizeCivilStatus(value: unknown) {
  const normalized = normalizeLookup(value);
  if (!normalized || ["blank", "none", "not found", "unknown", "n a", "na"].includes(normalized)) return "Unknown / Blank";
  if (["common law", "commonlaw", "live in", "living in"].includes(normalized)) return "Common-law";
  return titleCase(normalized);
}

function normalizeHea(value: unknown) {
  const normalized = normalizeLookup(value);
  if (!normalized || ["blank", "none", "not found", "unknown", "n a", "na"].includes(normalized)) return "Unknown / Blank";
  if (normalized.includes("high school graduate") || normalized.includes("hs graduate") || normalized.includes("4th year hs graduate") || normalized.includes("junior hs graduate")) return "High School Graduate";
  if (normalized.includes("senior high") && normalized.includes("graduate")) return "Senior High School Graduate";
  if (normalized.includes("college") && normalized.includes("graduate")) return "College Graduate";
  if (normalized.includes("college") && (normalized.includes("level") || normalized.includes("undergraduate"))) return "College Level";
  if (normalized.includes("elementary") && normalized.includes("graduate")) return "Elementary Graduate";
  if (normalized.includes("elementary") && normalized.includes("level")) return "Elementary Level";
  if (normalized.includes("high school") && normalized.includes("level")) return "High School Level";
  return titleCase(normalized);
}

function normalizeCategory(value: unknown) {
  if (isBlankLike(value)) return "Unknown / Blank";
  const normalized = normalizeLookup(value);
  return titleCase(normalized);
}

function getRowsByModule(parsedFiles: DashboardParsedFile[], aliases: string[]) {
  const normalizedAliases = aliases.map(normalizeLookup);
  return (parsedFiles || [])
    .filter((file) => {
      const haystack = normalizeLookup([file.moduleType, file.classification, file.fileName, file.originalName, file.folder, file.category, file.sourceModule, file.sourceFile].filter(Boolean).join(" "));
      return normalizedAliases.some((alias) => haystack.includes(alias));
    })
    .flatMap((file) => (file.rows || []).map((row) => ({
      ...row,
      __sourceFile: file.sourceFile || [file.folder || file.category, file.fileName || file.originalName].filter(Boolean).join(" / "),
      __headers: file.headers || Object.keys(row || {}),
    })));
}

function readCell(row: ParsedRow, aliases: string[]) {
  const headers = Array.isArray(row.__headers) && row.__headers.length ? row.__headers : Object.keys(row || {});
  const aliasNorms = aliases.map(normalizeLookup);
  const aliasCompacts = aliasNorms.map((alias) => alias.replace(/\s+/g, ""));
  const exact = headers.find((header) => {
    const normalized = normalizeLookup(header);
    return aliasNorms.includes(normalized) || aliasCompacts.includes(normalized.replace(/\s+/g, ""));
  });
  if (exact && normalizeText(row[exact])) return normalizeText(row[exact]);
  const partial = headers.find((header) => {
    const normalized = normalizeLookup(header);
    const compact = normalized.replace(/\s+/g, "");
    return aliasNorms.some((alias, index) => normalized.includes(alias) || alias.includes(normalized) || compact.includes(aliasCompacts[index]));
  });
  return partial ? normalizeText(row[partial]) : "";
}

function readExactCell(row: ParsedRow, columnName: string) {
  const headers = Array.isArray(row.__headers) && row.__headers.length ? row.__headers : Object.keys(row || {});
  const exact = headers.find((header) => normalizeLookup(header) === normalizeLookup(columnName));
  return exact ? normalizeText(row[exact]) : "";
}

function hasHeaders(headers: string[], aliases: string[]) {
  return aliases.every((alias) => headers.some((header) => {
    const left = normalizeLookup(header);
    const right = normalizeLookup(alias);
    return left === right || left.includes(right) || right.includes(left);
  }));
}

function getRowsByDetector(parsedFiles: DashboardParsedFile[], detector: (file: DashboardParsedFile, headers: string[]) => boolean) {
  return (parsedFiles || [])
    .filter((file) => detector(file, file.headers || Object.keys(file.rows?.[0] || {})))
    .flatMap((file) => (file.rows || []).map((row) => ({
      ...row,
      __sourceFile: file.sourceFile || [file.folder || file.category, file.fileName || file.originalName].filter(Boolean).join(" / "),
      __sourceModule: file.sourceModule || file.moduleType || file.classification || "",
      __headers: file.headers || Object.keys(row || {}),
    })));
}

function buildSlpaDemographicsSources(parsedFiles: DashboardParsedFile[]) {
  const personalRows = getRowsByDetector(parsedFiles, (file, headers) => {
    const label = normalizeLookup([file.folder, file.fileName, file.originalName, file.moduleType, file.classification, file.sourceModule].filter(Boolean).join(" "));
    return label.includes("personal module") || hasHeaders(headers, ["SLP Participant ID", "Last Name", "First Name", "Is Pantawid?"]);
  });
  const projectRows = getRowsByDetector(parsedFiles, (file, headers) => {
    const label = normalizeLookup([file.folder, file.fileName, file.originalName, file.moduleType, file.classification, file.sourceModule].filter(Boolean).join(" "));
    return label.includes("project module") || (
      hasHeaders(headers, ["Enterprise Type", "SLPA Name", "Municipality"])
      && hasHeaders(headers, ["SLP Participant ID"])
    ) || hasHeaders(headers, ["Project ID", "Enterprise Type", "Municipality", "Barangay"]);
  });
  const dptRows = getRowsByDetector(parsedFiles, (file, headers) => {
    const label = normalizeLookup([file.folder, file.fileName, file.originalName, file.moduleType, file.classification, file.sourceModule].filter(Boolean).join(" "));
    return label.includes("slp dpt") || label.includes("aurora database") || hasHeaders(headers, ["SLP UNIQUE ID", "Last Name", "First Name", "Fund Source"]);
  });
  return { personalRows, projectRows, dptRows };
}

function normalizedPersonKey(fullName: string, municipality: string, barangay?: string) {
  return [
    normalizePersonLookup(fullName),
    normalizeLookup(normalizeAuroraMunicipality(municipality) || municipality),
    barangay ? normalizeLookup(barangay) : "",
  ].join("|");
}

function personNameParts(row: ParsedRow) {
  return {
    lastName: readCell(row, ["Last Name", "Surname"]),
    firstName: readCell(row, ["First Name"]),
    middleName: readCell(row, ["Middle Name"]),
    extensionName: readCell(row, ["Extension Name", "Ext Name", "Name Extension"]),
  };
}

function personMatchNames(row: ParsedRow) {
  const direct = readCell(row, ["Full Name", "Name", "Participant Name"]);
  const { lastName, firstName, middleName, extensionName } = personNameParts(row);
  return Array.from(new Set([
    direct,
    [lastName, firstName, middleName, extensionName].filter(Boolean).join(" "),
    [firstName, middleName, lastName, extensionName].filter(Boolean).join(" "),
    [firstName, lastName].filter(Boolean).join(" "),
    [lastName, firstName].filter(Boolean).join(" "),
  ].map(normalizePersonLookup).filter(Boolean)));
}

function normalizeSexValue(value: unknown): SlpaMember["sex"] {
  const text = normalizeValue(value);
  if (text === "MALE" || text === "M" || text === "MAN") return "Male";
  if (text === "FEMALE" || text === "F" || text === "WOMAN") return "Female";
  return "Unknown Sex";
}

function normalizeSlpaPantawidStatus(value: unknown): SlpaMember["pantawidStatus"] {
  if (isYes(value)) return "Pantawid";
  if (isNo(value)) return "Non-Pantawid";
  return "Unknown Pantawid Status";
}

function slpaPersonalProfile(row: ParsedRow) {
  const fullName = participantName(row);
  const municipality = readCell(row, ["Municipality", "City/Municipality", "City"]);
  const normalizedMunicipality = normalizeAuroraMunicipality(municipality);
  const barangay = readCell(row, ["Barangay", "Brgy"]);
  const sex = readCell(row, ["Sex"]);
  const isPantawid = readCell(row, ["Is Pantawid", "Is Pantawid?"]);
  const householdId = readCell(row, ["Household ID"]);
  return {
    participantId: readCell(row, ["SLP Participant ID", "SLP Paricipant ID", "Participant ID"]),
    fullName,
    municipality: normalizedMunicipality || municipality,
    barangay,
    sex: normalizeSexValue(sex),
    pantawidStatus: normalizeSlpaPantawidStatus(isPantawid),
    householdId: normalizeSlpaPantawidStatus(isPantawid) === "Pantawid" ? householdId : "",
    sector: normalizeCategory(readExactCell(row, "Sector")),
    contactNumber: readCell(row, ["Contact Number", "Contact No.", "Mobile Number"]),
    sourceModule: "SLPIS Personal Module",
    sourceFile: row.__sourceFile || "Personal Module",
    matchNames: personMatchNames(row),
    personal: {
      ...row,
      Sex: sex,
      "Is Pantawid": isPantawid,
      "Is Pantawid?": isPantawid,
      "Household ID": householdId,
    },
  };
}

function buildSlpaMembers(sources: ReturnType<typeof buildSlpaDemographicsSources>) {
  const personalById = new Map<string, ReturnType<typeof slpaPersonalProfile>>();
  const personalByNamePlace = new Map<string, ReturnType<typeof slpaPersonalProfile>>();
  const personalByNameMunicipality = new Map<string, ReturnType<typeof slpaPersonalProfile>>();
  const personalByNameOnly = new Map<string, ReturnType<typeof slpaPersonalProfile>>();
  for (const row of sources.personalRows) {
    const profile = slpaPersonalProfile(row);
    if (profile.participantId) personalById.set(normalizeIdKey(profile.participantId), profile);
    for (const matchName of profile.matchNames) {
      if (matchName && profile.municipality && profile.barangay) personalByNamePlace.set(normalizedPersonKey(matchName, profile.municipality, profile.barangay), profile);
      if (matchName && profile.municipality) personalByNameMunicipality.set(normalizedPersonKey(matchName, profile.municipality), profile);
      if (matchName) personalByNameOnly.set(matchName, profile);
    }
  }

  const members = new Map<string, SlpaMember>();
  const addMember = (member: SlpaMember) => {
    const participantKey = normalizeIdKey(member.projectParticipantId || member.participantId);
    const key = participantKey
      ? `id:${participantKey}`
      : `name:${normalizePersonLookup(member.projectFullName || member.fullName)}|${normalizeLookup(member.municipality)}|${normalizeLookup(member.barangay)}`;
    if (!member.fullName || members.has(key)) return;
    members.set(key, { ...member, key });
  };
  const findPersonalProfile = (row: ParsedRow, participantId: string, fullName: string, municipality: string, barangay: string): { profile?: ReturnType<typeof slpaPersonalProfile>; confidence: SlpaMember["personalMatchConfidence"] } => {
    const byId = participantId ? personalById.get(normalizeIdKey(participantId)) : undefined;
    if (byId) return { profile: byId, confidence: "ID" };
    for (const matchName of personMatchNames(row).concat(normalizePersonLookup(fullName)).filter(Boolean)) {
      const byNameMunicipality = personalByNameMunicipality.get(normalizedPersonKey(matchName, municipality));
      if (byNameMunicipality) return { profile: byNameMunicipality, confidence: "Name + Municipality" };
      const byNamePlace = personalByNamePlace.get(normalizedPersonKey(matchName, municipality, barangay));
      if (byNamePlace) return { profile: byNamePlace, confidence: "Name + Municipality + Barangay" };
      const byNameOnly = personalByNameOnly.get(matchName);
      if (byNameOnly) return { profile: byNameOnly, confidence: "Name Only" };
    }
    return { confidence: "Not Matched" };
  };
  const memberFromProjectLikeRow = (row: ParsedRow, sourceModule: string, sourceFileFallback: string) => {
    if (!isAssociationEnterpriseType(readCell(row, ["Enterprise Type"]))) return;
    const participantId = readCell(row, ["SLP Participant ID", "SLP Paricipant ID", "Participant ID", "SLP UNIQUE ID"]);
    const fullName = participantName(row);
    const municipality = readCell(row, ["Municipality", "City/Municipality", "City"]);
    const normalizedMunicipality = normalizeAuroraMunicipality(municipality);
    const barangay = readCell(row, ["Barangay", "Brgy"]);
    const match = findPersonalProfile(row, participantId, fullName, municipality, barangay);
    const profile = match.profile;
    const matched = Boolean(profile);
    const slpaName = validSlpaName(readCell(row, ["SLPA Name"]));
    if (!slpaName || looksLikePersonName(slpaName, row)) return;
    addMember({
      key: "",
      fullName: profile?.fullName || fullName,
      sex: matched ? profile!.sex : "Not matched",
      pantawidStatus: matched ? profile!.pantawidStatus : "Not matched",
      householdId: matched ? profile!.householdId : "",
      participantId: profile?.participantId || participantId,
      slpaName,
      grantCode: readCell(row, ["Grant Code"]),
      projectId: readCell(row, ["Project ID"]),
      municipality: normalizedMunicipality || municipality || "Not Found",
      barangay: barangay || profile?.barangay || "Not Found",
      sector: profile?.sector || normalizeCategory(readCell(row, ["Sector", "Type of participants"])),
      contactNumber: profile?.contactNumber || "",
      sourceModule,
      sourceFile: row.__sourceFile || sourceFileFallback,
      personalMatchStatus: matched ? "Matched to Personal Module" : "Personal Record Not Matched",
      sexSource: matched ? "Personal Module" : "Personal Record Not Matched",
      pantawidSource: matched ? "Personal Module" : "Personal Record Not Matched",
      personal: profile?.personal,
      personalMatchConfidence: match.confidence,
      matchMethod: match.confidence || "Not Matched",
      projectFullName: fullName,
      projectParticipantId: participantId,
    });
  };

  for (const row of sources.projectRows) {
    memberFromProjectLikeRow(row, "SLPIS Project Module", "Project Module");
  }

  return Array.from(members.values()).sort((a, b) => a.municipality.localeCompare(b.municipality) || a.slpaName.localeCompare(b.slpaName) || a.fullName.localeCompare(b.fullName));
}

function validSlpaName(value: unknown) {
  const text = normalizeText(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (isBlankLike(text) || ["NOT ENCODED", "NOT FOUND"].includes(normalizeValue(text))) return "";
  return text;
}

function slpaOptionKey(municipality: string, slpaName: string, grantCode = "", projectId = "") {
  return [municipality, normalizeLookup(slpaName), normalizeLookup(grantCode || projectId)].join("|");
}

function looksLikePersonName(value: unknown, row?: ParsedRow) {
  const text = normalizeText(value);
  const normalized = normalizePersonLookup(text);
  if (!normalized) return false;
  if (/,\s*\S/.test(text)) return true;
  if (!row) return false;
  return personMatchNames(row).includes(normalized);
}

function containsOtherMunicipalityName(slpaName: unknown, selectedMunicipality: string) {
  const selected = normalizeAuroraMunicipality(selectedMunicipality);
  if (!selected) return false;
  const name = normalizeValue(slpaName);
  return AURORA_MUNICIPALITIES
    .filter((municipality) => municipality !== selected)
    .some((municipality) => name.includes(normalizeValue(municipality)));
}

function isAssociationEnterpriseType(value: unknown) {
  const enterpriseType = normalizeLookup(value);
  return enterpriseType.includes("association") || enterpriseType.includes("slpa");
}

function isAssociationProjectRow(row: ParsedRow) {
  const slpaName = validSlpaName(readCell(row, ["SLPA Name"]));
  return Boolean(slpaName)
    && isAssociationEnterpriseType(readCell(row, ["Enterprise Type"]))
    && !looksLikePersonName(slpaName, row);
}

function buildSlpaOptions(projectRows: ParsedRow[], selectedMunicipality: string) {
  const normalizedSelectedMunicipality = normalizeAuroraMunicipality(selectedMunicipality) || "All";
  const projectRowsInMunicipality = projectRows.filter((row) => {
    const municipality = normalizeAuroraMunicipality(readCell(row, ["Municipality", "City/Municipality", "City"]));
    return municipality && (normalizedSelectedMunicipality === "All" || municipality === normalizedSelectedMunicipality);
  });
  const rowsWithState = projectRowsInMunicipality
    .map((row) => {
      const municipality = normalizeAuroraMunicipality(readCell(row, ["Municipality", "City/Municipality", "City"]));
      const slpaName = validSlpaName(readCell(row, ["SLPA Name"]));
      const personName = looksLikePersonName(slpaName, row);
      const otherMunicipalityName = normalizedSelectedMunicipality !== "All" && containsOtherMunicipalityName(slpaName, normalizedSelectedMunicipality);
      const association = isAssociationProjectRow(row);
      return {
        municipality,
        slpaName,
        grantCode: readCell(row, ["Grant Code"]),
        projectId: readCell(row, ["Project ID"]),
        association,
        personName,
        otherMunicipalityName,
      };
    });
  const excludedPersonNameOptions = rowsWithState.filter((row) => row.slpaName && row.personName).map((row) => row.slpaName);
  const associationRows = rowsWithState.filter((row) => row.municipality && row.slpaName && row.association && !row.personName && !row.otherMunicipalityName);
  const excludedIndividualRows = rowsWithState.length - associationRows.length;
  const deduped = Array.from(new Map(associationRows.map((row) => [
    normalizeLookup(row.slpaName),
    row,
  ])).values()).sort((a, b) => a.slpaName.localeCompare(b.slpaName));
  const optionCandidates = deduped.map((row) => ({
      label: row.slpaName,
      value: row.slpaName,
      municipality: row.municipality || "",
      grantCode: row.grantCode,
      projectId: row.projectId,
    }));
  const invalidOptions = optionCandidates.filter((option) => normalizedSelectedMunicipality !== "All" && option.municipality !== normalizedSelectedMunicipality);
  if (invalidOptions.length) {
    console.warn("SLPA_STRICT_INVALID_OPTIONS_REMOVED", invalidOptions);
  }
  const strictOptions = optionCandidates.filter((option) => normalizedSelectedMunicipality === "All" || option.municipality === normalizedSelectedMunicipality);
  return {
    selectedMunicipality,
    normalizedSelectedMunicipality,
    projectRows,
    projectRowsInMunicipality,
    associationRows,
    excludedIndividualRows,
    excludedPersonNameOptions,
    invalidOptions,
    slpaOptions: [
      { label: "All", value: "All", municipality: "", grantCode: "", projectId: "" },
      ...strictOptions,
    ],
  };
}

function buildSlpaFilterOptions(members: SlpaMember[], sources: ReturnType<typeof buildSlpaDemographicsSources>, filters: Record<string, string>): SlpaFilterOptions {
  const options = (values: string[]) => ["All", ...Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b))];
  const dropdown = buildSlpaOptions(sources.projectRows, filters.municipality);
  const actualSlpaOptions = dropdown.slpaOptions.filter((item) => item.value !== "All");
  const validSlpaKeys = actualSlpaOptions.map((item) => slpaOptionKey(item.municipality, item.value, item.grantCode, item.projectId));
  const validSlpaNames = actualSlpaOptions.map((item) => normalizeLookup(item.value));
  const scopedMembers = members.filter((member) => (
    matchMunicipalityFilter(member.municipality, filters.municipality)
    && matchFilter(member.slpaName, filters.slpaName)
    && validSlpaNames.includes(normalizeLookup(member.slpaName))
  ));
  return {
    municipalities: ["All", ...AURORA_MUNICIPALITIES],
    slpaNames: dropdown.slpaOptions.map((item) => item.label),
    barangays: options(scopedMembers.map((item) => item.barangay)),
    sectors: options(members.map((item) => item.sector)),
    validSlpaKeys,
    validSlpaNames,
    debug: {
      selectedMunicipality: dropdown.selectedMunicipality,
      normalizedSelectedMunicipality: dropdown.normalizedSelectedMunicipality,
      totalProjectRows: dropdown.projectRows.length,
      projectRowsInMunicipality: dropdown.projectRowsInMunicipality.length,
      associationRows: dropdown.associationRows.length,
      excludedIndividualRows: dropdown.excludedIndividualRows,
      excludedPersonNameOptions: dropdown.excludedPersonNameOptions,
      finalSlpaOptionsCount: actualSlpaOptions.length,
      finalSlpaOptionsSample: actualSlpaOptions.slice(0, 20),
      personNamesFoundInDropdown: actualSlpaOptions.filter((item) => looksLikePersonName(item.label)).slice(0, 20),
      municipalitiesInOptions: Array.from(new Set(actualSlpaOptions.map((item) => item.municipality))).sort((a, b) => a.localeCompare(b)),
      invalidOptions: dropdown.invalidOptions,
      enterpriseTypeSamples: Array.from(new Set(sources.projectRows.map((row) => readCell(row, ["Enterprise Type"])).filter(Boolean))).slice(0, 30),
      invalidOptionsRemovedCount: dropdown.invalidOptions.length,
      selectedSlpaProjectRows: scopedMembers.length,
      uniqueMemberCount: scopedMembers.length,
    },
  };
}

function filterSlpaMembers(members: SlpaMember[], filters: Record<string, string>, _target?: SlpaDemographicsTarget | null, validSlpaKeys: string[] = [], validSlpaNames: string[] = []) {
  const search = normalizeLookup(filters.search || "");
  return members.filter((member) => (
    (validSlpaNames.length ? validSlpaNames.includes(normalizeLookup(member.slpaName)) : validSlpaKeys.includes(slpaOptionKey(normalizeAuroraMunicipality(member.municipality) || "", member.slpaName, member.grantCode, member.projectId)))
    && matchMunicipalityFilter(member.municipality, filters.municipality)
    && matchFilter(member.slpaName, filters.slpaName)
    && matchFilter(member.barangay, filters.barangay)
    && (filters.sex === "All" || member.sex === filters.sex)
    && (filters.pantawidStatus === "All" || member.pantawidStatus === filters.pantawidStatus)
    && matchFilter(member.sector, filters.sector)
    && (!search || normalizeLookup(member.fullName).includes(search))
  ));
}

function summarizeSlpaMembers(members: SlpaMember[]) {
  return {
    totalMembers: members.length,
    male: members.filter((item) => item.sex === "Male").length,
    female: members.filter((item) => item.sex === "Female").length,
    unknownSex: members.filter((item) => item.sex === "Unknown Sex").length,
    pantawid: members.filter((item) => item.pantawidStatus === "Pantawid").length,
    nonPantawid: members.filter((item) => item.pantawidStatus === "Non-Pantawid").length,
    unknownPantawidStatus: members.filter((item) => item.pantawidStatus === "Unknown Pantawid Status").length,
    personalRecordNotMatched: members.filter((item) => item.personalMatchStatus === "Personal Record Not Matched").length,
  };
}

function summarizePantawidBySex(members: SlpaMember[]) {
  const matchedPersonalMembers = members.filter((item) => item.personalMatchStatus === "Matched to Personal Module");
  return {
    matchedPersonalMembers: matchedPersonalMembers.length,
    malePantawid: matchedPersonalMembers.filter((item) => item.sex === "Male" && item.pantawidStatus === "Pantawid").length,
    maleNonPantawid: matchedPersonalMembers.filter((item) => item.sex === "Male" && item.pantawidStatus === "Non-Pantawid").length,
    femalePantawid: matchedPersonalMembers.filter((item) => item.sex === "Female" && item.pantawidStatus === "Pantawid").length,
    femaleNonPantawid: matchedPersonalMembers.filter((item) => item.sex === "Female" && item.pantawidStatus === "Non-Pantawid").length,
  };
}

function participantName(row: ParsedRow) {
  const direct = readCell(row, ["Full Name", "Name", "Participant Name"]);
  if (direct) return direct;
  return [
    readCell(row, ["First Name"]),
    readCell(row, ["Middle Name"]),
    readCell(row, ["Last Name", "Surname"]),
  ].filter(Boolean).join(" ").trim();
}

function pantawidStatus(value: string): PantawidStatus {
  if (isYes(value)) return "Pantawid";
  if (isNo(value)) return "Non-Pantawid";
  return "Unknown";
}

function buildParticipants(personalRows: ParsedRow[]) {
  const byKey = new Map<string, Participant>();
  for (const row of personalRows) {
    const participantId = readCell(row, ["SLP Participant ID", "SLP Paricipant ID", "Participant ID"]);
    const fullName = participantName(row);
    const municipality = readCell(row, ["Municipality", "City/Municipality", "City"]);
    const normalizedMunicipality = normalizeAuroraMunicipality(municipality);
    const yearServed = readCell(row, ["Year Served", "Year"]);
    const key = normalizeLookup(participantId)
      ? `id:${normalizeLookup(participantId)}`
      : `name:${normalizeLookup(fullName)}:${normalizeLookup(municipality)}:${normalizeLookup(yearServed)}`;
    if (!key || byKey.has(key)) continue;
    const isPantawid = readExactCell(row, "Is Pantawid?");
    const ipGroupName = readExactCell(row, "IP Group Name");
    const isPwd = readExactCell(row, "Is PWD");
    const sex = readExactCell(row, "Sex");
    const gender = readExactCell(row, "Gender");
    const sector = readExactCell(row, "Sector");
    byKey.set(key, {
      key,
      participantId,
      fullName,
      municipality: normalizedMunicipality || municipality || "Not Found",
      barangay: readCell(row, ["Barangay", "Brgy"]) || "Not Found",
      yearServed: yearServed || "Not Found",
      pantawidStatus: pantawidStatus(isPantawid),
      isPantawid: isPantawid || "Unknown",
      sex: normalizeCategory(sex),
      gender: normalizeCategory(gender),
      civilStatus: normalizeCivilStatus(readCell(row, ["Civil Status"])),
      sector: normalizeCategory(sector),
      sectorRaw: sector,
      ipGroupName: hasRealText(ipGroupName) ? normalizeCategory(ipGroupName) : "Unknown / Blank",
      ipGroupNameRaw: ipGroupName,
      isPwd: isYes(isPwd) ? "Yes" : isNo(isPwd) || isBlankLike(isPwd) ? "No" : "Unknown / Blank",
      isPwdRaw: isPwd,
      disability: normalizeCategory(readCell(row, ["Disability"])),
      hea: normalizeHea(readCell(row, ["HEA"])),
      sourceFile: row.__sourceFile || "Personal Module",
    });
  }
  return Array.from(byKey.values());
}

function filterParticipants(participants: Participant[], filters: Record<string, string>) {
  return participants.filter((participant) => (
    matchMunicipalityFilter(participant.municipality, filters.municipality)
    && matchFilter(participant.yearServed, filters.yearServed)
    && (filters.pantawidStatus === "All" || participant.pantawidStatus === filters.pantawidStatus)
    && matchFilter(participant.sex, filters.sex)
    && matchFilter(participant.gender, filters.gender)
    && matchFilter(participant.civilStatus, filters.civilStatus)
    && matchFilter(participant.sector, filters.sector)
    && matchFilter(participant.ipGroupName, filters.ipGroupName)
    && matchFilter(participant.isPwd, filters.isPwd)
    && matchFilter(participant.disability, filters.disability)
    && matchFilter(participant.hea, filters.hea)
  ));
}

function matchFilter(value: string, filter: string) {
  return filter === "All" || normalizeLookup(value) === normalizeLookup(filter);
}

function matchMunicipalityFilter(value: string, filter: string) {
  return filter === "All" || normalizeAuroraMunicipality(value) === filter;
}

function buildFilterOptions(participants: Participant[]) {
  const options = (values: string[]) => ["All", ...Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b))];
  return {
    municipalities: ["All", ...AURORA_MUNICIPALITIES],
    years: options(participants.map((item) => item.yearServed)),
    sex: options(participants.map((item) => item.sex)),
    gender: options(participants.map((item) => item.gender)),
    civilStatus: options(participants.map((item) => item.civilStatus)),
    sector: options(participants.map((item) => item.sector)),
    ipGroupName: options(participants.map((item) => item.ipGroupName)),
    isPwd: options(participants.map((item) => item.isPwd)),
    disability: options(participants.map((item) => item.disability)),
    hea: options(participants.map((item) => item.hea)),
  };
}

function summarizeParticipants(participants: Participant[]) {
  return {
    totalServed: participants.length,
    pantawidServed: participants.filter((item) => item.pantawidStatus === "Pantawid").length,
    nonPantawidServed: participants.filter((item) => item.pantawidStatus === "Non-Pantawid").length,
    unknownPantawidStatus: participants.filter((item) => item.pantawidStatus === "Unknown").length,
    pwdServed: participants.filter(isPwdParticipant).length,
    ipServed: participants.filter(isIpParticipant).length,
  };
}

function groupByMunicipalityYear(participants: Participant[]): PantawidTableRow[] {
  const groups = new Map<string, Participant[]>();
  for (const participant of participants) {
    const municipality = normalizeAuroraMunicipality(participant.municipality) || "Invalid / Unmapped Municipality";
    const key = `${municipality}||${participant.yearServed}`;
    groups.set(key, [...(groups.get(key) || []), participant]);
  }
  return Array.from(groups.entries()).map(([key, records]) => {
    const [municipality, yearServed] = key.split("||");
    return {
      municipality,
      yearServed,
      records,
      totalServed: records.length,
      pantawidServed: records.filter((item) => item.pantawidStatus === "Pantawid").length,
      nonPantawidServed: records.filter((item) => item.pantawidStatus === "Non-Pantawid").length,
      unknownPantawidStatus: records.filter((item) => item.pantawidStatus === "Unknown").length,
      male: records.filter(isMaleParticipant).length,
      female: records.filter(isFemaleParticipant).length,
      pwd: records.filter(isPwdParticipant).length,
      ip: records.filter(isIpParticipant).length,
      soloParent: records.filter(isSoloParentParticipant).length,
      youth: records.filter(isYouthParticipant).length,
      seniorCitizen: records.filter(isSeniorCitizenParticipant).length,
      topSector: topValue(records.map((item) => item.sector)),
      topCivilStatus: topValue(records.map((item) => item.civilStatus)),
      topHea: topValue(records.map((item) => item.hea)),
    };
  }).sort((a, b) => a.municipality.localeCompare(b.municipality) || String(a.yearServed).localeCompare(String(b.yearServed)));
}

function buildTotalRow(rows: PantawidTableRow[]): PantawidTableRow {
  return {
    municipality: "TOTAL",
    yearServed: "",
    records: rows.flatMap((row) => row.records),
    totalServed: sumRows(rows, "totalServed"),
    pantawidServed: sumRows(rows, "pantawidServed"),
    nonPantawidServed: sumRows(rows, "nonPantawidServed"),
    unknownPantawidStatus: sumRows(rows, "unknownPantawidStatus"),
    male: sumRows(rows, "male"),
    female: sumRows(rows, "female"),
    pwd: sumRows(rows, "pwd"),
    ip: sumRows(rows, "ip"),
    soloParent: sumRows(rows, "soloParent"),
    youth: sumRows(rows, "youth"),
    seniorCitizen: sumRows(rows, "seniorCitizen"),
    topSector: "",
    topCivilStatus: "",
    topHea: "",
  };
}

function sumRows(rows: PantawidTableRow[], key: keyof Pick<PantawidTableRow, "totalServed" | "pantawidServed" | "nonPantawidServed" | "unknownPantawidStatus" | "male" | "female" | "pwd" | "ip" | "soloParent" | "youth" | "seniorCitizen">) {
  return rows.reduce((total, row) => total + row[key], 0);
}

function buildCharts(participants: Participant[]) {
  const byMunicipality = Array.from(groupMap(participants, (item) => normalizeAuroraMunicipality(item.municipality) || "Invalid / Unmapped Municipality").entries()).map(([municipality, records]) => ({
    municipality,
    Pantawid: records.filter((item) => item.pantawidStatus === "Pantawid").length,
    "Non-Pantawid": records.filter((item) => item.pantawidStatus === "Non-Pantawid").length,
    Unknown: records.filter((item) => item.pantawidStatus === "Unknown").length,
  }));
  const byYear = Array.from(groupMap(participants, (item) => item.yearServed).entries()).map(([yearServed, records]) => ({
    yearServed,
    Pantawid: records.filter((item) => item.pantawidStatus === "Pantawid").length,
  }));
  return {
    byMunicipality,
    byYear,
    sexGender: topChartValues(participants.map(sexGenderCategory)).map(({ name, value }) => ({ name, value })),
    sector: topChartValues(participants.map((item) => item.sector), 10).map(({ name, value }) => ({ name, value })),
    pwdIp: [
      { name: "PWD", value: participants.filter(isPwdParticipant).length },
      { name: "IP", value: participants.filter(isIpParticipant).length },
      { name: "Not PWD", value: participants.filter((item) => !isPwdParticipant(item)).length },
      { name: "Not IP", value: participants.filter((item) => !isIpParticipant(item)).length },
    ],
  };
}

function buildDistributions(participants: Participant[]) {
  return {
    civilStatus: distributionRows(participants, (item) => item.civilStatus),
    hea: distributionRows(participants, (item) => item.hea),
    sex: distributionRows(participants, (item) => item.sex),
    gender: distributionRows(participants, (item) => item.gender),
    sector: distributionRows(participants, (item) => item.sector),
    ipGroupName: distributionRows(participants, (item) => item.ipGroupName),
    isPwd: distributionRows(participants, (item) => item.isPwd),
    disability: distributionRows(participants, (item) => item.disability),
  };
}

function distributionRows(participants: Participant[], keyFn: (participant: Participant) => string): DistributionRow[] {
  const total = participants.length || 1;
  return Array.from(groupMap(participants, keyFn).entries())
    .map(([label, records]) => ({
      label,
      count: records.length,
      percentage: (records.length / total) * 100,
      records,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function groupMap<T>(items: T[], keyFn: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item) || "Unknown";
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  return groups;
}

function topValue(values: string[]) {
  return topChartValues(values, 1)[0]?.name || "Unknown";
}

function topChartValues(values: string[], limit = 8) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = value || "Unknown";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function isPwdParticipant(participant: Participant) {
  return isYes(participant.isPwdRaw);
}

function isIpParticipant(participant: Participant) {
  return hasRealText(participant.ipGroupNameRaw);
}

function sexGenderCategory(participant: Participant) {
  return !isBlankLike(participant.sex) ? participant.sex : !isBlankLike(participant.gender) ? participant.gender : "Unknown / Blank";
}

function hasSectorText(participant: Participant, sector: string) {
  return hasRealText(participant.sectorRaw) && normalizeValue(participant.sectorRaw).includes(normalizeValue(sector));
}

function isSoloParentParticipant(participant: Participant) {
  return hasSectorText(participant, "Solo Parent");
}

function isYouthParticipant(participant: Participant) {
  return hasSectorText(participant, "Youth");
}

function isSeniorCitizenParticipant(participant: Participant) {
  return hasSectorText(participant, "Senior Citizen");
}

function isMaleParticipant(participant: Participant) {
  const sex = normalizeLookup(sexGenderCategory(participant));
  return sex === "male" || sex === "m";
}

function isFemaleParticipant(participant: Participant) {
  const sex = normalizeLookup(sexGenderCategory(participant));
  return sex === "female" || sex === "f";
}

function participantCsvRow(row: Participant) {
  return [
    row.participantId,
    row.fullName,
    row.municipality,
    row.barangay,
    row.yearServed,
    row.isPantawid,
    row.civilStatus,
    row.hea,
    row.sex,
    row.gender,
    row.sector,
    row.ipGroupName,
    row.isPwd,
    row.disability,
    row.sourceFile,
  ];
}

function slpaMemberCsvRow(row: SlpaMember) {
  return [
    row.fullName,
    row.sex,
    row.pantawidStatus,
    row.householdId,
    row.participantId,
    row.municipality,
    row.barangay,
    row.sector,
    row.contactNumber,
    row.personalMatchStatus,
    row.sexSource,
    row.pantawidSource,
    row.sourceModule,
    row.sourceFile,
  ];
}

function escapeCsv(value: unknown) {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function downloadParticipantsCsv(records: Participant[], fileName: string) {
  const csv = [detailColumns, ...records.map(participantCsvRow)].map((row) => row.map(escapeCsv).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadSlpaMembersCsv(records: SlpaMember[], fileName: string) {
  const csv = [slpaMemberColumns, ...records.map(slpaMemberCsvRow)].map((row) => row.map(escapeCsv).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function mainTableCsvRow(row: PantawidTableRow) {
  return [
    row.municipality,
    row.yearServed,
    row.totalServed,
    row.pantawidServed,
    row.nonPantawidServed,
    row.unknownPantawidStatus,
    row.male,
    row.female,
    row.pwd,
    row.ip,
    row.soloParent,
    row.youth,
    row.seniorCitizen,
    row.topSector,
    row.topCivilStatus,
    row.topHea,
  ];
}

function downloadMainTableCsv(rows: PantawidTableRow[], totalRow: PantawidTableRow, fileName: string) {
  const csv = [mainTableColumns, ...rows.map(mainTableCsvRow), mainTableCsvRow(totalRow)].map((row) => row.map(escapeCsv).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function copyParticipants(records: Participant[]) {
  const text = [detailColumns, ...records.map(participantCsvRow)].map((row) => row.map((value) => String(value ?? "")).join("\t")).join("\n");
  navigator.clipboard?.writeText(text);
}

function filenamePart(value: string) {
  return value.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
