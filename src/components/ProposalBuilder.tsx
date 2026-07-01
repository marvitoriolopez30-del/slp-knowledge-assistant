import React, { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileText, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { renderAsync } from "docx-preview";
import { proposalSchemas, proposalTypeOptions, type ProposalType } from "../proposalBuilder/proposalSchemas";
import { apiFetch } from "../utils/apiClient";

type AnyRow = Record<string, any>;

const AURORA_MUNICIPALITIES = ["Baler", "Casiguran", "Dilasag", "Dinalungan", "Dingalan", "Dipaculao", "Maria Aurora", "San Luis"];
const BARANGAYS_BY_MUNICIPALITY: Record<string, string[]> = {
  Baler: ["Barangay I", "Barangay II", "Barangay III", "Barangay IV", "Barangay V", "Buhangin", "Calabuanan", "Obligacion", "Pingit", "Reserva", "Sabang", "Suklayin", "Zabali"],
  Casiguran: ["Bianoan", "Calabgan", "Calangcuasan", "Cozo", "Dibacong", "Dibagat", "Ditinagyan", "Esperanza", "Esteves", "Lual", "Marikit", "San Ildefonso", "Tabas"],
  Dilasag: ["Dibulo", "Dicabasan", "Dilaguidi", "Dimaseset", "Diniog", "Esperanza", "Lawang", "Maligaya", "Manggitahan", "Masagana", "Ura"],
  Dinalungan: ["Abuleg", "Dibaraybay", "Ditawini", "Mapalad", "Nipoo", "Paleg", "Simbahan", "Zone I", "Zone II"],
  Dingalan: ["Aplaya", "Butas na Bato", "Cabog", "Caragsacan", "Davildavilan", "Dikapanikian", "Ibona", "Paltic", "Poblacion", "Tanawan", "Umiray"],
  Dipaculao: ["Bayabas", "Borlongan", "Buenavista", "Calaocan", "Diamanen", "Dianed", "Diarabasin", "Dibutunan", "Dimabuno", "Dinadiawan", "Ditale", "Gupa", "Ipil", "Laboy", "Lipit", "Lobbot", "Maligaya", "Mijares", "Mucdol", "North Poblacion", "Puangi", "Salay", "Sapangkawayan", "South Poblacion", "Toytoyan"],
  "Maria Aurora": ["Alcala", "Bagtu", "Bangco", "Bannawag", "Baubo", "Bayanihan", "Bazal", "Cabituculan East", "Cabituculan West", "Debucao", "Decoliat", "Detailen", "Diaat", "Dialatman", "Diaman", "Dianawan", "Dikildit", "Dimanpudso", "Diome", "Estonilo", "Florida", "Galintuja", "Malasin", "Ponglo", "Quirino", "Ramada", "San Joaquin", "San Jose", "San Juan", "San Leonardo", "Santa Lucia", "Santo Tomas", "Suguit", "Villa Aurora"],
  "San Luis": ["Bacong", "Barangay I", "Barangay II", "Barangay III", "Barangay IV", "Dibalo", "Dibayabay", "Dikapinisan", "Dimanayat", "Diteki", "Ditumabo", "L. Pimentel", "Nonong Senior", "Real", "San Isidro", "San Jose", "San Juan", "Zarah"],
};

const PROFILE_STORAGE_KEY = "slp-local-profile-v1";
const proposalDraftKey = (proposalType: ProposalType) => `proposal_builder_draft_${proposalType}`;
const id = (prefix = "line") => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};
const peso = (value: any) => Number(value || 0).toLocaleString("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 2 });
const plainNumber = (value: any, fractionDigits = 2) => Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
const numberValue = (value: any) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function blankForm(proposalType: ProposalType | "" = "") {
  return {
    proposalId: "",
    proposalType,
    templateType: proposalType,
    title: "",
    municipality: "Baler",
    barangay: "",
    projectName: "",
    associationParticipantProjectName: "",
    enterpriseType: "",
    participantId: "",
    participantAddress: "",
    microenterpriseLocation: "",
    requestedScfAmount: 0,
    dswdFunding: 0,
    partnerFunding: 0,
    objectives: "",
    dateOrganized: "",
    totalMembers: 0,
    slpaPresident: "",
    contactNumber: "",
    targetMarket: "",
    targetStartDate: "",
    productionCycleDays: 1,
    mandatorySavingsRate: 0,
    mandatorySavings: 0,
    preparedBy: "",
    recommendedBy: "",
    approvedBy: "",
    members: [],
    rawMaterials: [],
    toolsEquipment: [],
    manpower: [],
    otherExpenses: [],
    grossSales: [],
    scfSchedule: [],
    modalityApplications: [],
    partnerCounterparts: [],
  };
}

async function apiJson(path: string, init?: RequestInit) {
  const res = await apiFetch(path, init, { endpointName: "Proposal Builder" });
  const text = await res.text();
  let data: AnyRow = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Proposal API returned non-JSON response (${res.status}). ${text.slice(0, 160)}`);
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || "Proposal Builder request failed.");
  return data;
}

function currentProfileId() {
  try {
    const profile = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "null");
    return profile?.id || "";
  } catch {
    return "";
  }
}

function currentProfileRole() {
  try {
    const profile = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "null");
    return String(profile?.role || "");
  } catch {
    return "";
  }
}

function rawMaterialLine(row: AnyRow) {
  const quantity = numberValue(row.quantity);
  const unitCost = numberValue(row.unitCost);
  const frequency = numberValue(row.frequency || 1) || 1;
  return { ...row, quantity, unitCost, frequency, totalCost: quantity * unitCost * frequency };
}

function toolLine(row: AnyRow) {
  const quantity = numberValue(row.quantity);
  const unitCost = numberValue(row.unitCost);
  const totalCost = quantity * unitCost;
  const lifeSpan = numberValue(row.lifeSpan);
  const productionCycle = numberValue(row.productionCycle);
  return { ...row, quantity, unitCost, totalCost, lifeSpan, productionCycle, depreciationCost: lifeSpan ? (totalCost / lifeSpan) * productionCycle : 0 };
}

function salesLine(row: AnyRow) {
  const quantity = numberValue(row.quantity);
  const saleMode = row.saleMode === "weight_based" ? "weight_based" : "simple";
  const salePricePerUnit = numberValue(row.salePricePerUnit);
  const averageWeight = numberValue(row.averageWeight);
  const pricePerKilo = numberValue(row.pricePerKilo);
  const totalKilos = quantity * averageWeight;
  const totalSales = saleMode === "weight_based" ? totalKilos * pricePerKilo : quantity * salePricePerUnit;
  const salePriceDisplayText = saleMode === "weight_based"
    ? `${plainNumber(quantity, 0)} x ${plainNumber(averageWeight, 2).replace(/\.00$/, "")} ave weight\n${plainNumber(totalKilos, 0)} x ${plainNumber(pricePerKilo, 2)}/kl`
    : peso(salePricePerUnit);
  return { ...row, productName: row.productName || row.product || "", product: row.productName || row.product || "", quantity, saleMode, salePricePerUnit, averageWeight, pricePerKilo, totalKilos, salePriceDisplayText, totalSales };
}

function computeForm(form: AnyRow): AnyRow {
  const productionCycleDays = numberValue(form.productionCycleDays || 1) || 1;
  const rawMaterials = (form.rawMaterials || []).map(rawMaterialLine);
  const toolsEquipment = (form.toolsEquipment || []).map((row: AnyRow) => toolLine({ ...row, productionCycle: productionCycleDays }));
  const manpower = (form.manpower || []).map((row: AnyRow) => ({ ...row, dailyWage: numberValue(row.dailyWage) }));
  const otherExpenses = (form.otherExpenses || []).map((row: AnyRow) => ({ ...row, totalCost: numberValue(row.totalCost) }));
  const grossSales = (form.grossSales || []).map(salesLine);
  const modalityApplications = (form.modalityApplications || []).map((row: AnyRow) => ({ ...row, amount: numberValue(row.amount), participants: numberValue(row.participants) }));
  const partnerCounterparts = (form.partnerCounterparts || []).map((row: AnyRow) => ({ ...row, amount: numberValue(row.amount) }));
  const rawMaterialsSubtotal = rawMaterials.reduce((sum: number, row: AnyRow) => sum + numberValue(row.totalCost), 0);
  const toolsEquipmentSubtotal = toolsEquipment.reduce((sum: number, row: AnyRow) => sum + numberValue(row.totalCost), 0);
  const depreciationTotal = toolsEquipment.reduce((sum: number, row: AnyRow) => sum + numberValue(row.depreciationCost), 0);
  const totalDailyWage = manpower.reduce((sum: number, row: AnyRow) => sum + numberValue(row.dailyWage), 0);
  const manpowerTotal = totalDailyWage * productionCycleDays;
  const otherExpensesTotal = otherExpenses.reduce((sum: number, row: AnyRow) => sum + numberValue(row.totalCost), 0);
  const grossSalesTotal = grossSales.reduce((sum: number, row: AnyRow) => sum + numberValue(row.totalSales), 0);
  const grossProfit = grossSalesTotal - rawMaterialsSubtotal;
  const totalOperatingExpense = manpowerTotal + depreciationTotal + otherExpensesTotal;
  const grossProfitAfterOperatingExpense = grossProfit - totalOperatingExpense;
  const savingsRate = numberValue(form.mandatorySavingsRate) > 1 ? numberValue(form.mandatorySavingsRate) / 100 : numberValue(form.mandatorySavingsRate);
  const mandatorySavings = numberValue(form.mandatorySavings) || (grossProfitAfterOperatingExpense * savingsRate);
  const netProfit = grossProfitAfterOperatingExpense - mandatorySavings;
  const mafGrandTotal = rawMaterialsSubtotal + toolsEquipmentSubtotal + manpowerTotal + otherExpensesTotal;
  const modalityTotal = modalityApplications.reduce((sum: number, row: AnyRow) => sum + numberValue(row.amount), 0);
  const partnerCounterpartTotal = partnerCounterparts.reduce((sum: number, row: AnyRow) => sum + numberValue(row.amount), 0);
  const dswdFunding = numberValue(form.dswdFunding || form.requestedScfAmount || modalityTotal);
  const partnerFunding = numberValue(form.partnerFunding);
  const totalProjectCost = form.proposalType === "MUNGKAHING_PROYEKTO" ? dswdFunding + partnerFunding : mafGrandTotal;
  const existingScf = form.scfSchedule || [];
  const findSchedule = (lineItemId: string) => existingScf.find((row: AnyRow) => row.lineItemId === lineItemId)?.schedule || "";
  const customScf = existingScf.filter((row: AnyRow) => !String(row.lineItemId || "").startsWith("auto-scf-"));
  const scfSchedule = [
    { lineItemId: "auto-scf-raw-materials", expense: "Raw Materials", amount: rawMaterialsSubtotal, schedule: findSchedule("auto-scf-raw-materials") },
    { lineItemId: "auto-scf-tools-equipment", expense: "Tools and Equipment", amount: toolsEquipmentSubtotal, schedule: findSchedule("auto-scf-tools-equipment") },
    ...(otherExpensesTotal ? [{ lineItemId: "auto-scf-other-expenses", expense: "Other Expenses", amount: otherExpensesTotal, schedule: findSchedule("auto-scf-other-expenses") }] : []),
    ...customScf,
  ];
  return { ...form, templateType: form.proposalType, rawMaterials, toolsEquipment, manpower, otherExpenses, grossSales, modalityApplications, partnerCounterparts, productionCycleDays, dswdFunding, partnerFunding, rawMaterialsSubtotal, toolsEquipmentSubtotal, depreciationTotal, totalDailyWage, manpowerTotal, otherExpensesTotal, grossSalesTotal, grossProfit, totalOperatingExpense, grossProfitAfterOperatingExpense, mandatorySavings, netProfit, grandTotal: totalProjectCost, totalProjectCost, modalityTotal, partnerCounterpartTotal, scfSchedule };
}

function requiredFieldErrors(form: AnyRow) {
  const schema = form.proposalType ? proposalSchemas[form.proposalType as ProposalType] : null;
  if (!schema) return ["Proposal Type"];
  return schema.requiredFields
    .filter((key) => String(form[key] ?? "").trim() === "")
    .map((key) => schema.fields.find((field) => field.key === key)?.label || key);
}

export function ProposalBuilder() {
  const [section, setSection] = useState<"create" | "inventory" | "raw" | "tools" | "review">("create");
  const [templates, setTemplates] = useState<AnyRow[]>([]);
  const [rawCatalog, setRawCatalog] = useState<AnyRow[]>([]);
  const [toolsCatalog, setToolsCatalog] = useState<AnyRow[]>([]);
  const [inventory, setInventory] = useState<AnyRow[]>([]);
  const [form, setForm] = useState<AnyRow>(() => blankForm());
  const [reviewDraft, setReviewDraft] = useState<AnyRow | null>(null);
  const [message, setMessage] = useState("");
  const [inventorySearch, setInventorySearch] = useState("");
  const [inventoryTemplate, setInventoryTemplate] = useState("");
  const [inventoryStatus, setInventoryStatus] = useState("");
  const [inventoryMunicipality, setInventoryMunicipality] = useState("");
  const suppressNextAutoSave = useRef(false);
  const computed = useMemo(() => computeForm(form), [form]);
  const selectedSchema = computed.proposalType ? proposalSchemas[computed.proposalType as ProposalType] : null;
  const isMaf = computed.proposalType === "MAF";
  const isMp = computed.proposalType === "MUNGKAHING_PROYEKTO";
  const canDeleteProposals = currentProfileRole() === "admin";
  const selectedTemplateRecord = computed.proposalType ? templates.find((item) => item.templateType === computed.proposalType) : null;
  const selectedTemplateInvalid = Boolean(selectedSchema && (!selectedTemplateRecord || selectedTemplateRecord.isValid === false));

  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    if (!computed.proposalType) return;
    if (suppressNextAutoSave.current) {
      suppressNextAutoSave.current = false;
      return;
    }
    localStorage.setItem(proposalDraftKey(computed.proposalType as ProposalType), JSON.stringify(computed));
  }, [computed]);

  async function loadAll() {
    try {
      const [templateData, rawData, toolData, inventoryData] = await Promise.all([
        apiJson("/api/proposals/templates"),
        apiJson("/api/proposals/catalog/raw-materials"),
        apiJson("/api/proposals/catalog/tools-equipment"),
        apiJson("/api/proposals/inventory"),
      ]);
      setTemplates(templateData.templates || []);
      setRawCatalog(rawData.items || []);
      setToolsCatalog(toolData.items || []);
      setInventory(inventoryData.proposals || []);
    } catch (error: any) {
      setMessage(error.message);
    }
  }

  function patchForm(patch: AnyRow) {
    setForm((current) => computeForm({ ...current, ...patch }));
  }

  function setProposalType(proposalType: ProposalType) {
    setForm(loadDraftForm(proposalType) || computeForm(blankForm(proposalType)));
    setMessage("");
  }

  function loadDraftForm(proposalType: ProposalType) {
    try {
      const draft = JSON.parse(localStorage.getItem(proposalDraftKey(proposalType)) || "null");
      return draft ? computeForm({ ...blankForm(proposalType), ...draft, proposalType, templateType: proposalType }) : null;
    } catch {
      return null;
    }
  }

  function saveDraftForm() {
    if (!computed.proposalType) return setMessage("Select a proposal type before saving a draft.");
    localStorage.setItem(proposalDraftKey(computed.proposalType as ProposalType), JSON.stringify(computed));
    setMessage("Draft saved.");
  }

  function restoreDraftForm() {
    if (!computed.proposalType) return setMessage("Select a proposal type before loading a draft.");
    const draft = loadDraftForm(computed.proposalType as ProposalType);
    if (!draft) return setMessage("No saved draft found for this proposal type.");
    setForm(draft);
    setMessage("Draft loaded.");
  }

  function clearDraftForm() {
    if (!computed.proposalType) return setMessage("Select a proposal type before clearing a draft.");
    localStorage.removeItem(proposalDraftKey(computed.proposalType as ProposalType));
    suppressNextAutoSave.current = true;
    setForm(computeForm(blankForm(computed.proposalType as ProposalType)));
    setMessage("Draft cleared.");
  }

  function fillSampleData() {
    if (!computed.proposalType) return setMessage("Select a proposal type before filling sample data.");
    setForm(sampleProposalForm(computed.proposalType as ProposalType));
    setMessage("Sample data filled.");
  }

  function setRow(sectionName: string, rowId: string, patch: AnyRow) {
    setForm((current) => computeForm({ ...current, [sectionName]: (current[sectionName] || []).map((row: AnyRow) => row.lineItemId === rowId ? { ...row, ...patch } : row) }));
  }

  function addRow(sectionName: string, item: AnyRow = {}) {
    const base = { remarks: "", ...item, lineItemId: id(`${sectionName}-${form.proposalId || "new"}`) };
    const row = sectionName === "rawMaterials"
      ? rawMaterialLine({ catalogItemId: item.itemId || "", itemName: item.itemName || "", category: item.category || "", unit: item.unit || "", quantity: item.defaultQuantity || 1, unitCost: item.unitCost || 0, frequency: 1, saveToCatalog: false, ...base })
      : sectionName === "toolsEquipment"
        ? toolLine({ catalogItemId: item.itemId || "", itemName: item.itemName || "", category: item.category || "", unit: item.unit || "", quantity: item.defaultQuantity || 1, unitCost: item.unitCost || 0, lifeSpan: item.lifeSpan || 0, productionCycle: form.productionCycleDays || 1, saveToCatalog: false, ...base })
        : sectionName === "grossSales"
          ? salesLine({ productName: "", quantity: 1, unit: "", saleMode: "simple", salePricePerUnit: 0, averageWeight: 0, pricePerKilo: 0, ...base })
          : sectionName === "modalityApplications"
            ? { modality: "", amount: 0, targetStartDate: "", targetEndDate: "", participants: 0, ...base }
            : sectionName === "partnerCounterparts"
              ? { partner: "", support: "", amount: 0, supportType: "", specificSupport: "", ...base }
              : sectionName === "members"
                ? { name: "", designation: "", ...base }
                : sectionName === "scfSchedule"
                  ? { expense: "", amount: 0, schedule: "", ...base }
                  : base;
    setForm((current) => computeForm({ ...current, [sectionName]: [...(current[sectionName] || []), row] }));
  }

  function removeRow(sectionName: string, rowId: string) {
    setForm((current) => computeForm({ ...current, [sectionName]: (current[sectionName] || []).filter((row: AnyRow) => row.lineItemId !== rowId) }));
  }

  async function saveCatalogItem(payload: AnyRow) {
    await apiJson("/api/proposals/catalog", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await loadAll();
  }

  async function generateProposal() {
    const missing = requiredFieldErrors(computed);
    if (selectedTemplateInvalid) {
      setMessage("Cannot generate because the selected proposal template is invalid or missing.");
      return;
    }
    if (missing.length) {
      setMessage(`Missing required field(s): ${missing.join(", ")}`);
      return;
    }
    try {
      const data = await apiJson("/api/proposals/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...computed, proposalType: computed.proposalType, templateType: computed.proposalType, userId: currentProfileId() }),
      });
      const draft = await apiJson(`/api/proposals/drafts/${data.draftId}`);
      setReviewDraft({ ...draft.draft, ...data });
      patchForm({ proposalId: data.proposalId });
      setSection("review");
      setMessage("Word preview is shown from the generated DOCX.");
      await loadAll();
    } catch (error: any) {
      setMessage(error.message);
    }
  }

  async function openInventoryProposal(proposalId: string, mode: "view" | "revise" = "view") {
    const data = await apiJson(`/api/proposals/inventory/${proposalId}`);
    const proposalType = (data.proposal.proposalType || data.proposal.templateType || "MAF") as ProposalType;
    const latestDraft = data.drafts?.[0] || null;
    if (mode === "revise") {
      setForm(computeForm({ ...blankForm(proposalType), ...data.proposal.formData, proposalType, templateType: proposalType, proposalId }));
      setSection("create");
      return;
    }
    if (latestDraft) {
      setReviewDraft(latestDraft);
      setSection("review");
    }
  }

  async function deleteDraft(proposalId?: string) {
    if (!confirm("Are you sure you want to delete this proposal? This cannot be undone.")) return;
    if (proposalId) {
      setInventory((current) => current.filter((row) => row.proposalId !== proposalId));
      await apiJson(`/api/proposals/inventory/${proposalId}?userId=${encodeURIComponent(currentProfileId())}`, { method: "DELETE" });
      setMessage("Proposal deleted successfully.");
      setSection("inventory");
    }
    setReviewDraft(null);
    setForm(blankForm());
  }

  async function updateCatalogItem(itemId: string, payload: AnyRow) {
    await apiJson(`/api/proposals/catalog/${itemId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await loadAll();
  }

  async function deleteCatalogItem(itemId: string) {
    await apiJson(`/api/proposals/catalog/${itemId}`, { method: "DELETE" });
    await loadAll();
  }

  const filteredInventory = inventory.filter((row) => {
    const proposalType = row.proposalType || row.templateType;
    const haystack = [row.proposalId, row.title, proposalType, row.municipality, row.barangay, row.projectName, row.enterpriseType, row.status].join(" ").toLowerCase();
    return (!inventorySearch || haystack.includes(inventorySearch.toLowerCase())) && (!inventoryTemplate || proposalType === inventoryTemplate) && (!inventoryStatus || row.status === inventoryStatus) && (!inventoryMunicipality || String(row.municipality || "").toLowerCase().includes(inventoryMunicipality.toLowerCase()));
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-[#064E3B]">Proposal Builder</h2>
        <p className="mt-1 text-[#64748B]">Generate MAF and Mungkahing Proyekto drafts from exact uploaded Word templates.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {[["create", "Create Proposal"], ["inventory", "Proposal Inventory"], ["raw", "Raw Materials Catalog"], ["tools", "Tools & Equipment Catalog"]].map(([key, label]) => (
          <button key={key} onClick={() => setSection(key as any)} className={`rounded-lg px-4 py-2 text-sm font-semibold ${section === key ? "bg-[#047857] text-white" : "border border-[#D8E6E1] bg-white text-[#064E3B] hover:bg-[#ECFDF5]"}`}>{label}</button>
        ))}
      </div>

      {message && <div className="rounded-lg border border-[#D8E6E1] bg-white px-4 py-3 text-sm text-[#064E3B] shadow-sm">{message}</div>}

      {section === "create" && (
        <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
          <div className="space-y-6">
            <section className="rounded-lg border border-[#D8E6E1] bg-white p-5 shadow-sm">
              <h3 className="mb-4 text-lg font-bold text-[#064E3B]">Select Proposal Type</h3>
              <Field label="Proposal Type" value={computed.proposalType} onChange={(proposalType: ProposalType) => setProposalType(proposalType)} options={proposalTypeOptions.map((option) => [option.value, option.label])} includeBlank />
              {selectedSchema && <div className="mt-4 rounded-lg bg-[#ECFDF5] p-3 text-sm font-semibold text-[#064E3B]">Selected template: {selectedSchema.templateFilename}</div>}
              {selectedTemplateInvalid && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">Cannot generate because the selected proposal template is invalid or missing.</div>}
              {selectedSchema && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button onClick={saveDraftForm} className="rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#ECFDF5]">Save Draft</button>
                  <button onClick={restoreDraftForm} className="rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#ECFDF5]">Load Draft</button>
                  <button onClick={clearDraftForm} className="rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">Clear Draft</button>
                  <button onClick={fillSampleData} className="rounded-lg bg-[#047857] px-3 py-2 text-sm font-semibold text-white hover:bg-[#065F46]">Fill Sample Data</button>
                </div>
              )}
              <div className="mt-3 rounded-lg bg-[#F8FAFC] p-3 text-sm text-[#475569]">Available templates: {templates.map((item) => item.label).join(", ") || "No MAF or Mungkahing Proyekto template detected yet."}</div>
            </section>

            {selectedSchema && (
              <section className="rounded-lg border border-[#D8E6E1] bg-white p-5 shadow-sm">
                <h3 className="mb-4 text-lg font-bold text-[#064E3B]">{selectedSchema.label} Fields</h3>
                <div className="grid gap-3 md:grid-cols-2">
                  {selectedSchema.fields.map((field) => (
                    <Field key={field.key} label={`${field.label}${field.required ? " *" : ""}`} type={field.type} value={computed[field.key]} onChange={(value: any) => patchForm(field.key === "municipality" ? { municipality: value, barangay: "" } : { [field.key]: value })} options={field.source === "municipality" ? AURORA_MUNICIPALITIES.map((m) => [m, m]) : field.source === "barangay" ? (BARANGAYS_BY_MUNICIPALITY[computed.municipality] || []).map((b) => [b, b]) : undefined} includeBlank={field.source === "barangay"} />
                  ))}
                </div>
              </section>
            )}

            {isMaf && (
              <>
                <MembersTable rows={computed.members} onAdd={addRow} onChange={setRow} onRemove={removeRow} />
                <CatalogLineItems title="Raw Materials" sectionName="rawMaterials" rows={computed.rawMaterials} catalog={rawCatalog.filter((item) => item.isActive)} onAdd={addRow} onChange={setRow} onRemove={removeRow} onSaveCatalog={saveCatalogItem} subtotal={computed.rawMaterialsSubtotal} />
                <LaborTable rows={computed.manpower} onAdd={addRow} onChange={setRow} onRemove={removeRow} totalDailyWage={computed.totalDailyWage} manpowerTotal={computed.manpowerTotal} productionCycleDays={computed.productionCycleDays} />
                <CatalogLineItems title="Tools & Equipment" sectionName="toolsEquipment" rows={computed.toolsEquipment} catalog={toolsCatalog.filter((item) => item.isActive)} onAdd={addRow} onChange={setRow} onRemove={removeRow} onSaveCatalog={saveCatalogItem} subtotal={computed.toolsEquipmentSubtotal} depreciationTotal={computed.depreciationTotal} />
                <OtherExpensesTable rows={computed.otherExpenses} onAdd={addRow} onChange={setRow} onRemove={removeRow} total={computed.otherExpensesTotal} />
                <GrossSalesTable rows={computed.grossSales} onAdd={addRow} onChange={setRow} onRemove={removeRow} grossSales={computed.grossSalesTotal} />
                <ProfitAndScf computed={computed} onAdd={addRow} onChange={setRow} onRemove={removeRow} />
              </>
            )}

            {isMp && (
              <>
                <ModalityApplicationsTable rows={computed.modalityApplications} onAdd={addRow} onChange={setRow} onRemove={removeRow} total={computed.modalityTotal} />
                <PartnerCounterpartsTable rows={computed.partnerCounterparts} onAdd={addRow} onChange={setRow} onRemove={removeRow} total={computed.partnerCounterpartTotal} />
              </>
            )}

            {selectedSchema && (
              <section className="rounded-lg border border-[#D8E6E1] bg-white p-5 shadow-sm">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h3 className="text-lg font-bold text-[#064E3B]">{isMaf ? "Grand Total Project Cost" : "Total Project Cost"}</h3>
                    <p className="text-2xl font-bold text-[#047857]">{peso(computed.totalProjectCost)}</p>
                  </div>
                  <button disabled={selectedTemplateInvalid} onClick={generateProposal} className="inline-flex items-center gap-2 rounded-lg bg-[#047857] px-4 py-2 text-sm font-semibold text-white hover:bg-[#065F46] disabled:cursor-not-allowed disabled:opacity-50"><FileText size={16} /> Generate {selectedSchema.label}</button>
                </div>
              </section>
            )}
          </div>

          <aside className="h-fit rounded-lg border border-[#D8E6E1] bg-white p-5 shadow-sm xl:sticky xl:top-4">
            <h3 className="mb-3 font-bold text-[#064E3B]">Totals</h3>
            {isMaf && <>
              <Total label="Raw Materials" value={computed.rawMaterialsSubtotal} />
              <Total label="Manpower" value={computed.manpowerTotal} />
              <Total label="Tools & Equipment" value={computed.toolsEquipmentSubtotal} />
              <Total label="Depreciation" value={computed.depreciationTotal} />
              <Total label="Other Expenses" value={computed.otherExpensesTotal} />
              <Total label="Gross Sales" value={computed.grossSalesTotal} />
              <Total label="Net Profit" value={computed.netProfit} />
            </>}
            {isMp && <>
              <Total label="DSWD-SLP Funding" value={computed.dswdFunding} />
              <Total label="Partner Funding" value={computed.partnerFunding} />
              <Total label="Modality Total" value={computed.modalityTotal} />
              <Total label="Partner Counterpart" value={computed.partnerCounterpartTotal} />
            </>}
            {selectedSchema ? <Total label="Total Project Cost" value={computed.totalProjectCost} strong /> : <p className="text-sm text-[#64748B]">Select a proposal type.</p>}
            {isMaf && (
              <div className="mt-5 space-y-4">
                <QuickCatalog title="Raw Materials Catalog" rows={rawCatalog.filter((item) => item.isActive)} onAdd={(item: AnyRow) => addRow("rawMaterials", item)} />
                <QuickCatalog title="Tools and Equipment Catalog" rows={toolsCatalog.filter((item) => item.isActive)} onAdd={(item: AnyRow) => addRow("toolsEquipment", item)} />
              </div>
            )}
          </aside>
        </div>
      )}

      {section === "review" && reviewDraft && (
        <section className="rounded-lg border border-[#D8E6E1] bg-white p-5 shadow-sm">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="text-xl font-bold text-[#064E3B]">{reviewDraft.formData?.title || reviewDraft.fileName}</h3>
              <p className="text-sm text-[#64748B]">Proposal type: {proposalSchemas[(reviewDraft.proposalType || reviewDraft.templateType) as ProposalType]?.label || reviewDraft.templateType}</p>
              <p className="text-sm text-[#64748B]">Generated filename: {reviewDraft.fileName}</p>
              <p className="text-sm text-[#64748B]">Generated date/time: {new Date(reviewDraft.createdAt).toLocaleString()}</p>
              <p className="text-sm font-semibold text-[#064E3B]">Status: {reviewDraft.status || "Ready for Review"}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a href={reviewDraft.docxDownloadUrl || reviewDraft.downloadUrl} className="inline-flex items-center gap-2 rounded-lg bg-[#047857] px-4 py-2 text-sm font-semibold text-white hover:bg-[#065F46]"><Download size={16} /> Download DOCX</a>
              <button onClick={() => { const proposalType = (reviewDraft.proposalType || reviewDraft.templateType || "MAF") as ProposalType; setForm(computeForm({ ...blankForm(proposalType), ...reviewDraft.formData, proposalType, templateType: proposalType, proposalId: reviewDraft.proposalId })); setSection("create"); }} className="inline-flex items-center gap-2 rounded-lg border border-[#D8E6E1] px-4 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#ECFDF5]"><Pencil size={16} /> Revise</button>
              {canDeleteProposals && <button onClick={() => deleteDraft(reviewDraft.proposalId)} className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"><Trash2 size={16} /> Delete</button>}
            </div>
          </div>
          <DocxPreview sourceUrl={reviewDraft.previewUrl || reviewDraft.docxDownloadUrl || reviewDraft.downloadUrl} />
        </section>
      )}

      {section === "inventory" && <Inventory rows={filteredInventory} search={inventorySearch} setSearch={setInventorySearch} template={inventoryTemplate} setTemplate={setInventoryTemplate} status={inventoryStatus} setStatus={setInventoryStatus} municipality={inventoryMunicipality} setMunicipality={setInventoryMunicipality} canDelete={canDeleteProposals} onView={(row: AnyRow) => openInventoryProposal(row.proposalId, "view")} onRevise={(row: AnyRow) => openInventoryProposal(row.proposalId, "revise")} onDelete={(row: AnyRow) => deleteDraft(row.proposalId)} />}
      {section === "raw" && <CatalogPanel title="Raw Materials Catalog" catalogType="Raw Material" rows={rawCatalog} onCreate={saveCatalogItem} onUpdate={updateCatalogItem} onDelete={deleteCatalogItem} />}
      {section === "tools" && <CatalogPanel title="Tools & Equipment Catalog" catalogType="Tool/Equipment" rows={toolsCatalog} onCreate={saveCatalogItem} onUpdate={updateCatalogItem} onDelete={deleteCatalogItem} />}
    </div>
  );
}

function Field({ label, value, onChange, type = "text", options, includeBlank = false }: AnyRow) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-[#064E3B]">{label}</span>
      {options ? (
        <select value={value || ""} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm">
          {includeBlank && <option value="">Select</option>}
          {options.map(([optionValue, optionLabel]: [string, string]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}
        </select>
      ) : type === "textarea" ? (
        <textarea value={value || ""} onChange={(e) => onChange(e.target.value)} className="min-h-24 w-full rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm" />
      ) : (
        <input type={type} value={value || ""} onChange={(e) => onChange(type === "number" ? numberValue(e.target.value) : e.target.value)} className="w-full rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm" />
      )}
    </label>
  );
}

function DocxPreview({ sourceUrl }: { sourceUrl?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function renderDocx() {
      if (!sourceUrl || !containerRef.current) return;
      setError("");
      containerRef.current.innerHTML = "";
      try {
        const response = await fetch(sourceUrl);
        if (!response.ok) throw new Error(`Unable to fetch generated DOCX (${response.status}).`);
        const blob = await response.blob();
        const previewText = await extractDocxPreviewText(blob);
        if (/EMPLOYMENT ASSESSMENT/i.test(previewText)) {
          throw new Error("Wrong template preview detected. Please check backend template mapping.");
        }
        if (cancelled || !containerRef.current) return;
        await renderAsync(blob, containerRef.current, undefined, {
          className: "proposal-docx-preview",
          inWrapper: true,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
        });
      } catch (renderError: any) {
        if (!cancelled) setError(renderError?.message === "Wrong template preview detected. Please check backend template mapping." ? renderError.message : "DOCX preview failed, but the generated Word file is available for download.");
      }
    }
    renderDocx();
    return () => {
      cancelled = true;
    };
  }, [sourceUrl]);

  return (
    <div className="rounded-lg border border-[#D8E6E1] bg-[#F8FAFC] p-4">
      {error && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">{error}</div>}
      <div ref={containerRef} className="max-h-[760px] overflow-auto bg-white p-3" />
    </div>
  );
}

function sampleProposalForm(proposalType: ProposalType) {
  if (proposalType === "MUNGKAHING_PROYEKTO") {
    return computeForm({
      ...blankForm(proposalType),
      title: "Sample Microenterprise Development Project",
      municipality: "Baler",
      barangay: "Sabang",
      projectName: "Sample SLPA",
      associationParticipantProjectName: "Sample SLPA",
      participantId: "SLPA-SAMPLE-001",
      participantAddress: "Sabang, Baler, Aurora, Region III",
      microenterpriseLocation: "Sabang, Baler, Aurora",
      objectives: "To establish a viable microenterprise that increases household income and supports sustainable livelihood for program participants.",
      dswdFunding: 30000,
      partnerFunding: 5000,
      dateOrganized: "2026-05-28",
      totalMembers: 25,
      slpaPresident: "Juan Dela Cruz",
      contactNumber: "09170000000",
      targetStartDate: "2026-06-15",
      preparedBy: "PDO Sample",
      recommendedBy: "Municipal Link Sample",
      approvedBy: "Regional Director Sample",
      modalityApplications: [
        { lineItemId: id("modality"), modality: "Seed Capital Fund", amount: 30000, targetStartDate: "2026-06-15", targetEndDate: "2026-07-15", participants: 25 },
      ],
      partnerCounterparts: [
        { lineItemId: id("partner"), partner: "LGU Baler", support: "Training venue and technical assistance", amount: 5000, supportType: "In-kind", specificSupport: "Venue, chairs, and resource person" },
      ],
    });
  }
  return computeForm({
    ...blankForm(proposalType),
    title: "Sample Broiler Chicken Production",
    requestedScfAmount: 30000,
    municipality: "Baler",
    barangay: "Sabang",
    projectName: "Sample Broiler SLPA",
    associationParticipantProjectName: "Sample Broiler SLPA",
    enterpriseType: "Chicken Broiler",
    participantId: "SLPA-SAMPLE-001",
    slpaPresident: "Juan Dela Cruz",
    contactNumber: "09170000000",
    targetMarket: "Local households, market vendors, and food stalls in Baler.",
    productionCycleDays: 45,
    mandatorySavingsRate: 0.1,
    preparedBy: "PDO Sample",
    approvedBy: "Regional Director Sample",
    members: [
      { lineItemId: id("member"), name: "Maria Santos", designation: "President" },
      { lineItemId: id("member"), name: "Pedro Reyes", designation: "Treasurer" },
    ],
    rawMaterials: [
      { lineItemId: id("raw"), itemName: "Chicks", quantity: 50, unit: "head", unitCost: 45, frequency: 1 },
      { lineItemId: id("raw"), itemName: "Feeds", quantity: 10, unit: "sack", unitCost: 1650, frequency: 1 },
    ],
    manpower: [
      { lineItemId: id("labor"), workerName: "Caretaker", specificTask: "Feeding and sanitation", dailyWage: 300 },
    ],
    toolsEquipment: [
      { lineItemId: id("tool"), itemName: "Brooder and feeders", quantity: 1, unit: "set", unitCost: 5000, lifeSpan: 730, productionCycle: 45 },
    ],
    otherExpenses: [
      { lineItemId: id("expense"), expenseName: "Veterinary supplies", frequency: "Per cycle", totalCost: 1800 },
      { lineItemId: id("expense"), expenseName: "Electricity and water", frequency: "Per cycle", totalCost: 1200 },
    ],
    grossSales: [
      { lineItemId: id("sales"), productName: "Broiler chicken", quantity: 970, unit: "kg", saleMode: "weight_based", averageWeight: 1.8, pricePerKilo: 180 },
    ],
    scfSchedule: [
      { lineItemId: "auto-scf-raw-materials", expense: "Raw Materials", amount: 0, schedule: "Upon release of SCF" },
      { lineItemId: "auto-scf-tools-equipment", expense: "Tools and Equipment", amount: 0, schedule: "Upon release of SCF" },
    ],
  });
}

async function extractDocxPreviewText(blob: Blob) {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const texts: string[] = [];
    for (const name of Object.keys(zip.files).filter((fileName) => /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(fileName))) {
      const file = zip.file(name);
      if (!file) continue;
      const xml = await file.async("string");
      texts.push(xml.replace(/<[^>]+>/g, " "));
    }
    return texts.join(" ");
  } catch {
    return "";
  }
}

function CatalogLineItems({ title, sectionName, rows, catalog, onAdd, onChange, onRemove, onSaveCatalog, subtotal, depreciationTotal }: AnyRow) {
  const [selected, setSelected] = useState("");
  const selectedItem = catalog.find((item: AnyRow) => item.itemId === selected);
  const isRaw = sectionName === "rawMaterials";
  const headers = isRaw ? ["Item", "Qty", "Unit", "Unit Price", "Frequency", "Total", "Remarks", "Save", "Actions"] : ["Item", "Qty", "Unit", "Unit Price", "Total", "Life Span", "Production Cycle", "Depreciation", "Remarks", "Save", "Actions"];
  return (
    <section className="rounded-lg border border-[#D8E6E1] bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div><h3 className="text-lg font-bold text-[#064E3B]">{title}</h3><p className="text-sm text-[#64748B]">Select from catalog or add a custom item.</p></div>
        <div className="flex flex-wrap gap-2">
          <select value={selected} onChange={(e) => setSelected(e.target.value)} className="rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm"><option value="">Search/select catalog item</option>{catalog.map((item: AnyRow) => <option key={item.itemId} value={item.itemId}>{item.itemName}</option>)}</select>
          <button disabled={!selectedItem} onClick={() => { if (selectedItem) onAdd(sectionName, selectedItem); setSelected(""); }} className="rounded-lg bg-[#047857] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Add Item</button>
          <button onClick={() => onAdd(sectionName, {})} className="inline-flex items-center gap-2 rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#ECFDF5]"><Plus size={15} /> Custom</button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1100px] border-collapse text-sm">
          <thead className="bg-[#ECFDF5] text-left text-[#064E3B]"><tr>{headers.map((h) => <th key={h} className="border border-[#D8E6E1] p-3">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((row: AnyRow) => (
              <tr key={row.lineItemId}>
                <CellInput value={row.itemName} onChange={(itemName: string) => onChange(sectionName, row.lineItemId, { itemName })} />
                <CellInput type="number" value={row.quantity} onChange={(quantity: number) => onChange(sectionName, row.lineItemId, { quantity })} />
                <CellInput value={row.unit} onChange={(unit: string) => onChange(sectionName, row.lineItemId, { unit })} />
                <CellInput type="number" value={row.unitCost} onChange={(unitCost: number) => onChange(sectionName, row.lineItemId, { unitCost })} />
                {isRaw && <CellInput type="number" value={row.frequency} onChange={(frequency: number) => onChange(sectionName, row.lineItemId, { frequency })} />}
                <td className="border border-[#D8E6E1] p-2 font-semibold text-[#064E3B]">{peso(row.totalCost)}</td>
                {!isRaw && <><CellInput type="number" value={row.lifeSpan} onChange={(lifeSpan: number) => onChange(sectionName, row.lineItemId, { lifeSpan })} /><CellInput type="number" value={row.productionCycle} onChange={(productionCycle: number) => onChange(sectionName, row.lineItemId, { productionCycle })} /><td className="border border-[#D8E6E1] p-2 font-semibold text-[#064E3B]">{peso(row.depreciationCost)}</td></>}
                <CellInput value={row.remarks} onChange={(remarks: string) => onChange(sectionName, row.lineItemId, { remarks })} />
                <td className="border border-[#D8E6E1] p-2 text-center"><input type="checkbox" checked={Boolean(row.saveToCatalog)} onChange={(e) => onChange(sectionName, row.lineItemId, { saveToCatalog: e.target.checked })} /></td>
                <td className="border border-[#D8E6E1] p-2"><div className="flex gap-2"><button onClick={() => onSaveCatalog({ ...row, catalogType: isRaw ? "Raw Material" : "Tool/Equipment" })} className="rounded-md border border-[#D8E6E1] px-2 py-1 text-xs font-semibold text-[#047857]">Save</button><button onClick={() => onRemove(sectionName, row.lineItemId)} className="rounded-md border border-red-200 px-2 py-1 text-xs font-semibold text-red-700">Remove</button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap gap-2"><Total label={`${title} Total`} value={subtotal} />{depreciationTotal !== undefined && <Total label="Depreciation Total" value={depreciationTotal} />}</div>
    </section>
  );
}

function QuickCatalog({ title, rows, onAdd }: AnyRow) {
  const [search, setSearch] = useState("");
  const filtered = rows.filter((item: AnyRow) => [item.itemName, item.category, item.unit].join(" ").toLowerCase().includes(search.toLowerCase())).slice(0, 8);
  return (
    <div>
      <h4 className="mb-2 text-sm font-bold text-[#064E3B]">{title}</h4>
      <input value={search} onChange={(e) => setSearch(e.target.value)} className="mb-2 w-full rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm" placeholder="Search catalog" />
      <div className="space-y-2">
        {filtered.map((item: AnyRow) => (
          <button key={item.itemId} onClick={() => onAdd(item)} className="w-full rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-left text-sm hover:bg-[#ECFDF5]">
            <span className="block font-semibold text-[#064E3B]">{item.itemName}</span>
            <span className="text-xs text-[#64748B]">{item.unit || "unit"} - {peso(item.unitCost)}</span>
          </button>
        ))}
        {!filtered.length && <p className="text-xs text-[#64748B]">No catalog items found.</p>}
      </div>
    </div>
  );
}

function MembersTable({ rows, onAdd, onChange, onRemove }: AnyRow) {
  return <SimpleTable title="List of Names of SLPA Members" sectionName="members" rows={rows} headers={["Name", "Designation", "Actions"]} renderRow={(row: AnyRow) => <><CellInput value={row.name} onChange={(name: string) => onChange("members", row.lineItemId, { name })} /><CellInput value={row.designation} onChange={(designation: string) => onChange("members", row.lineItemId, { designation })} /></>} onAdd={() => onAdd("members", { name: "", designation: "" })} onRemove={onRemove} footer={null} />;
}

function LaborTable({ rows, onAdd, onChange, onRemove, totalDailyWage, manpowerTotal, productionCycleDays }: AnyRow) {
  return <SimpleTable title="Available Manpower and Required Labor" sectionName="manpower" rows={rows} headers={["Worker Name", "Specific Task", "Daily Wage/Salary", "Actions"]} renderRow={(row: AnyRow) => <><CellInput value={row.workerName} onChange={(workerName: string) => onChange("manpower", row.lineItemId, { workerName })} /><CellInput value={row.specificTask} onChange={(specificTask: string) => onChange("manpower", row.lineItemId, { specificTask })} /><CellInput type="number" value={row.dailyWage} onChange={(dailyWage: number) => onChange("manpower", row.lineItemId, { dailyWage })} /></>} onAdd={() => onAdd("manpower", { workerName: "", specificTask: "", dailyWage: 0 })} onRemove={onRemove} footer={<div className="flex flex-wrap gap-2"><Total label="Total Daily Wage" value={totalDailyWage} /><Total label={`Total Wage x ${productionCycleDays} Day(s)`} value={manpowerTotal} /></div>} />;
}

function OtherExpensesTable({ rows, onAdd, onChange, onRemove, total }: AnyRow) {
  return <SimpleTable title="Other Expenses" sectionName="otherExpenses" rows={rows} headers={["Expense", "Frequency", "Total Cost", "Remarks", "Actions"]} renderRow={(row: AnyRow) => <><CellInput value={row.expenseName} onChange={(expenseName: string) => onChange("otherExpenses", row.lineItemId, { expenseName })} /><CellInput value={row.frequency} onChange={(frequency: string) => onChange("otherExpenses", row.lineItemId, { frequency })} /><CellInput type="number" value={row.totalCost} onChange={(totalCost: number) => onChange("otherExpenses", row.lineItemId, { totalCost })} /><CellInput value={row.remarks} onChange={(remarks: string) => onChange("otherExpenses", row.lineItemId, { remarks })} /></>} onAdd={() => onAdd("otherExpenses", { expenseName: "", frequency: "", totalCost: 0 })} onRemove={onRemove} footer={<Total label="Other Expenses Total" value={total} />} />;
}

function GrossSalesTable({ rows, onAdd, onChange, onRemove, grossSales }: AnyRow) {
  return (
    <section className="rounded-lg border border-[#D8E6E1] bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-bold text-[#064E3B]">Gross Sales Per Production Cycle</h3>
        <button onClick={() => onAdd("grossSales", { productName: "", quantity: 1, unit: "", saleMode: "simple", salePricePerUnit: 0, averageWeight: 0, pricePerKilo: 0 })} className="inline-flex items-center gap-2 rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#ECFDF5]"><Plus size={15} /> Add Row</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1200px] border-collapse text-sm">
          <thead className="bg-[#ECFDF5] text-left text-[#064E3B]">
            <tr>{["Product", "Quantity", "Unit", "Sale Mode", "Sale Price", "Total Sales", "Actions"].map((h) => <th key={h} className="border border-[#D8E6E1] p-3">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row: AnyRow) => (
              <tr key={row.lineItemId}>
                <CellInput value={row.productName || row.product} onChange={(productName: string) => onChange("grossSales", row.lineItemId, { productName, product: productName })} />
                <CellInput type="number" value={row.quantity} onChange={(quantity: number) => onChange("grossSales", row.lineItemId, { quantity })} />
                <CellInput value={row.unit} onChange={(unit: string) => onChange("grossSales", row.lineItemId, { unit })} />
                <td className="border border-[#D8E6E1] p-2">
                  <select value={row.saleMode || "simple"} onChange={(e) => onChange("grossSales", row.lineItemId, { saleMode: e.target.value })} className="w-full rounded-md border border-[#D8E6E1] px-2 py-1 text-sm">
                    <option value="simple">Normal sale</option>
                    <option value="weight_based">Livestock / chicken sale</option>
                  </select>
                </td>
                <td className="border border-[#D8E6E1] p-2">
                  {row.saleMode === "weight_based" ? (
                    <div className="grid min-w-56 gap-2">
                      <input type="number" value={row.averageWeight || ""} onChange={(e) => onChange("grossSales", row.lineItemId, { averageWeight: numberValue(e.target.value) })} className="w-full rounded-md border border-[#D8E6E1] px-2 py-1 text-sm" placeholder="Average Weight" />
                      <input type="number" value={row.pricePerKilo || ""} onChange={(e) => onChange("grossSales", row.lineItemId, { pricePerKilo: numberValue(e.target.value) })} className="w-full rounded-md border border-[#D8E6E1] px-2 py-1 text-sm" placeholder="Price per Kilo" />
                      <div className="whitespace-pre-line rounded-md bg-[#F8FAFC] px-2 py-1 text-xs font-semibold text-[#064E3B]">{row.salePriceDisplayText}</div>
                    </div>
                  ) : (
                    <input type="number" value={row.salePricePerUnit || ""} onChange={(e) => onChange("grossSales", row.lineItemId, { salePricePerUnit: numberValue(e.target.value) })} className="w-full rounded-md border border-[#D8E6E1] px-2 py-1 text-sm" placeholder="Sale Price Per Unit" />
                  )}
                </td>
                <td className="border border-[#D8E6E1] p-2 font-semibold text-[#064E3B]">{peso(row.totalSales)}</td>
                <td className="border border-[#D8E6E1] p-2"><button onClick={() => onRemove("grossSales", row.lineItemId)} className="rounded-md border border-red-200 px-2 py-1 text-xs font-semibold text-red-700">Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3"><Total label="Gross Sales" value={grossSales} /></div>
    </section>
  );
}

function ModalityApplicationsTable({ rows, onAdd, onChange, onRemove, total }: AnyRow) {
  return <SimpleTable title="Summary of Modality Applications" sectionName="modalityApplications" rows={rows} headers={["Modality", "Amount Needed from DSWD", "Target Start Date", "Target End Date", "No. of Participants", "Actions"]} renderRow={(row: AnyRow) => <><CellInput value={row.modality} onChange={(modality: string) => onChange("modalityApplications", row.lineItemId, { modality })} /><CellInput type="number" value={row.amount} onChange={(amount: number) => onChange("modalityApplications", row.lineItemId, { amount })} /><CellInput type="date" value={row.targetStartDate} onChange={(targetStartDate: string) => onChange("modalityApplications", row.lineItemId, { targetStartDate })} /><CellInput type="date" value={row.targetEndDate} onChange={(targetEndDate: string) => onChange("modalityApplications", row.lineItemId, { targetEndDate })} /><CellInput type="number" value={row.participants} onChange={(participants: number) => onChange("modalityApplications", row.lineItemId, { participants })} /></>} onAdd={() => onAdd("modalityApplications", { modality: "", amount: 0, targetStartDate: "", targetEndDate: "", participants: 0 })} onRemove={onRemove} footer={<Total label="Modality Applications Total" value={total} />} />;
}

function PartnerCounterpartsTable({ rows, onAdd, onChange, onRemove, total }: AnyRow) {
  return <SimpleTable title="Counterpart of Partner Stakeholder/s" sectionName="partnerCounterparts" rows={rows} headers={["Partner", "Counterpart Support", "Amount", "Type of Counterpart Support", "Specific Name of Support", "Actions"]} renderRow={(row: AnyRow) => <><CellInput value={row.partner} onChange={(partner: string) => onChange("partnerCounterparts", row.lineItemId, { partner })} /><CellInput value={row.support} onChange={(support: string) => onChange("partnerCounterparts", row.lineItemId, { support })} /><CellInput type="number" value={row.amount} onChange={(amount: number) => onChange("partnerCounterparts", row.lineItemId, { amount })} /><CellInput value={row.supportType} onChange={(supportType: string) => onChange("partnerCounterparts", row.lineItemId, { supportType })} /><CellInput value={row.specificSupport} onChange={(specificSupport: string) => onChange("partnerCounterparts", row.lineItemId, { specificSupport })} /></>} onAdd={() => onAdd("partnerCounterparts", { partner: "", support: "", amount: 0, supportType: "", specificSupport: "" })} onRemove={onRemove} footer={<Total label="Partner Counterpart Total" value={total} />} />;
}

function SimpleTable({ title, sectionName, rows, headers, renderRow, onAdd, onRemove, footer }: AnyRow) {
  return (
    <section className="rounded-lg border border-[#D8E6E1] bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-bold text-[#064E3B]">{title}</h3><button onClick={onAdd} className="inline-flex items-center gap-2 rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm font-semibold text-[#064E3B] hover:bg-[#ECFDF5]"><Plus size={15} /> Add Row</button></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[900px] border-collapse text-sm"><thead className="bg-[#ECFDF5] text-left text-[#064E3B]"><tr>{headers.map((h: string) => <th key={h} className="border border-[#D8E6E1] p-3">{h}</th>)}</tr></thead><tbody>{rows.map((row: AnyRow) => <tr key={row.lineItemId}>{renderRow(row)}<td className="border border-[#D8E6E1] p-2"><button onClick={() => onRemove(sectionName, row.lineItemId)} className="rounded-md border border-red-200 px-2 py-1 text-xs font-semibold text-red-700">Remove</button></td></tr>)}</tbody></table></div>
      {footer && <div className="mt-3">{footer}</div>}
    </section>
  );
}

function ProfitAndScf({ computed, onAdd, onChange, onRemove }: AnyRow) {
  const rows = [["Gross Profit", computed.grossProfit], ["Total Operating Expense", computed.totalOperatingExpense], ["Gross Profit After Operating Expense", computed.grossProfitAfterOperatingExpense], ["Mandatory Savings", computed.mandatorySavings], ["Net Profit", computed.netProfit]];
  return <section className="rounded-lg border border-[#D8E6E1] bg-white p-5 shadow-sm"><h3 className="mb-4 text-lg font-bold text-[#064E3B]">Net Profit and Schedule for the Use of the SCF</h3><div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">{rows.map(([label, value]) => <Total key={label as string} label={label as string} value={value as number} />)}</div><SimpleTable title="Schedule for the Use of the SCF" sectionName="scfSchedule" rows={computed.scfSchedule} headers={["Expense", "Amount", "Schedule of Utilization", "Actions"]} renderRow={(row: AnyRow) => <><CellInput value={row.expense} onChange={(expense: string) => onChange("scfSchedule", row.lineItemId, { expense })} /><CellInput type="number" value={row.amount} onChange={(amount: number) => onChange("scfSchedule", row.lineItemId, { amount })} /><CellInput value={row.schedule} onChange={(schedule: string) => onChange("scfSchedule", row.lineItemId, { schedule })} /></>} onAdd={() => onAdd("scfSchedule", { expense: "", amount: 0, schedule: "" })} onRemove={onRemove} footer={null} /></section>;
}

function CellInput({ value, onChange, type = "text" }: AnyRow) {
  return <td className="border border-[#D8E6E1] p-2"><input type={type} value={value || ""} onChange={(e) => onChange(type === "number" ? numberValue(e.target.value) : e.target.value)} className="w-full rounded-md border border-[#D8E6E1] px-2 py-1 text-sm" /></td>;
}

function Total({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return <div className={`mb-2 rounded-lg ${strong ? "bg-[#047857] text-white" : "bg-[#ECFDF5] text-[#064E3B]"} px-4 py-3 text-sm font-bold`}>{label}: {peso(value)}</div>;
}

function Inventory(props: AnyRow) {
  return <section className="rounded-lg border border-[#D8E6E1] bg-white p-5 shadow-sm"><div className="mb-4 grid gap-3 md:grid-cols-4"><div className="relative"><Search className="absolute left-3 top-2.5 text-[#64748B]" size={18} /><input value={props.search} onChange={(e) => props.setSearch(e.target.value)} className="w-full rounded-lg border border-[#D8E6E1] py-2 pl-10 pr-3 text-sm" placeholder="Search inventory" /></div><select value={props.template} onChange={(e) => props.setTemplate(e.target.value)} className="rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm"><option value="">All proposal types</option>{proposalTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><input value={props.municipality} onChange={(e) => props.setMunicipality(e.target.value)} className="rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm" placeholder="Municipality" /><select value={props.status} onChange={(e) => props.setStatus(e.target.value)} className="rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm"><option value="">All statuses</option>{["Draft", "Ready for Review", "Downloaded", "Revised"].map((s) => <option key={s}>{s}</option>)}</select></div><div className="overflow-x-auto"><table className="w-full min-w-[1300px] border-collapse text-sm"><thead className="bg-[#ECFDF5] text-left text-[#064E3B]"><tr>{["Proposal ID", "Project Name", "Proposal Type", "Municipality", "Barangay", "Association / Participant / Project Name", "Total Project Cost", "Date Generated", "Status", "Actions"].map((h) => <th key={h} className="border border-[#D8E6E1] p-3">{h}</th>)}</tr></thead><tbody>{props.rows.map((row: AnyRow) => { const proposalType = (row.proposalType || row.templateType) as ProposalType; return <tr key={row.proposalId}><td className="border border-[#D8E6E1] p-3">{row.proposalId}</td><td className="border border-[#D8E6E1] p-3 font-semibold text-[#064E3B]">{row.title}</td><td className="border border-[#D8E6E1] p-3">{proposalSchemas[proposalType]?.label || proposalType}</td><td className="border border-[#D8E6E1] p-3">{row.municipality}</td><td className="border border-[#D8E6E1] p-3">{row.barangay}</td><td className="border border-[#D8E6E1] p-3">{row.projectName}</td><td className="border border-[#D8E6E1] p-3">{peso(row.totalCost)}</td><td className="border border-[#D8E6E1] p-3">{new Date(row.createdAt).toLocaleString()}</td><td className="border border-[#D8E6E1] p-3">{row.status}</td><td className="border border-[#D8E6E1] p-3"><div className="flex flex-wrap gap-2"><button onClick={() => props.onView(row)} className="rounded-md border border-[#D8E6E1] px-2 py-1 text-xs font-semibold text-[#047857]">View</button><button onClick={() => props.onRevise(row)} className="rounded-md border border-[#D8E6E1] px-2 py-1 text-xs font-semibold text-[#047857]">Revise</button>{row.downloadUrl && <a href={row.downloadUrl} className="rounded-md border border-[#D8E6E1] px-2 py-1 text-xs font-semibold text-[#047857]">Download DOCX</a>}{props.canDelete && <button onClick={() => props.onDelete(row)} className="rounded-md border border-red-200 px-2 py-1 text-xs font-semibold text-red-700">Delete</button>}</div></td></tr>; })}</tbody></table></div></section>;
}

function CatalogPanel({ title, catalogType, rows, onCreate, onUpdate, onDelete }: AnyRow) {
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<AnyRow>({ catalogType, defaultQuantity: 1, unitCost: 0, isActive: true });
  const filtered = rows.filter((row: AnyRow) => [row.itemId, row.itemName, row.category, row.unit, row.supplier, row.remarks].join(" ").toLowerCase().includes(search.toLowerCase()));
  const fields = ["itemName", "category", "unit", "defaultQuantity", "unitCost", "supplier", "remarks"];
  return <section className="rounded-lg border border-[#D8E6E1] bg-white p-5 shadow-sm"><div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between"><h3 className="text-lg font-bold text-[#064E3B]">{title}</h3><div className="relative max-w-sm flex-1"><Search className="absolute left-3 top-2.5 text-[#64748B]" size={18} /><input value={search} onChange={(e) => setSearch(e.target.value)} className="w-full rounded-lg border border-[#D8E6E1] py-2 pl-10 pr-3 text-sm" placeholder="Search catalog" /></div></div><div className="mb-4 grid gap-3 md:grid-cols-4">{fields.map((field) => <input key={field} type={["defaultQuantity", "unitCost"].includes(field) ? "number" : "text"} value={draft[field] || ""} onChange={(e) => setDraft({ ...draft, [field]: ["defaultQuantity", "unitCost"].includes(field) ? numberValue(e.target.value) : e.target.value })} className="rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm" placeholder={field.replace(/([A-Z])/g, " $1")} />)}<button onClick={async () => { await onCreate({ ...draft, catalogType }); setDraft({ catalogType, defaultQuantity: 1, unitCost: 0, isActive: true }); }} className="rounded-lg bg-[#047857] px-3 py-2 text-sm font-semibold text-white">Add Item</button></div><div className="overflow-x-auto"><table className="w-full min-w-[1100px] border-collapse text-sm"><thead className="bg-[#ECFDF5] text-left text-[#064E3B]"><tr>{["Item ID", "Item Name", "Catalog Type", "Category", "Unit", "Default Quantity", "Unit Cost", "Supplier / Source", "Remarks", "Active / Inactive", "Created Date", "Updated Date", "Actions"].map((h) => <th key={h} className="border border-[#D8E6E1] p-3">{h}</th>)}</tr></thead><tbody>{filtered.map((row: AnyRow) => <CatalogRow key={row.itemId} row={row} onUpdate={onUpdate} onDelete={onDelete} />)}</tbody></table></div></section>;
}

function CatalogRow({ row, onUpdate, onDelete }: AnyRow) {
  const [edit, setEdit] = useState(row);
  return <tr><td className="border border-[#D8E6E1] p-3">{row.itemId}</td>{["itemName", "catalogType", "category", "unit", "defaultQuantity", "unitCost", "supplier", "remarks"].map((field) => <td key={field} className="border border-[#D8E6E1] p-2"><input value={edit[field] || ""} onChange={(e) => setEdit({ ...edit, [field]: ["defaultQuantity", "unitCost"].includes(field) ? numberValue(e.target.value) : e.target.value })} className="w-full rounded-md border border-[#D8E6E1] px-2 py-1" /></td>)}<td className="border border-[#D8E6E1] p-2 text-center"><input type="checkbox" checked={Boolean(edit.isActive)} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /></td><td className="border border-[#D8E6E1] p-3">{new Date(row.createdAt).toLocaleString()}</td><td className="border border-[#D8E6E1] p-3">{new Date(row.updatedAt).toLocaleString()}</td><td className="border border-[#D8E6E1] p-3"><div className="flex gap-2"><button onClick={() => onUpdate(row.itemId, edit)} className="rounded-md border border-[#D8E6E1] px-2 py-1 text-xs font-semibold text-[#047857]">Edit</button><button onClick={() => onDelete(row.itemId)} className="rounded-md border border-red-200 px-2 py-1 text-xs font-semibold text-red-700">Delete</button></div></td></tr>;
}
