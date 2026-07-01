import L from "leaflet";
import { useMemo, useState } from "react";
import { CircleMarker, MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { BarangayAnalyticsRow, MunicipalityName, MunicipalityStat } from "../utils/dashboardAnalytics";

const statusColor = {
  operational: "#10B981",
  closed: "#DC2626",
  unknown: "#F59E0B",
};

const auroraMunicipalities: Array<{ name: MunicipalityName; lat: number; lng: number }> = [
  { name: "Baler", lat: 15.7589, lng: 121.5625 },
  { name: "Casiguran", lat: 16.2819, lng: 122.125 },
  { name: "Dilasag", lat: 16.3989, lng: 122.2228 },
  { name: "Dinalungan", lat: 16.1406, lng: 121.7606 },
  { name: "Dingalan", lat: 15.3897, lng: 121.3928 },
  { name: "Dipaculao", lat: 15.9833, lng: 121.6333 },
  { name: "Maria Aurora", lat: 15.7967, lng: 121.4733 },
  { name: "San Luis", lat: 15.7167, lng: 121.5167 },
];

const municipalityBounds = L.latLngBounds(auroraMunicipalities.map((item) => [item.lat, item.lng]));

function emptyMunicipalityStat(municipality: MunicipalityName): MunicipalityStat {
  return {
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
    mostOperationalEnterprise: "No data yet",
    mostClosedEnterprise: "No data yet",
    withGrantUtilizationReport: 0,
    withoutGrantUtilizationReport: 0,
    withTraining: 0,
    withoutTraining: 0,
  };
}

function markerIcon(active: boolean) {
  return L.divIcon({
    className: "",
    html: `
      <div style="
        width:${active ? 24 : 18}px;
        height:${active ? 24 : 18}px;
        border-radius:9999px;
        background:${active ? "#D4AF37" : "#047857"};
        border:3px solid white;
        box-shadow:0 8px 18px rgba(6,78,59,.28);
        outline:${active ? "3px solid rgba(212,175,55,.35)" : "0 solid transparent"};
      "></div>
    `,
    iconSize: [active ? 24 : 18, active ? 24 : 18],
    iconAnchor: [active ? 12 : 9, active ? 12 : 9],
    popupAnchor: [0, active ? -12 : -9],
  });
}

function FitAuroraBounds() {
  const map = useMap();
  map.fitBounds(municipalityBounds, { padding: [28, 28] });
  return null;
}

function ZoomTracker({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const map = useMapEvents({
    zoomend: () => onZoomChange(map.getZoom()),
  });
  return null;
}

export function AnalyticsMap({
  municipalities,
  barangayAnalytics,
  selectedMunicipality,
  onSelectMunicipality,
}: {
  municipalities: MunicipalityStat[];
  barangayAnalytics: BarangayAnalyticsRow[];
  selectedMunicipality: MunicipalityName;
  onSelectMunicipality: (municipality: MunicipalityName) => void;
}) {
  const [reportView, setReportView] = useState<"summary" | "barangay">("summary");
  const [barangaySearch, setBarangaySearch] = useState("");
  const [selectedBarangayKey, setSelectedBarangayKey] = useState("");
  const [mapZoom, setMapZoom] = useState(9);
  const municipalityStats = new Map(municipalities.map((item) => [item.municipality, item]));
  const selected = municipalityStats.get(selectedMunicipality) || emptyMunicipalityStat(selectedMunicipality);
  const barangaysForMunicipality = useMemo(
    () => barangayAnalytics.filter((item) => item.municipality === selectedMunicipality),
    [barangayAnalytics, selectedMunicipality],
  );
  const filteredBarangays = useMemo(() => {
    const needle = barangaySearch.trim().toLowerCase();
    if (!needle) return barangaysForMunicipality;
    return barangaysForMunicipality.filter((item) => item.barangay.toLowerCase().includes(needle));
  }, [barangaySearch, barangaysForMunicipality]);
  const topBarangays = useMemo(
    () => [...barangaysForMunicipality].sort((a, b) => b.totalParticipants + b.totalEnterprises - (a.totalParticipants + a.totalEnterprises)).slice(0, 5),
    [barangaysForMunicipality],
  );
  const selectedBarangay =
    barangaysForMunicipality.find((item) => barangayRowKey(item) === selectedBarangayKey) ||
    filteredBarangays[0] ||
    barangaysForMunicipality[0];
  const maxBarangayTotal = Math.max(1, ...topBarangays.map((item) => item.totalParticipants + item.totalEnterprises));
  const barangayPins = useMemo(
    () => barangaysForMunicipality.map((item, index) => ({ ...item, ...barangayCoordinate(item, index, barangaysForMunicipality.length) })),
    [barangaysForMunicipality],
  );
  const showBarangayPins = barangayPins.length > 0 && (Boolean(selectedMunicipality) || mapZoom >= 11);
  const hasSelectedData = Boolean(
    selected.totalParticipants ||
      selected.totalAssociations ||
      selected.totalEnterprises ||
      selected.individualEnterprises ||
      selected.operational ||
      selected.closed ||
      selected.inactive ||
      selected.withGrantUtilizationReport ||
      selected.withoutGrantUtilizationReport ||
      selected.withTraining ||
      selected.withoutTraining,
  );

  return (
    <div className="rounded-2xl border border-[#D8E6E1] bg-white/95 p-4 shadow">
      <div className="mb-4">
        <h3 className="text-xl font-bold text-[#064E3B]">Aurora Province SLP Map Analytics</h3>
        <p className="text-sm text-[#64748B]">Explore SLP performance and coverage across Aurora municipalities.</p>
        <p className="mt-1 text-sm font-semibold text-[#047857]">Click a municipality marker to view local SLP analytics.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-2xl bg-[#ECFDF5] p-3">
          <div className="overflow-hidden rounded-2xl border border-[#CFE8DE] shadow-sm" style={{ height: "clamp(300px, 38vw, 430px)" }}>
            <MapContainer
              center={[15.9, 121.75]}
              zoom={9}
              scrollWheelZoom={false}
              className="h-full w-full"
              zoomControl
            >
              <FitAuroraBounds />
              <ZoomTracker onZoomChange={setMapZoom} />
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {auroraMunicipalities.map((item) => {
                const stats = municipalityStats.get(item.name) || emptyMunicipalityStat(item.name);
                const active = selectedMunicipality === item.name;
                return (
                  <Marker
                    key={item.name}
                    position={[item.lat, item.lng]}
                    icon={markerIcon(active)}
                    title={item.name}
                    eventHandlers={{ click: () => onSelectMunicipality(item.name) }}
                  >
                    <Popup>
                      <div className="min-w-[220px] text-sm text-[#0F172A]">
                        <p className="text-base font-bold text-[#064E3B]">{stats.municipality}</p>
                        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                          <PopupMetric label="Participants" value={stats.totalParticipants} />
                          <PopupMetric label="Associations" value={stats.totalAssociations} />
                          <PopupMetric label="Individual enterprises" value={stats.individualEnterprises} />
                          <PopupMetric label="Operational" value={stats.operational} />
                          <PopupMetric label="Closed" value={stats.closed} />
                          <PopupMetric label="With GUR" value={stats.withGrantUtilizationReport || 0} />
                          <PopupMetric label="Without GUR" value={stats.withoutGrantUtilizationReport || 0} />
                          <PopupMetric label="With training" value={stats.withTraining || 0} />
                          <PopupMetric label="Without training" value={stats.withoutTraining || 0} />
                        </div>
                        <PopupText label="Top project" value={stats.topEnterpriseType} />
                        <PopupText label="Most operational" value={stats.mostOperationalEnterprise} />
                        <PopupText label="Most closed" value={stats.mostClosedEnterprise} />
                      </div>
                    </Popup>
                  </Marker>
                );
              })}
              {showBarangayPins && barangayPins.map((item) => (
                <CircleMarker
                  key={`barangay-pin-${barangayRowKey(item)}`}
                  center={[item.lat, item.lng]}
                  radius={5}
                  pathOptions={{ color: "#064E3B", fillColor: "#D4AF37", fillOpacity: 0.82, weight: 1.5 }}
                  eventHandlers={{ click: () => { setSelectedBarangayKey(barangayRowKey(item)); setReportView("barangay"); } }}
                >
                  <Popup>
                    <div className="min-w-[230px] text-sm text-[#0F172A]">
                      <p className="text-base font-bold text-[#064E3B]">{item.barangay}</p>
                      <p className="text-xs font-semibold text-[#64748B]">{item.municipality}</p>
                      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                        <PopupMetric label="Participants" value={item.totalParticipants} />
                        <PopupMetric label="Associations" value={item.totalAssociations} />
                        <PopupMetric label="Individual enterprises" value={item.individualEnterprises} />
                        <PopupMetric label="Operational" value={item.operational} />
                        <PopupMetric label="Closed" value={item.closed} />
                        <PopupMetric label="With GUR" value={item.withGrantUtilizationReport} />
                        <PopupMetric label="Without GUR" value={item.withoutGrantUtilizationReport} />
                        <PopupMetric label="With training" value={item.withTraining} />
                        <PopupMetric label="Without training" value={item.withoutTraining} />
                        <PopupMetric label="Annual assessment" value={item.annualAssessment} />
                        <PopupMetric label="Org assessment" value={item.organizationalAssessment} />
                      </div>
                    </div>
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>
          <p className="mt-2 text-xs text-[#64748B]">Barangay pins appear for the selected municipality and stay hidden from province-wide clutter.</p>
        </div>

        <div className="space-y-3">
          <div className="rounded-2xl border border-[#D8E6E1] bg-[#F0FDF4] p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">Selected municipality</p>
            <h4 className="mt-1 text-2xl font-bold text-[#064E3B]">{selected.municipality}</h4>
            <div className="mt-3 grid grid-cols-2 rounded-xl border border-[#D8E6E1] bg-white p-1 text-xs font-semibold">
              <button
                type="button"
                onClick={() => setReportView("summary")}
                className={`rounded-lg px-2 py-2 transition ${reportView === "summary" ? "bg-[#047857] text-white" : "text-[#064E3B] hover:bg-[#ECFDF5]"}`}
              >
                Municipality Summary
              </button>
              <button
                type="button"
                onClick={() => setReportView("barangay")}
                className={`rounded-lg px-2 py-2 transition ${reportView === "barangay" ? "bg-[#047857] text-white" : "text-[#064E3B] hover:bg-[#ECFDF5]"}`}
              >
                Barangay Breakdown
              </button>
            </div>

            {reportView === "summary" ? (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <Metric label="Participants" value={selected.totalParticipants} />
                  <Metric label="Associations" value={selected.totalAssociations} />
                  <Metric label="Individual enterprises" value={selected.individualEnterprises} />
                  <Metric label="With GUR" value={selected.withGrantUtilizationReport || 0} />
                  <Metric label="Without GUR" value={selected.withoutGrantUtilizationReport || 0} />
                  <Metric label="With training" value={selected.withTraining || 0} />
                  <Metric label="Without training" value={selected.withoutTraining || 0} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                  <span className="rounded-full px-2 py-1 text-white" style={{ backgroundColor: statusColor.operational }}>Operational {selected.operational}</span>
                  <span className="rounded-full px-2 py-1 text-white" style={{ backgroundColor: statusColor.closed }}>Closed {selected.closed}</span>
                  <span className="rounded-full px-2 py-1 text-white" style={{ backgroundColor: statusColor.unknown }}>Pending/Unknown {selected.inactive}</span>
                </div>
                <p className="mt-3 text-sm text-[#64748B]">Top Project: <span className="font-semibold text-[#0F172A]">{selected.topEnterpriseType || "No data yet"}</span></p>
                <p className="mt-2 text-sm text-[#64748B]">Most operational: <span className="font-semibold text-[#0F172A]">{selected.mostOperationalEnterprise || "No data yet"}</span></p>
                <p className="mt-2 text-sm text-[#64748B]">Most closed: <span className="font-semibold text-[#0F172A]">{selected.mostClosedEnterprise || "No data yet"}</span></p>
                {!hasSelectedData && <p className="mt-3 rounded-lg bg-white px-3 py-2 text-sm text-[#64748B]">No data available yet for this municipality.</p>}
              </>
            ) : (
              <div className="mt-3 space-y-3">
                <input
                  type="search"
                  value={barangaySearch}
                  onChange={(event) => setBarangaySearch(event.target.value)}
                  placeholder="Search barangay..."
                  className="w-full rounded-xl border border-[#CFE8DE] bg-white px-3 py-2 text-sm text-[#0F172A] outline-none focus:border-[#047857] focus:ring-2 focus:ring-[#047857]/20"
                />

                <div className="rounded-xl bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">Top barangays</p>
                  <div className="mt-2 space-y-2">
                    {topBarangays.length ? topBarangays.map((item) => {
                      const total = item.totalParticipants + item.totalEnterprises;
                      return (
                        <button key={barangayRowKey(item)} type="button" onClick={() => setSelectedBarangayKey(barangayRowKey(item))} className="block w-full text-left">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="font-semibold text-[#064E3B]">{item.barangay}</span>
                            <span className="text-[#64748B]">{total.toLocaleString()}</span>
                          </div>
                          <div className="mt-1 h-2 overflow-hidden rounded-full bg-[#E2E8F0]">
                            <div className="h-full rounded-full bg-[#047857]" style={{ width: `${Math.max(6, Math.round((total / maxBarangayTotal) * 100))}%` }} />
                          </div>
                        </button>
                      );
                    }) : <p className="text-sm text-[#64748B]">Barangay not available.</p>}
                  </div>
                </div>

                <div className="max-h-56 space-y-2 overflow-auto pr-1">
                  {filteredBarangays.length ? filteredBarangays.map((item) => {
                    const active = selectedBarangay && barangayRowKey(selectedBarangay) === barangayRowKey(item);
                    return (
                      <button
                        key={barangayRowKey(item)}
                        type="button"
                        onClick={() => setSelectedBarangayKey(barangayRowKey(item))}
                        className={`w-full rounded-xl border px-3 py-2 text-left transition ${active ? "border-[#D4AF37] bg-[#D4AF37]/15" : "border-[#D8E6E1] bg-white hover:bg-[#ECFDF5]"}`}
                      >
                        <span className="block text-sm font-bold text-[#064E3B]">{item.barangay}</span>
                        <span className="mt-1 block text-xs text-[#64748B]">
                          {item.totalParticipants.toLocaleString()} participants - {item.totalAssociations.toLocaleString()} associations - {item.individualEnterprises.toLocaleString()} individual enterprises
                        </span>
                      </button>
                    );
                  }) : <p className="rounded-xl bg-white px-3 py-2 text-sm text-[#64748B]">No barangay records found for this municipality.</p>}
                </div>

                {selectedBarangay && (
                  <div className="rounded-xl border border-[#D8E6E1] bg-white p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">Barangay details</p>
                    <h5 className="mt-1 text-lg font-bold text-[#064E3B]">{selectedBarangay.barangay}</h5>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Metric label="Participants" value={selectedBarangay.totalParticipants} />
                      <Metric label="Associations" value={selectedBarangay.totalAssociations} />
                      <Metric label="Individual enterprises" value={selectedBarangay.individualEnterprises} />
                      <Metric label="With GUR" value={selectedBarangay.withGrantUtilizationReport} />
                      <Metric label="With training" value={selectedBarangay.withTraining} />
                      <Metric label="Annual assessment" value={selectedBarangay.annualAssessment} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                      <span className="rounded-full px-2 py-1 text-white" style={{ backgroundColor: statusColor.operational }}>Operational {selectedBarangay.operational}</span>
                      <span className="rounded-full px-2 py-1 text-white" style={{ backgroundColor: statusColor.closed }}>Closed {selectedBarangay.closed}</span>
                      <span className="rounded-full px-2 py-1 text-white" style={{ backgroundColor: statusColor.unknown }}>Pending/Unknown {selectedBarangay.pendingUnknown}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-1 text-center text-xs">
                      <MiniCoverage label="1st" value={selectedBarangay.monitoringFirstVisit} />
                      <MiniCoverage label="2nd" value={selectedBarangay.monitoringSecondVisit} />
                      <MiniCoverage label="3rd" value={selectedBarangay.monitoringThirdVisit} />
                      <MiniCoverage label="4th" value={selectedBarangay.monitoringFourthVisit} />
                    </div>
                    <p className="mt-3 text-sm text-[#64748B]">Top project: <span className="font-semibold text-[#0F172A]">{selectedBarangay.topEnterpriseType}</span></p>
                    <p className="mt-2 text-sm text-[#64748B]">Most operational: <span className="font-semibold text-[#0F172A]">{selectedBarangay.mostOperationalEnterprise}</span></p>
                    <p className="mt-2 text-sm text-[#64748B]">Most closed: <span className="font-semibold text-[#0F172A]">{selectedBarangay.mostClosedEnterprise}</span></p>
                    <p className="mt-2 text-xs text-[#64748B]">Org Assessment: <span className="font-semibold text-[#0F172A]">{selectedBarangay.organizationalAssessment.toLocaleString()}</span></p>
                    <p className="mt-1 text-xs text-[#64748B]">Sources: <span className="font-semibold text-[#0F172A]">{selectedBarangay.sourceFiles.slice(0, 2).join("; ") || "No matching record"}</span></p>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
            {auroraMunicipalities.map((item) => {
              const stats = municipalityStats.get(item.name) || emptyMunicipalityStat(item.name);
              return (
                <button
                  key={item.name}
                  onClick={() => onSelectMunicipality(item.name)}
                  className={`min-h-12 rounded-xl border px-3 py-2 text-left text-sm font-semibold transition ${
                    selectedMunicipality === item.name
                      ? "border-[#D4AF37] bg-[#D4AF37]/15 text-[#064E3B]"
                      : "border-[#D8E6E1] bg-white text-[#0F172A] hover:bg-[#F0FDF4]"
                  }`}
                >
                  {item.name}
                  <span className="block text-xs font-normal text-[#64748B]">{stats.totalEnterprises} project{stats.totalEnterprises === 1 ? "" : "s"}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-white px-3 py-2">
      <p className="text-xs text-[#64748B]">{label}</p>
      <p className="text-lg font-bold text-[#064E3B]">{value.toLocaleString()}</p>
    </div>
  );
}

function MiniCoverage({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-[#ECFDF5] px-2 py-2">
      <p className="font-semibold text-[#047857]">{label}</p>
      <p className="font-bold text-[#064E3B]">{value.toLocaleString()}</p>
    </div>
  );
}

function barangayRowKey(item: BarangayAnalyticsRow) {
  return `${item.municipality}:${item.normalizedBarangay || item.barangay}`;
}

function barangayCoordinate(item: BarangayAnalyticsRow, index: number, total: number) {
  const municipality = auroraMunicipalities.find((row) => row.name === item.municipality) || auroraMunicipalities[0];
  const key = `${item.municipality}-${item.normalizedBarangay || item.barangay}`;
  const hash = Array.from(key).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const ring = 0.018 + (hash % 7) * 0.003;
  const angle = ((index / Math.max(total, 1)) * Math.PI * 2) + ((hash % 23) / 23);
  return {
    lat: municipality.lat + Math.sin(angle) * ring,
    lng: municipality.lng + Math.cos(angle) * ring,
  };
}

function PopupMetric({ label, value }: { label: string; value: number }) {
  return (
    <>
      <span className="text-[#64748B]">{label}</span>
      <strong className="text-right text-[#064E3B]">{value.toLocaleString()}</strong>
    </>
  );
}

function PopupText({ label, value }: { label: string; value?: string }) {
  return (
    <p className="mt-2 text-xs text-[#64748B]">
      {label}: <span className="font-semibold text-[#0F172A]">{value || "No data yet"}</span>
    </p>
  );
}
