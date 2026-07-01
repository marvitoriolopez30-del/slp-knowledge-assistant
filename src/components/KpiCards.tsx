import { Activity, CheckCircle2, ClipboardList, Users } from "lucide-react";
import type { DashboardAnalytics } from "../utils/dashboardAnalytics";

const cardData = [
  { key: "totalParticipants", label: "Total participants", icon: Users, tone: "emerald" },
  { key: "totalAssociations", label: "Associations", icon: Users, tone: "amber" },
  { key: "individualEnterprises", label: "Individual enterprises", icon: ClipboardList, tone: "indigo" },
  { key: "operationalEnterprises", label: "Operational", icon: CheckCircle2, tone: "green" },
  { key: "closedEnterprises", label: "Closed", icon: Activity, tone: "rose" },
] as const;

const toneClasses: Record<string, string> = {
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-100",
  teal: "bg-teal-50 text-teal-700 border-teal-100",
  green: "bg-green-50 text-green-700 border-green-100",
  rose: "bg-rose-50 text-rose-700 border-rose-100",
  sky: "bg-sky-50 text-sky-700 border-sky-100",
  amber: "bg-amber-50 text-amber-700 border-amber-100",
  indigo: "bg-indigo-50 text-indigo-700 border-indigo-100",
  slate: "bg-slate-50 text-slate-700 border-slate-100",
};

export function KpiCards({ analytics }: { analytics: DashboardAnalytics }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {cardData.map((card) => {
        const Icon = card.icon;
        const value = analytics.summary[card.key];
        return (
          <div key={card.key} className="min-w-0 rounded-xl border border-[#D8E6E1] bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{card.label}</p>
                <p className="mt-2 text-3xl font-bold text-[#064E3B]">{Number(value || 0).toLocaleString()}</p>
              </div>
              <div className={`rounded-lg border p-2 ${toneClasses[card.tone]}`}>
                <Icon size={20} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
