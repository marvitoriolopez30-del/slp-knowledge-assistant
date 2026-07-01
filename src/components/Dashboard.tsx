import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, BarChart3, CheckCircle2, Download, Factory, FileCheck2, MapPinned, Menu, MessageSquare, RefreshCw, Search, Table2, Upload, Users, X } from "lucide-react";
import { AnalyticsMap } from "./AnalyticsMap";
import { EnterpriseInsightsSection, OperationalStatusSection, ProgramComplianceSection } from "./EnterpriseCharts";
import { LivelihoodSustainabilitySection } from "./LivelihoodSustainabilitySection";
import { MonitoringCoverageSection } from "./MonitoringCoverageSection";
import { MunicipalityDrilldown } from "./MunicipalityDrilldown";
import { PantawidDemographicReport } from "./PantawidDemographicReport";
import {
  AURORA_MUNICIPALITIES,
  type DashboardAnalytics,
  type MunicipalityName,
  type MunicipalityStat,
} from "../utils/dashboardAnalytics";

export type SlpaDemographicsTarget = {
  municipality?: string;
  slpaName?: string;
  grantCode?: string;
  projectId?: string;
};

type Profile = {
  id: string;
  email: string;
  full_name?: string;
  role: "admin" | "user" | string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
};

function formatUserDisplayName(profile?: Profile | null) {
  const email = profile?.email?.trim() || "";
  const fullName = profile?.full_name?.trim() || "";
  if (fullName && fullName.toLowerCase() !== email.toLowerCase()) return fullName;
  return email.split("@")[0]?.replace(/\d+/g, " ").replace(/[._-]+/g, " ").trim() || "User";
}

