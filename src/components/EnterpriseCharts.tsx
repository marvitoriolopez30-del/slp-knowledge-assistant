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
import { Download } from "lucide-react";
import type { ReactNode } from "react";
import type { DashboardAnalytics } from "../utils/dashboardAnalytics";

const statusColors = ["#10B981", "#EF4444", "#38BDF8", "#F59E0B"];
const reportColors = ["#0F766E", "#F97316"];

function escapeCsv(value: string | number) {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function downloadCsv(fileName: string, headers: string[], rows: Array<Array<string | number>>) {
  const csv = [headers, ...rows].map((line) => line.map(escapeCsv).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function SectionHeader({
  eyebrow,
  title,
  description,
  onExport,
}: {
  eyebrow: string;
  title: string;
  description: string;
  onExport: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-[#047857]">{eyebrow}</p>
        <h3 className="mt-1 text-2xl font-bold text-[#064E3B]">{title}</h3>
        <p className="mt-1 max-w-3xl text-sm text-[#64748B]">{description}</p>
      </div>
      <button
        type="button"
        onClick={onExport}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#064E3B] px-3 py-2 text-sm font-semibold text-white hover:bg-[#047857]"
      >
        <Download size={16} /> Export section
      </button>
    </div>
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

function ReportTable({
  title,
  headers,
  rows,
  minWidth = 720,
}: {
  title: string;
  headers: string[];
  rows: Array<Array<string | number>>;
  minWidth?: number;
}) {
  const maxValue = Math.max(1, ...rows.map((row) => Number(row[row.length - 1]) || 0));
  return (
    <div className="overflow-hidden rounded-xl border border-[#D8E6E1] bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h4 className="text-sm font-bold uppercase tracking-wide text-[#064E3B]">{title}</h4>
        <button
          type="button"
          onClick={() => downloadCsv(`${title}.csv`.replace(/[^a-z0-9.-]+/gi, "-"), headers, rows)}
          className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
        >
          <Download size={13} /> {rows.length} rows
        </button>
      </div>
      <div className="grid gap-3 md:hidden">
        {rows.length ? rows.map((row, index) => {
          const value = Number(row[row.length - 1]) || 0;
          return (
            <div key={`${title}-card-${index}`} className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold text-[#0F172A]">{row[0]}</p>
                <span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-[#047857]">{value || row[row.length - 1]}</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-emerald-100">
                <div className="h-full rounded-full bg-[#0F766E]" style={{ width: `${Math.max(4, Math.min(100, (value / maxValue) * 100))}%` }} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#475569]">
                {headers.slice(1).map((header, cellIndex) => (
                  <div key={`${title}-card-${index}-${header}`}>
                    <dt className="font-semibold text-[#64748B]">{header}</dt>
                    <dd className="break-words text-[#334155]">{row[cellIndex + 1]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        }) : <p className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3 text-sm text-[#64748B]">No computed data available.</p>}
      </div>
      <div className="hidden max-h-[420px] max-w-full overflow-auto rounded-xl border border-slate-200 bg-white md:block">
        <table className="w-full table-auto text-sm" style={{ minWidth }}>
          <thead className="sticky top-0 z-10 bg-[#F0FDF4] text-left text-xs uppercase tracking-wide text-[#064E3B]">
            <tr>{headers.map((header) => <th key={header} className="max-w-xs p-3 align-top break-words whitespace-normal">{header}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row, index) => (
              <tr key={`${title}-${index}`} className="border-t border-[#D8E6E1]">
                {row.map((cell, cellIndex) => (
                  <td key={`${title}-${index}-${cellIndex}`} className="max-w-sm p-3 align-top break-words whitespace-normal text-[#334155]">{cell}</td>
                ))}
              </tr>
            )) : (
              <tr><td className="p-3 text-[#64748B]" colSpan={headers.length}>No computed data available.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MiniKpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-[#D8E6E1] bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{label}</p>
      <p className="mt-2 text-3xl font-bold text-[#064E3B]">{value.toLocaleString()}</p>
    </div>
  );
}

export function OperationalStatusSection({ analytics }: { analytics: DashboardAnalytics }) {
  const municipalityRows = analytics.byMunicipality.map((item) => [item.municipality, item.operational, item.closed, item.inactive, item.operational + item.closed + item.inactive]);
  const municipalityBars = analytics.byMunicipality.map((item) => ({
    municipality: item.municipality,
    Operational: item.operational,
    Closed: item.closed,
  }));

  return (
    <section className="space-y-5">
      <SectionHeader
        eyebrow="Operational Status"
        title="Operational vs Closed"
        description="Scan province-wide enterprise status first, then compare the same operational and closed counts by municipality."
        onExport={() => downloadCsv("operational-status.csv", ["Municipality", "Operational", "Closed", "Unknown", "Total"], municipalityRows)}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Operational vs Closed Summary">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={analytics.statusStats} dataKey="value" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={2}>
                {analytics.statusStats.map((entry, index) => (
                  <Cell key={entry.name} fill={statusColors[index % statusColors.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Operational vs Closed by Municipality">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={municipalityBars} margin={{ left: 0, right: 12, top: 8, bottom: 36 }}>
              <XAxis dataKey="municipality" angle={-25} textAnchor="end" interval={0} tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="Operational" fill="#10B981" radius={[5, 5, 0, 0]} />
              <Bar dataKey="Closed" fill="#EF4444" radius={[5, 5, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
      <ReportTable
        title="Operational vs Closed by Municipality"
        minWidth={760}
        headers={["Municipality", "Operational", "Closed", "Unknown", "Total"]}
        rows={municipalityRows}
      />
    </section>
  );
}

export function ProgramComplianceSection({ analytics }: { analytics: DashboardAnalytics }) {
  const gurDonut = [
    { name: "Conducted", value: analytics.grantUtilization.withReport },
    { name: "Not Conducted", value: analytics.grantUtilization.withoutReport },
  ];
  const trainingDonut = [
    { name: "Training Conducted", value: analytics.training.withTraining },
    { name: "No Training Conducted", value: analytics.training.withoutTraining },
  ];
  const gurRows = analytics.grantUtilization.byMunicipality.map((item) => [item.municipality, item.totalProjects, item.withGur, item.withoutGur]);
  const trainingRows = analytics.training.byMunicipality.map((item) => [item.municipality, item.projectParticipants, item.withTraining, item.withoutTraining]);
  const trainingTitleRows = analytics.training.byTrainingTitle.map((item) => [item.trainingTitle, item.participants]);

  return (
    <section className="space-y-5">
      <SectionHeader
        eyebrow="Program Compliance"
        title="GUR and Training Compliance"
        description="Review conducted versus not conducted compliance measures without mixing them into operational or enterprise-ranking tables."
        onExport={() => downloadCsv("program-compliance.csv", ["Report", "Category", "Value"], [
          ["GUR", "Conducted", analytics.grantUtilization.withReport],
          ["GUR", "Not Conducted", analytics.grantUtilization.withoutReport],
          ["Training", "Conducted", analytics.training.withTraining],
          ["Training", "Not Conducted", analytics.training.withoutTraining],
        ])}
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MiniKpi label="Projects with Grant Utilization Report" value={analytics.grantUtilization.withReport} />
        <MiniKpi label="Projects without Grant Utilization Report" value={analytics.grantUtilization.withoutReport} />
        <MiniKpi label="Participants with Training" value={analytics.training.withTraining} />
        <MiniKpi label="Participants without Training" value={analytics.training.withoutTraining} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Grant Utilization Report Conducted vs Not Conducted">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={gurDonut} dataKey="value" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={2}>
                {gurDonut.map((entry, index) => <Cell key={entry.name} fill={reportColors[index % reportColors.length]} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
        <ReportTable
          title="Grant Utilization Report by Municipality"
          minWidth={760}
          headers={["Municipality", "Total Projects", "With GUR", "Without GUR"]}
          rows={gurRows}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Training Conducted vs Not Conducted">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={trainingDonut} dataKey="value" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={2}>
                {trainingDonut.map((entry, index) => <Cell key={entry.name} fill={reportColors[index % reportColors.length]} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
        <ReportTable
          title="Training Report by Municipality"
          minWidth={760}
          headers={["Municipality", "Project Participants", "With Training", "Without Training"]}
          rows={trainingRows}
        />
      </div>
      <ReportTable
        title="Training Title Participation"
        minWidth={720}
        headers={["Training Title", "Participants"]}
        rows={trainingTitleRows}
      />
    </section>
  );
}

export function EnterpriseInsightsSection({ analytics }: { analytics: DashboardAnalytics }) {
  const topRows = analytics.topEnterpriseTypes.map((item) => [item.name, item.value]);
  const byMunicipalityRows = analytics.topEnterprisesByMunicipality.map((item) => [item.municipality, item.enterpriseProjectType, item.count]);
  const operationalRows = analytics.mostOperationalEnterprises.map((item) => [item.rank, item.enterpriseProjectType, item.operationalCount]);
  const operationalByMunicipalityRows = analytics.mostOperationalEnterprisesByMunicipality.map((item) => [item.municipality, item.enterpriseProjectType, item.operationalCount]);
  const closedRows = analytics.mostClosedEnterprises.map((item) => [item.rank, item.enterpriseProjectType, item.closedCount]);
  const closedByMunicipalityRows = analytics.mostClosedEnterprisesByMunicipality.map((item) => [item.municipality, item.enterpriseProjectType, item.closedCount]);

  return (
    <section className="space-y-5">
      <SectionHeader
        eyebrow="Enterprise Insights"
        title="Enterprise and Project Type Patterns"
        description="Compare the most implemented project types with the most operational and most closed enterprise/project type rankings."
        onExport={() => downloadCsv("enterprise-insights.csv", ["View", "Name", "Value"], [
          ...topRows.map((row) => ["Top Implemented", row[0], row[1]]),
          ...operationalRows.map((row) => ["Most Operational", row[1], row[2]]),
          ...closedRows.map((row) => ["Most Closed", row[1], row[2]]),
        ])}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Top 10 Most Implemented Enterprise / Project Types">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={analytics.topEnterpriseTypes} layout="vertical" margin={{ left: 24, right: 16, top: 8, bottom: 8 }}>
              <XAxis type="number" allowDecimals={false} />
              <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="value" fill="#0F766E" radius={[0, 5, 5, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ReportTable
          title="Top Enterprise / Project Type by Municipality"
          minWidth={760}
          headers={["Municipality", "Top Enterprise / Project Type", "Count"]}
          rows={byMunicipalityRows}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <ReportTable
          title="Most Operational Enterprises"
          headers={["Rank", "Enterprise / Project Type", "Operational Count"]}
          rows={operationalRows}
        />
        <ReportTable
          title="Most Operational Enterprise by Municipality"
          headers={["Municipality", "Enterprise / Project Type", "Operational Count"]}
          rows={operationalByMunicipalityRows}
        />
        <ReportTable
          title="Most Closed Enterprises"
          headers={["Rank", "Enterprise / Project Type", "Closed Count"]}
          rows={closedRows}
        />
        <ReportTable
          title="Most Closed Enterprise by Municipality"
          headers={["Municipality", "Enterprise / Project Type", "Closed Count"]}
          rows={closedByMunicipalityRows}
        />
      </div>
    </section>
  );
}

export function EnterpriseCharts({ analytics }: { analytics: DashboardAnalytics }) {
  return (
    <div className="space-y-8">
      <OperationalStatusSection analytics={analytics} />
      <ProgramComplianceSection analytics={analytics} />
      <EnterpriseInsightsSection analytics={analytics} />
    </div>
  );
}
