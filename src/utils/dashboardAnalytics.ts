import { API_BASE_URL, apiGetJson } from "./apiClient";

export type MunicipalityName =
  | "Baler"
  | "Casiguran"
  | "Dilasag"
  | "Dinalungan"
  | "Dingalan"
  | "Dipaculao"
  | "Maria Aurora"
  | "San Luis";

export type MonitoringCoverageStatus = "Completed" | "Missing" | "Not Applicable";
export type MonitoringCoverageRow = {
  unitKey: string;
  monitoringUnitName: string;
  municipality: MunicipalityName | "Not Found";
  barangay: string;
  type: "Individual" | "Association";
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

export type MonitoringCoverageAnalytics = {
  summary: {
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
  byMunicipality: Array<{
    municipality: MunicipalityName;
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
  debug?: {
    detectedSources: Array<{ sourceModule: string; sourceFile: string; rowsProcessed: number; keyColumns: string[] }>;
    availableFiles?: Array<{ fileName: string; detectedModuleType: string; rowCount: number; headersDetected: string[]; accepted: boolean; rejectedReason: string }>;
    apiFilesLoadedCount?: number;
    parsedFilesCount?: number;
    parsedRowsCount?: number;
    filesScanned?: number;
    headerRowUsed?: number;
    headersDetected?: Record<string, string[]>;
    rowsReadPerModule?: Record<string, number>;
    exactColumnsFound?: Record<string, Record<string, boolean>>;
    monitoringRowsBeforeFilter?: number;
    rowsProcessed: number;
    monitoringUnitsCreated: number;
    monitoringUnitsAfterMerge?: number;
    associationUnits?: number;
    individualUnits?: number;
    matchedRecords: number;
    unmatchedRecords: number;
    visitCounts: Record<string, number>;
    organizationalAssessmentCounts: number;
    annualAssessmentCounts: number;
    orgAssessmentMatches?: number;
    annualAssessmentMatches?: number;
    barangayCount?: number;
    barangayCountByMunicipality?: Record<string, number>;
    sourceProof?: Record<string, any>;
    activeFilters?: Record<string, string>;
  };
};

export type MunicipalityStat = {
  municipality: MunicipalityName;
  totalParticipants: number;
  totalAssociations: number;
  totalEnterprises: number;
  individualEnterprises: number;
  operational: number;
  closed: number;
  ongoing: number;
  inactive: number;
  encoded: number;
  notEncoded: number;
  totalVisits: number;
  topEnterpriseType: string;
  topBarangays: string[];
  sources: string[];
  mostOperationalEnterprise?: string;
  mostClosedEnterprise?: string;
  withGrantUtilizationReport?: number;
  withoutGrantUtilizationReport?: number;
  withTraining?: number;
  withoutTraining?: number;
};

export type BarangayAnalyticsRow = {
  municipality: MunicipalityName;
  barangay: string;
  normalizedBarangay: string;
  totalParticipants: number;
  totalAssociations: number;
  totalEnterprises: number;
  individualEnterprises: number;
  withGrantUtilizationReport: number;
  withoutGrantUtilizationReport: number;
  withTraining: number;
  withoutTraining: number;
  operational: number;
  closed: number;
  pendingUnknown: number;
  topEnterpriseType: string;
  mostOperationalEnterprise: string;
  mostClosedEnterprise: string;
  monitoringFirstVisit: number;
  monitoringSecondVisit: number;
  monitoringThirdVisit: number;
  monitoringFourthVisit: number;
  organizationalAssessment: number;
  annualAssessment: number;
  sourceModules: string[];
  sourceFiles: string[];
};

export type MunicipalityDrilldownRecord = Record<string, any>;
export type LivelihoodSustainabilityRecord = Record<string, any>;
export type LivelihoodSustainabilityAnalytics = {
  summary: {
    operationalTracked: number;
    stableIncome: number;
    withSavingsBankAccount: number;
    atRisk: number;
    possibleBusinessFailure: number;
    noMonitoringData: number;
  };
  byMunicipality: Array<{
    municipality: MunicipalityName;
    operationalTracked: number;
    stableIncome: number;
    atRisk: number;
    possibleBusinessFailure: number;
    noMonitoringData: number;
    withSavingsBankAccount: number;
    averageFinancialRating: number | null;
    averageNetIncome: number | null;
    totalSavings: number;
  }>;
  records: LivelihoodSustainabilityRecord[];
  municipalityFinancialRanking: Array<{
    municipality: MunicipalityName;
    topBestFinancialRating: LivelihoodSustainabilityRecord[];
    bottomLowEarningNeedsAssistance: LivelihoodSustainabilityRecord[];
    criticalCloseToBankruptcy: LivelihoodSustainabilityRecord[];
  }>;
  sourceCounts?: Record<string, number>;
  columnMapping?: Record<string, any>;
};
export type DashboardParsedFile = {
  moduleType?: string;
  classification?: string;
  fileName?: string;
  originalName?: string;
  folder?: string;
  category?: string;
  sourceModule?: string;
  sourceFile?: string;
  headers?: string[];
  rows?: Array<Record<string, any>>;
};

export type DashboardAnalyticsApiResponse = {
  success: boolean;
  lastUpdated: string;
  summary: {
    totalParticipants: number;
    associations: number;
    individualEnterprises: number;
    operational: number;
    closed: number;
  };
  operationalClosedByMunicipality: Array<{ municipality: MunicipalityName; operational: number; closed: number; unknown: number; total: number }>;
  topEnterprisesOverall: Array<{ rank: number; enterpriseProjectType: string; count: number }>;
  topEnterprisesByMunicipality: Array<{ municipality: MunicipalityName; enterpriseProjectType: string; count: number }>;
  mostOperationalEnterprises: Array<{ rank: number; enterpriseProjectType: string; operationalCount: number }>;
  mostOperationalEnterprisesByMunicipality?: Array<{ municipality: MunicipalityName; enterpriseProjectType: string; operationalCount: number }>;
  mostClosedEnterprises: Array<{ rank: number; enterpriseProjectType: string; closedCount: number }>;
  mostClosedEnterprisesByMunicipality?: Array<{ municipality: MunicipalityName; enterpriseProjectType: string; closedCount: number }>;
  grantUtilization: {
    withReport: number;
    withoutReport: number;
    byMunicipality: Array<{ municipality: MunicipalityName; totalProjects: number; withGur: number; withoutGur: number; gurRate?: number; sourceUsed?: string }>;
  };
  training: {
    withTraining: number;
    withoutTraining: number;
    byMunicipality: Array<{ municipality: MunicipalityName; projectParticipants: number; withTraining: number; withoutTraining: number }>;
    byTrainingTitle: Array<{ trainingTitle: string; participants: number; sourceRows?: number; municipalities?: string[] }>;
  };
  municipalityDrilldown: Array<{
    municipality: MunicipalityName;
    totalParticipants: number;
    associations: number;
    individualEnterprises: number;
    operational: number;
    closed: number;
    topEnterprise: string;
    mostOperationalEnterprise: string;
    mostClosedEnterprise: string;
    withGrantUtilizationReport: number;
    withoutGrantUtilizationReport: number;
    withTraining: number;
    withoutTraining: number;
    sourceFilesUsed: string[];
  }>;
  municipalityDrilldownRecords?: MunicipalityDrilldownRecord[];
  monitoringCoverage?: MonitoringCoverageAnalytics;
  barangayAnalytics?: BarangayAnalyticsRow[];
  livelihoodSustainability?: LivelihoodSustainabilityAnalytics;
  dataQualityNotes?: string[];
  lastIndexed?: string;
  sourceDiagnostics?: Array<{ sourceType: string; fileCount: number; totalRows: number; detectedHeaders: string[]; projectNameColumn?: string; projectIdColumn?: string; municipalityColumn?: string; participantIdColumn?: string; grantCodeColumn?: string; enterpriseCategoryColumn?: string; classificationConfidence: number; lastIndexed: string; usedBy: string[] }>;
  widgetDiagnostics?: Array<{ widgetName: string; source_type: string; files_used: number; rows_before: number; rows_after: number; join_key_used: string; missing_required_columns: string[]; final_result_count: number }>;
  dashboardDebug?: {
    projectModuleRowsLoaded: number;
    projectNameColumnUsed: string;
    sampleProjectNames: string[];
    projectNameColumnError?: string;
    monitoringIndividualRowsLoaded: number;
    monitoringAssociationRowsLoaded: number;
    joinKeyUsed: string;
    matchedMonitoringRowsToProjectRows: number;
    unmatchedMonitoringRows: number;
    widgetSources: Array<{ widgetName: string; sourceType: string; filesUsed: number; joinKeyUsed: string; resultCount: number }>;
  };
};

export type DashboardAnalytics = {
  success: boolean;
  lastUpdated: string;
  hasData: boolean;
  sourceCount: number;
  rowCount: number;
  summary: {
    totalParticipants: number;
    totalAssociations: number;
    totalEnterprises: number;
    individualEnterprises: number;
    operationalEnterprises: number;
    closedEnterprises: number;
    ongoingEnterprises: number;
    inactiveEnterprises: number;
    encodedRecords: number;
    notEncodedRecords: number;
    totalVisits: number;
    mostActiveMunicipality: string;
    highestClosedMunicipality: string;
    mostImplementedEnterpriseType: string;
  };
  municipalities: MunicipalityStat[];
  statusStats: Array<{ name: string; value: number }>;
  byMunicipality: Array<{
    municipality: MunicipalityName;
    operational: number;
    closed: number;
    ongoing: number;
    inactive: number;
    totalEnterprises: number;
    totalParticipants: number;
  }>;
  topEnterpriseTypes: Array<{ name: string; value: number }>;
  topEnterprisesOverall: DashboardAnalyticsApiResponse["topEnterprisesOverall"];
  topEnterprisesByMunicipality: DashboardAnalyticsApiResponse["topEnterprisesByMunicipality"];
  mostOperationalEnterprises: DashboardAnalyticsApiResponse["mostOperationalEnterprises"];
  mostOperationalEnterprisesByMunicipality: NonNullable<DashboardAnalyticsApiResponse["mostOperationalEnterprisesByMunicipality"]>;
  mostClosedEnterprises: DashboardAnalyticsApiResponse["mostClosedEnterprises"];
  mostClosedEnterprisesByMunicipality: NonNullable<DashboardAnalyticsApiResponse["mostClosedEnterprisesByMunicipality"]>;
  grantUtilization: DashboardAnalyticsApiResponse["grantUtilization"];
  training: DashboardAnalyticsApiResponse["training"];
  monitoringCoverage: MonitoringCoverageAnalytics;
  barangayAnalytics: BarangayAnalyticsRow[];
  livelihoodSustainability: LivelihoodSustainabilityAnalytics;
  municipalityDrilldownRecords: MunicipalityDrilldownRecord[];
  parsedFiles: DashboardParsedFile[];
  encodedStats: { encoded: number; notEncoded: number };
  visitStats: { totalVisits: number; mostVisitedMunicipality: string };
  insights: string[];
  dataQualityNotes: string[];
  sourceDiagnostics: NonNullable<DashboardAnalyticsApiResponse["sourceDiagnostics"]>;
  widgetDiagnostics: NonNullable<DashboardAnalyticsApiResponse["widgetDiagnostics"]>;
  dashboardDebug?: DashboardAnalyticsApiResponse["dashboardDebug"];
};

export const AURORA_MUNICIPALITIES: MunicipalityName[] = [
  "Baler",
  "Casiguran",
  "Dilasag",
  "Dinalungan",
  "Dingalan",
  "Dipaculao",
  "Maria Aurora",
  "San Luis",
];

const AURORA_MUNICIPALITY_LOOKUP = new Map(
  AURORA_MUNICIPALITIES.map((municipality) => [
    municipality.toUpperCase().replace(/\s+/g, " "),
    municipality,
  ]),
);

export function normalizeAuroraMunicipality(value: unknown): MunicipalityName | null {
  const raw = String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  return AURORA_MUNICIPALITY_LOOKUP.get(raw) || null;
}

export function logMunicipalityNormalizationDebug(values: unknown[]) {
  const originalMunicipalityValues = Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const normalizedMunicipalityCounts = Object.fromEntries(
    AURORA_MUNICIPALITIES.map((municipality) => [
      municipality,
      values.filter((value) => normalizeAuroraMunicipality(value) === municipality).length,
    ]),
  );
  const invalidMunicipalityValues = originalMunicipalityValues.filter((value) => !normalizeAuroraMunicipality(value));

  console.log("MUNICIPALITY_NORMALIZATION_DEBUG", {
    originalMunicipalityValues,
    normalizedMunicipalityCounts,
    invalidMunicipalityValues,
  });
}

export function emptyMonitoringCoverage(): MonitoringCoverageAnalytics {
  return {
    summary: {
      firstVisit: 0,
      secondVisit: 0,
      thirdVisit: 0,
      fourthVisit: 0,
      organizationalAssessment: 0,
      annualAssessment: 0,
      missingMonitoringVisits: 0,
      missingAssessments: 0,
      totalUnits: 0,
    },
    byMunicipality: AURORA_MUNICIPALITIES.map((municipality) => ({
      municipality,
      totalUnits: 0,
      firstVisit: 0,
      secondVisit: 0,
      thirdVisit: 0,
      fourthVisit: 0,
      organizationalAssessment: 0,
      annualAssessment: 0,
      missingMonitoringVisits: 0,
      missingAssessments: 0,
    })),
    rows: [],
  };
}

export function emptyLivelihoodSustainability(): LivelihoodSustainabilityAnalytics {
  return {
    summary: {
      operationalTracked: 0,
      stableIncome: 0,
      withSavingsBankAccount: 0,
      atRisk: 0,
      possibleBusinessFailure: 0,
      noMonitoringData: 0,
    },
    byMunicipality: AURORA_MUNICIPALITIES.map((municipality) => ({
      municipality,
      operationalTracked: 0,
      stableIncome: 0,
      atRisk: 0,
      possibleBusinessFailure: 0,
      noMonitoringData: 0,
      withSavingsBankAccount: 0,
      averageFinancialRating: null,
      averageNetIncome: null,
      totalSavings: 0,
    })),
    records: [],
    municipalityFinancialRanking: AURORA_MUNICIPALITIES.map((municipality) => ({
      municipality,
      topBestFinancialRating: [],
      bottomLowEarningNeedsAssistance: [],
      criticalCloseToBankruptcy: [],
    })),
  };
}

export function emptyDashboardAnalytics(): DashboardAnalytics {
  return {
    success: true,
    lastUpdated: new Date().toISOString(),
    hasData: false,
    sourceCount: 0,
    rowCount: 0,
    summary: {
      totalParticipants: 0,
      totalAssociations: 0,
      totalEnterprises: 0,
      individualEnterprises: 0,
      operationalEnterprises: 0,
      closedEnterprises: 0,
      ongoingEnterprises: 0,
      inactiveEnterprises: 0,
      encodedRecords: 0,
      notEncodedRecords: 0,
      totalVisits: 0,
      mostActiveMunicipality: "No data yet",
      highestClosedMunicipality: "No data yet",
      mostImplementedEnterpriseType: "No data yet",
    },
    municipalities: AURORA_MUNICIPALITIES.map((municipality) => ({
      municipality,
      totalParticipants: 0,
      totalAssociations: 0,
      totalEnterprises: 0,
      individualEnterprises: 0,
      operational: 0,
      closed: 0,
      ongoing: 0,
      inactive: 0,
      encoded: 0,
      notEncoded: 0,
      totalVisits: 0,
      topEnterpriseType: "No data yet",
      topBarangays: [],
      sources: [],
    })),
    statusStats: [
      { name: "Operational", value: 0 },
      { name: "Closed", value: 0 },
      { name: "Ongoing", value: 0 },
      { name: "Inactive/Validation", value: 0 },
    ],
    byMunicipality: AURORA_MUNICIPALITIES.map((municipality) => ({
      municipality,
      operational: 0,
      closed: 0,
      ongoing: 0,
      inactive: 0,
      totalEnterprises: 0,
      totalParticipants: 0,
    })),
    topEnterpriseTypes: [],
    topEnterprisesOverall: [],
    topEnterprisesByMunicipality: [],
    mostOperationalEnterprises: [],
    mostOperationalEnterprisesByMunicipality: [],
    mostClosedEnterprises: [],
    mostClosedEnterprisesByMunicipality: [],
    grantUtilization: { withReport: 0, withoutReport: 0, byMunicipality: [] },
    training: { withTraining: 0, withoutTraining: 0, byMunicipality: [], byTrainingTitle: [] },
    monitoringCoverage: emptyMonitoringCoverage(),
    barangayAnalytics: [],
    livelihoodSustainability: emptyLivelihoodSustainability(),
    municipalityDrilldownRecords: [],
    parsedFiles: [],
    encodedStats: { encoded: 0, notEncoded: 0 },
    visitStats: { totalVisits: 0, mostVisitedMunicipality: "No data yet" },
    insights: ["No data available yet. Upload SLPIS or monitoring files to populate analytics."],
    dataQualityNotes: [],
    sourceDiagnostics: [],
    widgetDiagnostics: [],
  };
}

function dashboardApiToDashboardAnalytics(data: DashboardAnalyticsApiResponse): DashboardAnalytics {
  const base = emptyDashboardAnalytics();
  const municipalities = AURORA_MUNICIPALITIES.map((municipality) => {
    const drill = data.municipalityDrilldown.find((row) => row.municipality === municipality);
    const status = data.operationalClosedByMunicipality.find((row) => row.municipality === municipality);
    return {
      municipality,
      totalParticipants: drill?.totalParticipants || 0,
      totalAssociations: drill?.associations || 0,
      totalEnterprises: (drill?.associations || 0) + (drill?.individualEnterprises || 0),
      individualEnterprises: drill?.individualEnterprises || 0,
      operational: drill?.operational || status?.operational || 0,
      closed: drill?.closed || status?.closed || 0,
      ongoing: 0,
      inactive: status?.unknown || 0,
      encoded: 0,
      notEncoded: 0,
      totalVisits: 0,
      topEnterpriseType: drill?.topEnterprise || "No data yet",
      topBarangays: [],
      sources: drill?.sourceFilesUsed || [],
      mostOperationalEnterprise: drill?.mostOperationalEnterprise || "No data yet",
      mostClosedEnterprise: drill?.mostClosedEnterprise || "No data yet",
      withGrantUtilizationReport: drill?.withGrantUtilizationReport || 0,
      withoutGrantUtilizationReport: drill?.withoutGrantUtilizationReport || 0,
      withTraining: drill?.withTraining || 0,
      withoutTraining: drill?.withoutTraining || 0,
    };
  });
  return {
    ...base,
    success: data.success,
    lastUpdated: data.lastUpdated || new Date().toISOString(),
    hasData: Object.values(data.summary || {}).some((value) => Number(value) > 0),
    sourceCount: data.sourceDiagnostics?.reduce((sum, item) => sum + item.fileCount, 0) || new Set(municipalities.flatMap((item) => item.sources)).size,
    rowCount: data.sourceDiagnostics?.reduce((sum, item) => sum + item.totalRows, 0) || data.summary.totalParticipants + data.summary.associations + data.summary.individualEnterprises,
    summary: {
      ...base.summary,
      totalParticipants: data.summary.totalParticipants,
      totalAssociations: data.summary.associations,
      totalEnterprises: data.summary.associations + data.summary.individualEnterprises,
      individualEnterprises: data.summary.individualEnterprises,
      operationalEnterprises: data.summary.operational,
      closedEnterprises: data.summary.closed,
      mostActiveMunicipality: [...municipalities].sort((a, b) => b.totalEnterprises + b.totalParticipants - (a.totalEnterprises + a.totalParticipants))[0]?.municipality || "No data yet",
      highestClosedMunicipality: [...municipalities].sort((a, b) => b.closed - a.closed)[0]?.municipality || "No data yet",
      mostImplementedEnterpriseType: data.topEnterprisesOverall[0]?.enterpriseProjectType || "No data yet",
    },
    municipalities,
    statusStats: [
      { name: "Operational", value: data.summary.operational },
      { name: "Closed", value: data.summary.closed },
    ],
    byMunicipality: data.operationalClosedByMunicipality.map((item) => ({
      municipality: item.municipality,
      operational: item.operational,
      closed: item.closed,
      ongoing: 0,
      inactive: item.unknown,
      totalEnterprises: municipalities.find((row) => row.municipality === item.municipality)?.totalEnterprises || 0,
      totalParticipants: municipalities.find((row) => row.municipality === item.municipality)?.totalParticipants || 0,
    })),
    topEnterpriseTypes: data.topEnterprisesOverall.map((item) => ({ name: item.enterpriseProjectType, value: item.count })),
    topEnterprisesOverall: data.topEnterprisesOverall,
    topEnterprisesByMunicipality: data.topEnterprisesByMunicipality,
    mostOperationalEnterprises: data.mostOperationalEnterprises,
    mostOperationalEnterprisesByMunicipality: data.mostOperationalEnterprisesByMunicipality || [],
    mostClosedEnterprises: data.mostClosedEnterprises,
    mostClosedEnterprisesByMunicipality: data.mostClosedEnterprisesByMunicipality || [],
    grantUtilization: data.grantUtilization,
    training: data.training,
    monitoringCoverage: data.monitoringCoverage || emptyMonitoringCoverage(),
    barangayAnalytics: data.barangayAnalytics || [],
    livelihoodSustainability: data.livelihoodSustainability || emptyLivelihoodSustainability(),
    municipalityDrilldownRecords: data.municipalityDrilldownRecords || [],
    insights: [
      `${data.summary.totalParticipants.toLocaleString()} participant(s) are counted from the Personal Module.`,
      `${data.summary.associations.toLocaleString()} association enterprise(s) are counted from the Project Module.`,
      `${data.summary.operational.toLocaleString()} operational and ${data.summary.closed.toLocaleString()} closed enterprise(s) are calculated from MDMonitoring.`,
    ],
    dataQualityNotes: data.dataQualityNotes || [],
    sourceDiagnostics: data.sourceDiagnostics || [],
    widgetDiagnostics: data.widgetDiagnostics || [],
    dashboardDebug: data.dashboardDebug,
  };
}

export function getApiBaseUrl() {
  return API_BASE_URL;
}

// Dashboard refresh function: always requests fresh SQLite-derived analytics and bypasses browser cache.
export async function refreshDashboardAnalytics(options: { force?: boolean } = {}): Promise<DashboardAnalytics> {
  console.log("Loading dashboard data from /api/dashboard-data");
  console.log("API_CALL", "GET /api/dashboard-data");
  console.time("LOAD_DASHBOARD_SUMMARY");
  let data: any;
  try {
    data = await apiGetJson(`/api/dashboard-data?ts=${Date.now()}${options.force ? "&refresh=1" : ""}`, { endpointName: "Dashboard data" });
  } finally {
    console.timeEnd("LOAD_DASHBOARD_SUMMARY");
  }
  console.log("UPLOADS_RECEIVED", { count: data.debug?.rowsParsedByType?.sourceRows || 0 });
  console.log("DASHBOARD DATA FROM API", data);
  const analytics = dashboardApiToDashboardAnalytics(data.analytics || data);
  const parsedFiles = data.files || data.parsedFiles || data.sourceFiles || [];
  console.log("DASHBOARD_UPDATE", {
    filesScanned: analytics.monitoringCoverage.debug?.filesScanned || 0,
    rowsBeforeFilter: analytics.monitoringCoverage.debug?.monitoringRowsBeforeFilter || 0,
    unitsAfterMerge: analytics.monitoringCoverage.debug?.monitoringUnitsAfterMerge || 0,
  });
  return { ...analytics, parsedFiles };
}

export function getDashboardSummary(analytics: DashboardAnalytics) {
  return analytics.summary;
}

export function getMunicipalityStats(analytics: DashboardAnalytics) {
  return analytics.municipalities;
}

export function getEnterpriseStatusStats(analytics: DashboardAnalytics) {
  return analytics.statusStats;
}

export function getTopEnterpriseTypes(analytics: DashboardAnalytics) {
  return analytics.topEnterpriseTypes;
}

export function getEncodedVsNotEncoded(analytics: DashboardAnalytics) {
  return analytics.encodedStats;
}

export function getVisitStats(analytics: DashboardAnalytics) {
  return analytics.visitStats;
}
