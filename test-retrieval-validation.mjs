const API = process.env.SLP_API_URL || "http://localhost:3001";
const ADMIN_ID = process.env.SLP_TEST_ADMIN_ID || "";

async function ask(message, sessionId = `retrieval-validation-${Date.now()}`) {
  const response = await fetch(`${API}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, userId: ADMIN_ID || undefined, chatSessionId: sessionId }),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, received: ${text.slice(0, 300)}`);
  }
  if (!response.ok) throw new Error(data.error || data.answer || `HTTP ${response.status}`);
  return String(data.answer || "");
}

async function matchNames(names) {
  const response = await fetch(`${API}/api/name-match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ names }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function dashboardAnalytics() {
  const response = await fetch(`${API}/api/dashboard/analytics?ts=${Date.now()}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const cases = [
  {
    name: "PWD count uses Personal Module PWD filter",
    message: "How many PWD participants are served?",
    expect: [/PWD participants|PWD column was not found/i, /Personal Module|Source Used/i],
    reject: [/Total participants:\s*\d+[\s\S]*Rows after filter/i],
  },
  {
    name: "Person project lookup goes Personal first",
    message: process.env.SLP_TEST_PERSON
      ? `What is the project of ${process.env.SLP_TEST_PERSON}?`
      : "What is the project of Juan Dela Cruz?",
    expect: [/Personal Module|could not find this person/i],
    reject: [/Checked Project Module using exact IDs\/full-name/i],
  },
  {
    name: "Proposal question searches PROPOSALS first",
    message: "Do we have a proposal about livelihood?",
    expect: [/Source: PROPOSALS|could not find the answer/i],
    reject: [/Personal Module|Project Module/i],
  },
  {
    name: "Project lookup uses Project Module",
    message: "How many total projects are encoded?",
    expect: [/Total projects|Project Module/i],
    reject: [/Personal Module first|PWD participants/i],
  },
  {
    name: "Closed projects in Dilasag uses monitoring status route",
    message: "How many closed projects in Dilasag?",
    expect: [/Dilasag has \d+ closed project/i, /MDMonitoring|Monitoring/i],
    reject: [/Personal Module|personName|projectType|Filters used/i],
  },
  {
    name: "Project count by barangay uses Project Module",
    message: "How many projects in barangay Diniog?",
    expect: [/Total projects in barangay Diniog/i, /Project Module/i],
    reject: [/Personal Module|personName|projectType/i],
  },
  {
    name: "Template copy returns download file response",
    message: "Can I have a copy of the MD Monitoring Tool?",
    expect: [/Download Files|could not find a matching original file/i],
    reject: [/Summary Table|Total participants/i],
  },
  {
    name: "MC 03 phases use guideline documents",
    message: "Based on MC 03 guidelines, what are the SLP implementation phases?",
    expect: [/Source: GUIDELINES|could not find the answer/i],
    reject: [/Summary Table|Project Module/i],
  },
  {
    name: "Simple explanation has no table",
    message: "What is SLP based on the guidelines?",
    expect: [/Direct Answer|Source:/i],
    reject: [/Summary Table|\| Metric \| Value \|/i],
  },
  {
    name: "Municipality filter is applied",
    message: "How many participants in Baler?",
    expect: [/Baler|municipality=Baler|No matching participants/i],
  },
  {
    name: "Chart only for numeric grouped data",
    message: "Show operational vs closed by municipality",
    expect: [/Operational|Closed|Municipality/i, /slp-chart|No .*found matching/i],
  },
  {
    name: "Weak evidence does not guess",
    message: "What does the uploaded guideline say about ZZZZ-NOT-A-REAL-SLP-TOPIC?",
    expect: [/could not find|not find the answer|not found/i],
  },
];

let failed = 0;
for (const test of cases) {
  const answer = await ask(test.message);
  const misses = (test.expect || []).filter((pattern) => !pattern.test(answer));
  const rejects = (test.reject || []).filter((pattern) => pattern.test(answer));
  if (misses.length || rejects.length) {
    failed += 1;
    console.error(`FAIL: ${test.name}`);
    console.error(answer.slice(0, 1600));
  } else {
    console.log(`PASS: ${test.name}`);
  }
}

try {
  const match = await matchNames("Validation Same Name\nValidation Same Name");
  const statuses = (match.results || []).map((row) => String(row.status || "")).join(" | ");
  if (/Exact duplicate|Possible duplicate/i.test(statuses)) {
    failed += 1;
    console.error("FAIL: Match & Compare does not compare within uploaded input");
    console.error(JSON.stringify(match, null, 2).slice(0, 1600));
  } else {
    console.log("PASS: Match & Compare does not compare within uploaded input");
  }
} catch (error) {
  failed += 1;
  console.error("FAIL: Match & Compare validation request failed");
  console.error(error);
}

try {
  const dashboard = await dashboardAnalytics();
  const statusSum = (dashboard.operationalClosedByMunicipality || []).reduce((acc, row) => {
    acc.operational += Number(row.operational || 0);
    acc.closed += Number(row.closed || 0);
    return acc;
  }, { operational: 0, closed: 0 });
  const dashboardFailures = [];
  if (statusSum.operational !== Number(dashboard.summary?.operational || 0)) dashboardFailures.push("Operational total does not match municipality rows");
  if (statusSum.closed !== Number(dashboard.summary?.closed || 0)) dashboardFailures.push("Closed total does not match municipality rows");
  if (Number(dashboard.summary?.associations || 0) + Number(dashboard.summary?.individualEnterprises || 0) > 0) {
    if (!dashboard.topEnterprisesOverall?.length) dashboardFailures.push("Top enterprise/project types are blank despite Project Module data");
    if (Number(dashboard.grantUtilization?.withReport || 0) + Number(dashboard.grantUtilization?.withoutReport || 0) === 0) dashboardFailures.push("GUR conducted/not conducted is blank despite Project Module data");
  }
  if (!dashboard.sourceDiagnostics?.some((item) => item.sourceType === "SLPIS_PROJECT_MODULE" && item.totalRows > 0)) dashboardFailures.push("Source diagnostics did not detect SLPIS Project Module rows");
  if (dashboardFailures.length) {
    failed += 1;
    console.error("FAIL: Unified dashboard aggregator consistency");
    console.error(dashboardFailures.join("; "));
  } else {
    console.log("PASS: Unified dashboard aggregator consistency");
  }
} catch (error) {
  failed += 1;
  console.error("FAIL: Dashboard analytics validation request failed");
  console.error(error);
}

process.exitCode = failed ? 1 : 0;
