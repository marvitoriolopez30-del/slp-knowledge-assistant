export type ProposalType = "MAF" | "MUNGKAHING_PROYEKTO";

export type ProposalField = {
  key: string;
  label: string;
  type?: "text" | "number" | "date" | "textarea";
  required?: boolean;
  source?: "municipality" | "barangay";
};

export type ProposalTableColumn = {
  key: string;
  label: string;
  type?: "text" | "number" | "date";
  computed?: boolean;
};

export type ProposalTable = {
  key: string;
  label: string;
  section: string;
  catalogType?: "Raw Material" | "Tool/Equipment";
  columns: ProposalTableColumn[];
};

export type ProposalSchema = {
  proposalType: ProposalType;
  label: string;
  templateKey: ProposalType;
  templateFilename: string;
  templateFilePatterns: string[];
  requiredFields: string[];
  optionalFields: string[];
  fields: ProposalField[];
  sections: string[];
  visibleFormSections: string[];
  tables: ProposalTable[];
  calculations: string[];
  placeholderMap: Record<string, string>;
  generatedFilenamePattern: string;
};

export const proposalSchemas: Record<ProposalType, ProposalSchema> = {
  MAF: {
    proposalType: "MAF",
    label: "MAF",
    templateKey: "MAF",
    templateFilename: "MAF.docx",
    templateFilePatterns: ["MAF.docx"],
    requiredFields: ["title", "requestedScfAmount", "municipality", "barangay", "projectName", "participantId", "contactNumber"],
    optionalFields: ["slpaPresident", "targetMarket", "productionCycleDays", "mandatorySavingsRate", "preparedBy", "approvedBy"],
    fields: [
      { key: "title", label: "Specific Title of MD Project", required: true },
      { key: "requestedScfAmount", label: "Amount of Requested Seed Capital Fund", type: "number", required: true },
      { key: "municipality", label: "Municipality", required: true, source: "municipality" },
      { key: "barangay", label: "Barangay", required: true, source: "barangay" },
      { key: "projectName", label: "Name of SLPA / Individual Program Participant", required: true },
      { key: "participantId", label: "SLPA / Participant ID Number", required: true },
      { key: "slpaPresident", label: "SLPA President" },
      { key: "contactNumber", label: "Contact Number", required: true },
      { key: "targetMarket", label: "Target Market", type: "textarea" },
      { key: "productionCycleDays", label: "Production Cycle Days", type: "number" },
      { key: "mandatorySavingsRate", label: "Mandatory Savings %", type: "number" },
      { key: "preparedBy", label: "Prepared By" },
      { key: "approvedBy", label: "Approved By" },
    ],
    sections: [
      "SCF Summary",
      "SLPA / Participant Information",
      "List of SLPA Members",
      "Target Market",
      "Microenterprise Management",
      "Gross Sales and Net Profit",
      "Schedule for the Use of SCF",
      "Signatories",
    ],
    visibleFormSections: ["basicInformation", "mafAssessment", "mafCosting", "mafSignatories"],
    tables: [
      {
        key: "members",
        label: "List of Names of SLPA Members",
        section: "list_of_members",
        columns: [
          { key: "name", label: "Name" },
          { key: "designation", label: "Designation" },
        ],
      },
      {
        key: "rawMaterials",
        label: "Raw Materials",
        section: "raw_materials",
        catalogType: "Raw Material",
        columns: [
          { key: "itemName", label: "Raw Material" },
          { key: "quantity", label: "Quantity", type: "number" },
          { key: "unit", label: "Unit" },
          { key: "unitCost", label: "Unit Price", type: "number" },
          { key: "frequency", label: "Frequency of Production", type: "number" },
          { key: "totalCost", label: "Total Cost", type: "number", computed: true },
        ],
      },
      {
        key: "manpower",
        label: "Available Manpower and Required Labor",
        section: "manpower",
        columns: [
          { key: "workerName", label: "Name of Worker" },
          { key: "specificTask", label: "Specific Task" },
          { key: "dailyWage", label: "Daily Wage / Salary", type: "number" },
        ],
      },
      {
        key: "toolsEquipment",
        label: "Tools and Equipment",
        section: "tools_equipment",
        catalogType: "Tool/Equipment",
        columns: [
          { key: "itemName", label: "Tool / Equipment" },
          { key: "quantity", label: "Quantity", type: "number" },
          { key: "unit", label: "Unit" },
          { key: "unitCost", label: "Unit Price", type: "number" },
          { key: "totalCost", label: "Total Cost", type: "number", computed: true },
          { key: "lifeSpan", label: "Life Span", type: "number" },
          { key: "productionCycle", label: "Production Cycle", type: "number" },
          { key: "depreciationCost", label: "Depreciation Cost", type: "number", computed: true },
        ],
      },
      {
        key: "otherExpenses",
        label: "Regular Operational Expense",
        section: "other_expenses",
        columns: [
          { key: "expenseName", label: "Regular Operational Expense" },
          { key: "frequency", label: "Frequency of Payment" },
          { key: "totalCost", label: "Total Cost", type: "number" },
        ],
      },
      {
        key: "grossSales",
        label: "Gross Sales Per Production Cycle",
        section: "gross_sales",
        columns: [
          { key: "product", label: "Product" },
          { key: "productName", label: "Product" },
          { key: "quantity", label: "Quantity", type: "number" },
          { key: "unit", label: "Unit" },
          { key: "saleMode", label: "Sale Mode" },
          { key: "salePricePerUnit", label: "Sale Price Per Unit", type: "number" },
          { key: "averageWeight", label: "Average Weight", type: "number" },
          { key: "pricePerKilo", label: "Price Per Kilo", type: "number" },
          { key: "salePriceDisplayText", label: "Sale Price Display Text" },
          { key: "totalKilos", label: "Total Kilos", type: "number", computed: true },
          { key: "totalSales", label: "Total Sales", type: "number", computed: true },
        ],
      },
      {
        key: "scfSchedule",
        label: "Schedule for the Use of SCF",
        section: "scf_schedule",
        columns: [
          { key: "expense", label: "Expense" },
          { key: "amount", label: "Amount", type: "number" },
          { key: "schedule", label: "Schedule of Utilization" },
        ],
      },
    ],
    calculations: ["rawMaterialsSubtotal", "manpowerTotal", "toolsEquipmentSubtotal", "depreciationTotal", "otherExpensesTotal", "grossSalesTotal", "grossProfit", "netProfit", "grandTotal"],
    placeholderMap: {
      PROJECT_TITLE: "title",
      REQUESTED_SCF_AMOUNT: "requestedScfAmount",
      LOCATION_OF_MICROENTERPRISE: "location",
      PARTICIPANT_NAME: "projectName",
      PARTICIPANT_ID: "participantId",
      SLPA_PRESIDENT: "slpaPresident",
      CONTACT_NUMBER: "contactNumber",
      TARGET_MARKET: "targetMarket",
    },
    generatedFilenamePattern: "MAF_{municipality}_{projectName}_{date}.docx",
  },
  MUNGKAHING_PROYEKTO: {
    proposalType: "MUNGKAHING_PROYEKTO",
    label: "Mungkahing Proyekto",
    templateKey: "MUNGKAHING_PROYEKTO",
    templateFilename: "MUNGKAHING_PROYEKTO.docx",
    templateFilePatterns: ["MUNGKAHING_PROYEKTO.docx"],
    requiredFields: ["title", "dswdFunding", "projectName", "participantId", "participantAddress", "microenterpriseLocation", "objectives"],
    optionalFields: ["partnerFunding", "municipality", "barangay", "dateOrganized", "totalMembers", "slpaPresident", "contactNumber", "targetStartDate", "preparedBy", "recommendedBy", "approvedBy"],
    fields: [
      { key: "title", label: "Title of MD Project", required: true },
      { key: "dswdFunding", label: "Cost of DSWD-SLP Funding", type: "number", required: true },
      { key: "partnerFunding", label: "Cost of Partner's Funding", type: "number" },
      { key: "projectName", label: "Name of SLPA / Individual Program Participant", required: true },
      { key: "participantId", label: "SLPA / Participant ID No.", required: true },
      { key: "participantAddress", label: "Address of the SLPA / Individual Program Participant", type: "textarea", required: true },
      { key: "microenterpriseLocation", label: "Location of the Proposed Microenterprise", type: "textarea", required: true },
      { key: "municipality", label: "Municipality", source: "municipality" },
      { key: "barangay", label: "Barangay", source: "barangay" },
      { key: "dateOrganized", label: "Date Organized", type: "date" },
      { key: "totalMembers", label: "Total No. of Members", type: "number" },
      { key: "slpaPresident", label: "SLPA President" },
      { key: "contactNumber", label: "Contact No." },
      { key: "objectives", label: "Objectives", type: "textarea", required: true },
      { key: "targetStartDate", label: "Target Start Date of Establishment", type: "date" },
      { key: "preparedBy", label: "Prepared By" },
      { key: "recommendedBy", label: "Recommended for Approval By" },
      { key: "approvedBy", label: "Approved By" },
    ],
    sections: [
      "Project Summary",
      "Basic Information",
      "Objectives",
      "Summary of Modality Applications",
      "Details of DSWD Funding",
      "Counterpart of Partner Stakeholders",
      "Attachments",
      "Recommendations",
      "Signatories",
    ],
    visibleFormSections: ["projectSummary", "basicInformation", "objectives", "modalityApplications", "partnerCounterpart", "signatories"],
    tables: [
      {
        key: "modalityApplications",
        label: "Summary of Modality Applications",
        section: "modality_applications",
        columns: [
          { key: "modality", label: "Modality" },
          { key: "amount", label: "Amount Needed from DSWD", type: "number" },
          { key: "targetStartDate", label: "Target Start Date", type: "date" },
          { key: "targetEndDate", label: "Target End Date", type: "date" },
          { key: "participants", label: "No. of Participants", type: "number" },
        ],
      },
      {
        key: "partnerCounterparts",
        label: "Counterpart of Partner Stakeholder/s",
        section: "partner_counterparts",
        columns: [
          { key: "partner", label: "Partner" },
          { key: "support", label: "Counterpart Support" },
          { key: "amount", label: "Amount", type: "number" },
          { key: "supportType", label: "Type of Counterpart Support" },
          { key: "specificSupport", label: "Specific Name of Counterpart Support" },
        ],
      },
    ],
    calculations: ["totalProjectCost", "dswdFunding", "partnerFunding", "modalityTotal", "partnerCounterpartTotal"],
    placeholderMap: {
      PROJECT_TITLE: "title",
      DSWD_FUNDING: "dswdFunding",
      PARTNER_FUNDING: "partnerFunding",
      TOTAL_PROJECT_COST: "totalProjectCost",
      PARTICIPANT_NAME: "projectName",
      PARTICIPANT_ID: "participantId",
      PARTICIPANT_ADDRESS: "participantAddress",
      MICROENTERPRISE_LOCATION: "microenterpriseLocation",
      OBJECTIVES: "objectives",
      TARGET_START_DATE: "targetStartDate",
    },
    generatedFilenamePattern: "MUNGKAHING_PROYEKTO_{municipality}_{projectName}_{date}.docx",
  },
};

export const proposalTypeOptions = Object.values(proposalSchemas).map((schema) => ({
  value: schema.proposalType,
  label: schema.label,
}));