function StatusPill({ label, active = true }: { label: string; active?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${active ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
      <span className={`h-2 w-2 rounded-full ${active ? "bg-emerald-500" : "bg-amber-500"}`} />
      {label}
    </span>
  );
}

type DashboardSection = "monitoring" | "operational" | "sustainability" | "compliance" | "enterprise" | "pantawid" | "drilldown";

const sectionTabs: Array<{
  key: DashboardSection;
  label: string;
  description: string;
  icon: typeof BarChart3;
}> = [
  { key: "monitoring", label: "Monitoring & Assessment", description: "Visits, filters, and coverage matrix", icon: MapPinned },
  { key: "operational", label: "Operational Status", description: "Operational versus closed views", icon: CheckCircle2 },
  { key: "sustainability", label: "Financial Overview", description: "Livelihood sustainability ratings", icon: BarChart3 },
  { key: "compliance", label: "Program Compliance", description: "GUR and training status", icon: FileCheck2 },
  { key: "enterprise", label: "Enterprise Insights", description: "Project type rankings", icon: Factory },
  { key: "pantawid", label: "Pantawid Served", description: "Personal module demographics", icon: Users },
  { key: "drilldown", label: "Municipality Drill-down", description: "Clickable source records", icon: Table2 },
];

function SectionTabs({ activeTab, onChange }: { activeTab: DashboardSection; onChange: (tab: DashboardSection) => void }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#D8E6E1] bg-white p-2 shadow-sm">
      <div className="flex gap-2 overflow-x-auto pb-1 lg:grid lg:grid-cols-7 lg:overflow-visible lg:pb-0">
        {sectionTabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className={`flex min-h-[64px] min-w-[180px] items-start gap-2 rounded-lg border px-3 py-3 text-left lg:min-w-0 ${
                active ? "border-[#047857] bg-[#F0FDF4] text-[#064E3B]" : "border-transparent bg-white text-[#334155] hover:bg-[#F8FAFC]"
              }`}
            >
              <span className={`rounded-md p-2 ${active ? "bg-white text-[#047857]" : "bg-[#F0FDF4] text-[#064E3B]"}`}>
                <Icon size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold">{tab.label}</span>
                <span className="mt-1 block text-xs leading-snug text-[#64748B]">{tab.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SelectedMunicipalityCard({
  selectedFilteredStats,
  selectedStats,
  selectedMunicipality,
}: {
  selectedFilteredStats?: MunicipalityStat;
  selectedStats?: MunicipalityStat;
  selectedMunicipality: MunicipalityName;
}) {
  const stats = selectedFilteredStats || selectedStats;
  return (
    <div className="rounded-lg border border-[#D8E6E1] bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">Selected Municipality</p>
      <p className="mt-1 text-lg font-bold text-[#064E3B]">{stats?.municipality || selectedMunicipality}</p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#334155]">
        <span>Projects: <strong>{stats?.totalEnterprises || 0}</strong></span>
        <span>Participants: <strong>{stats?.totalParticipants || 0}</strong></span>
        <span>Operational: <strong>{stats?.operational || 0}</strong></span>
        <span>Closed: <strong>{stats?.closed || 0}</strong></span>
      </div>
    </div>
  );
}

function InsightPanel({
  filteredAnalytics,
  selectedFilteredStats,
  selectedStats,
  selectedMunicipality,
  statusFilter,
  setStatusFilter,
}: {
  filteredAnalytics: DashboardAnalytics;
  selectedFilteredStats?: MunicipalityStat;
  selectedStats?: MunicipalityStat;
  selectedMunicipality: MunicipalityName;
  statusFilter: string;
  setStatusFilter: (value: string) => void;
}) {
  return (
    <div className="rounded-lg border border-[#D8E6E1] bg-white p-4 shadow-sm overflow-hidden">
      <div className="mb-3 flex items-center gap-2 text-[#064E3B]">
        <Search size={18} />
        <h3 className="font-bold">Insight Panel</h3>
      </div>
      <p className="mb-3 text-xs text-[#64748B]">Data is based on the latest uploaded and parsed files.</p>
      <label className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">Status filter</label>
      <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="mt-1 w-full rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm">
        <option value="all">All municipalities</option>
        <option value="operational">Operational</option>
        <option value="closed">Closed</option>
      </select>

      <div className="mt-4">
        <SelectedMunicipalityCard selectedFilteredStats={selectedFilteredStats} selectedStats={selectedStats} selectedMunicipality={selectedMunicipality} />
      </div>

      <div className="mt-4 space-y-2">
        {filteredAnalytics.insights.map((insight) => (
          <div key={insight} className="rounded-lg border border-emerald-100 bg-white p-3 text-sm text-[#334155]">{insight}</div>
        ))}
      </div>
    </div>
  );
}

function QuickActions({ onNavigate }: { onNavigate: (tab: "chat" | "docs" | "match") => void }) {
  return (
    <div className="rounded-lg border border-[#D8E6E1] bg-white p-4 shadow-sm overflow-hidden">
      <h3 className="mb-3 font-bold text-[#064E3B]">Quick Actions</h3>
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => onNavigate("chat")} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#F0FDF4] px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-emerald-100"><MessageSquare size={16} />New Chat</button>
        <button onClick={() => onNavigate("docs")} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#F0FDF4] px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-emerald-100"><Upload size={16} />Upload</button>
        <button onClick={() => onNavigate("match")} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#F0FDF4] px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-emerald-100"><Users size={16} />Match</button>
        <button onClick={() => onNavigate("chat")} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#F0FDF4] px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-emerald-100"><Download size={16} />Report</button>
      </div>
    </div>
  );
}

function MobileDisclosure({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="mb-3 rounded-xl border border-[#D8E6E1] bg-[#F8FAFC]">
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between px-3 py-3 text-left text-sm font-bold text-[#064E3B]">
        {title}
        <span>{open ? "Hide" : "Show"}</span>
      </button>
      {open && <div className="p-3 pt-0">{children}</div>}
    </div>
  );
}

export function Dashboard({
  profile,
  onNavigate,
  analytics,
  isLoaded,
  isLoading,
  error,
  loadAnalytics,
}: {
  profile: Profile | null;
  onNavigate: (tab: "chat" | "docs" | "match") => void;
  analytics: DashboardAnalytics;
  isLoaded: boolean;
  isLoading: boolean;
  error: string;
  lastLoadedAt: number;
  loadAnalytics: (reason: string, options?: { force?: boolean }) => Promise<DashboardAnalytics>;
}) {
  const [selectedMunicipality, setSelectedMunicipality] = useState<MunicipalityName>("Baler");
  const [statusFilter, setStatusFilter] = useState("all");
  const [activeSection, setActiveSection] = useState<DashboardSection>("monitoring");
  const [slpaDemographicsTarget, setSlpaDemographicsTarget] = useState<SlpaDemographicsTarget | null>(null);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [mobileInsightOpen, setMobileInsightOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const userDisplayName = formatUserDisplayName(profile);

  useEffect(() => {
    loadAnalytics("dashboard opened");
  }, [loadAnalytics]);

  useEffect(() => {
    const focusHandler = () => loadAnalytics("dashboard focus stale check");
    window.addEventListener("focus", focusHandler);
    return () => {
      window.removeEventListener("focus", focusHandler);
    };
  }, [loadAnalytics]);

  const message = error || (!analytics.hasData && isLoaded ? "Upload SLPIS, Project, Personal, SLPA, or Monitoring files to populate map analytics." : "");

  const selectedStats = analytics.municipalities.find((item) => item.municipality === selectedMunicipality) || analytics.municipalities[0];

  const filteredAnalytics = useMemo<DashboardAnalytics>(() => {
    if (statusFilter === "all") return analytics;
    const keepOperational = statusFilter === "operational";
    const municipalities = analytics.municipalities.map((item) => ({
      ...item,
      operational: keepOperational ? item.operational : 0,
      closed: keepOperational ? 0 : item.closed,
      inactive: 0,
      mostOperationalEnterprise: keepOperational ? item.mostOperationalEnterprise : "No data yet",
      mostClosedEnterprise: keepOperational ? "No data yet" : item.mostClosedEnterprise,
    }));
    const byMunicipality = analytics.byMunicipality.map((item) => ({
      ...item,
      operational: keepOperational ? item.operational : 0,
      closed: keepOperational ? 0 : item.closed,
      inactive: 0,
    }));
    const operationalTotal = keepOperational ? analytics.summary.operationalEnterprises : 0;
    const closedTotal = keepOperational ? 0 : analytics.summary.closedEnterprises;
    return {
      ...analytics,
      municipalities,
      byMunicipality,
      statusStats: keepOperational
        ? [{ name: "Operational", value: analytics.summary.operationalEnterprises }]
        : [{ name: "Closed", value: analytics.summary.closedEnterprises }],
      summary: {
        ...analytics.summary,
        operationalEnterprises: operationalTotal,
        closedEnterprises: closedTotal,
      },
      mostOperationalEnterprises: keepOperational ? analytics.mostOperationalEnterprises : [],
      mostOperationalEnterprisesByMunicipality: keepOperational ? analytics.mostOperationalEnterprisesByMunicipality : [],
      mostClosedEnterprises: keepOperational ? [] : analytics.mostClosedEnterprises,
      mostClosedEnterprisesByMunicipality: keepOperational ? [] : analytics.mostClosedEnterprisesByMunicipality,
      insights: [
        keepOperational
          ? `${analytics.summary.operationalEnterprises.toLocaleString()} operational enterprise(s) match the current view.`
          : `${analytics.summary.closedEnterprises.toLocaleString()} closed enterprise(s) match the current view.`,
      ],
    };
  }, [analytics, statusFilter]);

  const selectedFilteredStats = filteredAnalytics.municipalities.find((item) => item.municipality === selectedMunicipality) || filteredAnalytics.municipalities[0];

  const visibleMunicipalities = useMemo(() => {
    if (statusFilter === "all") return filteredAnalytics.municipalities;
    return filteredAnalytics.municipalities.filter((item) => Number(item[statusFilter as "operational" | "closed"] || 0) > 0);
  }, [filteredAnalytics.municipalities, statusFilter]);

  return (
    <div className="space-y-4 overflow-x-hidden">
      <div className="overflow-hidden rounded-xl border border-[#D8E6E1] bg-[#064E3B] p-4 text-white shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold text-emerald-100">Welcome, {userDisplayName}</p>
            <h2 className="mt-1 text-2xl font-bold sm:text-3xl">SLP Aurora Province Monitoring & Analytics Dashboard</h2>
            <p className="mt-2 max-w-3xl text-sm text-emerald-50">Clean monitoring view for SLP performance, coverage, and municipality-level insights.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-semibold">Last Updated: {new Date(analytics.lastUpdated).toLocaleString()}</span>
            <button onClick={() => loadAnalytics("manual dashboard refresh", { force: true })} className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-emerald-50">
              <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
              {isLoading && isLoaded ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      {!isLoaded ? (
        <DashboardLoadingState isLoading={isLoading} error={error} />
      ) : (
        <>
      {message && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 overflow-x-hidden">{message}</div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <AnalyticsMap municipalities={visibleMunicipalities.length ? visibleMunicipalities : filteredAnalytics.municipalities} barangayAnalytics={filteredAnalytics.barangayAnalytics} selectedMunicipality={selectedMunicipality} onSelectMunicipality={setSelectedMunicipality} />

        <div className="space-y-3 md:hidden">
          <SelectedMunicipalityCard selectedFilteredStats={selectedFilteredStats} selectedStats={selectedStats} selectedMunicipality={selectedMunicipality} />
          <button type="button" onClick={() => setMobileDrawerOpen(true)} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#064E3B] px-3 py-2 text-sm font-semibold text-white hover:bg-[#047857]">
            <Menu size={16} /> Open dashboard tools
          </button>
        </div>

        <aside className="hidden space-y-4 md:block">
          <InsightPanel filteredAnalytics={filteredAnalytics} selectedFilteredStats={selectedFilteredStats} selectedStats={selectedStats} selectedMunicipality={selectedMunicipality} statusFilter={statusFilter} setStatusFilter={setStatusFilter} />
          <QuickActions onNavigate={onNavigate} />
        </aside>
      </div>

      {mobileDrawerOpen && (
        <div className="fixed inset-0 z-[1000] md:hidden">
          <button type="button" aria-label="Close dashboard tools" className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileDrawerOpen(false)} />
          <div className="absolute right-0 top-0 h-full w-[88vw] max-w-sm overflow-y-auto bg-white p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-bold text-[#064E3B]">Dashboard Tools</h3>
              <button type="button" onClick={() => setMobileDrawerOpen(false)} className="rounded-lg border border-[#D8E6E1] p-2 text-[#064E3B]"><X size={18} /></button>
            </div>
            <MobileDisclosure title="Insight Panel" open={mobileInsightOpen} onToggle={() => setMobileInsightOpen((value) => !value)}>
              <InsightPanel filteredAnalytics={filteredAnalytics} selectedFilteredStats={selectedFilteredStats} selectedStats={selectedStats} selectedMunicipality={selectedMunicipality} statusFilter={statusFilter} setStatusFilter={setStatusFilter} />
            </MobileDisclosure>
            <MobileDisclosure title="Quick Actions" open={mobileActionsOpen} onToggle={() => setMobileActionsOpen((value) => !value)}>
              <QuickActions onNavigate={(tab) => { setMobileDrawerOpen(false); onNavigate(tab); }} />
            </MobileDisclosure>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-[#D8E6E1] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold text-[#064E3B]">Filtered Municipalities</h3>
            <p className="text-sm text-[#64748B]">{visibleMunicipalities.length} of {AURORA_MUNICIPALITIES.length} municipalities match the current filter.</p>
          </div>
          <StatusPill label={filteredAnalytics.summary.mostImplementedEnterpriseType} active={filteredAnalytics.hasData} />
        </div>
      </div>

      <SectionTabs activeTab={activeSection} onChange={setActiveSection} />

      <div>
        {activeSection === "monitoring" && <MonitoringCoverageSection analytics={filteredAnalytics} />}
        {activeSection === "operational" && <OperationalStatusSection analytics={filteredAnalytics} />}
        {activeSection === "sustainability" && (
          <LivelihoodSustainabilitySection
            analytics={analytics}
            onViewSlpaMembers={(target) => {
              setSlpaDemographicsTarget(target);
              setActiveSection("pantawid");
            }}
          />
        )}
        {activeSection === "compliance" && <ProgramComplianceSection analytics={filteredAnalytics} />}
        {activeSection === "enterprise" && <EnterpriseInsightsSection analytics={filteredAnalytics} />}
        {activeSection === "pantawid" && <PantawidDemographicReport parsedFiles={analytics.parsedFiles} slpaTarget={slpaDemographicsTarget} />}
        {activeSection === "drilldown" && (
          <MunicipalityDrilldown municipalities={visibleMunicipalities} records={filteredAnalytics.municipalityDrilldownRecords} parsedFiles={analytics.parsedFiles} sustainabilityRecords={analytics.livelihoodSustainability.records} selectedMunicipality={selectedMunicipality} onSelectMunicipality={setSelectedMunicipality} />
        )}
      </div>
        </>
      )}
    </div>
  );
}

function DashboardLoadingState({ isLoading, error }: { isLoading: boolean; error: string }) {
  const steps = [
    "Connecting to API...",
    "Loading parsed files...",
    "Loading dashboard summary...",
    "Loading financial overview...",
    "Loading Pantawid Served...",
    "Loading SLPA demographics...",
  ];
  return (
    <div className={`rounded-xl border px-4 py-4 text-sm shadow-sm ${error ? "border-rose-200 bg-rose-50 text-rose-800" : "border-[#D8E6E1] bg-white text-[#334155]"}`}>
      <div className="flex items-start gap-3">
        {error ? <AlertTriangle className="mt-0.5 shrink-0" size={18} /> : <RefreshCw className={`mt-0.5 shrink-0 ${isLoading ? "animate-spin" : ""}`} size={18} />}
        <div className="min-w-0 flex-1">
          <p className="font-bold">{error ? "Dashboard data could not be loaded." : "Preparing dashboard data..."}</p>
          <p className="mt-1">{error || "Do not close this tab while the forwarded API wakes up."}</p>
          {!error && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {steps.map((step, index) => (
                <div key={step} className="rounded-lg border border-[#D8E6E1] bg-[#F8FAFC] px-3 py-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="font-semibold text-[#64748B]">{index === 0 && isLoading ? "Connecting to API..." : step}</span>
                    <span className="h-2 w-2 rounded-full bg-[#10B981]" />
                  </div>
                  <div className="slp-skeleton-line w-full" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
