import express from "express";
import dotenv from "dotenv";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import Tesseract from "tesseract.js";
import levenshtein from "js-levenshtein";
import JSZip from "jszip";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import { buildUnifiedDashboardAnalytics } from "./src/lib/dashboardAggregator.ts";
import { createRetrievalPlan, routeUserQuery, type QueryRoute } from "./src/lib/retrievalController.ts";
import { classifyDataSource, sourceDisplayName as registrySourceDisplayName } from "./src/config/dataSourceRegistry.ts";
import { classifyDocument, documentTypeDisplayName } from "./src/lib/documentClassifier.ts";
import { documentTypeRule } from "./src/config/documentTypeRegistry.ts";
import { proposalSchemas, type ProposalType } from "./src/proposalBuilder/proposalSchemas.ts";

dotenv.config();

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3");
const compression = require("compression");
const app = express();
app.use(compression());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "500mb" }));
const PORT = Number(process.env.PORT) || 3001;

function logBackendError(error: any, port: number) {
  const name = error?.name || "UnknownError";
  const message = error?.message || String(error);
  console.error("------- API STARTUP ERROR -------");
  console.error("Error name:", name);
  console.error("Error message:", message);
  if (error?.stack) {
    console.error("Stack trace:", error.stack);
  }
  console.error("Port:", port);
  console.error("Environment:", process.env.NODE_ENV || "undefined");
  console.error("PORT env:", process.env.PORT ?? "(not set)");
  console.error("CWD:", process.cwd());
  console.error("-------");
}

process.on("uncaughtException", (error) => {
  logBackendError(error, PORT);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logBackendError(reason, PORT);
  process.exit(1);
});

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");
const PENDING_REGISTRATIONS_FILE = path.join(UPLOAD_ROOT, "pending-registrations.json");
const DOCUMENT_CACHE_FILE = path.join(UPLOAD_ROOT, "documents-cache.json");
const DATA_ROOT = path.resolve(process.cwd(), "data");
const SERVER_ROOT = path.resolve(process.cwd(), "server");
const PROPOSAL_TEMPLATE_ROOT = path.resolve(process.cwd(), "templates", "proposal");
const PROPOSAL_GENERATED_ROOT = path.join(SERVER_ROOT, "generated-proposals");
const LEGACY_LOCAL_DB_PATH = path.resolve(process.cwd(), "slp-local.sqlite");
const DEFAULT_LOCAL_DB_PATH = fsSync.existsSync(LEGACY_LOCAL_DB_PATH)
  ? LEGACY_LOCAL_DB_PATH
  : path.join(DATA_ROOT, "slp-local.db");
const LOCAL_DB_PATH = path.resolve(process.cwd(), process.env.LOCAL_SQLITE_PATH || DEFAULT_LOCAL_DB_PATH);
const LOCAL_DOCUMENT_FOLDERS = new Set(["GUIDELINES", "SLPIS", "SLP DPT", "PROPOSALS", "TEMPLATES", "IMAGE", "OTHER DOCUMENTS"]);
const RETRIEVAL_DEBUG = /^true|1|yes$/i.test(String(process.env.RETRIEVAL_DEBUG || ""));
fsSync.mkdirSync(path.dirname(LOCAL_DB_PATH), { recursive: true });

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: "Invalid JSON request body." });
  next(err);
});

const db = new BetterSqlite3(LOCAL_DB_PATH);
db.pragma("journal_mode = WAL");

// =========================
// DB INIT
// =========================
function initLocalDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      full_name TEXT, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, file_name TEXT NOT NULL, file_url TEXT, folder TEXT,
      file_size INTEGER DEFAULT 0, file_type TEXT, content_text TEXT, uploaded_by TEXT,
      chat_attachment INTEGER DEFAULT 0, chat_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL, chunk_size INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS pdf_pages (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, page_number INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '', text_length INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS pdf_tables (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, page_number INTEGER NOT NULL,
      table_index INTEGER NOT NULL, rows_json TEXT NOT NULL DEFAULT '[]',
      row_count INTEGER DEFAULT 0, column_count INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS pdf_extraction_status (
      document_id TEXT PRIMARY KEY, pages_processed INTEGER DEFAULT 0, text_length INTEGER DEFAULT 0,
      tables_extracted INTEGER DEFAULT 0, ocr_needed INTEGER DEFAULT 0, ocr_attempted INTEGER DEFAULT 0,
      extraction_error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS vision_extractions (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, file_name TEXT, page_number INTEGER DEFAULT 1,
      image_number INTEGER DEFAULT 1, extraction_method TEXT NOT NULL, model_used TEXT,
      text TEXT NOT NULL DEFAULT '', text_length INTEGER DEFAULT 0, confidence REAL,
      error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS chat_logs (
      id TEXT PRIMARY KEY, user_id TEXT, message TEXT, response TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS chat_memory (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, memory_key TEXT NOT NULL,
      memory_value TEXT NOT NULL, source_chat_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, memory_key)
    );
    CREATE TABLE IF NOT EXISTS faq_analytics (
      id TEXT PRIMARY KEY, normalized_question TEXT NOT NULL UNIQUE, original_question_sample TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General program questions', ask_count INTEGER NOT NULL DEFAULT 1,
      last_asked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT PRIMARY KEY, app_logo_url TEXT, updated_by TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS setting_values (
      id TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS uploaded_files (
      id TEXT PRIMARY KEY, document_id TEXT, file_name TEXT NOT NULL, folder TEXT, file_type TEXT,
      file_size INTEGER DEFAULT 0, file_hash TEXT, uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS original_file_metadata (
      file_id TEXT PRIMARY KEY, document_id TEXT, original_file_name TEXT NOT NULL,
      folder TEXT, sub_folder TEXT, source_type TEXT, mime_type TEXT, file_size INTEGER DEFAULT 0,
      storage_path TEXT, download_url TEXT, parsed_text_id TEXT, parsed_table_id TEXT,
      upload_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS uploaded_sheets (
      id TEXT PRIMARY KEY, file_id TEXT NOT NULL, document_id TEXT, sheet_name TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0, header_row_index INTEGER DEFAULT 0,
      header_confidence REAL DEFAULT 0, headers_json TEXT NOT NULL DEFAULT '[]',
      normalized_headers_json TEXT NOT NULL DEFAULT '[]',
      detected_columns_json TEXT NOT NULL DEFAULT '{}', sample_rows_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sheet_columns (
      id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL, column_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL, detected_role TEXT, sample_values_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS sheet_rows (
      id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL, file_id TEXT NOT NULL,
      row_index INTEGER NOT NULL, row_hash TEXT NOT NULL, row_json TEXT NOT NULL,
      row_text TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS analysis_cache (
      id TEXT PRIMARY KEY, cache_key TEXT NOT NULL UNIQUE, question TEXT NOT NULL,
      file_version TEXT, answer_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS analysis_history (
      id TEXT PRIMARY KEY, user_id TEXT, session_id TEXT, question TEXT NOT NULL,
      answer_summary TEXT NOT NULL DEFAULT '', source_files_json TEXT NOT NULL DEFAULT '[]',
      tables_json TEXT NOT NULL DEFAULT '[]', chart_data_json TEXT NOT NULL DEFAULT '{}',
      report_link TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, feature TEXT,
      file_id TEXT, file_name TEXT, details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL,
      feedback_type TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS feedback_log (
      id TEXT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL,
      user_feedback TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      retrieved_sources_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS retrieval_logs (
      id TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      userQuestion TEXT NOT NULL,
      normalizedQuestion TEXT,
      detectedIntent TEXT,
      selectedRoute TEXT NOT NULL DEFAULT '',
      retrievalMode TEXT,
      foldersSearchedJson TEXT NOT NULL DEFAULT '[]',
      modulesSearchedJson TEXT NOT NULL DEFAULT '[]',
      filesSearchedJson TEXT NOT NULL DEFAULT '[]',
      topRowsJson TEXT NOT NULL DEFAULT '[]',
      topChunksJson TEXT NOT NULL DEFAULT '[]',
      topScoresJson TEXT NOT NULL DEFAULT '[]',
      selectedSourcesJson TEXT NOT NULL DEFAULT '[]',
      fallbackUsed INTEGER NOT NULL DEFAULT 0,
      keywordFallbackTermsJson TEXT NOT NULL DEFAULT '[]',
      finalAnswer TEXT NOT NULL DEFAULT '',
      answerUsedRetrievedEvidence INTEGER NOT NULL DEFAULT 0,
      confidenceScore REAL NOT NULL DEFAULT 0,
      answerStatus TEXT NOT NULL DEFAULT 'low_confidence',
      errorMessage TEXT,
      foldersSearched TEXT NOT NULL DEFAULT '[]',
      modulesSearched TEXT NOT NULL DEFAULT '[]',
      vectorTopScore REAL NOT NULL DEFAULT 0,
      keywordFallbackUsed INTEGER NOT NULL DEFAULT 0,
      keywordTermsJson TEXT NOT NULL DEFAULT '[]',
      keywordResultCount INTEGER NOT NULL DEFAULT 0,
      documentConfidence REAL NOT NULL DEFAULT 0,
      sqliteConfidence REAL NOT NULL DEFAULT 0,
      reasonSelected TEXT NOT NULL DEFAULT '',
      feedbackType TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS answer_overrides (
      id TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      originalQuestion TEXT NOT NULL,
      normalizedQuestion TEXT NOT NULL,
      correctAnswer TEXT NOT NULL,
      correctSourceFile TEXT,
      correctFolder TEXT,
      correctModule TEXT,
      notes TEXT,
      createdBy TEXT,
      isActive INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS answer_feedback (
      id TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      rating TEXT,
      feedbackType TEXT NOT NULL,
      correctionId TEXT,
      notes TEXT,
      sourceCorrection TEXT,
      createdBy TEXT
    );
    CREATE TABLE IF NOT EXISTS retrieval_synonyms (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL,
      synonymsJson TEXT NOT NULL DEFAULT '[]',
      folder TEXT,
      module TEXT,
      isActive INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS match_overrides (
      id TEXT PRIMARY KEY,
      override_key TEXT NOT NULL UNIQUE,
      source_a_id TEXT,
      source_b_id TEXT,
      normalized_name_a TEXT,
      normalized_name_b TEXT,
      municipality TEXT,
      decision TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_documents_file_name ON documents(file_name);
    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON document_chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_pdf_pages_document_id ON pdf_pages(document_id);
    CREATE INDEX IF NOT EXISTS idx_pdf_tables_document_id ON pdf_tables(document_id);
    CREATE INDEX IF NOT EXISTS idx_vision_extractions_document_id ON vision_extractions(document_id);
    CREATE INDEX IF NOT EXISTS idx_chat_memory_user ON chat_memory(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_faq_analytics_count ON faq_analytics(ask_count);
    CREATE INDEX IF NOT EXISTS idx_uploaded_sheets_file_id ON uploaded_sheets(file_id);
    CREATE INDEX IF NOT EXISTS idx_sheet_rows_sheet_id ON sheet_rows(sheet_id);
    CREATE INDEX IF NOT EXISTS idx_analysis_history_session ON analysis_history(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_retrieval_logs_created ON retrieval_logs(createdAt);
    CREATE INDEX IF NOT EXISTS idx_retrieval_logs_status ON retrieval_logs(answerStatus, confidenceScore);
    CREATE INDEX IF NOT EXISTS idx_answer_overrides_normalized ON answer_overrides(normalizedQuestion, isActive);
    CREATE INDEX IF NOT EXISTS idx_answer_feedback_type ON answer_feedback(feedbackType, createdAt);
    CREATE INDEX IF NOT EXISTS idx_retrieval_synonyms_term ON retrieval_synonyms(term, isActive);
  `);

  // Migration for missing columns
  const sheetColumns = db.prepare("PRAGMA table_info(uploaded_sheets)").all().map((row: any) => row.name);
  if (!sheetColumns.includes("header_row_index")) db.prepare("ALTER TABLE uploaded_sheets ADD COLUMN header_row_index INTEGER DEFAULT 0").run();
  if (!sheetColumns.includes("header_confidence")) db.prepare("ALTER TABLE uploaded_sheets ADD COLUMN header_confidence REAL DEFAULT 0").run();
  if (!sheetColumns.includes("normalized_headers_json")) db.prepare("ALTER TABLE uploaded_sheets ADD COLUMN normalized_headers_json TEXT DEFAULT '[]'").run();
  const rowColumns = db.prepare("PRAGMA table_info(sheet_rows)").all().map((row: any) => row.name);
  if (!rowColumns.includes("row_text")) db.prepare("ALTER TABLE sheet_rows ADD COLUMN row_text TEXT NOT NULL DEFAULT ''").run();
  const documentColumns = db.prepare("PRAGMA table_info(documents)").all().map((row: any) => row.name);
  if (!documentColumns.includes("chat_attachment")) db.prepare("ALTER TABLE documents ADD COLUMN chat_attachment INTEGER DEFAULT 0").run();
  if (!documentColumns.includes("chat_session_id")) db.prepare("ALTER TABLE documents ADD COLUMN chat_session_id TEXT").run();
  migrateOriginalFileMetadataColumns();
  db.prepare(`CREATE TABLE IF NOT EXISTS vision_extractions (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, file_name TEXT, page_number INTEGER DEFAULT 1,
    image_number INTEGER DEFAULT 1, extraction_method TEXT NOT NULL, model_used TEXT,
    text TEXT NOT NULL DEFAULT '', text_length INTEGER DEFAULT 0, confidence REAL,
    error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_vision_extractions_document_id ON vision_extractions(document_id)").run();
  db.prepare("CREATE TABLE IF NOT EXISTS analysis_history (id TEXT PRIMARY KEY, user_id TEXT, session_id TEXT, question TEXT NOT NULL, answer_summary TEXT NOT NULL DEFAULT '', source_files_json TEXT NOT NULL DEFAULT '[]', tables_json TEXT NOT NULL DEFAULT '[]', chart_data_json TEXT NOT NULL DEFAULT '{}', report_link TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  db.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, feature TEXT, file_id TEXT, file_name TEXT, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  db.prepare("CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL, feedback_type TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  db.prepare("CREATE TABLE IF NOT EXISTS feedback_log (id TEXT PRIMARY KEY, question TEXT NOT NULL, answer TEXT NOT NULL, user_feedback TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, retrieved_sources_json TEXT NOT NULL DEFAULT '[]')").run();
  ensureRetrievalQualityTables();
  db.prepare("CREATE TABLE IF NOT EXISTS match_overrides (id TEXT PRIMARY KEY, override_key TEXT NOT NULL UNIQUE, source_a_id TEXT, source_b_id TEXT, normalized_name_a TEXT, normalized_name_b TEXT, municipality TEXT, decision TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_match_overrides_key ON match_overrides(override_key)").run();
  db.prepare(`CREATE TABLE IF NOT EXISTS match_jobs (
    jobId TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    total INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    exactCount INTEGER NOT NULL DEFAULT 0,
    possibleCount INTEGER NOT NULL DEFAULT 0,
    weakCount INTEGER NOT NULL DEFAULT 0,
    noMatchCount INTEGER NOT NULL DEFAULT 0,
    errorCount INTEGER NOT NULL DEFAULT 0,
    currentPhase TEXT NOT NULL DEFAULT 'Queued',
    startedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completedAt TEXT,
    cancelledAt TEXT,
    elapsedMs INTEGER NOT NULL DEFAULT 0,
    estimatedRemainingMs INTEGER NOT NULL DEFAULT 0,
    sourceSummaryJson TEXT NOT NULL DEFAULT '{}'
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS match_results (
    id TEXT PRIMARY KEY,
    jobId TEXT NOT NULL,
    rowNumber INTEGER,
    inputName TEXT,
    inputSourceFile TEXT,
    inputMunicipality TEXT,
    inputBarangay TEXT,
    inputBirthdate TEXT,
    inputSex TEXT,
    matchedName TEXT,
    source TEXT,
    slpParticipantId TEXT,
    slpUniqueId TEXT,
    fundSource TEXT,
    isPantawid TEXT,
    pantawidStatus TEXT,
    householdId TEXT,
    typeOfParticipant TEXT,
    municipality TEXT,
    barangay TEXT,
    birthdate TEXT,
    sex TEXT,
    finalScore REAL NOT NULL DEFAULT 0,
    category TEXT,
    reason TEXT,
    scoreBreakdownJson TEXT NOT NULL DEFAULT '{}',
    topCandidatesJson TEXT NOT NULL DEFAULT '[]',
    status TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_match_results_job ON match_results(jobId, rowNumber)").run();
  const matchResultColumns = db.prepare("PRAGMA table_info(match_results)").all().map((row: any) => row.name);
  if (!matchResultColumns.includes("inputSourceFile")) db.prepare("ALTER TABLE match_results ADD COLUMN inputSourceFile TEXT NOT NULL DEFAULT ''").run();
  if (!matchResultColumns.includes("isPantawid")) db.prepare("ALTER TABLE match_results ADD COLUMN isPantawid TEXT NOT NULL DEFAULT ''").run();
  if (!matchResultColumns.includes("pantawidStatus")) db.prepare("ALTER TABLE match_results ADD COLUMN pantawidStatus TEXT NOT NULL DEFAULT ''").run();
  if (!matchResultColumns.includes("householdId")) db.prepare("ALTER TABLE match_results ADD COLUMN householdId TEXT NOT NULL DEFAULT ''").run();
  if (!matchResultColumns.includes("typeOfParticipant")) db.prepare("ALTER TABLE match_results ADD COLUMN typeOfParticipant TEXT NOT NULL DEFAULT ''").run();
  db.prepare(`CREATE TABLE IF NOT EXISTS match_feedback (
    id TEXT PRIMARY KEY,
    inputName TEXT,
    matchedName TEXT,
    source TEXT,
    feedback TEXT NOT NULL,
    correctedRecordId TEXT,
    notes TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_analysis_history_session ON analysis_history(session_id, created_at)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)").run();
  db.prepare("CREATE TABLE IF NOT EXISTS original_file_metadata (file_id TEXT PRIMARY KEY, document_id TEXT, original_file_name TEXT NOT NULL, folder TEXT, sub_folder TEXT, source_type TEXT, mime_type TEXT, file_size INTEGER DEFAULT 0, storage_path TEXT, download_url TEXT, parsed_text_id TEXT, parsed_table_id TEXT, upload_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  migrateOriginalFileMetadataColumns();
  db.prepare("CREATE TABLE IF NOT EXISTS chat_memory (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, memory_key TEXT NOT NULL, memory_value TEXT NOT NULL, source_chat_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, memory_key))").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_chat_memory_user ON chat_memory(user_id, updated_at)").run();

  // Create default admin if none exists
  const adminCount = db.prepare("SELECT COUNT(*) AS count FROM profiles WHERE role = 'admin'").get().count;
  if (!adminCount) {
    const email = (process.env.LOCAL_ADMIN_EMAIL || "marvitoriolopez30@gmail.com").trim().toLowerCase();
    const password = process.env.LOCAL_ADMIN_PASSWORD || "Admin123!";
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO profiles (id, email, password_hash, full_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'admin', 'approved', ?, ?)").run(randomId("user"), email, hashPassword(password), email, now, now);
  }
}

function randomId(prefix: string) { return `${prefix}:${crypto.randomUUID()}`; }
function uniqueProposalLineItemId(proposalId: string, section: string, index: number) {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const safeProposalId = String(proposalId || "proposal").replace(/[^a-z0-9_-]+/gi, "_");
  const safeSection = String(section || "section").replace(/[^a-z0-9_-]+/gi, "_");
  return `${safeProposalId}-${safeSection}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 10)}`;
}
function ensureRetrievalQualityTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_logs (
      id TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      userQuestion TEXT NOT NULL,
      normalizedQuestion TEXT,
      detectedIntent TEXT,
      selectedRoute TEXT NOT NULL DEFAULT '',
      retrievalMode TEXT,
      foldersSearchedJson TEXT NOT NULL DEFAULT '[]',
      modulesSearchedJson TEXT NOT NULL DEFAULT '[]',
      filesSearchedJson TEXT NOT NULL DEFAULT '[]',
      topRowsJson TEXT NOT NULL DEFAULT '[]',
      topChunksJson TEXT NOT NULL DEFAULT '[]',
      topScoresJson TEXT NOT NULL DEFAULT '[]',
      selectedSourcesJson TEXT NOT NULL DEFAULT '[]',
      fallbackUsed INTEGER NOT NULL DEFAULT 0,
      keywordFallbackTermsJson TEXT NOT NULL DEFAULT '[]',
      finalAnswer TEXT NOT NULL DEFAULT '',
      answerUsedRetrievedEvidence INTEGER NOT NULL DEFAULT 0,
      confidenceScore REAL NOT NULL DEFAULT 0,
      answerStatus TEXT NOT NULL DEFAULT 'low_confidence',
      errorMessage TEXT,
      foldersSearched TEXT NOT NULL DEFAULT '[]',
      modulesSearched TEXT NOT NULL DEFAULT '[]',
      vectorTopScore REAL NOT NULL DEFAULT 0,
      keywordFallbackUsed INTEGER NOT NULL DEFAULT 0,
      keywordTermsJson TEXT NOT NULL DEFAULT '[]',
      keywordResultCount INTEGER NOT NULL DEFAULT 0,
      documentConfidence REAL NOT NULL DEFAULT 0,
      sqliteConfidence REAL NOT NULL DEFAULT 0,
      reasonSelected TEXT NOT NULL DEFAULT '',
      feedbackType TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS answer_overrides (
      id TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      originalQuestion TEXT NOT NULL,
      normalizedQuestion TEXT NOT NULL,
      correctAnswer TEXT NOT NULL,
      correctSourceFile TEXT,
      correctFolder TEXT,
      correctModule TEXT,
      notes TEXT,
      createdBy TEXT,
      isActive INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS answer_feedback (
      id TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      rating TEXT,
      feedbackType TEXT NOT NULL,
      correctionId TEXT,
      notes TEXT,
      sourceCorrection TEXT,
      createdBy TEXT
    );
    CREATE TABLE IF NOT EXISTS retrieval_synonyms (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL,
      synonymsJson TEXT NOT NULL DEFAULT '[]',
      folder TEXT,
      module TEXT,
      isActive INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_retrieval_logs_created ON retrieval_logs(createdAt);
    CREATE INDEX IF NOT EXISTS idx_retrieval_logs_status ON retrieval_logs(answerStatus, confidenceScore);
    CREATE INDEX IF NOT EXISTS idx_answer_overrides_normalized ON answer_overrides(normalizedQuestion, isActive);
    CREATE INDEX IF NOT EXISTS idx_answer_feedback_type ON answer_feedback(feedbackType, createdAt);
    CREATE INDEX IF NOT EXISTS idx_retrieval_synonyms_term ON retrieval_synonyms(term, isActive);
  `);
  migrateRetrievalQualityColumns();
}
function migrateRetrievalQualityColumns() {
  const addColumn = (table: string, name: string, definition: string) => {
    const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((row) => row.name));
    if (!existing.has(name)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
  };
  addColumn("retrieval_logs", "normalizedQuestion", "TEXT");
  addColumn("retrieval_logs", "selectedRoute", "TEXT NOT NULL DEFAULT ''");
  addColumn("retrieval_logs", "foldersSearchedJson", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("retrieval_logs", "modulesSearchedJson", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("retrieval_logs", "filesSearchedJson", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("retrieval_logs", "topRowsJson", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("retrieval_logs", "fallbackUsed", "INTEGER NOT NULL DEFAULT 0");
  addColumn("retrieval_logs", "keywordFallbackTermsJson", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("answer_feedback", "sourceCorrection", "TEXT");
  addColumn("answer_feedback", "createdBy", "TEXT");
}
function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password: string, stored: string) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex"));
}
function publicProfile(row: any) {
  if (!row) return null;
  return { id: row.id, email: row.email, full_name: row.full_name || "", role: row.role, status: row.status, created_at: row.created_at, updated_at: row.updated_at };
}
function insertChatLog(userId: string | null | undefined, message: string, response: string) {
  db.prepare("INSERT INTO chat_logs (id, user_id, message, response, created_at) VALUES (?, ?, ?, ?, ?)").run(randomId("chat"), userId || null, message, response, new Date().toISOString());
}
function insertAuditLog(input: { userId?: string | null; action: string; feature?: string; fileId?: string; fileName?: string; details?: any }) {
  try {
    db.prepare("INSERT INTO audit_logs (id, user_id, action, feature, file_id, file_name, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomId("audit"), input.userId || null, input.action, input.feature || "", input.fileId || "", input.fileName || "", JSON.stringify(input.details || {}), new Date().toISOString());
  } catch (error) { console.error("Audit log failed:", error); }
}

function sourceTypeForFolder(folder = "", fileName = "", fileType = "") {
  return classifyDataSource(fileName, folder, "", [], fileType).sourceType;
}

function normalizeLocalDocumentFolder(value: any, fallback = "SLPIS") {
  const folder = String(value || fallback).trim().toUpperCase();
  return LOCAL_DOCUMENT_FOLDERS.has(folder) ? folder : fallback;
}

function migrateOriginalFileMetadataColumns() {
  const existing = new Set((db.prepare("PRAGMA table_info(original_file_metadata)").all() as any[]).map((row) => row.name));
  const addColumn = (name: string, definition: string) => {
    if (!existing.has(name)) db.prepare(`ALTER TABLE original_file_metadata ADD COLUMN ${name} ${definition}`).run();
  };
  addColumn("document_type", "TEXT");
  addColumn("document_purpose", "TEXT");
  addColumn("document_stage", "TEXT");
  addColumn("keywords", "TEXT DEFAULT '[]'");
  addColumn("related_topics", "TEXT DEFAULT '[]'");
  addColumn("short_summary", "TEXT");
  addColumn("classification_confidence", "REAL DEFAULT 0");
  addColumn("classification_reason", "TEXT");
  addColumn("matched_patterns", "TEXT DEFAULT '{}'");
  addColumn("warnings", "TEXT DEFAULT '[]'");
  addColumn("classification_override", "INTEGER DEFAULT 0");
  addColumn("relative_path", "TEXT DEFAULT ''");
  addColumn("proposal_id", "TEXT DEFAULT ''");
  addColumn("proposal_root_folder", "TEXT DEFAULT ''");
}

function storagePathFromFileUrl(fileUrl = "") {
  if (!String(fileUrl || "").startsWith("local-upload://")) return "";
  return path.resolve(UPLOAD_ROOT, String(fileUrl).replace("local-upload://", ""));
}

function safeJsonArray(value: any) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonObject(value: any) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function spreadsheetClassificationContext(doc: any) {
  const sheets = parseXlsxContent(doc.content_text || "", { fileName: doc.file_name, folder: doc.folder, file_type: doc.file_type });
  const detectedHeaders = Array.from(new Set(sheets.flatMap((sheet) => sheet.headers || []))).slice(0, 80);
  const sampleRows = sheets.flatMap((sheet) => (sheet.rows || []).slice(0, 20)).slice(0, 80);
  return { sheetNames: sheets.map((sheet) => sheet.sheetName).filter(Boolean), detectedHeaders, sampleRows };
}

function shortDocumentSummary(content = "") {
  if (!content || content.trim().startsWith("{\"__slpWorkbook\"")) return "";
  return String(content).replace(/\s+/g, " ").trim().slice(0, 300);
}

function upsertOriginalFileMetadata(doc: any, options: { forceReclassify?: boolean } = {}) {
  if (!doc?.id || !doc?.file_name) return;
  const now = new Date().toISOString();
  const sourceType = sourceTypeForFolder(doc.folder || "", doc.file_name || "", doc.file_type || "");
  const storagePath = storagePathFromFileUrl(doc.file_url || "");
  const existing = db.prepare("SELECT * FROM original_file_metadata WHERE file_id = ?").get(doc.id) as any;
  const preserveOverride = existing?.classification_override && !options.forceReclassify;
  const spreadsheetContext = spreadsheetClassificationContext(doc);
  const classification = preserveOverride ? {
    documentType: existing.document_type || "OTHER_DOCUMENT",
    documentPurpose: existing.document_purpose || "",
    documentStage: existing.document_stage || "",
    keywords: safeJsonArray(existing.keywords),
    relatedTopics: safeJsonArray(existing.related_topics),
    confidence: Number(existing.classification_confidence || 0),
    reason: existing.classification_reason || "Admin override preserved.",
    matchedPatterns: safeJsonObject(existing.matched_patterns),
    warnings: safeJsonArray(existing.warnings),
  } : classifyDocument({
    fileId: doc.id,
    originalFileName: doc.file_name,
    folder: doc.folder || "",
    subFolder: "",
    sourceType,
    extractedText: doc.content_text || "",
    mimeType: doc.file_type || mimeTypeFromFileName(doc.file_name || ""),
    ...spreadsheetContext,
  });
  db.prepare(`
    INSERT INTO original_file_metadata
      (file_id, document_id, original_file_name, folder, sub_folder, source_type, mime_type, file_size, storage_path, download_url, parsed_text_id, parsed_table_id, upload_date, updated_at,
       document_type, document_purpose, document_stage, keywords, related_topics, short_summary, classification_confidence, classification_reason, matched_patterns, warnings, classification_override)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_id) DO UPDATE SET
      document_id = excluded.document_id,
      original_file_name = excluded.original_file_name,
      folder = excluded.folder,
      sub_folder = excluded.sub_folder,
      source_type = excluded.source_type,
      mime_type = excluded.mime_type,
      file_size = excluded.file_size,
      storage_path = excluded.storage_path,
      download_url = excluded.download_url,
      parsed_text_id = excluded.parsed_text_id,
      parsed_table_id = excluded.parsed_table_id,
      document_type = excluded.document_type,
      document_purpose = excluded.document_purpose,
      document_stage = excluded.document_stage,
      keywords = excluded.keywords,
      related_topics = excluded.related_topics,
      short_summary = excluded.short_summary,
      classification_confidence = excluded.classification_confidence,
      classification_reason = excluded.classification_reason,
      matched_patterns = excluded.matched_patterns,
      warnings = excluded.warnings,
      classification_override = excluded.classification_override,
      updated_at = excluded.updated_at
  `).run(
    doc.id,
    doc.id,
    doc.file_name,
    doc.folder || "",
    "",
    sourceType,
    doc.file_type || mimeTypeFromFileName(doc.file_name || ""),
    doc.file_size || 0,
    storagePath,
    storagePath ? downloadUrlForDocument(doc.id) : "",
    doc.id,
    "",
    doc.created_at || now,
    now,
    classification.documentType,
    classification.documentPurpose,
    classification.documentStage,
    JSON.stringify(classification.keywords || []),
    JSON.stringify(classification.relatedTopics || []),
    shortDocumentSummary(doc.content_text || ""),
    classification.confidence || 0,
    classification.reason || "",
    JSON.stringify(classification.matchedPatterns || {}),
    JSON.stringify(classification.warnings || []),
    preserveOverride ? 1 : 0
  );
}
let lastRetrievalDebug: any = null;
function storeRetrievalDebug(input: { userId?: string | null; sessionId?: string; question: string; intent: string; modules: SlpModuleTag[] | string[]; queryUsed?: string; rowsMatched?: number; reason?: string; matchedRows?: any[]; filesChecked?: string[] }) {
  lastRetrievalDebug = { ...input, createdAt: new Date().toISOString(), matchedRows: (input.matchedRows || []).slice(0, 100), filesChecked: (input.filesChecked || []).slice(0, 100) };
  debugRetrieval("stored", { intent: input.intent, modules: input.modules, rowsMatched: input.rowsMatched, reason: input.reason });
}
function extractSourcesFromAnswer(answer: string) {
  const bulletSources = Array.from(answer.matchAll(/^- (.+)$/gm)).map((match) => match[1]);
  const labeledSources = Array.from(answer.matchAll(/\bSource(?: Used)?:\s*([^\n\r]+)/gi)).map((match) => match[1]);
  return [...bulletSources, ...labeledSources]
    .map((line) => line.trim())
    .filter((line) => !/Intent:|Action:|Type:|Topic:|Required|Grouped|Filtered|Excel-style|No web|Checked|This was/.test(line))
    .slice(0, 20);
}
function saveAnalysisHistory(input: { userId?: string | null; sessionId: string; question: string; answer: string }) {
  try {
    db.prepare("INSERT INTO analysis_history (id, user_id, session_id, question, answer_summary, source_files_json, tables_json, chart_data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, '[]', '{}', ?)")
      .run(randomId("analysis"), input.userId || null, input.sessionId, input.question, input.answer.replace(/\s+/g, " ").slice(0, 1200), JSON.stringify(extractSourcesFromAnswer(input.answer)), new Date().toISOString());
  } catch (error) { console.error("Analysis history save failed:", error); }
}
function loadChatMemory(userId?: string | null) {
  if (!userId) return [] as Array<{ memory_key: string; memory_value: string; updated_at: string }>;
  try {
    return db.prepare("SELECT memory_key, memory_value, updated_at FROM chat_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20").all(userId) as Array<{ memory_key: string; memory_value: string; updated_at: string }>;
  } catch (error) {
    console.error("Chat memory load failed:", error);
    return [];
  }
}
function upsertChatMemory(userId: string | null | undefined, key: string, value: any, sourceChatId = "") {
  if (!userId || !key) return;
  const memoryValue = typeof value === "string" ? value : JSON.stringify(value);
  if (!memoryValue || memoryValue.length > 2000) return;
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO chat_memory (id, user_id, memory_key, memory_value, source_chat_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, memory_key) DO UPDATE SET memory_value = excluded.memory_value, source_chat_id = excluded.source_chat_id, updated_at = excluded.updated_at
    `).run(randomId("mem"), userId, key, memoryValue, sourceChatId, now, now);
  } catch (error) {
    console.error("Chat memory save failed:", error);
  }
}
function saveUsefulChatMemory(userId: string | null | undefined, sessionId: string, message: string, parsed: ParsedQuery, classified: ClassifiedQuestion, answer: string) {
  if (!userId) return;
  const filters = extractStrictFilters(message, parsed);
  const usefulFilters = Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
  if (Object.keys(usefulFilters).length) upsertChatMemory(userId, "recent_filters", usefulFilters, sessionId);
  if (classified.requiredModules.length) upsertChatMemory(userId, "recent_modules", classified.requiredModules.slice(0, 6), sessionId);
  if (classified.intent !== "unknown") upsertChatMemory(userId, "recent_intent", classified.intent, sessionId);
  const sources = extractSourcesFromAnswer(answer).slice(0, 5);
  if (sources.length) upsertChatMemory(userId, "recent_sources", sources, sessionId);
}
function logRouteDiagnostics(route: QueryRoute, query: string, answer = "", finalSource = "", evidence = false) {
  const diagnostics = {
    userQuery: query,
    detectedIntent: route.intent,
    confidence: route.confidence,
    confidenceScore: route.confidenceScore,
    sourceTypesSelected: [...route.primarySourceTypes, ...route.secondarySourceTypes],
    retrievalMode: route.retrievalMode,
    reason: route.reason,
    finalSourceUsed: finalSource || extractSourcesFromAnswer(answer)[0] || "",
    answerCameFrom: route.retrievalMode,
    hasEvidence: evidence || /\*\*Source Used\*\*|\nSource:\s+/i.test(answer),
    fallbackStrategy: route.fallbackStrategy,
  };
  console.log(`[QUERY_ROUTER] ${JSON.stringify(diagnostics)}`);
  lastRetrievalDebug = { ...(lastRetrievalDebug || {}), routeDiagnostics: diagnostics, createdAt: new Date().toISOString() };
}

type RetrievalAnswerStatus = "answered" | "refused_no_evidence" | "low_confidence" | "used_override" | "error";

function normalizedQuestionKey(question = "") {
  return normalizeName(question)
    .replace(/\b(please|kindly|can you|could you|show me|tell me|about|the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function activeRetrievalSynonyms() {
  try {
    return db.prepare("SELECT * FROM retrieval_synonyms WHERE isActive = 1 ORDER BY term ASC").all() as any[];
  } catch {
    return [];
  }
}

function expandTermsWithSynonyms(terms: string[], folder = "", module = "") {
  const normalizedTerms = new Set(terms.map(normalizeName).filter(Boolean));
  for (const row of activeRetrievalSynonyms()) {
    const term = normalizeName(row.term || "");
    const appliesToFolder = !row.folder || !folder || normalizeName(row.folder) === normalizeName(folder);
    const appliesToModule = !row.module || !module || normalizeName(row.module) === normalizeName(module);
    if (!term || !appliesToFolder || !appliesToModule) continue;
    const synonyms = safeJsonArray(row.synonymsJson).map((item: any) => normalizeName(String(item))).filter(Boolean);
    if (normalizedTerms.has(term) || synonyms.some((synonym: string) => normalizedTerms.has(synonym))) {
      normalizedTerms.add(term);
      synonyms.forEach((synonym: string) => normalizedTerms.add(synonym));
    }
  }
  return Array.from(normalizedTerms);
}

function retrievalKeywords(question: string) {
  const base = tokenizeForSearch(question)
    .map(normalizeName)
    .filter((term) => term.length >= 3 && !/^(what|when|where|which|show|list|give|from|with|without|about|does|this|that|have|into|using|based)$/.test(term));
  const phrases = extractExactPhrases(question);
  return expandTermsWithSynonyms(Array.from(new Set([...base, ...phrases])));
}

function findAnswerOverride(question: string) {
  const normalized = normalizedQuestionKey(question);
  if (!normalized) return null;
  const exact = db.prepare("SELECT * FROM answer_overrides WHERE isActive = 1 AND normalizedQuestion = ? ORDER BY createdAt DESC LIMIT 1").get(normalized) as any;
  if (exact) return { row: exact, score: 1, matchType: "exact" };
  const rows = db.prepare("SELECT * FROM answer_overrides WHERE isActive = 1 ORDER BY createdAt DESC LIMIT 300").all() as any[];
  const similar = rows
    .map((row) => {
      const other = String(row.normalizedQuestion || "");
      const score = normalized && other ? 1 - levenshtein(normalized, other) / Math.max(normalized.length, other.length) : 0;
      const tokenOverlap = overlapScore(normalized.split(" "), other.split(" "));
      return { row, score: Math.max(score, tokenOverlap), matchType: "similar" };
    })
    .sort((a, b) => b.score - a.score)[0];
  return similar && similar.score >= 0.82 ? similar : null;
}

function overlapScore(left: string[], right: string[]) {
  const a = new Set(left.filter((item) => item.length > 2));
  const b = new Set(right.filter((item) => item.length > 2));
  if (!a.size || !b.size) return 0;
  const common = Array.from(a).filter((item) => b.has(item)).length;
  return common / Math.max(a.size, b.size);
}

function answerFromOverride(match: any) {
  const row = match.row;
  return [
    "**Direct Answer**",
    "User-taught answer:",
    row.correctAnswer,
    "",
    "**Source Used**",
    row.correctSourceFile || row.correctFolder || row.correctModule
      ? `- Source file: ${row.correctSourceFile || "Not specified"}; folder/module: ${[row.correctFolder, row.correctModule].filter(Boolean).join(" / ") || "Not specified"}; evidence type: user-taught override`
      : "- User-taught override; no source file was provided.",
    "",
    "**Data Quality Notes**",
    `- Override match: ${match.matchType}; similarity ${Math.round(Number(match.score || 0) * 100)}%.`,
    "- This answer was saved through the teaching loop and is labeled separately from uploaded-document retrieval.",
  ].join("\n");
}

function keywordFallbackSearch(question: string, sources: any[], route: QueryRoute | null = null) {
  const terms = retrievalKeywords(question);
  if (!terms.length) return { terms, results: [] as any[] };
  const routeTypes = new Set([...(route?.primarySourceTypes || []), ...(route?.secondarySourceTypes || [])].map(canonicalEvidenceSourceType));
  const results = sources.flatMap((source: any) => {
    const metadata = documentMetadata(source);
    const label = sourceLabelForDocument(source);
    const sourceType = canonicalEvidenceSourceType(documentSourceType(source));
    const folder = String(metadata?.folder || source.folder || "");
    const module = String(metadata?.source_type || sourceType || "");
    const expanded = expandTermsWithSynonyms(terms, folder, module);
    return splitEvidenceBlocks(source.content_text || "").map((block) => {
      const haystack = normalizeName([
        label,
        folder,
        module,
        metadata?.document_type || "",
        metadata?.document_purpose || "",
        block.heading,
        block.text,
      ].join(" "));
      const titleHaystack = normalizeName([label, folder, module, block.heading].join(" "));
      const hits = expanded.filter((term) => haystack.includes(term));
      const titleHits = expanded.filter((term) => titleHaystack.includes(term));
      const phraseHits = queryPhrases(question).filter((phrase) => haystack.includes(phrase));
      const routeBoost = routeTypes.size && routeTypes.has(sourceType) ? 35 : routeTypes.size ? -35 : 0;
      const score = hits.length * 18 + titleHits.length * 24 + phraseHits.length * 55 + routeBoost;
      return {
        source,
        label,
        sourceType,
        heading: block.heading,
        text: block.text,
        score,
        keywordFallback: true,
        keywordHits: hits,
      };
    });
  }).filter((item) => item.score >= 30 && item.keywordHits.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  return { terms, results };
}

function keywordFallbackRows(question: string, attachmentIds: string[] = []) {
  const terms = retrievalKeywords(question);
  if (!terms.length) return { terms, results: [] as any[] };
  const sources = attachmentIds.length ? loadSheetSources({ attachmentIds }) : loadSheetSources({ includeChatAttachments: true });
  const results: any[] = [];
  for (const source of sources.slice(0, 40) as any[]) {
    const module = String(source.sourceType || source.module || source.folder || source.source || "");
    const expanded = expandTermsWithSynonyms(terms, String(source.folder || ""), module);
    const sourceText = normalizeName(`${source.source || ""} ${source.folder || ""} ${(source.headers || []).join(" ")}`);
    for (const row of (source.rows || []).slice(0, 250)) {
      const rowText = normalizeName(`${sourceText} ${Object.values(row || {}).join(" ")}`);
      const hits = expanded.filter((term) => rowText.includes(term));
      if (!hits.length) continue;
      const headerHits = expanded.filter((term) => sourceText.includes(term)).length;
      const score = hits.length * 14 + headerHits * 20 + (sourceText.includes(normalizeName(question)) ? 40 : 0);
      if (score < 28) continue;
      results.push({
        source: source.source || source.fileName || "SQLite source",
        module,
        rowNumber: row.__rowNumber || row.row_index || "",
        score,
        keywordHits: hits,
        values: Object.fromEntries((source.headers || Object.keys(row || {})).slice(0, 10).map((header: string) => [header, row[header] ?? ""])),
      });
    }
  }
  return { terms, results: results.sort((a, b) => b.score - a.score).slice(0, 8) };
}

function mergeRetrievalCandidates(vectorCandidates: any[], keywordCandidates: any[]) {
  const byKey = new Map<string, any>();
  for (const item of [...vectorCandidates, ...keywordCandidates]) {
    const key = `${item.label}|${item.heading}|${String(item.text || "").slice(0, 160)}`;
    const previous = byKey.get(key);
    const combinedScore = Number(item.score || 0) + (item.keywordFallback ? 18 : 0);
    if (!previous || combinedScore > Number(previous.score || 0)) byKey.set(key, { ...item, score: combinedScore });
  }
  return Array.from(byKey.values()).sort((a, b) => b.score - a.score);
}

function computeRetrievalConfidence(trace: any, answer: string, route: QueryRoute | null = null) {
  const topScore = Math.max(0, ...((trace?.topRetrievedChunks || []).map((chunk: any) => Number(chunk.score || 0))));
  const sourceCount = extractSourcesFromAnswer(answer).length || (trace?.finalSourceUsed ? 1 : 0);
  const hasEvidence = Boolean(trace?.finalEvidenceText || trace?.sqliteResult || sourceCount);
  const refused = isNoUploadedSourceAnswer(answer) || /not enough verified|not strong enough|could not find|no supporting source/i.test(answer);
  if (refused) return 0.35;
  const verified = trace?.evidenceVerificationPassed !== false;
  let score = 0;
  if (hasEvidence) score += 0.35;
  if (sourceCount) score += 0.15;
  if (verified) score += 0.15;
  if (trace?.sqliteResult) score += 0.2;
  if (topScore) score += Math.min(0.3, topScore / 350);
  if (route?.confidenceScore) score += Math.min(0.15, route.confidenceScore / 10);
  if (refused) score = Math.min(score, 0.35);
  return Math.max(0, Math.min(1, score));
}

function answerStatusFor(answer: string, confidenceScore: number, usedEvidence: boolean): RetrievalAnswerStatus {
  if (isNoUploadedSourceAnswer(answer) || /not enough verified|not strong enough|could not find|no supporting source/i.test(answer)) return "refused_no_evidence";
  if (confidenceScore < 0.45) return "low_confidence";
  if (!usedEvidence) return "low_confidence";
  return "answered";
}

function lowConfidenceEvidenceAnswer(trace: any) {
  const files = (trace?.topRetrievedChunks || []).slice(0, 5).map((chunk: any) => `- ${chunk.source || chunk.fileName || "Unknown source"}${chunk.score ? ` — score ${chunk.score}` : ""}`);
  const rows = (trace?.topRows || []).slice(0, 3).map((row: any) => `- ${row.source || row.module || "SQLite row"}${row.score ? ` — score ${row.score}` : ""}`);
  if (!files.length && !rows.length) {
    return [
      "**Direct Answer**",
      "I cannot answer this from the available uploaded data.",
      "",
      "**Sources Searched**",
      ...((trace?.filesSearched || []).length ? trace.filesSearched.map((item: string) => `- ${item}`) : ["- Uploaded document and SQLite sources"]),
      "",
      "**Suggested Next Action**",
      "- Upload the correct source, search another folder, or ask a broader question.",
    ].join("\n");
  }
  return [
    "**Direct Answer**",
    "I found possible related information, but the available uploaded data is not strong enough to answer confidently.",
    "",
    "**Sources Searched**",
    ...((trace?.filesSearched || []).length ? trace.filesSearched.map((item: string) => `- ${item}`) : ["- Uploaded document and SQLite sources"]),
    "",
    "**Best Matching Files**",
    ...(files.length ? files : ["- No strong match found."]),
    ...(rows.length ? ["", "**Best Matching Rows**", ...rows] : []),
    "",
    "**Suggested Next Action**",
    "- Upload the correct source file, add a synonym/routing rule, or teach the correct answer using the feedback control.",
  ].join("\n");
}

function cannotAnswerFromUploadedData(trace: any) {
  return [
    "**Direct Answer**",
    "I cannot answer this from the available uploaded data.",
    "",
    "**Sources Searched**",
    ...((trace?.filesSearched || []).length ? trace.filesSearched.map((item: string) => `- ${item}`) : ["- Uploaded document and SQLite sources"]),
    "",
    "**Suggested Next Action**",
    "- Upload the correct source, search another folder, or ask a broader question.",
  ].join("\n");
}

function unsupportedQuestionTerms(question: string, trace: any) {
  const evidence = normalizeName([
    trace?.finalEvidenceText || "",
    (trace?.topRetrievedChunks || []).map((chunk: any) => `${chunk.heading || ""} ${chunk.preview || ""} ${chunk.source || ""}`).join(" "),
    (trace?.topRows || []).map((row: any) => `${row.source || ""} ${JSON.stringify(row.values || row)}`).join(" "),
  ].join(" "));
  const terms = retrievalKeywords(question)
    .filter((term) => term.length >= 6)
    .filter((term) => !/^(official|available|uploaded|documents?|guidelines?|policy|aurora|municipality|participants?|projects?|status|source|answer)$/.test(term));
  return terms.filter((term) => !evidence.includes(term)).slice(0, 8);
}

function saveRetrievalLog(input: {
  question: string;
  route: QueryRoute | null;
  retrievalMode: string;
  trace: any;
  answer: string;
  confidenceScore: number;
  answerStatus: RetrievalAnswerStatus;
  errorMessage?: string;
}) {
  const trace = input.trace || {};
  const topChunks = trace.topRetrievedChunks || [];
  const topRows = trace.topRows || trace.matchedRows || trace.sqliteResult?.debug?.matchedRowsPreview || trace.sqliteResult?.matchedRows || [];
  const selectedSources = extractSourcesFromAnswer(input.answer);
  const fallbackUsed = Boolean(trace.keywordFallbackUsed || input.retrievalMode === "fallback_keyword");
  const answerUsedRetrievedEvidence = input.answerStatus !== "refused_no_evidence" && Boolean(trace.finalEvidenceText || trace.sqliteResult || selectedSources.length);
  try {
    const foldersSearched = trace.filesSearched || [];
    const modulesSearched = trace.selectedSourceTypes || input.route?.primarySourceTypes || [];
    const selectedRoute = input.retrievalMode === "override"
      ? "override"
      : input.answerStatus === "refused_no_evidence"
      ? "refused"
      : fallbackUsed
      ? "fallback_keyword"
      : String(trace.selectedRoute || input.retrievalMode || "");
    db.prepare(`
      INSERT INTO retrieval_logs (
        id, createdAt, userQuestion, normalizedQuestion, detectedIntent, selectedRoute, retrievalMode,
        foldersSearchedJson, modulesSearchedJson, filesSearchedJson, topChunksJson, topRowsJson, topScoresJson,
        selectedSourcesJson, fallbackUsed, keywordFallbackTermsJson, finalAnswer, answerUsedRetrievedEvidence,
        confidenceScore, answerStatus, errorMessage, foldersSearched, modulesSearched, vectorTopScore,
        keywordFallbackUsed, keywordTermsJson, keywordResultCount, documentConfidence, sqliteConfidence,
        reasonSelected
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomId("retrieval"),
      new Date().toISOString(),
      input.question,
      normalizedQuestionKey(input.question),
      input.route?.intent || trace.detectedIntent || "",
      selectedRoute,
      input.retrievalMode,
      JSON.stringify(foldersSearched),
      JSON.stringify(modulesSearched),
      JSON.stringify(foldersSearched),
      JSON.stringify(topChunks.slice(0, 3)),
      JSON.stringify((Array.isArray(topRows) ? topRows : []).slice(0, 3)),
      JSON.stringify(topChunks.slice(0, 3).map((chunk: any) => chunk.score || 0)),
      JSON.stringify(selectedSources),
      fallbackUsed ? 1 : 0,
      JSON.stringify(trace.keywordTermsUsed || []),
      String(input.answer || "").slice(0, 8000),
      answerUsedRetrievedEvidence ? 1 : 0,
      input.confidenceScore,
      input.answerStatus,
      input.errorMessage || "",
      JSON.stringify(foldersSearched),
      JSON.stringify(modulesSearched),
      Number(trace.vectorTopScore || topChunks[0]?.score || 0),
      fallbackUsed ? 1 : 0,
      JSON.stringify(trace.keywordTermsUsed || []),
      Number(trace.keywordResultCount || 0),
      Number(trace.documentConfidence || 0),
      Number(trace.sqliteConfidence || 0),
      String(trace.reasonSelected || "")
    );
    console.log("RETRIEVAL VERIFY", {
      question: input.question,
      detectedIntent: input.route?.intent || trace.detectedIntent || "",
      selectedRoute,
      topChunksCount: topChunks.length,
      topRowsCount: Array.isArray(topRows) ? topRows.length : 0,
      fallbackUsed,
      selectedSourcesCount: selectedSources.length,
      confidenceScore: input.confidenceScore,
      answerStatus: input.answerStatus,
      logSaved: true,
    });
    return true;
  } catch (error) {
    console.error("Retrieval log save failed:", error);
    console.log("RETRIEVAL VERIFY", {
      question: input.question,
      detectedIntent: input.route?.intent || trace.detectedIntent || "",
      selectedRoute: trace.selectedRoute || input.retrievalMode || "",
      topChunksCount: topChunks.length,
      topRowsCount: Array.isArray(topRows) ? topRows.length : 0,
      fallbackUsed,
      selectedSourcesCount: selectedSources.length,
      confidenceScore: input.confidenceScore,
      answerStatus: input.answerStatus,
      logSaved: false,
    });
    return false;
  }
}

function retrievalRoutePlan(message: string, parsed: ParsedQuery, queryRoute: QueryRoute) {
  const lower = normalizeName(message);
  const documentSignals = /\b(policy|guideline|guidelines|process|phase|definition|define|eligibility|requirement|template|form|annex|document|memo|proposal)\b/.test(lower);
  const sqliteSignals = /\b(count|total|how many|status|municipality|project|participant|training|gur|monitoring|operational|closed|table|dashboard|row|list all|without|with)\b/.test(lower);
  const ambiguous = documentSignals && sqliteSignals || queryRoute.retrievalMode === "clarify";
  const selectedRoute = ambiguous ? "both" : sqliteSignals || queryRoute.retrievalMode === "structured" || queryRoute.retrievalMode === "cross_check" ? "sqlite" : "document";
  return { documentSignals, sqliteSignals, ambiguous, selectedRoute };
}

async function estimateDocumentConfidence(message: string, parsed: ParsedQuery, route: QueryRoute, attachmentIds: string[]) {
  const sources = await loadDocumentTextSources(attachmentIds);
  const sourceTypes = Array.from(new Set([...route.primarySourceTypes, ...route.secondarySourceTypes]));
  const relevant = sourceTypes.length ? sources.filter((source: any) => sourceTypes.map(canonicalEvidenceSourceType).includes(canonicalEvidenceSourceType(documentSourceType(source)))) : sources;
  const candidates = relevant.flatMap((source: any) => splitEvidenceBlocks(source.content_text || "").map((block) => scoreEvidenceBlock(message, parsed, route, source, block)));
  const top = Math.max(0, ...candidates);
  return Math.min(1, top / 220);
}

function estimateSqliteConfidence(message: string, parsed: ParsedQuery, route: QueryRoute) {
  if (route.retrievalMode !== "structured" && route.retrievalMode !== "cross_check" && !/\b(count|total|status|municipality|project|participant|training|gur|monitoring|operational|closed|dashboard)\b/i.test(message)) return 0;
  const lookup = buildRowLookupAnswer(message, parsed);
  const matched = Number(lookup?.debug?.matchedRows || 0);
  if (matched > 0) return Math.min(1, 0.55 + Math.min(0.35, matched / 50));
  return route.retrievalMode === "structured" ? 0.4 : 0.15;
}

function sourceAwareSuggestedQuestions(trace: any, route: QueryRoute | null, answerStatus: RetrievalAnswerStatus | string = "") {
  if (answerStatus === "refused_no_evidence" || answerStatus === "low_confidence" && !(trace?.topRetrievedChunks || []).length && !(trace?.topRows || []).length) {
    return [];
  }
  const suggestions = new Set<string>();
  for (const chunk of (trace?.topRetrievedChunks || []).slice(0, 5)) {
    const heading = String(chunk.heading || "").replace(/^Unlabeled section$/i, "").trim();
    const sourceType = String(chunk.sourceType || "").trim();
    if (heading && chunk.score >= 60) suggestions.add(`Explain ${heading} from ${sourceType || "the retrieved source"}`);
    if (sourceType) suggestions.add(`Show supporting source details from ${sourceType}`);
  }
  for (const module of (trace?.selectedSourceTypes || route?.primarySourceTypes || []).slice(0, 3)) {
    if (module) suggestions.add(`Show available evidence from ${module}`);
  }
  try {
    const overrides = db.prepare("SELECT originalQuestion FROM answer_overrides WHERE isActive = 1 ORDER BY createdAt DESC LIMIT 3").all() as any[];
    overrides.forEach((row) => {
      if (row.originalQuestion && findAnswerOverride(row.originalQuestion)) suggestions.add(row.originalQuestion);
    });
  } catch {}
  return Array.from(suggestions).filter((item) => item.length > 8).slice(0, 5);
}
function normalizeName(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function titleCaseLabel(value: string) {
  const acronyms = new Set(["slp", "slpa", "gur", "4ps"]);
  return normalizeName(value).split(" ").filter(Boolean).map((word) => acronyms.has(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
function normalizeEnterpriseProjectType(value: string) {
  let normalized = normalizeName(value);
  normalized = normalized
    .replace(/\bsari\s*sari\s*vending\b/g, "sari sari vending")
    .replace(/\bgoat\s*raising\b/g, "goat raising")
    .replace(/\bhog\s*raising\b/g, "hog raising")
    .replace(/\bpig\s*raising\b/g, "pig raising")
    .replace(/\bfish\s*vendor\b/g, "fish vending")
    .replace(/\bfood\s*vending\b/g, "food vending");
  const compactKey = normalized.replace(/\s+/g, "");
  const aliases: Record<string, string> = {
    sarisarivending: "Sari-Sari Vending",
    goatraising: "Goat Raising",
    hograising: "Hog Raising",
    pigraising: "Pig Raising",
    fishvending: "Fish Vending",
    foodvending: "Food Vending",
  };
  return { key: compactKey, label: aliases[compactKey] || titleCaseLabel(normalized) || "Unspecified" };
}
function normalizeColumnName(value: string) {
  return normalizeName(value).replace(/\b(no|number|num)\b/g, "number").trim();
}
function similarityScore(a: string, b: string) {
  const left = normalizeName(a), right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 100;
  return Math.round((1 - levenshtein(left, right) / Math.max(left.length, right.length)) * 100);
}
function normalizeQuestionForFaq(question: string) {
  const stopWords = new Set(["please", "kindly", "show", "give", "tell", "me", "the", "a", "an", "of", "in", "on", "for", "by", "to", "and", "or", "with", "from", "my", "our", "all", "can", "you", "how", "many", "what", "is", "are", "was", "were", "create", "make"]);
  const normalized = normalizeName(question).split(" ").map((word) => {
    if (/encoded|encoding/.test(word)) return "encoded"; if (/participants?|beneficiaries?/.test(word)) return "participant";
    if (/municipalities/.test(word)) return "municipality"; if (/visits?/.test(word)) return "visit";
    if (/totals?|counts?|counted/.test(word)) return "count"; return word;
  }).filter((word) => word.length > 1 && !stopWords.has(word)).sort();
  return normalized.join(" ").slice(0, 240) || normalizeName(question).slice(0, 240);
}
function categorizeQuestion(question: string) {
  if (/monitoring|mdmonitoring|md\s*monitoring|operational|closed|association|group|visit|project status/i.test(question)) return "Monitoring";
  if (/grant\s*code|grant/i.test(question)) return "Grant Code";
  if (/municipality|barangay|city|province/i.test(question)) return "Municipality";
  if (/visit|monitoring|monitor/i.test(question)) return "Visits";
  if (/financial|finance|budget|amount|fund|expense|liquidation|cash|target.*actual|actual.*target/i.test(question)) return "Financial data";
  if (/encoded|not encoded|encoding|missing/i.test(question)) return "Encoding status";
  if (/participant|beneficiar|client|name/i.test(question)) return "Participants";
  return "General program questions";
}
function trackFaqQuestion(question: string) {
  const sample = String(question || "").trim();
  if (!sample) return;
  const now = new Date().toISOString();
  const normalized = normalizeQuestionForFaq(sample);
  const category = categorizeQuestion(sample);
  const direct = db.prepare("SELECT * FROM faq_analytics WHERE normalized_question = ?").get(normalized);
  if (direct) {
    db.prepare("UPDATE faq_analytics SET ask_count = ask_count + 1, original_question_sample = ?, category = ?, last_asked_at = ?, updated_at = ? WHERE id = ?").run(sample, category, now, now, direct.id);
    return;
  }
  const existing = db.prepare("SELECT * FROM faq_analytics ORDER BY ask_count DESC, last_asked_at DESC LIMIT 250").all();
  const similar = existing.map((row: any) => {
    const score = normalized && row.normalized_question ? 1 - levenshtein(normalized, row.normalized_question) / Math.max(normalized.length, row.normalized_question.length) : 0;
    return { row, score };
  }).find((item: any) => item.score >= 0.78);
  if (similar) {
    db.prepare("UPDATE faq_analytics SET ask_count = ask_count + 1, original_question_sample = ?, category = ?, last_asked_at = ?, updated_at = ? WHERE id = ?").run(sample, category, now, now, similar.row.id);
    return;
  }
  db.prepare("INSERT INTO faq_analytics (id, normalized_question, original_question_sample, category, ask_count, last_asked_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)").run(randomId("faq"), normalized, sample, category, now, now, now);
}

function getLocalProfileById(id: string) { return db.prepare("SELECT * FROM profiles WHERE id = ?").get(id); }
function getLocalProfileByEmail(email: string) { return db.prepare("SELECT * FROM profiles WHERE lower(email) = lower(?)").get(email); }
function getDefaultLocalProfile() {
  return db.prepare("SELECT * FROM profiles WHERE role = 'admin' AND status = 'approved' ORDER BY created_at ASC LIMIT 1").get() || db.prepare("SELECT * FROM profiles ORDER BY created_at ASC LIMIT 1").get();
}

initLocalDb();

// =========================
// PROPOSAL BUILDER
// =========================
type ProposalDocType = "maf" | "mungkahing-proyekto";
type ProposalBuilderTemplateType = "MAF" | "MUNGKAHING_PROYEKTO";

const proposalTemplatesRegistry: Record<ProposalBuilderTemplateType, { label: string; fileName: string; path: string; requiredText: RegExp[]; forbiddenText: RegExp[] }> = {
  MAF: {
    label: "MAF",
    fileName: "MAF.docx",
    path: path.join(PROPOSAL_TEMPLATE_ROOT, "MAF.docx"),
    requiredText: [/MODALITY APPLICATION FORM/i, /SEED CAPITAL FUND/i, /BUSINESS PROFITABILITY ASSESSMENT/i],
    forbiddenText: [/EMPLOYMENT ASSESSMENT/i, /\bPAT\b/i],
  },
  MUNGKAHING_PROYEKTO: {
    label: "Mungkahing Proyekto",
    fileName: "MUNGKAHING_PROYEKTO.docx",
    path: path.join(PROPOSAL_TEMPLATE_ROOT, "MUNGKAHING_PROYEKTO.docx"),
    requiredText: [/MUNGKAHING PROYEKTO/i, /MICRO-?ENTERPRISE DEVELOPMENT/i, /PROJECT SUMMARY/i],
    forbiddenText: [/EMPLOYMENT ASSESSMENT/i, /\bPAT\b/i],
  },
};

const proposalTemplateFiles: Record<ProposalDocType, string> = {
  maf: proposalTemplatesRegistry.MAF.fileName,
  "mungkahing-proyekto": proposalTemplatesRegistry.MUNGKAHING_PROYEKTO.fileName,
};

const defaultOtherExpenses = [
  "Insurance Expenses",
  "Work space rent",
  "Electricity",
  "Water",
  "Transportation cost",
  "Permit to operate",
  "Miscellaneous expenses",
  "Technician Fee",
];

const proposalReferenceSeeds = [
  {
    reference_id: "sari-sari-store",
    enterprise_type: "Sari-Sari Store",
    description: "Small neighborhood retail store for basic household goods.",
    raw_materials: [
      { item_name: "Assorted grocery inventory", quantity: 1, unit: "lot", unit_price: 18000, frequency: 1 },
      { item_name: "Rice stock", quantity: 5, unit: "sack", unit_price: 1450, frequency: 1 },
    ],
    tools_equipment: [
      { item_name: "Display shelves", quantity: 2, unit: "set", unit_price: 2500, life_span_days: 730 },
      { item_name: "Weighing scale", quantity: 1, unit: "unit", unit_price: 1200, life_span_days: 730 },
    ],
    labor: [{ worker_name: "Store attendant", specific_task: "Daily selling and inventory monitoring", daily_wage: 350 }],
    other_expenses: [
      { expense_name: "Electricity", frequency: "Monthly", total_cost: 800 },
      { expense_name: "Transportation cost", frequency: "Per purchase", total_cost: 600 },
    ],
    products: [
      { product_name: "Grocery items", quantity: 1, unit: "lot", selling_price: 31000 },
      { product_name: "Rice retail sales", quantity: 250, unit: "kg", selling_price: 48 },
    ],
    production_cycle_days: 30,
    savings_amount: 1000,
    notes: "Suggested values are editable and should be validated against current local prices.",
  },
  { reference_id: "hog-fattening", enterprise_type: "Hog Fattening", description: "Backyard hog raising and fattening cycle.", raw_materials: [{ item_name: "Piglets", quantity: 2, unit: "head", unit_price: 4500, frequency: 1 }, { item_name: "Feeds", quantity: 12, unit: "sack", unit_price: 1550, frequency: 1 }], tools_equipment: [{ item_name: "Hog pen materials", quantity: 1, unit: "lot", unit_price: 8000, life_span_days: 1095 }], labor: [{ worker_name: "Caretaker", specific_task: "Feeding and pen maintenance", daily_wage: 250 }], other_expenses: [{ expense_name: "Veterinary supplies", frequency: "Per cycle", total_cost: 2500 }], products: [{ product_name: "Live hog", quantity: 180, unit: "kg", selling_price: 175 }], production_cycle_days: 120, savings_amount: 1500, notes: "" },
  { reference_id: "fish-vending", enterprise_type: "Fish Vending", description: "Fresh fish buying and retail selling.", raw_materials: [{ item_name: "Fresh fish", quantity: 60, unit: "kg", unit_price: 130, frequency: 1 }], tools_equipment: [{ item_name: "Ice box", quantity: 1, unit: "unit", unit_price: 3500, life_span_days: 730 }], labor: [{ worker_name: "Vendor", specific_task: "Retail selling", daily_wage: 350 }], other_expenses: [{ expense_name: "Transportation cost", frequency: "Daily", total_cost: 500 }], products: [{ product_name: "Retail fish", quantity: 60, unit: "kg", selling_price: 170 }], production_cycle_days: 1, savings_amount: 300, notes: "" },
  { reference_id: "goat-raising", enterprise_type: "Goat Raising", description: "Small ruminant raising livelihood.", raw_materials: [{ item_name: "Goat stocks", quantity: 3, unit: "head", unit_price: 3500, frequency: 1 }], tools_equipment: [{ item_name: "Goat shelter materials", quantity: 1, unit: "lot", unit_price: 7000, life_span_days: 1095 }], labor: [{ worker_name: "Caretaker", specific_task: "Feeding and grazing", daily_wage: 220 }], other_expenses: [{ expense_name: "Veterinary supplies", frequency: "Per cycle", total_cost: 1200 }], products: [{ product_name: "Goat sales", quantity: 3, unit: "head", selling_price: 6500 }], production_cycle_days: 180, savings_amount: 1000, notes: "" },
  { reference_id: "rice-vending", enterprise_type: "Rice Vending", description: "Retail rice buying and selling.", raw_materials: [{ item_name: "Rice sacks", quantity: 20, unit: "sack", unit_price: 1450, frequency: 1 }], tools_equipment: [{ item_name: "Weighing scale", quantity: 1, unit: "unit", unit_price: 1200, life_span_days: 730 }], labor: [{ worker_name: "Vendor", specific_task: "Packing and selling", daily_wage: 350 }], other_expenses: [{ expense_name: "Transportation cost", frequency: "Per delivery", total_cost: 800 }], products: [{ product_name: "Rice retail", quantity: 1000, unit: "kg", selling_price: 48 }], production_cycle_days: 30, savings_amount: 1000, notes: "" },
  { reference_id: "street-food-vending", enterprise_type: "Street Food Vending", description: "Cooked snack food vending.", raw_materials: [{ item_name: "Ingredients", quantity: 1, unit: "lot", unit_price: 3500, frequency: 7 }], tools_equipment: [{ item_name: "Cooking set", quantity: 1, unit: "set", unit_price: 6500, life_span_days: 730 }], labor: [{ worker_name: "Cook/vendor", specific_task: "Cooking and selling", daily_wage: 400 }], other_expenses: [{ expense_name: "LPG/charcoal", frequency: "Weekly", total_cost: 900 }], products: [{ product_name: "Street food servings", quantity: 700, unit: "serving", selling_price: 15 }], production_cycle_days: 7, savings_amount: 700, notes: "" },
  { reference_id: "fruits-vegetables", enterprise_type: "Buy and Sell Fruits and Vegetables", description: "Fresh produce trading.", raw_materials: [{ item_name: "Assorted produce", quantity: 1, unit: "lot", unit_price: 10000, frequency: 1 }], tools_equipment: [{ item_name: "Crates", quantity: 10, unit: "piece", unit_price: 180, life_span_days: 365 }], labor: [{ worker_name: "Vendor", specific_task: "Sorting and selling", daily_wage: 350 }], other_expenses: [{ expense_name: "Transportation cost", frequency: "Daily", total_cost: 700 }], products: [{ product_name: "Assorted produce sales", quantity: 1, unit: "lot", selling_price: 14500 }], production_cycle_days: 3, savings_amount: 500, notes: "" },
  { reference_id: "chicken-broiler", enterprise_type: "Chicken Broiler", description: "Broiler chicken production cycle.", raw_materials: [{ item_name: "Chicks", quantity: 50, unit: "head", unit_price: 45, frequency: 1 }, { item_name: "Feeds", quantity: 10, unit: "sack", unit_price: 1650, frequency: 1 }], tools_equipment: [{ item_name: "Brooder and feeders", quantity: 1, unit: "set", unit_price: 5000, life_span_days: 730 }], labor: [{ worker_name: "Poultry caretaker", specific_task: "Feeding and sanitation", daily_wage: 300 }], other_expenses: [{ expense_name: "Veterinary supplies", frequency: "Per cycle", total_cost: 1800 }], products: [{ product_name: "Broiler chicken", quantity: 80, unit: "kg", selling_price: 180 }], production_cycle_days: 45, savings_amount: 800, notes: "" },
  { reference_id: "tailoring", enterprise_type: "Tailoring", description: "Sewing and alteration service.", raw_materials: [{ item_name: "Fabric and sewing supplies", quantity: 1, unit: "lot", unit_price: 7000, frequency: 1 }], tools_equipment: [{ item_name: "Sewing machine", quantity: 1, unit: "unit", unit_price: 12000, life_span_days: 1825 }], labor: [{ worker_name: "Tailor", specific_task: "Sewing services", daily_wage: 450 }], other_expenses: [{ expense_name: "Electricity", frequency: "Monthly", total_cost: 900 }], products: [{ product_name: "Sewn items/services", quantity: 50, unit: "piece", selling_price: 350 }], production_cycle_days: 30, savings_amount: 1000, notes: "" },
  { reference_id: "food-processing", enterprise_type: "Food Processing", description: "Small-scale processed food production.", raw_materials: [{ item_name: "Processing ingredients", quantity: 1, unit: "lot", unit_price: 8500, frequency: 1 }], tools_equipment: [{ item_name: "Processing tools", quantity: 1, unit: "set", unit_price: 9000, life_span_days: 1095 }], labor: [{ worker_name: "Food processor", specific_task: "Preparation and packaging", daily_wage: 400 }], other_expenses: [{ expense_name: "Packaging", frequency: "Per cycle", total_cost: 2000 }], products: [{ product_name: "Processed food packs", quantity: 200, unit: "pack", selling_price: 75 }], production_cycle_days: 14, savings_amount: 800, notes: "" },
];

function initProposalBuilderDb() {
  fsSync.mkdirSync(PROPOSAL_TEMPLATE_ROOT, { recursive: true });
  fsSync.mkdirSync(PROPOSAL_GENERATED_ROOT, { recursive: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposal_projects (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', enterprise_type TEXT DEFAULT '',
      municipality TEXT DEFAULT '', barangay TEXT DEFAULT '', project_type TEXT DEFAULT '',
      total_project_cost REAL DEFAULT 0, net_profit REAL DEFAULT 0, pat_result TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Draft', data_json TEXT NOT NULL DEFAULT '{}',
      is_template INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS proposal_members (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, number INTEGER, name TEXT, address TEXT);
    CREATE TABLE IF NOT EXISTS proposal_raw_materials (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, item_name TEXT, quantity REAL, unit TEXT, unit_price REAL, frequency REAL, total_cost REAL);
    CREATE TABLE IF NOT EXISTS proposal_workers (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, worker_name TEXT, specific_task TEXT, daily_wage REAL);
    CREATE TABLE IF NOT EXISTS proposal_tools_equipment (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, item_name TEXT, quantity REAL, unit TEXT, unit_price REAL, total_cost REAL, life_span_days REAL, production_cycle_days REAL, depreciation_cost REAL);
    CREATE TABLE IF NOT EXISTS proposal_other_expenses (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, expense_name TEXT, frequency TEXT, total_cost REAL);
    CREATE TABLE IF NOT EXISTS proposal_sales (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, product_name TEXT, quantity REAL, unit TEXT, selling_price REAL, total_sales REAL);
    CREATE TABLE IF NOT EXISTS proposal_pat_indicators (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, category TEXT, label TEXT, checked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS proposal_scf_schedule (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, expense TEXT, amount REAL, schedule TEXT);
    CREATE TABLE IF NOT EXISTS proposal_generated_documents (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, doc_type TEXT NOT NULL, file_name TEXT NOT NULL, file_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS proposal_references (id TEXT PRIMARY KEY, reference_id TEXT NOT NULL UNIQUE, enterprise_type TEXT NOT NULL, description TEXT DEFAULT '', data_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS catalog_products (id TEXT PRIMARY KEY, product_name TEXT NOT NULL, enterprise_type TEXT DEFAULT '', unit TEXT DEFAULT '', suggested_selling_price REAL DEFAULT 0, notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS catalog_raw_materials (id TEXT PRIMARY KEY, raw_material_name TEXT NOT NULL, enterprise_type TEXT DEFAULT '', unit TEXT DEFAULT '', suggested_unit_price REAL DEFAULT 0, notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS catalog_tools_equipment (id TEXT PRIMARY KEY, tool_equipment_name TEXT NOT NULL, enterprise_type TEXT DEFAULT '', unit TEXT DEFAULT '', suggested_unit_price REAL DEFAULT 0, suggested_life_span_days REAL DEFAULT 0, notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS catalog_labor_roles (id TEXT PRIMARY KEY, role_worker_type TEXT NOT NULL, enterprise_type TEXT DEFAULT '', specific_task TEXT DEFAULT '', suggested_daily_wage REAL DEFAULT 0, notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS catalog_other_expenses (id TEXT PRIMARY KEY, expense_name TEXT NOT NULL, enterprise_type TEXT DEFAULT '', frequency_of_payment TEXT DEFAULT '', suggested_cost REAL DEFAULT 0, notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS proposal_inventory (
      proposalId TEXT PRIMARY KEY,
      templateType TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      municipality TEXT DEFAULT '',
      barangay TEXT DEFAULT '',
      projectName TEXT DEFAULT '',
      enterpriseType TEXT DEFAULT '',
      totalCost REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Draft',
      formDataJson TEXT NOT NULL DEFAULT '{}',
      docxPath TEXT DEFAULT '',
      previewPath TEXT DEFAULT '',
      ownerUserId TEXT DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS proposal_catalog_items (
      itemId TEXT PRIMARY KEY,
      catalogType TEXT NOT NULL,
      itemName TEXT NOT NULL,
      category TEXT DEFAULT '',
      unit TEXT DEFAULT '',
      defaultQuantity REAL DEFAULT 1,
      unitCost REAL DEFAULT 0,
      supplier TEXT DEFAULT '',
      remarks TEXT DEFAULT '',
      isActive INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS proposal_line_items (
      lineItemId TEXT PRIMARY KEY,
      proposalId TEXT NOT NULL,
      proposalType TEXT NOT NULL DEFAULT '',
      sectionKey TEXT NOT NULL DEFAULT '',
      catalogItemId TEXT DEFAULT '',
      section TEXT NOT NULL DEFAULT '',
      catalogType TEXT NOT NULL,
      itemName TEXT NOT NULL,
      category TEXT DEFAULT '',
      unit TEXT DEFAULT '',
      quantity REAL DEFAULT 0,
      unitCost REAL DEFAULT 0,
      totalCost REAL DEFAULT 0,
      remarks TEXT DEFAULT '',
      valuesJson TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS proposal_drafts (
      draftId TEXT PRIMARY KEY,
      proposalId TEXT NOT NULL,
      templateType TEXT NOT NULL,
      fileName TEXT NOT NULL,
      docxPath TEXT NOT NULL,
      previewPath TEXT DEFAULT '',
      formDataJson TEXT NOT NULL DEFAULT '{}',
      ownerUserId TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Ready for Review',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const addColumn = (table: string, name: string, definition: string) => {
    const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((row) => row.name));
    if (!existing.has(name)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
  };
  addColumn("proposal_inventory", "ownerUserId", "TEXT DEFAULT ''");
  addColumn("proposal_drafts", "ownerUserId", "TEXT DEFAULT ''");
  addColumn("proposal_line_items", "section", "TEXT NOT NULL DEFAULT ''");
  addColumn("proposal_line_items", "proposalType", "TEXT NOT NULL DEFAULT ''");
  addColumn("proposal_line_items", "sectionKey", "TEXT NOT NULL DEFAULT ''");
  addColumn("proposal_line_items", "valuesJson", "TEXT NOT NULL DEFAULT '{}'");
  addColumn("proposal_inventory", "originalFolderName", "TEXT DEFAULT ''");
  addColumn("proposal_inventory", "uploadRootPath", "TEXT DEFAULT ''");
  addColumn("proposal_inventory", "detectedDocumentsJson", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("proposal_inventory", "extractedItemsJson", "TEXT NOT NULL DEFAULT '[]'");

  const existingRefs = db.prepare("SELECT COUNT(*) AS count FROM proposal_references").get() as any;
  if (!existingRefs?.count) {
    const insertRef = db.prepare("INSERT INTO proposal_references (id, reference_id, enterprise_type, description, data_json) VALUES (?, ?, ?, ?, ?)");
    for (const ref of proposalReferenceSeeds) insertRef.run(crypto.randomUUID(), ref.reference_id, ref.enterprise_type, ref.description, JSON.stringify(ref));
  }

  const catalogCount = db.prepare("SELECT COUNT(*) AS count FROM catalog_products").get() as any;
  if (!catalogCount?.count) seedProposalCatalogs();
}

function seedProposalCatalogs() {
  const product = db.prepare("INSERT INTO catalog_products (id, product_name, enterprise_type, unit, suggested_selling_price, notes) VALUES (?, ?, ?, ?, ?, ?)");
  const raw = db.prepare("INSERT INTO catalog_raw_materials (id, raw_material_name, enterprise_type, unit, suggested_unit_price, notes) VALUES (?, ?, ?, ?, ?, ?)");
  const tool = db.prepare("INSERT INTO catalog_tools_equipment (id, tool_equipment_name, enterprise_type, unit, suggested_unit_price, suggested_life_span_days, notes) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const labor = db.prepare("INSERT INTO catalog_labor_roles (id, role_worker_type, enterprise_type, specific_task, suggested_daily_wage, notes) VALUES (?, ?, ?, ?, ?, ?)");
  const expense = db.prepare("INSERT INTO catalog_other_expenses (id, expense_name, enterprise_type, frequency_of_payment, suggested_cost, notes) VALUES (?, ?, ?, ?, ?, ?)");
  for (const ref of proposalReferenceSeeds) {
    for (const p of ref.products || []) product.run(crypto.randomUUID(), p.product_name, ref.enterprise_type, p.unit || "", Number(p.selling_price || 0), "");
    for (const r of ref.raw_materials || []) raw.run(crypto.randomUUID(), r.item_name, ref.enterprise_type, r.unit || "", Number(r.unit_price || 0), "");
    for (const t of ref.tools_equipment || []) tool.run(crypto.randomUUID(), t.item_name, ref.enterprise_type, t.unit || "", Number(t.unit_price || 0), Number(t.life_span_days || 0), "");
    for (const l of ref.labor || []) labor.run(crypto.randomUUID(), l.worker_name, ref.enterprise_type, l.specific_task || "", Number(l.daily_wage || 0), "");
  }
  for (const name of defaultOtherExpenses) expense.run(crypto.randomUUID(), name, "", "Monthly/Per cycle", 0, "");
  seedProposalBuilderCatalogItems();
}

initProposalBuilderDb();
seedProposalBuilderCatalogItems();

const moneyValue = (value: any) => Number.isFinite(Number(value)) ? Number(value) : 0;
const rowId = () => crypto.randomUUID();
const json = (value: any) => JSON.stringify(value ?? {});
const parseJson = (value: any, fallback: any) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

function computeProposal(data: any) {
  const rawMaterials = (data.raw_materials || []).map((row: any) => ({
    ...row,
    quantity: moneyValue(row.quantity),
    unit_price: moneyValue(row.unit_price),
    frequency: moneyValue(row.frequency || 1),
    total_cost: moneyValue(row.quantity) * moneyValue(row.unit_price) * moneyValue(row.frequency || 1),
  }));
  const productionCycleDays = moneyValue(data.production_cycle_days || data.labor?.production_cycle_days || 0);
  const workers = (data.labor || data.workers || []).map((row: any) => ({ ...row, daily_wage: moneyValue(row.daily_wage) }));
  const tools = (data.tools_equipment || []).map((row: any) => {
    const totalCost = moneyValue(row.quantity) * moneyValue(row.unit_price);
    const lifeSpan = moneyValue(row.life_span_days);
    const cycleDays = moneyValue(row.production_cycle_days || productionCycleDays);
    return { ...row, total_cost: totalCost, production_cycle_days: cycleDays, depreciation_cost: lifeSpan > 0 ? (totalCost / lifeSpan) * cycleDays : 0 };
  });
  const otherExpenses = (data.other_expenses || []).map((row: any) => ({ ...row, total_cost: moneyValue(row.total_cost) }));
  const products = (data.products || data.sales || []).map((row: any) => ({
    ...row,
    selling_price: moneyValue(row.selling_price ?? row.sale_price_per_unit),
    total_sales: moneyValue(row.quantity) * moneyValue(row.selling_price ?? row.sale_price_per_unit),
  }));
  const rawMaterialTotal = rawMaterials.reduce((sum: number, row: any) => sum + moneyValue(row.total_cost), 0);
  const totalDailyWage = workers.reduce((sum: number, row: any) => sum + moneyValue(row.daily_wage), 0);
  const laborTotal = totalDailyWage * productionCycleDays;
  const toolsTotal = tools.reduce((sum: number, row: any) => sum + moneyValue(row.total_cost), 0);
  const depreciationTotal = tools.reduce((sum: number, row: any) => sum + moneyValue(row.depreciation_cost), 0);
  const otherExpensesTotal = otherExpenses.reduce((sum: number, row: any) => sum + moneyValue(row.total_cost), 0);
  const grossSales = products.reduce((sum: number, row: any) => sum + moneyValue(row.total_sales), 0);
  const grossProfit = grossSales - rawMaterialTotal;
  const totalOperatingExpense = laborTotal + depreciationTotal + otherExpensesTotal;
  const grossProfitAfterOperatingExpense = grossProfit - totalOperatingExpense;
  const savingsAmount = moneyValue(data.savings_amount || (grossProfitAfterOperatingExpense * moneyValue(data.savings_rate) / 100));
  const netProfit = grossProfitAfterOperatingExpense - savingsAmount;
  const patIndicators = data.pat_indicators || [];
  const patScore = patIndicators.filter((item: any) => Boolean(item.checked)).length;
  const patResult = patScore >= 10 ? "APPROVED" : patScore >= 5 ? "DEFERRED" : "DISAPPROVED";
  const totalProjectCost = moneyValue(data.dswd_funding) + moneyValue(data.partner_funding);
  const scfSchedule = (data.scf_schedule?.length ? data.scf_schedule : [
    { expense: "Raw Materials", schedule: "" },
    { expense: "Tools and Equipment", schedule: "" },
    { expense: "Labor", schedule: "" },
    { expense: "Other Expenses", schedule: "" },
  ]).map((row: any) => ({
    ...row,
    amount: row.expense === "Raw Materials" ? rawMaterialTotal
      : row.expense === "Tools and Equipment" ? toolsTotal
      : row.expense === "Labor" ? laborTotal
      : row.expense === "Other Expenses" ? otherExpensesTotal
      : moneyValue(row.amount),
  }));

  return {
    ...data,
    total_project_cost: totalProjectCost,
    raw_materials: rawMaterials,
    workers,
    labor: workers,
    tools_equipment: tools,
    other_expenses: otherExpenses,
    products,
    scf_schedule: scfSchedule,
    production_cycle_days: productionCycleDays,
    computed: {
      gross_sales: grossSales,
      raw_material_total: rawMaterialTotal,
      labor_total: laborTotal,
      total_daily_wage: totalDailyWage,
      tools_total: toolsTotal,
      depreciation_total: depreciationTotal,
      other_expenses_total: otherExpensesTotal,
      gross_profit: grossProfit,
      total_operating_expense: totalOperatingExpense,
      gross_profit_after_operating_expense: grossProfitAfterOperatingExpense,
      savings_amount: savingsAmount,
      net_profit: netProfit,
      pat_score: patScore,
      pat_result: patResult,
      total_project_cost: totalProjectCost,
    },
  };
}

function defaultPatIndicators() {
  return [
    ["Market", "Food-related enterprise or contributes to food delivery"],
    ["Market", "Clear demand and market"],
    ["Market", "Identified regular consumer"],
    ["Market", "Effective distribution channel"],
    ["Technical / Production", "Accessible location"],
    ["Technical / Production", "Raw materials are available"],
    ["Technical / Production", "Tools and equipment are appropriate"],
    ["Technical / Production", "Production process is feasible"],
    ["Organization and Management", "Members have defined roles"],
    ["Organization and Management", "Management structure is functional"],
    ["Organization and Management", "Implementation schedule is realistic"],
    ["Financial", "Guaranteed counterpart from partners"],
    ["Financial", "Sales can cover operating expenses"],
    ["Financial", "Savings or capital build-up is planned"],
  ].map(([category, label]) => ({ id: rowId(), category, label, checked: false }));
}

function normalizeProposalInput(input: any) {
  const data = {
    title: input.title || input.project_title || "",
    enterprise_type: input.enterprise_type || "",
    municipality: input.municipality || "",
    barangay: input.barangay || "",
    location: input.location || "",
    project_type: input.project_type || "Association",
    status: input.status || "Draft",
    dswd_funding: moneyValue(input.dswd_funding),
    partner_funding: moneyValue(input.partner_funding),
    target_start_date: input.target_start_date || "",
    slpa_name: input.slpa_name || input.participant_name || "",
    participant_name: input.participant_name || input.slpa_name || "",
    participant_id: input.participant_id || "",
    address: input.address || "",
    date_organized: input.date_organized || "",
    total_members: moneyValue(input.total_members),
    slpa_president: input.slpa_president || "",
    contact_number: input.contact_number || "",
    market: input.market || {},
    members: input.members || [],
    raw_materials: input.raw_materials || [],
    labor: input.labor || input.workers || [],
    tools_equipment: input.tools_equipment || [],
    other_expenses: input.other_expenses?.length ? input.other_expenses : defaultOtherExpenses.map((expense_name) => ({ id: rowId(), expense_name, frequency: "", total_cost: 0 })),
    products: input.products || input.sales || [],
    production_cycle_days: moneyValue(input.production_cycle_days || 1),
    savings_amount: moneyValue(input.savings_amount),
    savings_rate: moneyValue(input.savings_rate),
    scf_schedule: input.scf_schedule || [],
    pat_indicators: input.pat_indicators?.length ? input.pat_indicators : defaultPatIndicators(),
    attachments: input.attachments || { constitution: false, modality_application: false, program_of_works: false },
    approval: input.approval || {},
    generated_documents: input.generated_documents || [],
    source_reference_id: input.source_reference_id || "",
  };
  return computeProposal(data);
}

function saveProposalRows(proposalId: string, data: any) {
  const tables = ["proposal_members", "proposal_raw_materials", "proposal_workers", "proposal_tools_equipment", "proposal_other_expenses", "proposal_sales", "proposal_pat_indicators", "proposal_scf_schedule"];
  for (const table of tables) db.prepare(`DELETE FROM ${table} WHERE proposal_id = ?`).run(proposalId);
  const member = db.prepare("INSERT INTO proposal_members (id, proposal_id, number, name, address) VALUES (?, ?, ?, ?, ?)");
  (data.members || []).forEach((row: any, index: number) => member.run(row.id || rowId(), proposalId, row.number || index + 1, row.name || "", row.address || row.home_address || ""));
  const raw = db.prepare("INSERT INTO proposal_raw_materials (id, proposal_id, item_name, quantity, unit, unit_price, frequency, total_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  (data.raw_materials || []).forEach((row: any) => raw.run(row.id || rowId(), proposalId, row.item_name || row.raw_material || "", moneyValue(row.quantity), row.unit || "", moneyValue(row.unit_price), moneyValue(row.frequency), moneyValue(row.total_cost)));
  const worker = db.prepare("INSERT INTO proposal_workers (id, proposal_id, worker_name, specific_task, daily_wage) VALUES (?, ?, ?, ?, ?)");
  (data.labor || data.workers || []).forEach((row: any) => worker.run(row.id || rowId(), proposalId, row.worker_name || "", row.specific_task || "", moneyValue(row.daily_wage)));
  const tool = db.prepare("INSERT INTO proposal_tools_equipment (id, proposal_id, item_name, quantity, unit, unit_price, total_cost, life_span_days, production_cycle_days, depreciation_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  (data.tools_equipment || []).forEach((row: any) => tool.run(row.id || rowId(), proposalId, row.item_name || "", moneyValue(row.quantity), row.unit || "", moneyValue(row.unit_price), moneyValue(row.total_cost), moneyValue(row.life_span_days), moneyValue(row.production_cycle_days), moneyValue(row.depreciation_cost)));
  const expense = db.prepare("INSERT INTO proposal_other_expenses (id, proposal_id, expense_name, frequency, total_cost) VALUES (?, ?, ?, ?, ?)");
  (data.other_expenses || []).forEach((row: any) => expense.run(row.id || rowId(), proposalId, row.expense_name || "", row.frequency || "", moneyValue(row.total_cost)));
  const sale = db.prepare("INSERT INTO proposal_sales (id, proposal_id, product_name, quantity, unit, selling_price, total_sales) VALUES (?, ?, ?, ?, ?, ?, ?)");
  (data.products || []).forEach((row: any) => sale.run(row.id || rowId(), proposalId, row.product_name || "", moneyValue(row.quantity), row.unit || "", moneyValue(row.selling_price), moneyValue(row.total_sales)));
  const pat = db.prepare("INSERT INTO proposal_pat_indicators (id, proposal_id, category, label, checked) VALUES (?, ?, ?, ?, ?)");
  (data.pat_indicators || []).forEach((row: any) => pat.run(row.id || rowId(), proposalId, row.category || "", row.label || "", row.checked ? 1 : 0));
  const scf = db.prepare("INSERT INTO proposal_scf_schedule (id, proposal_id, expense, amount, schedule) VALUES (?, ?, ?, ?, ?)");
  (data.scf_schedule || []).forEach((row: any) => scf.run(row.id || rowId(), proposalId, row.expense || "", moneyValue(row.amount), row.schedule || ""));
}

function listGeneratedDocuments(proposalId: string) {
  return db.prepare("SELECT id, doc_type, file_name, created_at FROM proposal_generated_documents WHERE proposal_id = ? ORDER BY created_at DESC").all(proposalId);
}

function proposalFromRow(row: any, full = false) {
  const data = computeProposal(parseJson(row.data_json, {}));
  const base = {
    id: row.id,
    title: row.title,
    enterprise_type: row.enterprise_type,
    municipality: row.municipality,
    barangay: row.barangay,
    project_type: row.project_type,
    total_project_cost: row.total_project_cost,
    net_profit: row.net_profit,
    pat_result: row.pat_result,
    status: row.status,
    is_template: Boolean(row.is_template),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  return full ? { ...base, ...data, generated_documents: listGeneratedDocuments(row.id) } : base;
}

function fetchProposalOr404(id: string) {
  return db.prepare("SELECT * FROM proposal_projects WHERE id = ?").get(id) as any;
}

function writeProposal(input: any, id: string = crypto.randomUUID()) {
  const now = new Date().toISOString();
  const data = normalizeProposalInput(input);
  const existing = fetchProposalOr404(id);
  const payload = [id, data.title, data.enterprise_type, data.municipality, data.barangay, data.project_type, data.computed.total_project_cost, data.computed.net_profit, data.computed.pat_result, data.status, json(data), input.is_template ? 1 : 0, now];
  if (existing) {
    db.prepare(`UPDATE proposal_projects SET title = ?, enterprise_type = ?, municipality = ?, barangay = ?, project_type = ?, total_project_cost = ?, net_profit = ?, pat_result = ?, status = ?, data_json = ?, is_template = ?, updated_at = ? WHERE id = ?`)
      .run(data.title, data.enterprise_type, data.municipality, data.barangay, data.project_type, data.computed.total_project_cost, data.computed.net_profit, data.computed.pat_result, data.status, json(data), input.is_template ? 1 : 0, now, id);
  } else {
    db.prepare(`INSERT INTO proposal_projects (id, title, enterprise_type, municipality, barangay, project_type, total_project_cost, net_profit, pat_result, status, data_json, is_template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...payload, now);
  }
  saveProposalRows(id, data);
  return proposalFromRow(fetchProposalOr404(id), true);
}

function duplicateProposal(sourceId: string, useTemplate = false) {
  const source = fetchProposalOr404(sourceId);
  if (!source) return null;
  const data = normalizeProposalInput(parseJson(source.data_json, {}));
  delete data.approval;
  data.generated_documents = [];
  data.status = "Draft";
  data.title = useTemplate ? `${data.title || source.title} - Draft` : `${data.title || source.title} - Copy`;
  return writeProposal({ ...data, is_template: false }, crypto.randomUUID());
}

function docxDataForProposal(proposal: any) {
  const computed = proposal.computed || {};
  const currency = (value: any) => moneyValue(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    project_title: proposal.title,
    enterprise_type: proposal.enterprise_type,
    municipality: proposal.municipality,
    barangay: proposal.barangay,
    location: proposal.location,
    project_type: proposal.project_type,
    slpa_name: proposal.slpa_name,
    participant_name: proposal.participant_name,
    participant_id: proposal.participant_id,
    address: proposal.address,
    date_organized: proposal.date_organized,
    total_members: proposal.total_members,
    slpa_president: proposal.slpa_president,
    contact_number: proposal.contact_number,
    dswd_funding: currency(proposal.dswd_funding),
    partner_funding: currency(proposal.partner_funding),
    total_project_cost: currency(computed.total_project_cost),
    gross_sales: currency(computed.gross_sales),
    raw_material_total: currency(computed.raw_material_total),
    labor_total: currency(computed.labor_total),
    tools_total: currency(computed.tools_total),
    depreciation_total: currency(computed.depreciation_total),
    other_expenses_total: currency(computed.other_expenses_total),
    gross_profit: currency(computed.gross_profit),
    total_operating_expense: currency(computed.total_operating_expense),
    gross_profit_after_operating_expense: currency(computed.gross_profit_after_operating_expense),
    savings_amount: currency(computed.savings_amount),
    net_profit: currency(computed.net_profit),
    pat_score: computed.pat_score,
    pat_result: computed.pat_result,
    members: (proposal.members || []).map((row: any, index: number) => ({ number: row.number || index + 1, name: row.name || "", address: row.address || row.home_address || "" })),
    raw_materials: (proposal.raw_materials || []).map((row: any) => ({ ...row, raw_material: row.item_name, total_cost: currency(row.total_cost), unit_price: currency(row.unit_price) })),
    labor: (proposal.labor || []).map((row: any) => ({ ...row, daily_wage: currency(row.daily_wage) })),
    tools_equipment: (proposal.tools_equipment || []).map((row: any) => ({ ...row, total_cost: currency(row.total_cost), unit_price: currency(row.unit_price), depreciation_cost: currency(row.depreciation_cost) })),
    other_expenses: (proposal.other_expenses || []).map((row: any) => ({ ...row, total_cost: currency(row.total_cost) })),
    products: (proposal.products || []).map((row: any) => ({ ...row, sale_price_per_unit: currency(row.selling_price), selling_price: currency(row.selling_price), total_sales: currency(row.total_sales) })),
    scf_schedule: (proposal.scf_schedule || []).map((row: any) => ({ ...row, amount: currency(row.amount) })),
  };
}

async function generateProposalDocx(proposalId: string, docType: ProposalDocType) {
  const row = fetchProposalOr404(proposalId);
  if (!row) throw Object.assign(new Error("Proposal not found."), { status: 404 });
  const templatePath = path.join(PROPOSAL_TEMPLATE_ROOT, proposalTemplateFiles[docType]);
  if (!fsSync.existsSync(templatePath)) {
    console.log("PROPOSAL_TEMPLATE_NOT_FOUND", { docType, templatePath });
    throw Object.assign(new Error("DOCX template not found in templates/proposal."), { status: 404 });
  }
  await assertProposalTemplateIdentity(docType === "maf" ? "MAF" : "MUNGKAHING_PROYEKTO", templatePath);
  try {
    const proposal = proposalFromRow(row, true);
    const zip = new PizZip(await fs.readFile(templatePath));
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    doc.render(docxDataForProposal(proposal));
    const buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
    await fs.mkdir(PROPOSAL_GENERATED_ROOT, { recursive: true });
    const safeType = docType.replace(/[^a-z0-9-]/gi, "_");
    const fileName = `${safeType}-${proposalId}-${Date.now()}.docx`;
    const filePath = path.join(PROPOSAL_GENERATED_ROOT, fileName);
    await fs.writeFile(filePath, buffer);
    const docId = crypto.randomUUID();
    db.prepare("INSERT INTO proposal_generated_documents (id, proposal_id, doc_type, file_name, file_path) VALUES (?, ?, ?, ?, ?)").run(docId, proposalId, docType, fileName, filePath);
    console.log("PROPOSAL_EXPORT_DOCX", { proposalId, docType, fileName });
    return { id: docId, doc_type: docType, file_name: fileName, download_url: `/api/proposals/generated/${docId}/download` };
  } catch (err: any) {
    console.error("PROPOSAL_DOCX_RENDER_ERROR", err);
    throw Object.assign(new Error(err?.message || "DOCX render error."), { status: 500 });
  }
}

function proposalRouteError(res: express.Response, err: any) {
  console.error("Proposal Builder error:", err);
  const status = err?.status || 500;
  if (err?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || /UNIQUE constraint failed: proposal_line_items\.lineItemId/i.test(String(err?.message || ""))) {
    return res.status(status).json({ ok: false, error: "Unable to save proposal line items. Duplicate row ID was detected and fixed." });
  }
  if (err?.code || /SQLITE|constraint|database/i.test(String(err?.message || ""))) {
    return res.status(status).json({ ok: false, error: "Proposal Builder request failed." });
  }
  res.status(status).json({ ok: false, error: err?.message || "Proposal Builder request failed." });
}

function seedProposalBuilderCatalogItems() {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM proposal_catalog_items").get() as any;
  if (existing?.count) return;
  const insert = db.prepare(`INSERT INTO proposal_catalog_items
    (itemId, catalogType, itemName, category, unit, defaultQuantity, unitCost, supplier, remarks, isActive)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const rawItems = [
    ["Assorted grocery inventory", "Stocks/Inventory", "lot", 1, 18000],
    ["Rice stock", "Stocks/Inventory", "sack", 5, 1450],
    ["Feeds", "Feeds", "sack", 12, 1550],
    ["Seeds", "Farm inputs", "pack", 10, 120],
    ["Packaging materials", "Packaging", "lot", 1, 2000],
    ["Fertilizer", "Farm inputs", "sack", 4, 1800],
  ];
  const toolItems = [
    ["Weighing scale", "Retail equipment", "unit", 1, 1200],
    ["Freezer", "Cold storage", "unit", 1, 18000],
    ["Sewing machine", "Production equipment", "unit", 1, 12000],
    ["Cooking tools", "Food processing", "set", 1, 6500],
    ["Farm tools", "Farm equipment", "set", 1, 3500],
    ["Display shelves", "Store equipment", "set", 2, 2500],
  ];
  for (const [name, category, unit, qty, cost] of rawItems) insert.run(randomId("catalog"), "Raw Material", name, category, unit, qty, cost, "", "");
  for (const [name, category, unit, qty, cost] of toolItems) insert.run(randomId("catalog"), "Tool/Equipment", name, category, unit, qty, cost, "", "");
}

function safeProposalTemplateType(input: any): ProposalBuilderTemplateType {
  const value = String(input || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (value === "MAF") return "MAF";
  if (value === "MUNGKAHING_PROYEKTO") return "MUNGKAHING_PROYEKTO";
  if (value.includes("PAT")) throw Object.assign(new Error("PAT is not supported in Proposal Builder."), { status: 400 });
  throw Object.assign(new Error("Template type must be MAF or Mungkahing Proyekto."), { status: 400 });
}

function proposalSchemaFor(input: any) {
  const proposalType = safeProposalTemplateType(input?.proposalType || input?.templateType || input);
  return proposalSchemas[proposalType as ProposalType];
}

function proposalTemplateLabel(templateType: ProposalBuilderTemplateType) {
  return templateType === "MAF" ? "MAF" : "Mungkahing Proyekto";
}

function proposalTemplateFilePrefix(templateType: ProposalBuilderTemplateType) {
  return templateType === "MAF" ? "MAF" : "MungkahingProyekto";
}

function proposalBuilderLineTotal(row: any) {
  const quantity = moneyValue(row.quantity);
  const unitCost = moneyValue(row.unitCost ?? row.unit_cost ?? row.unit_price);
  const frequency = moneyValue(row.frequency ?? row.frequencyOfProduction ?? 1) || 1;
  return quantity * unitCost * frequency;
}

function proposalBuilderSimpleTotal(row: any) {
  return moneyValue(row.quantity) * moneyValue(row.unitCost ?? row.unit_price ?? row.salePricePerUnit);
}

function proposalBuilderNumberDisplay(value: any, fractionDigits = 2) {
  return moneyValue(value).toLocaleString("en-PH", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}

function proposalBuilderGrossSalesLine(row: any) {
  const quantity = moneyValue(row.quantity);
  const saleMode = row.saleMode === "weight_based" ? "weight_based" : "simple";
  const salePricePerUnit = moneyValue(row.salePricePerUnit ?? row.salePrice ?? row.selling_price);
  const averageWeight = moneyValue(row.averageWeight);
  const pricePerKilo = moneyValue(row.pricePerKilo);
  const totalKilos = quantity * averageWeight;
  const totalSales = saleMode === "weight_based" ? totalKilos * pricePerKilo : quantity * salePricePerUnit;
  const salePriceDisplayText = saleMode === "weight_based"
    ? `${proposalBuilderNumberDisplay(quantity, 0)} x ${proposalBuilderNumberDisplay(averageWeight, 2).replace(/\.00$/, "")} ave weight\n${proposalBuilderNumberDisplay(totalKilos, 0)} x ${proposalBuilderNumberDisplay(pricePerKilo, 2)}/kl`
    : moneyValue(salePricePerUnit).toLocaleString("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 2 });
  return {
    ...row,
    productName: row.productName || row.product || row.product_name || "",
    product: row.productName || row.product || row.product_name || "",
    quantity,
    saleMode,
    salePricePerUnit,
    averageWeight,
    pricePerKilo,
    totalKilos,
    totalSales,
    salePriceDisplayText,
  };
}

function proposalBuilderTotals(rawMaterials: any[] = [], toolsEquipment: any[] = [], manpower: any[] = [], otherExpenses: any[] = [], grossSales: any[] = [], productionCycleDays = 1, savingsInput: any = 0, savingsRate: any = 0) {
  const rawMaterialsSubtotal = rawMaterials.reduce((sum, row) => sum + proposalBuilderLineTotal(row), 0);
  const toolsEquipmentSubtotal = toolsEquipment.reduce((sum, row) => sum + proposalBuilderSimpleTotal(row), 0);
  const depreciationTotal = toolsEquipment.reduce((sum, row) => {
    const totalCost = proposalBuilderSimpleTotal(row);
    const lifeSpan = moneyValue(row.lifeSpan ?? row.life_span_days);
    const cycle = moneyValue(row.productionCycle ?? row.production_cycle_days ?? productionCycleDays);
    return sum + (lifeSpan > 0 ? (totalCost / lifeSpan) * cycle : 0);
  }, 0);
  const totalDailyWage = manpower.reduce((sum, row) => sum + moneyValue(row.dailyWage ?? row.daily_wage), 0);
  const manpowerTotal = totalDailyWage * moneyValue(productionCycleDays || 0);
  const otherExpensesTotal = otherExpenses.reduce((sum, row) => sum + moneyValue(row.totalCost ?? row.total_cost), 0);
  const grossSalesTotal = grossSales.reduce((sum, row) => sum + moneyValue(row.totalSales ?? row.total_sales), 0);
  const grossProfit = grossSalesTotal - rawMaterialsSubtotal;
  const totalOperatingExpense = manpowerTotal + depreciationTotal + otherExpensesTotal;
  const grossProfitAfterOperatingExpense = grossProfit - totalOperatingExpense;
  const normalizedSavingsRate = moneyValue(savingsRate) > 1 ? moneyValue(savingsRate) / 100 : moneyValue(savingsRate);
  const mandatorySavings = moneyValue(savingsInput) || (grossProfitAfterOperatingExpense * normalizedSavingsRate);
  const netProfit = grossProfitAfterOperatingExpense - mandatorySavings;
  return {
    rawMaterialsSubtotal,
    toolsEquipmentSubtotal,
    depreciationTotal,
    totalDailyWage,
    manpowerTotal,
    otherExpensesTotal,
    grossSalesTotal,
    grossProfit,
    totalOperatingExpense,
    grossProfitAfterOperatingExpense,
    mandatorySavings,
    netProfit,
    grandTotal: rawMaterialsSubtotal + toolsEquipmentSubtotal + manpowerTotal + otherExpensesTotal,
  };
}

function normalizeProposalBuilderLineItems(rows: any[] = [], catalogType: "Raw Material" | "Tool/Equipment", section = "") {
  return (rows || []).map((row, index) => {
    const quantity = moneyValue(row.quantity ?? row.defaultQuantity ?? 1);
    const unitCost = moneyValue(row.unitCost ?? row.unit_cost ?? row.unit_price ?? row.suggested_unit_price);
    const frequency = moneyValue(row.frequency ?? row.frequencyOfProduction ?? 1) || 1;
    const lifeSpan = moneyValue(row.lifeSpan ?? row.life_span_days);
    const productionCycle = moneyValue(row.productionCycle ?? row.production_cycle_days);
    const baseTotal = catalogType === "Raw Material" ? quantity * unitCost * frequency : quantity * unitCost;
    return {
      lineItemId: uniqueProposalLineItemId(row.proposalId || "draft", section || catalogType, index),
      catalogItemId: row.catalogItemId || row.itemId || "",
      section,
      catalogType,
      itemName: row.itemName || row.item_name || row.raw_material_name || row.tool_equipment_name || "",
      category: row.category || "",
      unit: row.unit || "",
      quantity,
      unitCost,
      frequency,
      lifeSpan,
      productionCycle,
      totalCost: baseTotal,
      depreciationCost: lifeSpan > 0 ? (baseTotal / lifeSpan) * productionCycle : 0,
      remarks: row.remarks || row.notes || "",
      saveToCatalog: Boolean(row.saveToCatalog),
    };
  }).filter((row) => row.itemName);
}

function normalizeProposalBuilderManpower(rows: any[] = []) {
  return (rows || []).map((row, index) => ({
    lineItemId: uniqueProposalLineItemId(row.proposalId || "draft", "manpower", index),
    section: "manpower",
    workerName: row.workerName || row.worker_name || "",
    specificTask: row.specificTask || row.specific_task || "",
    dailyWage: moneyValue(row.dailyWage ?? row.daily_wage),
    remarks: row.remarks || "",
  })).filter((row) => row.workerName || row.specificTask || row.dailyWage);
}

function normalizeProposalBuilderOtherExpenses(rows: any[] = []) {
  return (rows || []).map((row, index) => ({
    lineItemId: uniqueProposalLineItemId(row.proposalId || "draft", "other_expenses", index),
    section: "other_expenses",
    expenseName: row.expenseName || row.expense_name || "",
    frequency: row.frequency || "",
    totalCost: moneyValue(row.totalCost ?? row.total_cost),
    remarks: row.remarks || "",
  })).filter((row) => row.expenseName || row.totalCost);
}

function normalizeProposalBuilderGrossSales(rows: any[] = []) {
  return (rows || []).map((row, index) => {
    const computed = proposalBuilderGrossSalesLine(row);
    return {
      ...computed,
      lineItemId: uniqueProposalLineItemId(row.proposalId || "draft", "gross_sales", index),
      section: "gross_sales",
      unit: row.unit || "",
      remarks: row.remarks || "",
    };
  }).filter((row) => row.productName || row.product || row.totalSales);
}

function normalizeGenericProposalRows(rows: any[] = [], sectionKey: string) {
  return (rows || []).map((row, index) => ({
    ...row,
    lineItemId: uniqueProposalLineItemId(row.proposalId || "draft", sectionKey, index),
    section: sectionKey,
    sectionKey,
    amount: moneyValue(row.amount),
    quantity: moneyValue(row.quantity),
    participants: moneyValue(row.participants),
  })).filter((row) => Object.values(row).some((value) => String(value ?? "").trim() !== "" && value !== 0));
}

function proposalBuilderFormData(input: any) {
  const schema = proposalSchemaFor(input);
  const rawMaterials = schema.proposalType === "MAF" ? normalizeProposalBuilderLineItems(input.rawMaterials || input.raw_materials || [], "Raw Material", "raw_materials") : [];
  const toolsEquipment = schema.proposalType === "MAF" ? normalizeProposalBuilderLineItems(input.toolsEquipment || input.tools_equipment || [], "Tool/Equipment", "tools_equipment") : [];
  const manpower = schema.proposalType === "MAF" ? normalizeProposalBuilderManpower(input.manpower || input.labor || []) : [];
  let otherExpenses = schema.proposalType === "MAF" ? normalizeProposalBuilderOtherExpenses(input.otherExpenses || input.other_expenses || []) : [];
  const grossSales = schema.proposalType === "MAF" ? normalizeProposalBuilderGrossSales(input.grossSales || input.products || []) : [];
  const modalityApplications = schema.proposalType === "MUNGKAHING_PROYEKTO" ? normalizeGenericProposalRows(input.modalityApplications || [], "modality_applications") : [];
  const partnerCounterparts = schema.proposalType === "MUNGKAHING_PROYEKTO" ? normalizeGenericProposalRows(input.partnerCounterparts || [], "partner_counterparts") : [];
  const productionCycleDays = moneyValue(input.productionCycleDays ?? input.production_cycle_days ?? 1) || 1;
  toolsEquipment.forEach((row) => {
    row.productionCycle = productionCycleDays;
    row.totalCost = proposalBuilderSimpleTotal(row);
    row.depreciationCost = row.lifeSpan > 0 ? (row.totalCost / row.lifeSpan) * productionCycleDays : 0;
  });
  const mandatorySavingsInput = moneyValue(input.mandatorySavings ?? input.savings_amount);
  const mandatorySavingsRate = moneyValue(input.mandatorySavingsRate ?? input.savings_rate);
  const totals = proposalBuilderTotals(rawMaterials, toolsEquipment, manpower, otherExpenses, grossSales, productionCycleDays, mandatorySavingsInput, mandatorySavingsRate);
  const modalityTotal = modalityApplications.reduce((sum: number, row: any) => sum + moneyValue(row.amount), 0);
  const partnerCounterpartTotal = partnerCounterparts.reduce((sum: number, row: any) => sum + moneyValue(row.amount), 0);
  const dswdFunding = moneyValue(input.dswdFunding ?? input.requestedScfAmount ?? modalityTotal);
  const partnerFunding = moneyValue(input.partnerFunding);
  const totalProjectCost = schema.proposalType === "MAF" ? totals.grandTotal : dswdFunding + partnerFunding;
  const existingScfSchedule = normalizeGenericProposalRows(input.scfSchedule || input.scf_schedule || [], "scf_schedule");
  const scheduleById = new Map(existingScfSchedule.map((row: any) => [row.lineItemId, row.schedule || ""]));
  const customScfSchedule = existingScfSchedule.filter((row: any) => !String(row.lineItemId || "").startsWith("auto-scf-"));
  const scfSchedule = schema.proposalType === "MAF" ? [
    { lineItemId: "auto-scf-raw-materials", expense: "Raw Materials", amount: totals.rawMaterialsSubtotal, schedule: scheduleById.get("auto-scf-raw-materials") || "" },
    { lineItemId: "auto-scf-tools-equipment", expense: "Tools and Equipment", amount: totals.toolsEquipmentSubtotal, schedule: scheduleById.get("auto-scf-tools-equipment") || "" },
    ...(totals.otherExpensesTotal ? [{ lineItemId: "auto-scf-other-expenses", expense: "Other Expenses", amount: totals.otherExpensesTotal, schedule: scheduleById.get("auto-scf-other-expenses") || "" }] : []),
    ...customScfSchedule,
  ] : [];
  const missing = schema.requiredFields.filter((field) => {
    const value = input[field];
    return value === undefined || value === null || String(value).trim() === "";
  });
  if (missing.length) throw Object.assign(new Error(`Missing required ${schema.label} field(s): ${missing.map((field) => schema.fields.find((item) => item.key === field)?.label || field).join(", ")}`), { status: 400 });
  return {
    proposalType: schema.proposalType,
    templateType: schema.templateKey,
    title: input.title || input.projectTitle || input.projectName || "",
    municipality: input.municipality || "",
    barangay: input.barangay || "",
    projectName: input.projectName || input.slpaName || input.participantName || "",
    enterpriseType: input.enterpriseType || input.enterprise_type || "",
    associationParticipantProjectName: input.associationParticipantProjectName || input.projectName || input.slpaName || input.participantName || "",
    participantId: input.participantId || "",
    participantAddress: input.participantAddress || "",
    microenterpriseLocation: input.microenterpriseLocation || "",
    objectives: input.objectives || "",
    requestedScfAmount: moneyValue(input.requestedScfAmount),
    dswdFunding,
    partnerFunding,
    totalProjectCost,
    dateOrganized: input.dateOrganized || "",
    totalMembers: moneyValue(input.totalMembers),
    slpaPresident: input.slpaPresident || "",
    contactNumber: input.contactNumber || "",
    targetMarket: input.targetMarket || "",
    targetStartDate: input.targetStartDate || "",
    preparedBy: input.preparedBy || "",
    recommendedBy: input.recommendedBy || "",
    approvedBy: input.approvedBy || "",
    productionCycleDays,
    mandatorySavingsInput,
    mandatorySavingsRate,
    rawMaterials,
    toolsEquipment,
    manpower,
    otherExpenses,
    grossSales,
    scfSchedule,
    modalityApplications,
    partnerCounterparts,
    modalityTotal,
    partnerCounterpartTotal,
    ...totals,
    grandTotal: totalProjectCost,
  };
}

function proposalBuilderDocxData(formData: any) {
  const schema = proposalSchemaFor(formData);
  const currency = (value: any) => moneyValue(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const base = {
    TEMPLATE_TYPE: proposalTemplateLabel(formData.templateType),
    PROPOSAL_TYPE: schema.label,
    PROPOSAL_TITLE: formData.title,
    PROJECT_TITLE: formData.title,
    MUNICIPALITY: formData.municipality,
    BARANGAY: formData.barangay,
    LOCATION: [formData.barangay, formData.municipality, "Aurora"].filter(Boolean).join(", "),
    PROJECT_NAME: formData.projectName,
    ASSOCIATION_PARTICIPANT_PROJECT_NAME: formData.associationParticipantProjectName,
    ENTERPRISE_TYPE: formData.enterpriseType,
    PARTICIPANT_ID: formData.participantId,
    PARTICIPANT_ADDRESS: formData.participantAddress,
    MICROENTERPRISE_LOCATION: formData.microenterpriseLocation,
    OBJECTIVES: formData.objectives,
    CONTACT_NUMBER: formData.contactNumber,
    SLPA_PRESIDENT: formData.slpaPresident,
    REQUESTED_SCF_AMOUNT: currency(formData.requestedScfAmount),
    DSWD_FUNDING: currency(formData.dswdFunding),
    PARTNER_FUNDING: currency(formData.partnerFunding),
    TOTAL_PROJECT_COST: currency(formData.totalProjectCost || formData.grandTotal),
    DATE_ORGANIZED: formData.dateOrganized,
    TOTAL_MEMBERS: formData.totalMembers,
    TARGET_MARKET: formData.targetMarket,
    TARGET_START_DATE: formData.targetStartDate,
    PREPARED_BY: formData.preparedBy,
    RECOMMENDED_BY: formData.recommendedBy,
    APPROVED_BY: formData.approvedBy,
    RAW_MATERIALS_SUBTOTAL: currency(formData.rawMaterialsSubtotal),
    TOOLS_EQUIPMENT_SUBTOTAL: currency(formData.toolsEquipmentSubtotal),
    MANPOWER_TOTAL: currency(formData.manpowerTotal),
    TOTAL_DAILY_WAGE: currency(formData.totalDailyWage),
    DEPRECIATION_TOTAL: currency(formData.depreciationTotal),
    OTHER_EXPENSES_TOTAL: currency(formData.otherExpensesTotal),
    GROSS_SALES: currency(formData.grossSalesTotal),
    GROSS_PROFIT: currency(formData.grossProfit),
    TOTAL_OPERATING_EXPENSE: currency(formData.totalOperatingExpense),
    GROSS_PROFIT_AFTER_OPERATING_EXPENSE: currency(formData.grossProfitAfterOperatingExpense),
    MANDATORY_SAVINGS: currency(formData.mandatorySavings),
    NET_PROFIT: currency(formData.netProfit),
    GRAND_TOTAL_PROJECT_COST: currency(formData.grandTotal),
    raw_materials: formData.rawMaterials.map((row: any, index: number) => ({ ...row, no: index + 1, raw_material: row.itemName, item_name: row.itemName, unitPrice: currency(row.unitCost), unit_price: currency(row.unitCost), totalCost: currency(row.totalCost), total_cost: currency(row.totalCost) })),
    tools_equipment: formData.toolsEquipment.map((row: any, index: number) => ({ ...row, no: index + 1, tool_equipment: row.itemName, item_name: row.itemName, unitPrice: currency(row.unitCost), unit_price: currency(row.unitCost), totalCost: currency(row.totalCost), total_cost: currency(row.totalCost), lifeSpan: row.lifeSpan, life_span: row.lifeSpan, productionCycle: row.productionCycle, production_cycle: row.productionCycle, depreciationCost: currency(row.depreciationCost), depreciation_cost: currency(row.depreciationCost) })),
    manpower: formData.manpower.map((row: any, index: number) => ({ ...row, no: index + 1, worker_name: row.workerName, specific_task: row.specificTask, dailyWage: currency(row.dailyWage), daily_wage: currency(row.dailyWage) })),
    other_expenses: formData.otherExpenses.map((row: any, index: number) => ({ ...row, no: index + 1, expense_name: row.expenseName, totalCost: currency(row.totalCost), total_cost: currency(row.totalCost) })),
    gross_sales: formData.grossSales.map((row: any, index: number) => ({ ...row, no: index + 1, productName: row.productName || row.product, product_name: row.productName || row.product, salePricePerUnit: row.salePriceDisplayText || currency(row.salePricePerUnit), sale_price_per_unit: row.salePriceDisplayText || currency(row.salePricePerUnit), salePriceDisplayText: row.salePriceDisplayText || currency(row.salePricePerUnit), sale_price_display_text: row.salePriceDisplayText || currency(row.salePricePerUnit), totalKilos: proposalBuilderNumberDisplay(row.totalKilos, 0), total_kilos: proposalBuilderNumberDisplay(row.totalKilos, 0), totalSales: currency(row.totalSales), total_sales: currency(row.totalSales) })),
    modality_applications: (formData.modalityApplications || []).map((row: any, index: number) => ({ ...row, no: index + 1, amount: currency(row.amount) })),
    partner_counterparts: (formData.partnerCounterparts || []).map((row: any, index: number) => ({ ...row, no: index + 1, amount: currency(row.amount) })),
    scf_schedule: (formData.scfSchedule || proposalBuilderScfSchedule(formData)).map((row: any, index: number) => ({ ...row, no: index + 1, amount: currency(row.amount) })),
  };
  return base;
}

function localUploadPathFromUrl(fileUrl = "") {
  if (!fileUrl.startsWith("local-upload://")) return "";
  const relative = fileUrl.replace("local-upload://", "");
  const target = path.resolve(UPLOAD_ROOT, relative);
  return target.startsWith(UPLOAD_ROOT + path.sep) ? target : "";
}

async function docxTitleOrText(filePath: string) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return String(result.value || "").slice(0, 4000);
  } catch {
    return "";
  }
}

async function assertProposalTemplateIdentity(templateType: ProposalBuilderTemplateType, templatePath: string) {
  const registry = proposalTemplatesRegistry[templateType];
  const actualFileName = path.basename(templatePath);
  let isValid = true;
  let reason = "Template filename and identity text matched.";
  const fail = (message: string) => {
    isValid = false;
    reason = message;
    console.log("[PROPOSAL_TEMPLATE_VALIDATION]", { proposalType: templateType, isValid, reason });
    throw Object.assign(new Error(`Wrong proposal template selected. Expected ${registry.fileName} but got ${actualFileName}.`), { status: 400 });
  };
  if (actualFileName !== registry.fileName) {
    fail(`Expected filename ${registry.fileName} but got ${actualFileName}.`);
  }
  if (path.resolve(templatePath) !== path.resolve(registry.path)) {
    fail(`Expected path ${registry.path} but got ${templatePath}.`);
  }
  const text = await docxTitleOrText(templatePath);
  const missingRequired = registry.requiredText.filter((pattern) => !pattern.test(text)).map(String);
  const forbiddenMatch = registry.forbiddenText.find((pattern) => pattern.test(text));
  if (missingRequired.length || forbiddenMatch) {
    fail(forbiddenMatch ? `Forbidden template text matched ${forbiddenMatch}.` : `Missing required template text: ${missingRequired.join(", ")}.`);
  }
  console.log("[PROPOSAL_TEMPLATE_VALIDATION]", { proposalType: templateType, isValid, reason });
  return text;
}

async function detectProposalTemplates() {
  const byType: Partial<Record<ProposalBuilderTemplateType, any>> = {};
  const mafPath = proposalTemplatesRegistry.MAF.path;
  const mungkahingPath = proposalTemplatesRegistry.MUNGKAHING_PROYEKTO.path;
  if (fsSync.existsSync(mafPath)) {
    try { await assertProposalTemplateIdentity("MAF", mafPath); byType.MAF = { templateType: "MAF", label: proposalTemplatesRegistry.MAF.label, fileName: proposalTemplatesRegistry.MAF.fileName, filePath: mafPath, source: "templates/proposal", isValid: true }; }
    catch (error: any) { byType.MAF = { templateType: "MAF", label: proposalTemplatesRegistry.MAF.label, fileName: proposalTemplatesRegistry.MAF.fileName, filePath: mafPath, source: "templates/proposal", isValid: false, error: error?.message || String(error) }; }
  }
  if (fsSync.existsSync(mungkahingPath)) {
    try { await assertProposalTemplateIdentity("MUNGKAHING_PROYEKTO", mungkahingPath); byType.MUNGKAHING_PROYEKTO = { templateType: "MUNGKAHING_PROYEKTO", label: proposalTemplatesRegistry.MUNGKAHING_PROYEKTO.label, fileName: proposalTemplatesRegistry.MUNGKAHING_PROYEKTO.fileName, filePath: mungkahingPath, source: "templates/proposal", isValid: true }; }
    catch (error: any) { byType.MUNGKAHING_PROYEKTO = { templateType: "MUNGKAHING_PROYEKTO", label: proposalTemplatesRegistry.MUNGKAHING_PROYEKTO.label, fileName: proposalTemplatesRegistry.MUNGKAHING_PROYEKTO.fileName, filePath: mungkahingPath, source: "templates/proposal", isValid: false, error: error?.message || String(error) }; }
  }
  console.log("PROPOSAL_TEMPLATES_DETECTED", {
    mafFound: Boolean(byType.MAF),
    mungkahingProyektoFound: Boolean(byType.MUNGKAHING_PROYEKTO),
    templateRoot: PROPOSAL_TEMPLATE_ROOT,
    patExcluded: true
  });
  return Object.values(byType);
}

async function proposalTemplatePath(templateType: ProposalBuilderTemplateType) {
  const registry = proposalTemplatesRegistry[templateType];
  const filePath = registry.path;
  if (!fsSync.existsSync(filePath)) throw Object.assign(new Error(`${proposalTemplateLabel(templateType)} template not found at ${filePath}.`), { status: 404 });
  await assertProposalTemplateIdentity(templateType, filePath);
  console.log("PROPOSAL_SELECTED_TEMPLATE_PATH", { templateType, templatePath: filePath });
  return filePath;
}

function proposalBuilderFileName(templateType: ProposalBuilderTemplateType, formData: any) {
  const schema = proposalSchemas[templateType as ProposalType];
  const date = new Date().toISOString().slice(0, 10);
  const clean = (value: any) => String(value || "").replace(/[^a-z0-9]+/gi, "").slice(0, 40) || "Proposal";
  return schema.generatedFilenamePattern
    .replace("{municipality}", clean(formData.municipality))
    .replace("{projectName}", clean(formData.projectName || formData.title))
    .replace("{date}", date);
}

function proposalBuilderScalarData(data: any) {
  const scalar: Record<string, string> = {};
  const visit = (value: any, prefix = "") => {
    if (Array.isArray(value)) {
      scalar[prefix] = value.map((row) => {
        if (!row || typeof row !== "object") return String(row ?? "");
        return Object.values(row).filter((cell) => typeof cell !== "object").join(" | ");
      }).join("\n");
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, prefix ? `${prefix}_${key}` : key);
      return;
    }
    if (prefix) scalar[prefix] = String(value ?? "");
  };
  visit(data);
  for (const [key, value] of Object.entries({ ...scalar })) {
    scalar[key.toUpperCase()] = value;
    scalar[key.toLowerCase()] = value;
  }
  return scalar;
}

function escapeXmlText(value: any) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceContentControlsInXml(xml: string, scalarData: Record<string, string>) {
  return xml.replace(/<w:sdt\b[\s\S]*?<\/w:sdt>/g, (block) => {
    const tagMatch = block.match(/<w:tag\b[^>]*w:val="([^"]+)"/) || block.match(/<w:alias\b[^>]*w:val="([^"]+)"/);
    const tag = tagMatch?.[1] || "";
    if (!tag || !(tag in scalarData)) return block;
    const replacement = `<w:p><w:r><w:t xml:space="preserve">${escapeXmlText(scalarData[tag])}</w:t></w:r></w:p>`;
    return block.replace(/<w:sdtContent\b[^>]*>[\s\S]*?<\/w:sdtContent>/, `<w:sdtContent>${replacement}</w:sdtContent>`);
  });
}

function replacePlainPlaceholdersInXml(xml: string, scalarData: Record<string, string>) {
  let output = xml;
  for (const [key, value] of Object.entries(scalarData)) {
    const escaped = escapeXmlText(value);
    for (const token of [`{{${key}}}`, `{${key}}`, `[[${key}]]`]) {
      output = output.replace(new RegExp(escapeRegExp(escapeXmlText(token)), "g"), escaped);
    }
  }
  return output;
}

async function proposalDocxPlaceholderReport(buffer: Buffer, scalarData: Record<string, string>) {
  const found = new Set<string>();
  try {
    const zip = await JSZip.loadAsync(buffer);
    const xmlPaths = Object.keys(zip.files).filter((name) => /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(name));
    for (const xmlPath of xmlPaths) {
      const file = zip.file(xmlPath);
      if (!file) continue;
      const xml = await file.async("string");
      for (const match of xml.matchAll(/\{\{([A-Za-z0-9_]+)\}\}|\[\[([A-Za-z0-9_]+)\]\]|\{([A-Za-z0-9_]+)\}/g)) {
        found.add(match[1] || match[2] || match[3]);
      }
      for (const match of xml.matchAll(/<w:(?:tag|alias)\b[^>]*w:val="([^"]+)"/g)) {
        if (!/^goog_rdk_/i.test(match[1])) found.add(match[1]);
      }
    }
  } catch (error: any) {
    console.log("PROPOSAL_PLACEHOLDER_SCAN_ERROR", { reason: error?.message || String(error) });
  }
  const placeholders = [...found];
  return {
    found: placeholders,
    replaced: placeholders.filter((key) => key in scalarData),
    missing: placeholders.filter((key) => !(key in scalarData)),
  };
}

async function fillProposalTemplateCopy(templatePath: string, docxPath: string, formData: any) {
  await assertProposalTemplateIdentity(formData.templateType, templatePath);
  await fs.copyFile(templatePath, docxPath);
  const templateBuffer = await fs.readFile(docxPath);
  const data = proposalBuilderDocxData(formData);
  const scalarData = proposalBuilderScalarData(data);
  const beforeReport = await proposalDocxPlaceholderReport(templateBuffer, scalarData);
  let renderedBuffer = templateBuffer;
  try {
    const zip = new PizZip(templateBuffer);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    doc.render(data);
    renderedBuffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
  } catch (error: any) {
    console.log("PROPOSAL_DOCX_PLACEHOLDER_RENDER_SKIPPED", { templateType: formData.templateType, reason: error?.message || String(error), missingPlaceholders: beforeReport.missing });
  }

  try {
    const zip = await JSZip.loadAsync(renderedBuffer);
    const xmlPaths = Object.keys(zip.files).filter((name) => /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(name));
    for (const xmlPath of xmlPaths) {
      const file = zip.file(xmlPath);
      if (!file) continue;
      const xml = await file.async("string");
      zip.file(xmlPath, replacePlainPlaceholdersInXml(replaceContentControlsInXml(xml, scalarData), scalarData));
    }
    renderedBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  } catch (error: any) {
    console.log("PROPOSAL_DOCX_CONTENT_CONTROL_RENDER_SKIPPED", { templateType: formData.templateType, reason: error?.message || String(error) });
  }
  await fs.writeFile(docxPath, renderedBuffer);
  const generatedText = await docxTitleOrText(docxPath);
  const registry = proposalTemplatesRegistry[formData.templateType as ProposalBuilderTemplateType];
  const forbiddenMatch = registry.forbiddenText.find((pattern) => pattern.test(generatedText));
  if (forbiddenMatch) {
    try { await fs.unlink(docxPath); } catch {}
    throw Object.assign(new Error(`Wrong proposal template selected. Expected ${registry.fileName} but got ${path.basename(templatePath)}.`), { status: 400 });
  }
  const afterReport = await proposalDocxPlaceholderReport(renderedBuffer, scalarData);
  console.log("PROPOSAL_PLACEHOLDER_REPLACEMENT_RESULT", {
    templateType: formData.templateType,
    templatePath,
    generatedDocxPath: docxPath,
    placeholdersFound: beforeReport.found.length,
    placeholdersMatched: beforeReport.replaced.length,
    missingPlaceholders: beforeReport.missing,
    placeholdersRemaining: afterReport.found,
  });
}

function proposalInventoryRow(row: any) {
  const latestDraft = db.prepare("SELECT draftId FROM proposal_drafts WHERE proposalId = ? AND status != 'Deleted' ORDER BY createdAt DESC LIMIT 1").get(row.proposalId) as any;
  return {
    proposalId: row.proposalId,
    proposalType: row.templateType,
    templateType: row.templateType,
    title: row.title,
    municipality: row.municipality,
    barangay: row.barangay,
    projectName: row.projectName,
    enterpriseType: row.enterpriseType,
    totalCost: row.totalCost,
    status: row.status,
    formData: parseJson(row.formDataJson, {}),
    originalFolderName: row.originalFolderName || "",
    uploadRootPath: row.uploadRootPath || "",
    detectedDocuments: parseJson(row.detectedDocumentsJson || "[]", []),
    extractedItems: parseJson(row.extractedItemsJson || "[]", []),
    docxPath: row.docxPath,
    generatedFilePath: row.docxPath,
    previewPath: row.previewPath,
    ownerUserId: row.ownerUserId || "",
    latestDraftId: latestDraft?.draftId || "",
    downloadUrl: latestDraft?.draftId ? `/api/proposals/drafts/${latestDraft.draftId}/download` : "",
    previewUrl: latestDraft?.draftId ? `/api/proposals/drafts/${latestDraft.draftId}/preview` : "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function draftRow(row: any) {
  return {
    draftId: row.draftId,
    proposalId: row.proposalId,
    proposalType: row.templateType,
    templateType: row.templateType,
    fileName: row.fileName,
    generatedFilePath: row.docxPath,
    previewUrl: `/api/proposals/drafts/${row.draftId}/preview`,
    docxDownloadUrl: `/api/proposals/drafts/${row.draftId}/download`,
    downloadUrl: `/api/proposals/drafts/${row.draftId}/download`,
    previewAvailable: true,
    status: row.status,
    formData: parseJson(row.formDataJson, {}),
    ownerUserId: row.ownerUserId || "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function proposalBuilderScfSchedule(formData: any) {
  return [
    { expense: "Raw Materials", amount: moneyValue(formData.rawMaterialsSubtotal) },
    { expense: "Tools and Equipment", amount: moneyValue(formData.toolsEquipmentSubtotal) },
    ...(formData.otherExpensesTotal ? [{ expense: "Other Expenses", amount: moneyValue(formData.otherExpensesTotal) }] : []),
    { expense: "Grand Total", amount: moneyValue(formData.grandTotal) },
  ];
}

function proposalBuilderDbLineItems(proposalId: string, formData: any) {
  const schema = proposalSchemaFor(formData);
  const rows: any[] = [];
  const push = (section: string, row: any, index: number, itemName: string, catalogType = section) => {
    rows.push({
      lineItemId: uniqueProposalLineItemId(proposalId, section, index),
      proposalId,
      proposalType: schema.proposalType,
      sectionKey: section,
      catalogItemId: row.catalogItemId || "",
      section,
      catalogType,
      itemName,
      category: row.category || "",
      unit: row.unit || "",
      quantity: moneyValue(row.quantity),
      unitCost: moneyValue(row.unitCost ?? row.salePricePerUnit),
      totalCost: moneyValue(row.totalCost ?? row.dailyWage ?? row.totalSales ?? row.amount),
      remarks: row.remarks || row.frequency || row.specificTask || "",
      valuesJson: json(row),
    });
  };
  for (const table of schema.tables) {
    const sourceRows = table.key === "scfSchedule" && !(formData.scfSchedule || []).length ? proposalBuilderScfSchedule(formData) : (formData[table.key] || []);
    sourceRows.forEach((row: any, index: number) => {
      const labelKey = table.columns.find((column: any) => !column.computed)?.key || "itemName";
      push(table.section, row, index, row.itemName || row.productName || row.product || row.expenseName || row.workerName || row[labelKey] || table.label, table.catalogType || table.label);
    });
  }
  return rows.filter((row) => row.itemName);
}

function requesterProfile(req: express.Request) {
  const userId = String(req.query.userId || req.body?.userId || req.headers["x-user-id"] || "");
  return userId ? getLocalProfileById(userId) as any : null;
}

function canDeleteProposalRecord(row: any, profile: any) {
  if (profile?.role === "admin" && profile?.status === "approved") return true;
  return false;
}

async function unlinkGeneratedProposalFile(filePath: string, label: string) {
  try {
    if (filePath && fsSync.existsSync(filePath)) await fs.unlink(filePath);
  } catch (error) {
    console.warn(`Proposal ${label} delete failed:`, { filePath, error });
  }
}

function saveProposalBuilderCatalogItem(input: any, itemId = input.itemId || randomId("catalog")) {
  const catalogType = String(input.catalogType || "").toLowerCase().includes("tool") ? "Tool/Equipment" : "Raw Material";
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT itemId FROM proposal_catalog_items WHERE itemId = ?").get(itemId) as any;
  const values = [
    catalogType,
    input.itemName || input.item_name || "",
    input.category || "",
    input.unit || "",
    moneyValue(input.defaultQuantity ?? input.quantity ?? 1),
    moneyValue(input.unitCost ?? input.unit_cost ?? input.unit_price),
    input.supplier || "",
    input.remarks || "",
    input.isActive === false ? 0 : 1,
    now,
  ];
  if (existing) {
    db.prepare(`UPDATE proposal_catalog_items SET catalogType = ?, itemName = ?, category = ?, unit = ?, defaultQuantity = ?, unitCost = ?, supplier = ?, remarks = ?, isActive = ?, updatedAt = ? WHERE itemId = ?`).run(...values, itemId);
  } else {
    db.prepare(`INSERT INTO proposal_catalog_items (itemId, catalogType, itemName, category, unit, defaultQuantity, unitCost, supplier, remarks, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(itemId, ...values.slice(0, 9), now, now);
  }
  return db.prepare("SELECT * FROM proposal_catalog_items WHERE itemId = ?").get(itemId);
}

async function generateProposalBuilderDraft(input: any) {
  const formData = proposalBuilderFormData(input);
  const templateType = formData.templateType;
  const ownerUserId = String(input.userId || input.ownerUserId || "");
  console.log("PROPOSAL_GENERATE_START", {
    templateType,
    rawMaterialCount: formData.rawMaterials.length,
    toolsEquipmentCount: formData.toolsEquipment.length,
    grandTotal: formData.grandTotal
  });
  const templatePath = await proposalTemplatePath(templateType);
  const proposalId = input.proposalId || randomId("proposal");
  const draftId = randomId("draft");
  const fileName = proposalBuilderFileName(templateType, formData);
  const fileSafeDraftId = draftId.replace(/[^a-z0-9_-]+/gi, "_");
  const docxPath = path.join(PROPOSAL_GENERATED_ROOT, `${fileSafeDraftId}_${fileName}`);
  await fs.mkdir(PROPOSAL_GENERATED_ROOT, { recursive: true });
  await fillProposalTemplateCopy(templatePath, docxPath, formData);
  console.log("[PROPOSAL_TEMPLATE_SELECTED]", {
    proposalType: templateType,
    expectedTemplate: proposalTemplatesRegistry[templateType].fileName,
    actualTemplatePath: templatePath,
    actualTemplateFileName: path.basename(templatePath),
  });
  console.log("[PROPOSAL_GENERATED_FILE]", { proposalId, generatedFilePath: docxPath, generatedFileName: fileName });
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO proposal_inventory (proposalId, templateType, title, municipality, barangay, projectName, enterpriseType, totalCost, status, formDataJson, docxPath, previewPath, ownerUserId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Ready for Review', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(proposalId) DO UPDATE SET templateType = excluded.templateType, title = excluded.title, municipality = excluded.municipality, barangay = excluded.barangay, projectName = excluded.projectName, enterpriseType = excluded.enterpriseType, totalCost = excluded.totalCost, status = 'Revised', formDataJson = excluded.formDataJson, docxPath = excluded.docxPath, previewPath = excluded.previewPath, ownerUserId = COALESCE(NULLIF(excluded.ownerUserId, ''), proposal_inventory.ownerUserId), updatedAt = excluded.updatedAt`)
        .run(proposalId, templateType, formData.title, formData.municipality, formData.barangay, formData.projectName, formData.enterpriseType, formData.grandTotal, json(formData), docxPath, "", ownerUserId, now, now);
      db.prepare(`INSERT INTO proposal_drafts (draftId, proposalId, templateType, fileName, docxPath, previewPath, formDataJson, ownerUserId, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Ready for Review', ?, ?)`)
        .run(draftId, proposalId, templateType, fileName, docxPath, "", json(formData), ownerUserId, now, now);
      db.prepare("DELETE FROM proposal_line_items WHERE proposalId = ?").run(proposalId);
      const insertLine = db.prepare(`INSERT INTO proposal_line_items (lineItemId, proposalId, proposalType, sectionKey, catalogItemId, section, catalogType, itemName, category, unit, quantity, unitCost, totalCost, remarks, valuesJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of proposalBuilderDbLineItems(proposalId, formData)) {
        insertLine.run(row.lineItemId, row.proposalId, row.proposalType, row.sectionKey, row.catalogItemId, row.section, row.catalogType, row.itemName, row.category, row.unit, row.quantity, row.unitCost, row.totalCost, row.remarks, row.valuesJson);
      }
      for (const row of [...formData.rawMaterials, ...formData.toolsEquipment]) {
        if (row.saveToCatalog) saveProposalBuilderCatalogItem(row);
      }
    })();
  } catch (error) {
    try { if (docxPath && fsSync.existsSync(docxPath)) await fs.unlink(docxPath); } catch (unlinkError) { console.warn("Generated DOCX cleanup failed after save error:", unlinkError); }
    throw error;
  }
  console.log("PROPOSAL_INVENTORY_UPDATED", { proposalId, status: "Ready for Review" });
  console.log("[PROPOSAL_PREVIEW_SOURCE]", { proposalId, previewSourcePath: docxPath });
  console.log("PROPOSAL_GENERATE_COMPLETE", { draftId, proposalId, fileName, previewType: "docx" });
  return { ok: true, draftId, proposalId, fileName, generatedFilePath: docxPath, previewAvailable: true, previewType: "docx", previewUrl: `/api/proposals/drafts/${draftId}/preview`, docxDownloadUrl: `/api/proposals/drafts/${draftId}/download`, downloadUrl: `/api/proposals/drafts/${draftId}/download`, status: "Ready for Review" };
}

const MAX_CONTEXT_CHARS = 5000;
const MAX_CHUNKS = 8;
const CHAT_TIMEOUT = 60000;
const RAG_KEYWORD_SCAN_LIMIT = 50;
const CHAT_RESPONSE_MODE = "deterministic";

// =========================
// ANALYSIS ENGINE (full engine: QueryIntentParser, SourceScorer, ExcelEngine, ChartEngine, AnswerComposer, Session)
// =========================
type QueryAction = "explain" | "find" | "count" | "compare" | "verify" | "match" | "summarize" | "analyze" | "generate_report" | "list" | "show_breakdown" | "create_chart" | "export" | "unknown";
type QueryScope = "attached_file" | "named_file" | "named_folder" | "all_files" | "database" | "previous_result" | "unknown";
type DocType = "proposal" | "template" | "guideline" | "report" | "form" | "spreadsheet" | "pdf" | "image" | "project_record" | "participant_record" | "financial_record" | "monitoring_record" | "training_record" | "none";
type ChartType = "bar" | "horizontal_bar" | "stacked_bar" | "line" | "pie" | "donut" | "area" | "scatter" | "kpi" | "heatmap" | "table" | "none";
type IntentType = "explanation/definition" | "search/find" | "count" | "analyze dataset" | "compare/match" | "report" | "chart";
const NO_RELEVANT_SOURCE_MESSAGE = "I could not find a relevant answer in the uploaded files/documents. Please upload a related file or ask a question based on the available documents.";

interface ParsedQuery {
  intentType: IntentType;
  action: QueryAction; scope: QueryScope; docType: DocType; topicTerms: string[]; requiredFields: string[];
  namedSourceTerms: string[];
  outputType: "direct_answer" | "table" | "chart" | "list" | "summary" | "export";
  needsExcel: boolean; needsChart: boolean; groupBy: string[]; filterBy: Record<string, string>;
}

type ClassifiedQuestion = {
  intent: "document_qa" | "data_count" | "data_breakdown" | "file_copy" | "name_match" | "dashboard_metric" | "chart_report" | "unknown";
  sourceHint: string[];
  requiredModules: string[];
  requiredColumns: string[];
  filters: { municipality?: string; year?: string; status?: string; participantType?: string; projectType?: string };
  needsChart: boolean;
  needsTable: boolean;
  needsDownload: boolean;
};

function parseQuery(message: string): ParsedQuery {
  const lower = message.toLowerCase();
  let action: QueryAction = "unknown";
  if (/\b(what is|what are|define|definition of|meaning of|explain|explanation|describe|how does|why is|tell me about)\b/i.test(lower)) action = "explain";
  else if (/how many|count\b|total\b|number of|unique\b|distinct/i.test(lower)) action = "count";
  else if (/compare|vs\b|versus|difference|similarity|overlap|gap|missing.*not/i.test(lower)) action = "compare";
  else if (/verify|check if|confirm|validate/i.test(lower)) action = "verify";
  else if (/\bmatch\b|\blookup\b|\bfind\b.*\bin\b|\bsearch\b.*\bfor\b/i.test(lower) && !/find\s+(fish|livelihood|monitoring|proposal|template|guideline|report)/i.test(lower)) action = "match";
  else if (/summarize|summary|overview/i.test(lower)) action = "summarize";
  else if (/analyze|analyse|examine|explore/i.test(lower)) action = "analyze";
  else if (/generate.*report|create.*report/i.test(lower)) action = "generate_report";
  else if (/list\b|show\s+all|enumerate/i.test(lower)) action = "list";
  else if (/breakdown|pivot|group by|by municipality|by barangay|by status|by year|by type/i.test(lower)) action = "show_breakdown";
  else if (/chart|graph|visualize|plot/i.test(lower)) action = "create_chart";
  else if (/export|download|extract/i.test(lower)) action = "export";
  else if (/do you have|have a|find\s+|search\s+|proposal about|template for|guideline on|report on/i.test(lower)) action = "find";

  let scope: QueryScope = "all_files";
  if (/attached|attachment|this file|uploaded file|the file|attached file/i.test(lower)) scope = "attached_file";
  else if (/in folder|folder .*:|folder name|from folder|under folder/i.test(lower)) scope = "named_folder";
  else if (/\b(file|document|source)\s+["']?[\w .()_-]{3,}/i.test(message) || /\b(in|from)\s+["']?[\w .()_-]+\.(pdf|docx?|xlsx?|csv|txt)\b/i.test(message)) scope = "named_file";
  else if (/previous|last|earlier|before/i.test(lower)) scope = "previous_result";

  const namedSourceTerms: string[] = [];
  const namedPatterns = [
    /\b(?:file|document|source)\s+(?:named|called|titled)?\s*["']?([^"'\n?]{3,120}?\.(?:pdf|docx?|xlsx?|csv|txt))["']?/gi,
    /\b(?:in|from)\s+["']?([^"'\n?]{3,120}?\.(?:pdf|docx?|xlsx?|csv|txt))["']?/gi,
    /\b(?:folder|from folder|in folder|under folder)\s*[:=]?\s*["']?([^"'\n?]{3,80})["']?/gi,
  ];
  for (const pattern of namedPatterns) {
    for (const match of message.matchAll(pattern)) {
      const term = normalizeName(match[1]).replace(/\b(file|document|folder|source)\b/g, "").trim();
      if (term && term.length >= 3 && !namedSourceTerms.includes(term)) namedSourceTerms.push(term);
    }
  }

  let docType: DocType = "none";
  const typePatterns: [RegExp, DocType][] = [
    [/\bproposal\b|\bproposed\b|\bproject\s*proposal\b|\brequest\b(?!.*info)/i, "proposal"],
    [/\btemplate\b|\bform\b|\bformat\b|\bsample\s*form\b/i, "template"],
    [/\bguideline\b|\bguidelines\b|\bmemo\b|\bmemorandum\b|\bMC\b|\bmc\b|\bcircular\b|\bpolicy\b/i, "guideline"],
    [/\breport\b|\bsummary\b|\baccomplishment\b|\bassessment\b/i, "report"],
    [/\bpdf\b|\bdocument\b|\b.pdf\b/i, "pdf"],
    [/\bspreadsheet\b|\bxlsx\b|\bcsv\b|\bexcel\b/i, "spreadsheet"],
    [/\bproject\b|\benterprise\b|\blivelihood\b|\bhog\b|\bfattening\b/i, "project_record"],
    [/\bparticipant\b|\bbeneficiar\b|\bclient\b|\bpersonal\b|\bencoded\b|\bserved\b/i, "participant_record"],
    [/\bfinancial\b|\bfinance\b|\bbudget\b|\bamount\b|\bfund\b|\bliquidation\b/i, "financial_record"],
    [/\bmonitoring\b|\bvisit\b|\bmdmonitoring\b/i, "monitoring_record"],
    [/\btraining\b|\btrainings\b|\borientation\b|\bseminar\b/i, "training_record"],
  ];
  for (const [pattern, dt] of typePatterns) { if (pattern.test(lower)) { docType = dt; break; } }

  const topicTerms: string[] = [];
  const topicPatterns: [RegExp, string[]][] = [
    [/fish|fishing|fishery|fisheries|fish cage|fishing supply/i, ["fish", "fishing", "fishery"]],
    [/livelihood|enterprise|business/i, ["livelihood"]], [/education|elementary|high school|college|degree/i, ["education"]],
    [/grant|grant code|grant id/i, ["grant"]], [/visit|monitoring date|date of visit/i, ["visit"]],
    [/4ps|4p|pantawid|non-4ps|non4ps/i, ["4ps"]], [/solo parent|single parent/i, ["solo parent"]],
    [/closed|operational|active|inactive|ongoing/i, ["status"]], [/amount|budget|fund|cost|allocation/i, ["amount"]],
    [/municipality|municipal|city/i, ["municipality"]], [/barangay|brgy/i, ["barangay"]],
    [/encoded|encoding|not encoded|missing/i, ["encoded"]], [/served|is served|pantawid/i, ["served"]],
    [/training|trainings|seminar|workshop/i, ["training"]], [/monitoring|monitor|mdmonitoring/i, ["monitoring"]],
    [/project|enterprise|hog|fattening/i, ["project"]],
  ];
  for (const [pattern, terms] of topicPatterns) { if (pattern.test(lower)) terms.forEach(t => { if (!topicTerms.includes(t)) topicTerms.push(t); }); }

  const aboutMatch = lower.match(/\b(?:about|for|with|topic)\s+([a-z0-9\s-]{2,40})(?:\?|$)/);
  if (aboutMatch) { const t = aboutMatch[1].trim().replace(/\b(proposal|template|form|guideline|report|document|file)\b/g, "").trim(); if (t.length >= 2 && !topicTerms.includes(t)) topicTerms.push(t); }
  const simpleTerm = lower.match(/\b(fish|fishing|fishery|fisheries|monitoring|livelihood|training|education|grant|visit|amount|municipality|barangay)\b/);
  if (simpleTerm && !topicTerms.some(t => t.includes(simpleTerm[1]))) topicTerms.push(simpleTerm[1]);

  const requiredFields: string[] = [];
  const fieldPatterns: [RegExp, string][] = [
    [/status|closed|operational|active|inactive|ongoing/i, "status"], [/project|enterprise|livelihood|hog/i, "project"],
    [/name|full name|participant name|beneficiary name/i, "name"], [/municipality|city/i, "municipality"],
    [/barangay|brgy/i, "barangay"], [/grant.*code|grant.*id/i, "grant code"],
    [/visit|monitoring.*date|date.*visit/i, "visit"], [/amount|budget|fund|cost|allocation/i, "amount"],
    [/education|elementary|high school|college|degree/i, "education"],
    [/participant.*type|type.*participant|4ps|pantawid/i, "participant type"], [/year|date|year served/i, "year"],
  ];
  for (const [pattern, field] of fieldPatterns) { if (pattern.test(lower) && !requiredFields.includes(field)) requiredFields.push(field); }

  let outputType: ParsedQuery["outputType"] = "direct_answer";
  if (/chart|graph|visualize|plot/i.test(lower)) outputType = "chart";
  else if (/table|tabular/i.test(lower)) outputType = "table";
  else if (/list|enumerate|show all|all records/i.test(lower)) outputType = "list";
  else if (/summary|overview|summarize/i.test(lower)) outputType = "summary";
  else if (/export|download|extract/i.test(lower)) outputType = "export";
  else if (action === "show_breakdown" || action === "analyze") outputType = "table";

  const needsExcel = /match|lookup|xlookup|vlookup|countif|sumif|pivot|encoded.*not|not.*encoded|missing|compare|gap|duplicate|overlap|unique|distinct|vstack|hstack|filter|sort|join|merge/i.test(lower) || action === "compare" || action === "match" || action === "verify";
  const needsChart = /chart|graph|visualize|plot|breakdown|pivot|trend|compare.*chart|show.*chart/i.test(lower) || outputType === "chart" || action === "create_chart";
  const intentType: IntentType =
    needsChart || action === "create_chart" ? "chart" :
    action === "explain" ? "explanation/definition" :
    action === "count" || action === "show_breakdown" ? "count" :
    action === "analyze" || action === "summarize" ? "analyze dataset" :
    action === "compare" || action === "match" || action === "verify" ? "compare/match" :
    action === "generate_report" ? "report" :
    "search/find";

  const groupBy: string[] = [];
  const gp: [RegExp, string][] = [[/by municipality|municipality/i, "municipality"], [/by barangay|barangay/i, "barangay"], [/by status|status/i, "status"], [/by year|year/i, "year"], [/by type|type/i, "type"], [/by project|project/i, "project"], [/by sex|sex|gender/i, "sex"]];
  for (const [pattern, f] of gp) { if (pattern.test(lower) && !groupBy.includes(f)) groupBy.push(f); }

  const filterBy: Record<string, string> = {};
  if (/closed\b/i.test(lower) && !/operational/i.test(lower)) filterBy.status = "closed";
  if (/operational\b/i.test(lower) && !/closed/i.test(lower)) filterBy.status = "operational";
  const yearMatch = lower.match(/\b(20\d{2})\b/); if (yearMatch) filterBy.year = yearMatch[1];
  if (/4ps|pantawid/i.test(lower) && !/non[- ]?4ps|non[- ]?4p/i.test(lower)) filterBy.type = "4Ps";
  if (/non[- ]?4ps|non[- ]?4p/i.test(lower) && !/4ps|pantawid/i.test(lower)) filterBy.type = "Non-4Ps";

  return { intentType, action, scope, docType, topicTerms, requiredFields, namedSourceTerms, outputType, needsExcel, needsChart, groupBy, filterBy };
}

function classifyQuestion(question: string): ClassifiedQuestion {
  const parsed = parseQuery(question);
  const filters = extractStrictFilters(question, parsed);
  const lower = normalizeName(question);
  const sourceHint: string[] = [];
  const requiredModules: string[] = [];
  const requiredColumns = [...parsed.requiredFields];
  let intent: ClassifiedQuestion["intent"] = "unknown";

  if (isFileRequest(question)) intent = "file_copy";
  else if (/name match|duplicate|verify names?|match and compare/.test(lower)) intent = "name_match";
  else if (/dashboard|kpi|card|metric/.test(lower)) intent = "dashboard_metric";
  else if (parsed.needsChart || parsed.intentType === "report") intent = "chart_report";
  else if (parsed.intentType === "count" && parsed.groupBy.length) intent = "data_breakdown";
  else if (parsed.intentType === "count" || /how many|count|total|number of/.test(lower)) intent = "data_count";
  else if (parsed.intentType === "explanation/definition" || parsed.docType !== "none") intent = "document_qa";

  if (/mc\s*0?3|guidelines?|omnibus/.test(lower)) { sourceHint.push("GUIDELINES", "MC 03", "omnibus guidelines"); requiredModules.push("GUIDELINES_MC03"); }
  if (/template|tool|form|annex|copy|download/.test(lower)) sourceHint.push("TEMPLATES");
  if (/participant|4ps|non 4ps|served/.test(lower)) { requiredModules.push("PERSONAL"); requiredColumns.push("SLP Participant ID"); }
  if (/project|enterprise|association|individual enterprise|most implemented/.test(lower)) { requiredModules.push("PROJECT"); requiredColumns.push("Project ID"); }
  if (/operational|closed|status/.test(lower)) requiredModules.push("MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION");
  if (/training|trained/.test(lower)) requiredModules.push("TRAINING");
  if (/grant utilization|gur/.test(lower)) requiredModules.push("PROJECT", "GRANT_UTILIZATION");
  if (/slpis|personal module/.test(lower)) sourceHint.push("SLPIS", "Personal Module");
  if (/project module/.test(lower)) sourceHint.push("Project Module");

  return {
    intent,
    sourceHint: Array.from(new Set(sourceHint)),
    requiredModules: Array.from(new Set(requiredModules)),
    requiredColumns: Array.from(new Set(requiredColumns)),
    filters: {
      municipality: filters.municipality,
      year: filters.year,
      status: filters.status,
      participantType: filters.participantType,
    },
    needsChart: parsed.needsChart,
    needsTable: parsed.outputType === "table" || parsed.groupBy.length > 0 || intent === "data_count" || intent === "data_breakdown",
    needsDownload: intent === "file_copy",
  };
}

// Strict filter extraction from user question
interface QuestionFilters {
  municipality?: string;
  barangay?: string;
  year?: string;
  participantType?: "4Ps" | "Non-4Ps";
  pwd?: boolean;
  soloParent?: boolean;
  sex?: string;
  status?: string; // operational, closed, conducted, not conducted, served, not served
  personName?: string;
  participantId?: string;
  projectId?: string;
  grantCode?: string;
  projectType?: string;
  fileKeywords?: string[];
  moduleIntent?: string;
  metric?: string; // count, list, compare, breakdown, chart, report
}

function extractStrictFilters(message: string, parsed: ParsedQuery): QuestionFilters {
  const lower = normalizeName(message);
  const filters: QuestionFilters = {};
  const strictIntent = classifyStrictSlpIntent(message, parsed);
  const terms = extractStructuredLookupTerms(message);
  if (terms.name && (strictIntent === "person_lookup" || /(?:person|participant|beneficiary|client|name)\s+(?:named|called|is)|(?:project|training|grant code|status|record|lookup|find|search|served)\s+(?:of|for)\s+/i.test(message))) filters.personName = terms.name;
  if (terms.participantId) filters.participantId = terms.participantId;
  if (terms.projectId) filters.projectId = terms.projectId;
  if (terms.grantCode) filters.grantCode = terms.grantCode;

  // Municipality: look for any Aurora municipality name
  for (const muni of AURORA_MUNICIPALITIES) {
    if (lower.includes(normalizeName(muni))) {
      filters.municipality = muni;
      break;
    }
  }
  const barangay = findKnownBarangayFilter(message);
  if (barangay) filters.barangay = barangay;

  // Year
  const yearMatch = message.match(/\b(20\d{2})\b/);
  if (yearMatch) filters.year = yearMatch[1];

  // Participant type
  if (/4ps|pantawid/i.test(message) && !/non[- ]?4ps|non[- ]?4p/i.test(message)) filters.participantType = "4Ps";
  else if (/non[- ]?4ps|non[- ]?4p/i.test(message)) filters.participantType = "Non-4Ps";
  if (/\bpwd\b|person with disabil|disability/i.test(message)) filters.pwd = true;
  if (/solo parent|single parent/i.test(message)) filters.soloParent = true;
  const sexMatch = lower.match(/\b(female|male|woman|women|girl|girls|man|men|boy|boys)\b/);
  if (sexMatch) filters.sex = /female|woman|women|girl/.test(sexMatch[1]) ? "female" : "male";

  // Status keywords (conducted, not conducted, served, operational, closed)
  if (/conducted|with\s+training|with\s+orientation/i.test(lower) && !/not\s+conducted|without\s+training|without\s+orientation/i.test(lower)) filters.status = "conducted";
  else if (/not\s+conducted|without\s+training|without\s+orientation/i.test(lower)) filters.status = "not conducted";
  else if (/served|is\s+served|with\s+served/i.test(lower) && !/not\s+served/i.test(lower)) filters.status = "served";
  else if (/\b(closed|close|not operational|non operational|not operating)\b/i.test(lower) && !/\b(operational vs closed|closed vs operational)\b/i.test(lower)) filters.status = "closed";
  else if (/\b(operational|active|operating)\b/i.test(lower) && !/\b(closed|close|not operational|non operational|not operating)\b/i.test(lower)) filters.status = "operational";
  if (/association|enterprise|project|most implemented/.test(lower) && filters.status === "served") delete filters.status;
  const projectTypeMatch = message.match(/\b(?:project|enterprise|livelihood)\s+(?:type|kind|category)?\s*(?:of|for|is)?\s*([A-Za-z0-9Ññ\-\s]{3,60})(?:\?|$|,|\bin\b|\bby\b)/i);
  if (projectTypeMatch && !/project of|enterprise of/i.test(message)) filters.projectType = standardizeNameParts(projectTypeMatch[1]);
  const valueBackedProjectType = findKnownProjectTypeFilter(message);
  if (valueBackedProjectType) filters.projectType = valueBackedProjectType;
  else if (filters.projectType && !projectTypeFilterExists(filters.projectType)) delete filters.projectType;
  filters.fileKeywords = tokenizeForSearch(message);

  // Module intent from parsed
  if (parsed.docType !== "none") filters.moduleIntent = parsed.docType;

  // Metric from parsed.action
  filters.metric = parsed.action;

  return filters;
}

function filterRowsByFilters<T extends Record<string, any>>(rows: T[], headers: string[], filters: QuestionFilters): T[] {
  return rows.filter((row) => {
    // Municipality filter
    if (filters.municipality) {
      const muniVal = normalizeMunicipalityName(getCell(row, findMatchingColumn(headers, "municipality") || "municipality"));
      if (muniVal !== filters.municipality) return false;
    }
    if (filters.barangay) {
      const barangayCol = findSlpColumn(headers, ["Barangay", "Brgy"]);
      if (!barangayCol || normalizeName(row[barangayCol] || "") !== normalizeName(filters.barangay)) return false;
    }
    // Year filter
    if (filters.year) {
      const yearCol = findSlpColumn(headers, ["Year Served", "Implementation Year", "Year", "Date Served", "Date"]) || headers.find(h => /year/i.test(h)) || "";
      if (yearCol) {
        const yearVal = String(row[yearCol] || "").trim();
        if (!yearVal.includes(filters.year)) return false;
      }
    }
    // Participant type filter (4Ps vs Non-4Ps)
    if (filters.participantType) {
      const typeCol = headers.find(h => /pantawid|4ps/i.test(h)) || findMatchingColumn(headers, "participant type") || headers.find(h => /4ps|pantawid|type/i.test(h)) || "";
      if (typeCol) {
        const typeVal = normalizeName(row[typeCol] || "");
        if (filters.participantType === "4Ps") {
          if (!/4ps|pantawid|yes|true|oo/.test(typeVal)) return false;
        } else {
          if (/4ps|pantawid|yes|true|oo/.test(typeVal)) return false;
        }
      }
    }
    if (filters.pwd) {
      const pwdCol = findPwdColumn(headers);
      if (!pwdCol) return false;
      const pwdVal = normalizeName(row[pwdCol] || "");
      if (!/\bpwd\b|person with disabil|disability|yes|true|oo|y\b/.test(pwdVal) || /\b(no|not|none|false|non pwd)\b/.test(pwdVal)) return false;
    }
    if (filters.soloParent) {
      const soloCol = findSlpColumn(headers, ["Solo Parent", "Single Parent", "Sector", "Vulnerability", "Participant Type"]);
      if (!soloCol) return false;
      const soloVal = normalizeName(row[soloCol] || "");
      if (!/solo parent|single parent|yes|true|oo|y\b/.test(soloVal) || /\b(no|not|none|false)\b/.test(soloVal)) return false;
    }
    if (filters.sex) {
      const sexCol = findSlpColumn(headers, ["Sex", "Gender"]);
      if (!sexCol) return false;
      const sexVal = normalizeName(row[sexCol] || "");
      if (filters.sex === "female" && !/^f$|female|woman/.test(sexVal)) return false;
      if (filters.sex === "male" && !/^m$|male|man/.test(sexVal)) return false;
    }
    if (filters.participantId) {
      const participantCol = findSlpColumn(headers, ["SLP Participant ID", "SLP Paricipant ID", "Participant ID"]);
      if (!participantCol || normalizeName(row[participantCol] || "") !== normalizeName(filters.participantId)) return false;
    }
    if (filters.projectId) {
      const projectCol = findSlpColumn(headers, ["Project ID"]);
      if (!projectCol || normalizeName(row[projectCol] || "") !== normalizeName(filters.projectId)) return false;
    }
    if (filters.grantCode) {
      const grantCol = findSlpColumn(headers, ["Grant Code", "Grant ID", "Project Code"]);
      if (!grantCol || normalizeName(row[grantCol] || "") !== normalizeName(filters.grantCode)) return false;
    }
    if (filters.projectType) {
      const typeCol = findSlpColumn(headers, ["Enterprise Type", "Project Type", "Project Name", "Project Enterprise", "Type"]);
      if (!typeCol || !normalizeName(row[typeCol] || "").includes(normalizeName(filters.projectType))) return false;
    }
    // Status filter (operational/closed for monitoring; conducted/not conducted for training/orientation; served/not served for participants)
    if (filters.status) {
      const statusCol = findSlpColumn(headers, ["STATUS GUR", "Enterprise Status", "Livelihood Status", "Project Status", "Operational Status", "Monitoring Status", "Status", "Remarks"]) || findMatchingColumn(headers, "status") || headers.find(h => /status|remarks/i.test(h)) || "";
      if (statusCol) {
        const statusVal = normalizeName(row[statusCol] || "");
        if (filters.status === "operational") {
          if (!/operational|active|operating|implemented|completed/.test(statusVal)) return false;
        } else if (filters.status === "closed") {
          if (!/\b(closed|close|ceased|terminated|dissolved|not operational|not operating|non operational)\b/.test(statusVal)) return false;
        } else if (filters.status === "conducted") {
          // For training/orientation, presence in the module implies conducted — handled at matching stage
          // Here we only filter rows from the participant side, so no filter needed
        } else if (filters.status === "not conducted") {
          // Same as above — absence determines not conducted
        } else if (filters.status === "served") {
          const encodedCol = findMatchingColumn(headers, "encoded") || headers.find(h => /encoded/i.test(h)) || "";
          if (encodedCol) {
            const encVal = normalizeName(row[encodedCol] || "");
            if (!/encoded|yes|complete|done/.test(encVal)) return false;
          }
        } else if (filters.status === "not served") {
          const encodedCol = findMatchingColumn(headers, "encoded") || headers.find(h => /encoded/i.test(h)) || "";
          if (encodedCol) {
            const encVal = normalizeName(row[encodedCol] || "");
            if (/encoded|yes|complete|done/.test(encVal)) return false;
          }
        }
      }
    }
    return true;
  });
}

function typeKeywordsFor(dt: DocType): string[] {
  const map: Record<string, string[]> = { proposal: ["proposal", "proposed"], template: ["template", "form", "format", "sample"], guideline: ["guideline", "memo", "memorandum", "mc", "circular", "policy"], report: ["report", "summary", "accomplishment", "assessment"], spreadsheet: ["slpis", "slp dpt", "export", "data"], project_record: ["project", "enterprise", "livelihood", "hog"], participant_record: ["personal", "participant", "beneficiary"], financial_record: ["financial", "budget", "liquidation"], monitoring_record: ["monitoring", "mdmonitoring", "visit"], training_record: ["training", "orientation"], none: [], pdf: [], form: [], image: [] };
  return map[dt] || [];
}

function getCell(row: Record<string, string>, column: string) { return String(row[column] || "").trim(); }
function increment(map: Map<string, number>, key: string, amount = 1) { map.set(key, (map.get(key) || 0) + amount); }
function incrementEnterpriseProjectCount(map: Map<string, number>, rawName: string, amount = 1) {
  const canonical = normalizeEnterpriseProjectType(rawName || "Unspecified");
  increment(map, canonical.label, amount);
}
function topRows(map: Map<string, number>, maxRows = 8) { return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, maxRows).map(([k, v]) => [k, String(v)]); }
function markdownTable(headers: string[], rows: string[][]) {
  const clean = (value: string) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  return [`| ${headers.map(clean).join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map(r => `| ${r.map(clean).join(" | ")} |`)].join("\n");
}
function fuzzyValueMatches(value: string, term: string): boolean {
  const v = value.toLowerCase().replace(/\s+/g, " ").trim(), t = term.toLowerCase().replace(/\s+/g, " ").trim();
  if (!v || !t) return false; if (v.includes(t)) return true;
  const aliases: Record<string, string[]> = { fish: ["fish", "fishing", "fishery", "fisheries"], "fishing supply": ["fishing supply", "fishing supplies", "fishing equipment"], livelihood: ["livelihood", "enterprise", "project"], monitoring: ["monitoring", "monitor", "visit", "mdmonitoring"] };
  const a = aliases[t] || [t]; if (a.some(x => v.includes(x))) return true;
  const vt = v.split(" ").filter((s: string) => s.length > 2), tt = t.split(" ").filter((s: string) => s.length > 2);
  return tt.length > 0 && tt.every((x: string) => vt.some((y: string) => y.includes(x) || x.includes(y) || levenshtein(y, x) <= 1));
}

function sourceMatchesNamedTerms(sourceText: string, terms: string[]) {
  const normalized = normalizeName(sourceText);
  return terms.length > 0 && terms.some((term) => normalized.includes(term) || term.split(" ").filter(Boolean).every((part) => normalized.includes(part)));
}

function sourceHasRequiredFields(headers: string[], fields: string[]) {
  return fields.every((field) => {
    if (field === "participant identity") {
      const hasNameParts = Boolean(headers.find((header) => detectColumnRole(header) === "first_name")) && Boolean(headers.find((header) => detectColumnRole(header) === "last_name"));
      return Boolean(headers.find((header) => detectColumnRole(header) === "participant_id" || detectColumnRole(header) === "full_name") || hasNameParts);
    }
    return Boolean(findMatchingColumn(headers, field));
  });
}

function noUploadedSourceAnswer(parsed: ParsedQuery, checkedSources: string[] = [], note = "No uploaded/indexed source matched the question.") {
  return NO_RELEVANT_SOURCE_MESSAGE;
}

// Excel-style engine
interface JoinResult { matched: Array<{ left: Record<string, string>; right: Record<string, string> }>; unmatchedLeft: Array<Record<string, string>>; unmatchedRight: Array<Record<string, string>>; }
function xlookupMatch(leftRows: Array<Record<string, string>>, leftKeyCol: string, rightRows: Array<Record<string, string>>, rightKeyCol: string): JoinResult {
  const rightIndex = new Map<string, Record<string, string>>();
  for (const row of rightRows) { const key = normalizeName(getCell(row, rightKeyCol)); if (key && !rightIndex.has(key)) rightIndex.set(key, row); }
  const matched: JoinResult["matched"] = [], unmatchedLeft: JoinResult["unmatchedLeft"] = [];
  for (const leftRow of leftRows) { const key = normalizeName(getCell(leftRow, leftKeyCol)); const r = key ? rightIndex.get(key) : undefined; if (r) matched.push({ left: leftRow, right: r }); else unmatchedLeft.push(leftRow); }
  const unmatchedRight = rightRows.filter(r => { const key = normalizeName(getCell(r, rightKeyCol)); return key && !leftRows.some(l => normalizeName(getCell(l, leftKeyCol)) === key); });
  return { matched, unmatchedLeft, unmatchedRight };
}
function countIfs(rows: Array<Record<string, string>>, conditions: Array<{ column: string; value: string | RegExp; not?: boolean }>): number {
  return rows.filter(row => conditions.every(c => { const cell = getCell(row, c.column).toLowerCase(); return typeof c.value === "string" ? (c.not ? cell !== c.value.toLowerCase() : cell === c.value.toLowerCase()) : (c.not ? !c.value.test(cell) : c.value.test(cell)); })).length;
}
function sumIfs(rows: Array<Record<string, string>>, sumCol: string, conditions: Array<{ column: string; value: string | RegExp }>): number {
  return rows.reduce((s, row) => conditions.every(c => { const cell = getCell(row, c.column).toLowerCase(); return typeof c.value === "string" ? cell === c.value.toLowerCase() : c.value.test(cell); }) ? s + (Number(getCell(row, sumCol).replace(/[^0-9.-]/g, "")) || 0) : s, 0);
}
function distinctCount(rows: Array<Record<string, string>>, col: string): number { return new Set(rows.map(r => normalizeName(getCell(r, col))).filter(Boolean)).size; }
function getParticipantIdentityFromRow(row: Record<string, string>) {
  const headers = Object.keys(row).filter((header) => header !== "__rowNumber");
  const idCol = headers.find((header) => detectColumnRole(header) === "participant_id");
  if (idCol) {
    const value = normalizeName(getCell(row, idCol));
    if (value) return value;
  }
  const fullNameCol = headers.find((header) => detectColumnRole(header) === "full_name");
  if (fullNameCol) {
    const value = normalizeName(getCell(row, fullNameCol));
    if (value) return value;
  }
  return normalizeName(buildFullName(row, headers).fullName);
}
function uniqueBy(rows: Array<Record<string, string>>, keyCol: string): Array<Record<string, string>> { const s = new Set<string>(); return rows.filter(r => { const k = normalizeName(getCell(r, keyCol)); return k && !s.has(k) ? (s.add(k), true) : false; }); }
function filterRows(rows: Array<Record<string, string>>, column: string, value: string | RegExp): Array<Record<string, string>> { return rows.filter(r => typeof value === "string" ? getCell(r, column).toLowerCase() === value.toLowerCase() : value.test(getCell(r, column))); }
function pivotGroupBy(rows: Array<Record<string, string>>, rowField: string, colField: string, valueField: string, agg: "count" | "sum" = "count"): { headers: string[]; rows: string[][] } {
  const rv = [...new Set(rows.map(r => getCell(r, rowField)).filter(Boolean))], cv = [...new Set(rows.map(r => getCell(r, colField)).filter(Boolean))];
  const p = new Map<string, Map<string, number>>(); for (const v of rv) p.set(v, new Map());
  for (const row of rows) { const r = getCell(row, rowField), c = getCell(row, colField), vv = Number(getCell(row, valueField).replace(/[^0-9.-]/g, "")) || 1; if (!r || !c) continue; const m = p.get(r)!; m.set(c, (m.get(c) || 0) + (agg === "sum" ? vv : 1)); }
  return { headers: [rowField, ...cv, "Total"], rows: rv.map(r => { const m = p.get(r)!; return [r, ...cv.map(c => String(m.get(c) || 0)), String(Array.from(m.values()).reduce((s, v) => s + v, 0))]; }) };
}
function findMissingRecords(needle: Array<Record<string, string>>, haystack: Array<Record<string, string>>, keyCol: string): Array<Record<string, string>> {
  const keys = new Set(haystack.map(r => normalizeName(getCell(r, keyCol))).filter(Boolean));
  return needle.filter(r => { const k = normalizeName(getCell(r, keyCol)); return !k || (!keys.has(k) && !Array.from(keys).some(hk => levenshtein(hk, k) <= 2)); });
}

// Session store for follow-ups
interface SessionAnalysis { parsedQuery: ParsedQuery; filteredRows: Array<Record<string, string>>; headers: string[]; groupableColumns: string[]; computedResult: string; previousChartData?: any; }
const sessionStore = new Map<string, SessionAnalysis>();
const ANALYSIS_TTL = 30 * 60 * 1000;
function setSession(sid: string, data: SessionAnalysis) { sessionStore.set(sid, data); setTimeout(() => sessionStore.delete(sid), ANALYSIS_TTL); }

function composeChartFromPreviousResult(sessionId: string) {
  const previous = sessionStore.get(sessionId);
  const previousChart = previous?.previousChartData;
  const chartPayload = previousChart?.charts?.[0] || previousChart;
  if (!chartPayload || (!previousChart?.shouldChart && !previousChart?.charts?.length)) {
    return [
      "**Direct Answer**",
      "I do not have a previous numeric result that can be charted yet. Ask for a count, breakdown, ranking, or status result first.",
    ].join("\n");
  }
  const chart = chartPayload;
  return [
    "**Direct Answer**",
    `Here is a chart from the previous numeric result: ${chart.title}.`,
    "",
    "**Chart/Graph**",
    "```slp-chart",
    JSON.stringify({ charts: [{ type: chart.type || (chart.chartType === "horizontal_bar" ? "horizontalBar" : chart.chartType), title: chart.title, data: chart.data, note: chart.note || chart.insight }] }, null, 2),
    "```",
    "",
    "**Explanation**",
    "- Reused the previous computed SQLite/TypeScript result; no new numbers were guessed.",
  ].join("\n");
}

function rememberChartsFromAnswer(sessionId: string, message: string, parsed: ParsedQuery, answer: string) {
  const match = String(answer || "").match(/```slp-chart\s*([\s\S]*?)```/);
  if (!match) return;
  try {
    const payload = JSON.parse(match[1]);
    if (!payload?.charts?.length) return;
    setSession(sessionId, {
      parsedQuery: parsed,
      filteredRows: [],
      headers: [],
      groupableColumns: [],
      computedResult: message,
      previousChartData: payload,
    });
  } catch {}
}

// Chart engine
function chartDecisionEngine(parsed: ParsedQuery, data: Array<Record<string, string>>, headers: string[]): { shouldChart: boolean; chartType: ChartType; title: string; data: Array<Record<string, string | number>>; insight: string } {
  if (!data.length) return { shouldChart: false, chartType: "none", title: "", data: [], insight: "" };
  const numFields = headers.filter(h => /count|total|amount|budget|participants?|members?|cost|fund/i.test(h));
  const catFields = headers.filter(h => /municipality|barangay|status|type|sex|sector|year|project|slpa/i.test(h));
  const preferredCategory = parsed.groupBy.length ? (headers.find(h => normalizeName(h).includes(parsed.groupBy[0])) || catFields[0]) : catFields[0];
  const timeFields = headers.filter(h => /year|date|month|year served/i.test(h));
  let chartType: ChartType = "bar", title = "", insight = "";
  const needsTime = parsed.groupBy.includes("year") || timeFields.length > 0;
  const needsBreakdown = parsed.action === "show_breakdown" || parsed.groupBy.length > 0;
  if (needsBreakdown && preferredCategory && !needsTime) { chartType = "horizontal_bar"; title = `Breakdown by ${preferredCategory}`; insight = `${preferredCategory} with highest values shown at top.`; }
  else if (needsTime && data.length >= 3) { chartType = "line"; title = "Trend over time"; insight = "Trend shows progression across time periods."; }
  else if (parsed.filterBy.status && catFields.length > 0) { chartType = "stacked_bar"; title = `Status by ${catFields[0]}`; insight = "Stacked bars show distribution across categories."; }
  else if (catFields.length && numFields.length && [...new Set(data.map(r => getCell(r, catFields[0]))).values()].length <= 6) { chartType = "pie"; title = "Distribution"; insight = "Part-to-whole comparison across categories."; }
  else { chartType = "bar"; title = "Data overview"; insight = "Bar chart comparing categories."; }

  let chartData: Array<Record<string, string | number>> = [];
  if (preferredCategory && numFields.length) {
    const g = new Map<string, number>();
    for (const row of data) { const k = getCell(row, preferredCategory) || "Unspecified"; const v = Number(getCell(row, numFields[0]).replace(/[^0-9.-]/g, "")) || 1; g.set(k, (g.get(k) || 0) + v); }
    chartData = Array.from(g.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, v]) => ({ name: n, value: v }));
  }
  const usefulForIntent = parsed.needsChart || ["count", "chart", "analyze dataset", "show_breakdown"].includes(parsed.intentType) || parsed.action === "create_chart" || (data.length >= 5 && (catFields.length > 0 || numFields.length > 0));
  return { shouldChart: usefulForIntent && chartData.length >= 2, chartType, title, data: chartData, insight };
}

function detectHeaderRow(aoa: any[][]): { index: number; confidence: number; headers: string[] } {
  const maxScan = Math.min(20, aoa.length);
  let best = { index: 0, confidence: 0, headers: [] as string[] };
  const roleWords = /name|first|last|middle|surname|municipality|barangay|status|project|enterprise|amount|grant|education|date|year|sex|gender|participant|beneficiary|slpa|code/i;
  for (let index = 0; index < maxScan; index++) {
    const raw = aoa[index] || [];
    const cells = raw.map((cell) => String(cell ?? "").trim());
    const nonBlank = cells.filter(Boolean);
    if (nonBlank.length < 2) continue;
    const unique = new Set(nonBlank.map(normalizeColumnName)).size;
    const textLike = nonBlank.filter((cell) => /[a-z]/i.test(cell) && !/^\d+(\.\d+)?$/.test(cell)).length;
    const roleHits = nonBlank.filter((cell) => roleWords.test(cell)).length;
    const nextRows = aoa.slice(index + 1, Math.min(index + 6, aoa.length));
    const dataBelow = nextRows.filter((row) => row?.some((cell: any) => String(cell ?? "").trim())).length;
    const score = unique * 2 + textLike * 2 + roleHits * 4 + dataBelow - Math.max(0, nonBlank.length - unique) * 2;
    if (score > best.confidence) {
      const headers = cells.map((cell, colIndex) => String(cell || `Column ${colIndex + 1}`).trim());
      best = { index, confidence: score, headers };
    }
  }
  return best.headers.length ? best : { index: 0, confidence: 1, headers: (aoa[0] || []).map((cell, i) => String(cell || `Column ${i + 1}`).trim()) };
}

function rowsFromAoa(aoa: any[][], headerInfo = detectHeaderRow(aoa)) {
  const headers = headerInfo.headers.map((header, index) => String(header || `Column ${index + 1}`).trim());
  const rows = aoa.slice(headerInfo.index + 1).map((row, offset) => {
    const obj: Record<string, string> = { __rowNumber: String(headerInfo.index + offset + 2) };
    headers.forEach((header, index) => { obj[header] = String(row?.[index] ?? "").trim(); });
    return obj;
  }).filter((row) => headers.some((header) => row[header]));
  return { headers, rows, headerRowIndex: headerInfo.index, headerConfidence: headerInfo.confidence };
}

function requiresSecondRowHeaders(input: { fileName?: string; folder?: string; sheetName?: string; file_type?: string } = {}) {
  const label = normalizeName([input.folder, input.fileName, input.sheetName, input.file_type].filter(Boolean).join(" "));
  return /md\s*monitoring association|mdmonitoring association|md\s*monitoring individual|mdmonitoring individual|org\s*assessment|orgassessment|organizational assessment|organisation assessment|md\s*annual\s*assessment|mdannualassessment|annual assessment/.test(label);
}

function rowHeaderNames(row: any[] = []) {
  return row.map((cell) => normalizeColumnName(String(cell ?? "")));
}

function hasConfirmedMonitoringHeaders(row: any[] = []) {
  const headers = rowHeaderNames(row);
  const has = (name: string) => headers.includes(normalizeColumnName(name));
  return Boolean(
    has("Municipality") &&
      has("Barangay") &&
      (has("Project ID") || has("SLP Paricipant ID")) &&
      (has("Visit") || has("Assessment Visit")),
  );
}

function fixedHeaderInfo(aoa: any[][], index: number): { index: number; confidence: number; headers: string[] } {
  const row = aoa[index] || [];
  return {
    index,
    confidence: 100,
    headers: row.map((cell, index) => String(cell || `Column ${index + 1}`).trim()),
  };
}

function monitoringHeaderInfo(aoa: any[][]): { index: number; confidence: number; headers: string[] } {
  if (aoa.length > 1 && hasConfirmedMonitoringHeaders(aoa[1] || [])) return fixedHeaderInfo(aoa, 1);
  if (hasConfirmedMonitoringHeaders(aoa[0] || [])) return fixedHeaderInfo(aoa, 0);
  return detectHeaderRow(aoa);
}

function buildSearchableRowText(row: Record<string, string>, headers: string[]) {
  return normalizeName(headers.map((header) => `${normalizeColumnName(header)} ${String(row[header] || "")}`).join(" "));
}

let sheetRowSearchTextBackfilled = false;
function backfillSheetRowSearchText() {
  if (sheetRowSearchTextBackfilled) return;
  sheetRowSearchTextBackfilled = true;
  try {
    const blanks = db.prepare(`
      SELECT sr.id, sr.row_json, us.headers_json
      FROM sheet_rows sr
      JOIN uploaded_sheets us ON us.id = sr.sheet_id
      WHERE sr.row_text IS NULL OR sr.row_text = ''
      LIMIT 50000
    `).all();
    const update = db.prepare("UPDATE sheet_rows SET row_text = ? WHERE id = ?");
    const updateMany = db.transaction((rows: any[]) => {
      for (const item of rows) {
        const row = JSON.parse(item.row_json || "{}");
        const headers = JSON.parse(item.headers_json || "[]");
        update.run(buildSearchableRowText(row, headers), item.id);
      }
    });
    if (blanks.length) updateMany(blanks);
  } catch (error) {
    console.error("Sheet row search text backfill failed:", error);
  }
}

// Parse XLSX stored as JSON in content_text
function parseXlsxContent(content: string, context: { fileName?: string; folder?: string; file_type?: string } = {}): Array<{ sheetName: string; headers: string[]; rows: Array<Record<string, string>>; headerRowIndex: number; headerConfidence: number }> {
  try {
    const parsed = JSON.parse(content);
    if (!parsed.__slpWorkbook && !Array.isArray(parsed)) return [];
    const sheets = parsed.__slpWorkbook ? parsed.sheets || [] : [{ name: "Sheet1", rows: parsed }];
    return sheets.map((sheet: any) => {
      const aoa: any[][] = (sheet.rows || []).filter((r: any[]) => r.some((c: any) => c !== ""));
      if (!aoa.length) return { sheetName: sheet.name || "Unknown", headers: [], rows: [], headerRowIndex: 0, headerConfidence: 0 };
      const sheetName = sheet.name || "Unknown";
      const headerInfo = requiresSecondRowHeaders({ ...context, sheetName })
        ? monitoringHeaderInfo(aoa)
        : detectHeaderRow(aoa);
      return { sheetName, ...rowsFromAoa(aoa, headerInfo) };
    });
  } catch { return []; }
}

function detectColumnRole(header: string) {
  const h = normalizeColumnName(header);
  if (/^(first|given)( name)?$|given name|first name/.test(h)) return "first_name";
  if (/middle name|middle initial|middle init|^mi$/.test(h)) return "middle_name";
  if (/last name|surname|family name/.test(h)) return "last_name";
  if (/extension|name extension|^ext$|ext name/.test(h)) return "extension";
  if (/full name|complete name|participant name|beneficiary name|client name|^name$/.test(h)) return "full_name";
  if (/municipality|city/.test(h)) return "municipality";
  if (/barangay|brgy/.test(h)) return "barangay";
  if (/status|operational|closed/.test(h)) return "status";
  if (/education|educational/.test(h)) return "education";
  if (/amount|budget|fund|cost|allocation/.test(h)) return "amount";
  if (/grant.*code|grant.*id/.test(h)) return "grant_code";
  if (/^(slp )?par?ticipant id$|par?ticipant.*id|beneficiary.*id|client.*id/.test(h)) return "participant_id";
  if (/association|group name|organization|organisation/.test(h)) return "association";
  if (/project|enterprise|livelihood/.test(h)) return "project";
  return "";
}

function clearDocumentSheetIndex(documentId: string) {
  const fileRows = db.prepare("SELECT id FROM uploaded_files WHERE document_id = ?").all(documentId);
  const fileIds = fileRows.map((row: any) => row.id);
  if (!fileIds.length) return;
  const sheetRows = db.prepare(`SELECT id FROM uploaded_sheets WHERE file_id IN (${fileIds.map(() => "?").join(",")})`).all(...fileIds);
  const sheetIds = sheetRows.map((row: any) => row.id);
  if (sheetIds.length) {
    db.prepare(`DELETE FROM sheet_columns WHERE sheet_id IN (${sheetIds.map(() => "?").join(",")})`).run(...sheetIds);
    db.prepare(`DELETE FROM sheet_rows WHERE sheet_id IN (${sheetIds.map(() => "?").join(",")})`).run(...sheetIds);
  }
  db.prepare(`DELETE FROM uploaded_sheets WHERE file_id IN (${fileIds.map(() => "?").join(",")})`).run(...fileIds);
  db.prepare("DELETE FROM uploaded_files WHERE document_id = ?").run(documentId);
}

function indexWorkbookDocument(doc: any) {
  const sheets = parseXlsxContent(doc.content_text || "", { fileName: doc.file_name, folder: doc.folder, file_type: doc.file_type });
  if (!sheets.length) return;
  clearDocumentSheetIndex(doc.id);
  const now = new Date().toISOString();
  const fileId = randomId("file");
  db.prepare("INSERT INTO uploaded_files (id, document_id, file_name, folder, file_type, file_size, file_hash, uploaded_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(fileId, doc.id, doc.file_name, doc.folder || "", doc.file_type || "", doc.file_size || 0, crypto.createHash("sha1").update(doc.content_text || "").digest("hex"), now, now);
  for (const sheet of sheets) {
    const sheetId = randomId("sheet");
    const detected: Record<string, string> = {};
    sheet.headers.forEach((header) => { const role = detectColumnRole(header); if (role && !detected[role]) detected[role] = header; });
    db.prepare("INSERT INTO uploaded_sheets (id, file_id, document_id, sheet_name, row_count, header_row_index, header_confidence, headers_json, normalized_headers_json, detected_columns_json, sample_rows_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sheetId, fileId, doc.id, sheet.sheetName, sheet.rows.length, sheet.headerRowIndex, sheet.headerConfidence, JSON.stringify(sheet.headers), JSON.stringify(sheet.headers.map(normalizeColumnName)), JSON.stringify(detected), JSON.stringify(sheet.rows.slice(0, 5)), now, now);
    for (const header of sheet.headers) {
      const samples = sheet.rows.map((row) => row[header]).filter(Boolean).slice(0, 8);
      db.prepare("INSERT INTO sheet_columns (id, sheet_id, column_name, normalized_name, detected_role, sample_values_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomId("col"), sheetId, header, normalizeColumnName(header), detectColumnRole(header), JSON.stringify(samples));
    }
    for (const row of sheet.rows) {
      const rowHash = crypto.createHash("sha1").update(JSON.stringify(row)).digest("hex");
      db.prepare("INSERT INTO sheet_rows (id, sheet_id, file_id, row_index, row_hash, row_json, row_text) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(randomId("row"), sheetId, fileId, Number(row.__rowNumber || 0), rowHash, JSON.stringify(row), buildSearchableRowText(row, sheet.headers));
    }
    console.log(`[CSV_SQLITE_TABLE_CREATED] ${JSON.stringify({
      fileName: doc.file_name,
      sheetName: sheet.sheetName,
      sourceType: sourceTypeForFolder(doc.folder || "", doc.file_name || "", doc.file_type || ""),
      sqliteTables: ["uploaded_sheets", "sheet_rows", "sheet_columns"],
      rowCount: sheet.rows.length,
      detectedColumns: detected,
      columns: sheet.headers,
    })}`);
  }
}

function loadSheetSources(options: { attachmentIds?: string[]; includeChatAttachments?: boolean } = {}) {
  backfillSheetRowSearchText();
  const params: any[] = [];
  const where: string[] = [];
  if (options.attachmentIds?.length) {
    where.push(`d.id IN (${options.attachmentIds.map(() => "?").join(",")})`);
    params.push(...options.attachmentIds);
  } else if (!options.includeChatAttachments) {
    where.push("(d.chat_attachment = 0 OR d.chat_attachment IS NULL)");
  }
  const sql = `
    SELECT d.id AS document_id, d.file_name, d.folder, d.chat_attachment,
           m.original_file_name, m.source_type, m.document_type, m.document_purpose, m.classification_reason,
           uf.id AS file_id, us.id AS sheet_id, us.sheet_name, us.headers_json,
           us.header_row_index, us.header_confidence, sr.row_index, sr.row_json, sr.row_text
    FROM sheet_rows sr
    JOIN uploaded_sheets us ON us.id = sr.sheet_id
    JOIN uploaded_files uf ON uf.id = sr.file_id
    JOIN documents d ON d.id = us.document_id
    LEFT JOIN original_file_metadata m ON m.document_id = d.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY d.created_at DESC, us.sheet_name ASC, sr.row_index ASC`;
  const rows = db.prepare(sql).all(...params);
  const grouped = new Map<string, { documentId: string; fileName: string; originalFileName: string; folder: string; sheetName: string; headers: string[]; rows: Array<Record<string, string>>; headerRowIndex: number; headerConfidence: number; classificationText: string }>();
  for (const row of rows) {
    const key = row.sheet_id;
    if (!grouped.has(key)) grouped.set(key, {
      documentId: row.document_id,
      fileName: row.file_name,
      originalFileName: row.original_file_name || "",
      folder: row.folder || "",
      sheetName: row.sheet_name,
      headers: JSON.parse(row.headers_json || "[]"),
      rows: [],
      headerRowIndex: row.header_row_index || 0,
      headerConfidence: row.header_confidence || 0,
      classificationText: [row.source_type, row.document_type, row.document_purpose, row.classification_reason].filter(Boolean).join(" "),
    });
    const parsed = JSON.parse(row.row_json || "{}");
    parsed.__rowNumber = String(row.row_index || parsed.__rowNumber || "");
    parsed.__rowText = row.row_text || "";
    grouped.get(key)!.rows.push(parsed);
  }
  return Array.from(grouped.values()).map((source) => ({
    source: `${source.folder || "Unknown"}/${source.fileName} / ${source.sheetName}`,
    ...source,
  }));
}

function loadDashboardSheetSources() {
  const indexedSources = loadSheetSources({ includeChatAttachments: true }) as any[];
  const indexedDocumentIds = new Set(indexedSources.map((source: any) => source.documentId).filter(Boolean));
  const fallbackDocs = db.prepare("SELECT id, file_name, folder, content_text FROM documents WHERE content_text LIKE '%__slpWorkbook%' ORDER BY created_at DESC").all();
  const fallbackSources: any[] = [];

  for (const doc of fallbackDocs as any[]) {
    if (indexedDocumentIds.has(doc.id)) continue;
    const sheets = parseXlsxContent(doc.content_text || "", { fileName: doc.file_name, folder: doc.folder });
    for (const sheet of sheets) {
      fallbackSources.push({
        source: `${doc.folder || "Unknown"}/${doc.file_name} / ${sheet.sheetName}`,
        fileName: doc.file_name,
        folder: doc.folder || "",
        sheetName: sheet.sheetName,
        headers: sheet.headers,
        rows: sheet.rows,
        headerRowIndex: sheet.headerRowIndex,
        headerConfidence: sheet.headerConfidence,
        documentId: doc.id,
        sourceFile: doc.file_name,
      });
    }
  }

  return [...indexedSources, ...fallbackSources];
}

type SlpModuleTag =
  | "PERSONAL"
  | "PROJECT"
  | "TRAINING"
  | "GRANT_UTILIZATION"
  | "SLPA"
  | "ORIENTATION"
  | "MDMONITORING_INDIVIDUAL"
  | "MDMONITORING_ASSOCIATION"
  | "GUIDELINES_MC03"
  | "SLP_DPT_DATABASE"
  | "UNKNOWN";

const SLP_MODULE_LABELS: Record<SlpModuleTag, string> = {
  PERSONAL: "Personal Module",
  PROJECT: "Project Module",
  TRAINING: "Training Module",
  GRANT_UTILIZATION: "Grant Utilization Report Module",
  SLPA: "SLPA Module",
  ORIENTATION: "Orientation Module",
  MDMONITORING_INDIVIDUAL: "MDMonitoring Individual",
  MDMONITORING_ASSOCIATION: "MDMonitoring Association",
  GUIDELINES_MC03: "MC 03 Guidelines",
  SLP_DPT_DATABASE: "SLP Aurora Database",
  UNKNOWN: "Unknown",
};

const SLP_ALL_DRILLDOWN_MODULES: SlpModuleTag[] = ["PERSONAL", "PROJECT", "MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION", "TRAINING", "GRANT_UTILIZATION", "SLPA", "ORIENTATION"];

function slpSourceText(source: any) {
  const samples = (source.rows || []).slice(0, 5).map((row: any) => row.__rowText || Object.values(row || {}).map(String).join(" ")).join(" ");
  return normalizeName(`${source.folder || ""} ${source.fileName || source.file_name || ""} ${source.sheetName || source.sheet_name || ""} ${(source.headers || []).join(" ")} ${samples} ${String(source.content_text || "").slice(0, 2000)}`);
}

function detectSlpModule(source: any): SlpModuleTag {
  const nameText = normalizeName(`${source.folder || ""} ${source.fileName || source.file_name || ""} ${source.sheetName || source.sheet_name || ""}`);
  const text = slpSourceText(source);
  const has = (pattern: RegExp) => pattern.test(text);
  const nameHas = (pattern: RegExp) => pattern.test(nameText);
  if (nameHas(/\bpersonal module\b/)) return "PERSONAL";
  if (nameHas(/\bproject module\b/)) return "PROJECT";
  if (nameHas(/\btraining module\b/)) return "TRAINING";
  if (nameHas(/grant utilization/)) return "GRANT_UTILIZATION";
  if (nameHas(/orientation module/)) return "ORIENTATION";
  if (nameHas(/slp association|slpa module|association module/) && !nameHas(/md\s*monitoring|mdmonitoring/)) return "SLPA";
  if (nameHas(/md\s*monitoring individual|mdmonitoring individual/)) return "MDMONITORING_INDIVIDUAL";
  if (nameHas(/md\s*monitoring association|mdmonitoring association/)) return "MDMONITORING_ASSOCIATION";
  if (has(/\bmc\s*03\b|guidelines?|memorandum circular|policy|rules/)) return "GUIDELINES_MC03";
  if (has(/\bslp\s*dpt\b|aurora database|slp aurora database/)) return "SLP_DPT_DATABASE";
  if (has(/md\s*monitoring|mdmonitoring/)) {
    if (has(/association enterprise|slpa name|association module/)) return "MDMONITORING_ASSOCIATION";
    if (has(/individual enterprise|paricipant|participant/)) return "MDMONITORING_INDIVIDUAL";
  }
  if (has(/grant utilization|lddap|cheque number|total grant received|grant utilization report/)) return "GRANT_UTILIZATION";
  if (has(/\btraining\b|training code|training title|training batch/)) return "TRAINING";
  if (has(/orientation code|orientation date|assembly/)) return "ORIENTATION";
  if (has(/slp association|slpa code|date organized|with coe|with coa|member designation/)) return "SLPA";
  if (has(/personal module|slp household|pcn|birthday|civil status|type of participant|year served/) && !has(/project id.*enterprise type/)) return "PERSONAL";
  if (has(/project module|project id|enterprise type|participant count|member count|grant component|project enterprise/)) return "PROJECT";
  return "UNKNOWN";
}

function loadSlpModuleSources(options: { attachmentIds?: string[]; includeChatAttachments?: boolean } = {}) {
  return loadSheetSources({ attachmentIds: options.attachmentIds, includeChatAttachments: options.includeChatAttachments }).map((source: any) => ({
    ...source,
    module: detectSlpModule(source),
  }));
}

function findSlpColumn(headers: string[], aliases: string[]) {
  const normalizedAliases = aliases.map(normalizeColumnName);
  return headers.find((header) => normalizedAliases.includes(normalizeColumnName(header)))
    || headers.find((header) => {
      const h = normalizeColumnName(header);
      return normalizedAliases.some((alias) => h.includes(alias) || alias.includes(h));
    })
    || "";
}

type DynamicSchemaColumn = { name: string; type: string; sampleValues: string[] };
type DynamicSchemaTable = {
  tableName: string;
  physicalTableName?: string;
  module?: SlpModuleTag;
  sourceFile?: string;
  sheetName?: string;
  columns: DynamicSchemaColumn[];
  rowCount: number;
};

let dynamicSchemaCache: { updatedAt: number; registry: DynamicSchemaTable[] } = { updatedAt: 0, registry: [] };

function uniqueSamples(values: any[], limit = 5) {
  const seen = new Set<string>();
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text.slice(0, 80));
    if (seen.size >= limit) break;
  }
  return Array.from(seen);
}

function inspectDynamicSchema(force = false): DynamicSchemaTable[] {
  const now = Date.now();
  if (!force && dynamicSchemaCache.registry.length && now - dynamicSchemaCache.updatedAt < 30000) return dynamicSchemaCache.registry;
  const registry: DynamicSchemaTable[] = [];
  try {
    const physicalTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[];
    for (const table of physicalTables) {
      const tableName = String(table.name || "");
      const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all() as any[];
      const rowCount = (db.prepare(`SELECT COUNT(*) AS count FROM "${tableName.replace(/"/g, '""')}"`).get() as any)?.count || 0;
      const sampleRows = rowCount ? db.prepare(`SELECT * FROM "${tableName.replace(/"/g, '""')}" LIMIT 5`).all() as any[] : [];
      registry.push({
        tableName,
        physicalTableName: tableName,
        columns: columns.map((col: any) => ({
          name: String(col.name || ""),
          type: String(col.type || ""),
          sampleValues: uniqueSamples(sampleRows.map((row: any) => row[col.name])),
        })),
        rowCount: Number(rowCount || 0),
      });
    }
  } catch (error: any) {
    console.warn("Dynamic physical schema inspection failed:", error.message || error);
  }
  try {
    for (const source of loadSlpModuleSources({ includeChatAttachments: true })) {
      const headers = (source.headers || []).filter((header: string) => header && !String(header).startsWith("__"));
      registry.push({
        tableName: sourceDisplayName(source),
        module: source.module,
        sourceFile: source.fileName || source.sourceFile || "",
        sheetName: source.sheetName || "",
        rowCount: Number((source.rows || []).length),
        columns: headers.map((header: string) => ({
          name: header,
          type: inferColumnType((source.rows || []).slice(0, 20).map((row: any) => row[header])),
          sampleValues: uniqueSamples((source.rows || []).map((row: any) => row[header])),
        })),
      });
    }
  } catch (error: any) {
    console.warn("Dynamic sheet schema inspection failed:", error.message || error);
  }
  dynamicSchemaCache = { updatedAt: now, registry };
  console.log(`[SCHEMA_INSPECTED] ${JSON.stringify({
    tableCount: registry.length,
    tables: registry.slice(0, 20).map((table) => ({ tableName: table.tableName, rowCount: table.rowCount, columns: table.columns.map((col) => col.name).slice(0, 20) })),
  })}`);
  return registry;
}

function inferColumnType(values: any[]) {
  const filled = values.map((value) => String(value ?? "").trim()).filter(Boolean);
  if (!filled.length) return "TEXT";
  if (filled.every((value) => /^-?\d+(?:\.\d+)?$/.test(value.replace(/,/g, "")))) return "NUMERIC";
  if (filled.some((value) => /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\b20\d{2}\b/.test(value))) return "DATE";
  return "TEXT";
}

function bestColumnForConcept(headers: string[], concept: string, aliases: string[] = []) {
  const candidates = [concept, ...aliases].map(String).filter(Boolean);
  const exact = findSlpColumn(headers, candidates);
  if (exact) return exact;
  const normalizedConcepts = candidates.map(normalizeColumnName).filter(Boolean);
  let best = { header: "", score: 0 };
  for (const header of headers) {
    const normalizedHeader = normalizeColumnName(header);
    for (const target of normalizedConcepts) {
      const distance = levenshtein(normalizedHeader, target);
      const semanticHints =
        /municipality|city|town|lgu/.test(target) && /municipality|city|town|lgu/.test(normalizedHeader) ? 35 :
        /barangay|brgy/.test(target) && /barangay|brgy/.test(normalizedHeader) ? 35 :
        /email/.test(target) && /email|e mail|mail/.test(normalizedHeader) ? 35 :
        /date|year|created|birthday|served/.test(target) && /date|year|created|birthday|served/.test(normalizedHeader) ? 35 :
        /participant|beneficiary|client|member/.test(target) && /participant|beneficiary|client|member|name|id/.test(normalizedHeader) ? 25 :
        0;
      const score = similarityScore(normalizedHeader, target) + semanticHints - Math.max(0, distance - 2) * 4;
      if (score > best.score) best = { header, score };
    }
  }
  if (best.header && (best.score >= 80 || normalizedConcepts.some((target) => levenshtein(normalizeColumnName(best.header), target) < 3))) {
    console.log(`[FUZZY_NAME_CORRECTED] ${JSON.stringify({ requested: concept, corrected: best.header, score: Math.round(best.score) })}`);
    return best.header;
  }
  return "";
}

function bestDateColumn(headers: string[]) {
  return bestColumnForConcept(headers, "date", ["Orientation Date", "Training Date", "Date Conducted", "Created Date", "Year Served", "Birthday", "Implementation Date", "Visit Date", "Year"])
    || headers.find((header) => /\b(date|year|created|birthday|served)\b/i.test(header))
    || "";
}

function sourceKeyColumns(source: any) {
  const headers = source.headers || [];
  return [
    findSlpColumn(headers, ["Project ID"]),
    findSlpColumn(headers, ["Grant Code"]),
    findSlpColumn(headers, ["SLP Participant ID", "SLP Paricipant ID", "Participant ID"]),
    findSlpColumn(headers, ["Full Name", "Name", "Member"]),
    findSlpColumn(headers, ["Municipality"]),
    findSlpColumn(headers, ["Barangay"]),
    findSlpColumn(headers, ["Enterprise Status", "Project Status", "Status"]),
  ].filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index);
}

function sourcesForModules(sources: any[], modules: SlpModuleTag[]) {
  return sources.filter((source) => {
    if (!modules.includes(source.module)) return false;
    const folder = normalizeName(source.folder || "");
    if (folder === "templates" && !modules.includes("GUIDELINES_MC03")) return false;
    return true;
  });
}

function knownColumnValues(modules: SlpModuleTag[], aliases: string[]) {
  const values = new Set<string>();
  for (const source of sourcesForModules(loadSlpModuleSources(), modules)) {
    const headers = source.headers || [];
    const column = findSlpColumn(headers, aliases);
    if (!column) continue;
    for (const row of source.rows || []) {
      const raw = getCell(row, column);
      const normalized = normalizeName(raw);
      if (normalized.length >= 3) values.add(raw.trim());
    }
  }
  return Array.from(values);
}

function findKnownBarangayFilter(message: string) {
  const lower = normalizeName(message);
  if (!/\b(barangay|brgy)\b/.test(lower)) return "";
  const values = knownColumnValues(SLP_ALL_DRILLDOWN_MODULES, ["Barangay", "Brgy"]);
  return values
    .filter((value) => lower.includes(normalizeName(value)))
    .sort((a, b) => normalizeName(b).length - normalizeName(a).length)[0] || "";
}

function projectTypeFilterExists(value: string) {
  const normalized = normalizeName(value);
  if (!normalized) return false;
  return knownColumnValues(["PROJECT"], ["Enterprise Type", "Project Type", "Project Name", "Project Enterprise", "Type"])
    .some((candidate) => {
      const c = normalizeName(candidate);
      return c === normalized || c.includes(normalized) || normalized.includes(c);
    });
}

function findKnownProjectTypeFilter(message: string) {
  const lower = normalizeName(message);
  if (!/\b(project|enterprise|livelihood|type|kind|category)\b/.test(lower)) return "";
  const blocked = new Set(["project", "projects", "enterprise", "enterprises", "livelihood", "closed", "close", "operational", "active", "barangay", "municipality"]);
  return knownColumnValues(["PROJECT"], ["Enterprise Type", "Project Type", "Project Name", "Project Enterprise", "Type"])
    .filter((value) => {
      const normalized = normalizeName(value);
      if (!normalized || blocked.has(normalized)) return false;
      return lower.includes(normalized);
    })
    .sort((a, b) => normalizeName(b).length - normalizeName(a).length)[0] || "";
}

function slpRows(sources: any[]) {
  return sources.flatMap((source) => (source.rows || []).map((row: any) => ({ row, source })));
}

function sourceDisplayName(source: any) {
  return [source.folder, source.fileName || source.file_name, source.sheetName || source.sheet_name].filter(Boolean).join(" / ") || source.source || "Indexed source";
}

function selectedColumnsForSources(sources: any[]) {
  return Array.from(new Set(sources.flatMap((source: any) => sourceKeyColumns(source))));
}

function slpValue(row: Record<string, string>, headers: string[], aliases: string[]) {
  const column = findSlpColumn(headers, aliases);
  return column ? getCell(row, column) : "";
}

const PROJECT_NAME_OR_TYPE_ALIASES = [
  "Name",
  "Project Name",
  "Name of Project",
  "Project Title",
  "Enterprise Name",
  "Enterprise / Project Type",
  "Project Type",
  "Type of Project",
  "Livelihood Project",
  "Livelihood Activity",
  "Business Type",
  "Enterprise",
];

function firstValidProjectDisplayValue(row: Record<string, string>, headers: string[], aliases: string[]) {
  for (const alias of aliases) {
    const value = slpValue(row, headers, [alias]);
    if (!value) continue;
    const label = normalizeEnterpriseProjectType(value).label;
    if (/^(Individual Enterprise|Association Enterprise)$/i.test(label)) continue;
    return label;
  }
  return "";
}

function getProjectDisplayName(row: Record<string, string>, headers: string[], sourceType: SlpModuleTag = "PROJECT") {
  if (sourceType === "PROJECT") {
    const exactName = firstValidProjectDisplayValue(row, headers, ["Name"]);
    if (exactName) return exactName;
    return firstValidProjectDisplayValue(row, headers, PROJECT_NAME_OR_TYPE_ALIASES.filter((alias) => alias !== "Enterprise Type")) || "Unspecified Project Name";
  }
  if (sourceType === "GRANT_UTILIZATION") {
    const projectName = firstValidProjectDisplayValue(row, headers, ["Project Name"]);
    if (projectName) return projectName;
    return firstValidProjectDisplayValue(row, headers, PROJECT_NAME_OR_TYPE_ALIASES.filter((alias) => alias !== "Enterprise Type")) || "Unspecified Project Name";
  }
  return firstValidProjectDisplayValue(row, headers, PROJECT_NAME_OR_TYPE_ALIASES.filter((alias) => alias !== "Enterprise Type")) || "Unspecified Project Name";
}

function getProjectNameOrType(row: Record<string, string>, headers: string[]) {
  return getProjectDisplayName(row, headers, "PROJECT");
}

function slpFullName(row: Record<string, string>, headers: string[]) {
  const built = buildFullName(row, headers);
  if (built.fullName) return built.fullName;
  const name = slpValue(row, headers, ["Name", "Full Name", "Member"]);
  return standardizeNameParts(name);
}

function slpParticipantKey(row: Record<string, string>, headers: string[]) {
  const id = slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]);
  if (id) return `id:${normalizeName(id)}`;
  const fullName = slpFullName(row, headers);
  if (fullName.split(" ").filter(Boolean).length < 2) return "";
  const municipality = slpValue(row, headers, ["Municipality"]);
  const barangay = slpValue(row, headers, ["Barangay", "Brgy"]);
  return `name:${normalizeName([fullName, municipality, barangay].join("|"))}`;
}

function slpProjectKey(row: Record<string, string>, headers: string[]) {
  const projectId = slpValue(row, headers, ["Project ID"]);
  if (projectId) return `project:${normalizeName(projectId)}`;
  const grant = slpValue(row, headers, ["Grant Code"]);
  if (grant) return `grant:${normalizeName(grant)}`;
  const name = getProjectNameOrType(row, headers);
  const municipality = slpValue(row, headers, ["Municipality"]);
  return name ? `name:${normalizeName([name, municipality].join("|"))}` : "";
}

function slpProjectName(row: Record<string, string>, headers: string[]) {
  return getProjectNameOrType(row, headers);
}

function slpMunicipality(row: Record<string, string>, headers: string[]) {
  return normalizeMunicipalityName(slpValue(row, headers, ["Municipality", "City", "Mun"]));
}

type DeterministicLookup = {
  answer: string;
  debug: {
    intent: string;
    filters: Record<string, any>;
    selectedModules: SlpModuleTag[];
    selectedColumns: string[];
    selectedSource: string;
    matchedRows: number;
    answerType: string;
  };
};

function extractStructuredLookupTerms(message: string) {
  const projectId = message.match(/\bPR-\d{4}-[A-Za-z0-9-]+\b/i)?.[0] || "";
  const participantId = message.match(/\b(?:SLP[-\s]*)?(?:Participant\s*)?ID[:\s#-]*([A-Z0-9-]{6,})\b/i)?.[1] || "";
  const grantCode = message.match(/\b(?:grant\s*(?:code|id)?|gur\s*code)[:\s#-]*([A-Z0-9][A-Z0-9-]{4,})\b/i)?.[1] || "";
  let name = "";
  const namePatterns = [
    /\b(?:person|participant|beneficiary|client|name)\s+(?:named|called|is|of|for)?\s*([A-Za-zÑñ.,'\-\s]{5,80})(?:\?|$|,|\bgrant|\bproject|\bserved|\bin\b|\bfrom\b)/i,
    /\b(?:grant code|project|training|status|record|lookup|find|search|is served|served)\s+(?:of|for|by)?\s*([A-Za-zÑñ.,'\-\s]{5,80})(?:\?|$|,|\bin\b|\bfrom\b)/i,
  ];
  for (const pattern of namePatterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      const candidate = standardizeNameParts(match[1]);
      if (looksLikePersonNameCandidate(candidate)) {
        name = candidate;
        break;
      }
    }
  }
  if (!name && !projectId && !participantId && !grantCode) {
    const stripped = message
      .replace(/\b(what|is|are|was|were|the|a|an|of|for|can|you|please|show|find|search|lookup|participant|beneficiary|person|client|record|grant|code|project|training|status|served|in|from|municipality|year|how|many|count|total|copy|download|template|guideline|guidelines|mc|03|slp)\b/gi, " ")
      .replace(/\b20\d{2}\b/g, " ")
      .replace(new RegExp(AURORA_MUNICIPALITIES.join("|"), "gi"), " ");
    const candidate = standardizeNameParts(stripped);
    if (candidate.length <= 80 && looksLikePersonNameCandidate(candidate)) name = candidate;
  }
  return { projectId, participantId, grantCode, name };
}

function looksLikePersonNameCandidate(candidate: string) {
  const normalized = normalizeName(candidate);
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;
  if (tokens.some((token) => /^(pwd|4ps|pantawid|participant|participants|beneficiary|beneficiaries|served|serving|count|total|many|number|municipality|barangay|project|enterprise|training|orientation|operational|closed|status|template|proposal|guideline|file|copy|download|form|tool)$/i.test(token))) return false;
  if (/\b(person with disability|non 4ps|year served|how many|total participants|number of|show files|files checked)\b/.test(normalized)) return false;
  return true;
}

function rowMatchesPerson(row: Record<string, string>, headers: string[], queryName: string) {
  if (!queryName) return { matched: false, score: 0, type: "" };
  const rowName = slpFullName(row, headers);
  if (!rowName) return { matched: false, score: 0, type: "" };
  const variants = nameVariants(queryName);
  const rowVariants = nameVariants(rowName);
  const exact = variants.some((left) => rowVariants.includes(left));
  if (exact) return { matched: true, score: 100, type: "Exact normalized full-name match" };
  const queryNorm = normalizePersonName(queryName);
  const rowNorm = normalizePersonName(rowName);
  if ((queryNorm.length >= 6 && rowNorm.includes(queryNorm)) || (rowNorm.length >= 6 && queryNorm.includes(rowNorm))) return { matched: true, score: 96, type: "Full-name contains match" };
  const score = fullNameScoreVariant(queryName, rowName);
  return { matched: score >= 82, score, type: score >= 92 ? "Strong fuzzy full-name match" : "Possible fuzzy full-name match" };
}

function rowMatchesIdentifiers(row: Record<string, string>, headers: string[], terms: ReturnType<typeof extractStructuredLookupTerms>) {
  if (terms.projectId && normalizeName(slpValue(row, headers, ["Project ID"])) === normalizeName(terms.projectId)) return { matched: true, score: 100, type: "Project ID match" };
  if (terms.participantId && normalizeName(slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"])) === normalizeName(terms.participantId)) return { matched: true, score: 100, type: "SLP Participant ID match" };
  if (terms.grantCode && normalizeName(slpValue(row, headers, ["Grant Code", "Grant ID", "Project Code"])) === normalizeName(terms.grantCode)) return { matched: true, score: 100, type: "Grant Code match" };
  return { matched: false, score: 0, type: "" };
}

function deterministicModuleRoute(message: string, parsed: ParsedQuery): SlpModuleTag[] {
  const lower = normalizeName(message);
  const terms = extractStructuredLookupTerms(message);
  const strictIntent = classifyStrictSlpIntent(message, parsed);
  if (strictIntent === "file_request_download" || strictIntent === "template_or_form_lookup" || strictIntent === "proposal_lookup") return [];
  if (strictIntent === "guideline_definition") return ["GUIDELINES_MC03"];
  if (strictIntent === "participant_status_lookup") return ["PERSONAL"];
  if (strictIntent === "person_lookup") {
    if (/project|enterprise|livelihood/.test(lower)) return ["PERSONAL", "PROJECT"];
    if (/grant code|grant utilization|gur/.test(lower)) return ["PERSONAL", "PROJECT", "GRANT_UTILIZATION"];
    if (/training|trained/.test(lower)) return ["PERSONAL", "TRAINING"];
    if (/orientation/.test(lower)) return ["PERSONAL", "ORIENTATION"];
    if (/operational|closed|monitoring|status/.test(lower)) return ["PERSONAL", "MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"];
    return ["PERSONAL"];
  }
  if (strictIntent === "project_lookup") return ["PROJECT"];
  if (strictIntent === "monitoring_status_lookup") return ["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"];
  if (strictIntent === "gur_lookup") return ["GRANT_UTILIZATION", "PROJECT"];
  if (strictIntent === "grant_code_lookup") return terms.name || terms.participantId ? ["PERSONAL", "PROJECT", "GRANT_UTILIZATION"] : ["GRANT_UTILIZATION"];
  if (strictIntent === "training_lookup") return ["TRAINING", "PERSONAL", "PROJECT"];
  if (strictIntent === "orientation_lookup") return ["ORIENTATION", "PERSONAL", "PROJECT"];
  if (/guidelines?|mc\s*0?3|omnibus|policy|memorandum|slp phases?|implementation phases?/.test(lower) && !terms.projectId && !terms.participantId && !terms.grantCode && !/(participant|beneficiary|project id|grant code|gur|served|training|operational|closed)/.test(lower)) return ["GUIDELINES_MC03"];
  if (/template|tool|form|copy|download|annex/.test(lower)) return [];
  if (/grant code|grant utilization|gur/.test(lower) || terms.grantCode) return terms.name || terms.participantId ? ["PERSONAL", "PROJECT", "GRANT_UTILIZATION"] : ["GRANT_UTILIZATION"];
  if (/orientation/.test(lower)) return terms.name || terms.participantId ? ["PERSONAL", "ORIENTATION"] : ["ORIENTATION"];
  if (/training|trained|seminar|workshop/.test(lower)) return terms.name || terms.participantId ? ["PERSONAL", "TRAINING"] : ["TRAINING"];
  if (/operational|closed|monitoring|status/.test(lower)) return ["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"];
  if (/project id|project|enterprise|association|slpa/.test(lower) || terms.projectId) return ["PROJECT"];
  if (/participant|beneficiary|person|client|served|4ps|pantawid|non 4ps|pwd|solo parent|sex|gender|year served|participant type/.test(lower) || terms.participantId || terms.name) return ["PERSONAL"];
  return parsed.needsExcel ? ["PERSONAL", "PROJECT", "GRANT_UTILIZATION", "TRAINING", "MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"] : [];
}

function filteredSlpRowEntries(sources: any[], filters: QuestionFilters) {
  return slpRows(sources).filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
}

// ============================================================================
// ENHANCED SLP DATA COMPUTATION & RETRIEVAL IMPROVEMENTS
// ============================================================================

// Helper function: Count total distinct participants with deduplication
function countTotalParticipantsWithDedup(sources: any[], filters: QuestionFilters = {}): { count: number; keyColumn: string } {
  const participantSources = sourcesForModules(sources, ["PERSONAL"]);
  if (!participantSources.length) return { count: 0, keyColumn: "" };
  
  const allRows = slpRows(participantSources);
  const filteredRows = filters && Object.keys(filters).length 
    ? allRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0)
    : allRows;

  const participantKeys = new Set<string>();
  for (const { row, source } of filteredRows) {
    const key = slpParticipantKey(row, source.headers || []);
    if (key) participantKeys.add(key);
  }
  
  return { count: participantKeys.size, keyColumn: "SLP Participant ID / Full Name" };
}

// Helper function: Count associations vs individual enterprises properly
function countAssociationsAndIndividualEnterprises(sources: any[], filters: QuestionFilters = {}): { associations: number; individual: number; totalProjects: number } {
  const projectSources = sourcesForModules(sources, ["PROJECT"]);
  if (!projectSources.length) return { associations: 0, individual: 0, totalProjects: 0 };
  
  const allRows = slpRows(projectSources);
  const filteredRows = filters && Object.keys(filters).length
    ? allRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0)
    : allRows;

  // Group rows by Project ID to identify associations vs individual enterprises
  const projectMap = new Map<string, { rows: any[]; projectId: string }>();
  for (const { row, source } of filteredRows) {
    const headers = source.headers || [];
    const projectKey = slpProjectKey(row, headers);
    if (!projectKey) continue;
    
    const projectId = normalizeName(slpValue(row, headers, ["Project ID"]));
    if (!projectMap.has(projectKey)) {
      projectMap.set(projectKey, { rows: [], projectId });
    }
    projectMap.get(projectKey)!.rows.push({ row, source });
  }

  let associations = 0, individual = 0;
  for (const { rows } of projectMap.values()) {
    if (rows.length > 1) {
      associations += 1;
    } else if (rows.length === 1) {
      individual += 1;
    }
  }

  return { associations, individual, totalProjects: projectMap.size };
}

// Helper function: Count operational/closed with proper status classification
function countOperationalClosed(sources: any[], filters: QuestionFilters = {}): { operational: number; closed: number; byMunicipality: Map<string, { operational: number; closed: number }> } {
  const mdSources = sourcesForModules(sources, ["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"]);
  if (!mdSources.length) return { operational: 0, closed: 0, byMunicipality: new Map() };
  
  const allRows = slpRows(mdSources);
  const filteredRows = filters && Object.keys(filters).length
    ? allRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0)
    : allRows;

  const statusMap = new Map<string, { status: string; municipality: string }>();
  let operational = 0, closed = 0;
  const byMunicipality = new Map<string, { operational: number; closed: number }>();

  for (const { row, source } of filteredRows) {
    const headers = source.headers || [];
    const key = slpProjectKey(row, headers) || dashboardRowKey([slpFullName(row, headers), slpProjectName(row, headers), slpMunicipality(row, headers)]);
    if (!key) continue;

    const rawStatus = slpValue(row, headers, ["Enterprise Status", "Livelihood Status", "Project Status", "Status"]);
    const status = classifyEnterpriseStatus(rawStatus);
    const municipality = slpMunicipality(row, headers) || "Unspecified";

    // Only count each unique key once (first occurrence wins)
    if (!statusMap.has(key)) {
      statusMap.set(key, { status, municipality });
      if (status === "operational") operational += 1;
      else if (status === "closed") closed += 1;

      if (!byMunicipality.has(municipality)) {
        byMunicipality.set(municipality, { operational: 0, closed: 0 });
      }
      const muniItem = byMunicipality.get(municipality)!;
      if (status === "operational") muniItem.operational += 1;
      else if (status === "closed") muniItem.closed += 1;
    }
  }

  return { operational, closed, byMunicipality };
}

// Helper function: Count grant utilization conducted (GUR check)
function countGrantUtilizationConducted(projectSources: any[], gurSources: any[], filters: QuestionFilters = {}): { conducted: number; notConducted: number } {
  const allProjectRows = slpRows(projectSources);
  const filteredProjectRows = filters && Object.keys(filters).length
    ? allProjectRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0)
    : allProjectRows;

  // Build GUR key set
  const gurKeys = new Set<string>();
  for (const { row, source } of slpRows(gurSources)) {
    const headers = source.headers || [];
    const keys = [
      slpValue(row, headers, ["Project ID"]),
      slpValue(row, headers, ["Grant Code"]),
      normalizeName([slpProjectName(row, headers), slpMunicipality(row, headers)].join("|"))
    ].filter(Boolean).map(k => normalizeName(k));
    keys.forEach(k => gurKeys.add(k));
  }

  // Match project rows to GUR keys
  const seenProjectKeys = new Set<string>();
  let conducted = 0, notConducted = 0;

  for (const { row, source } of filteredProjectRows) {
    const headers = source.headers || [];
    const projectKey = slpProjectKey(row, headers);
    if (!projectKey || seenProjectKeys.has(projectKey)) continue;
    seenProjectKeys.add(projectKey);

    const matchKeys = [
      slpValue(row, headers, ["Project ID"]),
      slpValue(row, headers, ["Grant Code"]),
      normalizeName([slpProjectName(row, headers), slpMunicipality(row, headers)].join("|"))
    ].filter(Boolean).map(k => normalizeName(k));

    if (matchKeys.some(k => gurKeys.has(k))) {
      conducted += 1;
    } else {
      notConducted += 1;
    }
  }

  return { conducted, notConducted };
}

// Helper function: Count training conducted
function countTrainingConducted(participantSources: any[], trainingSources: any[], filters: QuestionFilters = {}): { conducted: number; notConducted: number } {
  const allParticipantRows = slpRows(participantSources);
  const filteredParticipantRows = filters && Object.keys(filters).length
    ? allParticipantRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0)
    : allParticipantRows;

  // Build training key set
  const trainingKeys = new Set<string>();
  for (const { row, source } of slpRows(trainingSources)) {
    const headers = source.headers || [];
    const participantId = slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]);
    const fullName = slpFullName(row, headers);
    const municipality = slpMunicipality(row, headers);
    const barangay = slpValue(row, headers, ["Barangay", "Brgy"]);
    
    const keys = [
      participantId,
      normalizeName([fullName, municipality, barangay].join("|"))
    ].filter(Boolean).map(k => normalizeName(k));
    keys.forEach(k => trainingKeys.add(k));
  }

  // Match participant rows to training keys
  let conducted = 0, notConducted = 0;
  for (const { row, source } of filteredParticipantRows) {
    const headers = source.headers || [];
    const participantId = slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]);
    const fullName = slpFullName(row, headers);
    const municipality = slpMunicipality(row, headers);
    const barangay = slpValue(row, headers, ["Barangay", "Brgy"]);

    const keys = [
      participantId,
      normalizeName([fullName, municipality, barangay].join("|"))
    ].filter(Boolean).map(k => normalizeName(k));

    if (keys.some(k => trainingKeys.has(k))) {
      conducted += 1;
    } else {
      notConducted += 1;
    }
  }

  return { conducted, notConducted };
}

// Helper function: Log debug information for chat answer
function logDebugInfo(input: {
  intent: string;
  modules: SlpModuleTag[];
  columns: string[];
  matched: number;
  selected: string;
  reason: string;
}) {
  const debugStr = JSON.stringify({
    intent: input.intent,
    modulesChecked: input.modules.map(m => SLP_MODULE_LABELS[m]),
    columnsUsed: input.columns,
    matchedRows: input.matched,
    selectedSource: input.selected,
    reason: input.reason,
    timestamp: new Date().toISOString()
  });
  console.log(`[RETRIEVAL_DEBUG] ${debugStr}`);
}

function normalizeTrainingTitleForDashboard(title = "") {
  const text = normalizeName(title);
  if (!text) return "Unspecified";
  if (/slp.*orientation|program.*orientation|orientation/.test(text)) return "SLP ORIENTATION";
  if (/financial.*literacy|finlit/.test(text)) return "FINANCIAL LITERACY";
  if (/microenterprise.*development.*ii|\bmdt\s*ii\b|\bmedi?i\b/.test(text)) return "Microenterprise Development Training II";
  if (/microenterprise.*development.*i|\bmdt\s*i\b|\bmedi?\b/.test(text)) return "Microenterprise Development Training I";
  if (/organizational.*development.*leadership/.test(text)) return "Organizational Development Leadership Training";
  if (/leadership/.test(text)) return "Leadership Training";
  return title.trim() || "Unspecified";
}

function debugRetrieval(event: string, details: Record<string, any>) {
  if (!RETRIEVAL_DEBUG) return;
  console.log(`[RETRIEVAL_DEBUG:${event}] ${JSON.stringify(details)}`);
}

type SlpIntent =
  | "file_request_download"
  | "template_or_form_lookup"
  | "proposal_lookup"
  | "guideline_definition"
  | "person_lookup"
  | "participant_status_lookup"
  | "project_lookup"
  | "grant_code_lookup"
  | "training_lookup"
  | "orientation_lookup"
  | "gur_lookup"
  | "monitoring_status_lookup"
  | "count_or_summary"
  | "dashboard_analytics"
  | "chart_report"
  | "comparison_or_matching"
  | "general_document_search"
  | "show_files_checked"
  | "show_indexed_modules"
  | "dashboard_calculation_check";

function classifyStrictSlpIntent(message: string, parsed: ParsedQuery = parseQuery(message)): SlpIntent {
  const lower = normalizeName(message);
  if (/show indexed modules/.test(lower)) return "show_indexed_modules";
  if (/show files checked|source selection|debug|check debug/.test(lower)) return "show_files_checked";
  if (/dashboard calculation check|calculation check|calc check|verify dashboard|dashboard metrics? check|check dashboard/.test(lower)) return "dashboard_calculation_check";
  if (isFileRequest(message) || /\b(download|copy of|have a copy|give me|provide|send me)\b/.test(lower) && /\b(file|template|form|tool|annex|document)\b/.test(lower)) return "file_request_download";
  if (/\btemplate|form|tool|annex\b/.test(lower)) return "template_or_form_lookup";
  if (/\bproposal|project proposal|sample proposal|proposal about\b/.test(lower)) return "proposal_lookup";
  if (/mc\s*0?3|guidelines?|omnibus|policy|slp phases?|implementation phases?|requirements?|process|definition|define|meaning/.test(lower) && !/(participant|beneficiary|project id|grant code|gur|training|operational|closed)/.test(lower)) return "guideline_definition";
  if (/\b(closed|close|not operational|non operational|not operating|operational|active|operating|status gur|monitoring status|operational status)\b/.test(lower)) return "monitoring_status_lookup";
  if (/dashboard|kpi|drill.?down|municipality profile|municipality details|municipality.*overview/.test(lower)) return "dashboard_analytics";
  if (/chart|graph|report|breakdown|trend| by municipality| by year|top\s*\d*/.test(lower)) return "chart_report";
  if (/match.*compare|compare.*personal|duplicate|name match|verify names?/.test(lower)) return "comparison_or_matching";
  if (/training|trained|seminar|workshop/.test(lower)) return "training_lookup";
  if (/orientation|punla orientation/.test(lower)) return "orientation_lookup";
  if (/grant utilization|gur|grant utilization report|conducted gur|not conducted gur/.test(lower)) return "gur_lookup";
  if (/grant.*code|grant.*id|project code/.test(lower)) return "grant_code_lookup";
  if (/operational|closed|monitoring|status gur|monitoring status|operational status/.test(lower)) return "monitoring_status_lookup";
  if (/person|participant|beneficiary|client|name|4ps|pantawid|non.?4ps|pwd|disability|sex|gender|solo parent|served|year served/.test(lower) && /(project|enterprise|grant|training|orientation|monitoring|status|details|find|lookup|search|record)/.test(lower)) return "person_lookup";
  if (/4ps|pantawid|non.?4ps|pwd|disability|sex|gender|solo parent|participant type|served|year served|participant|beneficiary|person/.test(lower)) return "participant_status_lookup";
  if (/project|enterprise|livelihood|association|individual enterprise|most implemented/.test(lower)) return "project_lookup";
  if (/how many|count|total|number of|summary|list|show/.test(lower) || parsed.intentType === "count") return "count_or_summary";
  return "general_document_search";
}

function legacyIntentFromStrict(intent: SlpIntent, message = "") {
  const lower = normalizeName(message);
  const map: Record<string, string> = {
    file_request_download: "template_request",
    template_or_form_lookup: "template_request",
    proposal_lookup: "proposal_request",
    guideline_definition: "guidelines",
    person_lookup: "person_lookup",
    participant_status_lookup: "total_participants",
    project_lookup: /association/.test(lower) ? "association_enterprises" : /individual enterprise/.test(lower) ? "individual_enterprises" : "total_projects",
    grant_code_lookup: "grant_code_lookup",
    training_lookup: "training_status",
    orientation_lookup: "orientation_status",
    gur_lookup: "grant_utilization_status",
    monitoring_status_lookup: /individual/.test(lower) ? "individual_status" : /association|slpa/.test(lower) ? "association_status" : "status_by_municipality",
    count_or_summary: "total_participants",
    dashboard_analytics: "municipality_drilldown",
    chart_report: /enterprise|project type|most implemented|top/.test(lower) ? "top_enterprise_types" : "status_by_municipality",
    comparison_or_matching: "match_compare",
    show_files_checked: "show_files_checked",
    show_indexed_modules: "show_indexed_modules",
    dashboard_calculation_check: "dashboard_calculation_check",
    general_document_search: "",
  };
  return map[intent] || "";
}

function slpParticipantId(row: Record<string, string>, headers: string[]) {
  return slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]);
}

function findPwdColumn(headers: string[]) {
  return findSlpColumn(headers, ["PWD", "Is PWD", "PWD Status", "Person with Disability", "Disability", "Sector", "Vulnerability", "Participant Type"]);
}

function findParticipantFilterMissingColumns(sources: any[], filters: QuestionFilters) {
  const missing: string[] = [];
  const hasAny = (predicate: (headers: string[]) => boolean) => sources.some((source) => predicate(source.headers || []));
  if (filters.pwd && !hasAny((headers) => Boolean(findPwdColumn(headers)))) missing.push("PWD column");
  if (filters.soloParent && !hasAny((headers) => Boolean(findSlpColumn(headers, ["Solo Parent", "Single Parent", "Sector", "Vulnerability", "Participant Type"])))) missing.push("Solo Parent column");
  if (filters.sex && !hasAny((headers) => Boolean(findSlpColumn(headers, ["Sex", "Gender"])))) missing.push("Sex/Gender column");
  if (filters.participantType && !hasAny((headers) => Boolean(findSlpColumn(headers, ["4Ps", "Pantawid", "Participant Type", "Type of Participant", "Pantawid Beneficiary"])))) missing.push("4Ps/Pantawid or Participant Type column");
  if (filters.year && !hasAny((headers) => Boolean(findSlpColumn(headers, ["Year Served", "Implementation Year", "Year", "Date Served", "Date"])))) missing.push("Year Served / Implementation Year column");
  return missing;
}

function slpProjectId(row: Record<string, string>, headers: string[]) {
  return slpValue(row, headers, ["Project ID"]);
}

function slpGrantCode(row: Record<string, string>, headers: string[]) {
  return slpValue(row, headers, ["Grant Code", "Grant ID", "Project Code"]);
}

function slpAssociationClassification(row: Record<string, string>, headers: string[], sameProjectRows = 1) {
  const type = normalizeName(slpValue(row, headers, ["Enterprise Type", "Project Type", "Type", "Mode", "Classification"]));
  if (/association|slpa|group|organization|organisation/.test(type) || sameProjectRows > 1) return "Association";
  if (/individual|participant|solo/.test(type) || sameProjectRows === 1) return "Individual";
  return "Unspecified";
}

function slpStatusValue(row: Record<string, string>, headers: string[], aliases: string[]) {
  const value = slpValue(row, headers, aliases);
  return value || "-";
}

function truthySlpValue(value: string) {
  const normalized = normalizeName(value);
  if (!normalized) return false;
  if (/^(yes|y|true|1|4ps|pwd|pantawid|served|conducted|with|member)$/.test(normalized)) return true;
  if (/^(no|n|false|0|none|not applicable|na|n a|non 4ps)$/.test(normalized)) return false;
  return true;
}

function personLookupIntent(message: string) {
  const lower = normalizeName(message);
  if (/template|tool|form|copy|download|annex/.test(lower)) return "template_request";
  if (/guidelines?|mc\s*0?3|memorandum|policy|rules/.test(lower)) return "guideline_explanation";
  if (/dashboard|analytics|chart|report|breakdown|top|how many|count|total|number of|show all|list all|all projects|all enterprises| by municipality|operational vs closed|closed vs operational|operational and closed|closed and operational/.test(lower)) return "";
  if (/grant.*code|grant utilization|gur/.test(lower)) return "grant_code_lookup";
  if (/project|enterprise|livelihood/.test(lower)) return "project_lookup_by_person";
  if (/4ps|pantawid|pwd|served|year served|status/.test(lower)) return "participant_status";
  if (/training|orientation|monitoring|operational|closed/.test(lower)) return "participant_status";
  if (/person|participant|beneficiary|client|name|lookup|find|search|record/.test(lower)) return "person_lookup";
  return "";
}

function findPersonalMatches(personalSources: any[], terms: ReturnType<typeof extractStructuredLookupTerms>, filters: QuestionFilters) {
  return filteredSlpRowEntries(personalSources, filters)
    .map(({ row, source }) => {
      const headers = source.headers || [];
      const idMatch = rowMatchesIdentifiers(row, headers, terms);
      const personMatch = rowMatchesPerson(row, headers, terms.name);
      const score = Math.max(idMatch.score, personMatch.score);
      const type = idMatch.score >= personMatch.score ? idMatch.type : personMatch.type;
      return { row, source, score, type };
    })
    .filter((item) => (terms.participantId || terms.name) ? item.score >= 82 : false)
    .sort((a, b) => b.score - a.score);
}

function personJoinKeys(matches: Array<{ row: Record<string, string>; source: any }>) {
  const participantIds = new Set<string>();
  const names = new Set<string>();
  const nameLocationKeys = new Set<string>();
  for (const item of matches) {
    const headers = item.source.headers || [];
    const id = slpParticipantId(item.row, headers);
    const fullName = slpFullName(item.row, headers);
    const municipality = slpMunicipality(item.row, headers);
    const barangay = slpValue(item.row, headers, ["Barangay", "Brgy"]);
    if (id) participantIds.add(normalizeName(id));
    if (fullName) names.add(normalizePersonName(fullName));
    if (fullName) nameLocationKeys.add(normalizeName([fullName, municipality, barangay].join("|")));
  }
  return { participantIds, names, nameLocationKeys };
}

function rowMatchesPersonKeys(row: Record<string, string>, headers: string[], keys: ReturnType<typeof personJoinKeys>) {
  const id = normalizeName(slpParticipantId(row, headers));
  if (id && keys.participantIds.has(id)) return { matched: true, reason: "SLP Participant ID join" };
  const fullName = slpFullName(row, headers);
  const municipality = slpMunicipality(row, headers);
  const barangay = slpValue(row, headers, ["Barangay", "Brgy"]);
  if (fullName && keys.nameLocationKeys.has(normalizeName([fullName, municipality, barangay].join("|")))) return { matched: true, reason: "Full name + municipality/barangay join" };
  if (fullName && keys.names.has(normalizePersonName(fullName))) return { matched: true, reason: "Normalized full-name join" };
  return { matched: false, reason: "" };
}

function projectRowsForPerson(projectSources: any[], keys: ReturnType<typeof personJoinKeys>, filters: QuestionFilters) {
  const raw = filteredSlpRowEntries(projectSources, filters)
    .map(({ row, source }) => {
      const headers = source.headers || [];
      const match = rowMatchesPersonKeys(row, headers, keys);
      return { row, source, match };
    })
    .filter((item) => item.match.matched);
  const projectCounts = new Map<string, number>();
  for (const item of raw) {
    const key = slpProjectKey(item.row, item.source.headers || []);
    if (key) projectCounts.set(key, (projectCounts.get(key) || 0) + 1);
  }
  return raw.map((item) => ({ ...item, sameProjectRows: projectCounts.get(slpProjectKey(item.row, item.source.headers || [])) || 1 }));
}

function findRowsByProjectOrPerson(sources: any[], projectRows: Array<{ row: Record<string, string>; source: any }>, keys: ReturnType<typeof personJoinKeys>, filters: QuestionFilters) {
  const projectIds = new Set(projectRows.map((item) => normalizeName(slpProjectId(item.row, item.source.headers || []))).filter(Boolean));
  const projectKeys = new Set(projectRows.flatMap((item) => slpProjectMatchKeys(item.row, item.source.headers || [])));
  return filteredSlpRowEntries(sources, filters)
    .map(({ row, source }) => {
      const headers = source.headers || [];
      const rowProjectId = normalizeName(slpProjectId(row, headers));
      const projectMatch = rowProjectId && projectIds.has(rowProjectId);
      const anyProjectMatch = slpProjectMatchKeys(row, headers).some((key) => projectKeys.has(key));
      const personMatch = rowMatchesPersonKeys(row, headers, keys);
      return { row, source, reason: projectMatch ? "Project ID join" : anyProjectMatch ? "Project/grant/name join" : personMatch.reason };
    })
    .filter((item) => item.reason);
}

function formatSourceRow(source: any, row: Record<string, string>) {
  return `${sourceDisplayName(source)} row ${row.__rowNumber || "?"}`;
}

function buildPersonDeterministicAnswer(message: string, parsed: ParsedQuery, sources = loadSlpModuleSources()): DeterministicLookup | null {
  const routedIntent = personLookupIntent(message);
  if (!routedIntent) return null;
  const strictIntent = classifyStrictSlpIntent(message, parsed);
  if (!["person_lookup", "participant_status_lookup", "grant_code_lookup", "project_lookup", "training_lookup", "orientation_lookup"].includes(strictIntent)) return null;
  const terms = extractStructuredLookupTerms(message);
  if (!terms.name && !terms.participantId) return null;

  const filters = extractStrictFilters(message, parsed);
  const personalSources = sourcesForModules(sources, ["PERSONAL"]);
  const projectSources = sourcesForModules(sources, ["PROJECT"]);
  const gurSources = sourcesForModules(sources, ["GRANT_UTILIZATION"]);
  const trainingSources = sourcesForModules(sources, ["TRAINING"]);
  const orientationSources = sourcesForModules(sources, ["ORIENTATION"]);
  const monitoringSources = sourcesForModules(sources, ["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"]);
  const checkedModules: SlpModuleTag[] = ["PERSONAL"];
  const filesChecked = personalSources.map(sourceDisplayName);

  if (!personalSources.length) return null;
  const personalMatches = findPersonalMatches(personalSources, terms, filters);
  const selectedColumns = selectedColumnsForSources(personalSources);
  if (!personalMatches.length) {
    return {
      answer: [
        "**Direct Answer**",
        "I could not find this person in the Personal Module.",
        "",
        "**Explanation**",
        "Checked Personal Module first using exact SLP Participant ID/full-name matching, then contains and fuzzy full-name matching.",
        "",
        "**Source Used**",
        ...filesChecked.slice(0, 5).map((source) => `- ${source}`),
      ].join("\n"),
      debug: { intent: routedIntent, filters, selectedModules: checkedModules, selectedColumns, selectedSource: filesChecked.slice(0, 5).join("; "), matchedRows: 0, answerType: "personal_no_match" },
    };
  }

  const bestPersonal = personalMatches[0];
  const keys = personJoinKeys(personalMatches.filter((item) => item.score >= Math.max(82, bestPersonal.score - 8)));
  const personalHeaders = bestPersonal.source.headers || [];
  const participantId = slpParticipantId(bestPersonal.row, personalHeaders) || "-";
  const fullName = slpFullName(bestPersonal.row, personalHeaders) || terms.name || "-";
  const municipality = slpMunicipality(bestPersonal.row, personalHeaders) || "-";
  const rowSource = formatSourceRow(bestPersonal.source, bestPersonal.row);

  if (routedIntent === "participant_status" || /4ps|pantawid|pwd|served|year served/i.test(message)) {
    const statusBits: string[] = [];
    if (/4ps|pantawid/i.test(message)) {
      const value = slpStatusValue(bestPersonal.row, personalHeaders, ["4Ps", "Pantawid", "Type of Participant", "Participant Type", "Pantawid Beneficiary"]);
      statusBits.push(`4Ps/Pantawid: ${truthySlpValue(value) && !/non[-\s]?4ps/i.test(value) ? "Yes" : value || "Not found"}`);
    }
    if (/pwd/i.test(message)) {
      const value = slpStatusValue(bestPersonal.row, personalHeaders, ["PWD", "Person with Disability", "Disability"]);
      statusBits.push(`PWD: ${truthySlpValue(value) ? "Yes" : value || "Not found"}`);
    }
    if (/served|year/i.test(message)) {
      const served = slpStatusValue(bestPersonal.row, personalHeaders, ["Served", "Status", "Participant Status"]);
      const year = slpStatusValue(bestPersonal.row, personalHeaders, ["Year Served", "Year", "Date Served", "Date"]);
      if (/served/i.test(message)) statusBits.push(`Served status: ${served}`);
      if (/year/i.test(message)) statusBits.push(`Year served: ${year}`);
    }
    if (!statusBits.length) statusBits.push(`Record found: ${fullName}`);
    return {
      answer: [
        "**Direct Answer**",
        `${fullName}: ${statusBits.join("; ")}.`,
        "",
        "**Explanation**",
        "This was answered only from the matched Personal Module row.",
        "",
        "**Source Used**",
        `- ${rowSource}`,
      ].join("\n"),
      debug: { intent: routedIntent, filters, selectedModules: checkedModules, selectedColumns, selectedSource: rowSource, matchedRows: personalMatches.length, answerType: "participant_status" },
    };
  }

  const projectMatches = projectRowsForPerson(projectSources, keys, filters);
  if (routedIntent === "project_lookup_by_person") {
    checkedModules.push("PROJECT"); filesChecked.push(...projectSources.map(sourceDisplayName));
    if (!projectMatches.length) {
      return {
        answer: [
          "**Direct Answer**",
          `${fullName} was found in Personal Module, but no linked Project Module row was found by SLP Participant ID, full name, or project keys.`,
          "",
          "**Source Used**",
          `- ${rowSource}`,
          ...projectSources.slice(0, 5).map((source) => `- ${sourceDisplayName(source)}`),
        ].join("\n"),
        debug: { intent: routedIntent, filters, selectedModules: checkedModules, selectedColumns: selectedColumnsForSources([...personalSources, ...projectSources]), selectedSource: rowSource, matchedRows: 0, answerType: "project_no_match" },
      };
    }
    const rows = projectMatches.slice(0, 10).map((item) => {
      const headers = item.source.headers || [];
      return [
        slpProjectName(item.row, headers),
        slpProjectId(item.row, headers) || "-",
        slpMunicipality(item.row, headers) || municipality,
        slpAssociationClassification(item.row, headers, item.sameProjectRows),
        item.match.reason,
        formatSourceRow(item.source, item.row),
      ];
    });
    return {
      answer: [
        "**Direct Answer**",
        `${fullName} is linked to ${projectMatches.length} Project Module row(s).`,
        "",
        "**Relevant Rows**",
        markdownTable(["Project/Enterprise Name", "Project ID", "Municipality", "Classification", "Match", "Source Row"], rows),
        "",
        "**Explanation**",
        "Personal Module was matched first, then Project Module was joined by SLP Participant ID and full-name keys.",
        "",
        "**Source Used**",
        `- ${rowSource}`,
        ...Array.from(new Set(projectMatches.slice(0, 5).map((item) => `- ${sourceDisplayName(item.source)}`))),
      ].join("\n"),
      debug: { intent: routedIntent, filters, selectedModules: checkedModules, selectedColumns: selectedColumnsForSources([...personalSources, ...projectSources]), selectedSource: rowSource, matchedRows: projectMatches.length, answerType: "project_join" },
    };
  }

  if (routedIntent === "grant_code_lookup") {
    checkedModules.push("PROJECT", "GRANT_UTILIZATION"); filesChecked.push(...projectSources.map(sourceDisplayName), ...gurSources.map(sourceDisplayName));
    const gurMatches = findRowsByProjectOrPerson(gurSources, projectMatches, keys, filters);
    const fallbackProjectGrantRows = projectMatches.filter((item) => slpGrantCode(item.row, item.source.headers || []));
    const rows = (gurMatches.length ? gurMatches : fallbackProjectGrantRows.map((item) => ({ ...item, reason: "Project Module fallback grant code" }))).slice(0, 10).map((item: any) => {
      const headers = item.source.headers || [];
      return [
        slpGrantCode(item.row, headers) || "-",
        slpProjectId(item.row, headers) || "-",
        slpProjectName(item.row, headers),
        slpMunicipality(item.row, headers) || municipality,
        item.reason,
        formatSourceRow(item.source, item.row),
      ];
    });
    if (!rows.length) {
      return {
        answer: [
          "**Direct Answer**",
          `${fullName} was found in Personal Module, but no linked grant code was found in Grant Utilization Module or Project Module.`,
          "",
          "**Source Used**",
          `- ${rowSource}`,
        ].join("\n"),
        debug: { intent: routedIntent, filters, selectedModules: checkedModules, selectedColumns: selectedColumnsForSources([...personalSources, ...projectSources, ...gurSources]), selectedSource: rowSource, matchedRows: 0, answerType: "grant_no_match" },
      };
    }
    return {
      answer: [
        "**Direct Answer**",
        `${fullName}: found ${rows.length} linked grant code row(s).`,
        "",
        "**Relevant Rows**",
        markdownTable(["Grant Code", "Project ID", "Project/Enterprise", "Municipality", "Match", "Source Row"], rows),
        "",
        "**Explanation**",
        "Searched Grant Utilization Module first using participant/project join keys, then fell back to Project Module grant code values.",
        "",
        "**Source Used**",
        `- ${rowSource}`,
        ...Array.from(new Set([...gurMatches, ...fallbackProjectGrantRows].slice(0, 5).map((item: any) => `- ${sourceDisplayName(item.source)}`))),
      ].join("\n"),
      debug: { intent: routedIntent, filters, selectedModules: checkedModules, selectedColumns: selectedColumnsForSources([...personalSources, ...projectSources, ...gurSources]), selectedSource: rowSource, matchedRows: rows.length, answerType: "grant_join" },
    };
  }

  checkedModules.push("PROJECT", "GRANT_UTILIZATION", "TRAINING", "ORIENTATION", "MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION");
  const trainingMatches = findRowsByProjectOrPerson(trainingSources, projectMatches, keys, filters);
  const orientationMatches = findRowsByProjectOrPerson(orientationSources, projectMatches, keys, filters);
  const monitoringMatches = findRowsByProjectOrPerson(monitoringSources, projectMatches, keys, filters);
  const direct = [
    `${fullName} was found in Personal Module`,
    `Participant ID: ${participantId}`,
    `Municipality: ${municipality}`,
    `Project rows: ${projectMatches.length}`,
    `Training rows: ${trainingMatches.length}`,
    `Orientation rows: ${orientationMatches.length}`,
    `Monitoring rows: ${monitoringMatches.length}`,
  ].join("; ") + ".";
  return {
    answer: [
      "**Direct Answer**",
      direct,
      "",
      "**Explanation**",
      "Personal Module was matched first; linked modules were searched by SLP Participant ID, project keys, and full-name keys.",
      "",
      "**Source Used**",
      `- ${rowSource}`,
    ].join("\n"),
    debug: { intent: routedIntent, filters, selectedModules: checkedModules, selectedColumns: selectedColumnsForSources(sourcesForModules(sources, checkedModules)), selectedSource: rowSource, matchedRows: 1 + projectMatches.length + trainingMatches.length + orientationMatches.length + monitoringMatches.length, answerType: "person_join_summary" },
  };
}

function buildRowLookupAnswer(message: string, parsed: ParsedQuery, sources = loadSlpModuleSources()): DeterministicLookup | null {
  const personAnswer = buildPersonDeterministicAnswer(message, parsed, sources);
  if (personAnswer) {
    console.log(`[SQLITE_RETRIEVAL_RESULTS] ${JSON.stringify({
      userQuery: message,
      selectedTables: ["uploaded_sheets", "sheet_rows", "sheet_columns"],
      tableSchemas: sqliteTableSchemasForDebug(["uploaded_sheets", "sheet_rows", "sheet_columns"]),
      generatedSql: "deterministic in-memory lookup over indexed SQLite sheet_rows JSON",
      rowCountReturned: personAnswer.debug?.matchedRows || 0,
      first5ResultRows: [],
    })}`);
    return personAnswer;
  }

  const lower = normalizeName(message);
  if (isFileRequest(message) || (/guidelines?|mc\s*0?3|omnibus/.test(lower) && !/(participant|beneficiary|project id|grant code|gur|served|training|operational|closed|association|enterprise)/.test(lower))) return null;
  if (/\b(show all|list all|all projects|all enterprises)\b/.test(lower)) return null;
  const terms = extractStructuredLookupTerms(message);
  const modules = deterministicModuleRoute(message, parsed);
  const hasLookupTerm = Boolean(terms.projectId || terms.participantId || terms.grantCode || terms.name);
  const asksLookup = /\b(find|search|lookup|record|status|grant code|project id|participant id|is served|served|training|conducted|gur|operational|closed)\b/i.test(message);
  if ((parsed.intentType === "count" || parsed.intentType === "chart" || parsed.intentType === "report" || /how many|count|total|number of|breakdown| by municipality| by year/i.test(message)) && !(terms.projectId || terms.participantId || terms.grantCode)) return null;
  if (!modules.length || (!hasLookupTerm && !asksLookup)) return null;

  const selected = sourcesForModules(sources, modules);
  const filters = extractStrictFilters(message, parsed);
  const selectedColumns = selectedColumnsForSources(selected);
  const selectedSource = selected.map(sourceDisplayName).slice(0, 5).join("; ");
  if (!selected.length) {
    console.log(`[SQLITE_RETRIEVAL_RESULTS] ${JSON.stringify({
      userQuery: message,
      selectedTables: ["uploaded_sheets", "sheet_rows", "sheet_columns"],
      tableSchemas: sqliteTableSchemasForDebug(["uploaded_sheets", "sheet_rows", "sheet_columns"]),
      generatedSql: `module filter: ${modules.join(", ")}`,
      rowCountReturned: 0,
      first5ResultRows: [],
    })}`);
    return {
      answer: [
        "**Direct Answer**",
        "I could not find this in the uploaded files.",
        "",
        "**Source Used**",
        `Checked module(s): ${modules.map((module) => SLP_MODULE_LABELS[module]).join(", ")}`,
      ].join("\n"),
      debug: { intent: "row_lookup", filters, selectedModules: modules, selectedColumns, selectedSource, matchedRows: 0, answerType: "no_result" },
    };
  }

  const candidates = filteredSlpRowEntries(selected, filters)
    .map(({ row, source }) => {
      const headers = source.headers || [];
      const idMatch = rowMatchesIdentifiers(row, headers, terms);
      const personMatch = rowMatchesPerson(row, headers, terms.name);
      const score = Math.max(idMatch.score, personMatch.score);
      const type = idMatch.score >= personMatch.score ? idMatch.type : personMatch.type;
      return { row, source, score, type };
    })
    .filter((item) => hasLookupTerm ? item.score >= 82 : true)
    .sort((a, b) => b.score - a.score);

  if (hasLookupTerm && !candidates.length) {
    const checked = selected.map(sourceDisplayName).slice(0, 5);
    console.log(`[SQLITE_RETRIEVAL_RESULTS] ${JSON.stringify({
      userQuery: message,
      selectedTables: ["uploaded_sheets", "sheet_rows", "sheet_columns"],
      tableSchemas: sqliteTableSchemasForDebug(["uploaded_sheets", "sheet_rows", "sheet_columns"]),
      generatedSql: `module filter: ${modules.join(", ")}; filters=${JSON.stringify(filters)}`,
      rowCountReturned: 0,
      first5ResultRows: [],
    })}`);
    return {
      answer: [
        "**Direct Answer**",
        "I could not find this in the uploaded files.",
        "",
        "**Explanation**",
        `Checked ${modules.map((module) => SLP_MODULE_LABELS[module]).join(", ")} using exact IDs/full-name matching and fuzzy full-name matching.`,
        "",
        "**Source Used**",
        ...checked.map((source) => `- ${source}`),
      ].join("\n"),
      debug: { intent: "row_lookup", filters, selectedModules: modules, selectedColumns, selectedSource, matchedRows: 0, answerType: "no_result" },
    };
  }

  if (!hasLookupTerm && /(grant utilization|gur|training).*(conducted|not conducted)|conducted.*(grant utilization|gur|training)/i.test(message)) return null;

  const rows = candidates.slice(0, hasLookupTerm ? 10 : 20).map(({ row, source, score, type }) => {
    const headers = source.headers || [];
    return [
      slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]) || "-",
      slpFullName(row, headers) || "-",
      slpMunicipality(row, headers) || "-",
      slpValue(row, headers, ["Project ID"]) || "-",
      slpValue(row, headers, ["Grant Code", "Grant ID", "Project Code"]) || "-",
      type || "Filtered row match",
      score ? `${score}%` : "-",
      sourceDisplayName(source),
      String(row.__rowNumber || ""),
    ];
  });
  if (!rows.length) return null;
  console.log(`[SQLITE_RETRIEVAL_RESULTS] ${JSON.stringify({
    userQuery: message,
    selectedTables: ["uploaded_sheets", "sheet_rows", "sheet_columns"],
    tableSchemas: sqliteTableSchemasForDebug(["uploaded_sheets", "sheet_rows", "sheet_columns"]),
    generatedSql: `module filter: ${modules.join(", ")}; filters=${JSON.stringify(filters)}`,
    rowCountReturned: candidates.length,
    first5ResultRows: rows.slice(0, 5),
  })}`);

  const directSubject = terms.name || terms.participantId || terms.projectId || terms.grantCode || "the requested record";
  const exactRows = candidates.filter((item) => item.score >= 96);
  const direct = exactRows.length
    ? `I found ${Math.min(exactRows.length, rows.length)} matching row(s) for ${directSubject}.`
    : `I found possible matching row(s) for ${directSubject}. Please review the similarity score before treating it as exact.`;
  return {
    answer: [
      "**Direct Answer**",
      direct,
      "",
      "**Relevant Rows**",
      markdownTable(["Participant ID", "Full Name", "Municipality", "Project ID", "Grant Code", "Match Type", "Similarity", "Source", "Row"], rows),
      "",
      "**Explanation**",
      `Checked only the routed SQLite module(s): ${modules.map((module) => SLP_MODULE_LABELS[module]).join(", ")}.`,
      "Applied exact identifier/full-name matching first, then fuzzy full-name matching.",
      "",
      "**Source Used**",
      ...Array.from(new Set(candidates.slice(0, 5).map((item) => `- ${sourceDisplayName(item.source)}`))),
    ].join("\n"),
    debug: { intent: "row_lookup", filters, selectedModules: modules, selectedColumns, selectedSource, matchedRows: candidates.length, answerType: "row_table" },
  };
}

function formatSlpAnswer(input: { direct: string; tableHeaders?: string[]; tableRows?: string[][]; chart?: any; explanation: string[]; sources: any[]; dataQuality?: string[]; suggested?: string[] }) {
  const sections = ["**Direct Answer**", input.direct, ""];
  if (input.tableHeaders?.length && input.tableRows?.length) sections.push("**Summary Table**", markdownTable(input.tableHeaders, input.tableRows), "");
  if (input.chart) sections.push("**Chart/Graph**", "```slp-chart", JSON.stringify({ charts: [input.chart] }, null, 2), "```", "");
  if (input.explanation.length) sections.push("**Key Insight / Interpretation**", ...input.explanation.map((line) => `- ${line}`), "");
  sections.push("**Source Used**");
  if (input.sources.length) sections.push(...input.sources.map((source) => `- ${SLP_MODULE_LABELS[source.module as SlpModuleTag]}: ${source.source}; columns: ${sourceKeyColumns(source).join(", ") || "headers indexed"}`));
  else sections.push("- None");
  if (input.dataQuality?.length) sections.push("", "**Data Quality Notes**", ...input.dataQuality.map((line) => `- ${line}`));
  if (input.suggested?.length) sections.push("", "**Suggested Next Questions**", ...input.suggested.map((line) => `- ${line}`));
  return sections.join("\n");
}

function stripDiagnosticsPrefix(message: string) {
  return message.replace(/^\s*(?:show\s+)?(?:files checked|source selection|debug|show diagnostics|calculation details)\s*(?:for|of|on|about)?\s*/i, "").trim() || message;
}

function displayQuestionFilters(filters: QuestionFilters) {
  const labels: Array<[keyof QuestionFilters, string]> = [
    ["municipality", "municipality"],
    ["barangay", "barangay"],
    ["year", "year"],
    ["participantType", "participant type"],
    ["pwd", "PWD"],
    ["soloParent", "solo parent"],
    ["sex", "sex"],
    ["status", "status"],
    ["personName", "person name"],
    ["participantId", "SLP Participant ID"],
    ["projectId", "Project ID"],
    ["grantCode", "Grant Code"],
    ["projectType", "project/enterprise type"],
  ];
  return labels
    .filter(([key]) => Boolean(filters[key]))
    .map(([key, label]) => `${label}=${filters[key]}`)
    .join(", ") || "None";
}

function missingModuleAnswer(module: SlpModuleTag) {
  return formatSlpAnswer({
    direct: `The required source for this answer is ${SLP_MODULE_LABELS[module]}, but it is not uploaded or indexed yet.`,
    explanation: ["The fixed SLP source-routing guide selected the required module before calculation."],
    sources: [],
    dataQuality: [`Missing required module: ${SLP_MODULE_LABELS[module]}.`],
  });
}

function missingColumnsAnswer(module: SlpModuleTag, sources: any[], columns: string[]) {
  return formatSlpAnswer({
    direct: `I found ${SLP_MODULE_LABELS[module]}, but could not find required columns: ${columns.join(", ")}.`,
    explanation: ["The source was selected deterministically, then required headers were validated before calculation."],
    sources,
    dataQuality: [`Missing required columns: ${columns.join(", ")}.`],
  });
}

function classifySlpIntent(message: string): string {
  const strict = classifyStrictSlpIntent(message);
  const mapped = legacyIntentFromStrict(strict, message);
  if (mapped) return mapped;
  const lower = normalizeName(message);
  
  // Navigation/diagnostic intents
  if (/show indexed modules/.test(lower)) return "show_indexed_modules";
  if (/show files checked|source selection|debug|check debug/.test(lower)) return "show_files_checked";
  if (/dashboard calculation check|calculation check|calc check|verify dashboard|dashboard metrics? check|check dashboard/.test(lower)) return "dashboard_calculation_check";
  
  // Document/guideline intents
  if (/guidelines?|mc 03|policy|rules|memorandum|slp phases?|implementation phases?|punla|usbong|sibol|yabong|pag ani/.test(lower) || (/(meaning|definition|explain)/.test(lower) && /(guideline|mc 03|policy|rule|omnibus)/.test(lower))) return "guidelines";
  if (/template|tool|form|annex|download|copy|request/.test(lower)) return "template_request";
  if (/proposal|proposed project|project proposal/.test(lower)) return "proposal_request";
  
  // Participant-related intents
  if (/(pwd|person with disabil|disability|4ps|pantawid|non.?4ps|solo parent|female|male|sex|gender|participant type|year served)/.test(lower)) return "total_participants";
  if (/(4ps|pantawid|non.?4ps|pwd|solo parent|female|male)/.test(lower) && /(count|total|number|how many|list|show)/.test(lower)) return "total_participants";
  if (/total participants?|number of participants?|count participants?|beneficiaries|served/.test(lower)) return "total_participants";
  if (/(how many|count|number of|total).*(4ps|non 4ps|served|participant|beneficiar)/.test(lower)) return "total_participants";
  if (/person(?:al)?.*module|participant.*personal|personal.*participant|slpis|slp household/.test(lower)) return "total_participants";
  if (/person|participant|beneficiary|client|person named|person called|individual(?!\s+enterprise)/.test(lower) && /(?:find|lookup|search|is served|served|status|training|grant|project|details)/.test(lower)) return "person_lookup";
  
  // Project/enterprise intents
  if (/project id|project|enterprise|livelihood|hog|fattening|project.*enterprise|enterprise.*project/.test(lower) && /(?:find|lookup|search|status|operational|closed)/.test(lower)) return "project_lookup";
  if (/top\s*10|most implemented|most\s+\w*\s*implemented|enterprise.*type|project.*type|enterprise type|project type/.test(lower)) return "top_enterprise_types";
  if (/total projects?|number of projects?|count projects?|distinct projects?/.test(lower)) return "total_projects";
  if (/individual enterprises?|individual projects?/.test(lower)) return "individual_enterprises";
  if (/association enterprises?|associations?|slpa|group.*enterprise/.test(lower)) return "association_enterprises";
  
  // Grant/financial intents
  if (/grant.*code|grant.*id|project code|grant code/.test(lower) && /(?:find|lookup|search|where|status)/.test(lower)) return "grant_code_lookup";
  if (/grant utilization|gur|grant.*utilization.*report/.test(lower)) return "grant_utilization_status";
  if (/(with|without|conducted|has|not|no).*(?:grant utilization|gur)/.test(lower)) return "grant_utilization_status";
  
  // Training/orientation intents
  if (/training/.test(lower) && /(?:conducted|attended|not conducted|without|with|participated|status|is|training|seminar)/.test(lower)) return "training_status";
  if (/orientation/.test(lower) && /(?:conducted|attended|not conducted|without|with|participated|orientation)/.test(lower)) return "orientation_status";
  if (/trained|participant.*training|who.*trained|training.*participant/.test(lower)) return "training_status";
  
  // Monitoring/status intents
  if (/monitored|visited|served|attended|monitoring|visit|md monitoring/.test(lower) && /participant/.test(lower)) return "participant_monitoring";
  if (/operational|closed/.test(lower) && /municipality/.test(lower)) return "status_by_municipality";
  if (/operational|closed/.test(lower) && /association/.test(lower)) return "association_status";
  if (/operational|closed/.test(lower) && /individual(?!\s+enterprise)/.test(lower)) return "individual_status";
  
  // Analytics intents
  if (/drill.?down|municipality profile|municipality details|municipality.*overview/.test(lower)) return "municipality_drilldown";
  if (/match.*compare|compare.*personal|aurora database|slp dpt|duplicate/.test(lower)) return "match_compare";
  
  return "";
}

function slpIntentModules(intent: string): SlpModuleTag[] {
  const mapping: Record<string, SlpModuleTag[]> = {
    show_indexed_modules: SLP_ALL_DRILLDOWN_MODULES,
    show_files_checked: SLP_ALL_DRILLDOWN_MODULES,
    dashboard_calculation_check: ["PERSONAL", "PROJECT", "MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION", "GRANT_UTILIZATION", "TRAINING", "ORIENTATION"],
    guidelines: ["GUIDELINES_MC03"],
    template_request: [],
    proposal_request: [],
    person_lookup: ["PERSONAL", "PROJECT", "GRANT_UTILIZATION", "TRAINING", "ORIENTATION", "MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"],
    project_lookup: ["PERSONAL", "PROJECT"],
    grant_code_lookup: ["GRANT_UTILIZATION"],
    total_participants: ["PERSONAL"],
    association_enterprises: ["PROJECT"],
    individual_enterprises: ["PROJECT"],
    status_by_municipality: ["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"],
    individual_status: ["MDMONITORING_INDIVIDUAL"],
    association_status: ["MDMONITORING_ASSOCIATION"],
    total_projects: ["PROJECT"],
    top_enterprise_types: ["PROJECT"],
    grant_utilization_status: ["PROJECT", "GRANT_UTILIZATION"],
    training_status: ["TRAINING", "PROJECT", "PERSONAL"],
    orientation_status: ["ORIENTATION", "PROJECT", "PERSONAL"],
    participant_monitoring: ["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"],
    match_compare: ["PERSONAL", "SLP_DPT_DATABASE"],
    municipality_drilldown: SLP_ALL_DRILLDOWN_MODULES,
  };
  return mapping[intent] || [];
}

function composeIndexedModulesAnswer(sources = loadSlpModuleSources()) {
  const rows = sources.map((source: any) => [
    source.fileName || source.file_name || "",
    source.sheetName || source.sheet_name || "",
    source.module,
    String((source.rows || []).length),
    sourceKeyColumns(source).join(", ") || "-",
  ]);
  return formatSlpAnswer({
    direct: `Found ${sources.length} indexed module sheet(s).`,
    tableHeaders: ["File", "Sheet/Page", "Detected Module", "Row Count", "Key Columns"],
    tableRows: rows,
    explanation: ["Detected modules from file name, folder, sheet name, headers, and sample values."],
    sources,
    dataQuality: rows.some((row) => row[2] === "UNKNOWN") ? ["Some sheets could not be confidently mapped to an SLP module."] : [],
    suggested: ["Show files checked", "Total participants", "Total projects"],
  });
}

function composeSlpFilesCheckedAnswer(message: string, routedIntent = classifySlpIntent(message), sources = loadSlpModuleSources()) {
  const diagnosticQuestion = stripDiagnosticsPrefix(message);
  const debugIntent = routedIntent === "show_files_checked"
    ? classifySlpIntent(diagnosticQuestion)
    : routedIntent;
  const requiredByIntent: Record<string, SlpModuleTag[]> = {
    total_participants: ["PERSONAL"],
    association_enterprises: ["PROJECT"],
    individual_enterprises: ["PROJECT"],
    individual_status: ["MDMONITORING_INDIVIDUAL"],
    association_status: ["MDMONITORING_ASSOCIATION"],
    status_by_municipality: ["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"],
    total_projects: ["PROJECT"],
    top_enterprise_types: ["PROJECT"],
    municipality_drilldown: SLP_ALL_DRILLDOWN_MODULES,
    grant_utilization_status: ["PROJECT", "GRANT_UTILIZATION"],
    training_status: ["TRAINING", "PROJECT", "PERSONAL"],
    orientation_status: ["ORIENTATION", "PROJECT", "PERSONAL"],
    participant_monitoring: ["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"],
    match_compare: ["PERSONAL", "SLP_DPT_DATABASE"],
    guidelines: ["GUIDELINES_MC03"],
  };
  const required = requiredByIntent[debugIntent] || [];
  const parsed = parseQuery(diagnosticQuestion);
  const filters = extractStrictFilters(diagnosticQuestion, parsed);

  const rows = sources.map((source: any) => {
    const matched = sourceKeyColumns(source);
    const requiredFound = required.includes(source.module) ? "Required module found" : "Not required for this intent";
    const included = required.length ? required.includes(source.module) : true;
    // Count rows before/after filter for this source
    const allRows = source.rows || [];
    const filteredRows = filterRowsByFilters(allRows, source.headers || [], filters);
    return [
      source.fileName || source.file_name || "",
      source.module,
      source.sheetName || source.sheet_name || "",
      matched.join(", ") || "-",
      displayQuestionFilters(filters),
      requiredFound,
      included ? "Yes" : "No",
      included ? "Selected by fixed SLP source-routing guide." : "Excluded because another module is required for this question.",
      String(allRows.length),
      String(filteredRows.length),
    ];
  });
  return formatSlpAnswer({
    direct: `Files checked for intent: ${debugIntent || routedIntent || "general"}.`,
    tableHeaders: ["File", "Module", "Sheet/Page", "Matched Columns", "Filters Applied", "Required Fields Found/Missing", "Included?", "Reason", "Rows Before", "Rows After"],
    tableRows: rows,
    explanation: ["Generic keyword search is not allowed to override this routing table.", "Filters are applied before counting to ensure accurate results."],
    sources: sources.filter((source: any) => !required.length || required.includes(source.module)),
    dataQuality: required.filter((module) => !sources.some((source: any) => source.module === module)).map((module) => `Missing required source: ${SLP_MODULE_LABELS[module]}.`),
  });
}

function composeDashboardCalculationCheckAnswer(message: string, sources = loadSlpModuleSources()) {
  const parsed = parseQuery(message);
  const filters = extractStrictFilters(message, parsed);
  const personal = sourcesForModules(sources, ["PERSONAL"]);
  const project = sourcesForModules(sources, ["PROJECT"]);
  const mdInd = sourcesForModules(sources, ["MDMONITORING_INDIVIDUAL"]);
  const mdAssn = sourcesForModules(sources, ["MDMONITORING_ASSOCIATION"]);
  const gur = sourcesForModules(sources, ["GRANT_UTILIZATION"]);
  const training = sourcesForModules(sources, ["TRAINING"]);
  const orientation = sourcesForModules(sources, ["ORIENTATION"]);

  // Helper to compute before/after using each row's own headers for filtering
  const computeBeforeAfter = (rows: any[], keyFn: (row: any, hdrs: string[]) => string) => {
    const before = rows.length;
    const filtered = rows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
    const keys = new Set<string>();
    for (const item of filtered) {
      const k = keyFn(item.row, item.source.headers || []);
      if (k) keys.add(k);
    }
    return [before, filtered.length, keys.size];
  };

  const [pBefore, pAfter, pUnique] = computeBeforeAfter(slpRows(personal), (r, h) => slpParticipantKey(r, h));
  const [projBefore, projAfter, projUnique] = computeBeforeAfter(slpRows(project), (r, h) => slpProjectKey(r, h));
  const [mdBefore, mdAfter, mdUnique] = computeBeforeAfter([...slpRows(mdInd), ...slpRows(mdAssn)], (r, h) => slpProjectKey(r, h) || dashboardRowKey([slpFullName(r, h), slpProjectName(r, h), slpMunicipality(r, h)]));
  const projectKindCounts = countAssociationsAndIndividualEnterprises(project, filters);
  const gurCounts = countGrantUtilizationConducted(project, gur, filters);
  const trainingCounts = countTrainingConducted(sourcesForModules(sources, ["PERSONAL"]), training, filters);
  const orientationCounts = countTrainingConducted(sourcesForModules(sources, ["PERSONAL"]), orientation, filters);

  const rowsTab: string[][] = [
    ["Total Participants", "Personal Module", "SLP Participant ID / Participant ID", Object.values(filters).filter(Boolean).join(", ") || "None", String(pBefore), String(pAfter), String(pUnique), "Deduplicated by ID or full name+muni+barangay"],
    ["Total Projects", "Project Module", "Project ID", Object.values(filters).filter(Boolean).join(", ") || "None", String(projBefore), String(projAfter), String(projUnique), "Deduplicated by Project ID"],
    ["Associations", "Project Module", "Project ID (appears >1)", Object.values(filters).filter(Boolean).join(", ") || "None", String(projBefore), String(projAfter), String(projectKindCounts.associations), "Count of project keys with >1 row after filter"],
    ["Individual Enterprises", "Project Module", "Project ID (appears =1)", Object.values(filters).filter(Boolean).join(", ") || "None", String(projBefore), String(projAfter), String(projectKindCounts.individual), "Count of project keys with exactly 1 row after filter"],
    ["Operational / Closed", "MDMonitoring Individual+Association", "Project ID / composite", Object.values(filters).filter(Boolean).join(", ") || "None", String(mdBefore), String(mdAfter), String(mdUnique), "Status determined from Enterprise Status field"],
    ["Grant Utilization Conducted", "Project vs Grant Utilization", "Project ID > Grant Code > composite", Object.values(filters).filter(Boolean).join(", ") || "None", String(projBefore), String(projAfter), String(gurCounts.conducted), "Project rows matched to any GUR record"],
    ["Training Conducted", "Project/Personal vs Training", "SLP Participant ID", Object.values(filters).filter(Boolean).join(", ") || "None", String(pBefore), String(pAfter), String(trainingCounts.conducted), "Filtered participants matched to Training records"],
    ["Orientation Conducted", "Project/Personal vs Orientation", "SLP Participant ID", Object.values(filters).filter(Boolean).join(", ") || "None", String(pBefore), String(pAfter), String(orientationCounts.conducted), "Filtered participants matched to Orientation records"],
  ];

  logDebugInfo({
    intent: "dashboard_calculation_check",
    modules: ["PERSONAL", "PROJECT", "MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION", "GRANT_UTILIZATION", "TRAINING", "ORIENTATION"],
    columns: selectedColumnsForSources([...personal, ...project, ...mdInd, ...mdAssn, ...gur, ...training, ...orientation]),
    matched: pAfter + projAfter + mdAfter,
    selected: [...new Set([...personal, ...project, ...mdInd, ...mdAssn, ...gur, ...training, ...orientation].map(sourceDisplayName))].slice(0, 5).join("; "),
    reason: "Verified dashboard metric counts using deterministic row-level filtering and deduplication.",
  });

  return formatSlpAnswer({
    direct: "Dashboard metric calculation check — filters applied deterministically before counting.",
    tableHeaders: ["Metric", "Source Module", "Key Used", "Filters Applied", "Rows Before Filter", "Rows After Filter", "Unique Count", "Notes"],
    tableRows: rowsTab,
    explanation: [
      "All numeric results are computed from SQLite rows using deterministic TypeScript Set/Map deduplication.",
      "Filters (municipality, year, type, status) are applied BEFORE counting.",
      "No final number is guessed by GitHub Models; models only plan, verify, select chart type, or rewrite explanation.",
    ],
    sources: sources,
    dataQuality: [],
    suggested: ["Show indexed modules", "Show files checked", "Total participants"],
  });
}


function requireSlpSources(sources: any[], modules: SlpModuleTag[]) {
  const selected = sourcesForModules(sources, modules);
  const missing = modules.find((module) => !selected.some((source) => source.module === module));
  return { selected, missing };
}

function countProjectModuleByKind(sources: any[], kind: "association" | "individual") {
  const projectRows = new Map<string, { rows: any[]; projectId: string }>();
  for (const { row, source } of slpRows(sources)) {
    const headers = source.headers || [];
    const projectKey = slpProjectKey(row, headers);
    if (!projectKey) continue;
    const projectId = normalizeName(slpValue(row, headers, ["Project ID"]));
    if (!projectRows.has(projectKey)) projectRows.set(projectKey, { rows: [], projectId });
    projectRows.get(projectKey)!.rows.push({ row, source, projectId });
  }

  const rows: string[][] = [];
  let count = 0;
  for (const [key, entry] of projectRows.entries()) {
    const isAssociation = entry.projectId ? entry.rows.length > 1 : entry.rows.length > 1;
    const isIndividual = !isAssociation;
    if ((kind === "association" && !isAssociation) || (kind === "individual" && !isIndividual)) continue;
    count += 1;
    const first = entry.rows[0];
    const headers = first.source.headers || [];
    rows.push([
      slpProjectName(first.row, headers),
      slpMunicipality(first.row, headers) || "-",
      slpValue(first.row, headers, ["Project ID"]) || "-",
      slpValue(first.row, headers, ["Enterprise Type"]) || "-",
    ]);
  }
  return { count, rows };
}

function collectParticipantKeys(sources: any[]) {
  const participants = new Map<string, { id: string; fullName: string; municipality: string; barangay: string }>();
  for (const { row, source } of slpRows(sources)) {
    const headers = source.headers || [];
    const key = slpParticipantKey(row, headers);
    if (!key) continue;
    if (!participants.has(key)) {
      participants.set(key, {
        id: slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]),
        fullName: slpFullName(row, headers),
        municipality: slpMunicipality(row, headers),
        barangay: slpValue(row, headers, ["Barangay", "Brgy"]),
      });
    }
  }
  return participants;
}

function composeParticipantTrainingStatus(participantSources: any[], trainingSources: any[]) {
  const trainingKeys = new Set<string>();
  const trainingDetails = new Map<string, string>();
  for (const { row, source } of slpRows(trainingSources)) {
    const headers = source.headers || [];
    const participantId = slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]);
    const fullName = slpFullName(row, headers);
    const municipality = slpMunicipality(row, headers);
    const barangay = slpValue(row, headers, ["Barangay", "Brgy"]);
    const detail = [slpValue(row, headers, ["Training Title", "Training Title 1", "Training Batch Name", "Type"]), slpValue(row, headers, ["Training Date", "Date"])].filter(Boolean).join(" / ") || "Training record found";
    const keys = [participantId, normalizeName([fullName, municipality, barangay].join("|"))].filter(Boolean).map(normalizeName);
    for (const key of keys) {
      trainingKeys.add(key);
      if (!trainingDetails.has(key)) trainingDetails.set(key, detail);
    }
  }

  const participants = collectParticipantKeys(participantSources);
  let conducted = 0;
  let notConducted = 0;
  const sampleRows: string[][] = [];

  for (const [key, participant] of participants.entries()) {
    const participantId = participant.id;
    const nameKey = normalizeName([participant.fullName, participant.municipality, participant.barangay].join("|"));
    const keys = [normalizeName(participantId), nameKey].filter(Boolean);
    const matchedKey = keys.find((candidate) => candidate && trainingKeys.has(candidate));
    if (matchedKey) conducted += 1;
    else notConducted += 1;
    if (sampleRows.length < 50) {
      sampleRows.push([participant.id || participant.fullName || "-", participant.municipality || "-", matchedKey ? "Training Conducted" : "No Training Conducted", matchedKey ? trainingDetails.get(matchedKey) || "-" : "-"]);
    }
  }

  return {
    conducted,
    notConducted,
    rows: [["Training Conducted", String(conducted)], ["No Training Conducted", String(notConducted)]],
    sampleRows,
  };
}

function composeParticipantOrientationStatus(participantSources: any[], orientationSources: any[]) {
  const orientationKeys = new Set<string>();
  for (const { row, source } of slpRows(orientationSources)) {
    const headers = source.headers || [];
    const participantId = slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]);
    const fullName = slpFullName(row, headers);
    const municipality = slpMunicipality(row, headers);
    const barangay = slpValue(row, headers, ["Barangay", "Brgy"]);
    const key = participantId ? normalizeName(participantId) : normalizeName([fullName, municipality, barangay].join("|"));
    if (!key) continue;
    orientationKeys.add(key);
  }

  const participants = collectParticipantKeys(participantSources);
  let conducted = 0;
  let notConducted = 0;
  const sampleRows: string[][] = [];

  for (const [key, participant] of participants.entries()) {
    const participantKeys = [normalizeName(participant.id), normalizeName([participant.fullName, participant.municipality, participant.barangay].join("|"))].filter(Boolean);
    const matched = participantKeys.some((candidate) => orientationKeys.has(candidate));
    if (matched) conducted += 1;
    else notConducted += 1;
    if (sampleRows.length < 50) {
      sampleRows.push([participant.id || participant.fullName || "-", participant.municipality || "-", matched ? "Orientation Conducted" : "No Orientation Conducted", matched ? "Orientation record found" : "-"]);
    }
  }

  return {
    conducted,
    notConducted,
    rows: [["Orientation Conducted", String(conducted)], ["No Orientation Conducted", String(notConducted)]],
    sampleRows,
  };
}

function composeParticipantMonitoringStatus(sources: any[]) {
  const participants = collectParticipantKeys(sources);
  return {
    count: participants.size,
    rows: Array.from(participants.values()).slice(0, 50).map((participant) => [participant.id || participant.fullName || "-", participant.municipality || "-", participant.barangay || "-"]),
  };
}

function countStatusFromMonitoring(sources: any[], groupByMunicipality = false) {
  const byProject = new Map<string, { status: string; municipality: string }>();
  for (const { row, source } of slpRows(sources)) {
    const headers = source.headers || [];
    const key = slpProjectKey(row, headers) || dashboardRowKey([slpFullName(row, headers), slpProjectName(row, headers), slpMunicipality(row, headers)]);
    const rawStatus = slpValue(row, headers, ["Enterprise Status", "Livelihood Status", "Project Status", "Status"]);
    const status = classifyEnterpriseStatus(rawStatus);
    const municipality = slpMunicipality(row, headers) || "Unspecified";
    if (!key) continue;
    const existing = byProject.get(key);
    if (!existing || existing.status === "inactive" || (existing.status === "operational" && status === "closed")) byProject.set(key, { status, municipality });
  }
  if (groupByMunicipality) {
    const byMuni = new Map<string, { operational: number; closed: number; unknown: number }>();
    for (const { status, municipality } of byProject.values()) {
      const item = byMuni.get(municipality) || { operational: 0, closed: 0, unknown: 0 };
      if (status === "operational") item.operational += 1;
      else if (status === "closed") item.closed += 1;
      else item.unknown += 1;
      byMuni.set(municipality, item);
    }
    return { byProject, rows: Array.from(byMuni.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([municipality, item]) => [municipality, String(item.operational), String(item.closed), String(item.unknown), String(item.operational + item.closed + item.unknown)]) };
  }
  const operational = Array.from(byProject.values()).filter((item) => item.status === "operational").length;
  const closed = Array.from(byProject.values()).filter((item) => item.status === "closed").length;
  const unknown = byProject.size - operational - closed;
  return { byProject, rows: [["Operational", String(operational)], ["Closed", String(closed)], ["Pending/Unknown", String(unknown)]] };
}

function composeGrantUtilizationStatus(projectSources: any[], gurSources: any[]) {
  const gurKeys = new Set<string>();
  for (const { row, source } of slpRows(gurSources)) {
    const headers = source.headers || [];
    [slpValue(row, headers, ["Project ID"]), slpValue(row, headers, ["Grant Code"]), normalizeName([slpProjectName(row, headers), slpMunicipality(row, headers)].join("|"))].filter(Boolean).forEach((key) => gurKeys.add(normalizeName(key)));
  }
  const projectSeen = new Set<string>();
  const byMuni = new Map<string, { conducted: number; notConducted: number }>();
  let conducted = 0, notConducted = 0;
  for (const { row, source } of slpRows(projectSources)) {
    const headers = source.headers || [];
    const projectKey = slpProjectKey(row, headers);
    if (!projectKey || projectSeen.has(projectKey)) continue;
    projectSeen.add(projectKey);
    const matchKeys = [slpValue(row, headers, ["Project ID"]), slpValue(row, headers, ["Grant Code"]), normalizeName([slpProjectName(row, headers), slpMunicipality(row, headers)].join("|"))].filter(Boolean).map(normalizeName);
    const hasGur = matchKeys.some((key) => gurKeys.has(key));
    if (hasGur) conducted += 1; else notConducted += 1;
    const muni = slpMunicipality(row, headers) || "Unspecified";
    const item = byMuni.get(muni) || { conducted: 0, notConducted: 0 };
    if (hasGur) item.conducted += 1; else item.notConducted += 1;
    byMuni.set(muni, item);
  }
  return {
    conducted,
    notConducted,
    rows: Array.from(byMuni.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([municipality, item]) => [municipality, String(item.conducted), String(item.notConducted), String(item.conducted + item.notConducted)]),
  };
}

function composeTrainingStatus(projectSources: any[], trainingSources: any[]) {
  const trainingKeys = new Set<string>();
  const trainingDetails = new Map<string, string>();
  for (const { row, source } of slpRows(trainingSources)) {
    const headers = source.headers || [];
    const keys = [
      slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]),
      normalizeName([slpFullName(row, headers), slpMunicipality(row, headers), slpValue(row, headers, ["Barangay"])].join("|")),
    ].filter(Boolean).map(normalizeName);
    const detail = [slpValue(row, headers, ["Training Title 1", "Training Batch Name", "Type"]), slpValue(row, headers, ["Training Date"])].filter(Boolean).join(" / ") || "Training record found";
    keys.forEach((key) => { trainingKeys.add(key); if (!trainingDetails.has(key)) trainingDetails.set(key, detail); });
  }
  const participantSeen = new Set<string>();
  let conducted = 0, notConducted = 0;
  const sampleRows: string[][] = [];
  for (const { row, source } of slpRows(projectSources)) {
    const headers = source.headers || [];
    const participantKey = slpParticipantKey(row, headers);
    if (!participantKey || participantSeen.has(participantKey)) continue;
    participantSeen.add(participantKey);
    const participantId = slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]);
    const fullName = participantId ? "" : slpFullName(row, headers);
    const keys = [
      participantId,
      normalizeName([fullName, slpMunicipality(row, headers), slpValue(row, headers, ["Barangay"])].join("|")),
    ].filter(Boolean).map(normalizeName);
    const matchedKey = keys.find((key) => trainingKeys.has(key));
    if (matchedKey) conducted += 1; else notConducted += 1;
    if (sampleRows.length < 50) sampleRows.push([participantId || fullName || "-", slpMunicipality(row, headers) || "-", matchedKey ? "Training Conducted" : "No Training Conducted", matchedKey ? trainingDetails.get(matchedKey) || "-" : "-"]);
  }
  return { conducted, notConducted, rows: [["Training Conducted", String(conducted)], ["No Training Conducted", String(notConducted)]], sampleRows };
}

function normalizeForNameMatch(name: string): string {
  return normalizeName(name)
    .replace(/\./g, "")           // remove periods (for initials)
    .replace(/\b(jr|sr|ii|iii|iv)\b/gi, "") // remove suffixes
    .replace(/\s+/g, " ")         // collapse spaces
    .trim();
}

function fullNameScore(a: string, b: string): number {
  return fullNameScoreVariant(a, b);
}

function composeMatchCompare(personalSources: any[], dptSources: any[]) {
  const dptExact = new Set<string>();
  const dptNames: string[] = [];
  for (const { row, source } of slpRows(dptSources)) {
    const headers = source.headers || [];
    [slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]), slpValue(row, headers, ["Grant Code"])].filter(Boolean).forEach((key) => dptExact.add(normalizeName(key)));
    const full = slpFullName(row, headers);
    const muni = slpMunicipality(row, headers);
    const brgy = slpValue(row, headers, ["Barangay"]);
    if (full.split(" ").length >= 2) dptNames.push(normalizeForNameMatch([full, muni, brgy].join("|")));
  }
  let matched = 0, unmatched = 0, possible = 0;
  const results: Array<{ inputName: string; matchedName: string; score: number; status: string; municipality: string; barangay: string; source: string }> = [];
  for (const { row, source } of slpRows(personalSources)) {
    const headers = source.headers || [];
    const stableKeys = [slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]), slpValue(row, headers, ["Grant Code"])].filter(Boolean).map(normalizeName);
    const inputFull = slpFullName(row, headers);
    const muni = slpMunicipality(row, headers);
    const brgy = slpValue(row, headers, ["Barangay"]);
    const inputNorm = normalizeForNameMatch(inputFull);
    let rowMatched = false;
    let rowPossible = false;
    let bestMatch = "";
    let bestScore = 0;
    if (stableKeys.some((key) => dptExact.has(key))) {
      matched += 1; rowMatched = true;
    } else {
      const composite = normalizeForNameMatch([inputFull, muni, brgy].join("|"));
      const exactIdx = dptNames.findIndex((name) => name === composite);
      if (exactIdx >= 0) { matched += 1; rowMatched = true; bestMatch = dptNames[exactIdx]; bestScore = 100; }
      else {
        // fuzzy compare against each DPT name
        for (const dptName of dptNames) {
          const score = fullNameScore(composite, dptName);
          if (score >= 90) { matched += 1; rowMatched = true; bestScore = score; bestMatch = dptName; break; }
          else if (score >= 80) { rowPossible = true; bestScore = score; bestMatch = dptName; }
        }
        if (!rowMatched && rowPossible) { possible += 1; }
        else if (!rowMatched && !rowPossible) { unmatched += 1; }
      }
    }
    const status = rowMatched ? "Duplicate (100%)" : rowPossible ? `Possible Duplicate (${Math.round(bestScore)}%)` : "Not Duplicate";
    results.push({ inputName: inputFull, matchedName: bestMatch || "-", score: Math.round(bestScore), status, municipality: muni || "-", barangay: brgy || "-", source: source.source });
  }
  // Build summary rows from results
  const summaryRows: string[][] = [
    ["Matched (Exact or ≥90%)", String(results.filter(r => r.status.startsWith("Duplicate")).length)],
    ["Possible Duplicate (80–89%)", String(results.filter(r => r.status.startsWith("Possible")).length)],
    ["Not Duplicate", String(results.filter(r => r.status === "Not Duplicate").length)],
  ];
  return { matched, possible, unmatched, rows: summaryRows, results };
}

async function composeGuidelinesMc03Answer(message: string, parsed: ParsedQuery, sources = loadSlpModuleSources()) {
  const guidelineSheets = sourcesForModules(sources, ["GUIDELINES_MC03"]);
  const docs = (await loadDocumentTextSources([])).filter((source: any) => {
    const label = normalizeName(`${source.folder || ""} ${source.file_name || source.fileName || ""} ${String(source.content_text || "").slice(0, 1000)}`);
    return /\bmc\s*03\b|mc03|guidelines?/.test(label);
  });
  if (!guidelineSheets.length && !docs.length) return missingModuleAnswer("GUIDELINES_MC03");
  if (docs.length) {
    const answer = await answerFromDocumentText(message, { ...parsed, docType: "guideline", intentType: "explanation/definition" }, []);
    return isNoUploadedSourceAnswer(answer) ? missingModuleAnswer("GUIDELINES_MC03") : answer;
  }
  return formatSlpAnswer({
    direct: "MC 03 Guidelines content is indexed as spreadsheet rows, but no extracted guideline document text was found. Please upload or index the MC 03 Guidelines document/text for policy questions.",
    explanation: ["Guideline questions are routed to MC 03 Guidelines first and are not answered from operational spreadsheet rows."],
    sources: guidelineSheets,
    dataQuality: ["No extracted MC 03 document text was available."],
  });
}

async function composeSlpRoutedAnswer(message: string, parsed: ParsedQuery, attachmentIds: string[] = [], sources = loadSlpModuleSources({ attachmentIds: attachmentIds.length ? attachmentIds : undefined })) {
  const intent = classifySlpIntent(message);
  if (!intent) return null;
  const intentModules = slpIntentModules(intent);
  const debugSources = intentModules.length ? sourcesForModules(sources, intentModules) : sources;
  logDebugInfo({
    intent: intent,
    modules: intentModules.length ? intentModules : Array.from(new Set(sources.map((source) => source.module))) as SlpModuleTag[],
    columns: selectedColumnsForSources(debugSources),
    matched: debugSources.flatMap((source) => source.rows || []).length,
    selected: debugSources.map(sourceDisplayName).slice(0, 5).join("; ") || "None",
    reason: "SLP intent routed; candidate sources selected by fixed intent routing.",
  });
  if (intent === "show_indexed_modules") return composeIndexedModulesAnswer(sources);
  if (intent === "show_files_checked") return composeSlpFilesCheckedAnswer(message, intent, sources);
  if (intent === "dashboard_calculation_check") return composeDashboardCalculationCheckAnswer(message, sources);
  if (intent === "guidelines") return composeGuidelinesMc03Answer(message, parsed, sources);

  const requireModules = (modules: SlpModuleTag[]) => {
    const check = requireSlpSources(sources, modules);
    return check.missing ? { error: missingModuleAnswer(check.missing), selected: check.selected } : { error: "", selected: check.selected };
  };

  if (intent === "total_participants") {
    const { error, selected } = requireModules(["PERSONAL"]); if (error) return error;
    const usableSources = selected.filter((s) => (s.rows || []).length && sourceKeyColumns(s).some((c) => /participant|name/i.test(c)));
    const missing = usableSources.length ? [] : ["Participant ID or Full Name"];
    if (missing.length) return missingColumnsAnswer("PERSONAL", selected, missing);
    const parsed = parseQuery(message);
    const filters = extractStrictFilters(message, parsed);
    const missingFilterColumns = findParticipantFilterMissingColumns(usableSources, filters);
    if (missingFilterColumns.length) {
      const direct = missingFilterColumns.includes("PWD column")
        ? "PWD column was not found in Personal Module."
        : `${missingFilterColumns.join(", ")} was not found in Personal Module.`;
      return formatSlpAnswer({
        direct,
        explanation: ["The question was routed to Personal Module, but the required filter column was missing."],
        sources: usableSources,
        dataQuality: missingFilterColumns.map((column) => `Missing required filter column: ${column}.`),
      });
    }
    const allRows = slpRows(usableSources);
    const filteredRows = allRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
    const keys = new Set(filteredRows.map(({ row, source }) => slpParticipantKey(row, source.headers || [])).filter(Boolean));
    if (!keys.size) {
      if (filters.pwd || filters.participantType || filters.soloParent || filters.sex) {
        return formatSlpAnswer({
          direct: `${filters.pwd ? "PWD participants" : filters.participantType ? `${filters.participantType} participants` : filters.soloParent ? "Solo parent participants" : `${filters.sex} participants`}: 0.`,
          explanation: ["Used Personal Module only.", "The required participant filter column was found, but no rows matched the requested value."],
          sources: usableSources,
        });
      }
      return formatSlpAnswer({
        direct: "No matching participants found.",
        tableHeaders: ["Filters Applied", "Value"],
        tableRows: Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [k, String(v)]),
        explanation: ["No participants matched the specified municipality, year, type, or status filters."],
        sources: usableSources,
        suggested: ["Show all participants", "Adjust filters", "Show files checked"],
      });
    }
    const participantLocation = filters.barangay ? ` in barangay ${filters.barangay}` : filters.municipality ? ` in ${filters.municipality}` : "";
    return formatSlpAnswer({
      direct: `${filters.pwd ? "PWD participants" : filters.participantType ? `${filters.participantType} participants` : filters.soloParent ? "Solo parent participants" : filters.sex ? `${filters.sex} participants` : "Total participants"}${participantLocation}: ${keys.size}.`,
      explanation: ["Used Personal Module only.", "Counted distinct participant IDs first, then full name plus municipality/barangay when IDs were missing.", "Filters applied before counting."],
      sources: usableSources,
    });
  }

  if (intent === "association_enterprises" || intent === "individual_enterprises") {
    const { error, selected } = requireModules(["PROJECT"]); if (error) return error;
    const kind = intent === "association_enterprises" ? "association" : "individual";
    const parsed = parseQuery(message);
    const filters = extractStrictFilters(message, parsed);
    const allRows = slpRows(selected);
    const filteredRows = allRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
    // Build projectRows map from filtered rows only
    const projectRows = new Map<string, { rows: any[]; projectId: string }>();
    for (const { row, source } of filteredRows) {
      const headers = source.headers || [];
      const projectKey = slpProjectKey(row, headers);
      if (!projectKey) continue;
      const projectId = normalizeName(slpValue(row, headers, ["Project ID"]));
      if (!projectRows.has(projectKey)) projectRows.set(projectKey, { rows: [], projectId });
      projectRows.get(projectKey)!.rows.push({ row, source, projectId });
    }
    const rows: string[][] = [];
    let count = 0;
    for (const [key, entry] of projectRows.entries()) {
      const isAssociation = entry.projectId ? entry.rows.length > 1 : entry.rows.length > 1;
      const isIndividual = !isAssociation;
      if ((kind === "association" && !isAssociation) || (kind === "individual" && !isIndividual)) continue;
      count += 1;
      const first = entry.rows[0];
      const headers = first.source.headers || [];
      rows.push([
        slpProjectName(first.row, headers),
        slpMunicipality(first.row, headers) || "-",
        slpValue(first.row, headers, ["Project ID"]) || "-",
        slpValue(first.row, headers, ["Enterprise Type"]) || "-",
      ]);
    }
    if (!count) {
      return formatSlpAnswer({
        direct: `No ${kind} enterprises found matching the filters.`,
        tableHeaders: ["Filters Applied", "Value"],
        tableRows: Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [k, String(v)]),
        explanation: [`No ${kind} enterprises matched the specified municipality, year, type, or status filters.`],
        sources: selected,
        suggested: ["Show all enterprises", "Adjust filters", "Show files checked"],
      });
    }
    return formatSlpAnswer({
      direct: `Total ${kind === "association" ? "association enterprises/associations" : "individual enterprises"}: ${count}.`,
      tableHeaders: ["Project/Enterprise", "Municipality", "Project ID", "Enterprise Type"],
      tableRows: rows.slice(0, 20),
      explanation: ["Used Project Module only.", "Association enterprises and Association are treated as the same term.", "Rows with the same Project ID are counted as one project.", "Filters applied before counting."],
      sources: selected,
      suggested: ["Total projects", "Top 10 enterprise/project types", "Break it down by municipality"],
    });
  }

  if (intent === "status_by_municipality") {
    const modules: SlpModuleTag[] = ["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"];
    const { error, selected } = requireModules(modules); if (error) return error;
    const parsed = parseQuery(message);
    const filters = extractStrictFilters(message, parsed);
    const allRows = slpRows(selected);
    const headers = selected[0]?.headers || [];
    const filteredRows = allRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
    const byProject = new Map<string, { status: string; municipality: string }>();
    for (const { row, source } of filteredRows) {
      const hdrs = source.headers || [];
      const key = slpProjectKey(row, hdrs) || dashboardRowKey([slpFullName(row, hdrs), slpProjectName(row, hdrs), slpMunicipality(row, hdrs)]);
      const rawStatus = slpValue(row, hdrs, ["Enterprise Status", "Livelihood Status", "Project Status", "Status"]);
      const status = classifyEnterpriseStatus(rawStatus);
      const municipality = slpMunicipality(row, hdrs) || "Unspecified";
      if (!key) continue;
      const existing = byProject.get(key);
      if (!existing || existing.status === "inactive" || (existing.status === "operational" && status === "closed")) byProject.set(key, { status, municipality });
    }
    const byMuni = new Map<string, { operational: number; closed: number; unknown: number }>();
    for (const { status, municipality } of byProject.values()) {
      const item = byMuni.get(municipality) || { operational: 0, closed: 0, unknown: 0 };
      if (status === "operational") item.operational += 1;
      else if (status === "closed") item.closed += 1;
      else item.unknown += 1;
      byMuni.set(municipality, item);
    }
    if (!byProject.size) {
      return formatSlpAnswer({
        direct: "No enterprise status found matching the filters.",
        explanation: ["No monitoring records matched the specified municipality, year, type, or status."],
        sources: selected,
      });
    }
    const sortedStatusRows = Array.from(byMuni.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([municipality, item]) => [municipality, String(item.operational), String(item.closed), String(item.unknown), String(item.operational + item.closed + item.unknown)]);
    const singleMuni = filters.municipality && byMuni.get(filters.municipality);
    const specificCount = filters.status && singleMuni
      ? filters.status === "closed" ? singleMuni.closed
        : filters.status === "operational" ? singleMuni.operational
        : singleMuni.unknown
      : null;
    const direct = specificCount !== null
      ? `${filters.municipality} has ${specificCount} ${filters.status} project${specificCount === 1 ? "" : "s"}.`
      : "Operational vs Closed by Municipality was calculated from both MDMonitoring sources.";
    return formatSlpAnswer({
      direct,
      tableHeaders: filters.municipality ? undefined : ["Municipality", "Operational", "Closed", "Pending/Unknown", "Total"],
      tableRows: filters.municipality ? undefined : sortedStatusRows,
      chart: filters.municipality ? undefined : { type: "stackedBar", title: "Operational vs Closed by Municipality", data: Array.from(byMuni.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([municipality, item]) => ({ name: municipality, operational: item.operational, closed: item.closed, unknown: item.unknown })) },
      explanation: filters.municipality
        ? [`Checked MDMonitoring Individual and Association for ${filters.municipality}.`, "Counted distinct Project ID/status keys after applying the status filter."]
        : ["Combined MDMonitoring Individual and MDMonitoring Association, then grouped by municipality.", "Counted distinct Project ID/status keys instead of raw duplicate rows."],
      sources: selected,
    });
  }

  if (intent === "individual_status") {
    const modules: SlpModuleTag[] = ["MDMONITORING_INDIVIDUAL"];
    const { error, selected } = requireModules(modules); if (error) return error;
    const parsed = parseQuery(message);
    const filters = extractStrictFilters(message, parsed);
    const allRows = slpRows(selected);
    const headers = selected[0]?.headers || [];
    const filteredRows = allRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
    const byProject = new Map<string, { status: string; municipality: string }>();
    for (const { row, source } of filteredRows) {
      const hdrs = source.headers || [];
      const key = slpProjectKey(row, hdrs) || dashboardRowKey([slpFullName(row, hdrs), slpProjectName(row, hdrs), slpMunicipality(row, hdrs)]);
      const rawStatus = slpValue(row, hdrs, ["Enterprise Status", "Livelihood Status", "Project Status", "Status"]);
      const status = classifyEnterpriseStatus(rawStatus);
      const municipality = slpMunicipality(row, hdrs) || "Unspecified";
      if (!key) continue;
      const existing = byProject.get(key);
      if (!existing || existing.status === "inactive" || (existing.status === "operational" && status === "closed")) byProject.set(key, { status, municipality });
    }
    const operational = Array.from(byProject.values()).filter((item) => item.status === "operational").length;
    const closed = Array.from(byProject.values()).filter((item) => item.status === "closed").length;
    const unknown = byProject.size - operational - closed;
    if (!byProject.size) {
      return formatSlpAnswer({
        direct: "No individual enterprise status found matching the filters.",
        explanation: ["No individual monitoring records matched the specified municipality, year, type, or status."],
        sources: selected,
      });
    }
    const requestedStatusCount = filters.status === "closed" ? closed : filters.status === "operational" ? operational : null;
    return formatSlpAnswer({
      direct: requestedStatusCount !== null && filters.municipality
        ? `${filters.municipality} has ${requestedStatusCount} ${filters.status} individual enterprise project${requestedStatusCount === 1 ? "" : "s"}.`
        : `Operational and closed counts for individual enterprises from ${SLP_MODULE_LABELS[modules[0]]}.`,
      tableHeaders: requestedStatusCount !== null ? undefined : ["Status", "Count"],
      tableRows: requestedStatusCount !== null ? undefined : [["Operational", String(operational)], ["Closed", String(closed)], ["Pending/Unknown", String(unknown)]],
      chart: { type: "kpi", title: "Operational vs Closed — Individual", data: [["Operational", operational], ["Closed", closed], ["Pending/Unknown", unknown]].map(([k, v]) => ({ name: k, value: v })) },
      explanation: ["Used MDMonitoring Individual module only.", "Counted distinct project keys by enterprise status.", "Filters applied before counting."],
      sources: selected,
    });
  }

  if (intent === "association_status") {
    const modules: SlpModuleTag[] = ["MDMONITORING_ASSOCIATION"];
    const { error, selected } = requireModules(modules); if (error) return error;
    const parsed = parseQuery(message);
    const filters = extractStrictFilters(message, parsed);
    const allRows = slpRows(selected);
    const headers = selected[0]?.headers || [];
    const filteredRows = allRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
    const byProject = new Map<string, { status: string; municipality: string }>();
    for (const { row, source } of filteredRows) {
      const hdrs = source.headers || [];
      const key = slpProjectKey(row, hdrs) || dashboardRowKey([slpFullName(row, hdrs), slpProjectName(row, hdrs), slpMunicipality(row, hdrs)]);
      const rawStatus = slpValue(row, hdrs, ["Enterprise Status", "Livelihood Status", "Project Status", "Status"]);
      const status = classifyEnterpriseStatus(rawStatus);
      const municipality = slpMunicipality(row, hdrs) || "Unspecified";
      if (!key) continue;
      const existing = byProject.get(key);
      if (!existing || existing.status === "inactive" || (existing.status === "operational" && status === "closed")) byProject.set(key, { status, municipality });
    }
    const operational = Array.from(byProject.values()).filter((item) => item.status === "operational").length;
    const closed = Array.from(byProject.values()).filter((item) => item.status === "closed").length;
    const unknown = byProject.size - operational - closed;
    if (!byProject.size) {
      return formatSlpAnswer({
        direct: "No association enterprise status found matching the filters.",
        explanation: ["No association monitoring records matched the specified municipality, year, type, or status."],
        sources: selected,
      });
    }
    const requestedStatusCount = filters.status === "closed" ? closed : filters.status === "operational" ? operational : null;
    return formatSlpAnswer({
      direct: requestedStatusCount !== null && filters.municipality
        ? `${filters.municipality} has ${requestedStatusCount} ${filters.status} association enterprise project${requestedStatusCount === 1 ? "" : "s"}.`
        : `Operational and closed counts for associations from ${SLP_MODULE_LABELS[modules[0]]}.`,
      tableHeaders: requestedStatusCount !== null ? undefined : ["Status", "Count"],
      tableRows: requestedStatusCount !== null ? undefined : [["Operational", String(operational)], ["Closed", String(closed)], ["Pending/Unknown", String(unknown)]],
      chart: { type: "kpi", title: "Operational vs Closed — Associations", data: [["Operational", operational], ["Closed", closed], ["Pending/Unknown", unknown]].map(([k, v]) => ({ name: k, value: v })) },
      explanation: ["Used MDMonitoring Association module only.", "Counted distinct project keys by enterprise status.", "Filters applied before counting."],
      sources: selected,
    });
  }

  if (intent === "total_projects") {
    const { error, selected } = requireModules(["PROJECT"]); if (error) return error;
    const parsed = parseQuery(message);
    const filters = extractStrictFilters(message, parsed);
    const allRows = slpRows(selected);
    const filteredRows = allRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
    const keys = new Set(filteredRows.map(({ row, source }) => slpProjectKey(row, source.headers || [])).filter(Boolean));
    if (!keys.size) {
      return formatSlpAnswer({
        direct: "No matching projects found.",
        explanation: ["No projects matched the specified municipality, year, type, or status filters."],
        sources: selected,
      });
    }
    const location = filters.barangay ? ` in barangay ${filters.barangay}` : filters.municipality ? ` in ${filters.municipality}` : "";
    return formatSlpAnswer({
      direct: `Total projects${location}: ${keys.size}.`,
      explanation: ["Used Project Module only.", "Counted distinct Project IDs; duplicate Project IDs were counted once."],
      sources: selected,
      suggested: ["Top 10 enterprise/project types", "Projects with and without Grant Utilization Report", "Operational vs Closed by Municipality"],
    });
  }

  if (intent === "top_enterprise_types") {
    const { error, selected } = requireModules(["PROJECT"]); if (error) return error;
    const parsed = parseQuery(message);
    const filters = extractStrictFilters(message, parsed);
    const allRows = slpRows(selected);
    const filteredRows = allRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    for (const { row, source } of filteredRows) {
      const headers = source.headers || [];
      const projectId = slpValue(row, headers, ["Project ID"]);
      const key = projectId ? `project:${normalizeName(projectId)}` : `row:${normalizeName(JSON.stringify(row))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = getProjectNameOrType(row, headers);
      incrementEnterpriseProjectCount(counts, name);
    }
    const rows = topRows(counts, 10);
    if (!rows.length) {
      return formatSlpAnswer({
        direct: "No enterprise/project types found matching the filters.",
        tableHeaders: ["Filters Applied", "Value"],
        tableRows: Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [k, String(v)]),
        explanation: ["No project types matched the specified municipality, year, type, or status filters."],
        sources: selected,
        suggested: ["Show all projects", "Adjust filters", "Show files checked"],
      });
    }
    return formatSlpAnswer({
      direct: `Top ${rows.length} enterprise/project types.`,
      tableHeaders: ["Enterprise/Project Type", "Count"],
      tableRows: rows,
      chart: { type: "bar", title: "Top 10 Enterprise / Project Types", data: rows.map((r) => ({ name: r[0], value: Number(r[1]) })) },
      explanation: ["Used Project Module only.", "Counted the most implemented project/enterprise names or types.", "Filters applied before counting."],
      sources: selected,
    });
  }

  if (intent === "grant_utilization_status") {
    const { error, selected } = requireModules(["PROJECT", "GRANT_UTILIZATION"]); if (error) return error;
    const parsed = parseQuery(message);
    const filters = extractStrictFilters(message, parsed);
    const projectSources = sourcesForModules(selected, ["PROJECT"]);
    const gurSources = sourcesForModules(selected, ["GRANT_UTILIZATION"]);
    // Filter project rows
    const allProjectRows = slpRows(projectSources);
    const filteredProjectRows = allProjectRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
    // Rebuild projectSeen set from filtered rows
    const gurKeys = new Set<string>();
    for (const { row, source } of slpRows(gurSources)) {
      const headers = source.headers || [];
      [slpValue(row, headers, ["Project ID"]), slpValue(row, headers, ["Grant Code"]), normalizeName([slpProjectName(row, headers), slpMunicipality(row, headers)].join("|"))].filter(Boolean).forEach((key) => gurKeys.add(normalizeName(key)));
    }
    const projectSeen = new Set<string>();
    const byMuni = new Map<string, { conducted: number; notConducted: number }>();
    let conducted = 0, notConducted = 0;
    for (const { row, source } of filteredProjectRows) {
      const headers = source.headers || [];
      const projectKey = slpProjectKey(row, headers);
      if (!projectKey || projectSeen.has(projectKey)) continue;
      projectSeen.add(projectKey);
      const matchKeys = [slpValue(row, headers, ["Project ID"]), slpValue(row, headers, ["Grant Code"]), normalizeName([slpProjectName(row, headers), slpMunicipality(row, headers)].join("|"))].filter(Boolean).map(normalizeName);
      const hasGur = matchKeys.some((key) => gurKeys.has(key));
      if (hasGur) conducted += 1; else notConducted += 1;
      const muni = slpMunicipality(row, headers) || "Unspecified";
      const item = byMuni.get(muni) || { conducted: 0, notConducted: 0 };
      if (hasGur) item.conducted += 1; else item.notConducted += 1;
      byMuni.set(muni, item);
    }
    if (!conducted && !notConducted) {
      return formatSlpAnswer({
        direct: "No projects found matching the Grant Utilization filters.",
        tableHeaders: ["Filters Applied", "Value"],
        tableRows: Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [k, String(v)]),
        explanation: ["No projects matched the specified municipality, year, type, or status for Grant Utilization comparison."],
        sources: selected,
        suggested: ["Show all projects", "Adjust filters", "Show files checked"],
      });
    }
    return formatSlpAnswer({
      direct: `Projects with Grant Utilization Report: ${conducted}. Projects without Grant Utilization Report: ${notConducted}.`,
      tableHeaders: ["Municipality", "Conducted", "Not Conducted", "Total Projects"],
      tableRows: Array.from(byMuni.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([municipality, item]) => [municipality, String(item.conducted), String(item.notConducted), String(item.conducted + item.notConducted)]),
      chart: { type: "donut", title: "Grant Utilization Report Conducted vs Not Conducted", data: [{ name: "Conducted", value: conducted }, { name: "Not Conducted", value: notConducted }] },
      explanation: ["Checked projects encoded in Project Module.", "Matched Grant Utilization Report by Project ID first, Grant Code second, Project Name plus Municipality third.", "Filters applied before matching."],
      sources: selected,
    });
  }

  if (intent === "training_status") {
    const trainingSources = sourcesForModules(sources, ["TRAINING"]);
    if (!trainingSources.length) return missingModuleAnswer("TRAINING");
    const participantSources = sourcesForModules(sources, ["PROJECT"]).length ? sourcesForModules(sources, ["PROJECT"]) : sourcesForModules(sources, ["PERSONAL"]);
    if (!participantSources.length) return missingModuleAnswer("PERSONAL");
    const parsed = parseQuery(message);
    const filters = extractStrictFilters(message, parsed);
    // Filter participant sources by filters (municipality, year, type, status)
    const allParticipantRows = slpRows(participantSources);
    const filteredParticipantRows = allParticipantRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
    // Build participant keys from filtered rows
    const participants = new Map<string, { id: string; fullName: string; municipality: string; barangay: string }>();
    for (const { row, source } of filteredParticipantRows) {
      const headers = source.headers || [];
      const key = slpParticipantKey(row, headers);
      if (!key) continue;
      if (!participants.has(key)) {
        participants.set(key, {
          id: slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]),
          fullName: slpFullName(row, headers),
          municipality: slpMunicipality(row, headers),
          barangay: slpValue(row, headers, ["Barangay", "Brgy"]),
        });
      }
    }
    // Build training keys from all training rows (training module itself usually not filtered by municipality/year)
    const trainingKeys = new Set<string>();
    const trainingDetails = new Map<string, string>();
    for (const { row, source } of slpRows(trainingSources)) {
      const headers = source.headers || [];
      const participantId = slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]);
      const fullName = slpFullName(row, headers);
      const municipality = slpMunicipality(row, headers);
      const barangay = slpValue(row, headers, ["Barangay", "Brgy"]);
      const detail = [slpValue(row, headers, ["Training Title", "Training Title 1", "Training Batch Name", "Type"]), slpValue(row, headers, ["Training Date", "Date"])].filter(Boolean).join(" / ") || "Training record found";
      const keys = [participantId, normalizeName([fullName, municipality, barangay].join("|"))].filter(Boolean).map(normalizeName);
      for (const key of keys) {
        trainingKeys.add(key);
        if (!trainingDetails.has(key)) trainingDetails.set(key, detail);
      }
    }
    let conducted = 0, notConducted = 0;
    const sampleRows: string[][] = [];
    for (const [key, participant] of participants.entries()) {
      const participantId = participant.id;
      const nameKey = normalizeName([participant.fullName, participant.municipality, participant.barangay].join("|"));
      const keys = [normalizeName(participantId), nameKey].filter(Boolean);
      const matchedKey = keys.find((candidate) => candidate && trainingKeys.has(candidate));
      if (matchedKey) conducted += 1;
      else notConducted += 1;
      if (sampleRows.length < 50) {
        sampleRows.push([participant.id || participant.fullName || "-", participant.municipality || "-", matchedKey ? "Training Conducted" : "No Training Conducted", matchedKey ? trainingDetails.get(matchedKey) || "-" : "-"]);
      }
    }
    if (!participants.size) {
      return formatSlpAnswer({
        direct: "No participants found matching the filters for training status.",
        tableHeaders: ["Filters Applied", "Value"],
        tableRows: Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [k, String(v)]),
        explanation: ["No participants matched the specified municipality, year, type, or status filters for training analysis."],
        sources: [...participantSources, ...trainingSources],
        suggested: ["Show all participants", "Adjust filters", "Show files checked"],
      });
    }
    return formatSlpAnswer({
      direct: `Participants with training conducted: ${conducted}. Participants with no training conducted: ${notConducted}.`,
      tableHeaders: sampleRows.length ? ["Participant", "Municipality", "Training Status", "Training Detail"] : ["Status", "Count"],
      tableRows: sampleRows.length ? sampleRows : [["Training Conducted", String(conducted)], ["No Training Conducted", String(notConducted)]],
      chart: { type: "donut", title: "Training Conducted vs Not Conducted", data: [{ name: "Training Conducted", value: conducted }, { name: "No Training Conducted", value: notConducted }] },
      explanation: ["Matched Training Module using participant keys first: SLP Participant ID/Participant ID.", "Fell back to full name + municipality + barangay only when IDs were missing.", "Never matched by first name only.", "Filters applied to participant set before matching."],
      sources: [...participantSources, ...trainingSources],
    });
  }

  if (intent === "orientation_status") {
    const orientationSources = sourcesForModules(sources, ["ORIENTATION"]);
    if (!orientationSources.length) return missingModuleAnswer("ORIENTATION");
    const participantSources = sourcesForModules(sources, ["PROJECT"]).length ? sourcesForModules(sources, ["PROJECT"]) : sourcesForModules(sources, ["PERSONAL"]);
    if (!participantSources.length) return missingModuleAnswer("PERSONAL");
    const parsed = parseQuery(message);
    const filters = extractStrictFilters(message, parsed);
    const allParticipantRows = slpRows(participantSources);
    const filteredParticipantRows = allParticipantRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
    // Build participant keys from filtered rows
    const participants = new Map<string, { id: string; fullName: string; municipality: string; barangay: string }>();
    for (const { row, source } of filteredParticipantRows) {
      const headers = source.headers || [];
      const key = slpParticipantKey(row, headers);
      if (!key) continue;
      if (!participants.has(key)) {
        participants.set(key, {
          id: slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]),
          fullName: slpFullName(row, headers),
          municipality: slpMunicipality(row, headers),
          barangay: slpValue(row, headers, ["Barangay", "Brgy"]),
        });
      }
    }
    // Build orientation keys
    const orientationKeys = new Set<string>();
    for (const { row, source } of slpRows(orientationSources)) {
      const headers = source.headers || [];
      const participantId = slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]);
      const fullName = slpFullName(row, headers);
      const municipality = slpMunicipality(row, headers);
      const barangay = slpValue(row, headers, ["Barangay", "Brgy"]);
      const key = participantId ? normalizeName(participantId) : normalizeName([fullName, municipality, barangay].join("|"));
      if (!key) continue;
      orientationKeys.add(key);
    }
    let conducted = 0, notConducted = 0;
    const sampleRows: string[][] = [];
    for (const [key, participant] of participants.entries()) {
      const participantKeys = [normalizeName(participant.id), normalizeName([participant.fullName, participant.municipality, participant.barangay].join("|"))].filter(Boolean);
      const matched = participantKeys.some((candidate) => orientationKeys.has(candidate));
      if (matched) conducted += 1;
      else notConducted += 1;
      if (sampleRows.length < 50) {
        sampleRows.push([participant.id || participant.fullName || "-", participant.municipality || "-", matched ? "Orientation Conducted" : "No Orientation Conducted", matched ? "Orientation record found" : "-"]);
      }
    }
    if (!participants.size) {
      return formatSlpAnswer({
        direct: "No participants found matching the filters for orientation status.",
        tableHeaders: ["Filters Applied", "Value"],
        tableRows: Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [k, String(v)]),
        explanation: ["No participants matched the specified municipality, year, type, or status filters for orientation analysis."],
        sources: [...participantSources, ...orientationSources],
        suggested: ["Show all participants", "Adjust filters", "Show files checked"],
      });
    }
    return formatSlpAnswer({
      direct: `Participants with orientation conducted: ${conducted}. Participants with no orientation conducted: ${notConducted}.`,
      tableHeaders: sampleRows.length ? ["Participant", "Municipality", "Orientation Status", "Details"] : ["Status", "Count"],
      tableRows: sampleRows.length ? sampleRows : [["Orientation Conducted", String(conducted)], ["No Orientation Conducted", String(notConducted)]],
      chart: { type: "donut", title: "Orientation Conducted vs Not Conducted", data: [{ name: "Orientation Conducted", value: conducted }, { name: "No Orientation Conducted", value: notConducted }] },
      explanation: ["Matched Orientation Module by participant keys first: SLP Participant ID/Participant ID.", "Fell back to full name + municipality + barangay only when IDs were missing.", "Never matched by first name only.", "Filters applied to participant set before matching."],
      sources: [...participantSources, ...orientationSources],
    });
  }

  if (intent === "participant_monitoring") {
    const { error, selected } = requireModules(["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"]); if (error) return error;
    const parsed = parseQuery(message);
    const filters = extractStrictFilters(message, parsed);
    // For participant monitoring, we count participants that appear in monitoring records, but also apply filters to monitoring rows if municipality/year specified
    const allRows = slpRows(selected);
    const headers = selected[0]?.headers || [];
    const filteredRows = allRows.filter(({ row, source }) => filterRowsByFilters([row], source.headers || [], filters).length > 0);
    const participants = new Map<string, { id: string; fullName: string; municipality: string; barangay: string }>();
    for (const { row, source } of filteredRows) {
      const hdrs = source.headers || [];
      const key = slpParticipantKey(row, hdrs);
      if (!key) continue;
      if (!participants.has(key)) {
        participants.set(key, {
          id: slpValue(row, hdrs, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]),
          fullName: slpFullName(row, hdrs),
          municipality: slpMunicipality(row, hdrs),
          barangay: slpValue(row, hdrs, ["Barangay", "Brgy"]),
        });
      }
    }
    if (!participants.size) {
      return formatSlpAnswer({
        direct: "No participants monitored/visited/served found matching the filters.",
        tableHeaders: ["Filters Applied", "Value"],
        tableRows: Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [k, String(v)]),
        explanation: ["No monitoring records matched the specified municipality, year, type, or status filters."],
        sources: selected,
        suggested: ["Show all monitoring records", "Adjust filters", "Show files checked"],
      });
    }
    return formatSlpAnswer({
      direct: `Participants monitored/visited/served: ${participants.size}.`,
      tableHeaders: ["Participant ID/Name", "Municipality", "Barangay"],
      tableRows: Array.from(participants.values()).slice(0, 50).map((participant) => [participant.id || participant.fullName || "-", participant.municipality || "-", participant.barangay || "-"]),
      explanation: ["Used MDMonitoring sources and matched participants by SLP Participant ID / Participant ID first.", "Fell back to full name plus municipality plus barangay only when IDs were missing.", "Filters applied to monitoring rows before counting unique participants."],
      sources: selected,
    });
  }

  if (intent === "match_compare") {
    const { error, selected } = requireModules(["PERSONAL", "SLP_DPT_DATABASE"]); if (error) return error;
    const result = composeMatchCompare(sourcesForModules(selected, ["PERSONAL"]), sourcesForModules(selected, ["SLP_DPT_DATABASE"]));
    return formatSlpAnswer({ direct: `Personal Module vs SLP Aurora Database comparison: ${result.matched} matched, ${result.possible} possible full-name matches, ${result.unmatched} not matched.`, tableHeaders: ["Match Status", "Count"], tableRows: result.rows, explanation: ["Compared Personal Module in SLPIS with SLP Aurora Database in SLP DPT.", "Used stable keys first: Participant ID, SLP Participant ID, Grant Code.", "Used normalized full name plus municipality plus barangay next; Levenshtein only on full names; never first name only."], sources: selected });
  }

  if (intent === "municipality_drilldown") {
    const selected = sourcesForModules(sources, SLP_ALL_DRILLDOWN_MODULES);
    if (!selected.length) return missingModuleAnswer("PERSONAL");
    const requested = AURORA_MUNICIPALITIES.find((m) => normalizeName(message).includes(normalizeName(m))) || "";
    const rows = SLP_ALL_DRILLDOWN_MODULES.map((module) => {
      const moduleSources = sourcesForModules(selected, [module]);
      const count = slpRows(moduleSources).filter(({ row, source }) => !requested || slpMunicipality(row, source.headers || []) === requested).length;
      return [SLP_MODULE_LABELS[module], String(count)];
    });
    return formatSlpAnswer({ direct: `Municipality drill-down${requested ? ` for ${requested}` : ""} across relevant uploaded SLP modules.`, tableHeaders: ["Module", "Rows Found"], tableRows: rows, explanation: ["Used all relevant uploaded modules required by the fixed routing guide.", "Filtered by municipality when a municipality name was present in the question."], sources: selected });
  }

  return null;
}

const AURORA_MUNICIPALITIES = ["Baler", "Casiguran", "Dilasag", "Dinalungan", "Dingalan", "Dipaculao", "Maria Aurora", "San Luis"];

function findDashboardColumn(headers: string[], candidates: string[]) {
  const normalizedCandidates = candidates.map(normalizeColumnName);
  const exact = headers.find((header) => {
    const normalized = normalizeColumnName(header);
    return normalizedCandidates.some((candidate) => normalized === candidate);
  });
  if (exact) return exact;
  const fuzzy = headers.find((header) => {
    const normalized = normalizeColumnName(header);
    return normalizedCandidates.some((candidate) => normalized.includes(candidate) || candidate.includes(normalized));
  });
  if (fuzzy) return fuzzy;
  // Fallback: look for partial matches
  return headers.find((header) => {
    const normalized = normalizeColumnName(header);
    const headerWords = normalized.split(/\s+/).filter(Boolean);
    return normalizedCandidates.some((candidate) => {
      const candidateWords = candidate.split(/\s+/).filter(Boolean);
      return headerWords.some((hw) => candidateWords.some((cw) => hw.includes(cw) || cw.includes(hw)));
    });
  }) || "";
}

function getDashboardRowValue(row: Record<string, string>, column = "") {
  return column ? String(row[column] || "").trim() : "";
}

function normalizeMunicipalityName(value = "") {
  const normalized = normalizeName(value);
  return AURORA_MUNICIPALITIES.find((municipality) => normalizeName(municipality) === normalized) || "";
}

function classifyEnterpriseStatus(value = "") {
  const normalized = normalizeName(value);
  if (/\b(closed|close|ceased|stopped|inactive|terminated|dissolved|not operational|not operating|non operational|nonoperational)\b/.test(normalized)) return "closed";
  if (/\b(operational|active|operating|functional|ongoing|in operation)\b/.test(normalized)) return "operational";
  if (/under implementation|implementation|pipeline|started|for implementation/.test(normalized)) return "ongoing";
  if (/validation|for validation|pending|hold|unknown/.test(normalized)) return "inactive";
  return "inactive";
}

function normalizeEnterpriseStatus(value = ""): "operational" | "closed" | "unknown" {
  const status = classifyEnterpriseStatus(value);
  return status === "operational" || status === "closed" ? status : "unknown";
}

function classifyEncodedStatus(row: Record<string, string>, encodedColumn = "", idColumn = "", grantColumn = "") {
  const explicit = normalizeName(getDashboardRowValue(row, encodedColumn));
  if (/not encoded|unencoded|no|missing|pending/.test(explicit)) return "notEncoded";
  if (/encoded|yes|complete|done/.test(explicit)) return "encoded";
  return getDashboardRowValue(row, idColumn) || getDashboardRowValue(row, grantColumn) ? "encoded" : "notEncoded";
}

function classifyEnterpriseKind(input: { typeText?: string; participantName?: string; participantId?: string; associationName?: string; enterpriseName?: string; individualEnterprise?: string; associationEnterprise?: string }) {
  const combined = normalizeName([input.typeText, input.enterpriseName].filter(Boolean).join(" "));
  if (input.individualEnterprise || /\bindividual\b|participant enterprise|personal|solo|microenterprise/.test(combined)) return "individual";
  if (input.associationEnterprise || /\bassociation\b|\bslpa\b|\bgroup\b|organization|organisation|collective/.test(combined)) return "association";
  if (input.associationName && !input.participantName && !input.participantId) return "association";
  if ((input.participantName || input.participantId) && !input.associationName) return "individual";
  return "unknown";
}

function dashboardRowKey(parts: string[]) {
  const value = parts.map((part) => normalizeName(part)).filter(Boolean).join("|");
  return value || crypto.randomUUID();
}

function readDashboardRecordsFromSqlite() {
  const sources = loadDashboardSheetSources();
  const records: any[] = [];
  const missingFields = new Map<string, Set<string>>();

  // Dashboard data mapping: tolerate changing uploaded spreadsheet headers by matching common SLPIS/monitoring aliases.
  for (const source of sources as any[]) {
    const headers = source.headers || [];
    const columns = {
      municipality: findDashboardColumn(headers, ["municipality", "city", "location municipality", "mun"]),
      barangay: findDashboardColumn(headers, ["barangay", "brgy", "village"]),
      participantName: findDashboardColumn(headers, ["participant name", "beneficiary name", "client name", "full name", "name"]),
      participantId: findDashboardColumn(headers, ["slp participant id", "participant id", "beneficiary id", "client id"]),
      association: findDashboardColumn(headers, ["association", "slpa", "slpa name", "group name", "organization", "organisation"]),
      grantCode: findDashboardColumn(headers, ["grant code", "grant id", "project grant code"]),
      enterpriseName: findDashboardColumn(headers, ["name", "project name", "enterprise name", "livelihood project", "proposed project", "actual project", "name of enterprise"]),
      individualEnterprise: findDashboardColumn(headers, ["individual enterprise", "participant enterprise", "personal enterprise"]),
      associationEnterprise: findDashboardColumn(headers, ["association enterprise", "group enterprise", "slpa enterprise"]),
      enterpriseType: findDashboardColumn(headers, ["type", "participant type", "beneficiary type", "enterprise type", "project type", "mode", "individual association", "individual or group", "slpa individual"]),
      status: findDashboardColumn(headers, ["status", "enterprise status", "project status", "operational status", "remarks"]),
      monitoringDate: findDashboardColumn(headers, ["monitoring date", "visit date", "date monitored", "date visited", "date of visit"]),
      visit: findDashboardColumn(headers, ["visit count", "visits", "no of visits", "number of visits", "visits conducted"]),
      encodedStatus: findDashboardColumn(headers, ["encoded status", "encoding status", "encoded", "is encoded"]),
    };
    const requiredDashboardColumns: Array<[string, string]> = [
      ["municipality", columns.municipality],
      ["participant", columns.participantName || columns.participantId],
      ["association", columns.association],
      ["project/enterprise", columns.enterpriseName || columns.individualEnterprise || columns.associationEnterprise || columns.enterpriseType],
      ["status", columns.status],
      ["visit/monitoring", columns.visit || columns.monitoringDate],
    ];
    const missing = requiredDashboardColumns.filter(([, column]) => !column).map(([field]) => field);
    if (missing.length) missingFields.set(source.source, new Set(missing));

    for (const row of source.rows || []) {
      const municipality = normalizeMunicipalityName(getDashboardRowValue(row, columns.municipality));
      if (!municipality) continue;
      const participantName = getDashboardRowValue(row, columns.participantName);
      const participantId = getDashboardRowValue(row, columns.participantId);
      const associationName = getDashboardRowValue(row, columns.association);
      const grantCode = getDashboardRowValue(row, columns.grantCode);
      const enterpriseName = getDashboardRowValue(row, columns.enterpriseName);
      const individualEnterprise = getDashboardRowValue(row, columns.individualEnterprise);
      const associationEnterprise = getDashboardRowValue(row, columns.associationEnterprise);
      const enterpriseType = getDashboardRowValue(row, columns.enterpriseType) || "Unspecified";
      const barangay = getDashboardRowValue(row, columns.barangay);
      const visitValue = columns.visit && columns.visit !== columns.monitoringDate ? getDashboardRowValue(row, columns.visit) : "";
      const parsedVisitCount = /^\s*\d+(\.\d+)?\s*$/.test(visitValue) ? Number(visitValue) : 0;
      const visitCount = parsedVisitCount || (getDashboardRowValue(row, columns.monitoringDate) || visitValue ? 1 : 0);
      const baseRecord = {
        municipality,
        barangay,
        participantKey: participantId || participantName ? dashboardRowKey([participantId, participantName, municipality]) : "",
        associationKey: associationName ? dashboardRowKey([associationName, municipality]) : "",
        grantCode,
        participantName,
        participantId,
        associationName,
        enterpriseType,
        status: classifyEnterpriseStatus(getDashboardRowValue(row, columns.status)),
        encodedStatus: classifyEncodedStatus(row, columns.encodedStatus, columns.participantId, columns.grantCode),
        visitCount,
        fileName: source.fileName,
        source: source.source,
      };
      const enterpriseEntries = [
        individualEnterprise ? { projectName: individualEnterprise, kind: "individual" } : null,
        associationEnterprise ? { projectName: associationEnterprise, kind: "association" } : null,
      ].filter(Boolean) as Array<{ projectName: string; kind: string }>;

      if (!enterpriseEntries.length && (enterpriseName || associationName || participantName || participantId)) {
        enterpriseEntries.push({
          projectName: enterpriseName || associationName || participantName || "Unspecified Project Name",
          kind: classifyEnterpriseKind({ typeText: enterpriseType, participantName, participantId, associationName, enterpriseName }),
        });
      }

      if (!enterpriseEntries.length) {
        records.push({ ...baseRecord, enterpriseKey: "", projectName: "", enterpriseKind: "unknown" });
      } else {
        enterpriseEntries.forEach((entry, index) => {
          const keyParts = entry.kind === "individual"
            ? [participantId, participantName, municipality, entry.projectName]
            : entry.kind === "association"
              ? [grantCode, associationName, municipality, entry.projectName]
              : [municipality, entry.projectName, grantCode, associationName, participantId, participantName];
          records.push({
            ...baseRecord,
            enterpriseKey: dashboardRowKey(keyParts),
            projectName: entry.projectName,
            enterpriseKind: entry.kind,
            visitCount: index === 0 ? baseRecord.visitCount : 0,
          });
        });
      }
    }
  }

  return { sources, records, missingFields };
}

function getMunicipalityStats(records: any[]) {
  const byMunicipality = new Map(AURORA_MUNICIPALITIES.map((municipality) => [municipality, {
    municipality,
    totalParticipants: 0,
    totalAssociations: 0,
    totalEnterprises: 0,
    associationEnterprises: 0,
    individualEnterprises: 0,
    operational: 0,
    closed: 0,
    ongoing: 0,
    inactive: 0,
    encoded: 0,
    notEncoded: 0,
    totalVisits: 0,
    topEnterpriseType: "No data yet",
    enterpriseTypes: {} as Record<string, number>,
    participantKeys: new Set<string>(),
    associationKeys: new Set<string>(),
    enterpriseKeys: new Set<string>(),
    associationEnterpriseKeys: new Set<string>(),
    individualEnterpriseKeys: new Set<string>(),
  }]));

  for (const record of records) {
    const item = byMunicipality.get(record.municipality);
    if (!item) continue;
    if (record.participantKey) item.participantKeys.add(record.participantKey);
    if (record.associationKey) item.associationKeys.add(record.associationKey);
    if (record.enterpriseKey) item.enterpriseKeys.add(record.enterpriseKey);
    if (record.enterpriseKey && record.enterpriseKind === "association") item.associationEnterpriseKeys.add(record.enterpriseKey);
    if (record.enterpriseKey && record.enterpriseKind === "individual") item.individualEnterpriseKeys.add(record.enterpriseKey);
    item[record.status as "operational" | "closed" | "ongoing" | "inactive"] += 1;
    if (record.encodedStatus === "encoded") item.encoded += 1;
    else item.notEncoded += 1;
    item.totalVisits += record.visitCount;
    if (record.projectName && !/^(Individual Enterprise|Association Enterprise)$/i.test(record.projectName)) {
      item.enterpriseTypes[record.projectName] = (item.enterpriseTypes[record.projectName] || 0) + 1;
    }
  }

  return Array.from(byMunicipality.values()).map((item) => {
    const topType = Object.entries(item.enterpriseTypes).sort((a, b) => b[1] - a[1])[0]?.[0] || "No data yet";
    return {
      municipality: item.municipality,
      totalParticipants: item.participantKeys.size,
      totalAssociations: item.associationKeys.size,
      totalEnterprises: item.enterpriseKeys.size,
      associationEnterprises: item.associationEnterpriseKeys.size,
      individualEnterprises: item.individualEnterpriseKeys.size,
      operational: item.operational,
      closed: item.closed,
      ongoing: item.ongoing,
      inactive: item.inactive,
      encoded: item.encoded,
      notEncoded: item.notEncoded,
      totalVisits: item.totalVisits,
      topEnterpriseType: topType,
    };
  });
}

function getEnterpriseStatusStats(records: any[]) {
  const counts = { operational: 0, closed: 0, ongoing: 0, inactive: 0 };
  records.forEach((record) => { counts[record.status as keyof typeof counts] += 1; });
  return [
    { name: "Operational", value: counts.operational },
    { name: "Closed", value: counts.closed },
    { name: "Ongoing", value: counts.ongoing },
    { name: "Inactive/Validation", value: counts.inactive },
  ];
}

function getTopEnterpriseTypes(records: any[]) {
  const counts = new Map<string, number>();
  records.forEach((record) => {
    if (record.projectName && !/^(Individual Enterprise|Association Enterprise)$/i.test(record.projectName)) {
      counts.set(record.projectName, (counts.get(record.projectName) || 0) + 1);
    }
  });
  return Array.from(counts.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 10);
}

function getEncodedVsNotEncoded(records: any[]) {
  return records.reduce((acc, record) => {
    if (record.encodedStatus === "encoded") acc.encoded += 1;
    else acc.notEncoded += 1;
    return acc;
  }, { encoded: 0, notEncoded: 0 });
}

function getVisitStats(records: any[]) {
  const totalVisits = records.reduce((sum, record) => sum + record.visitCount, 0);
  const byMunicipality = getMunicipalityStats(records).sort((a, b) => b.totalVisits - a.totalVisits);
  return { totalVisits, mostVisitedMunicipality: byMunicipality[0]?.totalVisits ? byMunicipality[0].municipality : "No data yet" };
}

function getDashboardSummary(records: any[], municipalityStats: ReturnType<typeof getMunicipalityStats>) {
  const participantKeys = new Set(records.map((record) => record.participantKey));
  const enterpriseKeys = new Set(records.map((record) => record.enterpriseKey));
  const status = getEnterpriseStatusStats(records).reduce((acc: any, item) => ({ ...acc, [item.name]: item.value }), {});
  const topTypes = getTopEnterpriseTypes(records);
  const encoded = getEncodedVsNotEncoded(records);
  const visits = getVisitStats(records);
  const mostActive = [...municipalityStats].sort((a, b) => b.totalEnterprises + b.totalVisits - (a.totalEnterprises + a.totalVisits))[0];
  const highestClosed = [...municipalityStats].sort((a, b) => b.closed - a.closed)[0];
  return {
    totalParticipants: participantKeys.size,
    totalEnterprises: enterpriseKeys.size,
    operationalEnterprises: status.Operational || 0,
    closedEnterprises: status.Closed || 0,
    ongoingEnterprises: status.Ongoing || 0,
    inactiveEnterprises: status["Inactive/Validation"] || 0,
    encodedRecords: encoded.encoded,
    notEncodedRecords: encoded.notEncoded,
    totalVisits: visits.totalVisits,
    mostActiveMunicipality: mostActive?.totalEnterprises || mostActive?.totalVisits ? mostActive.municipality : "No data yet",
    highestClosedMunicipality: highestClosed?.closed ? highestClosed.municipality : "No data yet",
    mostImplementedEnterpriseType: topTypes[0]?.name || "No data yet",
  };
}

function topKeys(counts: Map<string, number>, limit = 5) {
  return Array.from(counts.entries())
    .filter(([name]) => Boolean(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

function getMunicipalityAnalyticsResponse() {
  const sources = loadSlpModuleSources({ includeChatAttachments: true });
  const sourceSet = new Set<string>();
  const summaryParticipantKeys = new Set<string>();
  const summaryAssociationKeys = new Set<string>();
  const summaryProjectKeys = new Set<string>();
  const summaryAssociationEnterpriseKeys = new Set<string>();
  const summaryIndividualEnterpriseKeys = new Set<string>();
  const summaryOperationalKeys = new Set<string>();
  const summaryClosedKeys = new Set<string>();
  const byMunicipality = new Map(AURORA_MUNICIPALITIES.map((municipality) => [municipality, {
    municipality,
    participantKeys: new Set<string>(),
    associationKeys: new Set<string>(),
    projectKeys: new Set<string>(),
    associationEnterpriseKeys: new Set<string>(),
    individualEnterpriseKeys: new Set<string>(),
    statusByEnterpriseKey: new Map<string, string>(),
    visits: 0,
    projectCounts: new Map<string, number>(),
    barangayCounts: new Map<string, number>(),
    sources: new Set<string>(),
  }]));

  for (const source of sourcesForModules(sources, ["PERSONAL"])) {
    for (const row of source.rows || []) {
      const municipality = slpMunicipality(row, source.headers || []);
      const item = byMunicipality.get(municipality);
      if (!item) continue;
      const key = slpParticipantKey(row, source.headers || []);
      if (key) {
        item.participantKeys.add(key);
        summaryParticipantKeys.add(key);
      }
      const barangay = slpValue(row, source.headers || [], ["Barangay"]);
      if (barangay) item.barangayCounts.set(barangay, (item.barangayCounts.get(barangay) || 0) + 1);
      item.sources.add(source.source);
      sourceSet.add(source.source);
    }
  }

  const projectOccurrenceCounts = new Map<string, number>();
  for (const { row, source } of slpRows(sourcesForModules(sources, ["PROJECT"]))) {
    const key = slpProjectKey(row, source.headers || []);
    if (key) projectOccurrenceCounts.set(key, (projectOccurrenceCounts.get(key) || 0) + 1);
  }

  for (const source of sourcesForModules(sources, ["PROJECT"])) {
    for (const row of source.rows || []) {
      const headers = source.headers || [];
      const municipality = slpMunicipality(row, headers);
      const item = byMunicipality.get(municipality);
      if (!item) continue;
      const projectKey = slpProjectKey(row, headers);
      const assocName = slpValue(row, headers, ["SLPA Name", "Association", "Name"]);
      if (projectKey && (projectOccurrenceCounts.get(projectKey) || 0) > 1) {
        const assocKey = projectKey || dashboardRowKey([assocName, municipality]);
        item.associationKeys.add(assocKey);
        summaryAssociationKeys.add(assocKey);
      }
      if (projectKey) {
        item.projectKeys.add(projectKey);
        summaryProjectKeys.add(projectKey);
        if ((projectOccurrenceCounts.get(projectKey) || 0) > 1) {
          item.associationEnterpriseKeys.add(projectKey);
          summaryAssociationEnterpriseKeys.add(projectKey);
        } else {
          item.individualEnterpriseKeys.add(projectKey);
          summaryIndividualEnterpriseKeys.add(projectKey);
        }
      }
      const projectName = slpProjectName(row, headers);
      if (projectName && projectName !== "Unspecified") incrementEnterpriseProjectCount(item.projectCounts, projectName);
      const barangay = slpValue(row, headers, ["Barangay"]);
      if (barangay) item.barangayCounts.set(barangay, (item.barangayCounts.get(barangay) || 0) + 1);
      item.sources.add(source.source);
      sourceSet.add(source.source);
    }
  }

  for (const source of sourcesForModules(sources, ["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"])) {
    for (const row of source.rows || []) {
      const headers = source.headers || [];
      const municipality = slpMunicipality(row, headers);
      const item = byMunicipality.get(municipality);
      if (!item) continue;
      const key = slpProjectKey(row, headers) || dashboardRowKey([slpFullName(row, headers), slpProjectName(row, headers), municipality]);
      if (!key) continue;
      const status = classifyEnterpriseStatus(slpValue(row, headers, ["Enterprise Status", "Livelihood Status", "Project Status", "Status"]));
      const existing = item.statusByEnterpriseKey.get(key);
      if (!existing || existing === "inactive" || (existing === "operational" && status === "closed")) item.statusByEnterpriseKey.set(key, status);
      const visit = slpValue(row, headers, ["Visit"]);
      const visitCount = /^\d+(\.\d+)?$/.test(visit) ? Number(visit) : (slpValue(row, headers, ["Date Monitored", "Monitoring Date"]) ? 1 : 0);
      item.visits += visitCount;
      item.sources.add(source.source);
      sourceSet.add(source.source);
    }
  }

  for (const item of byMunicipality.values()) {
    for (const [key, status] of item.statusByEnterpriseKey.entries()) {
      if (status === "operational") summaryOperationalKeys.add(key);
      else if (status === "closed") summaryClosedKeys.add(key);
    }
  }

  const municipalities = Array.from(byMunicipality.values()).map((item) => ({
    municipality: item.municipality,
    participants: item.participantKeys.size,
    associations: item.associationKeys.size,
    associationEnterprises: item.associationEnterpriseKeys.size,
    individualEnterprises: item.individualEnterpriseKeys.size,
    projects: item.projectKeys.size,
    operational: Array.from(item.statusByEnterpriseKey.values()).filter((status) => status === "operational").length,
    closed: Array.from(item.statusByEnterpriseKey.values()).filter((status) => status === "closed").length,
    unknown: Array.from(item.statusByEnterpriseKey.values()).filter((status) => status !== "operational" && status !== "closed").length,
    visits: item.visits,
    topProject: topKeys(item.projectCounts, 1)[0] || "",
    topBarangays: topKeys(item.barangayCounts, 5),
    sources: Array.from(item.sources).slice(0, 12),
  }));

  return {
    summary: {
      participants: summaryParticipantKeys.size,
      associations: summaryAssociationKeys.size,
      associationEnterprises: summaryAssociationEnterpriseKeys.size,
      individualEnterprises: summaryIndividualEnterpriseKeys.size,
      projects: summaryProjectKeys.size,
      operational: summaryOperationalKeys.size,
      closed: summaryClosedKeys.size,
      sources: sourceSet.size,
    },
    municipalities,
    dataQualityNotes: [
      "Dashboard analytics use fixed SLP module routing: Personal for participants, Project for projects/enterprise type, MDMonitoring Individual/Association for operational and closed status.",
      !sources.length ? "No SQLite-indexed workbook sources were found." : "",
      !sourcesForModules(sources, ["PERSONAL"]).length ? "Personal Module is missing, so participant totals may be zero." : "",
      !sourcesForModules(sources, ["PROJECT"]).length ? "Project Module is missing, so project and enterprise totals may be zero." : "",
      !sourcesForModules(sources, ["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"]).length ? "MDMonitoring modules are missing, so operational/closed totals may be zero." : "",
    ].filter(Boolean),
  };
}

function slpProjectMatchKeys(row: Record<string, string>, headers: string[]) {
  return [
    slpValue(row, headers, ["Project ID"]),
    slpValue(row, headers, ["Grant Code"]),
    normalizeName([slpProjectName(row, headers), slpMunicipality(row, headers)].join("|")),
  ].filter(Boolean).map((key) => normalizeName(key));
}

function normalizeDashboardFileName(name = "") {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function detectDashboardModuleType(fileName = "", headers: string[] = []) {
  const n = normalizeDashboardFileName(fileName);
  const h = headers.map((x) => String(x || "").toLowerCase()).join(" ");
  if (n.includes("mdannualassessmentmodule") || n.includes("mdannualassessment") || n.includes("annualassessment")) return "MD_ANNUAL_ASSESSMENT";
  if (n.includes("orgassessmentmodule") || n.includes("orgassessment") || n.includes("organizationalassessment")) return "ORG_ASSESSMENT";
  if (n.includes("mdmonitoringindividualmodule") || n.includes("mdmonitoringindividual") || n.includes("monitoringindividual")) return "MD_MONITORING_INDIVIDUAL";
  if (n.includes("mdmonitoringassociationmodule") || n.includes("mdmonitoringassociation") || n.includes("monitoringassociation")) return "MD_MONITORING_ASSOCIATION";
  if (h.includes("assessment visit")) return "MD_ANNUAL_ASSESSMENT";
  if (h.includes("visit") && h.includes("slp paricipant id") && h.includes("project id")) return "MD_MONITORING_UNKNOWN";
  return null;
}

function dashboardSourceTypeForSource(source: any) {
  const fileName = source.fileName || source.file_name || "";
  const folder = source.folder || "";
  const sheetName = source.sheetName || source.sheet_name || "";
  const label = normalizeName(`${folder} ${fileName} ${sheetName}`);
  const explicit =
    detectDashboardModuleType(fileName, source.headers || []) ||
    (/\bslpis\b/.test(label) && /personal module/.test(label) ? "SLPIS_PERSONAL_MODULE" : "") ||
    (/\bslpis\b/.test(label) && /project module/.test(label) ? "SLPIS_PROJECT_MODULE" : "") ||
    (/\bslpis\b/.test(label) && /grant utilization|gur module/.test(label) ? "SLPIS_GUR_MODULE" : "") ||
    (/\bslpis\b/.test(label) && /training module/.test(label) ? "SLPIS_TRAINING_MODULE" : "") ||
    (/\bslp dpt\b|aurora database/.test(label) ? "SLP_DPT_AURORA_DATABASE" : "");
  return explicit || classifyDataSource(fileName, folder, sheetName, source.headers || [], source.file_type || "").sourceType;
}

function loadDashboardAggregatorSources() {
  const rows = db.prepare(`
    SELECT d.id AS document_id, d.file_name, d.folder, d.file_type,
           us.id AS sheet_id, us.sheet_name, us.headers_json,
           us.header_row_index, us.header_confidence, sr.row_index, sr.row_json
    FROM sheet_rows sr
    JOIN uploaded_sheets us ON us.id = sr.sheet_id
    JOIN documents d ON d.id = us.document_id
    ORDER BY us.id ASC, sr.row_index ASC
  `).all();
  const grouped = new Map<string, { documentId: string; fileName: string; folder: string; file_type: string; sheetName: string; headers: string[]; rows: Array<Record<string, string>>; headerRowIndex: number; headerConfidence: number; source: string }>();
  for (const row of rows as any[]) {
    if (!grouped.has(row.sheet_id)) {
      const source = `${row.folder || "Unknown"}/${row.file_name} / ${row.sheet_name}`;
      grouped.set(row.sheet_id, {
        documentId: row.document_id,
        fileName: row.file_name,
        folder: row.folder || "",
        file_type: row.file_type || "",
        sheetName: row.sheet_name,
        headers: JSON.parse(row.headers_json || "[]"),
        rows: [],
        headerRowIndex: row.header_row_index || 0,
        headerConfidence: row.header_confidence || 0,
        source,
      });
    }
    const parsed = JSON.parse(row.row_json || "{}");
    parsed.__rowNumber = String(row.row_index || parsed.__rowNumber || "");
    grouped.get(row.sheet_id)!.rows.push(parsed);
  }
  const indexedSources = Array.from(grouped.values());
  const indexedDocumentIds = new Set(indexedSources.map((source: any) => source.documentId).filter(Boolean));
  const monitoringDocumentIds = new Set<string>();
  const reparsedMonitoringSources: any[] = [];
  for (const source of indexedSources as any[]) {
    const sourceType = dashboardSourceTypeForSource(source);
    if (["MD_MONITORING_ASSOCIATION", "MD_MONITORING_INDIVIDUAL", "ORG_ASSESSMENT", "MD_ANNUAL_ASSESSMENT", "MD_MONITORING_UNKNOWN", "SLPIS_MONITORING_ASSOCIATION_MODULE", "SLPIS_MONITORING_INDIVIDUAL_MODULE", "SLPIS_ORG_ASSESSMENT_MODULE", "SLPIS_ANNUAL_ASSESSMENT_MODULE"].includes(String(sourceType))) {
      monitoringDocumentIds.add(source.documentId);
    }
  }
  if (monitoringDocumentIds.size) {
    const docs = db.prepare(`SELECT id, file_name, folder, file_type, content_text FROM documents WHERE id IN (${Array.from(monitoringDocumentIds).map(() => "?").join(",")})`).all(...Array.from(monitoringDocumentIds));
    for (const doc of docs as any[]) {
      const sheets = parseXlsxContent(doc.content_text || "", { fileName: doc.file_name, folder: doc.folder, file_type: doc.file_type });
      for (const sheet of sheets) {
        reparsedMonitoringSources.push({
          source: `${doc.folder || "Unknown"}/${doc.file_name} / ${sheet.sheetName}`,
          documentId: doc.id,
          fileName: doc.file_name,
          folder: doc.folder || "",
          file_type: doc.file_type || "",
          sheetName: sheet.sheetName,
          headers: sheet.headers,
          rows: sheet.rows,
          headerRowIndex: sheet.headerRowIndex,
          headerConfidence: sheet.headerConfidence,
        });
      }
    }
  }
  const fallbackSources: any[] = [];
  const fallbackDocs = db.prepare("SELECT id, file_name, folder, file_type, content_text FROM documents WHERE content_text LIKE '%__slpWorkbook%' ORDER BY created_at DESC").all();
  for (const doc of fallbackDocs as any[]) {
    if (indexedDocumentIds.has(doc.id) || monitoringDocumentIds.has(doc.id)) continue;
    const sheets = parseXlsxContent(doc.content_text || "", { fileName: doc.file_name, folder: doc.folder, file_type: doc.file_type });
    for (const sheet of sheets) {
      fallbackSources.push({
        source: `${doc.folder || "Unknown"}/${doc.file_name} / ${sheet.sheetName}`,
        documentId: doc.id,
        fileName: doc.file_name,
        folder: doc.folder || "",
        file_type: doc.file_type || "",
        sheetName: sheet.sheetName,
        headers: sheet.headers,
        rows: sheet.rows,
        headerRowIndex: sheet.headerRowIndex,
        headerConfidence: sheet.headerConfidence,
      });
    }
  }
  return [
    ...indexedSources.filter((source: any) => !monitoringDocumentIds.has(source.documentId)),
    ...reparsedMonitoringSources,
    ...fallbackSources,
  ];
}

function buildDashboardAnalyticsResponse() {
  return buildUnifiedDashboardAnalytics(loadDashboardAggregatorSources() as any);
  try {
    const sources = loadSlpModuleSources({ includeChatAttachments: true });
    const personalSources = sourcesForModules(sources, ["PERSONAL"]);
    const projectSources = sourcesForModules(sources, ["PROJECT"]);
    const monitoringSources = sourcesForModules(sources, ["MDMONITORING_INDIVIDUAL", "MDMONITORING_ASSOCIATION"]);
    const gurSources = sourcesForModules(sources, ["GRANT_UTILIZATION"]);
    const trainingSources = sourcesForModules(sources, ["TRAINING"]);
    const notes: string[] = [];
    const requireModule = (module: SlpModuleTag, available: any[]) => {
      if (!available.length) notes.push(`Required module missing: ${SLP_MODULE_LABELS[module]}.`);
    };
    requireModule("PERSONAL", personalSources);
    requireModule("PROJECT", projectSources);
    if (!monitoringSources.length) notes.push(`Required module missing: ${SLP_MODULE_LABELS.MDMONITORING_INDIVIDUAL} and ${SLP_MODULE_LABELS.MDMONITORING_ASSOCIATION}.`);
    requireModule("GRANT_UTILIZATION", gurSources);
    requireModule("TRAINING", trainingSources);

    const participantKeys = new Set<string>();
    for (const { row, source } of slpRows(personalSources)) {
      const key = slpParticipantKey(row, source.headers || []);
      if (key) participantKeys.add(key);
    }

    const associationProjects = countProjectModuleByKind(projectSources, "association");
    const individualProjects = countProjectModuleByKind(projectSources, "individual");
    const statusByMuni = countStatusFromMonitoring(monitoringSources, true).rows.map((row) => ({
      municipality: row[0],
      operational: Number(row[1]),
      closed: Number(row[2]),
      unknown: Number(row[3]),
      total: Number(row[4]),
    }));
    const operational = statusByMuni.reduce((sum, item) => sum + item.operational, 0);
    const closed = statusByMuni.reduce((sum, item) => sum + item.closed, 0);

    const projectRecords = new Map<string, { projectName: string; municipality: string; grantCode: string; projectId: string; keys: string[] }>();
    const topOverall = new Map<string, number>();
    const topByMuni = new Map<string, Map<string, number>>();
    for (const { row, source } of slpRows(projectSources)) {
      const headers = source.headers || [];
      const projectKey = slpProjectKey(row, headers);
      if (!projectKey || projectRecords.has(projectKey)) continue;
      const projectName = slpProjectName(row, headers);
      const municipality = slpMunicipality(row, headers) || "Unspecified";
      const grantCode = slpValue(row, headers, ["Grant Code"]);
      const projectId = slpValue(row, headers, ["Project ID"]);
      const keys = slpProjectMatchKeys(row, headers);
      projectRecords.set(projectKey, { projectName, municipality, grantCode, projectId, keys });
      incrementEnterpriseProjectCount(topOverall, projectName);
      if (!topByMuni.has(municipality)) topByMuni.set(municipality, new Map());
      incrementEnterpriseProjectCount(topByMuni.get(municipality)!, projectName);
    }

    const projectByAnyKey = new Map<string, { projectName: string; municipality: string }>();
    for (const project of projectRecords.values()) {
      project.keys.forEach((key) => {
        if (!projectByAnyKey.has(key)) projectByAnyKey.set(key, { projectName: project.projectName, municipality: project.municipality });
      });
    }

    const statusCounts = {
      operational: new Map<string, number>(),
      closed: new Map<string, number>(),
      operationalByMuni: new Map<string, Map<string, number>>(),
      closedByMuni: new Map<string, Map<string, number>>(),
    };
    const seenStatusKeys = new Set<string>();
    for (const { row, source } of slpRows(monitoringSources)) {
      const headers = source.headers || [];
      const status = classifyEnterpriseStatus(slpValue(row, headers, ["Enterprise Status", "Livelihood Status", "Project Status", "Status"]));
      if (status !== "operational" && status !== "closed") continue;
      const keys = slpProjectMatchKeys(row, headers);
      const matched = keys.map((key) => projectByAnyKey.get(key)).find(Boolean);
      const projectName = matched?.projectName || slpProjectName(row, headers);
      const municipality = matched?.municipality || slpMunicipality(row, headers) || "Unspecified";
      const dedupeKey = `${status}:${keys[0] || normalizeName([projectName, municipality, slpFullName(row, headers)].join("|"))}`;
      if (seenStatusKeys.has(dedupeKey)) continue;
      seenStatusKeys.add(dedupeKey);
      const overallMap = status === "operational" ? statusCounts.operational : statusCounts.closed;
      const muniMap = status === "operational" ? statusCounts.operationalByMuni : statusCounts.closedByMuni;
      incrementEnterpriseProjectCount(overallMap, projectName);
      if (!muniMap.has(municipality)) muniMap.set(municipality, new Map());
      incrementEnterpriseProjectCount(muniMap.get(municipality)!, projectName);
    }

    const topEnterprisesOverall = topRows(topOverall, 10).map(([name, count], index) => ({ rank: index + 1, enterpriseProjectType: name, count: Number(count) }));
    const topEnterprisesByMunicipality = Array.from(topByMuni.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([municipality, counts]) => {
      const [name, count] = topRows(counts, 1)[0] || ["No data yet", "0"];
      return { municipality, enterpriseProjectType: name, count: Number(count) };
    });
    const mostOperationalEnterprises = topRows(statusCounts.operational, 10).map(([name, count], index) => ({ rank: index + 1, enterpriseProjectType: name, operationalCount: Number(count) }));
    const mostClosedEnterprises = topRows(statusCounts.closed, 10).map(([name, count], index) => ({ rank: index + 1, enterpriseProjectType: name, closedCount: Number(count) }));
    const statusByMunicipalityRows = (sourceMap: Map<string, Map<string, number>>, countKey: "operationalCount" | "closedCount") => Array.from(sourceMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([municipality, counts]) => {
      const [name, count] = topRows(counts, 1)[0] || ["No data yet", "0"];
      return { municipality, enterpriseProjectType: name, [countKey]: Number(count) };
    });

    const gur = composeGrantUtilizationStatus(projectSources, gurSources);
    const training = composeTrainingStatus(projectSources, trainingSources);
    const gurByMunicipality = gur.rows.map((row) => ({ municipality: row[0], totalProjects: Number(row[3]), withGur: Number(row[1]), withoutGur: Number(row[2]) }));

    const trainingByMuni = new Map<string, { projectParticipants: Set<string>; withTraining: Set<string>; withoutTraining: Set<string> }>();
    const trainingKeys = new Set<string>();
    const trainingTitleCounts = new Map<string, number>();
    for (const { row, source } of slpRows(trainingSources)) {
      const headers = source.headers || [];
      [slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]), normalizeName([slpFullName(row, headers), slpMunicipality(row, headers), slpValue(row, headers, ["Barangay"])].join("|"))].filter(Boolean).map(normalizeName).forEach((key) => trainingKeys.add(key));
      const title = normalizeTrainingTitleForDashboard(slpValue(row, headers, ["Training Title", "Training Title 1", "Training Title 2", "Training Title 3", "Training Batch Name", "Type"]) || "Unspecified");
      increment(trainingTitleCounts, title);
    }
    for (const { row, source } of slpRows(projectSources)) {
      const headers = source.headers || [];
      const participantKey = slpParticipantKey(row, headers);
      if (!participantKey) continue;
      const municipality = slpMunicipality(row, headers) || "Unspecified";
      if (!trainingByMuni.has(municipality)) trainingByMuni.set(municipality, { projectParticipants: new Set(), withTraining: new Set(), withoutTraining: new Set() });
      const item = trainingByMuni.get(municipality)!;
      item.projectParticipants.add(participantKey);
      const participantId = slpValue(row, headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]);
      const fullName = participantId ? "" : slpFullName(row, headers);
      const keys = [participantId, normalizeName([fullName, municipality, slpValue(row, headers, ["Barangay"])].join("|"))].filter(Boolean).map(normalizeName);
      if (keys.some((key) => trainingKeys.has(key))) item.withTraining.add(participantKey);
      else item.withoutTraining.add(participantKey);
    }
    const trainingByMunicipality = Array.from(trainingByMuni.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([municipality, item]) => ({
      municipality,
      projectParticipants: item.projectParticipants.size,
      withTraining: item.withTraining.size,
      withoutTraining: item.withoutTraining.size,
    }));

    const municipalityResponse = getMunicipalityAnalyticsResponse();
    const drillByName = new Map(municipalityResponse.municipalities.map((item: any) => [item.municipality, item]));
    const gurByName = new Map(gurByMunicipality.map((item) => [item.municipality, item]));
    const trainingByName = new Map(trainingByMunicipality.map((item) => [item.municipality, item]));
    const opByName = new Map(statusByMunicipalityRows(statusCounts.operationalByMuni, "operationalCount").map((item) => [item.municipality, item]));
    const closedByName = new Map(statusByMunicipalityRows(statusCounts.closedByMuni, "closedCount").map((item) => [item.municipality, item]));
    const municipalityDrilldown = AURORA_MUNICIPALITIES.map((municipality) => {
      const base: any = drillByName.get(municipality) || {};
      const gurItem = gurByName.get(municipality);
      const trainingItem = trainingByName.get(municipality);
      return {
        municipality,
        totalParticipants: base.participants || 0,
        associations: base.associationEnterprises || 0,
        individualEnterprises: base.individualEnterprises || 0,
        operational: base.operational || 0,
        closed: base.closed || 0,
        topEnterprise: base.topProject || "No data yet",
        mostOperationalEnterprise: opByName.get(municipality)?.enterpriseProjectType || "No data yet",
        mostClosedEnterprise: closedByName.get(municipality)?.enterpriseProjectType || "No data yet",
        withGrantUtilizationReport: gurItem?.withGur || 0,
        withoutGrantUtilizationReport: gurItem?.withoutGur || 0,
        withTraining: trainingItem?.withTraining || 0,
        withoutTraining: trainingItem?.withoutTraining || 0,
        sourceFilesUsed: base.sources || [],
      };
    });

    return {
      success: true,
      lastUpdated: new Date().toISOString(),
      summary: {
        totalParticipants: participantKeys.size,
        associations: associationProjects.count,
        individualEnterprises: individualProjects.count,
        operational,
        closed,
      },
      operationalClosedByMunicipality: statusByMuni,
      topEnterprisesOverall,
      topEnterprisesByMunicipality,
      mostOperationalEnterprises,
      mostOperationalEnterprisesByMunicipality: statusByMunicipalityRows(statusCounts.operationalByMuni, "operationalCount"),
      mostClosedEnterprises,
      mostClosedEnterprisesByMunicipality: statusByMunicipalityRows(statusCounts.closedByMuni, "closedCount"),
      grantUtilization: {
        withReport: gur.conducted,
        withoutReport: gur.notConducted,
        byMunicipality: gurByMunicipality,
      },
      training: {
        withTraining: training.conducted,
        withoutTraining: training.notConducted,
        byMunicipality: trainingByMunicipality,
        byTrainingTitle: topRows(trainingTitleCounts, 15).map(([trainingTitle, participants]) => ({ trainingTitle, participants: Number(participants) })),
      },
      municipalityDrilldown,
      dataQualityNotes: notes,
    };
  } catch (error) {
    console.error("Dashboard analytics calculation failed:", error);
    throw error;
  }
}

function findMatchingColumn(headers: string[], field: string) {
  const wanted = normalizeColumnName(field);
  const role = field === "name" ? "full_name"
    : field === "grant code" ? "grant_code"
    : field === "participant id" || field === "slp participant id" ? "participant_id"
    : field === "association name" ? "association"
    : field;
  return headers.find((header) => detectColumnRole(header) === role)
    || headers.find((header) => normalizeColumnName(header).includes(wanted))
    || headers.find((header) => wanted.split(" ").some((part) => normalizeColumnName(header).includes(part)));
}

function numericValue(value: string) {
  const n = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function sourcesToRows(sources: ReturnType<typeof loadSheetSources>) {
  return sources.flatMap((source: any) => source.rows.map((row: any) => ({ source, row })));
}

function roleColumn(headers: string[], role: string) {
  return headers.find((header) => detectColumnRole(header) === role) || findMatchingColumn(headers, role);
}

function composeDataQualityReport(sources: ReturnType<typeof loadSheetSources>, message = "") {
  const all = sourcesToRows(sources);
  const summary = new Map<string, number>();
  const details: string[][] = [];
  const add = (issue: string, source: any, row: any, field: string, value: string, fix: string) => {
    increment(summary, issue);
    if (details.length < 200) details.push([issue, source.fileName, source.sheetName, String(row.__rowNumber || ""), field, value || "-", fix]);
  };
  for (const source of sources as any[]) {
    const headers = source.headers;
    const nameRecords = extractNameRecordsFromSources([source], "");
    const nameCounts = new Map<string, number>();
    nameRecords.forEach((record) => { if (record.normalized) increment(nameCounts, record.normalized); });
    const grantCol = roleColumn(headers, "grant code");
    const grantCounts = new Map<string, number>();
    if (grantCol) source.rows.forEach((row: any) => { const v = normalizeName(getCell(row, grantCol)); if (v) increment(grantCounts, v); });
    const checks: Array<[string, string, string]> = [
      ["missing municipality", "municipality", "Fill municipality from source record."],
      ["missing barangay", "barangay", "Fill barangay from source record."],
      ["missing status", "status", "Encode status or confirm if not applicable."],
      ["missing visit dates", "visit", "Add visit/monitoring date."],
      ["missing educational attainment", "education", "Add educational attainment."],
      ["missing project/enterprise", "project", "Add project or enterprise field."],
    ];
    source.rows.forEach((row: any) => {
      const built = buildFullName(row, headers);
      if (!built.sufficient) add("blank or incomplete name", source, row, "name", built.fullName, "Complete first and last name or full name.");
      else if ((nameCounts.get(built.fullName) || 0) > 1) add("duplicate full name", source, row, "name", built.fullName, "Review if this is the same participant or separate records.");
      if (grantCol) {
        const grant = getCell(row, grantCol);
        if (!grant) add("blank grant code", source, row, grantCol, grant, "Encode valid grant code.");
        else if (!/^[a-z0-9-]{4,}$/i.test(grant)) add("invalid grant code", source, row, grantCol, grant, "Check grant code format.");
        else if ((grantCounts.get(normalizeName(grant)) || 0) > 1) add("duplicate grant code", source, row, grantCol, grant, "Review duplicate grant code.");
      }
      const idCol = headers.find((h: string) => /participant.*id|slp.*id|client.*id/i.test(h));
      if (idCol && !getCell(row, idCol)) add("invalid or blank participant id", source, row, idCol, "", "Encode participant ID.");
      for (const [issue, field, fix] of checks) {
        const col = roleColumn(headers, field);
        if (col && !getCell(row, col)) add(issue, source, row, col, "", fix);
      }
    });
  }
  const summaryRows = Array.from(summary.entries()).sort((a, b) => b[1] - a[1]).map(([issue, count]) => [issue, String(count)]);
  return ["**Direct Answer**", summaryRows.length ? `Found ${summaryRows.reduce((s, row) => s + Number(row[1]), 0)} data quality issue(s) across ${sources.length} source(s).` : "No major data quality issues were found by deterministic checks.", "", "**Data Quality Summary Table**", summaryRows.length ? markdownTable(["Issue", "Count"], summaryRows) : markdownTable(["Issue", "Count"], [["No major issue", "0"]]), "", "**Issue Details Table**", details.length ? markdownTable(["Issue", "File", "Sheet", "Row", "Field", "Value", "Suggested Fix"], details) : "No issue details to show.", "", "**Suggested Fixes**", "- Complete required participant identity fields.", "- Review duplicate full names and grant codes manually before deleting any rows.", "- Fill missing location, status, visit date, education, and project fields from source documents.", "", "**Export option to CSV/XLSX**", "- Select this answer table and export from the browser, or ask: export this result.", "", "**Source Used**", ...sources.map((s: any) => `- ${s.source}`), "", "**Data Quality Notes**", "- Checks are deterministic and based on indexed spreadsheet columns only."].join("\n");
}

function composeFormulaAssistant(message: string, sources: ReturnType<typeof loadSheetSources>) {
  const headers = Array.from(new Set(sources.flatMap((s: any) => s.headers)));
  const keyCol = findMatchingColumn(headers, "grant code") || findMatchingColumn(headers, "name") || headers[0] || "A:A";
  const returnCols = ["name", "municipality", "visit"].map((field) => findMatchingColumn(headers, field)).filter(Boolean);
  const lower = message.toLowerCase();
  let formula = "";
  let label = "Formula";
  if (/xlookup/.test(lower)) { label = "XLOOKUP"; formula = `=XLOOKUP(A2,SourceTable[${keyCol}],SourceTable[${returnCols[0] || keyCol}],\"Not found\")`; }
  else if (/vlookup/.test(lower)) { label = "VLOOKUP"; formula = `=VLOOKUP(A2,SourceTable,2,FALSE)`; }
  else if (/countifs/.test(lower)) { label = "COUNTIFS"; formula = `=COUNTIFS(SourceTable[${findMatchingColumn(headers, "status") || "Status"}],\"Operational\")`; }
  else if (/sumifs/.test(lower)) { label = "SUMIFS"; formula = `=SUMIFS(SourceTable[${findMatchingColumn(headers, "amount") || "Amount"}],SourceTable[${findMatchingColumn(headers, "status") || "Status"}],\"Operational\")`; }
  else { label = "FILTER"; formula = `=FILTER(SourceTable,SourceTable[${keyCol}]=A2,\"No match\")`; }
  return ["**Direct Answer**", `Paste-ready ${label} formula:`, "```excel", formula, "```", "", "**Source Used**", sources.length ? sources.slice(0, 3).map((s: any) => `- ${s.source}`).join("\n") : "- Uploaded headers were not available; used generic table names.", "", "**How I calculated/found it**", "- Selected likely columns from uploaded spreadsheet headers when available.", "- Formula is for Excel structured tables named SourceTable.", "", "**Data Quality Notes**", "- Adjust table/column names if your Excel table uses different names."].join("\n");
}

function composeAttachedFileInsight(sources: Array<{ source: string; fileName: string; sheetName: string; headers: string[]; rows: Array<Record<string, string>>; headerRowIndex: number; headerConfidence: number }>) {
  const fileName = sources[0]?.fileName || "attached file";
  const allRows = sources.flatMap((source) => source.rows.map((row) => ({ source, row })));
  const allHeaders = Array.from(new Set(sources.flatMap((source) => source.headers)));
  const numericColumns = allHeaders.filter((header) => /amount|total|balance|budget|fund|cost|allocation|bene|beneficiar|participants?|projects?|checks?/i.test(header) && !/date|drn|check no|^no\.?$|number/i.test(header) && allRows.some(({ row }) => numericValue(row[header]) !== 0));
  const categoryColumns = allHeaders.filter((header) => /status|municipality|barangay|project|enterprise|category|type|education/i.test(header));
  const missingCounts = allHeaders.map((header) => [header, allRows.filter(({ row }) => !String(row[header] || "").trim()).length] as [string, number]).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const duplicateCount = new Set(allRows.map(({ row }) => JSON.stringify(row))).size;
  const sections = ["**Direct Answer**", `I analyzed the attached file: ${fileName}.`, "", "**Relevant Table**"];
  sections.push(markdownTable(["Metric", "Value"], [
    ["Sheets", String(sources.length)],
    ["Rows", String(allRows.length)],
    ["Columns", String(allHeaders.length)],
    ["Duplicate full rows", String(Math.max(0, allRows.length - duplicateCount))],
  ]), "");
  sections.push("**Source Used**", `- ${fileName}`, "", "**Relevant Table**", markdownTable(["Sheet", "Rows", "Columns", "Detected Header Row", "Confidence"], sources.map((source) => [source.sheetName, String(source.rows.length), String(source.headers.length), String(source.headerRowIndex + 1), String(source.headerConfidence)])), "");
  if (numericColumns.length) {
    sections.push("**Relevant Table**", markdownTable(["Column", "Total"], numericColumns.slice(0, 8).map((header) => [header, String(allRows.reduce((sum, { row }) => sum + numericValue(row[header]), 0))])), "");
  }
  if (categoryColumns.length) {
    const category = categoryColumns[0];
    const counts = new Map<string, number>();
    for (const { row } of allRows) increment(counts, String(row[category] || "Blank"));
    sections.push("**Relevant Table**", markdownTable([category, "Count"], topRows(counts, 10)), "");
  }
  sections.push("**How I calculated/found it**", "- Parsed the attached workbook into SQLite-indexed sheet rows.", "- Counted rows, columns, totals, categories, blanks, and identical full rows deterministically.", "", "**Data Quality Notes**", `- Header detection scanned the first 20 rows per sheet.`, `- Duplicate count is based on identical row values.`, missingCounts.length ? `- Largest blank-column counts: ${missingCounts.map(([header, count]) => `${header}=${count}`).join(", ")}.` : "- No major blank columns detected.", "");
  sections.push("**Suggested Next Questions**", "- Show totals by sheet", "- Show status by municipality", "- Find duplicate names", "- List rows with missing values");
  return sections.join("\n");
}

function composeAttachedNameVerification(attachedSources: any[]) {
  const fileName = attachedSources[0]?.fileName || "attached file";
  const inputRecords = extractNameRecordsFromSources(attachedSources, "Attached input. ");
  const databaseRecords = extractNameRecordsFromSources(loadSheetSources(), "Existing SQLite data. ");
  const rows = inputRecords.map((record) => {
    if (!record.normalized) return [String(record.row), record.fullName, "Insufficient data", "", "", "0%", record.notes];
    let best: (NameRecord & { score: number }) | null = null;
    for (const candidate of databaseRecords) {
      const score = fullNameScore(record.normalized, candidate.normalized);
      if (!best || score > best.score) best = { ...candidate, score };
    }
    const score = best?.score || 0;
    const status = score >= 95 ? "Served / strong match" : score >= 85 ? "Possible served match" : score >= 75 ? "Needs review" : "Not found as served";
    return [String(record.row), record.fullName, status, best && score >= 75 ? String(best.row) : "", best && score >= 75 ? best.fullName : "", `${score}%`, best && score >= 75 ? `${best.sourceFile} / ${best.sheet}` : "No full-name match at 75% or higher"];
  });
  const found = rows.filter((row) => /Served|Possible|Needs review/.test(row[2])).length;
  const sections = ["**Direct Answer**", `I verified the names in the attached file against the existing SQLite data using full-name matching.`, "", "**Relevant Table**"];
  sections.push(markdownTable(["Metric", "Value"], [["Rows checked", String(inputRecords.length)], ["Served / matched", String(found)], ["Not found", String(rows.filter((row) => row[2] === "Not found as served").length)], ["Insufficient name data", String(rows.filter((row) => row[2] === "Insufficient data").length)]]), "");
  sections.push("**Relevant Table**", markdownTable(["Source Row", "Full Name", "Status", "Matched Row", "Matched Full Name", "Score", "Notes"], rows.slice(0, 100)), "");
  sections.push("**Source Used**", `- Primary attachment: ${fileName}`, "- Comparison source: non-chat SQLite indexed sheets", "", "**How I calculated/found it**", "- Built full names from First/Given + Middle + Last/Surname + Extension, or Full/Complete/Participant Name.", "- Normalized names and used Levenshtein similarity on the full normalized name.", "- Never marked duplicates from first name only.", "", "**Data Quality Notes**", "- Rows with only one name token are marked insufficient.", "", "**Suggested Next Questions**", "- Show only strong matches", "- Show only not found names", "- Export the matched list");
  return sections.join("\n");
}

function detectMatchField(message: string) {
  const lower = message.toLowerCase();
  if (/grant\s*(code|id)/.test(lower)) return { field: "grant code", label: "Grant Code" };
  if (/slp\s*participant\s*id/.test(lower)) return { field: "slp participant id", label: "SLP Participant ID" };
  if (/participant\s*id|beneficiary\s*id|client\s*id/.test(lower)) return { field: "participant id", label: "Participant ID" };
  if (/association|group name|organization|organisation/.test(lower)) return { field: "association name", label: "Association Name" };
  if (/barangay|brgy/.test(lower)) return { field: "barangay", label: "Barangay" };
  if (/municipality|city/.test(lower)) return { field: "municipality", label: "Municipality" };
  return { field: "name", label: "Full Name" };
}

function rowDisplay(row: Record<string, string>, headers: string[]) {
  const name = buildFullName(row, headers);
  const grant = roleColumn(headers, "grant code");
  const participantId = roleColumn(headers, "participant id");
  const muni = roleColumn(headers, "municipality");
  return [
    name.fullName,
    grant ? getCell(row, grant) : "",
    participantId ? getCell(row, participantId) : "",
    muni ? getCell(row, muni) : "",
  ].filter(Boolean).join(" / ") || headers.slice(0, 3).map((header) => getCell(row, header)).filter(Boolean).join(" / ");
}

function composeSmartMatchCompare(attachedSources: any[], message: string) {
  if (attachedSources.length && detectMatchField(message).field === "name") return composeAttachedNameVerification(attachedSources);
  if (attachedSources.length) {
    const matchField = detectMatchField(message);
    const databaseSources = loadSheetSources();
    const databaseRows = sourcesToRows(databaseSources).map(({ source, row }: any) => {
      const keyCol = roleColumn(source.headers, matchField.field);
      const key = keyCol ? getCell(row, keyCol) : "";
      return { source, row, keyCol, key, normalized: normalizeName(key) };
    }).filter((entry: any) => entry.normalized);
    const inputRows = sourcesToRows(attachedSources);
    const rows = inputRows.map(({ source, row }: any, index: number) => {
      const keyCol = roleColumn(source.headers, matchField.field);
      const key = keyCol ? getCell(row, keyCol) : "";
      if (!key) return [String(row.__rowNumber || index + 1), "", "Insufficient data", "", "", "0%", `${matchField.label} column/value not found in input row.`];
      const normalized = normalizeName(key);
      let best: any = null;
      for (const candidate of databaseRows) {
        const score = normalized === candidate.normalized ? 100 : similarityScore(normalized, candidate.normalized);
        if (!best || score > best.score) best = { ...candidate, score };
      }
      const status = best?.score === 100 ? "Exact" : best?.score >= 92 ? "Possible" : "Not matched";
      const matchedRecord = status === "Not matched" ? "" : `${rowDisplay(best.row, best.source.headers)} (row ${best.row.__rowNumber || ""})`;
      const matchedSource = status === "Not matched" ? "" : `${best.source.fileName} / ${best.source.sheetName}`;
      const notes = status === "Exact" ? `Exact ${matchField.label} match.`
        : status === "Possible" ? `Near ${matchField.label} match; review before using.`
        : `No reliable ${matchField.label} match in indexed SQLite data.`;
      return [String(row.__rowNumber || index + 1), key, status, matchedRecord, matchedSource, `${best?.score || 0}%`, notes];
    });
    const metrics = new Map<string, number>();
    rows.forEach((row) => increment(metrics, row[2]));
    return ["**Direct Answer**", `I matched the attached file against existing SQLite-indexed uploaded data by ${matchField.label}.`, "", "**Relevant Table**", markdownTable(["Metric", "Value"], topRows(metrics, 10)), "", "**Relevant Table**", markdownTable(["Input Row", "Input Name/Key", "Match Status", "Matched Record", "Source File/Sheet", "Confidence", "Notes"], rows.slice(0, 150)), "", "**Source Used**", ...attachedSources.map((s: any) => `- Primary input: ${s.source}`), ...databaseSources.slice(0, 10).map((s: any) => `- Comparison data: ${s.source}`), "", "**How I calculated/found it**", `- Used deterministic ${matchField.label} column matching from parsed spreadsheet headers.`, "- Compared against non-chat SQLite-indexed uploaded data only.", "- Used exact normalized key matching first, then high-threshold Levenshtein for possible key typos.", "", "**Data Quality Notes**", "- Rows without the requested key are marked insufficient data.", "- Name matching, when requested, uses full names only and never first names alone.", "", "**Suggested Next Questions**", "- Show only not matched records", "- Export the matched list", "- Check data quality of this file"].join("\n");
  }
  const sources = loadSheetSources();
  return noUploadedSourceAnswer(parseQuery(message), sources.slice(0, 5).map((s: any) => s.source), "Attach an input file to match against existing SQLite-indexed data.");
}

function composeReportFromHistory(sessionId: string, userQuestion: string, userId?: string | null) {
  const last: any = db.prepare("SELECT * FROM analysis_history WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(sessionId);
  if (!last) return NO_RELEVANT_SOURCE_MESSAGE;
  const date = new Date().toLocaleString();
  insertAuditLog({ userId, action: "generate_report", feature: "report", details: { sessionId, sourceAnalysis: last.id } });
  return ["# SLP Knowledge Assistant Report", "", `**Date Generated:** ${date}`, `**User Question:** ${userQuestion}`, "", "## Direct Answer", last.answer_summary, "", "## Data Sources Used", ...(JSON.parse(last.source_files_json || "[]").map((source: string) => `- ${source}`)), "", "## Calculation Explanation", "- Generated from the last saved local analysis in SQLite.", "- No web search or cloud database dependency was used.", "", "## Data Quality Notes", "- Review source files before submission if the report will be used officially.", "", "**Prepared by / generated by app:** SLP Knowledge Assistant"].join("\n");
}

function composeLastAnalysis(sessionId: string) {
  const last: any = db.prepare("SELECT * FROM analysis_history WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(sessionId);
  if (!last) return "No previous analysis was found for this chat session.";
  return ["**Direct Answer**", "Here is the last saved analysis for this chat session.", "", "**Source Used**", ...(JSON.parse(last.source_files_json || "[]").map((source: string) => `- ${source}`)), "", "**Previous Question**", last.question, "", "**Answer Summary**", last.answer_summary, "", "**Data Quality Notes**", `- Saved at ${last.created_at}.`].join("\n");
}

function composeDashboardAnswer(message: string, sessionId: string, attachmentIds: string[] = []) {
  const sources = attachmentIds.length ? loadSheetSources({ attachmentIds }) : loadSheetSources();
  if (!sources.length) return noUploadedSourceAnswer(parseQuery(message), [], "No chartable spreadsheet rows were found.");
  const rows = sourcesToRows(sources);
  const headers = Array.from(new Set(sources.flatMap((s: any) => s.headers)));
  const statusCol = findMatchingColumn(headers, "status");
  const muniCol = findMatchingColumn(headers, "municipality");
  const projectCol = findMatchingColumn(headers, "project");
  const sections = ["**Direct Answer**", `Created a dashboard from ${rows.length} indexed row(s).`, "", "**Relevant Table**", markdownTable(["KPI", "Value"], [["Total rows", String(rows.length)], ["Sources", String(sources.length)], ["Columns", String(headers.length)]]), ""];
  if (statusCol) { const counts = new Map<string, number>(); rows.forEach(({ row }) => increment(counts, getCell(row, statusCol) || "Blank")); sections.push("**Relevant Table**", markdownTable(["Status", "Count"], topRows(counts, 20)), ""); }
  if (muniCol) { const counts = new Map<string, number>(); rows.forEach(({ row }) => increment(counts, getCell(row, muniCol) || "Blank")); sections.push("**Relevant Table**", markdownTable(["Municipality", "Count"], topRows(counts, 20)), ""); }
  if (projectCol) { const counts = new Map<string, number>(); rows.forEach(({ row }) => incrementEnterpriseProjectCount(counts, getCell(row, projectCol) || "Blank")); sections.push("**Relevant Table**", markdownTable(["Top Project", "Count"], topRows(counts, 10)), ""); }
  sections.push("```slp-chart", JSON.stringify({ charts: [{ type: "horizontalBar", title: muniCol ? "Rows by Municipality" : "Rows by Status", data: Array.from((() => { const c = new Map<string, number>(); rows.forEach(({ row }) => increment(c, getCell(row, muniCol || statusCol || headers[0]) || "Blank")); return c; })().entries()).slice(0, 12).map(([name, value]) => ({ name, value })), note: "Computed from indexed SQLite rows only." }] }, null, 2), "```", "", "**Source Used**", ...sources.map((s: any) => `- ${s.source}`), "", "**Data Quality Notes**", "- Charts are based only on computed data from selected sources.");
  return sections.join("\n");
}

function composeParticipantsByMunicipalityChart() {
  const personalSources = sourcesForModules(loadSlpModuleSources(), ["PERSONAL"]);
  if (!personalSources.length) return missingModuleAnswer("PERSONAL");
  const counts = new Map<string, Set<string>>();
  for (const { row, source } of slpRows(personalSources)) {
    const headers = source.headers || [];
    const municipality = slpMunicipality(row, headers) || "Blank";
    const participantId = slpParticipantId(row, headers);
    const fullName = slpFullName(row, headers);
    const barangay = slpValue(row, headers, ["Barangay", "Brgy"]);
    const key = participantId || normalizeName([fullName, municipality, barangay].join("|"));
    if (!key) continue;
    if (!counts.has(municipality)) counts.set(municipality, new Set());
    counts.get(municipality)!.add(key);
  }
  const rows = Array.from(counts.entries())
    .map(([municipality, set]) => [municipality, String(set.size)])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const chartData = rows.map(([municipality, count]) => ({ name: municipality, value: Number(count) }));
  return [
    "**Direct Answer**",
    "Participants by municipality were calculated from the Personal Module.",
    "",
    "**Relevant Table**",
    markdownTable(["Municipality", "Participants"], rows),
    "",
    "**Chart/Graph**",
    "```slp-chart",
    JSON.stringify({ charts: [{ type: "bar", title: "Participants by Municipality", data: chartData, note: "Computed from distinct participant IDs, then full name plus municipality/barangay when IDs are missing." }] }, null, 2),
    "```",
    "",
    "**Source Used**",
    ...personalSources.map((source) => `- ${sourceDisplayName(source)}`),
    "",
    "**Data Quality Notes**",
    "- Used Personal Module only.",
    "- Counted distinct participant IDs first, then full name plus municipality/barangay when IDs were missing.",
  ].join("\n");
}

function composeTopProjectsByMunicipality(message: string) {
  const projectSources = sourcesForModules(loadSlpModuleSources(), ["PROJECT"]);
  if (!projectSources.length) return missingModuleAnswer("PROJECT");
  const limit = Number(message.match(/\btop\s+(\d{1,3})\b/i)?.[1] || 10);
  const counts = new Map<string, number>();
  const projectNameByKey = new Map<string, string>();
  const municipalityByKey = new Map<string, string>();
  for (const { row, source } of slpRows(projectSources)) {
    const headers = source.headers || [];
    const projectName = slpProjectName(row, headers) || slpValue(row, headers, ["Name", "Project Name", "Name of Project", "Livelihood Project"]) || "Unspecified Project";
    const municipality = slpMunicipality(row, headers) || "Blank";
    const projectId = slpProjectId(row, headers);
    const key = projectId || normalizeName(`${projectName}|${municipality}`);
    const participantCount = Number(String(slpValue(row, headers, ["Participant Count", "No. of Participants", "Members", "Member Count"]) || "").replace(/[^0-9.-]/g, "")) || 1;
    counts.set(key, (counts.get(key) || 0) + participantCount);
    projectNameByKey.set(key, projectName);
    municipalityByKey.set(key, municipality);
  }
  const rows = Array.from(counts.entries())
    .map(([key, count]) => [projectNameByKey.get(key) || key, municipalityByKey.get(key) || "-", String(count)])
    .sort((a, b) => Number(b[2]) - Number(a[2]))
    .slice(0, Math.max(1, Math.min(limit, 50)));
  if (!rows.length) return composeVerifiedFallback(message, { selectedSourceTypes: ["SLPIS_PROJECT_MODULE"], filesSearched: projectSources.map(sourceDisplayName) });
  return [
    "**Direct Answer**",
    `Top ${rows.length} projects by municipality were calculated from the Project Module.`,
    "",
    "**Relevant Table**",
    markdownTable(["Project", "Municipality", "Count"], rows),
    "",
    "**Source Used**",
    ...projectSources.map((source) => `- ${sourceDisplayName(source)}`),
    "",
    "**Data Quality Notes**",
    "- Used Project Module only.",
    "- Count uses Participant Count/Member Count columns when available; otherwise each project row counts as 1.",
  ].join("\n");
}

type GenericSheetTable = {
  tableName: string;
  source: any;
  headers: string[];
  rows: Record<string, string>[];
};

function genericSheetTables() {
  inspectDynamicSchema();
  return loadSlpModuleSources({ includeChatAttachments: true }).map((source: any) => ({
    tableName: sourceDisplayName(source),
    source,
    headers: (source.headers || []).filter((header: string) => header && !String(header).startsWith("__")),
    rows: source.rows || [],
  })) as GenericSheetTable[];
}

function conceptTokens(text: string) {
  const stop = new Set(["what", "which", "show", "list", "give", "me", "all", "the", "for", "each", "per", "by", "with", "has", "have", "had", "highest", "lowest", "most", "least", "count", "total", "number", "records", "rows", "different", "unique", "distinct", "possible", "values", "value", "in", "from", "of", "and", "also", "plus", "as", "well", "chart", "bar", "line", "compare", "comparison"]);
  return normalizeName(text).split(" ").filter((token) => token.length > 1 && !stop.has(token));
}

function columnConceptScore(header: string, concept: string) {
  const h = normalizeColumnName(header);
  const c = normalizeColumnName(concept);
  if (!h || !c) return 0;
  if (h === c) return 120;
  if (h.includes(c) || c.includes(h)) return 90;
  const hTokens = new Set(h.replace(/s\b/g, "").split(" ").filter((token) => token.length > 2));
  const cTokens = c.replace(/s\b/g, "").split(" ").filter((token) => token.length > 2 && !["the", "from", "with", "module", "table", "sheet"].includes(token));
  const overlap = cTokens.filter((token) => hTokens.has(token) || Array.from(hTokens).some((hToken) => hToken.includes(token) || token.includes(hToken))).length;
  if (overlap) return 58 + overlap * 18;
  const score = similarityScore(h, c);
  return levenshtein(h, c) < 3 ? Math.max(score, 85) : Math.min(score, 55);
}

function bestGenericColumn(headers: string[], concept: string) {
  const normalizedConcept = normalizeColumnName(concept);
  if (!normalizedConcept) return "";
  let best = { column: "", score: 0 };
  for (const header of headers) {
    const score = columnConceptScore(header, normalizedConcept);
    if (score > best.score) best = { column: header, score };
  }
  if (best.score >= 62) {
    if (normalizeColumnName(best.column) !== normalizedConcept) console.log(`[FUZZY_NAME_CORRECTED] ${JSON.stringify({ requested: concept, corrected: best.column, score: Math.round(best.score) })}`);
    return best.column;
  }
  return "";
}

function numericMetricValue(raw: any) {
  const cleaned = String(raw ?? "").replace(/[^0-9.-]/g, "");
  if (!/[0-9]/.test(cleaned)) return NaN;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : NaN;
}

function bestNumericColumn(headers: string[], rows: Record<string, string>[], concept = "") {
  let best = { column: "", score: 0 };
  const cTokens = normalizeColumnName(concept).replace(/s\b/g, "").split(" ").filter((token) => token.length > 2 && !["the", "from", "with", "module", "table", "sheet"].includes(token));
  for (const header of headers) {
    const values = rows.slice(0, 80).map((row) => numericMetricValue(row[header])).filter(Number.isFinite);
    if (!values.length) continue;
    const conceptScore = concept ? columnConceptScore(header, concept) : 0;
    const hTokens = normalizeColumnName(header).replace(/s\b/g, "").split(" ").filter((token) => token.length > 2);
    const hasOverlap = cTokens.some((token) => hTokens.some((hToken) => hToken === token || hToken.includes(token) || token.includes(hToken)));
    if (concept && (!hasOverlap || conceptScore < 75)) continue;
    if (/\b(date|birthday|created|updated|served)\b/i.test(header) && !/\b(date|birthday|created|updated|served|year)\b/i.test(concept)) continue;
    const score = values.length + conceptScore;
    if (score > best.score) best = { column: header, score };
  }
  return best.column;
}

function findValueColumn(table: GenericSheetTable, rawValue: string) {
  const target = normalizeName(rawValue);
  if (!target) return { column: "", exactRows: [] as Record<string, string>[], partialRows: [] as Record<string, string>[], closest: "" };
  let best = { column: "", exactRows: [] as Record<string, string>[], partialRows: [] as Record<string, string>[], closest: "", closestDistance: Number.POSITIVE_INFINITY };
  for (const header of table.headers) {
    const exactRows: Record<string, string>[] = [];
    const partialRows: Record<string, string>[] = [];
    for (const row of table.rows) {
      const value = normalizeName(getCell(row, header));
      if (!value) continue;
      if (value === target) exactRows.push(row);
      else if (value.includes(target) || target.includes(value)) partialRows.push(row);
      const distance = levenshtein(value, target);
      if (distance < best.closestDistance) best = { ...best, closest: getCell(row, header), closestDistance: distance };
    }
    if (exactRows.length > best.exactRows.length || (!best.exactRows.length && partialRows.length > best.partialRows.length)) {
      best = { ...best, column: header, exactRows, partialRows };
    }
  }
  if (!best.exactRows.length && !best.partialRows.length && best.closest) console.log(`[FUZZY_VALUE_MATCH] ${JSON.stringify({ requested: rawValue, closest: best.closest, distance: best.closestDistance })}`);
  return best;
}

function relevantTableScore(table: GenericSheetTable, query: string, concepts: string[]) {
  const text = normalizeName(`${table.tableName} ${(table.headers || []).join(" ")}`);
  const samples = table.rows.slice(0, 8).map((row) => table.headers.map((header) => row[header]).join(" ")).join(" ");
  const sampleText = normalizeName(samples);
  const rowScore = Math.min(40, Math.log10(Math.max(table.rows.length, 1)) * 16);
  const sparsePenalty = table.rows.length < 5 ? -60 : 0;
  return rowScore + sparsePenalty + concepts.reduce((score, concept) => {
    const c = normalizeName(concept);
    return score + (text.includes(c) ? 30 : 0) + (sampleText.includes(c) ? 12 : 0) + (bestGenericColumn(table.headers, c) ? 25 : 0);
  }, query ? conceptTokens(query).filter((token) => text.includes(token)).length * 4 : 0);
}

function metricCanUseCount(metricConcept: string) {
  return /\b(participants?|beneficiar|clients?|members?|records?|rows?|completions?|attendance|attendances?)\b/i.test(metricConcept);
}

function bestDateColumnForQuestion(headers: string[], rows: Record<string, string>[], message: string) {
  let best = { column: "", score: 0 };
  const tokens = conceptTokens(message);
  for (const header of headers) {
    const parsedDates = rows.slice(0, 80).map((row) => parseFlexibleDate(getCell(row, header))).filter(Boolean).length;
    if (!parsedDates) continue;
    const normalizedHeader = normalizeColumnName(header);
    const tokenScore = tokens.filter((token) => normalizedHeader.includes(token) || token.includes(normalizedHeader)).length * 30;
    const dateWordScore = /\b(date|created|updated|served|added|encoded|registered|submitted)\b/i.test(header) ? 35 : 0;
    const score = parsedDates + tokenScore + dateWordScore;
    if (score > best.score) best = { column: header, score };
  }
  return best.column || bestDateColumn(headers);
}

function selectGenericTables(query: string, concepts: string[] = []) {
  return genericSheetTables()
    .map((table) => ({ table, score: relevantTableScore(table, query, concepts) }))
    .filter((item) => item.table.rows.length && item.table.headers.length)
    .sort((a, b) => b.score - a.score || b.table.rows.length - a.table.rows.length)
    .map((item) => item.table);
}

function distinctListingRequest(message: string) {
  const match = message.match(/\b(?:list\s+all\s+unique|list\s+unique|distinct|show\s+me\s+the\s+different|what\s+are\s+the\s+different|what\s+are\s+the\s+possible|different)\s+([A-Za-z][A-Za-z\s/_-]{1,80}?)(?:\s+(?:in|from)\s+(.+?))?(?:[?.!]|$)/i);
  if (!match) return null;
  let columnConcept = match[1].trim();
  let tableHint = String(match[2] || "").trim();
  const embeddedScope = columnConcept.match(/^(.+?)\s+(?:in|from)\s+(.+)$/i);
  if (embeddedScope) {
    columnConcept = embeddedScope[1].trim();
    tableHint = tableHint || embeddedScope[2].trim();
  }
  const words = columnConcept.split(/\s+/).filter(Boolean);
  if (words.length > 1) columnConcept = words.filter((word) => !/^(levels?|values?)$/i.test(word)).join(" ") || columnConcept;
  return { columnConcept, tableHint };
}

function composeGenericDistinctListingAnswer(message: string, trace: any = null) {
  const request = distinctListingRequest(message);
  if (!request) return "";
  const tables = selectGenericTables(`${request.tableHint} ${request.columnConcept}`, [request.columnConcept, request.tableHint]);
  for (const table of tables) {
    const column = bestGenericColumn(table.headers, request.columnConcept);
    if (!column) continue;
    const values = Array.from(new Set(table.rows.map((row) => getCell(row, column)).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    if (!values.length) continue;
    const generatedSql = `SELECT DISTINCT "${column}" FROM "${table.tableName}" ORDER BY "${column}"`;
    console.log(`[SQLITE_ROUTING] ${JSON.stringify({ userQuery: message, route: "distinct_listing", table: table.tableName, column })}`);
    console.log(`[DISTINCT_LISTING] ${JSON.stringify({ userQuery: message, generatedSql, rowCount: values.length })}`);
    if (trace) { trace.sqliteResult = values; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "generic_distinct_listing" }; }
    return [
      "**Direct Answer**",
      `Found ${values.length} distinct value(s) for ${column}.`,
      "",
      "**Relevant Table**",
      markdownTable([column], values.slice(0, 200).map((value) => [value])),
      "",
      "**Source Used**",
      `- ${table.tableName}`,
      "",
      "**How I calculated/found it**",
      `- SQL shape: ${generatedSql}`,
    ].join("\n");
  }
  return "";
}

function simpleCountRequest(message: string) {
  const match = message.match(/\b(?:how many|count(?:\s+of)?|total(?:\s+number\s+of)?)\s+([A-Za-z][A-Za-z\s/_-]{1,60}?)(?:\s+(?:are\s+)?(?:in|from|at|for)\s+([A-Za-z][A-Za-z0-9\s.'/_-]{1,80}))?(?:[?.!]|$)/i);
  if (!match) return null;
  return { entityConcept: match[1].trim(), filterValue: String(match[2] || "").trim() };
}

function composeGenericSimpleCountAnswer(message: string, trace: any = null) {
  const request = simpleCountRequest(message);
  if (!request || !request.filterValue || dateRangeFromQuestion(message)) return "";
  const tables = selectGenericTables(message, [request.entityConcept, request.filterValue]);
  for (const table of tables) {
    const filter = findValueColumn(table, request.filterValue);
    const matched = filter.exactRows.length ? filter.exactRows : filter.partialRows;
    if (!filter.column || !matched.length) continue;
    const matchType = filter.exactRows.length ? "exact" : "partial";
    const generatedSql = matchType === "exact"
      ? `SELECT COUNT(*) FROM "${table.tableName}" WHERE LOWER("${filter.column}") = LOWER(?)`
      : `SELECT COUNT(*) FROM "${table.tableName}" WHERE LOWER("${filter.column}") LIKE LOWER(?)`;
    console.log(`[SQLITE_ROUTING] ${JSON.stringify({ userQuery: message, route: "simple_count", table: table.tableName, filterColumn: filter.column, matchType })}`);
    if (matchType === "partial") console.log(`[FUZZY_VALUE_MATCH] ${JSON.stringify({ requested: request.filterValue, matchType, column: filter.column })}`);
    if (trace) { trace.sqliteResult = { count: matched.length, table: table.tableName, filterColumn: filter.column }; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "generic_simple_count" }; }
    return [
      "**Direct Answer**",
      `Found ${matched.length} ${request.entityConcept} row(s) where ${filter.column} matches "${request.filterValue}".`,
      matchType === "partial" ? "No exact case-insensitive match was found, so partial matching was used." : "",
      "",
      "**Relevant Table**",
      markdownTable([filter.column, "Count"], [[request.filterValue, String(matched.length)]]),
      "",
      "**Source Used**",
      `- ${table.tableName}`,
      "",
      "**How I calculated/found it**",
      `- SQL shape: ${generatedSql}`,
    ].filter(Boolean).join("\n");
  }
  console.log(`[FUZZY_VALUE_MATCH] ${JSON.stringify({ requested: request.filterValue, result: "no matching value in inspected tables" })}`);
  return "";
}

function columnValueTopRequest(message: string) {
  const match = message.match(/\b(?:which|what)\s+([A-Za-z][A-Za-z\s/_-]{1,50}?)\s+(?:in|from|at|for)\s+([A-Za-z][A-Za-z0-9\s.'/_-]{1,80}?)\s+(?:has|have|with)\s+(?:the\s+)?(?:most|highest|least|lowest)\s+([A-Za-z][A-Za-z\s/_-]{1,60})(?:[?.!]|$)/i);
  if (!match) return null;
  return { targetConcept: match[1].trim(), filterValue: match[2].trim(), metricConcept: match[3].trim(), direction: /\b(least|lowest)\b/i.test(message) ? "ASC" : "DESC" };
}

function composeGenericColumnValueTopAnswer(message: string, trace: any = null) {
  const request = columnValueTopRequest(message);
  if (!request) return "";
  const tables = selectGenericTables(message, [request.targetConcept, request.metricConcept, request.filterValue]);
  for (const table of tables) {
    const targetColumn = bestGenericColumn(table.headers, request.targetConcept);
    const filter = findValueColumn(table, request.filterValue);
    if (!targetColumn || !filter.column) continue;
    const matched = filter.exactRows.length ? filter.exactRows : filter.partialRows;
    if (!matched.length) continue;
    const counts = new Map<string, number>();
    for (const row of matched) {
      const key = getCell(row, targetColumn) || "Blank";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => request.direction === "DESC" ? b[1] - a[1] : a[1] - b[1]);
    const top = sorted[0];
    if (!top) continue;
    const generatedSql = `SELECT "${targetColumn}", COUNT(*) AS count FROM "${table.tableName}" WHERE LOWER("${filter.column}") ${filter.exactRows.length ? "= LOWER(?)" : "LIKE LOWER(?)"} GROUP BY "${targetColumn}" ORDER BY count ${request.direction} LIMIT 1`;
    console.log(`[SQLITE_ROUTING] ${JSON.stringify({ userQuery: message, route: "column_value_aggregation", table: table.tableName, targetColumn, filterColumn: filter.column })}`);
    console.log(`[COLUMN_VALUE_AGGREGATION] ${JSON.stringify({ userQuery: message, generatedSql, top: top[0], count: top[1] })}`);
    if (!filter.exactRows.length) console.log(`[FUZZY_VALUE_MATCH] ${JSON.stringify({ requested: request.filterValue, matchType: "partial", column: filter.column })}`);
    if (trace) { trace.sqliteResult = sorted; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "generic_column_value_top" }; }
    return [
      "**Direct Answer**",
      `${top[0]} has the ${request.direction === "DESC" ? "highest" : "lowest"} count (${top[1]}) for ${request.filterValue}.`,
      "",
      "**Relevant Table**",
      markdownTable([targetColumn, "Count"], sorted.slice(0, 20).map(([value, count]) => [value, String(count)])),
      "",
      "**Source Used**",
      `- ${table.tableName}`,
      "",
      "**How I calculated/found it**",
      `- SQL shape: ${generatedSql}`,
    ].join("\n");
  }
  return "";
}

function globalTopValueRequest(message: string) {
  const match = message.match(/\b(?:which|what)\s+([A-Za-z][A-Za-z\s/_-]{1,60}?)\s+(?:has|have|with)\s+(?:the\s+)?(?:most|highest|least|lowest)\s+([A-Za-z][A-Za-z\s/_-]{1,80})(?:[?.!]|$)/i);
  if (!match) return null;
  return { dimensionConcept: match[1].trim(), metricConcept: match[2].trim(), direction: /\b(least|lowest)\b/i.test(message) ? "ASC" : "DESC" };
}

function composeGenericGlobalTopValueAnswer(message: string, trace: any = null) {
  const request = globalTopValueRequest(message);
  if (!request) return "";
  const tables = selectGenericTables(message, [request.dimensionConcept, request.metricConcept]);
  for (const table of tables) {
    const dimensionColumn = bestGenericColumn(table.headers, request.dimensionConcept);
    if (!dimensionColumn) continue;
    const metricColumn = metricCanUseCount(request.metricConcept) ? "" : bestNumericColumn(table.headers, table.rows, request.metricConcept);
    if (!metricColumn && !metricCanUseCount(request.metricConcept)) continue;
    const totals = new Map<string, number>();
    for (const row of table.rows) {
      const dimension = getCell(row, dimensionColumn) || "Blank";
      const metricValue = metricColumn ? numericMetricValue(row[metricColumn]) : NaN;
      totals.set(dimension, (totals.get(dimension) || 0) + (Number.isFinite(metricValue) ? metricValue : 1));
    }
    const rows = Array.from(totals.entries()).sort((a, b) => request.direction === "DESC" ? b[1] - a[1] : a[1] - b[1]).slice(0, 20);
    if (!rows.length) continue;
    const generatedSql = `SELECT "${dimensionColumn}", ${metricColumn ? `SUM("${metricColumn}")` : "COUNT(*)"} AS metric FROM "${table.tableName}" GROUP BY "${dimensionColumn}" ORDER BY metric ${request.direction} LIMIT 20`;
    console.log(`[SQLITE_ROUTING] ${JSON.stringify({ userQuery: message, route: "global_top_value", table: table.tableName, dimensionColumn, metricColumn: metricColumn || "COUNT(*)" })}`);
    console.log(`[TOP_N_PER_GROUP] ${JSON.stringify({ userQuery: message, mode: "global_top_value", generatedSql, rows: rows.length })}`);
    if (trace) { trace.sqliteResult = rows; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "generic_global_top_value" }; }
    return [
      "**Direct Answer**",
      `${rows[0][0]} has the ${request.direction === "DESC" ? "highest" : "lowest"} ${request.metricConcept} (${rows[0][1]}).`,
      "",
      "**Relevant Table**",
      markdownTable([dimensionColumn, metricColumn || "Count"], rows.map(([value, count]) => [value, String(count)])),
      "",
      "**Source Used**",
      `- ${table.tableName}`,
      "",
      "**How I calculated/found it**",
      `- SQL shape: ${generatedSql}`,
    ].join("\n");
  }
  return "";
}

type HybridAggregationSpec = {
  dimensionConcept: string;
  metricConcept: string;
  filterConcept: string;
  direction: "ASC" | "DESC";
  followupRequest: string;
  aggregationQuestion: string;
};

type HybridAggregationResult = {
  ok: boolean;
  entity: string;
  metricValue: number;
  tableName: string;
  dimensionColumn: string;
  metricColumn: string;
  filterColumn: string;
  filterConcept: string;
  generatedSql: string;
  rows: string[][];
  reason?: string;
};

function parseGenericHybridAggregationQuestion(message: string): HybridAggregationSpec | null {
  const parts = String(message || "").split(/\b(?:then|and then|after that)\b/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const aggregationQuestion = parts[0];
  const followupRequest = parts.slice(1).join(" then ");
  if (!/\b(which|what)\b/i.test(aggregationQuestion) || !/\b(highest|largest|biggest|most|lowest|smallest|least)\b/i.test(aggregationQuestion)) return null;
  const match = aggregationQuestion.match(/\b(?:which|what)\s+([A-Za-z][A-Za-z\s/_-]{1,80}?)\s+(?:has|have|with)\s+(?:the\s+)?(?:highest|largest|biggest|most|lowest|smallest|least)\s+(.+?)(?:[?.!]|$)/i);
  if (!match) return null;
  const metricPhrase = match[2].replace(/\b(number\s+of|count\s+of|total\s+number\s+of|total)\b/gi, " ").replace(/\s+/g, " ").trim();
  const metricTokens = conceptTokens(metricPhrase);
  const countWords = new Set(["participant", "participants", "beneficiary", "beneficiaries", "member", "members", "client", "clients", "completion", "completions", "attendance", "attendances", "record", "records", "row", "rows"]);
  const filterConcept = metricTokens.filter((token) => !countWords.has(token)).join(" ");
  return {
    dimensionConcept: match[1].trim(),
    metricConcept: metricPhrase,
    filterConcept: metricCanUseCount(metricPhrase) ? filterConcept : "",
    direction: /\b(lowest|smallest|least)\b/i.test(aggregationQuestion) ? "ASC" : "DESC",
    followupRequest,
    aggregationQuestion,
  };
}

function rowText(row: Record<string, string>, headers: string[]) {
  return normalizeName(headers.map((header) => getCell(row, header)).join(" "));
}

function bestFilterColumnForConcept(table: GenericSheetTable, filterConcept: string) {
  const concept = normalizeName(filterConcept);
  if (!concept) return "";
  let best = { column: "", score: 0 };
  for (const header of table.headers) {
    const headerScore = columnConceptScore(header, concept);
    const sampleScore = table.rows.slice(0, 100).reduce((score, row) => {
      const value = normalizeName(getCell(row, header));
      if (!value) return score;
      if (value === concept) return score + 30;
      if (value.includes(concept) || concept.includes(value)) return score + 18;
      return score;
    }, 0);
    const score = headerScore + Math.min(120, sampleScore);
    if (score > best.score) best = { column: header, score };
  }
  return best.score >= 45 ? best.column : "";
}

function rowMatchesConcept(row: Record<string, string>, headers: string[], filterColumn: string, filterConcept: string) {
  const concept = normalizeName(filterConcept);
  if (!concept) return true;
  if (filterColumn) {
    const value = normalizeName(getCell(row, filterColumn));
    if (value.includes(concept) || concept.includes(value)) return true;
  }
  return rowText(row, headers).includes(concept);
}

function executeGenericHybridAggregation(spec: HybridAggregationSpec): HybridAggregationResult {
  const concepts = [spec.dimensionConcept, spec.metricConcept, spec.filterConcept].filter(Boolean);
  const tables = selectGenericTables(spec.aggregationQuestion, concepts);
  let bestFailure = "No indexed table matched the aggregation concepts.";
  const candidates: Array<HybridAggregationResult & { candidateScore: number }> = [];
  for (const table of tables) {
    const dimensionColumn = bestGenericColumn(table.headers, spec.dimensionConcept);
    if (!dimensionColumn) {
      bestFailure = `No grouping column matched "${spec.dimensionConcept}".`;
      continue;
    }
    const useCount = metricCanUseCount(spec.metricConcept);
    const metricColumn = useCount ? "" : bestNumericColumn(table.headers, table.rows, spec.metricConcept);
    if (!useCount && !metricColumn) {
      bestFailure = `No numeric metric column matched "${spec.metricConcept}".`;
      continue;
    }
    const filterColumn = spec.filterConcept ? bestFilterColumnForConcept(table, spec.filterConcept) : "";
    const filteredRows = table.rows.filter((row) => rowMatchesConcept(row, table.headers, filterColumn, spec.filterConcept));
    if (!filteredRows.length) {
      bestFailure = spec.filterConcept ? `No rows matched filter "${spec.filterConcept}".` : "No rows were available for aggregation.";
      continue;
    }
    const totals = new Map<string, number>();
    for (const row of filteredRows) {
      const entity = getCell(row, dimensionColumn) || "Blank";
      const amount = metricColumn ? numericMetricValue(row[metricColumn]) : 1;
      if (!Number.isFinite(amount)) continue;
      totals.set(entity, (totals.get(entity) || 0) + amount);
    }
    const rows = Array.from(totals.entries()).sort((a, b) => spec.direction === "DESC" ? b[1] - a[1] : a[1] - b[1]).slice(0, 20);
    if (!rows.length) {
      bestFailure = "Aggregation produced no numeric/countable rows.";
      continue;
    }
    const whereClause = spec.filterConcept
      ? filterColumn
        ? `WHERE LOWER("${filterColumn}") LIKE LOWER(?)`
        : "WHERE row_text LIKE ?"
      : "";
    const generatedSql = `SELECT "${dimensionColumn}", ${metricColumn ? `SUM("${metricColumn}")` : "COUNT(*)"} AS metric FROM "${table.tableName}" ${whereClause} GROUP BY "${dimensionColumn}" ORDER BY metric ${spec.direction} LIMIT 20`;
    const conceptText = normalizeName(`${table.tableName} ${table.headers.join(" ")}`);
    const conceptHitScore = conceptTokens(`${spec.dimensionConcept} ${spec.metricConcept} ${spec.filterConcept}`).filter((token) => conceptText.includes(token)).length * 30;
    const filterScore = spec.filterConcept ? Math.min(80, filteredRows.length / Math.max(1, table.rows.length) * 80) : 20;
    candidates.push({
      ok: true,
      entity: rows[0][0],
      metricValue: rows[0][1],
      tableName: table.tableName,
      dimensionColumn,
      metricColumn: metricColumn || "COUNT(*)",
      filterColumn,
      filterConcept: spec.filterConcept,
      generatedSql,
      rows: rows.map(([entity, value]) => [entity, String(value)]),
      candidateScore: conceptHitScore + filterScore + Math.min(80, Math.log10(Math.max(table.rows.length, 1)) * 25),
    });
  }
  if (candidates.length) {
    const best = candidates.sort((a, b) => b.candidateScore - a.candidateScore || b.metricValue - a.metricValue)[0];
    const { candidateScore: _candidateScore, ...result } = best;
    return result;
  }
  return {
    ok: false,
    entity: "",
    metricValue: 0,
    tableName: "",
    dimensionColumn: "",
    metricColumn: "",
    filterColumn: "",
    filterConcept: spec.filterConcept,
    generatedSql: "",
    rows: [],
    reason: bestFailure,
  };
}

function topNPerGroupRequest(message: string) {
  const text = String(message || "");
  if (!/\b(for each|per|by)\b/i.test(text) || !/\b(highest|lowest|most|least|top)\b/i.test(text)) return null;
  const dimension = text.match(/\b(?:for each|per|by)\s+([A-Za-z][A-Za-z\s/_-]{1,50}?)(?:,|\s+show|\s+which|\s+what|\s+list|\s+the|\s+has|\s+with|$)/i)?.[1]?.trim() || "";
  const entity = text.match(/\b(?:show|which|what|list)\s+(?:the\s+)?([A-Za-z][A-Za-z\s/_-]{1,50}?)\s+(?:with|has|having)\b/i)?.[1]?.trim()
    || text.match(/\b([A-Za-z][A-Za-z\s/_-]{1,50}?)\s+with\s+(?:the\s+)?(?:highest|lowest|most|least|top)\b/i)?.[1]?.trim()
    || "";
  const metric = text.match(/\b(?:highest|lowest|most|least|top)\s+([A-Za-z][A-Za-z\s/_-]{1,60})(?:[?.!]|$)/i)?.[1]?.trim() || entity;
  if (!dimension || !entity) return null;
  return { dimension, entity, metric, direction: /\b(lowest|least)\b/i.test(text) ? "ASC" : "DESC" };
}

function composeGenericTopNPerGroupAnswer(message: string, trace: any = null) {
  const request = topNPerGroupRequest(message);
  if (!request) return "";
  const tables = selectGenericTables(message, [request.dimension, request.entity, request.metric]);
  for (const table of tables) {
    const dimensionColumn = bestGenericColumn(table.headers, request.dimension);
    const entityColumn = bestGenericColumn(table.headers, request.entity);
    if (!dimensionColumn || !entityColumn) continue;
    const metricColumn = metricCanUseCount(request.metric) ? "" : bestNumericColumn(table.headers, table.rows, request.metric);
    if (!metricColumn && !metricCanUseCount(request.metric)) continue;
    const groupValues = new Map<string, Map<string, number>>();
    for (const row of table.rows) {
      const dimension = getCell(row, dimensionColumn) || "Blank";
      const entity = getCell(row, entityColumn) || "Blank";
      if (!groupValues.has(dimension)) groupValues.set(dimension, new Map());
      const metricValue = metricColumn ? numericMetricValue(row[metricColumn]) : NaN;
      const incrementBy = Number.isFinite(metricValue) ? metricValue : 1;
      groupValues.get(dimension)!.set(entity, (groupValues.get(dimension)!.get(entity) || 0) + incrementBy);
    }
    const rows = Array.from(groupValues.entries()).map(([dimension, entities]) => {
      const sorted = Array.from(entities.entries()).sort((a, b) => request.direction === "DESC" ? b[1] - a[1] : a[1] - b[1]);
      const [entity, metric] = sorted[0] || ["", 0];
      return [dimension, entity, String(metric)];
    }).filter((row) => row[1]).sort((a, b) => a[0].localeCompare(b[0]));
    if (!rows.length) continue;
    const generatedSql = `WITH ranked AS (SELECT "${dimensionColumn}", "${entityColumn}", ${metricColumn ? `SUM("${metricColumn}")` : "COUNT(*)"} AS metric, ROW_NUMBER() OVER (PARTITION BY "${dimensionColumn}" ORDER BY ${metricColumn ? `SUM("${metricColumn}")` : "COUNT(*)"} ${request.direction}) AS rn FROM "${table.tableName}" GROUP BY "${dimensionColumn}", "${entityColumn}") SELECT * FROM ranked WHERE rn = 1`;
    console.log(`[SQLITE_ROUTING] ${JSON.stringify({ userQuery: message, route: "top_n_per_group", table: table.tableName, dimensionColumn, entityColumn, metricColumn: metricColumn || "COUNT(*)" })}`);
    console.log(`[TOP_N_PER_GROUP] ${JSON.stringify({ userQuery: message, generatedSql, rows: rows.length })}`);
    if (trace) { trace.sqliteResult = rows; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "generic_top_n_per_group" }; }
    return [
      "**Direct Answer**",
      `Computed the ${request.direction === "DESC" ? "highest" : "lowest"} ${request.entity} per ${request.dimension}.`,
      "",
      "**Relevant Table**",
      markdownTable([dimensionColumn, entityColumn, metricColumn || "Count"], rows),
      "",
      "**Source Used**",
      `- ${table.tableName}`,
      "",
      "**How I calculated/found it**",
      `- SQL shape: ${generatedSql}`,
    ].join("\n");
  }
  return "";
}

function relativeDateRangesFromQuestion(message: string) {
  const now = new Date();
  const unitMatch = message.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+(days?|weeks?|months?|years?)\b/i);
  if (!unitMatch) return null;
  const amount = Number(unitMatch[1]);
  const unit = unitMatch[2].toLowerCase().replace(/s$/, "");
  const shift = (date: Date, multiplier: number) => {
    const copy = new Date(date);
    if (unit === "day") copy.setDate(copy.getDate() + multiplier * amount);
    else if (unit === "week") copy.setDate(copy.getDate() + multiplier * amount * 7);
    else if (unit === "month") copy.setMonth(copy.getMonth() + multiplier * amount);
    else if (unit === "year") copy.setFullYear(copy.getFullYear() + multiplier * amount);
    return copy;
  };
  const asksPreviousOnly = /\bprevious\s+\d{1,3}\s+(?:days?|weeks?|months?|years?)\b/i.test(message) && !/\b(last|past)\s+\d{1,3}\s+(?:days?|weeks?|months?|years?)\b/i.test(message);
  const current = asksPreviousOnly
    ? { label: `previous ${amount} ${unit}${amount === 1 ? "" : "s"}`, start: fmtDate(shift(now, -2)), end: fmtDate(shift(now, -1)) }
    : { label: `${unitMatch[0]}`, start: fmtDate(shift(now, -1)), end: fmtDate(now) };
  const previous = !asksPreviousOnly && /\bvs|versus|compare|previous\b/i.test(message)
    ? { label: `previous ${amount} ${unit}${amount === 1 ? "" : "s"}`, start: fmtDate(shift(now, -2)), end: fmtDate(shift(now, -1)) }
    : null;
  console.log(`[RELATIVE_DATE_RANGE] ${JSON.stringify({ userQuery: message, current, previous })}`);
  return { current, previous, unit, amount };
}

function composeGenericRelativeDateAnswer(message: string, trace: any = null) {
  const ranges = relativeDateRangesFromQuestion(message);
  if (!ranges) return "";
  const tables = selectGenericTables(message, conceptTokens(message));
  for (const table of tables) {
    const dateColumn = bestDateColumnForQuestion(table.headers, table.rows, message);
    if (!dateColumn) continue;
    const countRange = (range: { start: string; end: string }) => table.rows.filter((row) => {
      const date = parseFlexibleDate(getCell(row, dateColumn));
      return date && date >= range.start && date <= range.end;
    }).length;
    const rows = [[ranges.current.label, ranges.current.start, ranges.current.end, String(countRange(ranges.current))]];
    if (ranges.previous) rows.push([ranges.previous.label, ranges.previous.start, ranges.previous.end, String(countRange(ranges.previous))]);
    const generatedSql = `SELECT COUNT(*) FROM "${table.tableName}" WHERE date("${dateColumn}") BETWEEN ? AND ?`;
    console.log(`[SQLITE_ROUTING] ${JSON.stringify({ userQuery: message, route: "relative_date_range", table: table.tableName, dateColumn })}`);
    if (trace) { trace.sqliteResult = rows; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "generic_relative_date" }; }
    const chart = chartRequested(message) ? ["", "**Chart Code**", "```python", "import matplotlib.pyplot as plt", `labels = ${JSON.stringify(rows.map((row) => row[0]))}`, `counts = ${JSON.stringify(rows.map((row) => Number(row[3])))}`, "plt.figure(figsize=(8,5))", "plt.bar(labels, counts)", "plt.title('Relative Date Range Comparison')", "plt.ylabel('Rows')", "plt.tight_layout()", "plt.show()", "```"] : [];
    return [
      "**Direct Answer**",
      `Computed row counts using ${dateColumn} for the requested relative date range${ranges.previous ? " comparison" : ""}.`,
      "",
      "**Relevant Table**",
      markdownTable(["Period", "Start", "End", "Rows"], rows),
      ...chart,
      "",
      "**Source Used**",
      `- ${table.tableName}`,
      "",
      "**How I calculated/found it**",
      `- SQL shape: ${generatedSql}`,
    ].join("\n");
  }
  return "";
}

async function composeGenericHybridTopDescriptionAnswer(message: string, parsed: ParsedQuery, route: QueryRoute | null, attachmentIds: string[] = [], trace: any = null) {
  const hybridSpec = parseGenericHybridAggregationQuestion(message);
  if (hybridSpec) {
    const aggregation = executeGenericHybridAggregation(hybridSpec);
    console.log(`[HYBRID_QUERY_AGGREGATION] ${JSON.stringify({ userQuery: message, spec: hybridSpec, result: aggregation })}`);
    const entityQuery = aggregation.entity
      ? `${aggregation.entity} ${hybridSpec.followupRequest}`
      : `${hybridSpec.dimensionConcept} ${hybridSpec.metricConcept} ${hybridSpec.filterConcept} ${hybridSpec.followupRequest}`;
    const docRoute = routeUserQuery(entityQuery);
    console.log(`[HYBRID_QUERY_DOC_RETRIEVAL] ${JSON.stringify({ userQuery: message, entityQuery, aggregationOk: aggregation.ok })}`);
    const docTrace: any = {};
    const docAnswer = await answerFromRoutedDocumentText(entityQuery, { ...parsed, intentType: "explanation/definition" }, docRoute, attachmentIds, docTrace);
    if (trace) {
      trace.sqliteResult = aggregation;
      trace.finalEvidenceText = [
        aggregation.ok ? `Aggregation evidence: ${aggregation.entity} = ${aggregation.metricValue}; source=${aggregation.tableName}; sql=${aggregation.generatedSql}` : `Aggregation failed: ${aggregation.reason || ""}`,
        docTrace.finalEvidenceText || "",
      ].filter(Boolean).join("\n\n");
      trace.topRetrievedChunks = docTrace.topRetrievedChunks || trace.topRetrievedChunks || [];
      trace.filesSearched = docTrace.filesSearched || trace.filesSearched || [];
      trace.finalSourceUsed = { sourceType: "SQLite+RAG", answerMode: "generic_hybrid_query", entity: aggregation.entity || "" };
    }
    const sections = ["**Direct Answer**"];
    if (aggregation.ok) {
      sections.push(
        `The ${hybridSpec.dimensionConcept} with the ${hybridSpec.direction === "DESC" ? "highest" : "lowest"} ${hybridSpec.metricConcept} is ${aggregation.entity} with ${aggregation.metricValue}.`,
        "",
        "**Aggregation Table**",
        markdownTable([aggregation.dimensionColumn, aggregation.metricColumn], aggregation.rows),
        "",
        "**Aggregation Source**",
        `- ${aggregation.tableName}`,
        "",
        "**How I calculated/found it**",
        `- SQL shape: ${aggregation.generatedSql}`,
        aggregation.filterConcept ? `- Applied filter concept: ${aggregation.filterConcept}${aggregation.filterColumn ? ` via ${aggregation.filterColumn}` : " across row text"}.` : ""
      );
    } else {
      sections.push(
        `I could not complete the SQLite aggregation: ${aggregation.reason || "No matching structured data was found."}`,
        "",
        "**Aggregation Attempted**",
        `- Grouping concept: ${hybridSpec.dimensionConcept}`,
        `- Metric concept: ${hybridSpec.metricConcept}`,
        hybridSpec.filterConcept ? `- Filter concept: ${hybridSpec.filterConcept}` : "- Filter concept: none"
      );
    }
    sections.push(
      "",
      "**Document Retrieval**",
      docAnswer || "I attempted document retrieval as the second step, but did not find verified document text for this entity/request."
    );
    return sections.filter(Boolean).join("\n");
  }
  if (!/\b(describe|explain|what is|tell me about)\b/i.test(message) || !/\b(most|highest|top|least|lowest)\b/i.test(message)) return "";
  const structured = composeGenericColumnValueTopAnswer(message, trace) || composeGenericTopNPerGroupAnswer(message, trace) || composeGenericGlobalTopValueAnswer(message, trace) || composeGenericSimpleCountAnswer(message, trace);
  const table = firstMarkdownTable(structured || "");
  const entity = table?.headers?.length === 2 ? table?.rows?.[0]?.[0] : table?.rows?.[0]?.[1] || table?.rows?.[0]?.[0] || "";
  if (!structured || !entity) return "";
  console.log(`[HYBRID_QUERY] ${JSON.stringify({ userQuery: message, entity })}`);
  const docAnswer = await answerFromRoutedDocumentText(`Describe ${entity}`, parsed, route || routeUserQuery(message), attachmentIds, trace);
  return [
    structured,
    "",
    "**Description From Documents**",
    docAnswer || "I found the structured result, but no verified document description was available.",
  ].join("\n");
}

function safePragmaTableInfo(tableName: string) {
  const sanitized = String(tableName || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(sanitized)) return [];
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(sanitized);
  if (!exists) return [];
  return db.prepare(`PRAGMA table_info(${sanitized})`).all();
}

function sqliteTableSchemasForDebug(tableNames: string[]) {
  return tableNames.map((tableName) => ({
    tableName,
    columns: safePragmaTableInfo(tableName).map((row: any) => ({
      name: row.name,
      type: row.type || "",
      notNull: Number(row.notnull || 0),
      primaryKey: Number(row.pk || 0),
    })),
  }));
}

function metadataQueryTarget(message: string) {
  if (!/\b(columns?|column names?|schema|fields?|headers?)\b/i.test(message)) return null;
  if (!/\b(list|show|what|which|get|display|names?)\b/i.test(message)) return null;
  const explicitTable = message.match(/\b(?:table|sqlite table)\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)?.[1] || "";
  if (explicitTable) return { type: "sqlite_table", tableName: explicitTable };
  if (/personal module|participants?|beneficiar|client/i.test(message)) return { type: "personal_module", tableName: "sheet_rows" };
  return null;
}

function composeMetadataQueryAnswer(message: string, trace: any = null) {
  const target = metadataQueryTarget(message);
  if (!target) return "";
  const pragmaRows: any[] = safePragmaTableInfo(target.tableName);
  if (!pragmaRows.length) return composeVerifiedFallback(message, { ...trace, selectedSourceTypes: ["SQLite"], filesSearched: [] });

  if (target.type === "sqlite_table") {
    console.log(`[METADATA_QUERY_HANDLED] ${JSON.stringify({ userQuery: message, target: target.type, table: target.tableName, rows: pragmaRows.length })}`);
    console.log(`[SQLITE_RETRIEVAL_RESULTS] ${JSON.stringify({
      userQuery: message,
      selectedTables: [target.tableName],
      tableSchemas: pragmaRows.map((row) => `${row.name} ${row.type || ""}`.trim()),
      generatedSql: `PRAGMA table_info(${target.tableName})`,
      rowCountReturned: pragmaRows.length,
      first5ResultRows: pragmaRows.slice(0, 5),
    })}`);
    return [
      "**Direct Answer**",
      `Here are the SQLite columns for \`${target.tableName}\`.`,
      "",
      "**Relevant Table**",
      markdownTable(["Name", "Type", "Not Null", "Default", "Primary Key"], pragmaRows.map((row) => [
        String(row.name || ""),
        String(row.type || ""),
        String(row.notnull ?? 0),
        String(row.dflt_value ?? ""),
        String(row.pk ?? 0),
      ])),
      "",
      "**Source Used**",
      `- SQLite PRAGMA table_info(${target.tableName})`,
      "",
      "**Data Quality Notes**",
      "- This is the physical SQLite table schema.",
    ].join("\n");
  }

  const personalSources = sourcesForModules(loadSlpModuleSources(), ["PERSONAL"]);
  if (!personalSources.length) return composeVerifiedFallback(message, { ...trace, selectedSourceTypes: ["SLPIS_PERSONAL_MODULE"], filesSearched: [] });
  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const source of personalSources) {
    for (const header of source.headers || []) {
      const key = normalizeColumnName(header);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push([header, "TEXT", "0", "", "0"]);
    }
  }
  console.log(`[METADATA_QUERY_HANDLED] ${JSON.stringify({
    userQuery: message,
    target: target.type,
    sqliteTableChecked: target.tableName,
    sourceFiles: personalSources.map(sourceDisplayName),
    columns: rows.length,
  })}`);
  console.log(`[SQLITE_RETRIEVAL_RESULTS] ${JSON.stringify({
    userQuery: message,
    selectedTables: ["uploaded_sheets", "sheet_columns", "sheet_rows"],
    tableSchemas: sqliteTableSchemasForDebug(["uploaded_sheets", "sheet_columns", "sheet_rows"]),
    generatedSql: `PRAGMA table_info(${target.tableName}); SELECT column_name FROM sheet_columns JOIN uploaded_sheets WHERE module=PERSONAL`,
    rowCountReturned: rows.length,
    first5ResultRows: rows.slice(0, 5),
  })}`);
  return [
    "**Direct Answer**",
    "Here are the column names indexed for the Personal Module.",
    "",
    "**Relevant Table**",
    markdownTable(["Name", "Type", "Not Null", "Default", "Primary Key"], rows),
    "",
    "**Source Used**",
    ...personalSources.map((source) => `- ${sourceDisplayName(source)}`),
    "",
    "**How I calculated/found it**",
    "- Routed this as a SQLite metadata request.",
    `- Checked the indexed SQLite storage with PRAGMA table_info(${target.tableName}), then returned the original Personal Module headers preserved from the uploaded sheet metadata.`,
    "",
    "**Data Quality Notes**",
    "- Original spreadsheet headers are preserved in the indexed sheet metadata; SQLite stores row values as JSON in sheet_rows.",
  ].join("\n");
}

function filteredPersonalRowsRequest(message: string) {
  if (!/\b(show|list|display|get)\b/i.test(message)) return null;
  if (!/\bparticipants?|beneficiar|clients?\b/i.test(message)) return null;
  const knownPlacePattern = "Baler|Casiguran|Dilasag|Dinalungan|Dingalan|Dipaculao|Maria Aurora|San Luis";
  const known = message.match(new RegExp(`\\b(?:from|in|at)\\s+(${knownPlacePattern})\\b`, "i"))?.[1] || "";
  if (known) return { place: known.trim() };
  const generic = message.match(/\b(?:from|in|at)\s+([A-Za-z][A-Za-z\s.'-]{1,60})(?:\s+in\s+the\s+personal\s+module|\s+personal\s+module|\?|$)/i)?.[1] || "";
  if (!generic) return null;
  const cleaned = generic.replace(/\b(the|personal|module|participants?|beneficiaries|clients?)\b/gi, " ").replace(/\s+/g, " ").trim();
  return cleaned ? { place: cleaned } : null;
}

function composeFilteredPersonalRowsAnswer(message: string, trace: any = null) {
  const request = filteredPersonalRowsRequest(message);
  if (!request) return "";
  const personalSources = sourcesForModules(loadSlpModuleSources(), ["PERSONAL"]);
  if (!personalSources.length) return composeVerifiedFallback(message, { ...trace, selectedSourceTypes: ["SLPIS_PERSONAL_MODULE"], filesSearched: [] });

  const target = normalizeName(normalizeMunicipalityName(request.place) || request.place);
  const exact: Array<{ row: Record<string, string>; source: any }> = [];
  const partial: Array<{ row: Record<string, string>; source: any }> = [];
  for (const { row, source } of slpRows(personalSources)) {
    const headers = source.headers || [];
    const municipality = normalizeName(slpMunicipality(row, headers));
    if (!municipality) continue;
    if (municipality === target) exact.push({ row, source });
    else if (municipality.includes(target) || target.includes(municipality)) partial.push({ row, source });
  }
  const matched = exact.length ? exact : partial;
  if (!matched.length) {
    console.log(`[FILTERED_ROWS_HANDLED] ${JSON.stringify({ userQuery: message, municipality: request.place, matchType: "none", totalRows: 0 })}`);
    return composeVerifiedFallback(message, { ...trace, selectedSourceTypes: ["SLPIS_PERSONAL_MODULE"], filesSearched: personalSources.map(sourceDisplayName) });
  }

  const total = matched.length;
  const shown = matched.slice(0, 50);
  const headers = Array.from(new Set(shown.flatMap(({ source }) => (source.headers || []) as string[]))).filter((header) => !String(header).startsWith("__"));
  const tableRows = shown.map(({ row }) => headers.map((header) => String(row[header] ?? "")));
  console.log(`[FILTERED_ROWS_HANDLED] ${JSON.stringify({
    userQuery: message,
    municipality: request.place,
    normalizedMunicipality: target,
    matchType: exact.length ? "exact" : "partial",
    totalRows: total,
    shownRows: shown.length,
    sourceFiles: personalSources.map(sourceDisplayName),
  })}`);
  console.log(`[SQLITE_RETRIEVAL_RESULTS] ${JSON.stringify({
    userQuery: message,
    selectedTables: ["uploaded_sheets", "sheet_rows", "sheet_columns"],
    tableSchemas: sqliteTableSchemasForDebug(["uploaded_sheets", "sheet_rows", "sheet_columns"]),
    generatedSql: "SELECT * FROM Personal Module indexed sheet_rows WHERE LOWER(municipality_column) = LOWER(?) LIMIT 50; fallback LIKE '%value%'",
    rowCountReturned: total,
    first5ResultRows: tableRows.slice(0, 5),
  })}`);
  return [
    "**Direct Answer**",
    `Found ${total} participant row(s) from ${normalizeMunicipalityName(request.place) || request.place} in the Personal Module.`,
    total > 50 ? `Showing first 50 of ${total} total rows.` : `Showing ${shown.length} row(s).`,
    "",
    "**Relevant Table**",
    markdownTable(headers.length ? headers : ["Row"], headers.length ? tableRows : shown.map((_, index) => [String(index + 1)])),
    "",
    "**Source Used**",
    ...Array.from(new Set(shown.map(({ source }) => sourceDisplayName(source)))).map((source) => `- ${source}`),
    "",
    "**How I calculated/found it**",
    "- Routed this as a SQLite filtered row listing request.",
    "- Searched Personal Module rows using case-insensitive municipality matching.",
    exact.length ? "- Used exact municipality matches." : "- Exact municipality matching found no rows, so partial matching was used.",
    "",
    "**Data Quality Notes**",
    "- Returned indexed row values from the uploaded Personal Module only.",
  ].join("\n");
}

function moduleFromTablePhrase(tablePhrase: string): SlpModuleTag | null {
  const text = normalizeName(tablePhrase);
  if (/personal|participant|beneficiar|client/.test(text)) return "PERSONAL";
  if (/project/.test(text)) return "PROJECT";
  if (/orientation/.test(text)) return "ORIENTATION";
  if (/training/.test(text)) return "TRAINING";
  if (/gur|grant utilization/.test(text)) return "GRANT_UTILIZATION";
  if (/monitoring.*association|association.*monitoring/.test(text)) return "MDMONITORING_ASSOCIATION";
  if (/monitoring.*individual|individual.*monitoring|monitoring/.test(text)) return "MDMONITORING_INDIVIDUAL";
  if (/slpa|association/.test(text)) return "SLPA";
  if (/dpt|aurora database/.test(text)) return "SLP_DPT_DATABASE";
  return null;
}

function parseFlexibleDate(value: string) {
  const raw = String(value || "").trim().replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
  if (!raw) return "";
  const mdY = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const monthName = raw.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})$/i);
  const formatLocalDate = (year: number, month: number, day: number) => {
    const date = new Date(year, month - 1, day);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  if (mdY) {
    const year = Number(mdY[3].length === 2 ? `20${mdY[3]}` : mdY[3]);
    return formatLocalDate(year, Number(mdY[1]), Number(mdY[2]));
  }
  if (ymd) return formatLocalDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  if (monthName) {
    const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(monthName[1].toLowerCase()) + 1;
    return formatLocalDate(Number(monthName[3]), month, Number(monthName[2]));
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

function addMonths(date: Date, months: number) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function fmtDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateRangeFromQuestion(message: string) {
  const text = String(message || "");
  const q = text.match(/\bq([1-4])\s+(20\d{2})\b/i);
  if (q) {
    const quarter = Number(q[1]);
    const year = Number(q[2]);
    const startMonth = (quarter - 1) * 3 + 1;
    const range = { start: fmtDate(new Date(year, startMonth - 1, 1)), end: fmtDate(new Date(year, startMonth + 2, 0)), label: `Q${quarter} ${year}` };
    console.log(`[DATE_PARSED] ${JSON.stringify({ userQuery: message, ...range })}`);
    return range;
  }
  const season = text.match(/\b(spring|summer|fall|autumn|winter)\s+(20\d{2})\b/i);
  if (season) {
    const year = Number(season[2]);
    const ranges: Record<string, [number, number]> = { spring: [3, 5], summer: [6, 8], fall: [9, 11], autumn: [9, 11], winter: [12, 2] };
    const [startMonth, endMonth] = ranges[season[1].toLowerCase()];
    const endYear = startMonth > endMonth ? year + 1 : year;
    const range = { start: fmtDate(new Date(year, startMonth - 1, 1)), end: fmtDate(new Date(endYear, endMonth, 0)), label: `${season[1]} ${year}` };
    console.log(`[DATE_PARSED] ${JSON.stringify({ userQuery: message, ...range })}`);
    return range;
  }
  const now = new Date();
  if (/\blast month\b/i.test(text)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    const range = { start: fmtDate(start), end: fmtDate(end), label: "last month" };
    console.log(`[DATE_PARSED] ${JSON.stringify({ userQuery: message, ...range })}`);
    return range;
  }
  if (/\b(previous|last) year\b/i.test(text)) {
    const year = now.getFullYear() - 1;
    const range = { start: `${year}-01-01`, end: `${year}-12-31`, label: "previous year" };
    console.log(`[DATE_PARSED] ${JSON.stringify({ userQuery: message, ...range })}`);
    return range;
  }
  const lastMonths = text.match(/\blast\s+(\d{1,2})\s+months?\b/i);
  if (lastMonths) {
    const range = { start: fmtDate(addMonths(now, -Number(lastMonths[1]))), end: fmtDate(now), label: `last ${lastMonths[1]} months` };
    console.log(`[DATE_PARSED] ${JSON.stringify({ userQuery: message, ...range })}`);
    return range;
  }
  const fromYears = text.match(/\bfrom\s+(20\d{2})\s+to\s+(20\d{2})\b/i);
  if (fromYears) {
    const range = { start: `${fromYears[1]}-01-01`, end: `${fromYears[2]}-12-31`, label: `from ${fromYears[1]} to ${fromYears[2]}` };
    console.log(`[DATE_PARSED] ${JSON.stringify({ userQuery: message, ...range })}`);
    return range;
  }
  return null;
}

function dateFilterFromQuestion(message: string) {
  const match = message.match(/\b(after|before)\s+([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})/i);
  if (!match) return null;
  const normalizedDate = parseFlexibleDate(match[2]);
  if (!normalizedDate) return null;
  const parsed = { operator: match[1].toLowerCase() === "after" ? ">" : "<", value: normalizedDate, raw: match[2] };
  console.log(`[DATE_PARSED] ${JSON.stringify({ userQuery: message, ...parsed })}`);
  return parsed;
}

function findDateColumn(headers: string[]) {
  return bestDateColumn(headers);
}

function fuzzyFindColumn(headers: string[], target: string) {
  const exact = findSlpColumn(headers, [target]) || headers.find((header) => normalizeColumnName(header) === normalizeColumnName(target)) || "";
  if (exact) return exact;
  const normalized = normalizeColumnName(target);
  let best = { header: "", score: 0 };
  for (const header of headers) {
    const score = similarityScore(normalized, normalizeColumnName(header));
    if (score > best.score) best = { header, score };
  }
  if (best.score >= 80) {
    console.log(`[FUZZY_NAME_CORRECTED] ${JSON.stringify({ requested: target, corrected: best.header, score: best.score })}`);
    return best.header;
  }
  return "";
}

function numericComparisonFromQuestion(message: string) {
  const lower = normalizeName(message);
  const between = lower.match(/\bbetween\s+(\d+(?:\.\d+)?)\s+and\s+(\d+(?:\.\d+)?)\b/);
  if (between) return { operator: "BETWEEN", min: Number(between[1]), max: Number(between[2]), text: between[0] };
  const patterns: Array<[RegExp, string]> = [
    [/\bmore than\s+(\d+(?:\.\d+)?)\b/, ">"],
    [/\bless than\s+(\d+(?:\.\d+)?)\b/, "<"],
    [/\bat least\s+(\d+(?:\.\d+)?)\b/, ">="],
    [/\bat most\s+(\d+(?:\.\d+)?)\b/, "<="],
    [/\bexactly\s+(\d+(?:\.\d+)?)\b/, "="],
  ];
  for (const [pattern, operator] of patterns) {
    const match = lower.match(pattern);
    if (match) return { operator, value: Number(match[1]), text: match[0] };
  }
  return null;
}

function missingValueRequest(message: string) {
  const match = message.match(/\b(?:without|missing|empty|no)\s+([A-Za-z][A-Za-z\s/#_-]{2,50})(?:[?.!]|$|\bin\b|\bfrom\b)/i);
  if (!match) return null;
  const cleaned = match[1].replace(/\b(an?|the|address|field|column|value)\b/gi, "").replace(/\s+/g, " ").trim();
  return { columnHint: cleaned || match[1].trim() };
}

function columnDiscoveryRequest(message: string) {
  const match = message.match(/\b(?:what|which|list|show)\s+([A-Za-z][A-Za-z\s/#_-]{2,50}?)\s+(?:are|is)?\s*(?:in|for)\s+([A-Za-z][A-Za-z\s.'-]{1,60})(?:\?|$)/i);
  if (!match) return null;
  return { columnHint: match[1].trim(), valueHint: match[2].trim() };
}

function genericFilteredRowsRequest(message: string) {
  const afterBefore = dateFilterFromQuestion(message);
  if (!/\b(list|show(?:\s+me)?(?:\s+all)?|display|get|records?)\b/i.test(message) && !afterBefore) return null;
  const explicitModule =
    message.match(/\bfrom\s+(?:the\s+)?([A-Za-z ]+ Module|SLP DPT(?: Aurora Database)?|Aurora Database)\b/i)?.[1]
    || message.match(/\b(?:in|from)\s+(?:the\s+)?([A-Za-z ]+ Module|SLP DPT(?: Aurora Database)?|Aurora Database)\b/i)?.[1]
    || "";
  const moduleByTopic =
    /orientation/i.test(message) ? "Orientation Module"
    : /training/i.test(message) ? "Training Module"
    : /project/i.test(message) ? "Project Module"
    : /participant|personal/i.test(message) ? "Personal Module"
    : /gur|grant utilization/i.test(message) ? "GUR Module"
    : /monitoring/i.test(message) ? "Monitoring Module"
    : "";
  const modulePhrase = explicitModule || moduleByTopic;
  const module = moduleFromTablePhrase(modulePhrase);
  if (!module) return null;
  const knownPlacePattern = "Baler|Casiguran|Dilasag|Dinalungan|Dingalan|Dipaculao|Maria Aurora|San Luis";
  const knownPlace = message.match(new RegExp(`\\b(?:in|from|at)\\s+(${knownPlacePattern})\\b`, "i"))?.[1] || "";
  const genericPlace = knownPlace || message.match(/\b(?:municipality|city)\s+(?:of\s+)?([A-Za-z][A-Za-z\s.'-]{1,50})/i)?.[1] || "";
  return { module, modulePhrase: modulePhrase || SLP_MODULE_LABELS[module], place: genericPlace.trim(), dateFilter: afterBefore };
}

function composeGenericFilteredRowsAnswer(message: string, trace: any = null) {
  const request = genericFilteredRowsRequest(message);
  if (!request || (!request.place && !request.dateFilter)) return "";
  inspectDynamicSchema();
  const sources = sourcesForModules(loadSlpModuleSources(), [request.module]);
  if (!sources.length) return composeVerifiedFallback(message, { ...trace, selectedSourceTypes: [SLP_MODULE_LABELS[request.module]], filesSearched: [] });
  const placeTarget = request.place ? normalizeName(normalizeMunicipalityName(request.place) || request.place) : "";
  const exact: Array<{ row: Record<string, string>; source: any }> = [];
  const partial: Array<{ row: Record<string, string>; source: any }> = [];
  const dateCheckedColumns = new Set<string>();
  for (const { row, source } of slpRows(sources)) {
    const headers = source.headers || [];
    let placeMatches = true;
    if (placeTarget) {
      const municipalityColumn = bestColumnForConcept(headers, "municipality", ["Municipality", "City", "City/Municipality Name", "Local Government Unit", "Town", "LGU"]);
      const municipality = normalizeName(municipalityColumn ? getCell(row, municipalityColumn) : slpMunicipality(row, headers));
      if (municipality === placeTarget) placeMatches = true;
      else if (municipality.includes(placeTarget) || placeTarget.includes(municipality)) placeMatches = true;
      else placeMatches = false;
    }
    let dateMatches = true;
    if (request.dateFilter) {
      const dateColumn = findDateColumn(headers);
      if (dateColumn) dateCheckedColumns.add(dateColumn);
      const rowDate = dateColumn ? parseFlexibleDate(getCell(row, dateColumn)) : "";
      dateMatches = Boolean(rowDate) && (request.dateFilter.operator === ">" ? rowDate > request.dateFilter.value : rowDate < request.dateFilter.value);
    }
    if (!placeMatches || !dateMatches) continue;
    if (placeTarget) {
      const headers = source.headers || [];
      const municipalityColumn = bestColumnForConcept(headers, "municipality", ["Municipality", "City", "City/Municipality Name", "Local Government Unit", "Town", "LGU"]);
      const municipality = normalizeName(municipalityColumn ? getCell(row, municipalityColumn) : slpMunicipality(row, headers));
      (municipality === placeTarget ? exact : partial).push({ row, source });
    } else {
      exact.push({ row, source });
    }
  }
  const matched = exact.length ? exact : partial;
  if (!matched.length) {
    console.log(`[GENERIC_FILTERED_ROWS_HANDLED] ${JSON.stringify({ userQuery: message, module: request.module, municipality: request.place, dateFilter: request.dateFilter, rowCount: 0 })}`);
    return composeVerifiedFallback(message, { ...trace, selectedSourceTypes: [SLP_MODULE_LABELS[request.module]], filesSearched: sources.map(sourceDisplayName) });
  }
  const total = matched.length;
  const shown = matched.slice(0, 50);
  const headers = Array.from(new Set(shown.flatMap(({ source }) => (source.headers || []) as string[]))).filter((header) => !String(header).startsWith("__"));
  const tableRows = shown.map(({ row }) => headers.map((header) => String(row[header] ?? "")));
  const municipalityColumn = sources.map((source) => bestColumnForConcept(source.headers || [], "municipality", ["Municipality", "City", "City/Municipality Name", "Local Government Unit", "Town", "LGU"])).find(Boolean) || "municipality_column";
  const dateColumn = Array.from(dateCheckedColumns)[0] || "date_column";
  const whereParts: string[] = [];
  const params: string[] = [];
  if (request.place) { whereParts.push(`LOWER(${municipalityColumn}) = LOWER(?)`); params.push(request.place); }
  if (request.dateFilter) { whereParts.push(`${dateColumn} ${request.dateFilter.operator} ?`); params.push(request.dateFilter.value); }
  const generatedSql = `SELECT * FROM ${SLP_MODULE_LABELS[request.module]} WHERE ${whereParts.join(" AND ") || "1=1"} LIMIT 50`;
  console.log(`[GENERIC_FILTERED_ROWS_HANDLED] ${JSON.stringify({ userQuery: message, module: request.module, tableName: SLP_MODULE_LABELS[request.module], municipality: request.place || "", dateFilter: request.dateFilter, generatedSql, params, rowCountReturned: total, shownRows: shown.length })}`);
  if (request.dateFilter) console.log(`[DATE_FILTER_APPLIED] ${JSON.stringify({ userQuery: message, operator: request.dateFilter.operator, rawDate: request.dateFilter.raw, normalizedDate: request.dateFilter.value, dateColumn })}`);
  console.log(`[SQLITE_RETRIEVAL_RESULTS] ${JSON.stringify({
    userQuery: message,
    selectedTables: ["uploaded_sheets", "sheet_rows", "sheet_columns"],
    tableSchemas: sqliteTableSchemasForDebug(["uploaded_sheets", "sheet_rows", "sheet_columns"]),
    generatedSql,
    rowCountReturned: total,
    first5ResultRows: tableRows.slice(0, 5),
  })}`);
  return [
    "**Direct Answer**",
    `Found ${total} row(s) in ${SLP_MODULE_LABELS[request.module]}${request.place ? ` for ${normalizeMunicipalityName(request.place) || request.place}` : ""}${request.dateFilter ? ` ${request.dateFilter.operator === ">" ? "after" : "before"} ${request.dateFilter.value}` : ""}.`,
    total > 50 ? `Showing first 50 of ${total} total rows.` : `Showing ${shown.length} row(s).`,
    "",
    "**Relevant Table**",
    markdownTable(headers.length ? headers : ["Row"], headers.length ? tableRows : shown.map((_, index) => [String(index + 1)])),
    "",
    "**Source Used**",
    ...Array.from(new Set(shown.map(({ source }) => sourceDisplayName(source)))).map((source) => `- ${source}`),
    "",
    "**How I calculated/found it**",
    "- Routed this as a generic SQLite filtered row listing request.",
    `- Generated SQL shape: ${generatedSql}`,
    "",
    "**Data Quality Notes**",
    "- Rows come from indexed sheet_rows JSON for the selected module; original headers are preserved.",
  ].join("\n");
}

function composeColumnDiscoveryAnswer(message: string, trace: any = null) {
  const request = columnDiscoveryRequest(message);
  if (!request) return "";
  inspectDynamicSchema();
  const sources = loadSlpModuleSources();
  const rows: string[][] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const headers = source.headers || [];
    const targetColumn = bestColumnForConcept(headers, request.columnHint);
    const municipalityColumn = bestColumnForConcept(headers, "municipality", ["Municipality", "City", "Town", "LGU", "City/Municipality Name"]);
    if (!targetColumn || !municipalityColumn) continue;
    const valueTarget = normalizeName(normalizeMunicipalityName(request.valueHint) || request.valueHint);
    for (const row of source.rows || []) {
      const municipality = normalizeName(getCell(row, municipalityColumn));
      if (municipality !== valueTarget && !municipality.includes(valueTarget)) continue;
      const value = getCell(row, targetColumn);
      const key = normalizeName(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push([value, sourceDisplayName(source)]);
    }
  }
  if (!rows.length) return "";
  console.log(`[COLUMN_DISCOVERY_HANDLED] ${JSON.stringify({ userQuery: message, columnHint: request.columnHint, valueHint: request.valueHint, distinctValues: rows.length })}`);
  if (trace) { trace.sqliteResult = rows; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "sqlite_column_discovery" }; }
  return ["**Direct Answer**", `Found ${rows.length} distinct ${request.columnHint} value(s) for ${request.valueHint}.`, "", "**Relevant Table**", markdownTable([request.columnHint, "Source"], rows.slice(0, 100)), "", "**Source Used**", "- Indexed SQLite sheet_rows via uploaded sheet metadata"].join("\n");
}

function composeMissingValueAnswer(message: string, trace: any = null) {
  const request = missingValueRequest(message);
  if (!request) return "";
  inspectDynamicSchema();
  const module = /project/i.test(message) ? "PROJECT" : /orientation/i.test(message) ? "ORIENTATION" : /training/i.test(message) ? "TRAINING" : "PERSONAL";
  const sources = sourcesForModules(loadSlpModuleSources(), [module as SlpModuleTag]);
  const matches: Array<{ row: Record<string, string>; source: any; column: string }> = [];
  const checkedColumns: string[] = [];
  for (const source of sources) {
    const headers = source.headers || [];
    checkedColumns.push(...headers);
    const column = bestColumnForConcept(headers, request.columnHint);
    if (!column) continue;
    for (const row of source.rows || []) {
      const value = normalizeName(getCell(row, column));
      if (!value || value === "n a" || value === "na" || value === "none" || value === "null") matches.push({ row, source, column });
    }
  }
  const matchingColumnExists = sources.some((source) => bestColumnForConcept(source.headers || [], request.columnHint));
  if (!matchingColumnExists) {
    console.log(`[NULL_HANDLED] ${JSON.stringify({ userQuery: message, module, columnHint: request.columnHint, rowCount: 0, reason: "column_not_found" })}`);
    return [
      "**Direct Answer**",
      `I cannot list participants with missing ${request.columnHint} because the ${SLP_MODULE_LABELS[module as SlpModuleTag]} data does not contain a matching ${request.columnHint} column.`,
      "",
      "**Relevant Table**",
      markdownTable(["Requested Column", "Status"], [[request.columnHint, "Column not found in selected module"]]),
      "",
      "**Source Used**",
      ...sources.map((source) => `- ${sourceDisplayName(source)}`),
      "",
      "**Data Quality Notes**",
      `- Columns checked included: ${Array.from(new Set(checkedColumns)).slice(0, 25).join(", ") || "none"}.`,
    ].join("\n");
  }
  if (!matches.length) return "";
  const shown = matches.slice(0, 50);
  const headers = Array.from(new Set(shown.flatMap(({ source }) => source.headers || []))).filter((header) => !String(header).startsWith("__"));
  const tableRows = shown.map(({ row }) => headers.map((header) => String(row[header] ?? "")));
  console.log(`[MISSING_VALUE_FILTER_APPLIED] ${JSON.stringify({ userQuery: message, module, columnHint: request.columnHint, rowCount: matches.length })}`);
  console.log(`[NULL_HANDLED] ${JSON.stringify({ userQuery: message, module, columnHint: request.columnHint, rowCount: matches.length })}`);
  if (trace) { trace.sqliteResult = tableRows; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "sqlite_missing_value_filter" }; }
  return ["**Direct Answer**", `Found ${matches.length} row(s) with missing/empty ${request.columnHint}.`, matches.length > 50 ? `Showing first 50 of ${matches.length} total rows.` : `Showing ${shown.length} row(s).`, "", "**Relevant Table**", markdownTable(headers, tableRows), "", "**How I calculated/found it**", "- Applied missing-value filter: column IS NULL OR column = '' OR column = 'N/A'."].join("\n");
}

function composeNumericComparisonAnswer(message: string, trace: any = null) {
  const comparison = numericComparisonFromQuestion(message);
  if (!comparison) return "";
  const module = /project/i.test(message) ? "PROJECT" : /orientation/i.test(message) ? "ORIENTATION" : /training/i.test(message) ? "TRAINING" : "PERSONAL";
  const sources = sourcesForModules(loadSlpModuleSources(), [module as SlpModuleTag]);
  const columnHint = /age/i.test(message) ? "Age" : /participants?|member/i.test(message) ? "Participant Count" : /amount|cost|grant|fund/i.test(message) ? "Amount" : "";
  if (!columnHint) return "";
  const matches: Array<{ row: Record<string, string>; source: any }> = [];
  for (const source of sources) {
    const headers = source.headers || [];
    const column = fuzzyFindColumn(headers, columnHint);
    if (!column) continue;
    for (const row of source.rows || []) {
      const value = Number(String(getCell(row, column)).replace(/[^0-9.-]/g, ""));
      if (!Number.isFinite(value)) continue;
      const ok = comparison.operator === "BETWEEN" ? value >= comparison.min! && value <= comparison.max!
        : comparison.operator === ">" ? value > comparison.value!
        : comparison.operator === "<" ? value < comparison.value!
        : comparison.operator === ">=" ? value >= comparison.value!
        : comparison.operator === "<=" ? value <= comparison.value!
        : value === comparison.value;
      if (ok) matches.push({ row, source });
    }
  }
  if (!matches.length) return "";
  const shown = matches.slice(0, 50);
  const headers = Array.from(new Set(shown.flatMap(({ source }) => source.headers || []))).filter((header) => !String(header).startsWith("__"));
  const tableRows = shown.map(({ row }) => headers.map((header) => String(row[header] ?? "")));
  console.log(`[NUMERIC_COMPARISON_APPLIED] ${JSON.stringify({ userQuery: message, module, columnHint, comparison, rowCount: matches.length })}`);
  if (trace) { trace.sqliteResult = tableRows; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "sqlite_numeric_comparison" }; }
  return ["**Direct Answer**", `Found ${matches.length} row(s) where ${columnHint} matches "${comparison.text}".`, matches.length > 50 ? `Showing first 50 of ${matches.length} total rows.` : `Showing ${shown.length} row(s).`, "", "**Relevant Table**", markdownTable(headers, tableRows)].join("\n");
}

function composeCrossTableRatioAnswer(message: string, trace: any = null) {
  if (!/\b(ratio|per|divided by|participants per project|projects to participants)\b/i.test(message)) return "";
  inspectDynamicSchema();
  const personal = sourcesForModules(loadSlpModuleSources(), ["PERSONAL"]);
  const projects = sourcesForModules(loadSlpModuleSources(), ["PROJECT"]);
  if (!personal.length || !projects.length) return "";
  const participantCounts = new Map<string, Set<string>>();
  for (const { row, source } of slpRows(personal)) {
    const headers = source.headers || [];
    const municipality = slpMunicipality(row, headers);
    const key = slpParticipantId(row, headers) || normalizeName([slpFullName(row, headers), municipality, slpValue(row, headers, ["Barangay"])].join("|"));
    if (!municipality || !key) continue;
    if (!participantCounts.has(municipality)) participantCounts.set(municipality, new Set());
    participantCounts.get(municipality)!.add(key);
  }
  const projectCounts = new Map<string, Set<string>>();
  for (const { row, source } of slpRows(projects)) {
    const headers = source.headers || [];
    const municipality = slpMunicipality(row, headers);
    const key = slpProjectId(row, headers) || normalizeName([slpProjectName(row, headers), municipality].join("|"));
    if (!municipality || !key) continue;
    if (!projectCounts.has(municipality)) projectCounts.set(municipality, new Set());
    projectCounts.get(municipality)!.add(key);
  }
  const rows = Array.from(new Set([...participantCounts.keys(), ...projectCounts.keys()])).map((municipality) => {
    const participants = participantCounts.get(municipality)?.size || 0;
    const projectsCount = projectCounts.get(municipality)?.size || 0;
    const ratio = /projects?\s+(?:to|per)\s+participants?/i.test(message) ? projectsCount / Math.max(participants, 1) : participants / Math.max(projectsCount, 1);
    return [municipality, String(participants), String(projectsCount), ratio.toFixed(2)];
  }).sort((a, b) => Number(b[3]) - Number(a[3])).slice(0, 5);
  console.log(`[CROSS_TABLE_JOIN_ATTEMPTED] ${JSON.stringify({ userQuery: message, commonKey: "Municipality", generatedSql: "LEFT JOIN participant_counts and project_counts ON municipality; ratio uses NULLIF denominator", rows: rows.length })}`);
  if (trace) { trace.sqliteResult = rows; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "sqlite_cross_table_ratio" }; }
  return ["**Direct Answer**", "Calculated cross-table ratio using Personal Module and Project Module joined by municipality.", "", "**Relevant Table**", markdownTable(["Municipality", "Participants", "Projects", "Ratio"], rows), "", "**How I calculated/found it**", "- SQL shape: LEFT JOIN participant_counts and project_counts ON municipality, using COUNT(DISTINCT ...) and NULLIF-style denominator protection."].join("\n");
}

function composeYearTrendAnswer(message: string, trace: any = null) {
  if (!/\b(trend|from\s+20\d{2}\s+to\s+20\d{2}|average age change|by year|line chart)\b/i.test(message)) return "";
  inspectDynamicSchema();
  const sources = /project/i.test(message) ? sourcesForModules(loadSlpModuleSources(), ["PROJECT"]) : sourcesForModules(loadSlpModuleSources(), ["PERSONAL"]);
  if (!sources.length) return "";
  const range = dateRangeFromQuestion(message);
  const minMatch = message.match(/\b(?:minimum|min|at least)\s+(\d+)\s+participants?\b/i);
  const minParticipants = minMatch ? Number(minMatch[1]) : 0;
  const counts = new Map<string, number>();
  const ageSums = new Map<string, { sum: number; count: number }>();
  for (const { row, source } of slpRows(sources)) {
    const headers = source.headers || [];
    const yearValue = slpValue(row, headers, ["Year Served", "Implementation Year", "Year"]) || parseFlexibleDate(slpValue(row, headers, ["Created Date", "Date"]))?.slice(0, 4);
    const year = String(yearValue || "").match(/20\d{2}/)?.[0] || "";
    if (!year) continue;
    if (range && (year < range.start.slice(0, 4) || year > range.end.slice(0, 4))) continue;
    counts.set(year, (counts.get(year) || 0) + 1);
    const age = Number(String(slpValue(row, headers, ["Age"])).replace(/[^0-9.]/g, ""));
    if (Number.isFinite(age) && age > 0) {
      const current = ageSums.get(year) || { sum: 0, count: 0 };
      current.sum += age; current.count += 1; ageSums.set(year, current);
    }
  }
  let rows = Array.from(counts.entries()).filter(([, count]) => count >= minParticipants).sort((a, b) => a[0].localeCompare(b[0])).map(([year, count]) => {
    const avg = ageSums.get(year);
    return [year, String(count), avg?.count ? (avg.sum / avg.count).toFixed(1) : ""];
  });
  if (!rows.length) return "";
  console.log(`[DATE_FILTER_APPLIED] ${JSON.stringify({ userQuery: message, range, minParticipants })}`);
  if (trace) { trace.sqliteResult = rows; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "sqlite_year_trend" }; }
  return ["**Direct Answer**", `Computed yearly trend${range ? ` for ${range.label}` : ""}.`, "", "**Relevant Table**", markdownTable(["Year", "Rows", "Average Age"], rows), "", "**Chart Code**", "```python", "import matplotlib.pyplot as plt", `years = ${JSON.stringify(rows.map((row) => row[0]))}`, `counts = ${JSON.stringify(rows.map((row) => Number(row[1])))}`, "plt.figure(figsize=(9,5))", "plt.plot(years, counts, marker='o')", "plt.title('Yearly Trend')", "plt.xlabel('Year')", "plt.ylabel('Rows')", "plt.tight_layout()", "plt.show()", "```"].join("\n");
}

function composeDualAxisChartAnswer(message: string, trace: any = null) {
  if (!/\b(combined chart|bar and line|dual axis)\b/i.test(message)) return "";
  console.log(`[DUAL_AXIS_CHART_REQUESTED] ${JSON.stringify({ userQuery: message })}`);
  inspectDynamicSchema();
  const personal = sourcesForModules(loadSlpModuleSources(), ["PERSONAL"]);
  const training = sourcesForModules(loadSlpModuleSources(), ["TRAINING", "ORIENTATION"]);
  if (!personal.length) return "";
  const participants = new Map<string, Set<string>>();
  for (const { row, source } of slpRows(personal)) {
    const headers = source.headers || [];
    const municipality = slpMunicipality(row, headers) || "Unspecified";
    const key = slpParticipantId(row, headers) || normalizeName([slpFullName(row, headers), municipality, slpValue(row, headers, ["Barangay"])].join("|"));
    if (!participants.has(municipality)) participants.set(municipality, new Set());
    if (key) participants.get(municipality)!.add(key);
  }
  const trained = new Map<string, number>();
  for (const { row, source } of slpRows(training)) {
    const municipality = slpMunicipality(row, source.headers || []) || "Unspecified";
    trained.set(municipality, (trained.get(municipality) || 0) + 1);
  }
  const minParticipants = Number(message.match(/\b(?:>|more than|over)\s*(\d+)\s+participants?\b/i)?.[1] || 0);
  const rows = Array.from(participants.entries()).map(([municipality, set]) => {
    const count = set.size;
    const trainingCount = trained.get(municipality) || 0;
    return [municipality, String(count), String(trainingCount), count ? ((trainingCount / count) * 100).toFixed(1) : "0"];
  }).filter((row) => Number(row[1]) > minParticipants).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 12);
  console.log(`[DUAL_AXIS_GENERATED] ${JSON.stringify({ userQuery: message, rows: rows.length, minParticipants })}`);
  if (trace) { trace.sqliteResult = rows; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "sqlite_dual_axis_chart" }; }
  return ["**Direct Answer**", "Prepared a dual-axis chart dataset for participants and training/orientation rate by municipality.", "", "**Relevant Table**", markdownTable(["Municipality", "Participants", "Training/Orientation Rows", "Rate %"], rows), "", "**Chart Code**", "```python", "import matplotlib.pyplot as plt", `municipalities = ${JSON.stringify(rows.map((row) => row[0]))}`, `participants = ${JSON.stringify(rows.map((row) => Number(row[1])))}`, `rates = ${JSON.stringify(rows.map((row) => Number(row[3])))}`, "fig, ax1 = plt.subplots(figsize=(12,6))", "ax1.bar(municipalities, participants, color='steelblue')", "ax1.set_ylabel('Participants')", "ax2 = ax1.twinx()", "ax2.plot(municipalities, rates, color='darkorange', marker='o')", "ax2.set_ylabel('Training/Orientation Rate %')", "plt.xticks(rotation=45, ha='right')", "plt.title('Participants and Training/Orientation Rate by Municipality')", "fig.tight_layout()", "plt.show()", "```"].join("\n");
}

function composeDateRangeCountAnswer(message: string, trace: any = null) {
  const range = dateRangeFromQuestion(message);
  if (!range || !/\b(how many|count|total|attendance|attendances|records?)\b/i.test(message)) return "";
  inspectDynamicSchema();
  const modules: SlpModuleTag[] = /training|attendance/i.test(message) ? ["TRAINING", "ORIENTATION"] : ["PERSONAL", "PROJECT", "TRAINING", "ORIENTATION"];
  const sources = sourcesForModules(loadSlpModuleSources(), modules);
  let count = 0;
  const checked: string[] = [];
  for (const { row, source } of slpRows(sources)) {
    const headers = source.headers || [];
    const dateColumn = bestDateColumn(headers);
    if (!dateColumn) continue;
    checked.push(`${sourceDisplayName(source)}:${dateColumn}`);
    const parsedDate = parseFlexibleDate(getCell(row, dateColumn));
    if (parsedDate && parsedDate >= range.start && parsedDate <= range.end) count += 1;
  }
  const files = Array.from(new Set(checked.map((item) => item.split(":")[0])));
  console.log(`[DATE_FILTER_APPLIED] ${JSON.stringify({ userQuery: message, range, modules, rowCount: count, filesChecked: files })}`);
  if (trace) { trace.sqliteResult = { count, range, modules }; trace.finalSourceUsed = { sourceType: "SQLite", answerMode: "sqlite_date_range_count" }; }
  return [
    "**Direct Answer**",
    `Found ${count} row(s) for ${range.label} (${range.start} to ${range.end}).`,
    "",
    "**Relevant Table**",
    markdownTable(["Date Range", "Rows"], [[range.label, String(count)]]),
    "",
    "**Source Used**",
    ...(files.length ? files.map((file) => `- ${file}`) : ["- Indexed SQLite sheet rows; no date column matched the requested range."]),
  ].join("\n");
}

async function composeLongDocumentSummary(message: string, trace: any = null) {
  if (!/\b(summarize|overview|gist of|summary of)\b/i.test(message)) return "";
  console.log(`[SUMMARIZATION_TRIGGERED] ${JSON.stringify({ userQuery: message })}`);
  const files = originalFileRows().map((file: any) => {
    const content = [
      file.document_purpose,
      file.short_summary,
      file.classification_reason,
      file.related_topics,
      String(file.content_text || "").slice(0, 10000),
    ].filter(Boolean).join(" ");
    return { file, score: scoreContext(message, content, explicitFilenameIntent(message) ? file.original_file_name || "" : "") };
  }).sort((a, b) => b.score - a.score);
  const top = files[0]?.file;
  if (!top || files[0].score < 5) return "";
  const doc = db.prepare("SELECT content_text FROM documents WHERE id = ? OR id = ?").get(top.document_id || top.file_id, top.file_id) as any;
  const text = String(doc?.content_text || "");
  if (!text || text.startsWith("{\"__slpWorkbook\"")) return "";
  const prompt = `Summarize the following document in 3-5 paragraphs, focusing on key points. Use only the document text.\n\n${text.slice(0, 24000)}`;
  const result = await callModel("main", [{ role: "user", content: prompt }], { temperature: 0.1, maxTokens: 1200, timeoutMs: 45000 }).catch(() => ({ content: text.replace(/\s+/g, " ").slice(0, 1800) }));
  console.log(`[LONG_DOCUMENT_SUMMARY_USED] ${JSON.stringify({ userQuery: message, fileName: top.original_file_name, textLength: text.length })}`);
  if (trace) { trace.finalEvidenceText = text.slice(0, 5000); trace.finalSourceUsed = { source: `${top.source_type}/${top.original_file_name}`, sourceType: top.source_type, answerMode: "document_summary" }; }
  return ["**Direct Answer**", result.content, "", "**Source Used**", `- ${top.source_type || canonicalSourceFolder(top.folder)}/${top.original_file_name}`, hasDownloadPath(top) ? `- [Download File](${downloadUrlForDocument(top.file_id)})` : ""].filter(Boolean).join("\n");
}

function composeHybridPhaseAnswer(message: string, trace: any = null) {
  if (!/\b(phase|implementation phase).*\b(most|highest|top)\b|\b(most|highest|top).*\bphase\b/i.test(message)) return "";
  console.log(`[HYBRID_QUERY] ${JSON.stringify({ userQuery: message, sqliteEntity: "phase", documentFollowup: "guidelines phase description" })}`);
  const personal = sourcesForModules(loadSlpModuleSources(), ["PERSONAL"]);
  const counts = new Map<string, number>();
  for (const { row, source } of slpRows(personal)) {
    const phase = slpValue(row, source.headers || [], ["Implementation Phase", "Phase"]) || "Unspecified";
    counts.set(phase, (counts.get(phase) || 0) + 1);
  }
  const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  if (!top) return "";
  const docs = db.prepare("SELECT file_name, folder, content_text FROM documents WHERE folder LIKE '%GUIDELINES%' AND content_text IS NOT NULL ORDER BY updated_at DESC LIMIT 20").all() as any[];
  const evidence = docs.map((doc) => summarizeRelevantText(top[0], doc.content_text || "")).find(Boolean) || "";
  console.log(`[HYBRID_ANSWER_GENERATED] ${JSON.stringify({ userQuery: message, topPhase: top[0], count: top[1], guidelineEvidence: Boolean(evidence) })}`);
  if (trace) { trace.sqliteResult = { phase: top[0], count: top[1] }; trace.finalEvidenceText = evidence; trace.finalSourceUsed = { sourceType: "SQLite+GUIDELINES", answerMode: "hybrid_phase_count_description" }; }
  return ["**Direct Answer**", `${top[0]} has the highest count (${top[1]} row(s)).${evidence ? `\n\n${evidence}` : ""}`, "", "**Relevant Table**", markdownTable(["Phase", "Rows"], Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([phase, count]) => [phase, String(count)])), "", "**Source Used**", "- SQLite Personal Module for counts", evidence ? "- GUIDELINES document text for phase description" : "- No guideline description found"].join("\n");
}

function composePhaseCorrectionAnswer(message: string) {
  const match = message.match(/\bphase\s+(one|two|three|four|five|1|2|3|4|5)\s*\(([^)]+)\)/i);
  if (!match) return "";
  const numberMap: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 };
  const phaseMap: Record<string, number> = { punla: 1, usbong: 2, sibol: 3, yabong: 4, "pag ani": 5 };
  const asked = numberMap[match[1].toLowerCase()];
  const label = normalizeName(match[2]);
  const actual = phaseMap[label];
  if (!actual || actual === asked) return "";
  return ["**Direct Answer**", `${match[2]} is Phase ${actual}, not Phase ${asked}.`, "", "**Source Used**", "- Built-in SLP phase name mapping: Punla=1, Usbong=2, Sibol=3, Yabong=4, Pag-Ani=5."].join("\n");
}

function splitMultiIntentQuestion(message: string) {
  if (!/\b(and also|plus|as well as)\b/i.test(message)) return [];
  const parts = message.split(/\b(?:and also|plus|as well as)\b/i).map((part) => part.trim()).filter((part) => part.length > 4);
  return parts.length > 1 ? parts.slice(0, 4) : [];
}

async function splitMultiIntentQuestionWithModel(message: string) {
  const explicitConnectors = /\b(and also|plus|as well as)\b/i.test(message);
  const questionMarks = (String(message || "").match(/\?/g) || []).length;
  if (!explicitConnectors && questionMarks < 2) return [];
  try {
    const result = await callModel("main", [
      { role: "system", content: "Split the following user question into independent sub-questions that can be answered separately. Return only a JSON array of strings. If the question is atomic, return [original]." },
      { role: "user", content: `Question: ${message}` },
    ], { temperature: 0, maxTokens: 300, timeoutMs: 12000 });
    const parsed = JSON.parse(String(result.content || "").trim());
    if (Array.isArray(parsed)) {
      const parts = parsed.map((part) => String(part || "").trim()).filter((part) => part.length > 4).slice(0, 5);
      if (parts.length > 1 && parts.some((part) => normalizeName(part) !== normalizeName(message))) {
        console.log(`[MULTI_INTENT_SPLIT] ${JSON.stringify({ userQuery: message, method: "llm", subQuestions: parts })}`);
        console.log(`[MULTI_INTENT] ${JSON.stringify({ userQuery: message, method: "llm", subQuestions: parts })}`);
        return parts;
      }
    }
  } catch (error: any) {
    console.warn("LLM multi-intent split unavailable; using regex fallback:", error.message || error);
  }
  const fallback = splitMultiIntentQuestion(message);
  if (fallback.length) console.log(`[MULTI_INTENT_SPLIT] ${JSON.stringify({ userQuery: message, method: "regex", subQuestions: fallback })}`);
  if (fallback.length) console.log(`[MULTI_INTENT] ${JSON.stringify({ userQuery: message, method: "regex", subQuestions: fallback })}`);
  return fallback;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function answerSubQuestionDeterministically(message: string, sessionId: string, attachmentIds: string[]) {
  const parsed = parseQuery(message);
  const route = routeUserQuery(message, { previousSources: getPreviousSources(sessionId) });
  const trace: any = {};
  return await composeGenericHybridTopDescriptionAnswer(message, parsed, route, attachmentIds, trace)
    || composeGenericTopNPerGroupAnswer(message, trace)
    || composeGenericColumnValueTopAnswer(message, trace)
    || composeGenericGlobalTopValueAnswer(message, trace)
    || composeGenericDistinctListingAnswer(message, trace)
    || composeGenericRelativeDateAnswer(message, trace)
    || composeGenericSimpleCountAnswer(message, trace)
    || composePhaseCorrectionAnswer(message)
    || (/\bparticipants?\b/i.test(message) && /munic?pality|municipality|city/i.test(message) && /\b(count|how many|by)\b/i.test(message) ? composeParticipantsByMunicipalityChart() : "")
    || composeColumnDiscoveryAnswer(message, trace)
    || composeMissingValueAnswer(message, trace)
    || composeDualAxisChartAnswer(message, trace)
    || composeYearTrendAnswer(message, trace)
    || composeCrossTableRatioAnswer(message, trace)
    || composeNumericComparisonAnswer(message, trace)
    || composeDateRangeCountAnswer(message, trace)
    || composeHybridPhaseAnswer(message, trace)
    || composeGenericFilteredRowsAnswer(message, trace)
    || composeFilteredPersonalRowsAnswer(message, trace)
    || await composeClassifiedDocumentAnswer(message, sessionId, attachmentIds, trace)
    || await answerFromRoutedDocumentText(message, parsed, route, attachmentIds, trace)
    || composeVerifiedFallback(message, trace);
}

async function composeMultiIntentAnswer(message: string, sessionId: string, attachmentIds: string[], trace: any = null) {
  const parts = await splitMultiIntentQuestionWithModel(message);
  if (!parts.length) return "";
  const results = await Promise.allSettled(parts.map((part) => withTimeout(answerSubQuestionDeterministically(part, sessionId, attachmentIds), 10000, part)));
  const sections = ["**Direct Answer**", `I split this into ${parts.length} sub-question(s) and answered each independently.`, ""];
  results.forEach((result, index) => {
    sections.push(`## ${index + 1}. ${parts[index]}`);
    sections.push(result.status === "fulfilled" ? result.value : `I could not answer this part: ${result.reason?.message || result.reason}`);
    sections.push("");
  });
  if (trace) { trace.finalSourceUsed = { sourceType: "mixed", answerMode: "multi_intent" }; trace.sqliteResult = sections.join("\n"); }
  return sections.join("\n").trim();
}

function analyzeData(docs: any[], message: string, sessionId: string, attachmentIds: string[] = []): string {
  const parsed = parseQuery(message);
  const hasAttachments = attachmentIds.length > 0;
  const messageAsksParticipants = /participant|beneficiar|served|client/i.test(message);
  const messageAsksAssociations = /association|slpa|group|organization|organisation/i.test(message);
  const messageAsksProjects = /project|enterprise|livelihood/i.test(message);
  const allSources = hasAttachments ? loadSheetSources({ attachmentIds }) : loadSheetSources();
  if (!allSources.length) return noUploadedSourceAnswer(parsed, [], hasAttachments ? "The attachment did not contain parseable spreadsheet rows." : "No parseable XLSX/CSV data is indexed.");
  const attachedPrefix = hasAttachments ? `Attached file used: ${Array.from(new Set(allSources.map((source: any) => source.fileName))).join(", ")}\n\n` : "";

  if (hasAttachments && /verify|match|served|encoded|not encoded/i.test(message)) {
    return composeSmartMatchCompare(allSources, message);
  }

  if (/data quality|duplicate participants?|missing municipality|blank status|invalid grant|inconsistent names|blank names?|missing barangay|missing visit|missing education|missing project/i.test(message)) {
    return composeDataQualityReport(allSources, message);
  }

  if (hasAttachments && (parsed.action === "analyze" || parsed.action === "summarize") && !/match|verify|served|encoded|not encoded/i.test(message)) {
    return composeAttachedFileInsight(allSources as any);
  }

  // Choose sources by relevance (scored)
  const scored = allSources.map(s => {
    const folder = s.source.toLowerCase();
    const namedSourceScore = sourceMatchesNamedTerms(s.source, parsed.namedSourceTerms) ? 50 : 0;
    const h = s.headers.map(x => x.toLowerCase());
    let typeScore = 0, topicScore = 0, fieldScore = 0;
    if (parsed.docType !== "none") {
      const kw = typeKeywordsFor(parsed.docType);
      const documentTypeNeedsSourceName = ["proposal", "template", "guideline", "report", "form", "pdf"].includes(parsed.docType);
      typeScore = kw.filter(k => folder.includes(k) || (!documentTypeNeedsSourceName && h.some(hh => hh.includes(k)))).length * 15;
      if (parsed.docType === "proposal" && /(^|\/)proposals?\//i.test(s.source)) typeScore = Math.max(typeScore, 30);
      if (parsed.docType === "template" && /(^|\/)templates?\//i.test(s.source)) typeScore = Math.max(typeScore, 30);
    }
    else if (!parsed.topicTerms.length && !parsed.requiredFields.length && ["analyze dataset", "report"].includes(parsed.intentType)) typeScore = 10;
    for (const t of parsed.topicTerms) {
      if (folder.includes(t)) topicScore += 10;
      if (h.some(hh => hh.includes(t))) topicScore += 8;
      if (s.rows.some(r => String(r.__rowText || "").includes(normalizeName(t)) || Object.values(r).some(v => fuzzyValueMatches(v, t)))) topicScore += 6;
    }
    for (const f of parsed.requiredFields) { const col = findMatchingColumn(s.headers, f); const fk = f.split(" "); if (col) fieldScore += 25; else if (h.some(hh => fk.every(x => hh.includes(x)))) fieldScore += 15; else if (h.some(hh => fk.some(x => hh.includes(x)))) fieldScore += 8; }
    const finalScore = namedSourceScore + typeScore + topicScore + fieldScore;
    return { ...s, namedSourceScore, typeScore, topicScore, fieldScore, finalScore };
  }).sort((a, b) => b.finalScore - a.finalScore);

  const requiredForCalculation = parsed.intentType === "count" || parsed.intentType === "chart" || parsed.action === "show_breakdown";
  const calculationFields = Array.from(new Set([
    ...parsed.requiredFields,
    ...parsed.groupBy,
    ...(messageAsksParticipants ? ["participant identity"] : []),
    ...(messageAsksAssociations ? ["association name"] : []),
    ...(messageAsksProjects ? ["project"] : []),
  ]));
  const dataQuestion = requiredForCalculation || messageAsksParticipants || messageAsksAssociations || messageAsksProjects || /grant utilization|gur|training|operational|closed|status/i.test(message);
  const scoredForIntent = dataQuestion && !hasAttachments ? scored.filter((source: any) => normalizeName(source.folder || "") !== "templates") : scored;
  const relevantByScore = hasAttachments ? scoredForIntent : scoredForIntent.filter(s => s.finalScore >= (parsed.namedSourceTerms.length ? 35 : 8));
  const selected = hasAttachments
    ? scoredForIntent.slice(0, 10) // Take top 10 for attachments
    : parsed.namedSourceTerms.length
      ? relevantByScore.slice(0, 8) // Take top 8 for named sources
      : requiredForCalculation
        ? [...scoredForIntent.filter((source) => sourceHasRequiredFields(source.headers, calculationFields)).slice(0, 5), ...scoredForIntent.filter((source) => !sourceHasRequiredFields(source.headers, calculationFields) && source.finalScore >= 15).slice(0, 3)] // Prefer sources with fields, but include some without if score is good
        : relevantByScore.slice(0, 8); // Take top 8 for general queries
  if (!selected.length && !message.toLowerCase().includes("files checked")) {
    const checked = scored.slice(0, 8).map(s => s.source);
    const note = requiredForCalculation
      ? "No source had the required reliable columns for this calculation."
      : "No source had enough filename, folder, header, row-value, or extracted-data relevance.";
    return noUploadedSourceAnswer(parsed, checked, note);
  }
  const allRows: Array<Record<string, string>> = [], allHeaders = new Set<string>();
  for (const s of selected) { allRows.push(...s.rows); s.headers.forEach(h => allHeaders.add(h)); }
  const headersArr = Array.from(allHeaders);
  const strictFilters = extractStrictFilters(message, parsed);
  const rowsForAnalysis = Object.keys(strictFilters).length ? filterRowsByFilters(allRows, headersArr, strictFilters) : allRows;

  // Handle "show files checked"
  if (message.toLowerCase().includes("files checked")) {
    return ["**Direct Answer**", `I checked ${scored.length} indexed spreadsheet source(s) and ranked them by attachment/named source, intent, headers, file/folder names, and row values.`, "", "**Relevant Table**", markdownTable(["Source", "Named", "Type", "Topic", "Fields", "Final", "Class", "Chartable"], scored.slice(0, 15).map(s => [s.source, String(s.namedSourceScore || 0), String(s.typeScore), String(s.topicScore), String(s.fieldScore), String(s.finalScore), s.finalScore >= 25 ? "HIGH" : s.finalScore >= 10 ? "MEDIUM" : "LOW", s.headers.filter(h => /count|total|amount|municipality|status|year/i.test(h)).join(", ").slice(0, 40) || "-"])), "", "**Source Used**", ...scored.slice(0, 5).map(s => `- ${s.source}`), "", "**How I calculated/found it**", `- Intent: ${parsed.intentType}`, "- Scored attachment priority, named source hints, file/folder/name, headers, row values, required fields, and extracted workbook metadata.", "", "**Data Quality Notes**", "- Debug scores are for source selection only; counts are calculated separately from selected structured columns.", "", "**Suggested Next Questions**", "- Show the selected rows", "- Count by status", "- Break it down by municipality"].join("\n");
  }

  let excelLabel = "";
  let direct = "";
  let tableRows: string[][] = [];
  let tableHeaders: string[] = [];

  if (parsed.intentType === "count" && !parsed.groupBy.length) {
    if (/participant|beneficiar|served|client/i.test(message)) {
      const idCol = headersArr.find(h => detectColumnRole(h) === "participant_id");
      const nameCol = headersArr.find(h => detectColumnRole(h) === "full_name");
      const keyCol = idCol || nameCol;
      if (keyCol || (headersArr.some(h => detectColumnRole(h) === "first_name") && headersArr.some(h => detectColumnRole(h) === "last_name"))) {
        const keys = new Set(rowsForAnalysis.map((row) => getParticipantIdentityFromRow(row)).filter(Boolean));
        const count = keys.size;
        direct = `Total participants: ${count}.`;
        tableHeaders = ["Metric", "Value"];
        tableRows = [["Total participants", String(count)], ["Key column", keyCol || "Full name parts"], ["Rows checked", String(rowsForAnalysis.length)]];
        excelLabel = `DISTINCTCOUNT by ${keyCol || "full name parts"}`;
      }
    } else if (/association|slpa|group|organization|organisation/i.test(message)) {
      const assocCol = findMatchingColumn(headersArr, "association name") || headersArr.find(h => /association|slpa|group|organization|organisation/i.test(h));
      if (assocCol) {
        const count = distinctCount(rowsForAnalysis, assocCol);
        direct = `Total associations/SLPAs: ${count}.`;
        tableHeaders = ["Metric", "Value"];
        tableRows = [["Total associations", String(count)], ["Key column", assocCol], ["Rows checked", String(rowsForAnalysis.length)]];
        excelLabel = `DISTINCTCOUNT by ${assocCol}`;
      }
    } else if (/project|enterprise|livelihood/i.test(message)) {
      const projectCol = findMatchingColumn(headersArr, "project") || headersArr.find(h => /enterprise|livelihood|project/i.test(h));
      if (projectCol) {
        const count = distinctCount(rowsForAnalysis, projectCol);
        direct = `Total projects/enterprises: ${count}.`;
        tableHeaders = ["Metric", "Value"];
        tableRows = [["Total projects/enterprises", String(count)], ["Key column", projectCol], ["Rows checked", String(rowsForAnalysis.length)]];
        excelLabel = `DISTINCTCOUNT by ${projectCol}`;
      }
    }
  }

  if (!direct && parsed.needsExcel && parsed.scope === "attached_file") {
    const keyField = parsed.requiredFields.find(f => /name|id|code|grant/i.test(f)) || "Name";
    const keyCol = headersArr.find(h => /name|id|code/i.test(h)) || headersArr[0];
    if (parsed.action === "compare" || parsed.action === "verify") {
      excelLabel = `XLOOKUP-style matching by ${keyField}`;
      const m = xlookupMatch(rowsForAnalysis, keyCol, rowsForAnalysis, keyCol);
      direct = `Compared ${rowsForAnalysis.length} records. Matched: ${m.matched.length}, Only in left: ${m.unmatchedLeft.length}, Only in right: ${m.unmatchedRight.length}.`;
      tableHeaders = ["Category", "Count"]; tableRows = [["In both", String(m.matched.length)], ["Only in left (encoded)", String(m.unmatchedLeft.length)], ["Only in right (not encoded)", String(m.unmatchedRight.length)]];
    } else if (parsed.action === "count") {
      excelLabel = "COUNTIFS-style counting";
      const conds = Object.entries(parsed.filterBy).map(([k, v]) => ({ column: k, value: v }));
      direct = `Found ${countIfs(rowsForAnalysis, conds)} matching records.`;
      tableHeaders = ["Metric", "Value"]; tableRows = [["Total matching", String(countIfs(rowsForAnalysis, conds))]];
    }
  } else if (!direct && (parsed.action === "count" || parsed.action === "show_breakdown")) {
    if (parsed.groupBy.includes("municipality") && parsed.requiredFields.includes("education")) {
      const educationSources = scored.filter((source) => findMatchingColumn(source.headers, "municipality") && findMatchingColumn(source.headers, "education"));
      const pivotSources = educationSources.length ? educationSources : selected;
      const pivotHeaders = Array.from(new Set(pivotSources.flatMap((source) => source.headers)));
      const pivotRows = pivotSources.flatMap((source) => source.rows);
      const mc = findMatchingColumn(pivotHeaders, "municipality");
      const ec = findMatchingColumn(pivotHeaders, "education");
      if (mc && ec) {
        const pivot = pivotGroupBy(pivotRows, mc, ec, "", "count");
        direct = `Grouped education by municipality from ${pivotRows.length} records.`;
        tableHeaders = pivot.headers;
        tableRows = pivot.rows.slice(0, 30);
        excelLabel = "Pivot table summary: education by municipality";
      } else {
        direct = `I could not find a reliable ${!mc ? "municipality" : "education"} column. I checked ${selected.slice(0, 5).map(s => s.source).join(", ")}.`;
      }
    } else if (parsed.groupBy.length) {
      const gf = parsed.groupBy[0]; const gc = headersArr.find(h => normalizeName(h).includes(gf));
      if (gc) {
        const g = new Map<string, number>();
        const participantKeyCol = messageAsksParticipants ? (headersArr.find(h => detectColumnRole(h) === "participant_id") || headersArr.find(h => detectColumnRole(h) === "full_name") || "") : "";
        const groupedDistinct = new Map<string, Set<string>>();
        for (const row of rowsForAnalysis) {
          const k = getCell(row, gc) || "Unspecified";
          if (participantKeyCol || messageAsksParticipants) {
            if (!groupedDistinct.has(k)) groupedDistinct.set(k, new Set());
            const key = getParticipantIdentityFromRow(row);
            if (key) groupedDistinct.get(k)!.add(key);
          } else {
            g.set(k, (g.get(k) || 0) + 1);
          }
        }
        if (participantKeyCol) groupedDistinct.forEach((set, key) => g.set(key, set.size));
        if (parsed.filterBy.status) { const sc = headersArr.find(h => /status/i.test(h)); if (sc) { g.clear(); for (const row of rowsForAnalysis) { if (getCell(row, sc).toLowerCase() === parsed.filterBy.status.toLowerCase()) { const k = getCell(row, gc) || "Unspecified"; g.set(k, (g.get(k) || 0) + 1); } } } }
        const groupedTotal = Array.from(g.values()).reduce((a, b) => a + b, 0);
        const groupedEntity = messageAsksParticipants ? "participants" : messageAsksAssociations ? "associations/SLPAs" : messageAsksProjects ? "projects/enterprises" : "records";
        direct = `Total: ${groupedTotal} ${groupedEntity} across ${g.size} ${gf}(s).`;
        tableHeaders = [gf.charAt(0).toUpperCase() + gf.slice(1), "Count"]; tableRows = topRows(g, 20);
        excelLabel = `COUNTIFS-style grouping by ${gf}`;
      }
    }
    if (!direct && parsed.requiredFields.includes("status") && /closed|operational/i.test(message)) {
      const sc = headersArr.find(h => detectColumnRole(h) === "status" || /status|remarks/i.test(h));
      if (!sc) {
        direct = `I could not find a reliable status column. I checked ${selected.slice(0, 5).map(s => s.source).join(", ")}.`;
      } else {
        const closed = rowsForAnalysis.filter(row => /closed/i.test(getCell(row, sc))).length;
        const operational = rowsForAnalysis.filter(row => /operational/i.test(getCell(row, sc))).length;
        if (closed + operational === 0) {
          direct = `I could not find reliable closed/operational values in the status column "${sc}". I checked ${selected.slice(0, 5).map(s => s.source).join(", ")}.`;
        } else if (parsed.filterBy.status === "operational") {
          direct = `Operational: ${operational}.`;
          tableHeaders = ["Status", "Count"]; tableRows = [["Operational", String(operational)]];
        } else if (parsed.filterBy.status === "closed") {
          direct = `Closed: ${closed}.`;
          tableHeaders = ["Status", "Count"]; tableRows = [["Closed", String(closed)]];
        } else {
          direct = `Closed: ${closed}. Operational: ${operational}.`;
          tableHeaders = ["Status", "Count"]; tableRows = [["Closed", String(closed)], ["Operational", String(operational)]];
        }
      }
    }
    if (!direct) { direct = `Total: ${rowsForAnalysis.length} records`; tableHeaders = ["Metric", "Value"]; tableRows = [["Total records", String(rowsForAnalysis.length)]]; }
  } else if (parsed.action === "find") {
    const typeLabel = parsed.docType !== "none" ? parsed.docType.charAt(0).toUpperCase() + parsed.docType.slice(1) : "Document";
    const topicLabel = parsed.topicTerms.join(", ") || "any";
    const typeSources = scored.filter(s => s.typeScore >= 10);
    const topicSources = parsed.topicTerms.length ? scored.filter(s => s.topicScore >= 5) : typeSources;
    if (typeSources.length && topicSources.length) {
      const exactTypeTopic = topicSources.filter(s => s.typeScore >= 10 && s.topicScore >= 5);
      if (exactTypeTopic.length) {
        direct = `${typeLabel} about ${topicLabel}: Found ${exactTypeTopic.length} source(s).`;
        tableHeaders = ["Source", "Type", "Topic", "Reason"]; tableRows = exactTypeTopic.slice(0, 8).map(s => [s.source, String(s.typeScore), String(s.topicScore), `Type=${s.typeScore > 0}, Topic=${s.topicScore > 0}`]);
      } else {
        direct = `I found ${topicLabel}-related records, but I did not find a ${typeLabel.toLowerCase()} about ${topicLabel}.`;
        tableHeaders = ["Related records", "Why not exact match"]; tableRows = topicSources.slice(0, 8).map(s => [s.source, `Not a ${typeLabel.toLowerCase()}`]);
      }
    } else if (topicSources.length && parsed.topicTerms.some(t => /fish|fishing|fishery/.test(t))) {
      direct = `I found records related to "${topicLabel}", but I did not find a ${typeLabel.toLowerCase()} document/column matching.`;
      tableHeaders = ["Related records", "Why not type match"]; tableRows = topicSources.slice(0, 8).map(s => [s.source, "Not " + typeLabel.toLowerCase()]);
    } else { direct = `I did not find ${typeLabel} content matching "${topicLabel}".`; }
  } else if (parsed.action === "analyze" || parsed.action === "summarize") {
    direct = `Analyzed ${rowsForAnalysis.length} rows across ${selected.length} source(s).`;
    tableHeaders = ["Metric", "Value"]; tableRows = [["Total rows", String(rowsForAnalysis.length)], ["Sources", String(selected.length)], ["Fields", headersArr.join(", ") || "None"]];
  } else {
    direct = `Found ${rowsForAnalysis.length} records from ${selected.length} source(s).`;
    tableHeaders = headersArr.slice(0, 5); tableRows = rowsForAnalysis.slice(0, 10).map(r => headersArr.slice(0, 5).map(h => getCell(r, h) || "-"));
  }

  let chart = chartDecisionEngine(parsed, rowsForAnalysis, headersArr);
  if (tableHeaders.length >= 2 && tableRows.length >= 2 && tableRows.every((row) => Number.isFinite(Number(row[1])))) {
    chart = {
      shouldChart: true,
      chartType: parsed.groupBy.includes("year") ? "line" : "horizontal_bar",
      title: `${tableHeaders[1]} by ${tableHeaders[0]}`,
      data: tableRows.slice(0, 12).map((row) => ({ name: row[0], value: Number(row[1]) })),
      insight: `${tableHeaders[0]} values are ranked by ${tableHeaders[1]}.`,
    };
  }
  setSession(sessionId, { parsedQuery: parsed, filteredRows: rowsForAnalysis, headers: headersArr, groupableColumns: headersArr.filter(h => /municipality|barangau|status|type|year|i/.test(h)), computedResult: direct, previousChartData: chart });

  // Compose answer
  const sections: string[] = ["**Direct Answer**", `${attachedPrefix}${direct}`, ""];
  if (tableHeaders.length && tableRows.length) { sections.push("**Summary Table**", markdownTable(tableHeaders, tableRows), ""); }
  if (chart.shouldChart) {
    sections.push("**Chart/Graph**", `_Chart type: ${chart.chartType.toUpperCase()}_`, `_${chart.insight}_`, "", "| Category | Value |", "|---|---|", ...chart.data.map(d => `| ${d.name || "-"} | ${d.value} |`), "", "```slp-chart", JSON.stringify({ charts: [{ type: chart.chartType === "horizontal_bar" ? "horizontalBar" : chart.chartType, title: chart.title, data: chart.data, note: chart.insight }] }, null, 2), "```", "");
  } else {
    sections.push("**Chart/Graph**", "No chart was generated because the selected data did not have at least two reliable category/value points for this question.", "");
  }
  sections.push("**Explanation**", `- Parsed intent: ${parsed.intentType} (${parsed.action})`);
  if (parsed.docType !== "none") sections.push(`- Document type: ${parsed.docType}`);
  if (parsed.topicTerms.length) sections.push(`- Topics detected: ${parsed.topicTerms.join(", ")}`);
  if (parsed.requiredFields.length) sections.push(`- Required data columns: ${parsed.requiredFields.join(", ")}`);
  if (parsed.groupBy.length) sections.push(`- Grouped/categorized by: ${parsed.groupBy.join(", ")}`);
  if (Object.keys(parsed.filterBy).length) sections.push(`- Filters applied: ${Object.entries(parsed.filterBy).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (excelLabel) sections.push(`- Data calculation method: ${excelLabel}`);
  sections.push(`- Sources analyzed: ${selected.length} sheet(s)`);
  sections.push(`- Data points processed: ${rowsForAnalysis.length} row(s)`);
  sections.push("", "**Source Used**", ...selected.map(s => `- ${s.source}`), "", "**Data Quality Notes**", "- All counts and metrics were calculated from indexed spreadsheet data only, not external sources.", "- No unrelated rows or documents were included in the analysis.", "- Column names were matched intelligently to tolerate variations in uploaded spreadsheets.", "", "**Suggested Next Questions**", "- Show chart", "- Show files checked", "- Break it down by municipality");
  return sections.join("\n");
}

// =========================
// UTILITY FUNCTIONS (text extraction, chunking, embedding, chat)
// =========================
function chunkText(text: string, size = 900, overlap = 120) {
  const cleaned = text.replace(/\s+/g, " ").trim(); if (!cleaned) return [];
  const chunks: string[] = []; for (let start = 0; start < cleaned.length; start += size - overlap) chunks.push(cleaned.slice(start, start + size).trim()); return chunks.filter(Boolean);
}
function getKeywords(text: string) {
  const stopWords = new Set(["what", "when", "where", "which", "who", "how", "the", "and", "for", "with", "from", "that", "this", "are", "was", "were", "does", "did", "can", "could", "about", "your", "uploaded", "document", "documents", "file", "files", "answer", "question", "please", "give", "show", "tell"]);
  return text.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2 && !stopWords.has(w)).slice(0, 12) || [];
}
function rankContextChunks(message: string, chunks: string[], maxChars = MAX_CONTEXT_CHARS) {
  const keywords = getKeywords(message).map(normalizeName);
  const phrases = extractExactPhrases(message);
  const ranked = chunks.filter(Boolean).map((chunk, index) => {
    const lower = normalizeName(chunk);
    const hits = keywords.filter((kw) => lower.includes(kw));
    const phraseHits = phrases.filter((phrase) => lower.includes(phrase));
    const allTerms = keywords.length > 1 && hits.length === keywords.length;
    const proximityBonus = hits.length >= 2 && hits.every((term) => lower.indexOf(term) >= 0) ? Math.max(0, 20 - (Math.max(...hits.map((term) => lower.indexOf(term))) - Math.min(...hits.map((term) => lower.indexOf(term)))) / 80) : 0;
    const score = hits.length * 8 + phraseHits.length * 40 + (allTerms ? 35 : 0) + proximityBonus;
    return { chunk, index, score, hits: hits.length };
  }).sort((a, b) => b.score - a.score || b.hits - a.hits || a.index - b.index);
  const selected = ranked.filter(i => i.score >= 12).slice(0, MAX_CHUNKS);
  if (!selected.length) return "";
  let ctx = "";
  for (const item of selected) { if (ctx.length + item.chunk.length > maxChars) break; ctx += `${item.chunk}\n\n`; }
  return ctx.trim();
}

async function generateEmbedding(_text: string): Promise<number[]> {
  throw new Error("Embeddings are disabled; keyword ranking is used for local SQLite document retrieval.");
}

type ModelRole = "router" | "main" | "dataAnalysis" | "chartRecommendation" | "verification" | "vision" | "fallback";
type ModelMessage = { role: "system" | "user" | "assistant"; content: any };
type GitHubModelSettings = {
  provider: "GitHub Models";
  roles: Record<ModelRole, { model: string }>;
  baseUrl: string;
  timeoutMs: number;
  enableVerificationForComplexOnly: boolean;
  enableImageDocumentVision: boolean;
};
type ModelSettingsSource = "database" | "env" | "fallback";

const MODEL_ROLES: ModelRole[] = ["router", "main", "dataAnalysis", "chartRecommendation", "verification", "vision", "fallback"];
const MODEL_ROLE_LABELS: Record<ModelRole, string> = {
  router: "Fast Router",
  main: "Main",
  dataAnalysis: "Reasoning",
  chartRecommendation: "Chart",
  verification: "Verification",
  vision: "Vision",
  fallback: "Fallback",
};

const ROLE_MODEL_PREFERENCES: Record<ModelRole, string[]> = {
  router: ["openai/gpt-4.1-mini"],
  main: ["openai/gpt-4.1"],
  dataAnalysis: ["openai/gpt-4.1"],
  chartRecommendation: ["openai/gpt-4.1"],
  verification: ["openai/gpt-4.1-mini"],
  vision: ["openai/gpt-4o"],
  fallback: ["openai/gpt-4.1-mini"],
};

const APPROVED_MODEL_BY_ROLE: Record<ModelRole, string> = {
  router: "openai/gpt-4.1-mini",
  main: "openai/gpt-4.1",
  dataAnalysis: "openai/gpt-4.1",
  chartRecommendation: "openai/gpt-4.1",
  verification: "openai/gpt-4.1-mini",
  vision: "openai/gpt-4o",
  fallback: "openai/gpt-4.1-mini",
};

const APPROVED_MODEL_IDS = new Set(Object.values(APPROVED_MODEL_BY_ROLE));
const BLOCKED_MODEL_PATTERN = /gpt-5|deepseek|grok|mistral|llama|phi/i;

function approvedModelForRole(role: ModelRole, model: string) {
  const value = String(model || "").trim();
  if (!APPROVED_MODEL_IDS.has(value) || BLOCKED_MODEL_PATTERN.test(value)) return APPROVED_MODEL_BY_ROLE[role];
  return value;
}

function getGitHubModelForRole(role: ModelRole) {
  if (role === "router") return approvedModelForRole(role, process.env.GITHUB_ROUTER_MODEL || process.env.GITHUB_FAST_MODEL || APPROVED_MODEL_BY_ROLE.router);
  if (role === "vision") return approvedModelForRole(role, process.env.GITHUB_VISION_MODEL || APPROVED_MODEL_BY_ROLE.vision);
  if (role === "dataAnalysis") return approvedModelForRole(role, process.env.GITHUB_DATA_ANALYSIS_MODEL || process.env.GITHUB_REASONING_MODEL || process.env.GITHUB_MAIN_MODEL || APPROVED_MODEL_BY_ROLE.dataAnalysis);
  if (role === "chartRecommendation") return approvedModelForRole(role, process.env.GITHUB_CHART_RECOMMENDATION_MODEL || process.env.GITHUB_CHART_MODEL || process.env.GITHUB_REASONING_MODEL || process.env.GITHUB_MAIN_MODEL || APPROVED_MODEL_BY_ROLE.chartRecommendation);
  if (role === "verification") return approvedModelForRole(role, process.env.GITHUB_VERIFICATION_MODEL || APPROVED_MODEL_BY_ROLE.verification);
  if (role === "fallback") return approvedModelForRole(role, process.env.GITHUB_FALLBACK_MODEL || APPROVED_MODEL_BY_ROLE.fallback);
  return approvedModelForRole(role, process.env.GITHUB_MAIN_MODEL || APPROVED_MODEL_BY_ROLE.main);
}

function getEnvModelSettings() {
  const envRoles: Record<ModelRole, string> = {
    router: process.env.GITHUB_ROUTER_MODEL || process.env.GITHUB_FAST_MODEL || "",
    main: process.env.GITHUB_MAIN_MODEL || "",
    dataAnalysis: process.env.GITHUB_DATA_ANALYSIS_MODEL || process.env.GITHUB_REASONING_MODEL || process.env.GITHUB_MAIN_MODEL || "",
    chartRecommendation: process.env.GITHUB_CHART_RECOMMENDATION_MODEL || process.env.GITHUB_CHART_MODEL || process.env.GITHUB_REASONING_MODEL || process.env.GITHUB_MAIN_MODEL || "",
    verification: process.env.GITHUB_VERIFICATION_MODEL || "",
    vision: process.env.GITHUB_VISION_MODEL || "",
    fallback: process.env.GITHUB_FALLBACK_MODEL || "",
  };
  return {
    baseUrl: process.env.GITHUB_MODELS_BASE_URL || "",
    roles: envRoles,
    timeoutMs: process.env.GITHUB_MODELS_TIMEOUT_MS ? Number(process.env.GITHUB_MODELS_TIMEOUT_MS) : undefined,
  };
}

function getSafeFallbackModel(role: ModelRole) {
  return ROLE_MODEL_PREFERENCES[role]?.[0] || "openai/gpt-4.1-mini";
}

function uniqueModelList(models: Array<string | undefined | null>) {
  return Array.from(new Set(models.map((model) => String(model || "").trim()).filter(Boolean)));
}

function getModelCandidatesForRole(role: ModelRole) {
  return uniqueModelList([getModelSettings().roles[role]?.model || getGitHubModelForRole(role), ...(ROLE_MODEL_PREFERENCES[role] || [])]);
}

function githubModelsCatalogBaseUrl() {
  return String(process.env.GITHUB_MODELS_BASE_URL || "https://models.github.ai/inference")
    .replace(/\/$/, "")
    .replace(/\/inference$/, "");
}

async function fetchGitHubModelsCatalog() {
  const token = process.env.GITHUB_TOKEN || "";
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  const res = await fetch(`${githubModelsCatalogBaseUrl()}/catalog/models`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub Models catalog ${res.status}: ${text.slice(0, 180)}`);
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : [];
}

function withCatalogSelectedModels(settings: GitHubModelSettings, catalogModels: any[]) {
  const catalogIds = new Set(catalogModels.map((model) => String(model.id || "")).filter(Boolean));
  if (!catalogIds.size) return settings;
  return {
    ...settings,
    roles: Object.fromEntries(MODEL_ROLES.map((role) => {
      const selected = getModelCandidatesForRole(role).find((model) => catalogIds.has(model)) || getGitHubModelForRole(role);
      return [role, { model: selected }];
    })) as Record<ModelRole, { model: string }>,
  };
}

function getSavedModelSettings() {
  const row = db.prepare("SELECT value_json FROM setting_values WHERE id = 'modelSettings'").get();
  if (!row?.value_json) return null;
  try {
    const parsed = JSON.parse(row.value_json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function dashboardDataFiles() {
  console.log("PARSING_START", { source: "dashboardDataFiles" });
  const files = (loadDashboardAggregatorSources() as any[]).map((source: any) => {
    const moduleType = dashboardSourceTypeForSource(source);
    const file = {
      id: source.sheetId || source.documentId || `${source.fileName}-${source.sheetName}`,
      documentId: source.documentId || "",
      fileName: source.fileName || source.file_name || "",
      originalName: source.fileName || source.file_name || "",
      moduleType,
      category: source.folder || "",
      headers: source.headers || [],
      rowCount: source.rows?.length || 0,
      rows: source.rows || [],
      sourceModule: moduleType ? registrySourceDisplayName(moduleType as any) : "Unknown",
      sourceFile: source.source || `${source.folder || "Unknown"}/${source.fileName || source.file_name || ""} / ${source.sheetName || ""}`,
      hasParsedRows: Boolean(source.rows?.length),
    };
    return file;
  });
  console.log("PARSING_COMPLETE", {
    files: files.length,
    rows: files.reduce((sum, file) => sum + Number(file.rowCount || 0), 0),
  });
  return files;
}

function rowsForUnifiedDashboard(files: ReturnType<typeof dashboardDataFiles>, moduleTypes: string[]) {
  const wanted = new Set(moduleTypes);
  return files
    .filter((file) => wanted.has(String(file.moduleType || "")))
    .flatMap((file) => (file.rows || []).map((row: any) => ({
      ...row,
      __sourceFile: file.sourceFile,
      __sourceModule: file.moduleType,
      __headers: file.headers,
    })));
}

const DASHBOARD_CACHE_TTL_MS = 45000;
let dashboardResponseCache: { version: string; builtAt: number; response: any; lastBuildMs: number } | null = null;

function safeCount(sql: string, fallback = 0) {
  try {
    const row = db.prepare(sql).get() as any;
    return Number(row?.count || fallback);
  } catch {
    return fallback;
  }
}

function dashboardSourceVersion() {
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS sheetCount,
        COALESCE(SUM(row_count), 0) AS rowCount,
        COALESCE(MAX(updated_at), '') AS sheetUpdated
      FROM uploaded_sheets
    `).get() as any;
    const docs = db.prepare("SELECT COUNT(*) AS docCount, COALESCE(MAX(updated_at), '') AS docUpdated FROM documents").get() as any;
    return `${row?.sheetCount || 0}:${row?.rowCount || 0}:${row?.sheetUpdated || ""}:${docs?.docCount || 0}:${docs?.docUpdated || ""}`;
  } catch {
    return String(Date.now());
  }
}

function clearDashboardResponseCache() {
  dashboardResponseCache = null;
}

function cachedUnifiedDashboardEndpointResponse(options: { force?: boolean } = {}) {
  const version = dashboardSourceVersion();
  const now = Date.now();
  if (!options.force && dashboardResponseCache && dashboardResponseCache.version === version && now - dashboardResponseCache.builtAt < DASHBOARD_CACHE_TTL_MS) {
    return {
      ...dashboardResponseCache.response,
      cacheStatus: { hit: true, builtAt: dashboardResponseCache.builtAt, ttlMs: DASHBOARD_CACHE_TTL_MS, lastBuildMs: dashboardResponseCache.lastBuildMs },
    };
  }

  console.time("DASHBOARD_SUMMARY_BUILD");
  console.time("PANTAWID_SUMMARY_BUILD");
  console.time("LIVELIHOOD_SUMMARY_BUILD");
  console.time("SLPA_DEMOGRAPHICS_BUILD");
  const started = Date.now();
  try {
    const response = buildUnifiedDashboardEndpointResponse();
    const lastBuildMs = Date.now() - started;
    dashboardResponseCache = { version, builtAt: Date.now(), response, lastBuildMs };
    return {
      ...response,
      cacheStatus: { hit: false, builtAt: dashboardResponseCache.builtAt, ttlMs: DASHBOARD_CACHE_TTL_MS, lastBuildMs },
    };
  } finally {
    console.timeEnd("SLPA_DEMOGRAPHICS_BUILD");
    console.timeEnd("LIVELIHOOD_SUMMARY_BUILD");
    console.timeEnd("PANTAWID_SUMMARY_BUILD");
    console.timeEnd("DASHBOARD_SUMMARY_BUILD");
  }
}

function buildUnifiedDashboardEndpointResponse() {
  console.log("UNIFIED_ENDPOINT_CALLED");
  const dashboardModuleTypes = new Set([
    "SLPIS_PERSONAL_MODULE",
    "SLPIS_PROJECT_MODULE",
    "SLPIS_GUR_MODULE",
    "SLPIS_TRAINING_MODULE",
    "MD_MONITORING_INDIVIDUAL",
    "MD_MONITORING_ASSOCIATION",
    "ORG_ASSESSMENT",
    "MD_ANNUAL_ASSESSMENT",
  ]);
  const rawSources = loadDashboardAggregatorSources() as any[];
  const relevantSources = rawSources.filter((source) => dashboardModuleTypes.has(String(dashboardSourceTypeForSource(source) || "")));
  const files = dashboardDataFiles().filter((file) => dashboardModuleTypes.has(String(file.moduleType || "")));
  const analytics = buildUnifiedDashboardAnalytics(relevantSources as any) as any;
  const sourceRows = files.flatMap((file) => (file.rows || []).map((row: any) => ({
    ...row,
    __sourceFile: file.sourceFile,
    __sourceModule: file.moduleType,
    __headers: file.headers,
  })));
  const personalRows = rowsForUnifiedDashboard(files, ["SLPIS_PERSONAL_MODULE"]);
  const projectRows = rowsForUnifiedDashboard(files, ["SLPIS_PROJECT_MODULE"]);
  const gurRows = rowsForUnifiedDashboard(files, ["SLPIS_GUR_MODULE"]);
  const trainingRows = rowsForUnifiedDashboard(files, ["SLPIS_TRAINING_MODULE"]);
  const monitoringIndividualRows = rowsForUnifiedDashboard(files, ["MD_MONITORING_INDIVIDUAL"]);
  const monitoringAssociationRows = rowsForUnifiedDashboard(files, ["MD_MONITORING_ASSOCIATION"]);
  const orgAssessmentRows = rowsForUnifiedDashboard(files, ["ORG_ASSESSMENT"]);
  const annualAssessmentRows = rowsForUnifiedDashboard(files, ["MD_ANNUAL_ASSESSMENT"]);
  const rowsParsedByType = {
    sourceRows: sourceRows.length,
    personalRows: personalRows.length,
    projectRows: projectRows.length,
    gurRows: gurRows.length,
    trainingRows: trainingRows.length,
    monitoringIndividualRows: monitoringIndividualRows.length,
    monitoringAssociationRows: monitoringAssociationRows.length,
    orgAssessmentRows: orgAssessmentRows.length,
    annualAssessmentRows: annualAssessmentRows.length,
  };
  console.log("ROWS_PARSED_BY_TYPE", rowsParsedByType);
  return {
    files,
    sourceRows,
    personalRows,
    projectRows,
    gurRows,
    trainingRows,
    monitoringIndividualRows,
    monitoringAssociationRows,
    orgAssessmentRows,
    annualAssessmentRows,
    municipalityStats: analytics.municipalityDrilldown || [],
    dashboardStats: analytics.summary || {},
    analytics,
    debug: { rowsParsedByType },
  };
}

function normalizeModelSettings(input: any = {}, source: ModelSettingsSource = "fallback"): GitHubModelSettings & { loadedFrom: ModelSettingsSource } {
  const env = getEnvModelSettings();
  const localSettings = getLocalModelFlags();
  const roleFor = (role: ModelRole) => approvedModelForRole(role, String(input.roles?.[role]?.model || input[role] || env.roles[role] || getSafeFallbackModel(role)));
  return {
    provider: "GitHub Models",
    roles: Object.fromEntries(MODEL_ROLES.map((role) => [role, { model: roleFor(role) }])) as Record<ModelRole, { model: string }>,
    baseUrl: String(input.baseUrl || env.baseUrl || "https://models.github.ai/inference"),
    timeoutMs: Number(input.timeoutMs || env.timeoutMs || localSettings.timeoutMs || 90000),
    enableVerificationForComplexOnly: input.enableVerificationForComplexOnly ?? localSettings.enableVerificationForComplexOnly ?? true,
    enableImageDocumentVision: input.enableImageDocumentVision ?? localSettings.enableImageDocumentVision ?? true,
    loadedFrom: source,
  };
}

function getModelSettings(): GitHubModelSettings & { loadedFrom: ModelSettingsSource } {
  const saved = getSavedModelSettings();
  if (saved) return normalizeModelSettings(saved, "database");
  const env = getEnvModelSettings();
  const hasEnv = Boolean(env.baseUrl || env.timeoutMs || Object.values(env.roles).some(Boolean));
  return normalizeModelSettings({}, hasEnv ? "env" : "fallback");
}

function modelSettingsResponse(settings = getModelSettings()) {
  return {
    baseUrl: settings.baseUrl,
    router: settings.roles.router.model,
    main: settings.roles.main.model,
    dataAnalysis: settings.roles.dataAnalysis.model,
    chartRecommendation: settings.roles.chartRecommendation.model,
    verification: settings.roles.verification.model,
    vision: settings.roles.vision.model,
    fallback: settings.roles.fallback.model,
    timeoutMs: settings.timeoutMs,
    loadedFrom: settings.loadedFrom,
    settings,
  };
}

function saveModelSettings(settings: any, adminId: string) {
  const now = new Date().toISOString();
  const current = getLocalModelFlags();
  const normalized = normalizeModelSettings(settings, "database");
  const next = {
    ...current,
    timeoutMs: Number(normalized.timeoutMs || current.timeoutMs || 90000),
    enableVerificationForComplexOnly: settings?.enableVerificationForComplexOnly ?? current.enableVerificationForComplexOnly ?? true,
    enableImageDocumentVision: settings?.enableImageDocumentVision ?? current.enableImageDocumentVision ?? true,
  };
  db.prepare("INSERT INTO setting_values (id, value_json, updated_by, updated_at) VALUES ('modelFlags', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
    .run(JSON.stringify(next), adminId, now);
  db.prepare("INSERT INTO setting_values (id, value_json, updated_by, updated_at) VALUES ('modelSettings', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
    .run(JSON.stringify(normalized), adminId, now);
  return getModelSettings();
}

function githubMessagesForRequest(role: ModelRole, messages: ModelMessage[], options: any = {}) {
  if (role !== "vision" || !Array.isArray(options.images) || !options.images.length) return messages;
  return messages.map((message) => {
    if (message.role !== "user") return message;
    return {
      role: message.role,
      content: [
        { type: "text", text: String(message.content || "") },
        ...options.images.map((image: string) => ({ type: "image_url", image_url: { url: image.startsWith("data:") ? image : `data:image/png;base64,${image}` } })),
      ],
    };
  });
}

async function callGitHubModelId(model: string, role: ModelRole, messages: ModelMessage[], options: any = {}) {
  const token = process.env.GITHUB_TOKEN || "";
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  const effectiveSettings = getModelSettings();
  const baseUrl = String(options.baseUrl || effectiveSettings.baseUrl || "https://models.github.ai/inference").replace(/\/$/, "");
  const timeoutMs = Number(options.timeoutMs || effectiveSettings.timeoutMs || CHAT_TIMEOUT);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: githubMessagesForRequest(role, messages, options),
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens || 2048,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub Models ${res.status}: ${text.slice(0, 180)}`);
    const data = JSON.parse(text);
    return { content: String(data.choices?.[0]?.message?.content || "").trim(), provider: "GitHub Models", model, responseTimeMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

async function callGitHubModel(role: ModelRole, messages: ModelMessage[], options: any = {}) {
  const candidates = uniqueModelList(options.candidateModels?.length ? options.candidateModels : getModelCandidatesForRole(role));
  const errors: string[] = [];
  for (const model of candidates) {
    try {
      const result = await callGitHubModelId(model, role, messages, options);
      return {
        ...result,
        configuredModel: candidates[0],
        fallbackUsed: model !== candidates[0],
      };
    } catch (error: any) {
      errors.push(`${model}: ${error.message || error}`);
    }
  }
  throw new Error(`No reachable GitHub model for ${MODEL_ROLE_LABELS[role] || role}. ${errors.join(" | ")}`);
}

async function callModel(role: ModelRole, messages: ModelMessage[], options: any = {}) {
  return callGitHubModel(role, messages, options);
}

async function generateChat(prompt: string, modelOverride?: string) {
  return (await callModel("main", [{ role: "user", content: prompt }], { temperature: 0.7, maxTokens: 1024 })).content;
}

async function generateVisionText(model: string, imageBase64: string, prompt: string) {
  return (await callModel("vision", [{ role: "user", content: prompt }], { images: [imageBase64], temperature: 0.1, maxTokens: 1600 })).content;
}

async function getDocumentContext(message: string, attachmentIds: string[] = []) {
  let queryEmbedding: number[] | null = null;
  try { queryEmbedding = await generateEmbedding(message); } catch (e) { console.error("Embedding fail:", e); }
  const rows = attachmentIds.length
    ? db.prepare(`SELECT id, file_name, folder, content_text FROM documents WHERE id IN (${attachmentIds.map(() => "?").join(",")}) AND content_text IS NOT NULL AND length(content_text) > 0 ORDER BY created_at DESC`).all(...attachmentIds)
    : db.prepare("SELECT id, file_name, folder, content_text FROM documents WHERE content_text IS NOT NULL AND length(content_text) > 0 AND (chat_attachment = 0 OR chat_attachment IS NULL) ORDER BY created_at DESC LIMIT ?").all(RAG_KEYWORD_SCAN_LIMIT);
  const ids = rows.map((row: any) => row.id).filter(Boolean);
  const pageRows = ids.length ? db.prepare("SELECT d.file_name, d.folder, p.page_number, p.text AS content_text FROM pdf_pages p JOIN documents d ON d.id = p.document_id WHERE p.document_id IN (" + ids.map(() => "?").join(",") + ") AND p.text IS NOT NULL AND length(p.text) > 0 ORDER BY d.created_at DESC, p.page_number ASC").all(...ids) : [];
  const cached = await readLocalDocumentCache().catch(() => []);
  const allRows = [...pageRows.map((row: any) => ({ file_name: `${row.file_name} (page ${row.page_number})`, folder: row.folder, content_text: row.content_text })), ...rows, ...cached].filter((row: any) => row.content_text);
  if (!allRows.length) return "";
  const chunks = allRows.flatMap((row: any) => chunkText(row.content_text || "", 900, 80).map((content) => ({ content, fileName: `${row.folder || "OTHER DOCUMENTS"}/${row.file_name}` })));
  return rankContextItems(message, chunks);
}

function scoreContext(message: string, content: string, fileName = "") {
  const keywords = getKeywords(message); const searchableContent = content.toLowerCase(); const searchableFile = fileName.toLowerCase(); const fullQuery = message.toLowerCase().replace(/\s+/g, " ").trim();
  let score = 0; if (fullQuery && searchableContent.includes(fullQuery)) score += 12; if (fullQuery && searchableFile.includes(fullQuery)) score += 20;
  for (const keyword of keywords) { if (searchableContent.includes(keyword)) score += 1; if (searchableFile.includes(keyword)) score += 6; }
  if (keywords.includes("mc") && keywords.some((k) => /^\d+$/.test(k)) && searchableFile.includes("mc")) score += 8;
  if (keywords.includes("guidelines") && searchableFile.includes("guideline")) score += 8;
  return score;
}

function rankContextItems(message: string, items: Array<{ content: string; fileName?: string }>, maxChars = MAX_CONTEXT_CHARS) {
  const ranked = items.filter((item) => item.content).map((item, index) => ({ ...item, index, score: scoreContext(message, item.content, item.fileName || "") })).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = ranked.filter((item) => item.score > 0).slice(0, MAX_CHUNKS), fallback = ranked.slice(0, MAX_CHUNKS);
  const finalChunks = selected.length ? selected : fallback; let context = "";
  for (const item of finalChunks) { const block = `SOURCE: ${item.fileName}\nCONTENT: ${item.content}`; if (context.length + block.length > maxChars) break; context += `${block}\n\n`; }
  return context.trim();
}

function tokenizeForSearch(text: string) {
  const stopWords = new Set(["what", "when", "where", "which", "who", "how", "the", "and", "for", "with", "from", "that", "this", "are", "was", "were", "does", "did", "can", "could", "about", "your", "uploaded", "document", "documents", "file", "files", "answer", "question", "please", "give", "show", "tell", "define", "definition", "meaning", "explain", "explanation", "describe", "copy", "download", "send", "provide", "need", "have", "attachment", "where"]);
  const normalized = normalizeName(text);
  return normalized.split(" ").filter((word) => word.length > 2 && !stopWords.has(word)).slice(0, 24);
}

async function expandQuestionWithModel(question: string) {
  if (!/\b(moa|template|form|participant|beneficiar|municipality|city|project|enterprise|annex|guideline|proposal)\b/i.test(question)) return question;
  try {
    const result = await callModel("router", [
      { role: "system", content: "Rewrite the user question to include common alternative phrasings for key terms. Return only one rewritten question. Do not answer it." },
      { role: "user", content: question },
    ], { temperature: 0, maxTokens: 160, timeoutMs: 10000 });
    const expanded = String(result.content || "").trim().replace(/^["']|["']$/g, "");
    if (expanded && normalizeName(expanded) !== normalizeName(question)) {
      console.log(`[QUERY_EXPANSION_USED] ${JSON.stringify({ originalQuestion: question, expandedQuestion: expanded })}`);
      return expanded;
    }
  } catch (error: any) {
    console.warn("Query expansion unavailable:", error.message || error);
  }
  return question;
}

function isFileRequest(message: string) {
  return /\b(?:can i have|may i have|give me|provide|send me|i need|copy of|have a copy|download|where is|where's|template for|form for|tool for)\b/i.test(message)
    && /\b(?:copy|file|document|template|form|tool|memorandum|memo|report|annex|proposal|guideline|pdf|docx|xlsx|csv|image|download)\b/i.test(message);
}

function downloadUrlForDocument(id: string) {
  return `/api/documents/${encodeURIComponent(id)}/download`;
}

function previewUrlForDocument(id: string) {
  return `/api/documents/${encodeURIComponent(id)}/preview`;
}

function previewAvailableForUploadedDocument(fileName = "", mimeType = "") {
  const type = mimeType || mimeTypeFromFileName(fileName);
  return /^(application\/pdf|image\/|text\/)|csv/i.test(type) || /\.(pdf|png|jpe?g|webp|txt|csv)$/i.test(fileName);
}

function normalizeFilePath(value: any) {
  let text = String(value || "").trim();
  try { text = decodeURIComponent(text); } catch {}
  return text
    .replace(/\\/g, "/")
    .replace(/^local-upload:\/\//i, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function normalizedPathBasename(value: any) {
  const normalized = normalizeFilePath(value);
  return normalized.split("/").filter(Boolean).pop() || normalized;
}

function localUploadPathFromFileUrl(fileUrl = "") {
  const value = String(fileUrl || "");
  if (!value.startsWith("local-upload://")) return "";
  const relative = value.replace("local-upload://", "");
  return path.resolve(UPLOAD_ROOT, relative);
}

function sourceReferenceCandidateRows() {
  backfillOriginalFileMetadata();
  return db.prepare(`
    SELECT
      d.id AS document_id,
      d.file_name AS document_file_name,
      d.file_url,
      d.file_type AS document_file_type,
      d.file_size AS document_file_size,
      d.folder AS document_folder,
      d.created_at AS document_created_at,
      d.updated_at AS document_updated_at,
      uf.id AS uploaded_file_id,
      uf.file_name AS uploaded_file_name,
      uf.folder AS uploaded_folder,
      uf.file_type AS uploaded_file_type,
      uf.uploaded_at AS uploaded_at,
      uf.updated_at AS uploaded_updated_at,
      m.file_id AS metadata_file_id,
      m.document_id AS metadata_document_id,
      m.original_file_name,
      m.folder AS metadata_folder,
      m.sub_folder,
      m.source_type,
      m.mime_type,
      m.file_size AS metadata_file_size,
      m.storage_path,
      m.download_url,
      m.upload_date,
      m.updated_at AS metadata_updated_at
    FROM documents d
    LEFT JOIN original_file_metadata m ON m.document_id = d.id OR m.file_id = d.id
    LEFT JOIN uploaded_files uf ON uf.document_id = d.id OR uf.id = m.file_id OR uf.id = d.id
  `).all() as any[];
}

function resolveRowFilePath(row: any) {
  const storagePath = String(row?.storage_path || "").trim();
  if (storagePath) return path.resolve(storagePath);
  return localUploadPathFromFileUrl(row?.file_url || "");
}

function rowOriginalFilename(row: any) {
  return String(row?.original_file_name || row?.uploaded_file_name || row?.document_file_name || "").trim();
}

function rowMimeType(row: any, fileName = "") {
  return String(row?.mime_type || row?.uploaded_file_type || row?.document_file_type || mimeTypeFromFileName(fileName));
}

function rowReferencePayload(row: any, source: any = {}, resolved = false) {
  const originalFilename = rowOriginalFilename(row) || String(source?.fileName || source?.title || "Uploaded file");
  const filePath = resolveRowFilePath(row);
  const documentId = String(row?.document_id || row?.metadata_document_id || source?.documentId || source?.document_id || "");
  const uploadedFileId = String(row?.uploaded_file_id || row?.metadata_file_id || source?.uploadedFileId || source?.fileId || source?.file_id || "");
  const category = canonicalTemplateCategory({
    source_type: row?.source_type || source?.module || source?.category,
    folder: row?.metadata_folder || row?.document_folder || row?.uploaded_folder || source?.category || source?.folder,
    original_file_name: originalFilename,
    mime_type: rowMimeType(row, originalFilename),
  });
  const module = String(row?.source_type || source?.module || category);
  const mimeType = rowMimeType(row, originalFilename);
  const exists = Boolean(filePath && fsSync.existsSync(filePath));
  const canDownload = Boolean(documentId && exists);
  return {
    documentId,
    uploadedFileId,
    fileId: uploadedFileId || documentId,
    originalFilename,
    fileName: originalFilename,
    storedFilename: filePath ? path.basename(filePath) : "",
    filePath,
    storageKey: row?.file_url || row?.download_url || "",
    category,
    module,
    mimeType,
    fileType: templateFileTypeLabel(originalFilename, mimeType),
    sourceFile: [category, row?.sub_folder, originalFilename].filter(Boolean).join("/"),
    downloadUrl: canDownload ? downloadUrlForDocument(documentId) : "",
    previewUrl: documentId && previewAvailableForUploadedDocument(originalFilename, mimeType) ? previewUrlForDocument(documentId) : "",
    exists,
    canDownload,
    resolved,
  };
}

function sourceReferenceSearchValues(source: any) {
  const sourcePath = String(source?.sourcePath || source?.source_path || source?.sourceFile || source?.source_file || source?.filePath || source?.path || "").trim();
  const fileName = String(source?.fileName || source?.filename || source?.originalFilename || source?.original_file_name || source?.file || source?.title || "").trim();
  const title = String(source?.title || source?.label || "").trim();
  const basename = normalizedPathBasename(sourcePath || fileName || title);
  const fullNeedles = [sourcePath, fileName, title].map(normalizeFilePath).filter(Boolean);
  const basenameNeedles = [basename, fileName, title].map(normalizedPathBasename).filter(Boolean);
  return {
    sourcePath,
    fileName,
    title,
    fullNeedles: Array.from(new Set(fullNeedles)),
    basenameNeedles: Array.from(new Set(basenameNeedles)),
  };
}

function rowReferencePaths(row: any) {
  const originalFilename = rowOriginalFilename(row);
  return [
    originalFilename,
    row?.document_file_name,
    row?.uploaded_file_name,
    row?.storage_path,
    row?.file_url,
    row?.download_url,
    [row?.source_type, row?.sub_folder, originalFilename].filter(Boolean).join("/"),
    [row?.metadata_folder || row?.document_folder || row?.uploaded_folder, row?.sub_folder, originalFilename].filter(Boolean).join("/"),
  ].filter(Boolean).map(String);
}

function scoreSourceReferenceRow(row: any, source: any) {
  const search = sourceReferenceSearchValues(source);
  const sameCategory = normalizeName(source?.category || source?.folder || "");
  const sameModule = normalizeName(source?.module || source?.sourceType || "");
  const paths = rowReferencePaths(row);
  const normalizedPaths = paths.map(normalizeFilePath).filter(Boolean);
  const basenames = paths.map(normalizedPathBasename).filter(Boolean);
  let score = 0;
  for (const needle of search.fullNeedles) {
    if (normalizedPaths.some((candidate) => candidate === needle)) score += 180;
    if (normalizedPaths.some((candidate) => candidate.endsWith(`/${needle}`) || needle.endsWith(`/${candidate}`))) score += 130;
    if (normalizedPaths.some((candidate) => candidate.includes(needle) || needle.includes(candidate))) score += 70;
  }
  for (const needle of search.basenameNeedles) {
    if (basenames.some((candidate) => candidate === needle)) score += 120;
  }
  if (sameCategory && normalizeName(`${row?.source_type || ""} ${row?.metadata_folder || ""} ${row?.document_folder || ""}`).includes(sameCategory)) score += 30;
  if (sameModule && normalizeName(`${row?.source_type || ""} ${row?.metadata_folder || ""} ${row?.sub_folder || ""}`).includes(sameModule)) score += 25;
  if (resolveRowFilePath(row) && fsSync.existsSync(resolveRowFilePath(row))) score += 20;
  if (row?.upload_date || row?.metadata_updated_at || row?.document_updated_at) score += 1;
  return score;
}

function directSourceReferenceRow(source: any) {
  const documentId = String(source?.documentId || source?.document_id || "").trim();
  const uploadedFileId = String(source?.uploadedFileId || source?.fileId || source?.file_id || "").trim();
  if (documentId || uploadedFileId) {
    const row = db.prepare(`
      SELECT
        d.id AS document_id, d.file_name AS document_file_name, d.file_url, d.file_type AS document_file_type,
        d.file_size AS document_file_size, d.folder AS document_folder, d.created_at AS document_created_at, d.updated_at AS document_updated_at,
        uf.id AS uploaded_file_id, uf.file_name AS uploaded_file_name, uf.folder AS uploaded_folder, uf.file_type AS uploaded_file_type,
        uf.uploaded_at AS uploaded_at, uf.updated_at AS uploaded_updated_at,
        m.file_id AS metadata_file_id, m.document_id AS metadata_document_id, m.original_file_name, m.folder AS metadata_folder,
        m.sub_folder, m.source_type, m.mime_type, m.file_size AS metadata_file_size, m.storage_path, m.download_url,
        m.upload_date, m.updated_at AS metadata_updated_at
      FROM documents d
      LEFT JOIN original_file_metadata m ON m.document_id = d.id OR m.file_id = d.id
      LEFT JOIN uploaded_files uf ON uf.document_id = d.id OR uf.id = m.file_id OR uf.id = d.id
      WHERE d.id = ? OR m.document_id = ? OR m.file_id = ? OR uf.id = ? OR uf.document_id = ?
      ORDER BY m.updated_at DESC, d.updated_at DESC
      LIMIT 1
    `).get(documentId, documentId, uploadedFileId || documentId, uploadedFileId, documentId || uploadedFileId) as any;
    if (row) return row;
  }
  const chunkId = String(source?.chunkId || source?.chunk_id || source?.documentChunkId || "").trim();
  if (chunkId) {
    const chunk = db.prepare("SELECT document_id FROM document_chunks WHERE id = ? LIMIT 1").get(chunkId) as any;
    if (chunk?.document_id) return directSourceReferenceRow({ ...source, documentId: chunk.document_id });
  }
  const rowId = String(source?.rowId || source?.row_id || source?.sheetRowId || "").trim();
  if (rowId) {
    const sheetRow = db.prepare("SELECT file_id FROM sheet_rows WHERE id = ? LIMIT 1").get(rowId) as any;
    if (sheetRow?.file_id) return directSourceReferenceRow({ ...source, uploadedFileId: sheetRow.file_id });
  }
  const sheetId = String(source?.sheetId || source?.sheet_id || source?.uploadedSheetId || "").trim();
  if (sheetId) {
    const sheet = db.prepare("SELECT file_id, document_id FROM uploaded_sheets WHERE id = ? LIMIT 1").get(sheetId) as any;
    if (sheet?.document_id || sheet?.file_id) return directSourceReferenceRow({ ...source, documentId: sheet.document_id, uploadedFileId: sheet.file_id });
  }
  return null;
}

function resolveSourceFileReference(source: any = {}) {
  const search = sourceReferenceSearchValues(source);
  console.log("RESOLVE_FILE_START", {
    sourcePath: search.sourcePath,
    fileName: search.fileName,
    evidenceKeys: Object.keys(source || {})
  });
  console.log("CHAT_FILE_REFERENCE_RESOLVE_START", {
    title: search.title,
    sourcePath: search.sourcePath,
    fileName: search.fileName,
    documentId: source?.documentId || source?.document_id || "",
    uploadedFileId: source?.uploadedFileId || source?.fileId || source?.file_id || "",
  });
  let row = directSourceReferenceRow(source);
  if (!row && (search.fullNeedles.length || search.basenameNeedles.length)) {
    row = sourceReferenceCandidateRows()
      .map((candidate) => ({ candidate, score: scoreSourceReferenceRow(candidate, source) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return String(b.candidate.metadata_updated_at || b.candidate.upload_date || b.candidate.document_updated_at || "").localeCompare(String(a.candidate.metadata_updated_at || a.candidate.upload_date || a.candidate.document_updated_at || ""));
      })[0]?.candidate || null;
  }
  const payload = row ? rowReferencePayload(row, source, true) : {
    documentId: "",
    uploadedFileId: "",
    fileId: "",
    originalFilename: search.fileName || search.title || normalizedPathBasename(search.sourcePath) || "",
    fileName: search.fileName || search.title || normalizedPathBasename(search.sourcePath) || "",
    storedFilename: "",
    filePath: "",
    storageKey: "",
    category: source?.category || source?.folder || "",
    module: source?.module || "",
    mimeType: "",
    fileType: "",
    sourceFile: search.sourcePath || "",
    downloadUrl: "",
    previewUrl: "",
    exists: false,
    canDownload: false,
    resolved: false,
  };
  console.log("CHAT_FILE_REFERENCE_RESOLVE_RESULT", {
    sourcePath: search.sourcePath,
    resolved: payload.resolved,
    documentId: payload.documentId,
    uploadedFileId: payload.uploadedFileId,
    originalFilename: payload.originalFilename,
    filePath: payload.filePath,
    exists: payload.exists,
    downloadUrl: payload.downloadUrl
  });
  console.log("RESOLVE_FILE_MATCH_RESULT", {
    sourcePath: search.sourcePath,
    basename: normalizedPathBasename(search.sourcePath || search.fileName || search.title),
    matched: Boolean(payload.resolved),
    matchedTable: row ? "documents/original_file_metadata/uploaded_files" : "",
    documentId: payload.documentId,
    uploadedFileId: payload.uploadedFileId,
    originalFilename: payload.originalFilename,
    filePath: payload.filePath,
    exists: payload.exists,
    downloadUrl: payload.downloadUrl
  });
  return payload;
}

function normalizeFileName(fileName: string) {
  return normalizeName(String(fileName || "")).replace(/\.(pdf|docx|doc|xlsx|xls|csv|txt)$/i, "").trim();
}

function extractDocumentTitle(content: string) {
  const text = String(content || "").replace(/\r/g, "");
  const lines = text.split(/\n+/).map((line) => line.trim()).filter((line) => line.length > 5);
  return normalizeName(lines.slice(0, 3).join(" ")).replace(/\s+/g, " ").trim();
}

function fileRequestDescription(doc: any, terms: string[]) {
  const text = String(doc.content_text || "").replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const hit = terms.find((term) => lower.includes(term));
  if (hit) {
    const index = lower.indexOf(hit);
    const start = Math.max(0, index - 70);
    return text.slice(start, start + 180).trim();
  }
  if (text && !text.startsWith("{\"__slpWorkbook\"")) return text.slice(0, 180);
  return `${doc.folder || "OTHER DOCUMENTS"} uploaded file.`;
}

function scoreFileRequestMatch(message: string, doc: any) {
  const query = normalizeName(message).replace(/\s+/g, " ").trim();
  const fileName = normalizeFileName(doc.file_name || "");
  const folder = normalizeName(doc.folder || "");
  const title = normalizeName(`${doc.file_name || ""} ${doc.folder || ""} ${extractDocumentTitle(doc.content_text || "")}`).replace(/\s+/g, " ").trim();
  const body = normalizeName(String(doc.content_text || "").slice(0, 10000)).replace(/\s+/g, " ").trim();
  const terms = tokenizeForSearch(message);
  const nameTitle = `${fileName} ${title}`;

  let score = 0;
  if (fileName && (query === fileName || query.includes(fileName) || fileName.includes(query))) score += 120;
  if (title && (query === title || query.includes(title) || title.includes(query))) score += 100;
  if (fileName && query.includes(fileName)) score += 70;
  if (title && query.includes(title)) score += 60;
  if (folder && query.includes(folder)) score += 20;
  if (fileName && terms.every((term) => fileName.includes(term))) score += 50;
  if (title && terms.every((term) => title.includes(term))) score += 40;
  for (const term of terms) {
    if (fileName.includes(term)) score += 18;
    else if (title.includes(term)) score += 12;
    else if (folder.includes(term)) score += 8;
    else if (body.includes(term)) score += 2;
  }
  if (/(template|form|tool|memoran|memo|report|annex)/i.test(message) && /\.(docx|xlsx?|pdf|csv)$/i.test(doc.file_name || "")) score += 10;
  if (doc.chat_attachment) score += 8;
  const shortRequired = terms.filter((term) => /^(md|ef|mc)$/.test(term));
  if (shortRequired.some((term) => !nameTitle.includes(term))) score = Math.min(score, 35);
  const annexMatch = normalizeName(message).match(/\bannex\s+([a-z0-9]+)\b/);
  if (annexMatch && !nameTitle.includes(`annex ${annexMatch[1]}`)) score = Math.min(score, 35);
  if (/\bmd\s+monitoring\s+tool\b/i.test(message) && !/md\s+monitoring\s+tool/.test(nameTitle)) score = Math.min(score, 35);
  return score;
}

function formatFileRequestLead(bestCount: number, exactMatch: boolean, ambiguous: boolean) {
  if (bestCount === 0) return "I could not find any uploaded files with an available original download.";
  if (exactMatch) return bestCount === 1 ? "I found the matching file." : `I found ${bestCount} matching version${bestCount === 1 ? "" : "s"}.`;
  if (ambiguous) return "I found several possible matches. Please tell me which file you want.";
  return bestCount === 1 ? "I found the best matching file." : `I found ${bestCount} matching files.`;
}

function canonicalSourceFolder(folder = "") {
  const normalized = normalizeName(folder);
  if (/^proposals?$/.test(normalized)) return "PROPOSAL";
  if (/^templates?$/.test(normalized)) return "TEMPLATES";
  if (/^other documents?$/.test(normalized)) return "OTHER DOCUMENTS";
  return folder || "OTHER DOCUMENTS";
}

function preferredSourceTypesForFileRequest(message: string, previousSources: string[] = []) {
  const usePreviousSourceContext = /\b(?:that|this|it|same|previous|above|recommended|mentioned)\b/i.test(message);
  const text = normalizeName(`${message} ${usePreviousSourceContext ? previousSources.join(" ") : ""}`);
  const types: string[] = [];
  if (/\bproposal|proposals?\b/.test(text)) types.push("PROPOSAL");
  if (/\btemplate|templates?|form|forms?|annex|tool\b/.test(text)) types.push("TEMPLATES");
  if (/\bguideline|guidelines?|mc|memorandum circular|implementation\b/.test(text)) types.push("GUIDELINES");
  if (/\bmemo|memorandum|reference|supporting document|other document\b/.test(text)) types.push("OTHER_DOCUMENTS");
  return Array.from(new Set(types));
}

function extractFileLikeNames(text: string) {
  const names = new Set<string>();
  for (const match of String(text || "").matchAll(/([A-Za-z0-9][^"'`\n\r]*?\.(?:docx?|pdf|xlsx?|csv|txt|png|jpe?g|webp))/gi)) {
    names.add(match[1].replace(/^[-:\s]+/, "").trim());
  }
  return Array.from(names);
}

function getPreviousSources(sessionId = "") {
  if (!sessionId) return [] as string[];
  try {
    const rows = db.prepare("SELECT source_files_json FROM analysis_history WHERE session_id = ? ORDER BY created_at DESC LIMIT 3").all(sessionId) as any[];
    return rows.flatMap((row) => {
      try { return JSON.parse(row.source_files_json || "[]"); } catch { return []; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function getPreviousAnswerContext(sessionId = "") {
  if (!sessionId) return null as any;
  try {
    const memory = db.prepare("SELECT memory_value FROM chat_memory WHERE user_id = ? AND memory_key = 'last_answer_context' ORDER BY updated_at DESC LIMIT 1").get(`session:${sessionId}`) as any;
    if (memory?.memory_value) return JSON.parse(memory.memory_value);
  } catch {}
  return null;
}

function savePreviousAnswerContext(sessionId = "", context: any = null) {
  if (!sessionId || !context?.source) return;
  upsertChatMemory(`session:${sessionId}`, "last_answer_context", context, sessionId);
}

function backfillOriginalFileMetadata() {
  const docs = db.prepare("SELECT id, file_name, file_url, folder, file_size, file_type, content_text, created_at, updated_at FROM documents").all();
  for (const doc of docs as any[]) upsertOriginalFileMetadata(doc);
}

function originalFileRows(attachmentIds: string[] = []) {
  backfillOriginalFileMetadata();
  if (attachmentIds.length) {
    return db.prepare(`
      SELECT m.file_id, m.document_id, m.original_file_name, m.folder, m.sub_folder, m.source_type, m.mime_type, m.file_size,
             m.storage_path, m.download_url, m.parsed_text_id, m.parsed_table_id, m.upload_date,
             m.document_type, m.document_purpose, m.document_stage, m.keywords, m.related_topics, m.short_summary,
             m.classification_confidence, m.classification_reason, m.matched_patterns, m.warnings, m.classification_override,
             d.file_url, d.content_text, d.chat_attachment, d.created_at
      FROM original_file_metadata m
      JOIN documents d ON d.id = m.document_id
      WHERE m.document_id IN (${attachmentIds.map(() => "?").join(",")})
      ORDER BY m.upload_date DESC
    `).all(...attachmentIds);
  }
  return db.prepare(`
    SELECT m.file_id, m.document_id, m.original_file_name, m.folder, m.sub_folder, m.source_type, m.mime_type, m.file_size,
           m.storage_path, m.download_url, m.parsed_text_id, m.parsed_table_id, m.upload_date,
           m.document_type, m.document_purpose, m.document_stage, m.keywords, m.related_topics, m.short_summary,
           m.classification_confidence, m.classification_reason, m.matched_patterns, m.warnings, m.classification_override,
           d.file_url, d.content_text, d.chat_attachment, d.created_at
    FROM original_file_metadata m
    JOIN documents d ON d.id = m.document_id
    ORDER BY m.upload_date DESC
  `).all();
}

function hasDownloadPath(file: any) {
  return Boolean(file.storage_path || String(file.file_url || "").startsWith("local-upload://") || /^https?:\/\//i.test(String(file.download_url || "")));
}

function scoreDownloadableFile(query: string, file: any, preferredSourceTypes: string[], previousSources: string[]) {
  const fileName = String(file.original_file_name || "");
  const normalizedFile = normalizeFileName(fileName);
  const normalizedQuery = normalizeFileName(query);
  const sourceName = normalizeName(`${file.folder || ""}/${fileName}`);
  const terms = tokenizeForSearch(query);
  const previousNames = previousSources.flatMap(extractFileLikeNames).map(normalizeFileName);
  const previousText = normalizeName(previousSources.join(" "));
  const usePreviousSourceContext = /\b(?:that|this|it|same|previous|above|recommended|mentioned)\b/i.test(query) || !terms.length;
  let score = 0;
  if (normalizedFile && (normalizedQuery === normalizedFile || normalizedQuery.includes(normalizedFile))) score += 260;
  if (extractFileLikeNames(query).some((name) => normalizeFileName(name) === normalizedFile)) score += 260;
  if (previousNames.some((name) => name === normalizedFile || name.includes(normalizedFile) || normalizedFile.includes(name))) score += usePreviousSourceContext ? 170 : 25;
  if (usePreviousSourceContext && previousText && previousText.includes(normalizeName(fileName))) score += 190;
  if (preferredSourceTypes.includes(file.source_type)) score += 90;
  else if (preferredSourceTypes.length) score -= 60;
  for (const term of terms) {
    if (normalizedFile.includes(term)) score += 22;
    else if (sourceName.includes(term)) score += 8;
  }
  const normalizedAnnexQuery = normalizeName(query);
  const annexNumberMatch = normalizedAnnexQuery.match(/\bannex\s+([a-z])\s+([0-9]+)\b/);
  const annexSimpleMatch = normalizedAnnexQuery.match(/\bannex\s+([a-z0-9]+)\b/);
  if (annexNumberMatch && !normalizedFile.includes(`annex ${annexNumberMatch[1]} ${annexNumberMatch[2]}`)) score -= 90;
  else if (annexSimpleMatch && !normalizedFile.includes(`annex ${annexSimpleMatch[1]}`)) score -= 90;
  score += Math.max(0, similarityScore(normalizedQuery, normalizedFile) - 55);
  if (!hasDownloadPath(file)) score -= 80;
  return applyGeneralDocumentRankingBoosts({
    message: query,
    score,
    fileName,
    folder: file.folder || "",
    sourceType: file.source_type || "",
    documentType: file.document_type || "",
    heading: file.document_type || "",
    sheetName: file.sub_folder || "",
    logContext: "downloadable_file",
  });
}

function findDownloadableFiles(query: string, preferredSourceTypes: string[] = [], previousSources: string[] = [], attachmentIds: string[] = []) {
  const rows = originalFileRows(attachmentIds);
  const scored = rows.map((file: any) => ({ file, score: scoreDownloadableFile(query, file, preferredSourceTypes, previousSources) }))
    .filter((item) => item.score > 20)
    .sort((a, b) => b.score - a.score || String(b.file.upload_date || "").localeCompare(String(a.file.upload_date || "")));
  const bestScore = scored[0]?.score || 0;
  const close = scored.filter((item) => item.score >= Math.max(45, bestScore - 35)).slice(0, 5);
  const downloadable = close.filter((item) => hasDownloadPath(item.file));
  const missingPath = close.filter((item) => !hasDownloadPath(item.file));
  return { downloadable, missingPath, checked: scored.slice(0, 5) };
}

async function composeFileRequestAnswer(message: string, attachmentIds: string[] = [], sessionId = "", trace: any = null) {
  const previousContext = getPreviousAnswerContext(sessionId);
  const previousSources = [...getPreviousSources(sessionId), previousContext?.source].filter(Boolean);
  const preferredSourceTypes = preferredSourceTypesForFileRequest(message, previousSources);
  const followUpDownload = /\b(that|this|it|same|previous|above|recommended|mentioned)\b/i.test(message);
  if (followUpDownload && previousContext?.source) {
    const previousFileName = String(previousContext.source).split("/").pop() || "";
    const previousSourceName = normalizeName(previousContext.source || "");
    const previousBaseName = normalizeName(previousFileName);
    const exact = originalFileRows(attachmentIds).find((file: any) => {
      const originalName = normalizeName(file.original_file_name || "");
      const sourceName = normalizeName(`${file.source_type || canonicalSourceFolder(file.folder)}/${file.original_file_name || ""}`);
      return originalName === previousBaseName
        || sourceName === previousSourceName
        || previousSourceName.includes(originalName)
        || sourceName.includes(previousBaseName);
    });
    if (exact && hasDownloadPath(exact)) {
    if (trace) {
      trace.filesSearched = [`${exact.source_type || canonicalSourceFolder(exact.folder)}/${exact.original_file_name}`];
      trace.finalSourceUsed = { source: `${exact.source_type || canonicalSourceFolder(exact.folder)}/${exact.original_file_name}`, sourceType: exact.source_type || canonicalSourceFolder(exact.folder), heading: exact.document_type || "original file metadata", score: 999 };
      trace.finalEvidenceText = `Original file metadata: ${exact.source_type || canonicalSourceFolder(exact.folder)}/${exact.original_file_name}; download available=${hasDownloadPath(exact)}`;
      trace.evidenceVerificationPassed = true;
    }
      return [
        "**Direct Answer**",
        `I found the previously referenced document: ${exact.original_file_name}`,
        "",
        "**Download Files**",
        `- [Download File](${downloadUrlForDocument(exact.file_id)})`,
        "",
        "**Source Used**",
        `- ${exact.source_type || canonicalSourceFolder(exact.folder)}/${exact.original_file_name}`,
        "",
        "**Data Quality Notes**",
        "- Download came from original file metadata using the previous answer context.",
      ].join("\n");
    }
  }
  const result = findDownloadableFiles(message, preferredSourceTypes, previousSources, attachmentIds);
  const candidates = result.downloadable.filter((candidate, index, arr) => arr.findIndex((item) => item.file.file_id === candidate.file.file_id) === index);
  const downloadDiagnostics = {
    query: message,
    detectedIntent: "download_request",
    preferredSourceTypes,
    filenameTokens: [...new Set([...extractFileLikeNames(message).flatMap((name) => tokenizeForSearch(name)), ...tokenizeForSearch(message)])],
    filesSearchedCount: originalFileRows(attachmentIds).length,
    matchedOriginalFiles: candidates.map(({ file, score }) => ({ fileName: file.original_file_name, sourceType: file.source_type, score, hasDownloadPath: hasDownloadPath(file) })),
    missingDownloadPathMatches: result.missingPath.map(({ file, score }) => ({ fileName: file.original_file_name, sourceType: file.source_type, score })),
  };
  console.log(`[DOWNLOAD_DIAGNOSTICS] ${JSON.stringify(downloadDiagnostics)}`);
  if (trace) {
    trace.filesSearched = result.checked.map(({ file, score }) => `${file.source_type || canonicalSourceFolder(file.folder)}/${file.original_file_name} (${Math.round(score)})`);
    trace.finalSourceUsed = candidates[0] ? { source: `${candidates[0].file.source_type || canonicalSourceFolder(candidates[0].file.folder)}/${candidates[0].file.original_file_name}`, sourceType: candidates[0].file.source_type || canonicalSourceFolder(candidates[0].file.folder), heading: candidates[0].file.document_type || "original file metadata", score: Math.round(candidates[0].score) } : null;
    trace.finalEvidenceText = candidates[0] ? `Original file metadata: ${candidates[0].file.source_type || canonicalSourceFolder(candidates[0].file.folder)}/${candidates[0].file.original_file_name}; download available=${hasDownloadPath(candidates[0].file)}` : "";
    trace.evidenceVerificationPassed = Boolean(candidates.length);
  }
  if (candidates.length) {
    const sections = [
      "**Direct Answer**",
      candidates.length === 1
        ? `I found the document: ${candidates[0].file.original_file_name}`
        : "I found multiple matching files. Choose one to download:",
      "",
      "**Download Files**",
    ];
    for (const { file, score } of candidates.slice(0, 5)) {
      sections.push(
        `### ${file.original_file_name}`,
        `- Source: ${file.source_type || canonicalSourceFolder(file.folder)}`,
        `- Source folder: ${canonicalSourceFolder(file.folder)}`,
        `- Match score: ${score}`,
        `- File type: ${file.mime_type || path.extname(file.original_file_name || "").replace(".", "").toUpperCase() || "file"}`,
        `- Upload date: ${file.upload_date || file.created_at || "-"}`,
        `- [Download File](${downloadUrlForDocument(file.file_id)})`,
        ""
      );
    }
    sections.push(
      "**Download Diagnostics**",
      `- query: ${downloadDiagnostics.query}`,
      `- detected intent: ${downloadDiagnostics.detectedIntent}`,
      `- preferred source types: ${downloadDiagnostics.preferredSourceTypes.join(", ") || "None"}`,
      `- filename tokens: ${downloadDiagnostics.filenameTokens.join(", ") || "None"}`,
      `- files searched count: ${downloadDiagnostics.filesSearchedCount}`,
      `- matched original files: ${downloadDiagnostics.matchedOriginalFiles.map((item) => `${item.sourceType}/${item.fileName} (download=${item.hasDownloadPath})`).join("; ") || "None"}`,
      ""
    );
    return sections.join("\n");
  }
  if (result.missingPath.length) {
    return [
      "**Direct Answer**",
      "I found the document content in the parsed knowledge base, but the original uploaded file is missing a download path. Please re-upload the original file or check storage_path.",
      "",
      "**Files Checked**",
      ...result.missingPath.slice(0, 5).map(({ file, score }) => `- ${file.source_type || canonicalSourceFolder(file.folder)}/${file.original_file_name} (score ${score}; missing storage_path/download_url)`),
    ].join("\n");
  }
  return [
    "**Direct Answer**",
    "I found matching text, but the original uploaded file is not available for download.",
    "",
    "**Files Checked**",
    ...(result.checked.length ? result.checked.map(({ file, score }) => `- ${file.source_type || canonicalSourceFolder(file.folder)}/${file.original_file_name} (score ${score})`) : ["- No matching original file metadata found."]),
  ].join("\n");
}

const TEMPLATE_RECOMMENDATION_CATEGORY_PRIORITY = ["TEMPLATES", "PROPOSAL", "GUIDELINES", "OTHER DOCUMENTS"];

function canonicalTemplateCategory(file: any) {
  const source = canonicalEvidenceSourceType(file.source_type || sourceTypeForFolder(file.folder || "", file.original_file_name || "", file.mime_type || ""));
  if (source === "PROPOSAL" || /PROPOSALS?/i.test(String(file.folder || ""))) return "PROPOSAL";
  if (source === "OTHER_DOCUMENTS") return "OTHER DOCUMENTS";
  if (/SLP_DPT|SLP DPT/i.test(source) || /SLP\s*DPT/i.test(String(file.folder || ""))) return "SLP DPT";
  if (/SLPIS/i.test(source) || /SLPIS/i.test(String(file.folder || ""))) return "SLPIS";
  if (source === "TEMPLATES") return "TEMPLATES";
  if (source === "GUIDELINES") return "GUIDELINES";
  return "OTHER DOCUMENTS";
}

function isTemplateRecommendationCategory(file: any) {
  return TEMPLATE_RECOMMENDATION_CATEGORY_PRIORITY.includes(canonicalTemplateCategory(file));
}

function templateIntentDetails(question: string) {
  const text = normalizeName(question);
  if (/^\s*(list|show)\s+(available\s+)?templates?\b/.test(text)) {
    console.log("CHAT_TEMPLATE_INTENT_DETECTED", { question, detected: false, purpose: "template listing", keywords: ["template"] });
    return { detected: false, purpose: "template listing", keywords: ["template"] };
  }
  const keywordPatterns: Array<[string, RegExp]> = [
    ["template", /\btemplates?\b/],
    ["form", /\bforms?\b/],
    ["file to use", /\bfile\s+(?:should|do|to)\s+(?:i\s+)?use\b|\bwhat\s+file\b/],
    ["document to use", /\bdocument\s+(?:should|do|to)\s+(?:i\s+)?use\b|\bwhat\s+document\b/],
    ["what should I use", /\bwhat\s+should\s+i\s+use\b/],
    ["download template", /\bdownload\s+(?:the\s+)?templates?\b/],
    ["waiver", /\bwaive(?:r)?\b|\bwaiver\s+form\b/],
    ["proposal", /\bproposal\b|\blivelihood proposal\b|\bseed capital\b|\bmicroenterprise\b/],
    ["MAF", /\bmaf\b|\bmicroenterprise assistance fund\b/],
    ["Mungkahing Proyekto", /\bmungkahing\s+proyekto\b/],
    ["PAT", /\bpat\b|\bproject assessment tool\b/],
    ["attendance", /\battendance\b/],
    ["assessment", /\bassessment\b/],
    ["monitoring", /\bmonitoring\b/],
    ["GUR", /\bgur\b|\bgrant utilization\b/],
    ["training", /\btraining\b/],
    ["SLPA", /\bslpa\b/],
    ["modality application", /\bmodality application\b/],
  ];
  const keywords = keywordPatterns.filter(([, pattern]) => pattern.test(text)).map(([keyword]) => keyword);
  const detected = keywords.length > 0 && (
    /\b(template|form|file|document|download|use|required|needed|give me)\b/.test(text)
    || /\b(proposal|maf|mungkahing proyekto|pat|attendance|assessment|monitoring|gur|training|slpa|seed capital|livelihood proposal|microenterprise|modality application)\b/.test(text)
  );
  let purpose = "uploaded file/template recommendation";
  if (/\bwaive(?:r)?\b|\bwaiver\s+form\b/.test(text)) purpose = "waiver form";
  else if (/\bseed capital\b|\bscf\b|\bslpa\b.*\bproposal\b|\bproposal\b.*\bslpa\b/.test(text)) purpose = "Seed Capital Fund / SLPA proposal";
  else if (/\bmicroenterprise\b|\bmaf\b/.test(text)) purpose = "microenterprise assistance or proposal";
  else if (/\bproposal\b|\bmungkahing proyekto\b|\blivelihood proposal\b/.test(text)) purpose = "livelihood proposal";
  else if (/\bassessment\b|\bpat\b|\bproject assessment tool\b/.test(text)) purpose = "assessment";
  else if (/\bmonitoring\b/.test(text)) purpose = "monitoring";
  else if (/\btraining\b|\battendance\b/.test(text)) purpose = "training or attendance";
  else if (/\bgur\b|\bgrant utilization\b/.test(text)) purpose = "Grant Utilization reporting";
  else if (/\bbeneficiary list\b|\bbeneficiar/.test(text)) purpose = "beneficiary list";
  else if (/\bmodality application\b/.test(text)) purpose = "modality application";
  console.log("CHAT_TEMPLATE_INTENT_DETECTED", { question, detected, purpose, keywords });
  return { detected, purpose, keywords };
}

function templatePurposeTerms(question: string, purpose: string) {
  const terms = new Set(tokenizeForSearch(`${question} ${purpose}`));
  const text = normalizeName(`${question} ${purpose}`);
  const add = (...items: string[]) => items.forEach((item) => tokenizeForSearch(item).forEach((term) => terms.add(term)));
  if (/seed capital|scf|slpa proposal/.test(text)) add("seed capital fund", "scf", "slpa", "maf", "microenterprise assistance fund", "mungkahing proyekto", "project proposal", "proposal");
  if (/microenterprise|maf/.test(text)) add("maf", "microenterprise assistance fund", "microenterprise", "proposal");
  if (/proposal|livelihood/.test(text)) add("proposal", "mungkahing proyekto", "project proposal", "livelihood");
  if (/assessment|pat/.test(text)) add("assessment", "project assessment tool", "pat");
  if (/monitoring/.test(text)) add("monitoring", "monitoring form", "monitoring tool");
  if (/training|attendance/.test(text)) add("training", "attendance", "attendance sheet");
  if (/gur|grant utilization/.test(text)) add("gur", "grant utilization", "grant utilization report");
  if (/beneficiary/.test(text)) add("beneficiary", "personal module", "slpis", "participant");
  if (/modality application/.test(text)) add("modality application", "annex k");
  if (/waive|waiver/.test(text)) add("waiver", "waive", "waiver form");
  if (/bank account|open account|account opening/.test(text)) add("bank account", "open bank account", "account opening", "endorsement letter");
  return Array.from(terms);
}

function preferredFileExtensionsForTemplatePurpose(purpose: string, question: string) {
  const text = normalizeName(`${purpose} ${question}`);
  if (/\b(attendance|list|beneficiary|tracker|matrix)\b/.test(text)) return [".xlsx", ".xls", ".csv", ".docx", ".pdf"];
  if (/\b(training|presentation|orientation)\b/.test(text)) return [".pptx", ".ppt", ".docx", ".xlsx", ".pdf"];
  if (/\b(proposal|form|template|assessment|monitoring|gur|modality)\b/.test(text)) return [".docx", ".xlsx", ".xls", ".pdf"];
  return [".docx", ".xlsx", ".xls", ".pdf", ".pptx", ".csv"];
}

function templateSpecificTerms(terms: string[]) {
  const generic = new Set([
    "template", "templates", "form", "forms", "file", "files", "document", "documents", "uploaded", "recommendation",
    "recommend", "needed", "required", "should", "use", "using", "download", "give", "purpose", "example", "definitely",
    "not", "matching", "matched",
  ]);
  return terms.filter((term) => term.length > 2 && !generic.has(term));
}

function templateFileTypeLabel(fileName = "", mimeType = "") {
  const ext = path.extname(fileName || "").replace(".", "").toUpperCase();
  if (ext) return ext;
  if (/word/i.test(mimeType)) return "DOCX";
  if (/sheet|excel/i.test(mimeType)) return "XLSX";
  if (/pdf/i.test(mimeType)) return "PDF";
  return "FILE";
}

function templatePreviewAvailable(fileName = "", mimeType = "") {
  return previewAvailableForUploadedDocument(fileName, mimeType);
}

function templateMatchReason(file: any, scoreDetails: string[], purpose: string) {
  const category = canonicalTemplateCategory(file);
  const reason = scoreDetails.slice(0, 2).join("; ");
  return reason || `Matched the ${purpose} purpose from uploaded ${category} metadata or extracted text.`;
}

function scoreTemplateRecommendationFile(question: string, file: any, purpose: string, purposeTerms: string[], preferredExtensions: string[]) {
  const category = canonicalTemplateCategory(file);
  const priorityIndex = TEMPLATE_RECOMMENDATION_CATEGORY_PRIORITY.indexOf(category);
  const fileName = String(file.original_file_name || "");
  const normalizedFile = normalizeName(fileName);
  const normalizedTitle = normalizeName(extractDocumentTitle(file.content_text || ""));
  const metadata = normalizeName([
    fileName,
    file.folder,
    file.sub_folder,
    file.source_type,
    file.document_type,
    file.document_purpose,
    file.document_stage,
    (file.keywordsArray || []).join(" "),
    (file.relatedTopicsArray || []).join(" "),
    file.short_summary,
  ].filter(Boolean).join(" "));
  const content = normalizeName(String(file.content_text || "").slice(0, 16000));
  const questionText = normalizeName(question);
  const ext = path.extname(fileName).toLowerCase();
  const scoreDetails: string[] = [];
  const specificTerms = templateSpecificTerms(purposeTerms);
  let specificTermHits = 0;
  let score = 0;

  if (priorityIndex >= 0) score += Math.max(0, 60 - priorityIndex * 8);
  if (questionText && normalizedFile && (normalizedFile.includes(questionText) || questionText.includes(normalizedFile))) {
    score += 220;
    scoreDetails.push("exact filename match");
  }
  if (questionText && normalizedTitle && (normalizedTitle.includes(questionText) || questionText.includes(normalizedTitle))) {
    score += 190;
    scoreDetails.push("exact title match");
  }
  if (category === "TEMPLATES" && /\b(template|form|annex|tool)\b/.test(questionText)) {
    score += 70;
    scoreDetails.push("template category match");
  }
  if (category === "PROPOSAL" && /\b(proposal|seed capital|slpa|microenterprise|livelihood)\b/.test(questionText)) {
    score += 65;
    scoreDetails.push("proposal category match");
  }
  if (/\bproposal\b/.test(questionText) && /\b(mungkahing proyekto|maf|microenterprise assistance fund)\b/.test(normalizedFile) && /\.docx?$/i.test(fileName)) score += 90;
  if (/\bproposal\b/.test(questionText) && /\btracker\b/.test(normalizedFile)) score -= 90;
  if (/\b(bank account|open account|account opening|open a bank account)\b/.test(questionText)) {
    if (/\bendorsement letter\b/.test(normalizedFile)) {
      score += 140;
      scoreDetails.push("filename matches the bank account endorsement purpose");
    }
    if (/\bwaiver\b/.test(normalizedFile) && !/\bwaive|waiver\b/.test(questionText)) score -= 70;
  }
  if (category === "GUIDELINES" && /\b(guideline|required|requirement|needed)\b/.test(questionText)) score += 35;
  let fileHits = 0;
  let metadataHits = 0;
  let contentHits = 0;
  for (const term of purposeTerms) {
    const isSpecific = specificTerms.includes(term);
    if (normalizedFile.includes(term)) { score += 32; fileHits++; if (isSpecific) specificTermHits++; }
    else if (metadata.includes(term) || normalizedTitle.includes(term)) { score += 20; metadataHits++; if (isSpecific) specificTermHits++; }
    else if (content.includes(term)) { score += 7; contentHits++; if (isSpecific) specificTermHits++; }
  }
  if (fileHits) scoreDetails.push("filename matches the requested purpose");
  if (metadataHits) scoreDetails.push("uploaded metadata matches the requested purpose");
  if (contentHits) scoreDetails.push("indexed text matches the requested purpose");
  if (fileHits >= 2) score += 45;
  if (metadataHits >= 2) score += 30;
  if (contentHits >= 2) score += 20;
  if (preferredExtensions.includes(ext)) score += 24;
  if (hasDownloadPath(file)) score += 25;
  else score -= 200;
  if (String(file.chat_attachment || "") === "1") score += 8;
  if (!/\b(template|form|annex|tool|proposal|assessment|monitoring|gur|training|attendance|maf|mungkahing|pat|slpa|beneficiary|modality|seed|capital|microenterprise)\b/.test(`${normalizedFile} ${metadata} ${content.slice(0, 2000)}`)) score -= 55;
  if (specificTerms.length && specificTermHits === 0) score = Math.min(score, 20);
  return { score, scoreDetails, specificTermHits };
}

function templateRecommendationForUi(file: any, score: number, confidence: "High" | "Medium" | "Low", reason: string, purpose: string) {
  const resolved = resolveSourceFileReference(file);
  const documentId = String(resolved.documentId || file.document_id || file.file_id || "");
  const fileName = String(file.original_file_name || "Uploaded file");
  const module = String(file.source_type || canonicalTemplateCategory(file));
  const category = canonicalTemplateCategory(file);
  const mimeType = file.mime_type || mimeTypeFromFileName(fileName);
  const storedFilename = file.storage_path ? path.basename(file.storage_path) : "";
  return {
    documentId,
    uploadedFileId: resolved.uploadedFileId || "",
    fileId: String(resolved.uploadedFileId || file.file_id || documentId),
    filename: resolved.originalFilename || fileName,
    fileName: resolved.fileName || fileName,
    originalFilename: resolved.originalFilename || fileName,
    storedFilename: resolved.storedFilename || storedFilename,
    filePath: resolved.filePath || file.storage_path || "",
    storageKey: resolved.storageKey || file.file_url || file.download_url || "",
    category: resolved.category || category,
    module: resolved.module || module,
    folder: file.folder || "",
    sourceFile: resolved.sourceFile || `${category}/${fileName}`,
    useFor: purpose,
    reason,
    confidence,
    score: Math.round(score),
    fileType: resolved.fileType || templateFileTypeLabel(fileName, mimeType),
    mimeType: resolved.mimeType || mimeType,
    downloadUrl: resolved.downloadUrl || "",
    previewUrl: resolved.previewUrl || "",
    canDownload: resolved.canDownload,
  };
}

function resolveTemplateFileReference(file: any, resultTitle = "") {
  const title = String(resultTitle || file?.original_file_name || file?.file_name || "");
  const sourcePath = [
    canonicalTemplateCategory(file),
    file?.folder,
    file?.sub_folder,
    file?.original_file_name || file?.file_name,
  ].filter(Boolean).join("/");
  const fileReference = resolveSourceFileReference({
    ...file,
    title,
    sourcePath,
    sourceFile: sourcePath,
    fileName: file?.original_file_name || file?.file_name || title,
    documentId: file?.document_id,
    uploadedFileId: file?.file_id,
    category: canonicalTemplateCategory(file),
    module: file?.source_type || "",
  });
  const resolved = fileReference.documentId ? {
    ...file,
    document_id: fileReference.documentId,
    file_id: fileReference.uploadedFileId || fileReference.documentId,
    original_file_name: fileReference.originalFilename || file?.original_file_name || title,
    storage_path: fileReference.filePath || file?.storage_path,
    file_url: fileReference.storageKey || file?.file_url,
    source_type: fileReference.module || file?.source_type,
    mime_type: fileReference.mimeType || file?.mime_type,
  } : file;
  const documentId = String(fileReference.documentId || resolved?.document_id || resolved?.file_id || "");
  const originalFilename = String(fileReference.originalFilename || resolved?.original_file_name || resolved?.file_name || title || "");
  const hasFilePath = Boolean(fileReference.filePath || resolved?.storage_path || resolved?.file_url);
  const hasDownloadUrl = Boolean(fileReference.downloadUrl);
  console.log("CHAT_TEMPLATE_FILE_REFERENCE_RESOLUTION", {
    resultTitle: title,
    sourcePath,
    resolvedDocumentId: documentId,
    resolvedUploadedFileId: fileReference.uploadedFileId || resolved?.file_id || "",
    originalFilename,
    hasFilePath,
    hasDownloadUrl
  });
  return { file: resolved, documentId, originalFilename, hasFilePath, hasDownloadUrl };
}

function composeNoTemplateMatchAnswer(categoriesSearched: string[]) {
  return [
    "I could not find a matching uploaded template/file for this purpose.",
    "",
    "Checked:",
    ...categoriesSearched.map((category) => `- ${category}`),
    "",
    "Possible reasons:",
    "- the template has not been uploaded",
    "- the file is in the wrong category",
    "- the file was uploaded but not indexed",
    "- the file name/content does not match the request",
    "",
    "Please upload the template or move it to the correct category.",
  ].join("\n");
}

function composeTemplateRecommendationAnswer(question: string, attachmentIds: string[] = [], trace: any = null) {
  const intent = templateIntentDetails(question);
  if (!intent.detected) return null;
  const categoriesSearched = TEMPLATE_RECOMMENDATION_CATEGORY_PRIORITY;
  const allRows = classifiedDocumentRows(attachmentIds);
  const scopedRows = allRows.filter((file: any) => isTemplateRecommendationCategory(file));
  const indexedFilesAvailable = scopedRows.filter((file: any) => String(file.content_text || "").trim().length > 0).length;
  console.log("CHAT_TEMPLATE_SEARCH_SCOPE", {
    categoriesSearched,
    totalFilesAvailable: scopedRows.length,
    indexedFilesAvailable,
  });

  const purposeTerms = templatePurposeTerms(question, intent.purpose);
  const preferredExtensions = preferredFileExtensionsForTemplatePurpose(intent.purpose, question);
  const allScored = scopedRows.map((file: any) => {
    const result = scoreTemplateRecommendationFile(question, file, intent.purpose, purposeTerms, preferredExtensions);
    return { file, ...result };
  }).sort((a, b) => b.score - a.score || TEMPLATE_RECOMMENDATION_CATEGORY_PRIORITY.indexOf(canonicalTemplateCategory(a.file)) - TEMPLATE_RECOMMENDATION_CATEGORY_PRIORITY.indexOf(canonicalTemplateCategory(b.file)));
  const scored = allScored.filter((item) => item.score >= 55);
  const bestScore = scored[0]?.score || 0;
  const exactSelected = scored.filter((item) => item.score >= Math.max(55, bestScore - 45)).slice(0, 8);
  const relatedSelected = exactSelected.length ? [] : allScored
    .filter((item) => /\.(docx?|xlsx?|pdf|pptx?)$/i.test(item.file.original_file_name || ""))
    .filter((item) => /\b(form|template|annex|tool|letter|certification|report|application)\b/i.test(item.file.original_file_name || item.file.document_type || ""))
    .slice(0, 3);
  const selected = exactSelected.length ? exactSelected : relatedSelected;
  const unresolvedResults: any[] = [];
  const results = selected.map((item) => {
    const resolution = resolveTemplateFileReference(item.file, item.file.original_file_name);
    if (!resolution.documentId || !resolution.hasDownloadUrl) unresolvedResults.push({ file: item.file, score: item.score, reason: "file reference could not be resolved" });
    const confidence = item.score >= 170 ? "High" : item.score >= 100 ? "Medium" : "Low";
    return resolution.documentId && resolution.hasDownloadUrl
      ? templateRecommendationForUi(resolution.file, item.score, confidence as any, templateMatchReason(resolution.file, item.scoreDetails, intent.purpose), intent.purpose)
      : null;
  }).filter(Boolean);

  console.log("CHAT_TEMPLATE_SEARCH_RESULTS", {
    resultCount: results.length,
    topResults: results.slice(0, 5).map((r) => ({
      filename: r.filename,
      category: r.category,
      module: r.module,
      score: r.score,
      hasDownloadUrl: !!r.downloadUrl
    }))
  });

  const downloadableResults = results.filter((item: any) => item.downloadUrl).slice(0, 3);
  const exactMatchFound = exactSelected.length > 0;
  const hiddenUnrelatedCount = Math.max(0, allRows.length - scopedRows.length);
  console.log("CHAT_TEMPLATE_FINAL_CARDS", {
    recommendedCount: downloadableResults.length,
      relatedCount: exactMatchFound ? 0 : downloadableResults.length,
    hiddenUnrelatedCount,
    unresolvedFileReferences: unresolvedResults.length
  });
  const confidence = downloadableResults.some((item) => item.confidence === "High") ? "High" : downloadableResults.some((item) => item.confidence === "Medium") ? "Medium" : downloadableResults.length ? "Low" : "Low";
  console.log("CHAT_TEMPLATE_FINAL_RECOMMENDATION", {
    recommendedCount: downloadableResults.length,
    filenames: downloadableResults.map((item) => item.filename),
    confidence
  });

  if (trace) {
    trace.templateRecommendation = {
      detected: true,
      purpose: intent.purpose,
      categoriesSearched,
      resultCount: downloadableResults.length,
    };
    trace.filesSearched = scopedRows.slice(0, 20).map((file: any) => `${canonicalTemplateCategory(file)}/${file.original_file_name}`);
    trace.topRetrievedChunks = selected.map((item) => ({
      source: `${canonicalTemplateCategory(item.file)}/${item.file.original_file_name}`,
      sourceType: canonicalTemplateCategory(item.file),
      heading: item.file.document_type || "uploaded file metadata",
      score: Math.round(item.score),
      preview: templateMatchReason(item.file, item.scoreDetails, intent.purpose),
    }));
    trace.finalSourceUsed = downloadableResults[0] ? {
      source: `${downloadableResults[0].category}/${downloadableResults[0].filename}`,
      sourceType: downloadableResults[0].category,
      heading: "template recommendation",
      score: downloadableResults[0].score,
      answerMode: "template_recommendation",
    } : null;
    trace.finalEvidenceText = downloadableResults.map((item) => `${item.category}/${item.filename}: ${item.reason}; download=${Boolean(item.downloadUrl)}`).join("\n");
    trace.evidenceVerificationPassed = Boolean(downloadableResults.length);
  }

  if (!downloadableResults.length) {
    return {
      answer: [
        `I could not find an exact uploaded ${intent.purpose} template/file.`,
        "",
        "Checked:",
        categoriesSearched.join(", "),
        ...(unresolvedResults.length ? ["", "Related file found but file reference could not be resolved.", ...unresolvedResults.slice(0, 3).map(({ file }) => `- ${file.original_file_name || file.file_name || "Related file"}`)] : []),
      ].join("\n"),
      fileRecommendations: [],
      relatedFiles: [],
      unresolvedFileReferences: unresolvedResults.slice(0, 3).map(({ file }) => file.original_file_name || file.file_name || "Related file"),
      confidence: 0,
      answerStatus: "refused_no_evidence",
    };
  }

  const primary = downloadableResults[0];
  const usesRequiredGrouping = /\b(proposal|seed capital|slpa|microenterprise|livelihood)\b/i.test(intent.purpose) && downloadableResults.length > 1;
  const required = usesRequiredGrouping
    ? downloadableResults.filter((item) => /\b(maf|mungkahing|proposal|project)\b/i.test(item.filename)).slice(0, 3)
    : downloadableResults.slice(0, 1);
  const requiredIds = new Set(required.map((item) => item.documentId));
  const optional = downloadableResults.filter((item) => !requiredIds.has(item.documentId)).slice(0, 3);
  const lines = [
    exactMatchFound ? (usesRequiredGrouping ? "Required files:" : "Recommended file:") : `I could not find an exact uploaded ${intent.purpose} template/file.\n\nClosest related uploaded files:`,
    ...(usesRequiredGrouping
      ? required.map((item) => `- ${item.filename} - ${item.useFor} - Download${item.previewUrl ? " / Preview" : ""}`)
      : !exactMatchFound
      ? downloadableResults.map((item, index) => `${index + 1}. ${item.filename} - ${item.reason} - Download${item.previewUrl ? " / Preview" : ""}`)
      : [
        `1. ${primary.filename}`,
        `   Use for: ${primary.useFor}`,
        `   Why this file: ${primary.reason}`,
        `   Category/Module: ${primary.category}/${primary.module}`,
        `   File type: ${primary.fileType}`,
        `   Confidence: ${primary.confidence}`,
        "   Actions:",
        "   - Download",
        ...(primary.previewUrl ? ["   - Preview"] : []),
      ]),
    ...(optional.length && usesRequiredGrouping ? ["", "Optional supporting files:", ...optional.map((item) => `- ${item.filename} - ${item.useFor} - Download${item.previewUrl ? " / Preview" : ""}`)] : []),
    ...(unresolvedResults.length ? ["", "Related file found but file reference could not be resolved.", ...unresolvedResults.slice(0, 3).map(({ file }) => `- ${file.original_file_name || file.file_name || "Related file"}`)] : []),
    "",
    "Sources checked:",
    `- Categories searched: ${categoriesSearched.join(", ")}`,
    `- Matching files found: ${downloadableResults.length}`,
    `- Top source used: ${primary.category}/${primary.filename}`,
    `- Confidence: ${confidence}`,
    ...(confidence === "Low" ? ["", "Please verify this file before use."] : []),
  ];
  return {
    answer: lines.join("\n"),
    fileRecommendations: downloadableResults,
    relatedFiles: [],
    unresolvedFileReferences: unresolvedResults.slice(0, 3).map(({ file }) => file.original_file_name || file.file_name || "Related file"),
    confidence: confidence === "High" ? 0.9 : confidence === "Medium" ? 0.65 : 0.35,
    answerStatus: confidence === "Low" ? "low_confidence" : "answered",
  };
}

function isDocumentRecommendationRequest(message: string) {
  if (isFileRequest(message)) return false;
  return /\b(?:what|which|do you have|recommend|use|using|template|form|annex|tool|document|agreement|certification|matrix|proposal|market map|market assessment|buyers|suppliers|sia|moa|barangay ranking|mlamm|plamm|rlamm|guideline)\b/i.test(message)
    && /\b(?:template|form|annex|tool|document|agreement|certification|matrix|proposal|market|map|buyers|suppliers|sia|moa|barangay|ranking|mlamm|plamm|rlamm|guideline|fish|hog|rice|sari)\b/i.test(message);
}

function preferredDocumentTypesForQuestion(message: string) {
  const text = normalizeName(message);
  const preferred: string[] = [];
  if (/market map|market mapping|market assessment|buyers?|suppliers?|where to sell|target market|product outlet/.test(text)) preferred.push("MARKET_ASSESSMENT_TOOL", "PROJECT_ASSESSMENT_TOOL", "PROJECT_PROPOSAL_TEMPLATE");
  if (/\bsia\b|specific implementation agreement/.test(text)) preferred.push("SPECIFIC_IMPLEMENTATION_AGREEMENT");
  if (/agreement|moa|lgu|partnership/.test(text)) preferred.push("SPECIFIC_IMPLEMENTATION_AGREEMENT", "UNIFIED_MOA", "REGIONAL_MOA");
  if (/disaster affected|disaster affected individuals|mc 3 s 2025/.test(text)) preferred.push("DISASTER_AFFECTED_CERTIFICATION");
  if (/area based convergence|area based|convergence participants/.test(text)) preferred.push("AREA_BASED_CONVERGENCE_CERTIFICATION");
  if (/barangay ranking|barangay prioritization|prioritize barangay/.test(text)) preferred.push("BARANGAY_RANKING_MATRIX");
  if (/\bc\s*mlamm\b|city mlamm|municipal mlamm|c_mlamm/.test(text)) preferred.push("C_MLAMM_MATRIX");
  if (/\bplamm\b|provincial lamm/.test(text)) preferred.push("PLAMM_MATRIX");
  if (/\brlamm\b|regional lamm/.test(text)) preferred.push("RLAMM_MATRIX");
  if (/proposal|fish|fishpond|hog|rice|sari|vending|livelihood proposal/.test(text)) preferred.push("PROPOSAL", "APPROVED_PROPOSAL", "PROJECT_PROPOSAL_TEMPLATE");
  if (/grant acknowledgement|acknowledgement receipt|annex r/.test(text)) preferred.push("GRANT_ACKNOWLEDGEMENT_RECEIPT");
  if (/modality application|annex k/.test(text)) preferred.push("MODALITY_APPLICATION_FORM");
  if (/constitution|by laws|by laws|annex i/.test(text)) preferred.push("SLPA_CONSTITUTION_BY_LAWS");
  if (/training|capability building/.test(text)) preferred.push("TRAINING_FORM");
  if (/monitoring/.test(text)) preferred.push("MONITORING_FORM");
  if (/\bgur\b|grant utilization/.test(text)) preferred.push("GUR_FORM");
  if (/template|blank form|prescribed form|annex|form/.test(text)) preferred.push("PROJECT_PROPOSAL_TEMPLATE", "TEMPLATE", "FORM");
  return Array.from(new Set(preferred));
}

function preferredSourceTypesForDocumentQuestion(message: string, preferredDocumentTypes: string[]) {
  const text = normalizeName(message);
  const types: string[] = [];
  if (/proposal|fish|fishpond|hog|rice|sari|vending|livelihood proposal/.test(text) || preferredDocumentTypes.includes("PROPOSAL")) types.push("PROPOSAL");
  if (/template|form|annex|tool|market map|market assessment|matrix|certification|sia|moa|agreement/.test(text)) types.push("TEMPLATES");
  if (/guideline|guidelines|implementation|policy|manual|moa|memorandum|agreement/.test(text)) types.push("GUIDELINES");
  if (/memo|memorandum|reference|supporting/.test(text)) types.push("OTHER_DOCUMENTS");
  return Array.from(new Set(types));
}

function annexIdentifiersFromQuestion(message: string) {
  return Array.from(message.matchAll(/\bannex\s+([A-Z])\s*[\.-]\s*(\d+)\b/gi))
    .map((match) => `annex ${match[1]} ${match[2]}`.toLowerCase());
}

function exactDocumentNeedlesFromQuestion(message: string) {
  const needles = new Set<string>();
  for (const annexId of annexIdentifiersFromQuestion(message)) needles.add(annexId);
  if (/\bunified\s+moa\b/i.test(message)) {
    needles.add("unified moa");
    needles.add("unified memorandum of agreement");
  }
  const quoted = Array.from(message.matchAll(/["“]([^"”]{4,120})["”]/g)).map((match) => normalizeName(match[1]));
  quoted.forEach((item) => needles.add(item));
  return Array.from(needles).filter(Boolean);
}

function folderBoostForQuestion(message: string, sourceType = "", folder = "") {
  const text = normalizeName(message);
  const source = String(sourceType || folder || "").toUpperCase();
  const folderText = normalizeName(`${sourceType} ${folder}`);
  if (/\b(template|form|annex|mungkahing proyekto|mp tracker)\b/.test(text) && (source.includes("TEMPLATES") || folderText.includes("templates"))) return { amount: 30, folder: "TEMPLATES" };
  if (/\b(guideline|policy|implementation|phase|moa|memorandum|agreement)\b/.test(text) && (source.includes("GUIDELINES") || folderText.includes("guidelines"))) return { amount: 30, folder: "GUIDELINES" };
  if (/\b(proposal|livelihood project|enterprise)\b/.test(text) && (source.includes("PROPOSAL") || folderText.includes("proposals"))) return { amount: 20, folder: "PROPOSALS" };
  return { amount: 0, folder: "" };
}

function docTypeBoostForQuestion(message: string, documentType = "", fileName = "") {
  const text = normalizeName(message);
  const type = String(documentType || "").toUpperCase();
  const name = normalizeName(fileName);
  if (/\b(project proposal|mungkahing proyekto)\b/.test(text) && !/PROJECT_PROPOSAL_TEMPLATE/.test(type) && !/\b(proposal|mungkahing proyekto)\b/.test(name)) return { amount: 0, reason: "" };
  if (/\b(template|blank form|prescribed form|form|annex)\b/.test(text) && (/TEMPLATE|FORM|ANNEX|TOOL|TRACKER|MATRIX/.test(type) || /\b(template|form|annex)\b/.test(name))) return { amount: 60, reason: "template/form request" };
  if (/\b(signatories|signatory|who signs|signed by|signs)\b/.test(text) && (/MOA|UNIFIED_MOA|MEMORANDUM|AGREEMENT/.test(type) || /\b(moa|memorandum|agreement)\b/.test(name))) return { amount: 70, reason: "signatory/MOA request" };
  return { amount: 0, reason: "" };
}

const rankingBoostLogKeys = new Set<string>();
function logRankingBoostOnce(label: string, payload: any) {
  const key = `${label}:${payload.context || ""}:${payload.fileName || ""}:${payload.folder || ""}:${payload.documentType || ""}:${payload.annexId || ""}:${payload.reason || ""}:${payload.boost || ""}`;
  if (rankingBoostLogKeys.has(key)) return;
  rankingBoostLogKeys.add(key);
  if (rankingBoostLogKeys.size > 5000) rankingBoostLogKeys.clear();
  console.log(`[${label}] ${JSON.stringify(payload)}`);
}

function applyGeneralDocumentRankingBoosts(input: { message: string; score: number; fileName?: string; folder?: string; sourceType?: string; documentType?: string; heading?: string; sheetName?: string; logContext: string }) {
  let score = input.score;
  const folderBoost = folderBoostForQuestion(input.message, input.sourceType || "", input.folder || "");
  if (folderBoost.amount) {
    score += folderBoost.amount;
    logRankingBoostOnce("FOLDER_BOOST_APPLIED", { context: input.logContext, fileName: input.fileName || "", folder: folderBoost.folder, boost: folderBoost.amount });
  }
  const haystack = normalizeName([input.fileName, input.sheetName, input.heading].filter(Boolean).join(" "));
  for (const needle of exactDocumentNeedlesFromQuestion(input.message)) {
    if (haystack.includes(needle)) {
      score += 500;
      logRankingBoostOnce("EXACT_SUBSTRING_BOOST_APPLIED", { context: input.logContext, fileName: input.fileName || "", sheetName: input.sheetName || "", heading: input.heading || "", exactSubstring: needle, boost: 500 });
      if (needle.startsWith("annex ")) logRankingBoostOnce("ANNEX_ID_MATCH", { context: input.logContext, fileName: input.fileName || "", heading: input.heading || "", annexId: needle, boost: 500 });
    }
  }
  const typeBoost = docTypeBoostForQuestion(input.message, input.documentType || "", input.fileName || "");
  if (typeBoost.amount) {
    score += typeBoost.amount;
    logRankingBoostOnce("DOCTYPE_BOOST_APPLIED", { context: input.logContext, fileName: input.fileName || "", documentType: input.documentType || "", reason: typeBoost.reason, boost: typeBoost.amount });
  }
  return score;
}

function classifiedDocumentRows(attachmentIds: string[] = []) {
  return originalFileRows(attachmentIds).map((file: any) => ({
    ...file,
    keywordsArray: safeJsonArray(file.keywords),
    relatedTopicsArray: safeJsonArray(file.related_topics),
    matchedPatternsObject: safeJsonObject(file.matched_patterns),
    warningsArray: safeJsonArray(file.warnings),
  }));
}

function scoreClassifiedDocument(message: string, file: any, preferredDocumentTypes: string[], preferredSourceTypes: string[]) {
  const text = normalizeName(message);
  const fileName = normalizeName(file.original_file_name || "");
  const allowFilenameBoost = explicitFilenameIntent(message);
  const source = String(file.source_type || "").toUpperCase();
  const documentType = String(file.document_type || "").toUpperCase();
  const purpose = normalizeName(file.document_purpose || "");
  const keywords = normalizeName((file.keywordsArray || []).join(" "));
  const related = normalizeName((file.relatedTopicsArray || []).join(" "));
  const content = normalizeName(String(file.content_text || "").slice(0, 12000));
  const terms = tokenizeForSearch(message);
  let score = Number(file.classification_confidence || 0) * 0.25;
  if (preferredDocumentTypes.includes(documentType)) score += 140;
  else if (preferredDocumentTypes.length && documentType.startsWith("OTHER_")) score -= 20;
  if (preferredSourceTypes.includes(source)) score += 80;
  else if (preferredSourceTypes.length) score -= 55;
  if (hasDownloadPath(file)) score += 18;
  if (/market map|market assessment|buyers|suppliers/i.test(message) && documentType === "MODALITY_APPLICATION_FORM") score -= 140;
  for (const term of terms) {
    if (allowFilenameBoost && fileName.includes(term)) score += 24;
    if (keywords.includes(term)) score += 18;
    if (related.includes(term)) score += 16;
    if (purpose.includes(term)) score += 12;
    if (content.includes(term)) score += 2;
  }
  for (const phrase of extractExactPhrases(message)) {
    if (allowFilenameBoost && fileName.includes(phrase)) score += 55;
    if (purpose.includes(phrase) || related.includes(phrase)) score += 45;
  }
  if (allowFilenameBoost && preferredDocumentTypes.length && preferredDocumentTypes.some((type) => fileName.includes(normalizeName(documentTypeDisplayName(type))))) score += 30;
  if (source === "PROPOSAL" && /proposal|fish|fishpond|hog|rice|sari|vending/i.test(message)) score += 35;
  if (source === "TEMPLATES" && /template|form|tool|annex|market map|agreement|certification|matrix/i.test(message)) score += 35;
  if (text.includes("market map") && /market/.test(fileName)) score += 60;
  return applyGeneralDocumentRankingBoosts({
    message,
    score,
    fileName: file.original_file_name || "",
    folder: file.folder || "",
    sourceType: file.source_type || "",
    documentType: file.document_type || "",
    heading: file.document_type || "",
    sheetName: file.sub_folder || "",
    logContext: "classified_document",
  });
}

async function composeClassifiedDocumentAnswer(message: string, sessionId = "", attachmentIds: string[] = [], trace: any = null) {
  if (!isDocumentRecommendationRequest(message)) return "";
  const preferredDocumentTypes = preferredDocumentTypesForQuestion(message);
  const preferredSourceTypes = preferredSourceTypesForDocumentQuestion(message, preferredDocumentTypes);
  const previousSources = getPreviousSources(sessionId);
  const rows = classifiedDocumentRows(attachmentIds);
  const searchableRows = preferredSourceTypes.length
    ? rows.filter((file: any) => preferredSourceTypes.includes(String(file.source_type || "").toUpperCase()))
    : rows;
  const scored = searchableRows.map((file: any) => ({ file, score: scoreClassifiedDocument(message, file, preferredDocumentTypes, preferredSourceTypes) }))
    .filter((item) => item.score >= (preferredDocumentTypes.length ? 55 : 35))
    .sort((a, b) => b.score - a.score || Number(b.file.classification_confidence || 0) - Number(a.file.classification_confidence || 0));
  const bestScore = scored[0]?.score || 0;
  const selected = scored.filter((item) => item.score >= Math.max(55, bestScore - 35)).slice(0, 5);
  const diagnostics = {
    query: message,
    intent: "classified_document_retrieval",
    preferredDocumentTypes,
    preferredSourceTypes,
    filesSearched: searchableRows.length,
    matches: selected.map(({ file, score }) => ({ fileName: file.original_file_name, sourceType: file.source_type, documentType: file.document_type, score, download: hasDownloadPath(file) })),
    previousSources,
  };
  console.log(`[DOCUMENT_CLASSIFIER_RETRIEVAL] ${JSON.stringify(diagnostics)}`);
  if (!selected.length) return "";
  const primary = selected[0].file;
  if (trace) {
    trace.filesSearched = searchableRows.slice(0, 12).map((file: any) => `${file.source_type || canonicalSourceFolder(file.folder)}/${file.original_file_name}`);
    trace.topRetrievedChunks = selected.map(({ file, score }) => ({
      source: `${file.source_type || canonicalSourceFolder(file.folder)}/${file.original_file_name}`,
      sourceType: file.source_type || canonicalSourceFolder(file.folder),
      heading: file.document_type || "classified metadata",
      score: Math.round(score),
      preview: String(file.document_purpose || file.short_summary || file.classification_reason || "").slice(0, 240),
    }));
    trace.finalSourceUsed = {
      source: `${primary.source_type || canonicalSourceFolder(primary.folder)}/${primary.original_file_name}`,
      sourceType: primary.source_type || canonicalSourceFolder(primary.folder),
      documentType: primary.document_type || "",
      heading: primary.document_type || "classified metadata",
      score: Math.round(selected[0].score),
      answerMode: "classified_document_metadata",
    };
    trace.finalEvidenceText = selected.map(({ file, score }) => [
      `Classified metadata: ${file.source_type || canonicalSourceFolder(file.folder)}/${file.original_file_name}`,
      `Document type: ${file.document_type || ""}`,
      `Purpose: ${file.document_purpose || ""}`,
      `Related topics: ${(file.relatedTopicsArray || []).join(", ")}`,
      `Download available: ${hasDownloadPath(file)}`,
      `Match score: ${Math.round(score)}`,
    ].join("\n")).join("\n\n");
    trace.evidenceVerificationPassed = true;
  }
  upsertChatMemory("system", "last_recommended_document", { fileName: primary.original_file_name, fileId: primary.file_id, sourceType: primary.source_type }, sessionId);
  if (selected.length === 1 || selected[0].score - (selected[1]?.score || 0) >= 20) {
    const rule = documentTypeRule(primary.document_type);
    const why = primary.classification_reason || rule?.purpose || primary.document_purpose || "Matched by document classification, filename, source type, and related topic.";
    return [
      "**Direct Answer**",
      "Recommended Document:",
      primary.original_file_name,
      "",
      "Document Type:",
      documentTypeDisplayName(primary.document_type),
      "",
      "Why:",
      why,
      "",
      "Source:",
      `${primary.source_type || canonicalSourceFolder(primary.folder)}${primary.sub_folder ? `/${primary.sub_folder}` : ""}/${primary.original_file_name}`,
      "",
      "Download:",
      hasDownloadPath(primary) ? `[Download File](${downloadUrlForDocument(primary.file_id)})` : "I found the document content, but the original uploaded file is missing a download path. Please re-upload the file or check storage_path.",
      "",
      "**Source Used**",
      `- ${primary.source_type || canonicalSourceFolder(primary.folder)}/${primary.original_file_name}`,
    ].join("\n");
  }
  return [
    "**Direct Answer**",
    "I found multiple matching documents. Choose one to download:",
    "",
    "**Recommended Documents**",
    ...selected.map(({ file, score }, index) => {
      const source = `${file.source_type || canonicalSourceFolder(file.folder)}${file.sub_folder ? `/${file.sub_folder}` : ""}`;
      const download = hasDownloadPath(file) ? `[Download](${downloadUrlForDocument(file.file_id)})` : "Download path missing";
      return `${index + 1}. ${file.original_file_name} — ${documentTypeDisplayName(file.document_type)} — ${source} — score ${Math.round(score)} — ${download}`;
    }),
    "",
    "**Source Used**",
    ...selected.map(({ file }) => `- ${file.source_type || canonicalSourceFolder(file.folder)}/${file.original_file_name}`),
  ].join("\n");
}

async function loadDocumentTextSources(attachmentIds: string[] = []) {
  const rows = attachmentIds.length
    ? db.prepare(`SELECT id, file_name, folder, content_text, chat_attachment FROM documents WHERE id IN (${attachmentIds.map(() => "?").join(",")}) AND content_text IS NOT NULL AND length(content_text) > 0 ORDER BY created_at DESC`).all(...attachmentIds)
    : db.prepare("SELECT id, file_name, folder, content_text, chat_attachment FROM documents WHERE content_text IS NOT NULL AND length(content_text) > 0 AND (chat_attachment = 0 OR chat_attachment IS NULL) ORDER BY created_at DESC LIMIT ?").all(RAG_KEYWORD_SCAN_LIMIT);
  const ids = rows.map((row: any) => row.id).filter(Boolean);
  const visionRows = ids.length ? db.prepare(`SELECT d.id, d.file_name, d.folder, d.chat_attachment, v.page_number, v.image_number, v.extraction_method, v.model_used, v.confidence, v.text AS content_text FROM vision_extractions v JOIN documents d ON d.id = v.document_id WHERE v.document_id IN (${ids.map(() => "?").join(",")}) AND v.text IS NOT NULL AND length(v.text) > 0 ORDER BY d.created_at DESC, v.page_number ASC, v.image_number ASC`).all(...ids) : [];
  const visionDocumentIds = new Set(visionRows.map((row: any) => row.id));
  const cached = attachmentIds.length ? [] : (await readLocalDocumentCache().catch(() => [])).filter((row: any) => !row.chat_attachment && !/chat attachments/i.test(String(row.folder || "")));
  const seen = new Set<string>();
  return [...visionRows, ...rows.filter((row: any) => !visionDocumentIds.has(row.id)), ...cached].filter((row: any) => {
    const key = `${row.id || row.folder}/${row.file_name || row.fileName}/${row.page_number || ""}/${row.image_number || ""}/${row.extraction_method || "document"}`;
    if (!row.content_text || String(row.content_text).trim().startsWith("{\"__slpWorkbook\"") || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function documentSourceType(source: any) {
  const fileName = source.file_name || source.fileName || source.original_file_name || "";
  const folder = source.folder || "";
  const metadata = source.id ? db.prepare("SELECT source_type FROM original_file_metadata WHERE document_id = ? OR file_id = ?").get(source.id, source.id) as any : null;
  return String(metadata?.source_type || sourceTypeForFolder(folder, fileName, source.file_type || ""));
}

function documentMetadata(source: any) {
  if (!source.id) return null;
  return db.prepare("SELECT source_type, document_type, document_purpose, original_file_name, folder, sub_folder FROM original_file_metadata WHERE document_id = ? OR file_id = ?").get(source.id, source.id) as any;
}

function sourceLabelForDocument(source: any) {
  const metadata = documentMetadata(source);
  const sourceType = String(metadata?.source_type || documentSourceType(source) || "OTHER_DOCUMENTS");
  const fileName = metadata?.original_file_name || source.file_name || source.fileName || "document";
  const subFolder = metadata?.sub_folder ? `/${metadata.sub_folder}` : "";
  return `${sourceType}${subFolder}/${fileName}`;
}

function isExactListQuestion(message: string) {
  return /\b(phases?|steps?|requirements?|eligibility|documents?\s+needed|process|criteria|list|types?|categories|components?|forms?|annex(?:es)?)\b/i.test(message);
}

function queryTermSet(message: string) {
  return new Set(tokenizeForSearch(message).map(normalizeName));
}

function queryPhrases(message: string) {
  const normalized = normalizeName(message);
  const phrases = new Set(extractExactPhrases(message));
  const phaseHeading = normalized.match(/\bphase\s+(one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*\(([^)]+)\))?/i);
  if (phaseHeading) {
    phrases.add(`phase ${phaseHeading[1]}`);
    if (phaseHeading[2]) phrases.add(`phase ${phaseHeading[1]} ${phaseHeading[2]}`);
  }
  const interesting = [
    "implementation phases",
    "five implementation phases",
    "primary stages",
    "implementation process",
    "sustainability plan",
    "eligibility requirements",
    "documents needed",
    "grant utilization",
    "market assessment",
    "project proposal",
  ];
  interesting.forEach((phrase) => { if (normalized.includes(phrase)) phrases.add(phrase); });
  return Array.from(phrases);
}

function significantNgrams(message: string, minLength = 5) {
  const terms = tokenizeForSearch(message);
  const grams = new Set<string>();
  for (let size = Math.min(8, terms.length); size >= minLength; size--) {
    for (let index = 0; index <= terms.length - size; index++) grams.add(terms.slice(index, index + size).join(" "));
  }
  return Array.from(grams);
}

function explicitFilenameIntent(message: string) {
  return /\b(filename|file name|named|called|annex\s+[a-z0-9.]+|\.docx|\.pdf|\.xlsx|\.xls|\.csv|unified\s+(?:moa|memorandum)|memorandum of agreement)\b/i.test(message);
}

function looksLikeHeading(line: string) {
  const text = line.trim();
  if (text.length < 3 || text.length > 120) return false;
  if (/^(\d+(\.\d+)*|[IVXLCDM]+|[A-Z])[\).\s-]+[A-Z]/.test(text)) return true;
  if (/^(section|chapter|part|annex|phase|step)\b/i.test(text)) return true;
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4 && text === text.toUpperCase();
}

function splitEvidenceBlocks(content: string) {
  const lines = String(content || "").replace(/\r/g, "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const blocks: Array<{ heading: string; text: string }> = [];
  let heading = "Unlabeled section";
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text.length >= 40) blocks.push({ heading, text });
    buffer = [];
  };
  for (const line of lines) {
    if (looksLikeHeading(line)) {
      flush();
      heading = line.replace(/\s+/g, " ").trim();
    } else {
      buffer.push(line);
      if (buffer.join(" ").length > 2200) flush();
    }
  }
  flush();
  if (blocks.length) return blocks;
  return chunkText(content, 1200, 150).map((text, index) => ({ heading: index ? `Extracted text chunk ${index + 1}` : "Extracted text", text }));
}

function numberedListDensity(text: string) {
  const matches = String(text || "").match(/(^|\n|\s)(?:\d+[\).\:]|[a-z][\).\:]|[ivxlcdm]+[\).\:]|[-*])\s+[A-Za-z]/gi);
  return matches?.length || 0;
}

function scoreEvidenceBlock(message: string, parsed: ParsedQuery, route: QueryRoute | null, source: any, block: { heading: string; text: string }) {
  const sourceType = canonicalEvidenceSourceType(documentSourceType(source));
  const metadata = documentMetadata(source);
  const label = normalizeName(sourceLabelForDocument(source));
  const heading = normalizeName(block.heading);
  const text = normalizeName(block.text);
  const terms = Array.from(queryTermSet(message));
  const phrases = queryPhrases(message);
  const ngrams = significantNgrams(message);
  const allowFilenameBoost = explicitFilenameIntent(message);
  let score = 0;

  const routePrimary = (route?.primarySourceTypes || []).map((type) => canonicalEvidenceSourceType(type));
  const routeSecondary = (route?.secondarySourceTypes || []).map((type) => canonicalEvidenceSourceType(type));
  if (routePrimary.includes(sourceType)) score += 120;
  else if (routeSecondary.includes(sourceType)) score += 45;
  else if (route?.primarySourceTypes.length) score -= 160;

  if (parsed.docType === "proposal" && sourceType === "PROPOSAL") score += 80;
  if (parsed.docType === "template" && sourceType === "TEMPLATES") score += 80;
  if (parsed.docType === "guideline" && sourceType === "GUIDELINES") score += 80;
  if (metadata?.document_type && preferredDocumentTypesForQuestion(message).includes(String(metadata.document_type).toUpperCase())) score += 80;

  for (const phrase of phrases) {
    if (heading.includes(phrase)) {
      score += 120;
      console.log(`[CONTENT_BOOST_APPLIED] ${JSON.stringify({ logContext: "document_chunk", type: "heading_phrase", phrase, heading: block.heading })}`);
    }
    if (allowFilenameBoost && label.includes(phrase)) score += 70;
    if (text.includes(phrase)) {
      score += 90;
      console.log(`[CONTENT_BOOST_APPLIED] ${JSON.stringify({ logContext: "document_chunk", type: "text_phrase", phrase })}`);
    }
  }
  for (const gram of ngrams) {
    if (text.includes(gram)) {
      score += 40;
      console.log(`[CONTENT_BOOST_APPLIED] ${JSON.stringify({ logContext: "document_chunk", type: "exact_ngram", ngram: gram })}`);
    }
  }
  let termHits = 0;
  for (const term of terms) {
    if (heading.includes(term)) { score += 26; termHits++; }
    else if (allowFilenameBoost && label.includes(term)) { score += 18; termHits++; }
    else if (text.includes(term)) { score += 10; termHits++; }
  }
  if (terms.length && termHits >= Math.min(terms.length, 3)) score += 45;
  if (isExactListQuestion(message) && numberedListDensity(block.text) >= 2) score += 55;
  if (isExactListQuestion(message) && extractEvidenceList(block.text).length >= 2) score += 120;
  if (/\b(phases?|steps?|process)\b/i.test(message) && /\b(phase|step|stage|process|implementation)\b/i.test(`${block.heading} ${block.text}`)) score += 35;
  const rawBlock = `${block.heading} ${block.text}`;
  const phaseListQuery = /\b(?:5|five)\b.*\b(?:implementation\s+)?phases?\b|\bimplementation\s+phases?\b/i.test(message);
  if (phaseListQuery) {
    const phaseItemCount = (rawBlock.match(/\bPhase\s+(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)\s*\([^)]+\)/gi) || []).length;
    if (/five\s*\(?5\)?\s*(?:implementation\s*)?phases|through the five\s*\(?5\)?\s*implementation phases|phase one\s*\([^)]+\).*phase two\s*\([^)]+\)/is.test(rawBlock)) score += 220;
    if (phaseItemCount >= 2) score += 260;
    if (/implementation phases|primary stages|pre-implementation|social preparation|resource mobilization|project monitoring/i.test(rawBlock)) score += 90;
    if (!/implementation phases|primary stages|phase one|pre-implementation|social preparation|resource mobilization/i.test(rawBlock)) score -= 120;
    if (/orientation to blgu|forms\/documents|person responsible|submitted to\/approved by/i.test(rawBlock) && !/five\s*\(?5\)?|primary stages/i.test(rawBlock)) score -= 80;
  }
  if (/\b(requirements?|eligibility|criteria|documents?)\b/i.test(message) && /\b(requirement|eligible|eligibility|criteria|document|shall|must|required)\b/i.test(`${block.heading} ${block.text}`)) score += 35;
  if (/\b(sustainability plan)\b/i.test(message) && !/sustainability plan/i.test(`${block.heading} ${block.text}`)) score -= 50;
  if (/\bimplementation process\b/i.test(message) && /sustainability plan/i.test(`${block.heading} ${block.text}`) && !/implementation process/i.test(`${block.heading} ${block.text}`)) score -= 45;
  return applyGeneralDocumentRankingBoosts({
    message,
    score,
    fileName: metadata?.original_file_name || source.file_name || source.fileName || "",
    folder: metadata?.folder || source.folder || "",
    sourceType,
    documentType: metadata?.document_type || "",
    heading: block.heading || "",
    sheetName: source.sheetName || source.sheet_name || metadata?.sub_folder || "",
    logContext: "document_chunk",
  });
}

function extractEvidenceList(text: string) {
  const raw = String(text || "").replace(/\r/g, "");
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const listLines = lines.filter((line) => /^(?:\d+[\).\:]|[a-z][\).\:]|[ivxlcdm]+[\).\:]|[-*])\s+/.test(line));
  if (listLines.length >= 2) return listLines.slice(0, 16);
  const compact = raw.replace(/\s+/g, " ").trim();
  const phaseItems = Array.from(compact.matchAll(/\b(Phase\s+(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)\s*\([^)]+\))/gi)).map((match) => match[1].trim());
  if (phaseItems.length >= 2) return phaseItems.slice(0, 16);
  const inline = Array.from(compact.matchAll(/(?:^|\s)(\d+[\).]\s+[^0-9]{3,180}?)(?=\s+\d+[\).]\s+|$)/g)).map((match) => match[1].trim());
  if (inline.length >= 2) return inline.slice(0, 16);
  return [];
}

function evidenceExcerpt(message: string, block: { heading: string; text: string }) {
  const list = isExactListQuestion(message) ? extractEvidenceList(block.text) : [];
  if (list.length) return list.join("\n");
  const terms = Array.from(queryTermSet(message));
  const sentences = block.text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter((part) => part.length > 20);
  const ranked = sentences.map((sentence, index) => {
    const normalized = normalizeName(sentence);
    const score = terms.reduce((sum, term) => sum + (normalized.includes(term) ? 1 : 0), 0);
    return { sentence, index, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  if (ranked.length) {
    const first = Math.max(0, ranked[0].index - 1);
    return sentences.slice(first, Math.min(sentences.length, first + 4)).join(" ").slice(0, 1800);
  }
  return block.text.replace(/\s+/g, " ").trim().slice(0, 1800);
}

function unsupportedEvidenceTerms(answer: string, evidence: string) {
  const evidenceText = normalizeName(evidence);
  return Array.from(queryTermSet(answer))
    .filter((term) => term.length > 4 && !evidenceText.includes(term))
    .filter((term) => !["source", "folder", "module", "document", "text", "structured", "data", "answer", "direct", "found", "multiple", "related", "sections", "keeping", "separate", "different", "parts", "matching", "choose", "recommended", "recommendation", "download", "score"].includes(term))
    .slice(0, 8);
}

function canonicalEvidenceSourceType(sourceType = "") {
  const normalized = String(sourceType || "").toUpperCase().replace(/[\s-]+/g, "_");
  if (/GUIDELINE|MC_?03|OMNIBUS/.test(normalized)) return "GUIDELINES";
  if (/OTHER/.test(normalized)) return "OTHER_DOCUMENTS";
  if (/PROPOSAL/.test(normalized)) return "PROPOSAL";
  if (/TEMPLATE|ANNEX|FORM/.test(normalized)) return "TEMPLATES";
  if (/IMAGE|VISION|OCR/.test(normalized)) return "IMAGE";
  return normalized || "UNKNOWN";
}

function composeEvidenceLockedAnswer(message: string, parsed: ParsedQuery, route: QueryRoute | null, sources: any[], sourceTypes: string[] = [], trace: any = null) {
  const wantedSourceTypes = sourceTypes.map(canonicalEvidenceSourceType);
  const relevantSources = wantedSourceTypes.length
    ? sources.filter((source: any) => wantedSourceTypes.includes(canonicalEvidenceSourceType(documentSourceType(source))))
    : sources;
  const checked = (relevantSources.length ? relevantSources : sources)
    .map((source: any) => sourceLabelForDocument(source))
    .slice(0, 8);
  if (trace) {
    trace.selectedSourceTypes = wantedSourceTypes.length ? wantedSourceTypes : ["document text"];
    trace.filesSearched = checked;
    trace.topRetrievedChunks = [];
    trace.finalSourceUsed = null;
    trace.evidenceVerificationPassed = false;
  }
  console.log(`[DOCUMENT_RETRIEVAL_START] ${JSON.stringify({
    userQuery: message,
    retrievalMode: route?.retrievalMode || "document",
    sourceTypeFilter: wantedSourceTypes,
    documentTypeFilter: parsed.docType,
    queryTermsUsed: Array.from(queryTermSet(message)),
    filesSearched: checked,
    candidateSourceCount: relevantSources.length,
  })}`);
  if (!relevantSources.length) {
    console.log(`[DOCUMENT_RETRIEVAL_RESULTS] ${JSON.stringify({ userQuery: message, chunksFound: 0, topChunks: [], reason: "no sources matched source_type filter" })}`);
    return [
      "**Direct Answer**",
      "I found related content, but not enough verified text to answer exactly.",
      "",
      "**Sources Checked**",
      ...(checked.length ? checked.map((item) => `- ${item}`) : sourceTypes.map((item) => `- ${item}`)),
      "",
      "**Data Quality Notes**",
      `- Routed source type(s): ${sourceTypes.join(", ") || "document text"}.`,
      "- No indexed document text was found for the routed source type(s).",
    ].join("\n");
  }

  const previousContextSource = normalizeName(trace?.previousContext?.source || "");
  const previousContextFile = normalizeName(String(trace?.previousContext?.source || "").split("/").pop() || "");
  const previousContextHeading = normalizeName(trace?.previousContext?.heading || "");
  const usePreviousContext = Boolean(trace?.previousContext && /\b(that|this|it|same|previous|above|mentioned|phase\s+(one|two|three|four|five|six|seven|eight|nine|ten))\b/i.test(message));
  const vectorCandidates = relevantSources.flatMap((source: any) => splitEvidenceBlocks(source.content_text || "").map((block) => {
    const label = sourceLabelForDocument(source);
    const contextHaystack = normalizeName(`${label} ${block.heading}`);
    const contextBoost = usePreviousContext && (
      (previousContextFile && contextHaystack.includes(previousContextFile)) ||
      (previousContextSource && contextHaystack.includes(previousContextSource)) ||
      (previousContextHeading && contextHaystack.includes(previousContextHeading))
    ) ? 90 : 0;
    return {
      source,
      label,
      sourceType: canonicalEvidenceSourceType(documentSourceType(source)),
      heading: block.heading,
      text: block.text,
      score: scoreEvidenceBlock(message, parsed, route, source, block) + contextBoost,
    };
  })).sort((a, b) => b.score - a.score);
  const vectorTopScore = vectorCandidates[0]?.score || 0;
  const weakVector = vectorTopScore < 85;
  const keywordFallback = weakVector ? keywordFallbackSearch(message, relevantSources, route) : { terms: [] as string[], results: [] as any[] };
  const candidates = mergeRetrievalCandidates(vectorCandidates, keywordFallback.results);
  console.log(`[DOCUMENT_RETRIEVAL_RESULTS] ${JSON.stringify({
    userQuery: message,
    vectorTopScore: Math.round(vectorTopScore),
    keywordFallbackUsed: weakVector,
    keywordTermsUsed: keywordFallback.terms,
    keywordResultCount: keywordFallback.results.length,
    chunksFound: candidates.length,
    topChunks: candidates.slice(0, 5).map((item) => ({
      fileName: item.label,
      sourceType: item.sourceType,
      heading: item.heading || "Unlabeled section",
      section: item.heading || "",
      score: Math.round(item.score),
      first300: item.text.replace(/\s+/g, " ").slice(0, 300),
    })),
  })}`);
  if (trace) {
    trace.vectorTopScore = Math.round(vectorTopScore);
    trace.keywordFallbackUsed = weakVector;
    trace.keywordTermsUsed = keywordFallback.terms;
    trace.keywordResultCount = keywordFallback.results.length;
    trace.topRetrievedChunks = candidates.slice(0, 5).map((item) => ({
      source: item.label,
      sourceType: item.sourceType,
      heading: item.heading || "Unlabeled section",
      score: Math.round(item.score),
      preview: item.text.replace(/\s+/g, " ").slice(0, 240),
      retrievalMethod: item.keywordFallback ? "keyword_fallback" : "vector_or_ranked",
    }));
  }
  const bestScore = candidates[0]?.score || 0;
  const strong = candidates.filter((item) => item.score >= Math.max(85, bestScore - 35)).slice(0, 3);
  if (!strong.length) {
    return [
      "**Direct Answer**",
      "I found related content, but not enough verified text to answer exactly.",
      "",
      "**Sources Checked**",
      ...(checked.length ? checked.map((item) => `- ${item}`) : ["- No source files available."]),
      "",
      "**Data Quality Notes**",
      "- Relevant source types/files were checked, but no section matched the important query terms strongly enough.",
    ].join("\n");
  }

  const evidenceItems = strong.map((item) => ({ ...item, excerpt: evidenceExcerpt(message, item) })).filter((item) => item.excerpt);
  if (!evidenceItems.length) {
    return [
      "**Direct Answer**",
      "I found related content, but not enough verified text to answer exactly.",
      "",
      "**Sources Checked**",
      ...strong.map((item) => `- ${item.label}`),
    ].join("\n");
  }

  const top = evidenceItems[0];
  const exactSectionQuestion = /\bphase\s+(one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*\([^)]+\))?\b|section\s+[a-z0-9.]+|annex\s+[a-z0-9.]+/i.test(message);
  const related = exactSectionQuestion ? [] : evidenceItems.filter((item, index) => index > 0 && (item.heading !== top.heading || item.label !== top.label));
  const directLines: string[] = ["**Direct Answer**"];
  if (related.length && Math.abs(top.score - related[0].score) <= 25) {
    directLines.push("I found multiple related sections. I am keeping them separate so the answer does not mix different parts of the documents.", "");
    [top, ...related].slice(0, 3).forEach((item, index) => {
      directLines.push(`${String.fromCharCode(65 + index)}. ${item.heading}`, item.excerpt, "");
    });
  } else {
    directLines.push(top.excerpt, "");
  }
  const citedEvidenceItems = related.length && Math.abs(top.score - related[0].score) <= 25 ? [top, ...related].slice(0, 3) : [top];
  const unsupported = unsupportedEvidenceTerms(directLines.join("\n"), citedEvidenceItems.map((item) => `${item.heading}\n${item.excerpt}`).join("\n"));
  if (trace) {
    trace.finalSourceUsed = {
      source: top.label,
      sourceType: top.sourceType,
      heading: top.heading || "Unlabeled section",
      score: Math.round(top.score),
    };
    trace.finalEvidenceText = citedEvidenceItems.map((item) => `${item.heading}\n${item.excerpt}`).join("\n\n");
    trace.evidenceVerificationPassed = unsupported.length === 0;
    trace.unsupportedTerms = unsupported;
  }
  if (unsupported.length) {
    directLines.push("**Not Verified**", `- Removed/avoided unsupported claims. Terms not found in evidence: ${unsupported.join(", ")}`, "");
  }
  directLines.push(
    "**Source Used**",
    ...citedEvidenceItems.map((item) => `- Source file: ${item.label}; folder/module: ${item.sourceType}; section/heading: ${item.heading || "Unlabeled section"}; evidence type: document text`),
    "",
    "**Data Quality Notes**",
    "- Answer is limited to the retrieved evidence above.",
    `- Routed source type(s): ${sourceTypes.join(", ") || "document text"}.`
  );
  return directLines.join("\n").trim();
}

async function answerFromRoutedDocumentText(message: string, parsed: ParsedQuery, route: QueryRoute, attachmentIds: string[] = [], trace: any = null) {
  const sourceTypes = route.retrievalMode === "rag_text"
    ? Array.from(new Set([...route.primarySourceTypes, ...route.secondarySourceTypes]))
    : route.confidence === "high"
    ? route.primarySourceTypes
    : Array.from(new Set([...route.primarySourceTypes, ...route.secondarySourceTypes]));
  if (!sourceTypes.length) return "";
  const sources = await loadDocumentTextSources(attachmentIds);
  return composeEvidenceLockedAnswer(message, parsed, route, sources, sourceTypes as string[], trace);
}

function composeLowConfidenceSourceAnswer(message: string, route: QueryRoute) {
  const rows = classifiedDocumentRows().map((file: any) => {
    const preferredTypes = preferredDocumentTypesForQuestion(message);
    const preferredSources = preferredSourceTypesForDocumentQuestion(message, preferredTypes);
    return { file, score: scoreClassifiedDocument(message, file, preferredTypes, preferredSources) };
  }).filter((item) => item.score > 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return [
    "**Direct Answer**",
    "I found possible sources but I am not confident. Here are the files I checked.",
    "",
    "**Files Checked**",
    ...(rows.length ? rows.map(({ file, score }) => `- ${file.source_type || canonicalSourceFolder(file.folder)}/${file.original_file_name} — score ${Math.round(score)} — ${file.document_type || "unclassified"}`) : ["- No classified document metadata matched the question."]),
    "",
    "**Retrieval Diagnostics**",
    `- detected intent: ${route.intent}`,
    `- confidence: ${route.confidence}`,
    `- retrieval mode: ${route.retrievalMode}`,
    `- reason: ${route.reason}`,
  ].join("\n");
}

function scoreDocumentSource(parsed: ParsedQuery, message: string, source: any) {
  const queryTerms = tokenizeForSearch(message);
  const sourceName = normalizeName(`${source.folder || ""} ${source.file_name || source.fileName || ""}`);
  const text = normalizeName(String(source.content_text || "").slice(0, 50000));
  let score = 0;
  if (sourceMatchesNamedTerms(sourceName, parsed.namedSourceTerms)) score += 60;
  if (parsed.docType === "proposal" && /(^|\s)proposals?(\s|$)/.test(sourceName)) score += 80;
  if (parsed.docType === "template" && /(^|\s)templates?(\s|$)/.test(sourceName)) score += 80;
  if ((parsed.docType === "guideline" || /mc\s*0?3|guidelines?|slp phases?|implementation phases?/i.test(message)) && /guidelines?|mc\s*0?3|mc03/.test(sourceName)) score += 90;
  for (const term of queryTerms) {
    if (sourceName.includes(term)) score += 10;
    if (text.includes(term)) score += 3;
  }
  if (queryTerms.length >= 2 && queryTerms.every((term) => text.includes(term) || sourceName.includes(term))) score += 45;
  for (const phrase of extractExactPhrases(message)) {
    if (sourceName.includes(phrase)) score += 40;
    if (text.includes(phrase)) score += 70;
  }
  for (const term of parsed.topicTerms) {
    if (sourceName.includes(term)) score += 10;
    if (text.includes(term)) score += 6;
  }
  if (parsed.docType !== "none") {
    for (const keyword of typeKeywordsFor(parsed.docType)) {
      if (sourceName.includes(keyword)) score += 10;
      if (text.includes(keyword)) score += 3;
    }
  }
  if (source.chat_attachment) score += 25;
  return score;
}

function documentTypeMatches(parsed: ParsedQuery, source: any) {
  if (!["proposal", "template", "guideline", "report"].includes(parsed.docType)) return true;
  const haystack = normalizeName(`${source.folder || ""} ${source.file_name || source.fileName || ""} ${String(source.content_text || "").slice(0, 4000)}`);
  return typeKeywordsFor(parsed.docType).some((keyword) => haystack.includes(normalizeName(keyword)));
}

function extractExactPhrases(message: string) {
  const phrases = Array.from(message.matchAll(/["“]([^"”]{3,120})["”]/g)).map((match) => match[1].trim());
  const definition = message.match(/\b(?:define|definition of|meaning of|what is|what are|explain)\s+([a-z0-9][a-z0-9\s\-]{2,80})(?:\?|$)/i)?.[1]?.trim();
  return [...phrases, ...(definition ? [definition] : [])].map((phrase) => normalizeName(phrase)).filter(Boolean);
}

function summarizeRelevantText(message: string, content: string) {
  const terms = tokenizeForSearch(message);
  const rawContent = String(content || "").replace(/\r/g, "");
  const paragraphs = rawContent.split(/\n{2,}|(?<=\.)\s+(?=[A-Z0-9])/).map((part) => part.replace(/\s+/g, " ").trim()).filter((part) => part.length > 30);
  const exactPhrases = extractExactPhrases(message);
  for (const phrase of exactPhrases) {
    const index = paragraphs.findIndex((paragraph) => normalizeName(paragraph).includes(phrase));
    if (index >= 0) return paragraphs.slice(Math.max(0, index - 1), Math.min(paragraphs.length, index + 3)).join("\n\n").slice(0, 2200);
  }
  const ranked = paragraphs.map((paragraph, index) => {
    const lower = paragraph.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
    return { paragraph, index, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = ranked.slice(0, 3).map((item) => item.paragraph);
  return selected.join("\n\n").slice(0, 1800);
}

async function answerFromDocumentText(message: string, parsed: ParsedQuery, attachmentIds: string[] = [], trace: any = null) {
  const sources = await loadDocumentTextSources(attachmentIds);
  if (!sources.length) {
    return [
      "**Direct Answer**",
      "I found related content, but not enough verified text to answer exactly.",
      "",
      "**Sources Checked**",
      "- No extracted PDF/DOCX/text content was available.",
      "",
      "**Data Quality Notes**",
      "- Upload or attach a document with extractable text.",
    ].join("\n");
  }
  const sourceTypes =
    parsed.docType === "proposal" ? ["PROPOSAL"]
    : parsed.docType === "template" ? ["TEMPLATES"]
    : parsed.docType === "guideline" || /mc\s*0?3|guidelines?|policy|process|definition|implementation/i.test(message) ? ["GUIDELINES", "OTHER_DOCUMENTS"]
    : parsed.docType === "report" ? ["OTHER_DOCUMENTS"]
    : [];
  const route = sourceTypes.length ? ({
    intent: "document_text",
    confidence: "high",
    confidenceScore: 0.9,
    primarySourceTypes: sourceTypes,
    secondarySourceTypes: [],
    retrievalMode: "rag_text",
    reason: "Evidence-locked document text retrieval.",
    extractedEntities: {},
    fallbackStrategy: "Do not guess when source text is weak.",
  } as QueryRoute) : null;
  return composeEvidenceLockedAnswer(message, parsed, route, sources, sourceTypes, trace);
}

async function composeFilesCheckedDebug(message: string, parsed: ParsedQuery, attachmentIds: string[] = []) {
  const requestedFields = Array.from(new Set([
    ...parsed.requiredFields,
    ...parsed.groupBy,
    ...(/participant|beneficiar|served|client/i.test(message) ? ["participant identity"] : []),
    ...(/association|slpa|group|organization|organisation/i.test(message) ? ["association name"] : []),
    ...(/project|enterprise|livelihood/i.test(message) ? ["project"] : []),
  ]));
  const docSources = await loadDocumentTextSources(attachmentIds);
  const docRows = docSources.map((source: any) => {
    const label = `${source.folder || "OTHER DOCUMENTS"}/${source.file_name || source.fileName || "document"}`;
    const score = scoreDocumentSource(parsed, message, source);
    const typeMatch = documentTypeMatches(parsed, source);
    const namedMatch = sourceMatchesNamedTerms(label, parsed.namedSourceTerms);
    const included = score > 0 && typeMatch && (!parsed.namedSourceTerms.length || namedMatch);
    return [label, "-", String(score), typeMatch ? "yes" : "no", included ? "included" : "excluded", included ? "Matched document text/name terms." : "Low score, wrong document type, or named source mismatch.", "document text"];
  }).sort((a, b) => Number(b[2]) - Number(a[2]));
  const sheetSources = (attachmentIds.length ? loadSheetSources({ attachmentIds }) : loadSheetSources()).map((source: any) => {
    const matchedColumns = requestedFields.map((field) => {
      if (field === "participant identity") {
        const directIdentity = source.headers.find((header: string) => detectColumnRole(header) === "participant_id" || detectColumnRole(header) === "full_name");
        if (directIdentity) return directIdentity;
        const first = source.headers.find((header: string) => detectColumnRole(header) === "first_name");
        const last = source.headers.find((header: string) => detectColumnRole(header) === "last_name");
        return first && last ? `${first} + ${last}` : "";
      }
      return findMatchingColumn(source.headers, field);
    }).filter(Boolean);
    const headerHits = matchedColumns.length;
    const topicHits = parsed.topicTerms.filter((term) => source.source.toLowerCase().includes(term) || source.headers.some((h: string) => h.toLowerCase().includes(term))).length;
    const named = sourceMatchesNamedTerms(source.source, parsed.namedSourceTerms);
    const score = (named ? 50 : 0) + headerHits * 18 + topicHits * 8;
    const included = attachmentIds.length || (!parsed.namedSourceTerms.length || named) && sourceHasRequiredFields(source.headers, requestedFields) && (score > 0 || (!requestedFields.length && !parsed.topicTerms.length));
    return [source.source, matchedColumns.join(", ") || "-", String(score), "-", included ? "included" : "excluded", included ? "Matched requested fields/topic or broad scan." : "No required columns/topic match or named source mismatch.", "spreadsheet rows"];
  }).sort((a, b) => Number(b[2]) - Number(a[2]));
  const rows = [...docRows, ...sheetSources].slice(0, 20);
  if (!rows.length) return noUploadedSourceAnswer(parsed, [], "No indexed document text or spreadsheet rows were available for debugging.");
  return ["**Direct Answer**", `I checked ${rows.length} source candidate(s) for this question and ranked them by source priority, document type, topic, named source, headers, and extracted text.`, "", "**Summary Table**", markdownTable(["Source", "Matched Columns", "Score", "Requested Type Match", "Decision", "Reason", "Source Kind"], rows), "", "**Chart/Graph**", "No chart was generated because this is a source-selection debug view, not a computed data result.", "", "**Source Used**", ...rows.slice(0, 8).map((row) => `- ${row[0]}`), "", "**Explanation**", `- Intent: ${parsed.intentType}`, "- Chat attachments are checked first when present.", "- Named files/folders are scored before global uploaded sources.", "- Document types are matched before topics for proposal/template/guideline/report questions.", "", "**Data Quality Notes**", "- This debug table is not an answer table; it explains source selection.", "", "**Suggested Next Questions**", "- Ask the question again with a named file", "- Attach the file to prioritize it", "- Ask for a count using a specific column"].join("\n");
}

function composeOcrStatusDebug(attachmentIds: string[] = []) {
  const params: any[] = [];
  const where = attachmentIds.length ? `WHERE v.document_id IN (${attachmentIds.map(() => "?").join(",")})` : "";
  if (attachmentIds.length) params.push(...attachmentIds);
  const rows = db.prepare(`SELECT d.file_name, v.page_number, v.image_number, v.extraction_method, v.model_used, v.text_length, v.error, v.confidence, v.created_at FROM vision_extractions v JOIN documents d ON d.id = v.document_id ${where} ORDER BY v.created_at DESC LIMIT 100`).all(...params);
  if (!rows.length) return ["**Direct Answer**", "No OCR/vision extraction records were found.", "", "**Source Used**", "- Local SQLite vision_extractions table", "", "**Data Quality Notes**", "- Upload an image or scanned PDF with image/document vision enabled to create OCR status records."].join("\n");
  return ["**Direct Answer**", `Found ${rows.length} OCR/vision extraction record(s).`, "", "**Relevant Table**", markdownTable(["File", "Page/Image", "Extraction method", "Model used", "Text length", "Errors", "Confidence"], rows.map((row: any) => [row.file_name, `${row.page_number || 1}/${row.image_number || 1}`, row.extraction_method || "-", row.model_used || "-", String(row.text_length || 0), row.error || "-", row.confidence == null ? "-" : String(row.confidence)])), "", "**Source Used**", "- Local SQLite vision_extractions table", "", "**Data Quality Notes**", "- Low confidence or errors mean the image may be blurry, low resolution, or not readable by the configured vision models."].join("\n");
}

function composeNoAnswer(direct: string, parsed: ParsedQuery, sources: string[], note: string) {
  return NO_RELEVANT_SOURCE_MESSAGE;
}

function validateAnswerBeforeSend(answer: string, parsed: ParsedQuery) {
  if (answer === NO_RELEVANT_SOURCE_MESSAGE) return answer;
  const notes: string[] = [];
  if (!answer.includes("**Direct Answer**")) notes.push("ERROR: Missing Direct Answer section.");
  if (!answer.includes("**Source Used**") && !/\nSource:\s+/i.test(answer)) notes.push("ERROR: Missing Source Used section.");
  if (parsed.intentType === "explanation/definition" && /\|\s*(Grant Code|Municipality|Payee)\s*\|/i.test(answer)) notes.push("WARNING: Detected spreadsheet table in explanation answer (should be document text only).");
  if (parsed.intentType === "compare/match" && /first-name-only/i.test(answer)) notes.push("WARNING: Name matching must use full names.");
  if (/\|\s*(Grant Code|Municipality|Payee)\s*\|/i.test(answer) && !/grant|municipality|payee/i.test(JSON.stringify(parsed.requiredFields))) notes.push("WARNING: Detected unrelated generic fallback records.");
  
  // Check for relevance: answer should address the specific question
  if (parsed.topicTerms.length > 0) {
    const answerText = answer.toLowerCase();
    const hasTopicMatch = parsed.topicTerms.some(term => answerText.includes(term.toLowerCase()));
    if (!hasTopicMatch && !answer.includes("could not find")) {
      notes.push("WARNING: Answer may not address the requested topic.");
    }
  }
  
  if (!notes.length) return answer;
  return `${answer}${notes.some(n => n.includes("ERROR")) ? "\n\n**VALIDATION WARNINGS**\n" + notes.map((note) => `- ${note}`).join("\n") : ""}`;
}

function isNoUploadedSourceAnswer(answer: string) {
  return answer.includes(NO_RELEVANT_SOURCE_MESSAGE)
    || answer.includes("I could not find this in the uploaded documents.")
    || answer.includes("I cannot answer this from the available uploaded data.")
    || answer.includes("I cannot answer this from the available data.");
}

function uploadedSheetSchemaSummary(limit = 20) {
  try {
    const rows = db.prepare(`
      SELECT d.file_name, d.folder, us.sheet_name, us.row_count, us.headers_json, us.detected_columns_json
      FROM uploaded_sheets us
      JOIN documents d ON d.id = us.document_id
      ORDER BY d.created_at DESC, us.sheet_name ASC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map((row) => {
      const headers = safeJsonArray(row.headers_json).map(String);
      const detected = safeJsonObject(row.detected_columns_json);
      return `${row.folder || "Unknown"}/${row.file_name} / ${row.sheet_name}: rows=${row.row_count || 0}; columns=${headers.join(", ")}; detected=${JSON.stringify(detected)}`;
    });
  } catch {
    return [];
  }
}

function sqliteSchemaForPrompt(tableNames = ["documents", "original_file_metadata", "uploaded_files", "uploaded_sheets", "sheet_columns", "sheet_rows", "analysis_history"]) {
  const rows: string[] = [];
  const dynamicRegistry = inspectDynamicSchema();
  for (const table of tableNames) {
    try {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
      if (columns.length) rows.push(`${table}: ${columns.map((column) => `${column.name} ${column.type || "TEXT"}`).join(", ")}`);
    } catch {}
  }
  const sheetSchemas = uploadedSheetSchemaSummary();
  const dynamicSchemas = dynamicRegistry.slice(0, 40).map((table) => `${table.tableName}: rows=${table.rowCount}; columns=${table.columns.map((column) => `${column.name} ${column.type || "TEXT"}`).join(", ")}`);
  console.log(`[SQLITE_SCHEMA_INJECTED] ${JSON.stringify({ tables: rows.map((row) => row.split(":")[0]), uploadedSheets: sheetSchemas.length, dynamicTables: dynamicSchemas.length })}`);
  return [...rows, dynamicSchemas.length ? "Dynamic Data Registry:" : "", ...dynamicSchemas, sheetSchemas.length ? "Uploaded Sheet Schemas:" : "", ...sheetSchemas].filter(Boolean).join("\n");
}

function chartRequested(message: string) {
  return /\b(chart|graph|plot|visuali[sz]ation|trend|comparison chart|dashboard-style|dashboard visual|bar chart|line chart|pie chart)\b/i.test(message);
}

function analyticsRequested(message: string) {
  return /\b(how many|count|total|by municipality|by barangay|top\b|most\b|least\b|operational|closed|with\s+gur|without\s+gur|with\/without\s+gur|training|chart|graph|compare|breakdown|rank|ranking)\b/i.test(message);
}

function firstMarkdownTable(answer: string) {
  const lines = answer.split(/\r?\n/);
  for (let i = 0; i < lines.length - 2; i++) {
    if (!/^\|.*\|$/.test(lines[i]) || !/^\|[\s:\-|]+\|$/.test(lines[i + 1])) continue;
    const headers = lines[i].split("|").slice(1, -1).map((cell) => cell.trim());
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length && /^\|.*\|$/.test(lines[j]); j++) {
      rows.push(lines[j].split("|").slice(1, -1).map((cell) => cell.trim()));
    }
    if (headers.length >= 2 && rows.length) return { headers, rows };
  }
  return null;
}

function ensureChartOutput(answer: string, message: string) {
  if (!chartRequested(message) || /```python/i.test(answer)) return answer;
  console.log(`[CHART_OUTPUT_REQUESTED] ${JSON.stringify({ userQuery: message })}`);
  const cleanedAnswer = answer
    .replace(/\n?```slp-chart[\s\S]*?```\n?/g, "\n")
    .replace(/\*\*Chart\/Graph\*\*\s*(?=\n\*\*Source Used\*\*)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const table = firstMarkdownTable(cleanedAnswer);
  if (!table) {
    return `${cleanedAnswer}\n\n**Chart Data**\nI cannot generate chart code because no verified table data was available.`;
  }
  const rows = table.rows
    .map((row) => ({ label: row[0], value: Number(String(row[1] || "").replace(/[^0-9.-]/g, "")) }))
    .filter((row) => row.label && Number.isFinite(row.value));
  if (!rows.length) return `${cleanedAnswer}\n\n**Chart Data**\nI cannot generate chart code because the verified table does not contain numeric values.`;
  const labels = JSON.stringify(rows.map((row) => row.label));
  const values = JSON.stringify(rows.map((row) => row.value));
  return [
    cleanedAnswer,
    "",
    "**Chart Code**",
    "```python",
    "import matplotlib.pyplot as plt",
    `labels = ${labels}`,
    `values = ${values}`,
    "plt.figure(figsize=(10, 6))",
    "plt.bar(labels, values)",
    `plt.title(${JSON.stringify(message)})`,
    `plt.ylabel(${JSON.stringify(table.headers[1] || "Value")})`,
    "plt.xticks(rotation=45, ha='right')",
    "plt.tight_layout()",
    "plt.show()",
    "```",
  ].join("\n");
}

function fallbackSuggestions(message: string, trace: any = null) {
  const suggestions = new Set<string>();
  const sourceTypes = trace?.selectedSourceTypes?.length ? trace.selectedSourceTypes : [];
  const files = (trace?.filesSearched || []).map((file: string) => file.replace(/\s*\(\d+\)$/, ""));
  const sheetSchemas = uploadedSheetSchemaSummary(6);
  const firstSheet = sheetSchemas[0] || "";
  const firstFile = firstSheet.split(":")[0] || files[0] || "";
  const firstColumns = firstSheet.match(/columns=([^;]+)/)?.[1]?.split(",").map((item) => item.trim()).filter(Boolean) || [];
  const uploadedFiles = originalFileRows().slice(0, 300);
  const folders = new Set(uploadedFiles.map((file: any) => String(file.source_type || canonicalSourceFolder(file.folder) || "").toUpperCase()).filter(Boolean));
  const fileNames = uploadedFiles.map((file: any) => String(file.original_file_name || "")).filter(Boolean);
  if (folders.has("TEMPLATES") || fileNames.some((name) => /template|annex|form|tracker/i.test(name))) suggestions.add("List all templates in the TEMPLATES folder");
  if (folders.has("GUIDELINES") || fileNames.some((name) => /guideline|memorandum|policy|moa|agreement/i.test(name))) suggestions.add("Show guidelines from the GUIDELINES folder");
  if (folders.has("PROPOSAL") || folders.has("PROPOSALS") || fileNames.some((name) => /proposal/i.test(name))) suggestions.add("List available project proposal files");
  if (firstFile && firstColumns.includes("Municipality")) suggestions.add(`How many records by Municipality in ${firstFile}?`);
  if (firstFile && firstColumns[0]) suggestions.add(`Show top values by ${firstColumns[0]} in ${firstFile}`);
  if (sourceTypes.includes("GUIDELINES")) suggestions.add("What are the SLP eligibility requirements from the guidelines?");
  if (sourceTypes.includes("TEMPLATES")) suggestions.add("What template should I use for a project proposal attachment?");
  if (/participant|municipality|count|chart/i.test(message)) suggestions.add("How many participants are in Baler?");
  suggestions.add("Count participants by municipality from Personal Module");
  suggestions.add("Show files checked for this question");
  suggestions.add("What source types are available?");
  const finalSuggestions = Array.from(suggestions).slice(0, 3);
  console.log(`[DYNAMIC_FALLBACK_USED] ${JSON.stringify({
    userQuery: message,
    suggestions: finalSuggestions,
    filesScanned: uploadedFiles.length,
    folders: Array.from(folders).slice(0, 12),
  })}`);
  return finalSuggestions;
}

function composeVerifiedFallback(message: string, trace: any = null) {
  const suggestions = fallbackSuggestions(message, trace);
  console.log(`[FALLBACK_SUGGESTIONS_USED] ${JSON.stringify({
    userQuery: message,
    whyFallbackTriggered: trace?.fallbackReason || trace?.verificationFailReason || trace?.reason || "answer could not be verified from available evidence",
    suggestions,
    generatedFrom: {
      tables: sqliteTableSchemasForDebug(["uploaded_sheets", "sheet_columns", "sheet_rows"]),
      files: trace?.filesSearched || [],
      selectedSourceTypes: trace?.selectedSourceTypes || [],
    },
  })}`);
  return [
    "**Direct Answer**",
    "I cannot answer this from the available data.",
    "",
    "**Suggested Next Questions**",
    ...suggestions.map((question) => `- ${question}`),
  ].join("\n");
}

function extractUserProvidedTextForEditing(message: string) {
  const explicit = message.match(/(?:rewrite|revise|edit|proofread|improve|polish|grammar check|summarize this|make this)\b[\s\S]*?(?:text|paragraph|sentence|message|draft)?\s*[:\-]\s*([\s\S]{10,})/i);
  if (explicit) return explicit[1].trim();
  const quoted = message.match(/["“]([^"”]{10,})["”]/);
  if (quoted && /\b(rewrite|revise|edit|proofread|improve|polish|grammar|summarize this|make this)\b/i.test(message)) return quoted[1].trim();
  return "";
}

function isWritingEditingRequest(message: string) {
  return /\b(rewrite|revise|edit|proofread|improve|polish|grammar check|correct grammar|summarize this|make this more|turn this into|format this)\b/i.test(message)
    && Boolean(extractUserProvidedTextForEditing(message));
}

function visionPrompt(pageLabel = "image") {
  return `Read this ${pageLabel} carefully. Extract only what is visible. Include readable text, table rows, labels, forms, names, dates, amounts, addresses, IDs, and key fields when present. If a part is unclear, write exactly: "I could not read this part clearly from the image." Do not invent missing data. End with a short confidence note: Confidence: high, medium, or low.`;
}

function estimateVisionConfidence(text: string) {
  if (/confidence:\s*high/i.test(text)) return 0.9;
  if (/confidence:\s*medium/i.test(text)) return 0.65;
  if (/confidence:\s*low|could not read|unclear|blurry/i.test(text)) return 0.35;
  return text.trim().length > 80 ? 0.6 : 0.3;
}

function insertVisionExtraction(input: { documentId: string; fileName: string; pageNumber?: number; imageNumber?: number; method: string; modelUsed?: string; text?: string; confidence?: number; error?: string }) {
  const text = input.text || "";
  db.prepare("INSERT INTO vision_extractions (id, document_id, file_name, page_number, image_number, extraction_method, model_used, text, text_length, confidence, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(randomId("vision"), input.documentId, input.fileName, input.pageNumber || 1, input.imageNumber || 1, input.method, input.modelUsed || "", text, text.length, input.confidence ?? null, input.error || null, new Date().toISOString());
}

async function extractImageWithVision(buffer: Buffer, documentId: string, fileName: string, options: { pageNumber?: number; imageNumber?: number; mimeType?: string; method?: string } = {}) {
  const settings = getModelSettings();
  if (!settings.enableImageDocumentVision) {
    insertVisionExtraction({ documentId, fileName, pageNumber: options.pageNumber, imageNumber: options.imageNumber, method: "vision disabled", error: "Image/document vision is disabled in admin settings." });
    return "[Image/document vision is disabled in admin settings.]";
  }
  const imageBase64 = buffer.toString("base64");
  const primary = settings.roles.vision.model || "openai/gpt-4o";
  const prompt = visionPrompt(options.pageNumber ? `PDF page ${options.pageNumber}` : "image");
  try {
    const text = await generateVisionText(primary, imageBase64, prompt);
    insertVisionExtraction({ documentId, fileName, pageNumber: options.pageNumber, imageNumber: options.imageNumber, method: options.method || "github models vision", modelUsed: primary, text, confidence: estimateVisionConfidence(text) });
    return text;
  } catch (primaryError: any) {
    const error = `GitHub vision model ${primary} failed: ${primaryError.message || primaryError}`;
    insertVisionExtraction({ documentId, fileName, pageNumber: options.pageNumber, imageNumber: options.imageNumber, method: options.method || "github models vision", modelUsed: primary, text: "", confidence: 0, error });
    return `[Vision extraction failed. ${error}]`;
  }
}

async function answerWritingEditingRequest(message: string) {
  const providedText = extractUserProvidedTextForEditing(message);
  const prompt = `You may only rewrite, edit, format, or summarize the user-provided text below. Do not add outside facts or claims. Preserve the meaning unless the user explicitly asks for a different tone or format.\n\nUSER REQUEST:\n${message}\n\nUSER-PROVIDED TEXT:\n${providedText}`;
  const rewritten = (await generateChat(prompt)).trim();
  return ["**Direct Answer**", rewritten, "", "**Source Used**", "- User-provided text in the current message", "", "**How I calculated/found it**", "- This was a writing/editing request, so no uploaded factual source was required.", "- GitHub Models was used only to transform the text provided by the user.", "", "**Data Quality Notes**", "- No web search or general factual knowledge was used."].join("\n");
}

async function readLocalDocumentCache(): Promise<any[]> { try { return JSON.parse(await fs.readFile(DOCUMENT_CACHE_FILE, "utf-8")) || []; } catch { return []; } }
async function writeLocalDocumentCache(rows: any[]) { await fs.mkdir(UPLOAD_ROOT, { recursive: true }); await fs.writeFile(DOCUMENT_CACHE_FILE, JSON.stringify(rows, null, 2), "utf-8"); }
async function upsertLocalDocumentCache(document: any) { const rows = await readLocalDocumentCache(); const index = rows.findIndex((r: any) => r.id === document.id); if (index >= 0) rows[index] = { ...rows[index], ...document }; else rows.unshift(document); await writeLocalDocumentCache(rows.slice(0, 500)); }
async function removeLocalDocumentCache(documentId: string) {
  const rows = await readLocalDocumentCache();
  const kept = rows.filter((row: any) => row?.id !== documentId);
  if (kept.length !== rows.length) await writeLocalDocumentCache(kept);
  return rows.find((row: any) => row?.id === documentId) || null;
}
async function deleteLocalUploadFile(fileUrl = "") {
  if (!fileUrl.startsWith("local-upload://")) return;
  const relative = fileUrl.replace("local-upload://", "");
  const target = path.resolve(UPLOAD_ROOT, relative);
  if (!target.startsWith(UPLOAD_ROOT + path.sep)) return;
  try { await fs.unlink(target); } catch {}
}

function isSupportedUpload(fileName = "", fileType = "") {
  return /pdf/i.test(fileType) || /\.pdf$/i.test(fileName)
    || /word|docx/i.test(fileType) || /\.docx$/i.test(fileName)
    || /sheet|excel|csv/i.test(fileType) || /\.(xlsx?|csv)$/i.test(fileName)
    || /image/i.test(fileType) || /\.(png|jpe?g|webp)$/i.test(fileName)
    || /text\/plain/i.test(fileType) || /\.txt$/i.test(fileName);
}

async function readDocumentBuffer(fileUrl: string) {
  if (fileUrl?.startsWith("local-upload://")) {
    const relative = fileUrl.replace("local-upload://", "");
    const target = path.resolve(UPLOAD_ROOT, relative);
    if (!target.startsWith(UPLOAD_ROOT + path.sep)) throw new Error("Invalid local upload path.");
    const buffer = await fs.readFile(target);
    return { buffer, type: "" };
  }
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Could not read document: ${response.status}`);
  return { buffer: Buffer.from(await response.arrayBuffer()), type: response.headers.get("content-type") || "" };
}

// =========================
// LOCAL MODEL FLAGS
// =========================
const DEFAULT_LOCAL_MODEL_FLAGS = { enableImageDocumentVision: true, timeoutMs: Number(process.env.GITHUB_MODELS_TIMEOUT_MS || 90000), enableVerificationForComplexOnly: true };
function getLocalModelFlags() { const row = db.prepare("SELECT value_json FROM setting_values WHERE id = 'modelFlags'").get(); if (!row?.value_json) return DEFAULT_LOCAL_MODEL_FLAGS; try { return { ...DEFAULT_LOCAL_MODEL_FLAGS, ...JSON.parse(row.value_json) }; } catch { return DEFAULT_LOCAL_MODEL_FLAGS; } }

function getAnswerModel() { return getModelSettings().roles.main.model || "openai/gpt-4.1"; }

async function verifyAnswerRelevance(input: {
  userQuestion: string;
  answer: string;
  finalEvidenceText?: string;
  retrievedChunks?: any[];
  sqliteResult?: any;
  answerMode: "document" | "sqlite" | "mixed" | "fallback";
  selectedSourceInfo?: any;
  parsed: ParsedQuery;
}): Promise<boolean> {
  try {
    const evidenceText = [
      input.finalEvidenceText || "",
      ...(input.retrievedChunks || []).map((chunk: any) => `${chunk.heading || ""}\n${chunk.preview || chunk.text || ""}`),
    ].join("\n").trim();
    const sqliteText = typeof input.sqliteResult === "string" ? input.sqliteResult : JSON.stringify(input.sqliteResult || {});
    const supportText = input.answerMode === "sqlite" ? sqliteText : evidenceText;
    if (input.answerMode === "document" && !evidenceText) {
      console.log(`[EVIDENCE_VERIFICATION_USED] ${JSON.stringify({ answerMode: input.answerMode, evidencePassedToVerifier: false, evidenceLength: 0, passed: false, result: "fail", failReason: "missing document evidence" })}`);
      return false;
    }
    if (input.answerMode === "sqlite" && (!sqliteText || sqliteText === "{}")) {
      console.log(`[EVIDENCE_VERIFICATION_USED] ${JSON.stringify({ answerMode: input.answerMode, evidencePassedToVerifier: false, evidenceLength: 0, passed: false, result: "fail", failReason: "missing sqlite result" })}`);
      return false;
    }
    const unsupported = unsupportedEvidenceTerms(input.answer, supportText);
    if (unsupported.length && !/cannot answer|could not find|not enough verified/i.test(input.answer)) {
      console.log(`[EVIDENCE_VERIFICATION_USED] ${JSON.stringify({ answerMode: input.answerMode, evidencePassedToVerifier: Boolean(supportText), evidenceLength: supportText.length, passed: false, result: "fail", failReason: "unsupported terms", unsupported })}`);
      return false;
    }
    if (input.selectedSourceInfo?.answerMode === "classified_document_metadata" && supportText) {
      console.log(`[EVIDENCE_VERIFICATION_USED] ${JSON.stringify({ answerMode: input.answerMode, evidencePassedToVerifier: true, evidenceLength: supportText.length, passed: true, result: "pass", reason: "classified document metadata answer is supported by retrieved file metadata", selectedSourceInfo: input.selectedSourceInfo || null })}`);
      return true;
    }
    const prompt = [
      "You are an evidence verifier. Answer with only PASS or FAIL.",
      "PASS only if the answer directly addresses the question and every substantive claim is supported by the provided evidence or SQLite result.",
      "FAIL if the answer contains unsupported claims, guessed counts, mixed unrelated document sections, or a source type that does not match the query intent.",
      "FAIL if no evidence/result is provided.",
      "",
      `Answer mode: ${input.answerMode}`,
      `Selected source info: ${JSON.stringify(input.selectedSourceInfo || {})}`,
      `User question: "${input.userQuestion}"`,
      `Parsed intent/doc type: ${input.parsed.intentType}/${input.parsed.docType}`,
      `Evidence or SQLite result: "${supportText.slice(0, 2500)}"`,
      `Answer to verify: "${input.answer.slice(0, 1800)}"`,
    ].join("\\n");
    const result = await callModel("verification", [{ role: "user", content: prompt }], { temperature: 0.1, maxTokens: 32, timeoutMs: 30000 });
    const passed = result.content.toLowerCase().includes("pass");
    console.log(`[EVIDENCE_VERIFICATION_USED] ${JSON.stringify({ answerMode: input.answerMode, evidencePassedToVerifier: Boolean(supportText), evidenceLength: supportText.length, passed, result: passed ? "pass" : "fail", failReason: passed ? "" : result.content.slice(0, 200), selectedSourceInfo: input.selectedSourceInfo || null })}`);
    return passed;
  } catch (e) {
    const supportText = String(input.finalEvidenceText || input.sqliteResult || "");
    const passed = Boolean(supportText && !unsupportedEvidenceTerms(input.answer, supportText).length);
    console.log(`[EVIDENCE_VERIFICATION_USED] ${JSON.stringify({ answerMode: input.answerMode, evidencePassedToVerifier: Boolean(supportText), evidenceLength: supportText.length, passed, result: passed ? "pass" : "fail", failReason: passed ? "" : `verifier exception: ${String((e as any)?.message || e).slice(0, 200)}`, fallback: true })}`);
    return passed;
  }
}

// =========================
// AUTH ROUTES
// =========================
app.get("/api/health", (_req, res) => {
  let databaseConnected = false;
  try {
    db.prepare("SELECT 1 AS ok").get();
    databaseConnected = true;
  } catch {
    databaseConnected = false;
  }
  res.json({
    ok: true,
    service: "api",
    api: "running",
    database: databaseConnected ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
    port: PORT,
  });
});

app.get("/api/proposals", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM proposal_projects ORDER BY updated_at DESC").all() as any[];
    const q = String(req.query.search || "").toLowerCase();
    const filtered = rows.map((row) => proposalFromRow(row, false)).filter((row: any) => {
      const haystack = [row.title, row.enterprise_type, row.municipality, row.barangay, row.project_type, row.pat_result, row.status].join(" ").toLowerCase();
      return !q || haystack.includes(q);
    });
    res.json({ proposals: filtered });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.post("/api/proposals", (req, res) => {
  try {
    console.log("PROPOSAL_CREATE_NEW");
    res.status(201).json({ proposal: writeProposal(req.body || {}) });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposals/templates", async (_req, res) => {
  try {
    res.json({ templates: await detectProposalTemplates() });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposals/catalog/raw-materials", (_req, res) => {
  try {
    res.json({ items: db.prepare("SELECT * FROM proposal_catalog_items WHERE catalogType = 'Raw Material' ORDER BY isActive DESC, itemName COLLATE NOCASE").all() });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposals/catalog/tools-equipment", (_req, res) => {
  try {
    res.json({ items: db.prepare("SELECT * FROM proposal_catalog_items WHERE catalogType = 'Tool/Equipment' ORDER BY isActive DESC, itemName COLLATE NOCASE").all() });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.post("/api/proposals/catalog", (req, res) => {
  try {
    res.status(201).json({ item: saveProposalBuilderCatalogItem(req.body || {}) });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.put("/api/proposals/catalog/:itemId", (req, res) => {
  try {
    const existing = db.prepare("SELECT * FROM proposal_catalog_items WHERE itemId = ?").get(req.params.itemId);
    if (!existing) return res.status(404).json({ ok: false, error: "Catalog item not found." });
    res.json({ item: saveProposalBuilderCatalogItem({ ...(existing as any), ...(req.body || {}) }, req.params.itemId) });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.delete("/api/proposals/catalog/:itemId", (req, res) => {
  try {
    const now = new Date().toISOString();
    db.prepare("UPDATE proposal_catalog_items SET isActive = 0, updatedAt = ? WHERE itemId = ?").run(now, req.params.itemId);
    res.json({ success: true });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposals/inventory", (req, res) => {
  try {
    const rows = (db.prepare("SELECT * FROM proposal_inventory WHERE status != 'Deleted' ORDER BY updatedAt DESC").all() as any[])
      .map(proposalInventoryRow)
      .filter((row: any) => {
        const q = String(req.query.search || "").toLowerCase();
        const template = String(req.query.templateType || "");
        const municipality = String(req.query.municipality || "").toLowerCase();
        const status = String(req.query.status || "");
        const haystack = [row.proposalId, row.title, row.templateType, row.municipality, row.barangay, row.projectName, row.enterpriseType, row.status].join(" ").toLowerCase();
        return (!q || haystack.includes(q)) && (!template || row.templateType === template) && (!municipality || String(row.municipality || "").toLowerCase().includes(municipality)) && (!status || row.status === status);
      });
    res.json({ proposals: rows });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposals/inventory/:proposalId", (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM proposal_inventory WHERE proposalId = ?").get(req.params.proposalId) as any;
    if (!row) return res.status(404).json({ ok: false, error: "Proposal inventory record not found." });
    const drafts = (db.prepare("SELECT * FROM proposal_drafts WHERE proposalId = ? ORDER BY createdAt DESC").all(req.params.proposalId) as any[]).map(draftRow);
    const lineItems = db.prepare("SELECT * FROM proposal_line_items WHERE proposalId = ? ORDER BY sectionKey, itemName").all(req.params.proposalId);
    res.json({ proposal: proposalInventoryRow(row), drafts, lineItems });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.delete("/api/proposals/inventory/:proposalId", async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM proposal_inventory WHERE proposalId = ?").get(req.params.proposalId) as any;
    if (!row) return res.status(404).json({ ok: false, error: "Proposal inventory record not found." });
    const profile = requesterProfile(req);
    if (!canDeleteProposalRecord(row, profile)) return res.status(403).json({ ok: false, error: "You do not have permission to delete this proposal." });
    const drafts = db.prepare("SELECT * FROM proposal_drafts WHERE proposalId = ?").all(req.params.proposalId) as any[];
    const generatedDocs = db.prepare("SELECT * FROM proposal_generated_documents WHERE proposal_id = ?").all(req.params.proposalId) as any[];
    const filePaths = new Set<string>();
    for (const filePath of [row.docxPath, row.previewPath]) if (filePath) filePaths.add(filePath);
    for (const draft of drafts) for (const filePath of [draft.docxPath, draft.previewPath]) if (filePath) filePaths.add(filePath);
    for (const generated of generatedDocs) if (generated.file_path) filePaths.add(generated.file_path);
    db.transaction(() => {
      db.prepare("DELETE FROM proposal_line_items WHERE proposalId = ?").run(req.params.proposalId);
      db.prepare("DELETE FROM proposal_drafts WHERE proposalId = ?").run(req.params.proposalId);
      db.prepare("DELETE FROM proposal_generated_documents WHERE proposal_id = ?").run(req.params.proposalId);
      db.prepare("DELETE FROM proposal_inventory WHERE proposalId = ?").run(req.params.proposalId);
    })();
    for (const filePath of filePaths) await unlinkGeneratedProposalFile(filePath, "file");
    console.log("PROPOSAL_INVENTORY_DELETED", { proposalId: req.params.proposalId, userId: profile?.id || "" });
    res.json({ success: true });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.post("/api/proposals/generate", async (req, res) => {
  try {
    res.status(201).json(await generateProposalBuilderDraft(req.body || {}));
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposals/drafts/:draftId", (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM proposal_drafts WHERE draftId = ?").get(req.params.draftId) as any;
    if (!row || row.status === "Deleted") return res.status(404).json({ ok: false, error: "Proposal draft not found." });
    res.json({ draft: draftRow(row) });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposals/drafts/:draftId/download", (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM proposal_drafts WHERE draftId = ?").get(req.params.draftId) as any;
    if (!row || row.status === "Deleted") return res.status(404).json({ ok: false, error: "Proposal draft not found." });
    if (!fsSync.existsSync(row.docxPath)) return res.status(410).json({ ok: false, error: "Generated DOCX is missing." });
    const now = new Date().toISOString();
    db.prepare("UPDATE proposal_drafts SET status = 'Downloaded', updatedAt = ? WHERE draftId = ?").run(now, req.params.draftId);
    db.prepare("UPDATE proposal_inventory SET status = 'Downloaded', updatedAt = ? WHERE proposalId = ?").run(now, row.proposalId);
    console.log("PROPOSAL_INVENTORY_UPDATED", { proposalId: row.proposalId, status: "Downloaded" });
    res.download(row.docxPath, row.fileName);
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposals/drafts/:draftId/preview", (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM proposal_drafts WHERE draftId = ?").get(req.params.draftId) as any;
    if (!row || row.status === "Deleted") return res.status(404).json({ ok: false, error: "Proposal draft not found." });
    if (!fsSync.existsSync(row.docxPath)) return res.status(410).json({ ok: false, error: "Generated DOCX is missing." });
    console.log("[PROPOSAL_PREVIEW_SOURCE]", { proposalId: row.proposalId, previewSourcePath: row.docxPath });
    res.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(fsSync.readFileSync(row.docxPath));
  } catch (err: any) { proposalRouteError(res, err); }
});

app.delete("/api/proposals/drafts/:draftId", async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM proposal_drafts WHERE draftId = ?").get(req.params.draftId) as any;
    if (!row) return res.status(404).json({ ok: false, error: "Proposal draft not found." });
    try { if (row.docxPath && fsSync.existsSync(row.docxPath)) await fs.unlink(row.docxPath); } catch {}
    try { if (row.previewPath && fsSync.existsSync(row.previewPath)) await fs.unlink(row.previewPath); } catch {}
    const now = new Date().toISOString();
    db.prepare("UPDATE proposal_drafts SET status = 'Deleted', updatedAt = ? WHERE draftId = ?").run(now, req.params.draftId);
    db.prepare("UPDATE proposal_inventory SET status = 'Deleted', updatedAt = ? WHERE proposalId = ?").run(now, row.proposalId);
    console.log("PROPOSAL_INVENTORY_UPDATED", { proposalId: row.proposalId, status: "Deleted" });
    res.json({ success: true });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposals/:id/docx", (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM proposal_drafts WHERE proposalId = ? AND status != 'Deleted' ORDER BY createdAt DESC LIMIT 1").get(req.params.id) as any;
    if (!row) return res.status(404).json({ ok: false, error: "Generated proposal DOCX not found." });
    if (!fsSync.existsSync(row.docxPath)) return res.status(410).json({ ok: false, error: "Generated DOCX is missing." });
    res.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document").send(fsSync.readFileSync(row.docxPath));
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposals/:id", (req, res) => {
  try {
    const row = fetchProposalOr404(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: "Proposal not found." });
    res.json({ proposal: proposalFromRow(row, true) });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.put("/api/proposals/:id", (req, res) => {
  try {
    console.log("PROPOSAL_SAVE_DRAFT");
    res.json({ proposal: writeProposal(req.body || {}, req.params.id) });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.delete("/api/proposals/:id", (req, res) => {
  try {
    const id = req.params.id;
    const row = fetchProposalOr404(id);
    if (!row) return res.status(404).json({ ok: false, error: "Proposal not found." });
    db.transaction(() => {
      for (const table of ["proposal_members", "proposal_raw_materials", "proposal_workers", "proposal_tools_equipment", "proposal_other_expenses", "proposal_sales", "proposal_pat_indicators", "proposal_scf_schedule", "proposal_generated_documents"]) {
        db.prepare(`DELETE FROM ${table} WHERE proposal_id = ?`).run(id);
      }
      db.prepare("DELETE FROM proposal_projects WHERE id = ?").run(id);
    })();
    res.json({ success: true });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.post("/api/proposals/:id/duplicate", (req, res) => {
  try {
    const proposal = duplicateProposal(req.params.id, false);
    if (!proposal) return res.status(404).json({ ok: false, error: "Proposal not found." });
    res.status(201).json({ proposal });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.post("/api/proposals/:id/use-template", (req, res) => {
  try {
    console.log("PROPOSAL_USE_TEMPLATE");
    const proposal = duplicateProposal(req.params.id, true);
    if (!proposal) return res.status(404).json({ ok: false, error: "Proposal not found." });
    res.status(201).json({ proposal });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.post("/api/proposals/:id/generate/maf", async (req, res) => {
  try { res.json({ document: await generateProposalDocx(req.params.id, "maf") }); } catch (err: any) { proposalRouteError(res, err); }
});

app.post("/api/proposals/:id/generate/mungkahing-proyekto", async (req, res) => {
  try { res.json({ document: await generateProposalDocx(req.params.id, "mungkahing-proyekto") }); } catch (err: any) { proposalRouteError(res, err); }
});

app.post("/api/proposals/:id/generate/all", async (req, res) => {
  try {
    const documents = [];
    for (const docType of ["maf", "mungkahing-proyekto"] as ProposalDocType[]) documents.push(await generateProposalDocx(req.params.id, docType));
    res.json({ documents });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposals/generated/:docId/download", async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM proposal_generated_documents WHERE id = ?").get(req.params.docId) as any;
    if (!row) return res.status(404).json({ ok: false, error: "Generated document not found." });
    if (!fsSync.existsSync(row.file_path)) return res.status(410).json({ ok: false, error: "Generated document file is missing." });
    res.download(row.file_path, row.file_name);
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposal-catalogs", (_req, res) => {
  try {
    res.json({
      products: db.prepare("SELECT * FROM catalog_products ORDER BY product_name").all(),
      raw_materials: db.prepare("SELECT * FROM catalog_raw_materials ORDER BY raw_material_name").all(),
      tools_equipment: db.prepare("SELECT * FROM catalog_tools_equipment ORDER BY tool_equipment_name").all(),
      labor_roles: db.prepare("SELECT * FROM catalog_labor_roles ORDER BY role_worker_type").all(),
      other_expenses: db.prepare("SELECT * FROM catalog_other_expenses ORDER BY expense_name").all(),
    });
  } catch (err: any) { proposalRouteError(res, err); }
});

const catalogTableMap: Record<string, { table: string; nameField: string; fields: string[] }> = {
  products: { table: "catalog_products", nameField: "product_name", fields: ["product_name", "enterprise_type", "unit", "suggested_selling_price", "notes"] },
  raw_materials: { table: "catalog_raw_materials", nameField: "raw_material_name", fields: ["raw_material_name", "enterprise_type", "unit", "suggested_unit_price", "notes"] },
  tools_equipment: { table: "catalog_tools_equipment", nameField: "tool_equipment_name", fields: ["tool_equipment_name", "enterprise_type", "unit", "suggested_unit_price", "suggested_life_span_days", "notes"] },
  labor_roles: { table: "catalog_labor_roles", nameField: "role_worker_type", fields: ["role_worker_type", "enterprise_type", "specific_task", "suggested_daily_wage", "notes"] },
  other_expenses: { table: "catalog_other_expenses", nameField: "expense_name", fields: ["expense_name", "enterprise_type", "frequency_of_payment", "suggested_cost", "notes"] },
};

app.post("/api/proposal-catalogs", (req, res) => {
  try {
    const type = String(req.body?.type || "");
    const def = catalogTableMap[type];
    if (!def) return res.status(400).json({ ok: false, error: "Invalid catalog type." });
    const id = crypto.randomUUID();
    const values = def.fields.map((field) => req.body[field] ?? "");
    db.prepare(`INSERT INTO ${def.table} (id, ${def.fields.join(", ")}) VALUES (?, ${def.fields.map(() => "?").join(", ")})`).run(id, ...values);
    res.status(201).json({ item: db.prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(id) });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.put("/api/proposal-catalogs/:id", (req, res) => {
  try {
    const type = String(req.body?.type || "");
    const def = catalogTableMap[type];
    if (!def) return res.status(400).json({ ok: false, error: "Invalid catalog type." });
    const assignments = def.fields.map((field) => `${field} = ?`).join(", ");
    db.prepare(`UPDATE ${def.table} SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...def.fields.map((field) => req.body[field] ?? ""), req.params.id);
    res.json({ item: db.prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(req.params.id) });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.delete("/api/proposal-catalogs/:id", (req, res) => {
  try {
    const type = String(req.query.type || "");
    const def = catalogTableMap[type];
    if (!def) return res.status(400).json({ ok: false, error: "Invalid catalog type." });
    db.prepare(`DELETE FROM ${def.table} WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/proposal-references", (_req, res) => {
  try {
    const references = (db.prepare("SELECT * FROM proposal_references ORDER BY enterprise_type").all() as any[]).map((row) => ({ id: row.id, reference_id: row.reference_id, enterprise_type: row.enterprise_type, description: row.description, ...parseJson(row.data_json, {}) }));
    res.json({ references });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.post("/api/proposal-references", (req, res) => {
  try {
    const id = crypto.randomUUID();
    const referenceId = req.body.reference_id || id;
    db.prepare("INSERT INTO proposal_references (id, reference_id, enterprise_type, description, data_json) VALUES (?, ?, ?, ?, ?)").run(id, referenceId, req.body.enterprise_type || "", req.body.description || "", json(req.body));
    res.status(201).json({ reference: db.prepare("SELECT * FROM proposal_references WHERE id = ?").get(id) });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.put("/api/proposal-references/:id", (req, res) => {
  try {
    db.prepare("UPDATE proposal_references SET reference_id = ?, enterprise_type = ?, description = ?, data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.body.reference_id || req.params.id, req.body.enterprise_type || "", req.body.description || "", json(req.body), req.params.id);
    res.json({ reference: db.prepare("SELECT * FROM proposal_references WHERE id = ?").get(req.params.id) });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.delete("/api/proposal-references/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM proposal_references WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (err: any) { proposalRouteError(res, err); }
});

app.get("/api/me", async (_req, res) => res.json({ profile: null }));
app.post("/api/logout", (_req, res) => res.json({ success: true }));

const PENDING_FILE = PENDING_REGISTRATIONS_FILE;
async function readPendingRegistrations(): Promise<any[]> { try { const content = await fs.readFile(PENDING_FILE, "utf-8"); const parsed = JSON.parse(content); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
async function writePendingRegistrations(rows: any[]) { await fs.mkdir(UPLOAD_ROOT, { recursive: true }); await fs.writeFile(PENDING_FILE, JSON.stringify(rows, null, 2), "utf-8"); }

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    const profile = getLocalProfileByEmail(email);
    if (!profile) return res.status(401).json({ error: "Invalid email or password" });
    if (!verifyPassword(password, profile.password_hash)) return res.status(401).json({ error: "Invalid email or password" });
    res.json({ profile: publicProfile(profile) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/register", async (req, res) => {
  try {
    const { email, password, fullName = "" } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const existing = getLocalProfileByEmail(email);
    if (existing) return res.status(409).json({ error: "Email already registered" });
    const pending = await readPendingRegistrations();
    if (pending.some((r: any) => r.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: "Email already registered" });
    pending.push({ id: randomId("pending"), email: email.trim().toLowerCase(), password, full_name: fullName, role: "user", status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    await writePendingRegistrations(pending);
    res.json({ success: true, message: "Registration submitted for admin approval." });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/recover-default-admin", async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const adminProfile = getDefaultLocalProfile();
    if (!adminProfile) return res.status(404).json({ error: "No admin profile found" });
    const now = new Date().toISOString();
    db.prepare("UPDATE profiles SET password_hash = ?, role = 'admin', status = 'approved', updated_at = ? WHERE id = ?").run(hashPassword(password), now, adminProfile.id);
    res.json({ success: true, message: "Default admin password was reset." });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// =========================
// DOCUMENT ROUTES
// =========================
app.get("/api/documents", async (_req, res) => {
  try {
    backfillOriginalFileMetadata();
    const rows = db.prepare(`
      SELECT d.id, d.file_name, d.file_url, d.folder, d.file_size, d.file_type, d.uploaded_by, d.created_at, d.updated_at,
             m.source_type, m.document_type, m.document_purpose, m.document_stage, m.keywords, m.related_topics, m.short_summary,
             m.classification_confidence, m.classification_reason, m.matched_patterns, m.warnings, m.classification_override,
             CASE WHEN length(coalesce(m.storage_path, '')) > 0 OR length(coalesce(m.download_url, '')) > 0 OR d.file_url LIKE 'local-upload://%' THEN 1 ELSE 0 END AS download_available
      FROM documents d
      LEFT JOIN original_file_metadata m ON m.document_id = d.id
      ORDER BY d.created_at DESC
    `).all();
    const cached = await readLocalDocumentCache();
    const seen = new Set(rows.map((r: any) => r.id));
    const merged = [...rows, ...cached.filter((r: any) => r?.id && !seen.has(r.id)).map((r: any) => ({ id: r.id, file_name: r.file_name || r.fileName, file_url: r.file_url || r.fileUrl, folder: r.folder, file_size: r.file_size || r.fileSize || 0, file_type: r.file_type || r.fileType || "", uploaded_by: r.uploaded_by || r.uploadedBy || "", created_at: r.created_at || r.createdAt, updated_at: r.updated_at || r.updatedAt || r.created_at || r.createdAt }))].sort((a: any, b: any) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    res.json({ documents: merged });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/uploads", async (_req, res) => {
  try {
    console.log("API_CALL", "GET /api/uploads");
    backfillOriginalFileMetadata();
    const files = db.prepare(`
      SELECT d.id, d.file_name AS name, d.file_name AS fileName, d.file_type AS type, d.file_size AS size,
             d.folder AS category, d.created_at AS uploadDate, d.updated_at AS updatedAt,
             m.source_type AS moduleType
      FROM documents d
      LEFT JOIN original_file_metadata m ON m.document_id = d.id
      ORDER BY d.created_at DESC
    `).all();
    console.log("UPLOADS_RECEIVED", { count: files.length });
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Could not load uploads." });
  }
});

app.get("/api/dashboard/files", async (_req, res) => {
  try {
    console.log("API_CALL", "GET /api/dashboard/files");
    const files = dashboardDataFiles().map((file) => ({
      id: file.id,
      name: file.fileName,
      fileName: file.fileName,
      type: file.moduleType,
      uploadDate: "",
      rowCount: file.rowCount,
      headers: file.headers,
      moduleType: file.moduleType,
      sourceFile: file.sourceFile,
    }));
    console.log("UPLOADS_RECEIVED", { count: files.length });
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Could not load dashboard files." });
  }
});

function reclassifyAllDocuments(options: { force?: boolean } = {}) {
  const docs = db.prepare("SELECT id, file_name, file_url, folder, file_size, file_type, content_text, created_at, updated_at FROM documents").all() as any[];
  let updated = 0;
  for (const doc of docs) {
    upsertOriginalFileMetadata(doc, { forceReclassify: options.force });
    updated += 1;
  }
  return { updated, total: docs.length };
}

app.post("/api/admin/reclassify-documents", async (req, res) => {
  try {
    const userId = String(req.body?.userId || req.query.userId || "");
    if (!(await requireAdmin(userId))) return res.status(403).json({ error: "Unauthorized" });
    const result = reclassifyAllDocuments({ force: Boolean(req.body?.force) });
    insertAuditLog({ userId, action: "reclassify_documents", feature: "documents", details: result });
    clearDashboardResponseCache();
    res.json({ success: true, ...result });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.put("/api/admin/document-classifications/:id", async (req, res) => {
  try {
    const userId = String(req.body?.userId || req.query.userId || "");
    if (!(await requireAdmin(userId))) return res.status(403).json({ error: "Unauthorized" });
    const id = String(req.params.id || "");
    const current = db.prepare("SELECT * FROM original_file_metadata WHERE file_id = ? OR document_id = ?").get(id, id) as any;
    if (!current) return res.status(404).json({ error: "Document classification metadata not found" });
    const keywords = Array.isArray(req.body?.keywords) ? req.body.keywords : String(req.body?.keywords || "").split(",").map((item: string) => item.trim()).filter(Boolean);
    const relatedTopics = Array.isArray(req.body?.relatedTopics) ? req.body.relatedTopics : String(req.body?.relatedTopics || "").split(",").map((item: string) => item.trim()).filter(Boolean);
    const documentType = String(req.body?.documentType || current.document_type || "OTHER_DOCUMENT").trim();
    const rule = documentTypeRule(documentType);
    const documentPurpose = String(req.body?.documentPurpose || rule?.purpose || current.document_purpose || "").trim();
    db.prepare(`
      UPDATE original_file_metadata
      SET document_type = ?, document_purpose = ?, document_stage = ?, keywords = ?, related_topics = ?,
          classification_confidence = ?, classification_reason = ?, warnings = ?, classification_override = 1, updated_at = ?
      WHERE file_id = ? OR document_id = ?
    `).run(
      documentType,
      documentPurpose,
      String(req.body?.documentStage || current.document_stage || ""),
      JSON.stringify(keywords),
      JSON.stringify(relatedTopics),
      100,
      `Admin override by ${userId}`,
      JSON.stringify([]),
      new Date().toISOString(),
      id,
      id
    );
    insertAuditLog({ userId, action: "update_document_classification", feature: "documents", fileId: current.file_id, fileName: current.original_file_name, details: { documentType } });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/documents/download", async (req, res) => {
  try {
    const id = String(req.query.id || ""), fileName = String(req.query.fileName || "");
    if (!id && !fileName) return res.status(400).json({ error: "id or fileName is required" });
    const doc = id ? db.prepare("SELECT * FROM documents WHERE id = ?").get(id) : db.prepare("SELECT * FROM documents WHERE file_name = ? ORDER BY created_at DESC LIMIT 1").get(fileName);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    const localPath = doc.file_url?.startsWith("local-upload://") ? path.join(UPLOAD_ROOT, doc.file_url.replace("local-upload://", "")) : null;
    if (localPath) { try { await fs.access(localPath); return res.download(localPath, doc.file_name); } catch {} }
    res.status(410).json({ error: "Original file not available. Re-upload to enable download." });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

async function resolveDownloadableDocument(id: string) {
  const inputId = String(id || "").trim();
  if (!inputId) throw Object.assign(new Error("documentId is required."), { status: 400 });
  const upload = db.prepare("SELECT id, document_id FROM uploaded_files WHERE id = ? OR document_id = ? LIMIT 1").get(inputId, inputId) as any;
  const documentId = upload?.document_id || inputId;
  const uploadedFileId = upload?.id || "";
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as any;
  if (!doc) throw Object.assign(new Error("Document not found."), { status: 404 });
  if (!String(doc.file_url || "").startsWith("local-upload://")) {
    throw Object.assign(new Error("Original file is not available locally. Re-upload to enable download."), { status: 410 });
  }
  const relative = String(doc.file_url).replace("local-upload://", "");
  const localPath = path.resolve(UPLOAD_ROOT, relative);
  if (!localPath.startsWith(UPLOAD_ROOT + path.sep)) throw Object.assign(new Error("Invalid local file path."), { status: 400 });
  await fs.access(localPath);
  return {
    doc,
    documentId,
    uploadedFileId,
    localPath,
    originalFilename: path.basename(doc.file_name || "download"),
    contentType: doc.file_type || mimeTypeFromFileName(doc.file_name || ""),
  };
}

app.get("/api/documents/resolve", async (req, res) => {
  try {
    const sourcePath = String(req.query.sourcePath || "");
    const fileName = String(req.query.fileName || "");
    const resolved = resolveSourceFileReference({
      sourcePath,
      sourceFile: sourcePath,
      fileName,
      title: String(req.query.title || fileName || sourcePath),
      category: String(req.query.category || ""),
      module: String(req.query.module || ""),
    });
    res.json({
      ok: Boolean(resolved.resolved),
      sourcePath,
      matchedDocument: resolved.documentId ? {
        documentId: resolved.documentId,
        originalFilename: resolved.originalFilename,
        filePath: resolved.filePath,
        exists: resolved.exists,
      } : null,
      matchedUpload: resolved.uploadedFileId ? {
        uploadedFileId: resolved.uploadedFileId,
        originalFilename: resolved.originalFilename,
        filePath: resolved.filePath,
        exists: resolved.exists,
      } : null,
      downloadUrl: resolved.downloadUrl,
      previewUrl: resolved.previewUrl,
      resolved,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || "Document source resolution failed." });
  }
});

app.get("/api/debug/resolve-file", async (req, res) => {
  try {
    const sourcePath = String(req.query.sourcePath || "");
    const fileName = String(req.query.fileName || "");
    const normalizedSourcePath = normalizeFilePath(sourcePath);
    const basename = normalizedPathBasename(sourcePath || fileName);
    const resolved = resolveSourceFileReference({
      sourcePath,
      sourceFile: sourcePath,
      fileName,
      title: String(req.query.title || fileName || sourcePath),
      category: String(req.query.category || ""),
      module: String(req.query.module || ""),
    });
    res.json({
      ok: Boolean(resolved.resolved),
      sourcePath,
      normalizedSourcePath,
      basename,
      matchedRecord: resolved.resolved ? {
        category: resolved.category,
        module: resolved.module,
        storageKey: resolved.storageKey,
      } : null,
      documentId: resolved.documentId,
      uploadedFileId: resolved.uploadedFileId,
      originalFilename: resolved.originalFilename,
      filePath: resolved.filePath,
      exists: resolved.exists,
      downloadUrl: resolved.downloadUrl,
      previewUrl: resolved.previewUrl,
      resolveError: resolved.resolved ? "" : "No matching uploaded file record found",
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || "Debug file resolution failed." });
  }
});

app.get("/api/documents/:documentId/download", async (req, res) => {
  const requestedDocumentId = String(req.params.documentId || "");
  const requestedUpload = db.prepare("SELECT id, document_id FROM uploaded_files WHERE id = ? OR document_id = ? LIMIT 1").get(requestedDocumentId, requestedDocumentId) as any;
  const requestedDoc = db.prepare("SELECT file_name, file_url FROM documents WHERE id = ?").get(requestedUpload?.document_id || requestedDocumentId) as any;
  const requestedPath = requestedDoc?.file_url?.startsWith("local-upload://") ? path.resolve(UPLOAD_ROOT, String(requestedDoc.file_url).replace("local-upload://", "")) : "";
  let requestLog = {
    documentId: requestedUpload?.document_id || requestedDocumentId,
    uploadedFileId: requestedUpload?.id || "",
    originalFilename: requestedDoc?.file_name || "",
    filePath: requestedPath,
    exists: Boolean(requestedPath && fsSync.existsSync(requestedPath)),
  };
  try {
    const file = await resolveDownloadableDocument(req.params.documentId);
    requestLog = {
      documentId: file.documentId,
      uploadedFileId: file.uploadedFileId,
      originalFilename: file.originalFilename,
      filePath: file.localPath,
      exists: true,
    };
    console.log("DOCUMENT_DOWNLOAD_LOOKUP", requestLog);
    console.log("DOCUMENT_DOWNLOAD_REQUEST", requestLog);
    if (file.contentType) res.setHeader("Content-Type", file.contentType);
    return res.download(file.localPath, file.originalFilename);
  } catch (err: any) {
    console.log("DOCUMENT_DOWNLOAD_LOOKUP", requestLog);
    console.log("DOCUMENT_DOWNLOAD_REQUEST", requestLog);
    if (err?.code === "ENOENT") return res.status(410).json({ error: "Original file is missing from local uploads." });
    res.status(err?.status || 500).json({ error: err.message || "Document download failed." });
  }
});

app.get("/api/uploads/:fileId/download", async (req, res) => {
  let requestLog = {
    documentId: "",
    uploadedFileId: String(req.params.fileId || ""),
    originalFilename: "",
    filePath: "",
    exists: false,
  };
  try {
    const file = await resolveDownloadableDocument(req.params.fileId);
    requestLog = {
      documentId: file.documentId,
      uploadedFileId: file.uploadedFileId || String(req.params.fileId || ""),
      originalFilename: file.originalFilename,
      filePath: file.localPath,
      exists: true,
    };
    console.log("DOCUMENT_DOWNLOAD_LOOKUP", requestLog);
    console.log("DOCUMENT_DOWNLOAD_REQUEST", requestLog);
    if (file.contentType) res.setHeader("Content-Type", file.contentType);
    return res.download(file.localPath, file.originalFilename);
  } catch (err: any) {
    console.log("DOCUMENT_DOWNLOAD_LOOKUP", requestLog);
    console.log("DOCUMENT_DOWNLOAD_REQUEST", requestLog);
    if (err?.code === "ENOENT") return res.status(410).json({ error: "Original file is missing from local uploads." });
    res.status(err?.status || 500).json({ error: err.message || "Uploaded file download failed." });
  }
});

app.get("/api/documents/:documentId/preview", async (req, res) => {
  try {
    const file = await resolveDownloadableDocument(req.params.documentId);
    const contentType = file.contentType || mimeTypeFromFileName(file.originalFilename);
    if (!/^(application\/pdf|image\/|text\/)|csv/i.test(contentType) && !/\.(pdf|png|jpe?g|webp|txt|csv)$/i.test(file.originalFilename)) {
      return res.status(415).json({ ok: false, message: "Preview is not available for this file type." });
    }
    if (contentType) res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="${file.originalFilename.replace(/"/g, "")}"`);
    return res.sendFile(file.localPath);
  } catch (err: any) {
    if (err?.code === "ENOENT") return res.status(410).json({ error: "Original file is missing from local uploads." });
    res.status(err?.status || 500).json({ error: err.message || "Document preview failed." });
  }
});

app.get("/api/files/:id/download", async (req, res) => {
  try {
    const file = await resolveDownloadableDocument(req.params.id);
    if (file.contentType) res.setHeader("Content-Type", file.contentType);
    return res.download(file.localPath, file.originalFilename);
  } catch (err: any) {
    if (err?.code === "ENOENT") return res.status(410).json({ error: "Original file is missing from local uploads." });
    res.status(err?.status || 500).json({ error: err.message });
  }
});

function mimeTypeFromFileName(fileName: string) {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  return map[ext] || "application/octet-stream";
}

app.get("/api/dashboard-analytics", async (_req, res) => {
  try {
    const unified = buildDashboardAnalyticsResponse() as any;
    const municipalityStats = AURORA_MUNICIPALITIES.map((municipality) => {
      const drill = unified.municipalityDrilldown.find((item: any) => item.municipality === municipality) || {};
      const status = unified.operationalClosedByMunicipality.find((item: any) => item.municipality === municipality) || {};
      return {
        municipality,
        totalParticipants: drill.totalParticipants || 0,
        totalAssociations: drill.associations || 0,
        totalEnterprises: (drill.associations || 0) + (drill.individualEnterprises || 0),
        associationEnterprises: drill.associations || 0,
        individualEnterprises: drill.individualEnterprises || 0,
        operational: drill.operational || status.operational || 0,
        closed: drill.closed || status.closed || 0,
        ongoing: 0,
        inactive: status.unknown || 0,
        encoded: 0,
        notEncoded: 0,
        totalVisits: 0,
        topEnterpriseType: drill.topEnterprise || "No data yet",
        mostOperationalEnterprise: drill.mostOperationalEnterprise || "No data yet",
        mostClosedEnterprise: drill.mostClosedEnterprise || "No data yet",
      };
    });
    const summary = {
      totalParticipants: unified.summary.totalParticipants,
      totalAssociations: unified.summary.associations,
      totalEnterprises: unified.summary.associations + unified.summary.individualEnterprises,
      associationEnterprises: unified.summary.associations,
      individualEnterprises: unified.summary.individualEnterprises,
      operationalEnterprises: unified.summary.operational,
      closedEnterprises: unified.summary.closed,
      ongoingEnterprises: 0,
      inactiveEnterprises: municipalityStats.reduce((sum: number, item: any) => sum + item.inactive, 0),
      encodedRecords: 0,
      notEncodedRecords: 0,
      totalVisits: municipalityStats.reduce((sum: number, item: any) => sum + item.totalVisits, 0),
      mostActiveMunicipality: [...municipalityStats].sort((a: any, b: any) => b.totalEnterprises + b.totalParticipants - (a.totalEnterprises + a.totalParticipants))[0]?.municipality || "No data yet",
      highestClosedMunicipality: [...municipalityStats].sort((a: any, b: any) => b.closed - a.closed)[0]?.municipality || "No data yet",
      mostImplementedEnterpriseType: unified.topEnterprisesOverall[0]?.enterpriseProjectType || "No data yet",
    };
    const byMunicipality = municipalityStats.map((item: any) => ({ municipality: item.municipality, operational: item.operational, closed: item.closed, ongoing: 0, inactive: item.inactive, totalEnterprises: item.totalEnterprises, totalParticipants: item.totalParticipants }));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      success: true,
      lastUpdated: unified.lastUpdated,
      hasData: Object.values(unified.summary || {}).some((value: any) => Number(value) > 0),
      sourceCount: unified.sourceDiagnostics?.reduce((sum: number, item: any) => sum + item.fileCount, 0) || 0,
      rowCount: unified.sourceDiagnostics?.reduce((sum: number, item: any) => sum + item.totalRows, 0) || 0,
      summary,
      municipalities: municipalityStats,
      statusStats: [{ name: "Operational", value: unified.summary.operational }, { name: "Closed", value: unified.summary.closed }, { name: "Pending/Unknown", value: summary.inactiveEnterprises }],
      byMunicipality,
      topEnterpriseTypes: unified.topEnterprisesOverall.map((item: any) => ({ name: item.enterpriseProjectType, value: item.count })),
      topEnterprisesOverall: unified.topEnterprisesOverall,
      topEnterprisesByMunicipality: unified.topEnterprisesByMunicipality,
      mostOperationalEnterprises: unified.mostOperationalEnterprises,
      mostOperationalEnterprisesByMunicipality: unified.mostOperationalEnterprisesByMunicipality,
      mostClosedEnterprises: unified.mostClosedEnterprises,
      mostClosedEnterprisesByMunicipality: unified.mostClosedEnterprisesByMunicipality,
      grantUtilization: unified.grantUtilization,
      training: unified.training,
      municipalityDrilldown: unified.municipalityDrilldown,
      encodedStats: { encoded: 0, notEncoded: 0 },
      visitStats: { totalVisits: summary.totalVisits, mostVisitedMunicipality: [...municipalityStats].sort((a: any, b: any) => b.totalVisits - a.totalVisits)[0]?.municipality || "No data yet" },
      insights: [
        summary.mostActiveMunicipality !== "No data yet" ? `${summary.mostActiveMunicipality} is currently the most active municipality by enterprise and visit activity.` : "No valid Aurora municipality rows were found yet.",
        summary.highestClosedMunicipality !== "No data yet" ? `${summary.highestClosedMunicipality} has the highest number of closed projects.` : "Closed project trends will appear after status fields are detected.",
        summary.mostImplementedEnterpriseType !== "No data yet" ? `${summary.mostImplementedEnterpriseType} is the most implemented enterprise/project type.` : "Enterprise type insights will appear after project type columns are detected.",
      ],
      sourceDiagnostics: unified.sourceDiagnostics,
      widgetDiagnostics: unified.widgetDiagnostics,
      dashboardDebug: unified.dashboardDebug,
    });
  } catch (err: any) {
    console.error("Dashboard analytics failed:", err);
    res.status(500).json({ error: err.message || "Dashboard analytics failed." });
  }
});

app.get("/api/dashboard/municipality-analytics", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(getMunicipalityAnalyticsResponse());
  } catch (err: any) {
    console.error("Municipality analytics failed:", err);
    res.status(500).json({ error: err.message || "Municipality analytics failed." });
  }
});

app.get("/api/dashboard/analytics", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "private, max-age=30");
    res.json(cachedUnifiedDashboardEndpointResponse().analytics);
  } catch (err: any) {
    console.error("Dashboard analytics failed:", err);
    res.status(500).json({ error: err.message || "Dashboard analytics failed." });
  }
});

app.get("/api/dashboard/unified", async (req, res) => {
  try {
    const force = String(req.query.refresh || "") === "1";
    if (force) clearDashboardResponseCache();
    res.setHeader("Cache-Control", force ? "no-store" : "private, max-age=30");
    res.json(cachedUnifiedDashboardEndpointResponse({ force }));
  } catch (err: any) {
    console.error("Unified dashboard endpoint failed:", err);
    res.status(500).json({ error: err.message || "Unified dashboard endpoint failed." });
  }
});

app.get("/api/dashboard-data", async (req, res) => {
  console.log("GET /api/dashboard-data called");
  try {
    const force = String(req.query.refresh || "") === "1";
    if (force) clearDashboardResponseCache();
    res.setHeader("Cache-Control", force ? "no-store" : "private, max-age=30");
    const unified = cachedUnifiedDashboardEndpointResponse({ force }) as any;
    const files = unified.files || [];
    res.json({
      files,
      rows: unified.sourceRows || [],
      sourceRows: unified.sourceRows || [],
      personalRows: unified.personalRows || [],
      projectRows: unified.projectRows || [],
      monitoringRows: [...(unified.monitoringIndividualRows || []), ...(unified.monitoringAssociationRows || [])],
      monitoringIndividualRows: unified.monitoringIndividualRows || [],
      monitoringAssociationRows: unified.monitoringAssociationRows || [],
      orgAssessmentRows: unified.orgAssessmentRows || [],
      annualAssessmentRows: unified.annualAssessmentRows || [],
      gurRows: unified.gurRows || [],
      trainingRows: unified.trainingRows || [],
      dashboardStats: unified.dashboardStats || {},
      municipalityStats: unified.municipalityStats || [],
      analytics: unified.analytics,
      debug: unified.debug,
      cacheStatus: unified.cacheStatus,
    });
  } catch (err: any) {
    console.error("Dashboard data files failed:", err);
    res.status(500).json({
      error: "Failed to load dashboard data",
      details: String(err?.message || err),
      files: [],
      rows: [],
      sourceRows: [],
      personalRows: [],
      projectRows: [],
      monitoringRows: [],
      monitoringIndividualRows: [],
      monitoringAssociationRows: [],
      orgAssessmentRows: [],
      annualAssessmentRows: [],
      gurRows: [],
      trainingRows: [],
      dashboardStats: {},
      municipalityStats: [],
    });
  }
});

app.get("/api/dashboard/performance", async (_req, res) => {
  try {
    const unified = cachedUnifiedDashboardEndpointResponse() as any;
    const rowCounts = unified.debug?.rowsParsedByType || {};
    res.json({
      apiBaseUrl: process.env.PUBLIC_API_BASE_URL || "",
      databaseConnected: true,
      parsedFiles: safeCount("SELECT COUNT(*) AS count FROM uploaded_sheets"),
      rowCounts: {
        personal: rowCounts.personalRows || 0,
        project: rowCounts.projectRows || 0,
        gur: rowCounts.gurRows || 0,
        training: rowCounts.trainingRows || 0,
        monitoringIndividual: rowCounts.monitoringIndividualRows || 0,
        monitoringAssociation: rowCounts.monitoringAssociationRows || 0,
      },
      cacheStatus: unified.cacheStatus,
      lastBuildMs: unified.cacheStatus?.lastBuildMs || 0,
    });
  } catch (err: any) {
    res.status(500).json({
      apiBaseUrl: process.env.PUBLIC_API_BASE_URL || "",
      databaseConnected: false,
      parsedFiles: 0,
      rowCounts: { personal: 0, project: 0, gur: 0, training: 0, monitoringIndividual: 0, monitoringAssociation: 0 },
      cacheStatus: dashboardResponseCache ? { hit: true, builtAt: dashboardResponseCache.builtAt, ttlMs: DASHBOARD_CACHE_TTL_MS, lastBuildMs: dashboardResponseCache.lastBuildMs } : { hit: false },
      lastBuildMs: dashboardResponseCache?.lastBuildMs || 0,
      error: err.message || "Dashboard performance failed.",
    });
  }
});

app.get("/api/debug/dashboard-files", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const files = dashboardDataFiles();
    const filesTableCount = db.prepare("SELECT COUNT(*) AS count FROM uploaded_files").get() as any;
    const documentsCount = db.prepare("SELECT COUNT(*) AS count FROM documents").get() as any;
    const processedFilesCount = db.prepare("SELECT COUNT(DISTINCT document_id) AS count FROM uploaded_sheets WHERE document_id IS NOT NULL").get() as any;
    res.json({
      filesTableCount: Number(filesTableCount?.count || 0),
      uploadedFilesCount: Number(documentsCount?.count || 0),
      processedFilesCount: Number(processedFilesCount?.count || 0),
      files: files.map((file) => ({
        id: file.id,
        fileName: file.fileName,
        originalName: file.originalName,
        moduleType: file.moduleType,
        category: file.category,
        hasParsedRows: file.hasParsedRows,
        rowCount: file.rowCount,
        headers: file.headers,
      })),
    });
  } catch (err: any) {
    console.error("Dashboard files debug failed:", err);
    res.status(500).json({ error: err.message || "Dashboard files debug failed." });
  }
});

async function extractPdfText(buffer: Buffer, documentId?: string, fileName = "document.pdf") {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = result.text || "";
    const now = new Date().toISOString();
    if (documentId) {
      db.prepare("DELETE FROM pdf_pages WHERE document_id = ?").run(documentId);
      db.prepare("DELETE FROM vision_extractions WHERE document_id = ?").run(documentId);
      const pages = text.split(/\n\s*\n(?=Page\s+\d+|\d+\s*$)/i).filter(Boolean);
      const pageTexts = pages.length > 1 ? pages : [text];
      pageTexts.filter((pageText) => pageText.trim()).forEach((pageText, index) => {
        db.prepare("INSERT INTO pdf_pages (id, document_id, page_number, text, text_length, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(randomId("pdfpage"), documentId, index + 1, pageText, pageText.length, now);
      });
    }
    if (documentId && text.trim().length < 80) {
      try {
        const screenshots = await parser.getScreenshot({ imageBuffer: true, imageDataUrl: false, desiredWidth: 1400, first: 10 } as any);
        const visionTexts: string[] = [];
        for (const page of screenshots.pages || []) {
          const pageNumber = Number(page.pageNumber || visionTexts.length + 1);
          const pageBuffer = Buffer.from(page.data);
          let pageText = await extractImageWithVision(pageBuffer, documentId, fileName, { pageNumber, imageNumber: 1, mimeType: "image/png", method: "github models vision scanned pdf page" });
          if (!pageText || /^\[Vision extraction failed/.test(pageText)) {
            try {
              const { data: ocrData } = await Tesseract.recognize(pageBuffer, "eng");
              const fallbackText = ocrData.text || "[No text detected]";
              insertVisionExtraction({ documentId, fileName, pageNumber, imageNumber: 1, method: "tesseract scanned pdf fallback", modelUsed: "tesseract.js", text: fallbackText, confidence: typeof ocrData.confidence === "number" ? ocrData.confidence / 100 : undefined });
              pageText = fallbackText;
            } catch {}
          }
          visionTexts.push(`Page ${pageNumber}:\n${pageText}`);
          db.prepare("INSERT INTO pdf_pages (id, document_id, page_number, text, text_length, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(randomId("pdfpage"), documentId, pageNumber, pageText, pageText.length, now);
        }
        const combined = visionTexts.join("\n\n").trim();
        db.prepare("INSERT INTO pdf_extraction_status (document_id, pages_processed, text_length, tables_extracted, ocr_needed, ocr_attempted, extraction_error, updated_at) VALUES (?, ?, ?, 0, 1, 1, NULL, ?) ON CONFLICT(document_id) DO UPDATE SET pages_processed = excluded.pages_processed, text_length = excluded.text_length, ocr_needed = 1, ocr_attempted = 1, extraction_error = NULL, updated_at = excluded.updated_at")
          .run(documentId, visionTexts.length, combined.length, now);
        return combined || "[Scanned PDF vision extraction produced no readable text.]";
      } catch (visionError: any) {
        db.prepare("INSERT INTO pdf_extraction_status (document_id, pages_processed, text_length, tables_extracted, ocr_needed, ocr_attempted, extraction_error, updated_at) VALUES (?, 0, ?, 0, 1, 1, ?, ?) ON CONFLICT(document_id) DO UPDATE SET text_length = excluded.text_length, ocr_needed = 1, ocr_attempted = 1, extraction_error = excluded.extraction_error, updated_at = excluded.updated_at")
          .run(documentId, text.length, visionError.message || "Scanned PDF vision extraction failed", now);
      }
    }
    if (documentId) {
      db.prepare("INSERT INTO pdf_extraction_status (document_id, pages_processed, text_length, tables_extracted, ocr_needed, ocr_attempted, extraction_error, updated_at) VALUES (?, ?, ?, 0, ?, 0, NULL, ?) ON CONFLICT(document_id) DO UPDATE SET pages_processed = excluded.pages_processed, text_length = excluded.text_length, ocr_needed = excluded.ocr_needed, extraction_error = NULL, updated_at = excluded.updated_at")
        .run(documentId, Math.max(1, text ? text.split(/\f|\n\s*\n(?=Page\s+\d+)/i).length : 0), text.length, text.trim().length < 80 ? 1 : 0, now);
    }
    return text.trim() || "[PDF text extraction produced no readable text.]";
  } catch (error: any) {
    if (documentId) {
      db.prepare("INSERT INTO pdf_extraction_status (document_id, pages_processed, text_length, tables_extracted, ocr_needed, ocr_attempted, extraction_error, updated_at) VALUES (?, 0, 0, 0, 1, 0, ?, ?) ON CONFLICT(document_id) DO UPDATE SET extraction_error = excluded.extraction_error, ocr_needed = 1, updated_at = excluded.updated_at")
        .run(documentId, error.message || "PDF extraction failed", new Date().toISOString());
    }
    return "[PDF text extraction failed. If this is a scanned/image PDF, vision extraction could not run.]";
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

app.post("/api/upload-document", async (req, res) => {
  try {
    const { fileName, fileType = "text/plain", fileSize = 0, folder: requestedFolder = "SLPIS", selectedFolder: selectedFolderInput, uploadMode = "single-document", relativePath = "", data, userId, chatAttachment = false, chatSessionId = "" } = req.body;
    if (!fileName || !data) return res.status(400).json({ error: "fileName and data are required" });
    if (!isSupportedUpload(fileName, fileType)) {
      return res.status(400).json({ error: "Unsupported file type. Please upload PDF, DOCX, TXT, CSV, Excel, PNG, JPG, JPEG, or WEBP files." });
    }
    const selectedFolder = normalizeLocalDocumentFolder(selectedFolderInput || requestedFolder, "SLPIS");
    const folder = selectedFolder;
    console.log("[DOCUMENT_UPLOAD_ROUTE]", {
      selectedFolder,
      uploadMode,
      endpoint: "/api/upload-document",
      filesReceived: [{ fileName, fileSize, relativePath }],
      finalSavedFolder: folder,
    });
    if (!chatAttachment) {
      const uploader = userId ? getLocalProfileById(String(userId)) : null;
      if (!uploader || uploader.role !== "admin" || uploader.status !== "approved") return res.status(403).json({ error: "Only admin accounts can upload documents from the Documents page." });
    }
    const buffer = Buffer.from(data, "base64");
    let text = "";
    const docId = randomId("doc"); const now = new Date().toISOString();
    if (/pdf/i.test(fileType) || /\.pdf$/i.test(fileName)) {
      text = await extractPdfText(buffer, docId, fileName);
    } else if (/word|docx/i.test(fileType) || /\.docx$/i.test(fileName)) { text = (await mammoth.extractRawText({ buffer })).value; }
    else if (/sheet|excel|csv/i.test(fileType) || /\.(xlsx?|csv)$/i.test(fileName)) {
      const wb = XLSX.read(buffer, { type: "buffer" }); const sheets: any[] = [];
      wb.SheetNames.forEach(sn => sheets.push({ name: sn, rows: XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sn], { header: 1, defval: "", raw: false }) }));
      text = JSON.stringify({ __slpWorkbook: true, sheets });
    } else if (/image/i.test(fileType) || /\.(png|jpe?g|webp)$/i.test(fileName)) {
      db.prepare("DELETE FROM vision_extractions WHERE document_id = ?").run(docId);
      text = await extractImageWithVision(buffer, docId, fileName, { imageNumber: 1, mimeType: fileType, method: "github models vision image" });
      if (!text || /^\[Vision extraction failed/.test(text)) {
        try {
          const { data: ocrData } = await Tesseract.recognize(buffer, "eng");
          const fallbackText = ocrData.text || "[No text detected]";
          insertVisionExtraction({ documentId: docId, fileName, imageNumber: 1, method: "tesseract fallback", modelUsed: "tesseract.js", text: fallbackText, confidence: typeof ocrData.confidence === "number" ? ocrData.confidence / 100 : undefined });
          text = fallbackText;
        } catch { text = text || "[OCR failed]"; }
      }
    }
    else text = buffer.toString("utf-8");
    const uploadUserId = userId || (await getDefaultLocalProfile())?.id || null;
    const fileUrl = await saveUploadedOriginal(buffer, folder, fileName).catch(() => `local-upload://${Date.now()}_${fileName}`);
    db.prepare("INSERT INTO documents (id, file_name, file_url, folder, file_size, file_type, content_text, uploaded_by, chat_attachment, chat_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(docId, fileName, fileUrl, folder, fileSize, fileType, text, uploadUserId, chatAttachment ? 1 : 0, chatSessionId || null, now, now);
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(docId);
    upsertOriginalFileMetadata(doc);
    if (relativePath) applyFolderUploadMetadata(docId, String(relativePath));
    if (/sheet|excel|csv/i.test(fileType) || /\.(xlsx?|csv)$/i.test(fileName)) indexWorkbookDocument(doc);
    console.log(`[INGESTION_INDEX_STATUS] ${JSON.stringify({
      documentId: docId,
      fileName,
      folder,
      fileType,
      sourceType: sourceTypeForFolder(folder, fileName, fileType),
      textLength: String(text || "").length,
      indexedAsWorkbook: /sheet|excel|csv/i.test(fileType) || /\.(xlsx?|csv)$/i.test(fileName),
      chatAttachment: Boolean(chatAttachment),
    })}`);
    await upsertLocalDocumentCache(doc);
    insertAuditLog({ userId: uploadUserId, action: chatAttachment ? "upload_chat_attachment" : "upload_document", feature: "documents", fileId: docId, fileName, details: { folder, fileType, fileSize } });
    clearDashboardResponseCache();
    res.json({ success: true, document: doc, message: "Upload saved." });
  } catch (err: any) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/proposals/upload-folder", async (req, res) => {
  try {
    const { files = [], userId, selectedFolder: selectedFolderInput, uploadMode = "proposal-folder" } = req.body || {};
    const selectedFolder = String(selectedFolderInput || "").trim().toUpperCase();
    console.log("[DOCUMENT_UPLOAD_ROUTE]", {
      selectedFolder,
      uploadMode,
      endpoint: "/api/proposals/upload-folder",
      filesReceived: Array.isArray(files) ? files.map((file: any) => ({
        fileName: file?.fileName || "",
        fileSize: file?.fileSize || 0,
        relativePath: file?.relativePath || file?.webkitRelativePath || "",
      })) : [],
      finalSavedFolder: selectedFolder === "PROPOSALS" ? "PROPOSALS" : "",
    });
    if (selectedFolder !== "PROPOSALS") {
      return res.status(400).json({ error: "Proposal folder upload is only allowed when selectedFolder is PROPOSALS." });
    }
    const uploader = userId ? getLocalProfileById(String(userId)) : null;
    if (!uploader || uploader.role !== "admin" || uploader.status !== "approved") return res.status(403).json({ error: "Only admin accounts can upload proposal folders." });
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: "Select one complete proposal folder to upload." });

    const normalizedFiles = files.map((file: any) => ({
      fileName: String(file.fileName || path.basename(String(file.relativePath || "")) || ""),
      fileType: String(file.fileType || "application/octet-stream"),
      fileSize: Number(file.fileSize || 0),
      data: String(file.data || ""),
      relativePath: normalizeUploadRelativePath(file.relativePath || file.webkitRelativePath || ""),
    }));
    const invalid = normalizedFiles.find((file: any) => !file.fileName || !file.data || !file.relativePath || file.relativePath.split("/").length < 2);
    if (invalid) return res.status(400).json({ error: "Folder upload requires every file to include file.webkitRelativePath." });

    const roots = Array.from(new Set(normalizedFiles.map((file: any) => file.relativePath.split("/")[0]).filter(Boolean)));
    if (roots.length !== 1) return res.status(400).json({ error: "Upload exactly one proposal folder at a time." });
    const originalFolderName = roots[0];
    const proposalId = randomId("proposal");
    const folder = "PROPOSALS";
    const now = new Date().toISOString();
    const detectedDocuments: any[] = [];
    const extractedItems: any[] = [];
    let extractedTitle = "";
    let templateType: ProposalBuilderTemplateType = "MAF";

    for (const file of normalizedFiles) {
      const buffer = Buffer.from(file.data, "base64");
      const docId = randomId("doc");
      const fileUrl = await saveUploadedOriginalAtRelativePath(buffer, folder, proposalId, file.relativePath);
      let text = "";
      if (isSupportedUpload(file.fileName, file.fileType)) {
        if (/pdf/i.test(file.fileType) || /\.pdf$/i.test(file.fileName)) text = await extractPdfText(buffer, docId, file.fileName);
        else if (/word|docx/i.test(file.fileType) || /\.docx$/i.test(file.fileName)) text = (await mammoth.extractRawText({ buffer })).value;
        else if (/sheet|excel|csv/i.test(file.fileType) || /\.(xlsx?|csv)$/i.test(file.fileName)) {
          const wb = XLSX.read(buffer, { type: "buffer" }); const sheets: any[] = [];
          wb.SheetNames.forEach(sn => sheets.push({ name: sn, rows: XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sn], { header: 1, defval: "", raw: false }) }));
          text = JSON.stringify({ __slpWorkbook: true, sheets });
        } else if (/image/i.test(file.fileType) || /\.(png|jpe?g|webp)$/i.test(file.fileName)) {
          text = await extractImageWithVision(buffer, docId, file.fileName, { imageNumber: 1, mimeType: file.fileType, method: "github models vision proposal folder image" });
        } else {
          text = buffer.toString("utf-8");
        }
      }

      db.prepare("INSERT INTO documents (id, file_name, file_url, folder, file_size, file_type, content_text, uploaded_by, chat_attachment, chat_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)")
        .run(docId, file.fileName, fileUrl, folder, file.fileSize || buffer.length, file.fileType, text, userId, now, now);
      const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(docId);
      upsertOriginalFileMetadata(doc);
      applyProposalFolderMetadata(docId, { relativePath: file.relativePath, proposalId, rootFolder: originalFolderName });
      if (/sheet|excel|csv/i.test(file.fileType) || /\.(xlsx?|csv)$/i.test(file.fileName)) indexWorkbookDocument(doc);
      await upsertLocalDocumentCache(doc);

      const score = proposalDocumentNameScore(file.relativePath || file.fileName);
      if (score > 0 && /\.docx$/i.test(file.fileName)) {
        const currentType = detectProposalTemplateTypeFromName(file.relativePath || file.fileName);
        templateType = currentType;
        const title = extractTitleFromProposalText(text);
        if (title && !extractedTitle) extractedTitle = title;
        const docItems = await extractProposalItemsFromDocx({ buffer, fileName: file.fileName, text });
        extractedItems.push(...docItems.map((item) => ({ ...item, relativePath: file.relativePath, proposalId })));
        detectedDocuments.push({
          documentId: docId,
          fileName: file.fileName,
          relativePath: file.relativePath,
          detectedType: currentType,
          score,
          extractedItemCount: docItems.length,
          title,
        });
      }
    }

    const proposalTitle = extractedTitle || originalFolderName;
    const proposal = writeUploadedProposalFolderRecord({
      proposalId,
      originalFolderName,
      proposalTitle,
      templateType,
      uploadRootPath: `local-upload://${safePathPart(folder)}/${safePathPart(proposalId)}/${safeUploadRelativePath(originalFolderName)}`,
      detectedDocuments,
      extractedItems,
      ownerUserId: String(userId || ""),
    });
    insertAuditLog({ userId, action: "upload_proposal_folder", feature: "proposals", fileId: proposalId, fileName: originalFolderName, details: { fileCount: normalizedFiles.length, detectedDocuments: detectedDocuments.length, extractedItems: extractedItems.length } });
    console.log("[DOCUMENT_UPLOAD_COMPLETE]", {
      selectedFolder,
      uploadMode,
      endpoint: "/api/proposals/upload-folder",
      filesReceived: normalizedFiles.length,
      finalSavedFolder: folder,
    });
    res.json({ success: true, proposal, proposalId, originalFolderName, proposalTitle, fileCount: normalizedFiles.length, detectedDocuments, extractedItems });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message || "Proposal folder upload failed." });
  }
});

app.use("/api/proposals", (_req, res) => {
  res.status(404).json({ ok: false, error: "Proposal endpoint not found." });
});

app.delete("/api/documents/:id", async (req, res) => {
  try {
    const { id } = req.params; const requesterId = String(req.query.userId || "");
    const requester = requesterId ? getLocalProfileById(requesterId) : null;
    if (!requester || requester.role !== "admin" || requester.status !== "approved") return res.status(403).json({ error: "Unauthorized" });

    const doc = db.prepare("SELECT id, file_url FROM documents WHERE id = ?").get(id);
    const cachedDoc = await removeLocalDocumentCache(id);
    if (!doc && !cachedDoc) return res.status(404).json({ error: "Document not found" });

    clearDocumentSheetIndex(id);
    db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);
    db.prepare("DELETE FROM pdf_pages WHERE document_id = ?").run(id);
    db.prepare("DELETE FROM pdf_tables WHERE document_id = ?").run(id);
    db.prepare("DELETE FROM pdf_extraction_status WHERE document_id = ?").run(id);
    db.prepare("DELETE FROM vision_extractions WHERE document_id = ?").run(id);
    db.prepare("DELETE FROM original_file_metadata WHERE document_id = ? OR file_id = ?").run(id, id);
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);

    await deleteLocalUploadFile(doc?.file_url || cachedDoc?.file_url || cachedDoc?.fileUrl || "");
    insertAuditLog({ userId: requesterId, action: "delete_document", feature: "documents", fileId: id, fileName: doc?.file_name || cachedDoc?.file_name || cachedDoc?.fileName || "", details: {} });
    clearDashboardResponseCache();
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

function safePathPart(value: string) { return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100); }
async function saveUploadedOriginal(buffer: Buffer, folder: string, fileName: string): Promise<string> {
  const safeFolder = safePathPart(folder), safeName = `${Date.now()}_${safePathPart(fileName)}`;
  const dest = path.join(UPLOAD_ROOT, safeFolder, safeName);
  await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, buffer);
  return `local-upload://${safeFolder}/${safeName}`;
}

function normalizeUploadRelativePath(value = "") {
  return String(value || "").replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

function safeUploadRelativePath(value = "") {
  return normalizeUploadRelativePath(value).split("/").map(safePathPart).filter(Boolean).join("/");
}

async function saveUploadedOriginalAtRelativePath(buffer: Buffer, folder: string, proposalId: string, relativePath: string): Promise<string> {
  const safeFolder = safePathPart(folder);
  const safeProposalId = safePathPart(proposalId);
  const safeRelativePath = safeUploadRelativePath(relativePath);
  if (!safeRelativePath || safeRelativePath.includes("..")) throw new Error("Invalid upload relative path.");
  const dest = path.resolve(UPLOAD_ROOT, safeFolder, safeProposalId, safeRelativePath);
  const allowedRoot = path.resolve(UPLOAD_ROOT, safeFolder, safeProposalId);
  if (dest !== allowedRoot && !dest.startsWith(allowedRoot + path.sep)) throw new Error("Invalid upload relative path.");
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buffer);
  return `local-upload://${safeFolder}/${safeProposalId}/${safeRelativePath}`;
}

function proposalDocumentNameScore(fileName = "") {
  const normalized = String(fileName || "").toLowerCase().replace(/[_-]+/g, " ");
  let score = 0;
  if (/\bmaf\b|microenterprise assistance fund/.test(normalized)) score += 100;
  if (/mungkahing proyekto/.test(normalized)) score += 100;
  if (/project proposal|proposal/.test(normalized)) score += 70;
  return score;
}

function detectProposalTemplateTypeFromName(fileName = ""): ProposalBuilderTemplateType {
  const normalized = String(fileName || "").toLowerCase().replace(/[_-]+/g, " ");
  if (/\bmaf\b|microenterprise assistance fund/.test(normalized)) return "MAF";
  if (/mungkahing proyekto|project proposal/.test(normalized)) return "MUNGKAHING_PROYEKTO";
  return "MAF";
}

function decodeXmlText(value = "") {
  return String(value || "")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractDocxTables(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")?.async("text");
  if (!xml) return [] as string[][][];
  const tables: string[][][] = [];
  for (const tableMatch of xml.matchAll(/<w:tbl[\s\S]*?<\/w:tbl>/g)) {
    const rows: string[][] = [];
    for (const rowMatch of tableMatch[0].matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)) {
      const cells = Array.from(rowMatch[0].matchAll(/<w:tc[\s\S]*?<\/w:tc>/g))
        .map((cell) => decodeXmlText(cell[0]))
        .filter((cell) => cell.length > 0);
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function normalizeHeader(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function proposalItemKindFromText(value = "") {
  const text = normalizeHeader(value);
  if (/raw material|materials?|inputs?|supplies/.test(text)) return "raw_materials";
  if (/tool|equipment|asset|utensil|machine|implement/.test(text)) return "tools_equipment";
  if (/product|output|sales|produce/.test(text)) return "products_output";
  return "";
}

function sourceSectionFromContext(context = "", fallback = "") {
  const kind = proposalItemKindFromText(context);
  if (kind) return kind;
  return fallback;
}

function numberFromCell(value: any) {
  const cleaned = String(value ?? "").replace(/[₱,\s]/g, "").match(/-?\d+(?:\.\d+)?/);
  return cleaned ? Number(cleaned[0]) : 0;
}

function pickCell(row: string[], headers: string[], patterns: RegExp[]) {
  const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
  return index >= 0 ? String(row[index] || "").trim() : "";
}

function extractTitleFromProposalText(text = "") {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const labeled = lines.find((line) => /^(project\s+title|title\s+of\s+md\s+project|specific\s+title)/i.test(line));
  if (labeled) {
    const value = labeled.split(/[:\-]/).slice(1).join(":").trim();
    if (value.length >= 3) return value.slice(0, 160);
  }
  const candidate = lines.find((line) => /proposal|microenterprise|livelihood|project/i.test(line) && line.length >= 8 && line.length <= 160);
  return candidate || "";
}

function extractProposalItemsFromDocx(input: { buffer: Buffer; fileName: string; text: string }) {
  return extractDocxTables(input.buffer).then((tables) => {
    const items: any[] = [];
    tables.forEach((table, tableIndex) => {
      const context = table.slice(0, 2).flat().join(" ");
      const contextKind = sourceSectionFromContext(context);
      table.forEach((row, rowIndex) => {
        const headerRow = row.map(normalizeHeader);
        const looksLikeHeader = headerRow.some((cell) => /(quantity|qty|unit|cost|price|amount|total|supplier|raw material|equipment|product)/.test(cell));
        if (!looksLikeHeader) return;
        const headers = headerRow;
        for (const valueRow of table.slice(rowIndex + 1)) {
          const joined = valueRow.join(" ").trim();
          if (!joined || /^(total|subtotal|grand total)\b/i.test(joined)) continue;
          const section = sourceSectionFromContext(`${context} ${headers.join(" ")}`, contextKind || "raw_materials");
          const name = pickCell(valueRow, headers, [/raw material|item|particular|description|tool|equipment|product|output|expense/]) || valueRow[0] || "";
          if (!name || /^(no\.?|qty|quantity|unit)$/i.test(name)) continue;
          const quantity = numberFromCell(pickCell(valueRow, headers, [/^qty$|quantity|number/]));
          const unit = pickCell(valueRow, headers, [/^unit$|unit of measure|uom/]);
          const unitCost = numberFromCell(pickCell(valueRow, headers, [/unit cost|unit price|price|cost per/]));
          const totalCost = numberFromCell(pickCell(valueRow, headers, [/total cost|total amount|amount|total/])) || (quantity && unitCost ? quantity * unitCost : 0);
          const supplier = pickCell(valueRow, headers, [/supplier|source|store|dealer/]);
          if (!quantity && !unitCost && !totalCost && valueRow.length < 3) continue;
          items.push({
            section,
            itemName: name,
            quantity,
            unit,
            unitCost,
            totalCost,
            supplier,
            sourceFileName: input.fileName,
            sourceSectionTable: `Table ${tableIndex + 1}`,
          });
        }
      });
    });
    return items;
  }).catch(() => [] as any[]);
}

function applyProposalFolderMetadata(documentId: string, input: { relativePath: string; proposalId: string; rootFolder: string }) {
  db.prepare("UPDATE original_file_metadata SET relative_path = ?, proposal_id = ?, proposal_root_folder = ?, sub_folder = ? WHERE file_id = ?")
    .run(input.relativePath, input.proposalId, input.rootFolder, normalizeUploadRelativePath(input.relativePath).split("/").slice(1, -1).join("/"), documentId);
}

function applyFolderUploadMetadata(documentId: string, relativePath: string) {
  const normalized = normalizeUploadRelativePath(relativePath);
  db.prepare("UPDATE original_file_metadata SET relative_path = ?, proposal_id = '', proposal_root_folder = '', sub_folder = ? WHERE file_id = ?")
    .run(normalized, normalized.split("/").slice(1, -1).join("/"), documentId);
}

function writeUploadedProposalFolderRecord(input: {
  proposalId: string;
  originalFolderName: string;
  proposalTitle: string;
  templateType: ProposalBuilderTemplateType;
  uploadRootPath: string;
  detectedDocuments: any[];
  extractedItems: any[];
  ownerUserId: string;
}) {
  const now = new Date().toISOString();
  const rawMaterials = input.extractedItems.filter((item) => item.section === "raw_materials");
  const toolsEquipment = input.extractedItems.filter((item) => item.section === "tools_equipment");
  const productsOutput = input.extractedItems.filter((item) => item.section === "products_output");
  const totalCost = [...rawMaterials, ...toolsEquipment].reduce((sum, item) => sum + moneyValue(item.totalCost), 0);
  const formData = {
    proposalId: input.proposalId,
    proposalType: input.templateType,
    templateType: input.templateType,
    originalFolderName: input.originalFolderName,
    proposalTitle: input.proposalTitle,
    title: input.proposalTitle || input.originalFolderName,
    projectName: input.proposalTitle || input.originalFolderName,
    rawMaterials,
    toolsEquipment,
    grossSales: productsOutput.map((item) => ({ ...item, productName: item.itemName, totalSales: item.totalCost })),
    detectedDocuments: input.detectedDocuments,
    extractedItems: input.extractedItems,
  };
  db.transaction(() => {
    db.prepare(`INSERT INTO proposal_inventory
      (proposalId, templateType, title, municipality, barangay, projectName, enterpriseType, totalCost, status, formDataJson, docxPath, previewPath, ownerUserId, originalFolderName, uploadRootPath, detectedDocumentsJson, extractedItemsJson, createdAt, updatedAt)
      VALUES (?, ?, ?, '', '', ?, '', ?, 'Uploaded Folder', ?, '', '', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(proposalId) DO UPDATE SET templateType = excluded.templateType, title = excluded.title, projectName = excluded.projectName, totalCost = excluded.totalCost, status = excluded.status, formDataJson = excluded.formDataJson, ownerUserId = excluded.ownerUserId, originalFolderName = excluded.originalFolderName, uploadRootPath = excluded.uploadRootPath, detectedDocumentsJson = excluded.detectedDocumentsJson, extractedItemsJson = excluded.extractedItemsJson, updatedAt = excluded.updatedAt`)
      .run(input.proposalId, input.templateType, input.proposalTitle || input.originalFolderName, input.proposalTitle || input.originalFolderName, totalCost, json(formData), input.ownerUserId, input.originalFolderName, input.uploadRootPath, json(input.detectedDocuments), json(input.extractedItems), now, now);
    db.prepare("DELETE FROM proposal_line_items WHERE proposalId = ?").run(input.proposalId);
    const insertLine = db.prepare(`INSERT INTO proposal_line_items (lineItemId, proposalId, proposalType, sectionKey, catalogItemId, section, catalogType, itemName, category, unit, quantity, unitCost, totalCost, remarks, valuesJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    input.extractedItems.forEach((item, index) => {
      const catalogType = item.section === "tools_equipment" ? "Tool/Equipment" : item.section === "products_output" ? "Product/Output" : "Raw Material";
      insertLine.run(uniqueProposalLineItemId(input.proposalId, item.section || "extracted", index), input.proposalId, input.templateType, item.section || "extracted", "", item.section || "extracted", catalogType, item.itemName || "", "", item.unit || "", moneyValue(item.quantity), moneyValue(item.unitCost), moneyValue(item.totalCost), item.supplier || "", json(item));
    });
  })();
  return proposalInventoryRow(db.prepare("SELECT * FROM proposal_inventory WHERE proposalId = ?").get(input.proposalId));
}

// =========================
// NAME MATCHING ROUTES
// =========================
type NameRecord = {
  row: number;
  fullName: string;
  normalized: string;
  sourceFile: string;
  sheet: string;
  notes: string;
  participantId?: string;
  slpUniqueId?: string;
  fundSource?: string;
  isPantawid?: string;
  pantawidStatus?: string;
  householdId?: string;
  typeOfParticipant?: string;
  projectId?: string;
  enterpriseType?: string;
  sex?: string;
  birthdate?: string;
  municipality?: string;
  barangay?: string;
  dataset?: string;
  source?: string;
  sourceModule?: string;
  sourceSystem?: "SLPIS" | "SLP DPT" | "Input names" | "Reference";
  sourceId?: string;
};

function standardizeNameParts(value: string) {
  return normalizeName(value)
    .split(" ")
    .map((part) => ({ jr: "jr", junior: "jr", sr: "sr", senior: "sr", ii: "ii", iii: "iii", iv: "iv" } as Record<string, string>)[part] || part)
    .join(" ");
}

function buildFullName(row: Record<string, string>, headers: string[]) {
  const byRole = (role: string) => headers.find((header) => detectColumnRole(header) === role);
  const fullCol = byRole("full_name");
  if (fullCol && String(row[fullCol] || "").trim()) {
    const full = standardizeNameParts(row[fullCol]);
    const tokens = full.split(" ").filter(Boolean);
    return { fullName: full, sufficient: tokens.length >= 2, notes: tokens.length >= 2 ? "One-column full name" : "Only first name or incomplete full name" };
  }
  const first = byRole("first_name"), middle = byRole("middle_name"), last = byRole("last_name"), ext = byRole("extension");
  const parts = [last && row[last], first && row[first], middle && row[middle], ext && row[ext]].filter(Boolean).map(String);
  const fullName = standardizeNameParts(parts.join(" "));
  const sufficient = Boolean(first && last && row[first] && row[last]);
  return { fullName, sufficient, notes: sufficient ? "Built from separate name columns" : "Insufficient data: first and last name were not both available" };
}

function normalizePersonName(value: string) {
  return normalizeName(value)
    .replace(/\b(jr|junior|sr|senior|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function nameVariants(value: string) {
  const normalized = normalizePersonName(value);
  const tokens = normalized.split(" ").filter(Boolean);
  const variants = new Set<string>();
  if (!tokens.length) return [normalized];
  variants.add(normalized);
  if (tokens.length >= 2) {
    variants.add(`${tokens[tokens.length - 1]} ${tokens.slice(0, -1).join(" ")}`.trim());
    variants.add(`${tokens[1] || ""} ${tokens.slice(2).join(" ")} ${tokens[0]}`.trim());
    if (tokens.length > 2) {
      variants.add([tokens[0], tokens[tokens.length - 1]].join(" "));
      variants.add([tokens[1], tokens[tokens.length - 1], tokens[0]].join(" "));
      variants.add([tokens[1], tokens[0]].join(" "));
      variants.add([tokens[0], ...tokens.slice(1, -1).filter((token) => token.length > 1), tokens[tokens.length - 1]].join(" "));
      variants.add([tokens[0], ...tokens.slice(1, -1).map((token) => token[0]), tokens[tokens.length - 1]].join(" "));
    }
  }
  return Array.from(variants).filter(Boolean);
}

function fullNameScoreVariant(a: string, b: string) {
  const av = nameVariants(a), bv = nameVariants(b);
  let best = 0;
  for (const left of av) for (const right of bv) best = Math.max(best, similarityScore(left, right));
  const at = normalizePersonName(a).split(" ").filter(Boolean);
  const bt = normalizePersonName(b).split(" ").filter(Boolean);
  
  // Exact first and last name match (ignore middle)
  if (at.length >= 2 && bt.length >= 2 && at[0] === bt[0] && at[at.length - 1] === bt[bt.length - 1]) best = Math.max(best, 94);
  if (at.length >= 2 && bt.length >= 2 && at[0] === bt[bt.length - 1] && at[at.length - 1] === bt[0]) best = Math.max(best, 92); // reversed
  
  // All tokens from shorter match in longer (allows extra middle names)
  const shortTokens = at.length <= bt.length ? at : bt;
  const longTokens = at.length <= bt.length ? bt : at;
  if (shortTokens.length >= 2 && shortTokens.every((token) => longTokens.includes(token))) best = Math.max(best, 94);
  
  // Middle initial vs full middle name (e.g., "John M Smith" vs "John Michael Smith")
  if (at.length === 3 && bt.length === 3) {
    if (at[0] === bt[0] && at[2] === bt[2]) {
      // Compare middle: if one is initial and one is full name, give high score
      if ((at[1].length === 1 && bt[1].length > 1 && bt[1][0] === at[1]) ||
          (bt[1].length === 1 && at[1].length > 1 && at[1][0] === bt[1])) {
        best = Math.max(best, 90);
      }
    }
  }
  
  // Compare without middle names
  if (at.length >= 2 && bt.length >= 2) {
    const atNoMiddle = [at[0], at[at.length - 1]].join(" ");
    const btNoMiddle = [bt[0], bt[bt.length - 1]].join(" ");
    const atReversedNoMiddle = [at[at.length - 1], at[0]].join(" ");
    const btReversedNoMiddle = [bt[bt.length - 1], bt[0]].join(" ");
    best = Math.max(best, 
      similarityScore(atNoMiddle, btNoMiddle), 
      similarityScore(atNoMiddle, btReversedNoMiddle), 
      similarityScore(atReversedNoMiddle, btNoMiddle)
    );
  }
  
  // Levenshtein on full normalized names (distance-based fallback)
  const aFull = normalizePersonName(a);
  const bFull = normalizePersonName(b);
  const levenshteinScore = Math.max(0, 100 - (levenshtein(aFull, bFull) / Math.max(aFull.length, bFull.length)) * 100);
  best = Math.max(best, levenshteinScore);
  
  return Math.min(100, best);
}

function nameStatus(score: number, exact: boolean) {
  if (exact) return "Exact duplicate";
  if (score >= 95) return "Strong duplicate";
  if (score >= 85) return "Possible duplicate";
  if (score >= 75) return "Needs review";
  return "Not duplicate";
}

function firstLastMatchWithMiddleDifference(a: string, b: string) {
  const at = normalizePersonName(a).split(" ").filter(Boolean);
  const bt = normalizePersonName(b).split(" ").filter(Boolean);
  if (at.length < 2 || bt.length < 2) return false;
  const sameOrdered = at[0] === bt[0] && at[at.length - 1] === bt[bt.length - 1];
  const sameReversed = at[0] === bt[bt.length - 1] && at[at.length - 1] === bt[0];
  return (sameOrdered || sameReversed) && normalizePersonName(a) !== normalizePersonName(b);
}

function nameSupportingFields(input: NameRecord, candidate: NameRecord) {
  const matched: string[] = [];
  const notMatched: string[] = [];
  const compare = (label: string, left?: string, right?: string) => {
    const l = normalizeName(left || ""), r = normalizeName(right || "");
    if (!l || !r) return;
    if (l === r) matched.push(label);
    else notMatched.push(label);
  };
  compare("municipality", input.municipality, candidate.municipality);
  compare("barangay", input.barangay, candidate.barangay);
  compare("SLP Participant ID", input.participantId, candidate.participantId);
  compare("SLP Unique ID", input.slpUniqueId, candidate.slpUniqueId);
  compare("Project ID", input.projectId, candidate.projectId);
  compare("Fund Source", input.fundSource, candidate.fundSource);
  compare("sex", input.sex, candidate.sex);
  compare("birthdate", input.birthdate, candidate.birthdate);
  return { matched, notMatched };
}

type NameParts = { first: string; middle: string; last: string; tokens: string[]; normalizedFull: string };
type MatchOverrideDecision = "MATCH" | "NOT_MATCH" | "NEEDS_REVIEW";

function splitNameParts(value: string | Record<string, string>, headers: string[] = []): NameParts {
  const fromRow = typeof value !== "string";
  if (fromRow) {
    const row = value as Record<string, string>;
    const first = normalizePersonName(slpValue(row, headers, ["First Name", "Given Name"]));
    const middle = normalizePersonName(slpValue(row, headers, ["Middle Name", "Middle Initial"]));
    const last = normalizePersonName(slpValue(row, headers, ["Last Name", "Surname", "Family Name"]));
    const full = normalizePersonName([last, first, middle].filter(Boolean).join(" ") || slpFullName(row, headers));
    return { first, middle, last, tokens: full.split(" ").filter(Boolean), normalizedFull: full };
  }
  const normalizedFull = normalizePersonName(value);
  if (String(value || "").includes(",")) {
    const [lastRaw, restRaw = ""] = String(value).split(",", 2);
    const rest = normalizePersonName(restRaw).split(" ").filter(Boolean);
    const last = normalizePersonName(lastRaw);
    const first = rest[0] || "";
    const middle = rest.slice(1).join(" ");
    return { first, middle, last, tokens: normalizedFull.split(" ").filter(Boolean), normalizedFull };
  }
  const tokens = normalizedFull.split(" ").filter(Boolean);
  if (tokens.length <= 1) return { first: tokens[0] || "", middle: "", last: "", tokens, normalizedFull };
  return {
    first: tokens[0] || "",
    middle: tokens.length > 2 ? tokens.slice(1, -1).join(" ") : "",
    last: tokens[tokens.length - 1] || "",
    tokens,
    normalizedFull,
  };
}

function tokenSetSimilarity(a: string, b: string) {
  const left = new Set(normalizePersonName(a).split(" ").filter(Boolean));
  const right = new Set(normalizePersonName(b).split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;
  const intersection = Array.from(left).filter((token) => right.has(token)).length;
  return Math.round((2 * intersection / (left.size + right.size)) * 100);
}

function levenshteinSimilarity(a: string, b: string) {
  const left = normalizePersonName(a), right = normalizePersonName(b);
  if (!left || !right) return 0;
  return Math.max(0, Math.round((1 - levenshtein(left, right) / Math.max(left.length, right.length)) * 100));
}

function soundexLike(value: string) {
  const normalized = normalizePersonName(value).replace(/\b(de|del|dela|la|las|los|y)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const compact = normalized.replace(/ph/g, "f").replace(/[ckq]/g, "k").replace(/[sz]/g, "s").replace(/[bd]/g, "d").replace(/[mn]/g, "n").replace(/[aeiouhwy]/g, "");
  return `${normalized[0] || ""}${compact.slice(1)}`.slice(0, 8);
}

function phoneticSimilarity(a: string, b: string) {
  const left = soundexLike(a), right = soundexLike(b);
  if (!left || !right) return 0;
  if (left === right) return 100;
  return levenshteinSimilarity(left, right);
}

function classifyMatch(score: number, exact = false) {
  if (exact || score >= 95) return "EXACT MATCH";
  if (score >= 85) return "POSSIBLE DUPLICATE - HIGH";
  if (score >= 75) return "POSSIBLE DUPLICATE - REVIEW";
  if (score >= 60) return "WEAK SIMILARITY";
  return "NO MATCH";
}

function stableRecordId(record: NameRecord) {
  return normalizeName(record.participantId || record.slpUniqueId || record.projectId || record.sourceId || [record.normalized || record.fullName, record.municipality].join("|"));
}

function normalizePantawidStatus(value: any) {
  const normalized = normalizeMatchText(value);
  if (normalized === "yes") return "Pantawid Beneficiary";
  if (normalized === "no") return "Non-Pantawid";
  return "Unknown";
}

function matchOverrideKey(input: NameRecord, candidate: NameRecord) {
  const sourceAId = stableRecordId(input);
  const sourceBId = stableRecordId(candidate);
  const municipality = normalizeName(input.municipality || candidate.municipality || "");
  const fallback = normalizeName([input.normalized || input.fullName, candidate.normalized || candidate.fullName, municipality].join("|"));
  return crypto.createHash("sha1").update([sourceAId || fallback, sourceBId || fallback, municipality].join("::")).digest("hex");
}

function getMatchOverride(overrideKey: string) {
  if (!overrideKey) return null;
  return db.prepare("SELECT * FROM match_overrides WHERE override_key = ?").get(overrideKey) as any | null;
}

function saveMatchOverride(payload: {
  overrideKey: string;
  decision: MatchOverrideDecision;
  sourceAId?: string;
  sourceBId?: string;
  normalizedNameA?: string;
  normalizedNameB?: string;
  municipality?: string;
  details?: Record<string, any>;
}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO match_overrides (id, override_key, source_a_id, source_b_id, normalized_name_a, normalized_name_b, municipality, decision, details_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(override_key) DO UPDATE SET
      source_a_id = excluded.source_a_id,
      source_b_id = excluded.source_b_id,
      normalized_name_a = excluded.normalized_name_a,
      normalized_name_b = excluded.normalized_name_b,
      municipality = excluded.municipality,
      decision = excluded.decision,
      details_json = excluded.details_json,
      updated_at = excluded.updated_at
  `).run(
    randomId("match_override"),
    payload.overrideKey,
    payload.sourceAId || "",
    payload.sourceBId || "",
    payload.normalizedNameA || "",
    payload.normalizedNameB || "",
    payload.municipality || "",
    payload.decision,
    JSON.stringify(payload.details || {}),
    now,
    now,
  );
  return getMatchOverride(payload.overrideKey);
}

function explainMatch(details: ReturnType<typeof calculateMatchScore>) {
  if (details.overrideDecision === "MATCH") return ["cached user override confirmed this pair"];
  if (details.overrideDecision === "NEEDS_REVIEW") return ["cached user override marked this pair for review", ...details.reasons];
  const matched = details.reasons.length ? `Matched signals: ${details.reasons.join("; ")}` : "Matched signals: none";
  const notMatched = details.notMatchedSignals.length ? `Signals not matched: ${details.notMatchedSignals.join("; ")}` : "Signals not matched: none";
  return [matched, notMatched];
}

function calculateMatchScore(input: NameRecord, candidate: NameRecord, overrideDecision?: MatchOverrideDecision | "") {
  const reasons: string[] = [];
  const notMatchedSignals: string[] = [];
  const inputParts = splitNameParts(input.normalized || input.fullName);
  const candidateParts = splitNameParts(candidate.normalized || candidate.fullName);
  const exactId = Boolean(
    (input.participantId && candidate.participantId && normalizeName(input.participantId) === normalizeName(candidate.participantId)) ||
    (input.slpUniqueId && candidate.slpUniqueId && normalizeName(input.slpUniqueId) === normalizeName(candidate.slpUniqueId))
  );
  const exactName = Boolean(inputParts.normalizedFull && inputParts.normalizedFull === candidateParts.normalizedFull);
  const tokenScore = tokenSetSimilarity(inputParts.normalizedFull, candidateParts.normalizedFull);
  const fullScore = Math.max(...nameVariants(inputParts.normalizedFull).flatMap((left) => nameVariants(candidateParts.normalizedFull).map((right) => levenshteinSimilarity(left, right))), 0);
  const firstScore = Math.max(levenshteinSimilarity(inputParts.first, candidateParts.first), inputParts.first && candidateParts.first && inputParts.first[0] === candidateParts.first[0] ? 70 : 0);
  const lastScore = Math.max(levenshteinSimilarity(inputParts.last, candidateParts.last), levenshteinSimilarity(inputParts.last, candidateParts.first), levenshteinSimilarity(inputParts.first, candidateParts.last));
  const middleScore = inputParts.middle && candidateParts.middle ? levenshteinSimilarity(inputParts.middle, candidateParts.middle) : 0;
  const municipalityMatch = Boolean(input.municipality && candidate.municipality && normalizeName(input.municipality) === normalizeName(candidate.municipality));
  const barangayMatch = Boolean(input.barangay && candidate.barangay && normalizeName(input.barangay) === normalizeName(candidate.barangay));
  const phoneticScore = Math.max(phoneticSimilarity(inputParts.first, candidateParts.first), phoneticSimilarity(inputParts.last, candidateParts.last));
  const hasComparableId = Boolean((input.participantId || input.slpUniqueId) && (candidate.participantId || candidate.slpUniqueId));
  if (hasComparableId && !exactId) notMatchedSignals.push("available IDs did not match");
  if (!exactName) notMatchedSignals.push("normalized full name was not exact");
  if (inputParts.last && candidateParts.last && lastScore < 88) notMatchedSignals.push(`last-name similarity below high-confidence threshold (${lastScore}%)`);
  if (inputParts.first && candidateParts.first && firstScore < 88) notMatchedSignals.push(`first-name similarity below high-confidence threshold (${firstScore}%)`);
  if (input.municipality && candidate.municipality && !municipalityMatch) notMatchedSignals.push("municipality differs");
  if (input.barangay && candidate.barangay && !barangayMatch) notMatchedSignals.push("barangay differs");

  if (overrideDecision === "MATCH") {
    return { score: 100, classification: "EXACT MATCH", exact: true, duplicate: true, reasons: ["cached user override"], notMatchedSignals, strongSignals: ["cached user override"], overrideDecision, signals: { exactId, exactName, tokenScore, fullScore, firstScore, lastScore, middleScore, municipalityMatch, barangayMatch, phoneticScore } };
  }

  const strongSignals: string[] = [];
  if (exactId) { strongSignals.push("same SLP Participant ID / SLP Unique ID"); reasons.push("same SLP Participant ID / SLP Unique ID"); }
  if (exactName) { strongSignals.push("exact normalized name"); reasons.push("exact normalized name"); }
  if (tokenScore >= 90) { strongSignals.push("strong token overlap"); reasons.push(`strong token overlap (${tokenScore}%)`); }
  if (lastScore >= 88) { strongSignals.push("same or very similar last name"); reasons.push(`last-name similarity (${lastScore}%)`); }
  if (firstScore >= 88) { strongSignals.push("same or very similar first name"); reasons.push(`first-name similarity (${firstScore}%)`); }
  if (municipalityMatch) { strongSignals.push("same municipality"); reasons.push("same municipality"); }
  if (barangayMatch) { strongSignals.push("same barangay"); reasons.push("same barangay"); }
  if (fullScore >= 82) reasons.push(`typo/fuzzy full-name similarity (${fullScore}%)`);
  if (phoneticScore >= 85) reasons.push(`phonetic similarity (${phoneticScore}%)`);

  let score = 0;
  if (exactId) score = 100;
  else if (exactName) score = municipalityMatch || barangayMatch ? 98 : 84;
  else {
    score = Math.round(
      tokenScore * 0.28 +
      fullScore * 0.24 +
      lastScore * 0.18 +
      firstScore * 0.18 +
      middleScore * 0.04 +
      (municipalityMatch ? 5 : 0) +
      (barangayMatch ? 4 : 0) +
      (phoneticScore >= 85 ? 3 : 0)
    );
  }

  if (score > 85 && strongSignals.length < 2) score = Math.min(score, 84);
  if (!exactId && tokenScore < 65 && fullScore < 70) score = Math.min(score, 70);
  if (!exactId && firstScore < 55 && lastScore < 55) score = Math.min(score, 60);
  if (!exactId && firstScore >= 80 && lastScore < 55 && tokenScore < 70) score = Math.min(score, 60);
  if (!exactId && phoneticScore >= 85 && tokenScore < 65 && fullScore < 70) score = Math.min(score, 70);
  if (overrideDecision === "NEEDS_REVIEW") score = Math.max(score, 75);
  score = Math.max(0, Math.min(100, score));
  const automatedExact = exactId || (exactName && municipalityMatch);
  const classification = classifyMatch(score, automatedExact);
  return { score, classification, exact: automatedExact, duplicate: classification === "EXACT MATCH" || classification === "POSSIBLE DUPLICATE - HIGH", reasons, notMatchedSignals, strongSignals, overrideDecision, signals: { exactId, exactName, tokenScore, fullScore, firstScore, lastScore, middleScore, municipalityMatch, barangayMatch, phoneticScore } };
}

type EvaluatedNameMatch = NameRecord & {
  score: number;
  support: ReturnType<typeof nameSupportingFields>;
  scoreDetails: ReturnType<typeof calculateMatchScore>;
  overrideKey: string;
  override?: any;
  candidatePass: string;
};

function prefixLooksSimilar(a = "", b = "", length = 3) {
  const left = normalizePersonName(a), right = normalizePersonName(b);
  if (!left || !right) return false;
  const min = Math.min(length, left.length, right.length);
  if (min <= 1) return left[0] === right[0];
  return left.slice(0, min) === right.slice(0, min);
}

function exactIdMatch(input: NameRecord, candidate: NameRecord) {
  return Boolean(
    (input.participantId && candidate.participantId && normalizeName(input.participantId) === normalizeName(candidate.participantId)) ||
    (input.slpUniqueId && candidate.slpUniqueId && normalizeName(input.slpUniqueId) === normalizeName(candidate.slpUniqueId))
  );
}

function cheapCandidateScore(input: NameRecord, candidate: NameRecord) {
  const inputParts = splitNameParts(input.normalized || input.fullName);
  const candidateParts = splitNameParts(candidate.normalized || candidate.fullName);
  const municipalityMatch = Boolean(input.municipality && candidate.municipality && normalizeName(input.municipality) === normalizeName(candidate.municipality));
  const barangayMatch = Boolean(input.barangay && candidate.barangay && normalizeName(input.barangay) === normalizeName(candidate.barangay));
  const exactName = Boolean(inputParts.normalizedFull && inputParts.normalizedFull === candidateParts.normalizedFull);
  const tokenScore = tokenSetSimilarity(inputParts.normalizedFull, candidateParts.normalizedFull);
  const firstPrefix = prefixLooksSimilar(inputParts.first, candidateParts.first, 3);
  const lastPrefix = prefixLooksSimilar(inputParts.last, candidateParts.last, 3) || prefixLooksSimilar(inputParts.last, candidateParts.first, 3) || prefixLooksSimilar(inputParts.first, candidateParts.last, 3);
  const firstPhonetic = soundexLike(inputParts.first) && soundexLike(inputParts.first) === soundexLike(candidateParts.first);
  const lastPhonetic = soundexLike(inputParts.last) && (soundexLike(inputParts.last) === soundexLike(candidateParts.last) || soundexLike(inputParts.last) === soundexLike(candidateParts.first));
  const idExact = exactIdMatch(input, candidate);
  const score =
    (idExact ? 100 : 0) +
    (exactName ? 80 : 0) +
    Math.round(tokenScore * 0.6) +
    (municipalityMatch ? 16 : 0) +
    (barangayMatch ? 8 : 0) +
    (firstPrefix ? 10 : 0) +
    (lastPrefix ? 14 : 0) +
    (firstPhonetic ? 5 : 0) +
    (lastPhonetic ? 7 : 0);
  return { score, idExact, exactName, tokenScore, municipalityMatch, barangayMatch, firstPrefix, lastPrefix, firstPhonetic, lastPhonetic };
}

function sourceBackedNameRecords(records: NameRecord[]) {
  return records.filter((candidate) => candidate.normalized && candidate.sourceFile && candidate.row && candidate.sourceSystem);
}

function evaluateNameCandidate(record: NameRecord, candidate: NameRecord, candidatePass: string): EvaluatedNameMatch | null {
  const overrideKey = matchOverrideKey(record, candidate);
  const override = getMatchOverride(overrideKey);
  if (override?.decision === "NOT_MATCH") return null;
  const scoreDetails = calculateMatchScore(record, candidate, override?.decision || "");
  const support = nameSupportingFields(record, candidate);
  return { ...candidate, score: scoreDetails.score, support, scoreDetails, overrideKey, override, candidatePass };
}

function betterNameMatch(left: EvaluatedNameMatch | null, right: EvaluatedNameMatch | null) {
  if (!left) return right;
  if (!right) return left;
  if (right.score !== left.score) return right.score > left.score ? right : left;
  if (right.support.matched.length !== left.support.matched.length) return right.support.matched.length > left.support.matched.length ? right : left;
  return right.scoreDetails.strongSignals.length > left.scoreDetails.strongSignals.length ? right : left;
}

function bestFromCandidatePass(record: NameRecord, candidates: NameRecord[], passName: string) {
  let best: EvaluatedNameMatch | null = null;
  for (const candidate of candidates) {
    const evaluated = evaluateNameCandidate(record, candidate, passName);
    best = betterNameMatch(best, evaluated);
  }
  return best;
}

function findBestNameMatch(record: NameRecord, databaseRecords: NameRecord[]) {
  const candidates = sourceBackedNameRecords(databaseRecords);
  const rejectedOverrideKeys = new Set<string>();

  for (const candidate of candidates) {
    const overrideKey = matchOverrideKey(record, candidate);
    const override = getMatchOverride(overrideKey);
    if (override?.decision === "MATCH") return evaluateNameCandidate(record, candidate, "Cached override");
    if (override?.decision === "NOT_MATCH") rejectedOverrideKeys.add(overrideKey);
  }

  const available = candidates.filter((candidate) => !rejectedOverrideKeys.has(matchOverrideKey(record, candidate)));
  const pass1 = available.filter((candidate) => {
    const cheap = cheapCandidateScore(record, candidate);
    const barangayCompatible = cheap.barangayMatch || !record.barangay || !candidate.barangay;
    return cheap.municipalityMatch && barangayCompatible && (cheap.idExact || cheap.exactName || cheap.tokenScore >= 78 || cheap.firstPrefix || cheap.lastPrefix);
  }).sort((a, b) => cheapCandidateScore(record, b).score - cheapCandidateScore(record, a).score).slice(0, 250);

  let best = bestFromCandidatePass(record, pass1, "Pass 1: strong local candidates");
  if (best && best.score >= 85) return best;

  const pass2 = available.filter((candidate) => {
    const cheap = cheapCandidateScore(record, candidate);
    return cheap.municipalityMatch && (cheap.idExact || cheap.exactName || cheap.tokenScore >= 52 || cheap.firstPrefix || cheap.lastPrefix || cheap.firstPhonetic || cheap.lastPhonetic);
  }).sort((a, b) => cheapCandidateScore(record, b).score - cheapCandidateScore(record, a).score).slice(0, 350);

  best = betterNameMatch(best, bestFromCandidatePass(record, pass2, "Pass 2: wider municipality candidates"));
  if (best && best.score >= 85) return best;

  const pass3 = available
    .map((candidate) => ({ candidate, cheap: cheapCandidateScore(record, candidate) }))
    .filter(({ cheap }) => cheap.idExact || cheap.exactName || cheap.tokenScore >= 45 || cheap.firstPrefix || cheap.lastPrefix || cheap.firstPhonetic || cheap.lastPhonetic)
    .sort((a, b) => b.cheap.score - a.cheap.score)
    .slice(0, 500)
    .map(({ candidate }) => candidate);

  best = betterNameMatch(best, bestFromCandidatePass(record, pass3, "Pass 3: province-wide fallback"));
  return best;
}

function extractNameRecordsFromSources(sources: ReturnType<typeof loadSheetSources>, sourceFilter = ""): NameRecord[] {
  const records: NameRecord[] = [];
  for (const source of sources as any[]) {
    const classification = classifyDataSource(source.fileName || source.file_name || "", source.folder || "", source.sheetName || source.sheet_name || "", source.headers || [], source.file_type || "");
    const moduleTag = source.module || detectSlpModule(source);
    const dataset = moduleTag === "PERSONAL" ? "SLPIS" : moduleTag === "SLP_DPT_DATABASE" ? "SLP DPT" : registrySourceDisplayName(classification.sourceType);
    const sourceSystem = moduleTag === "PERSONAL" ? "SLPIS" : moduleTag === "SLP_DPT_DATABASE" ? "SLP DPT" : "Reference";
    const strictSourceLabel = /SLPIS Personal Module/i.test(sourceFilter) ? "SLPIS Personal Module" : /SLP DPT/i.test(sourceFilter) ? "SLP DPT" : sourceSystem;
    const hasSourceHeader = (aliases: string[]) => Boolean(findSlpColumn(source.headers || [], aliases));
    console.log("MATCH_REFERENCE_EXTRA_FIELDS", {
      source: strictSourceLabel,
      hasPantawidField: hasSourceHeader(["Is Pantawid?", "Is Pantawid", "Pantawid", "4Ps", "4Ps Beneficiary"]),
      hasHouseholdIdField: hasSourceHeader(["Household ID", "HH ID", "HHID", "Household No", "Household Number"]),
      hasTypeOfParticipantsField: hasSourceHeader(["Type of participants", "Type of participant", "Participant Type", "Type"]),
      sampleRecord: (source.rows || [])[0] || {}
    });
    for (const row of source.rows) {
      const built = buildFullName(row, source.headers);
      if (!built.fullName) continue;
      const participantId = slpValue(row, source.headers, ["Participant ID", "SLP Participant ID", "SLP Paricipant ID"]);
      const slpUniqueId = slpValue(row, source.headers, ["SLP UNIQUE ID", "SLP Unique ID", "Unique ID", "SLP ID"]);
      const fundSource = slpValue(row, source.headers, ["Fundsource", "Fund Source", "fund_source"]);
      const isPantawid = slpValue(row, source.headers, ["Is Pantawid?", "Is Pantawid", "Pantawid", "4Ps", "4Ps Beneficiary"]);
      const householdId = slpValue(row, source.headers, ["Household ID", "HH ID", "HHID", "Household No", "Household Number"]);
      const typeOfParticipant = slpValue(row, source.headers, ["Type of participants", "Type of participant", "Participant Type", "Type"]);
      const municipality = slpMunicipality(row, source.headers);
      const barangay = slpValue(row, source.headers, ["Barangay", "Brgy"]);
      records.push({
        row: Number(row.__rowNumber || 0),
        fullName: built.fullName,
        normalized: built.sufficient ? built.fullName : "",
        sourceFile: source.fileName || source.file_name || "",
        sheet: source.sheetName || source.sheet_name || "",
        notes: `${sourceFilter}${built.notes}`,
        participantId,
        slpUniqueId,
        fundSource,
        isPantawid,
        pantawidStatus: normalizePantawidStatus(isPantawid),
        householdId,
        typeOfParticipant,
        projectId: slpValue(row, source.headers, ["Project ID", "SLP Project ID", "Unique Project ID"]),
        enterpriseType: slpValue(row, source.headers, ["Enterprise Type", "Project Type", "Livelihood Project", "Type of Project", "Name of Project"]),
        sex: slpValue(row, source.headers, ["Sex", "Gender"]),
        birthdate: slpValue(row, source.headers, ["Birthdate", "Birth Date", "Birthday", "Date of Birth"]),
        municipality,
        barangay,
        dataset,
        source: strictSourceLabel,
        sourceModule: SLP_MODULE_LABELS[moduleTag as SlpModuleTag] || dataset,
        sourceSystem,
        sourceId: sourceSystem === "SLPIS" ? participantId : [slpUniqueId, fundSource].filter(Boolean).join(" / "),
      });
    }
  }
  return records;
}

function parseNameUpload(fileName = "", fileType = "", data = "", names = ""): NameRecord[] {
  if (data) {
    const buffer = Buffer.from(data, "base64");
    if (/csv|sheet|excel/i.test(fileType) || /\.(xlsx?|csv)$/i.test(fileName)) {
      const wb = XLSX.read(buffer, { type: "buffer" });
      const records: NameRecord[] = [];
      for (const sheetName of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sheetName], { header: 1, defval: "", raw: false });
        const parsed = rowsFromAoa(aoa);
        records.push(...extractNameRecordsFromSources([{ source: fileName, fileName, folder: "", sheetName, headers: parsed.headers, rows: parsed.rows, headerRowIndex: parsed.headerRowIndex, headerConfidence: parsed.headerConfidence, documentId: "", sourceFile: fileName } as any], ""));
      }
      return records;
    }
    names = buffer.toString("utf-8");
  }
  return String(names || "").split(/\r?\n/).map((line, index) => {
    const fullName = standardizeNameParts(line);
    const tokens = fullName.split(" ").filter(Boolean);
    return { row: index + 1, fullName, normalized: tokens.length >= 2 ? fullName : "", sourceFile: fileName || "Typed names", sheet: "Typed names", notes: tokens.length >= 2 ? "Typed full name" : "Insufficient data: only first name exists", dataset: "Input names", sourceSystem: "Input names" as const, sourceId: normalizeName(fullName) };
  }).filter((record) => record.fullName);
}

type DeepMatchReference = NameRecord & {
  referenceKey: string;
  strictSource: "SLPIS Personal Module" | "SLP DPT";
  normalizedFullName: string;
  normalizedLastName: string;
  normalizedFirstName: string;
  normalizedMiddleName: string;
  normalizedBirthdate: string;
  normalizedMunicipality: string;
  normalizedBarangay: string;
  normalizedSex: string;
  nameTokens: string[];
};

type DeepMatchInput = NameRecord & {
  normalizedFullName: string;
  normalizedLastName: string;
  normalizedFirstName: string;
  normalizedMiddleName: string;
  normalizedBirthdate: string;
  normalizedMunicipality: string;
  normalizedBarangay: string;
  normalizedSex: string;
  nameTokens: string[];
};

type DeepMatchJobState = {
  jobId: string;
  cancelled: boolean;
  inputRecords: DeepMatchInput[];
  references: DeepMatchReference[];
  indexes: ReturnType<typeof buildDeepMatchIndexes>;
  startedMs: number;
  nextIndex: number;
  counts: { exactCount: number; possibleCount: number; weakCount: number; noMatchCount: number; errorCount: number };
};

const activeDeepMatchJobs = new Map<string, DeepMatchJobState>();
const DEEP_MATCH_BATCH_SIZE = 50;
const DEEP_MATCH_RECORD_TIME_LIMIT_MS = 15000;
let strictMatchReferenceCache: { loadedAt: number; data: ReturnType<typeof loadStrictMatchReferenceSourcesUncached> } | null = null;

function normalizeMatchText(value: any) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s.'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMatchName(value: any) {
  return normalizeMatchText(value)
    .replace(/\b(?:mr|mrs|ms|miss|dr|hon|sir|madam)\.?\b/g, " ")
    .replace(/\b(?:jr|sr|ii|iii|iv|junior|senior)\.?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBirthdateValue(value: any) {
  const text = normalizeMatchText(value).replace(/\b0:00:00\b/g, "").trim();
  if (!text) return "";
  const parsed = new Date(String(value));
  if (!Number.isNaN(parsed.getTime()) && /[-/]|[a-z]/i.test(String(value))) return parsed.toISOString().slice(0, 10);
  return text;
}

function levenshteinDistance(a: string, b: string): number {
  const left = String(a || ""), right = String(b || "");
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = new Array(right.length + 1);
  const current = new Array(right.length + 1);
  for (let j = 0; j <= right.length; j++) previous[j] = j;
  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= right.length; j++) previous[j] = current[j];
  }
  return previous[right.length];
}

function levenshteinSimilarityDeep(a: string, b: string) {
  const left = normalizeMatchName(a);
  const right = normalizeMatchName(b);
  const maxLen = Math.max(left.length, right.length);
  if (maxLen === 0) return 100;
  const distance = levenshteinDistance(left, right);
  return Math.max(0, Math.round(((maxLen - distance) / maxLen) * 100));
}

function tokenSetSimilarityDeep(a: string | string[], b: string | string[]) {
  const leftTokens = Array.isArray(a) ? a : normalizeMatchName(a).split(" ").filter(Boolean);
  const rightTokens = Array.isArray(b) ? b : normalizeMatchName(b).split(" ").filter(Boolean);
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  if (!left.size || !right.size) return 0;
  const intersection = Array.from(left).filter((token) => right.has(token)).length;
  const dice = (2 * intersection / (left.size + right.size)) * 100;
  return Math.round(dice);
}

function deepNameParts(record: Partial<NameRecord> & Record<string, any>) {
  const fullName = record.fullName || record.name || "";
  let parts = splitNameParts(fullName || "");
  const explicitFirst = normalizeMatchName(record.firstName || record.first_name || "");
  const explicitMiddle = normalizeMatchName(record.middleName || record.middle_name || "");
  const explicitLast = normalizeMatchName(record.lastName || record.last_name || "");
  if (explicitFirst || explicitLast || explicitMiddle) {
    const normalizedFull = normalizeMatchName([explicitLast, explicitFirst, explicitMiddle].filter(Boolean).join(" ") || fullName);
    parts = { first: explicitFirst || parts.first, middle: explicitMiddle || parts.middle, last: explicitLast || parts.last, tokens: normalizedFull.split(" ").filter(Boolean), normalizedFull };
  }
  return {
    normalizedFullName: normalizeMatchName(parts.normalizedFull || fullName),
    normalizedFirstName: normalizeMatchName(parts.first),
    normalizedMiddleName: normalizeMatchName(parts.middle),
    normalizedLastName: normalizeMatchName(parts.last),
    nameTokens: normalizeMatchName(parts.normalizedFull || fullName).split(" ").filter(Boolean),
  };
}

function deepNormalizeRecord<T extends NameRecord>(record: T): T & DeepMatchInput {
  const parts = deepNameParts(record);
  return {
    ...record,
    normalized: parts.normalizedFullName,
    ...parts,
    normalizedBirthdate: normalizeBirthdateValue(record.birthdate),
    normalizedMunicipality: normalizeMatchText(record.municipality),
    normalizedBarangay: normalizeMatchText(record.barangay),
    normalizedSex: normalizeMatchText(record.sex),
  };
}

function strictReferenceSourceDetection(source: any) {
  const moduleLabel = SLP_MODULE_LABELS[(source.module || detectSlpModule(source)) as SlpModuleTag] || "";
  const classification = classifyDataSource(source.fileName || source.file_name || "", source.folder || "", source.sheetName || source.sheet_name || "", source.headers || [], source.file_type || "");
  const fileName = source.fileName || source.file_name || "";
  const originalFileName = source.originalFileName || source.original_file_name || "";
  const folder = source.folder || "";
  const headers = source.headers || [];
  const classificationText = normalizeMatchText([
    moduleLabel,
    classification.sourceType,
    source.classificationText,
    source.source_type,
    source.document_type,
    source.document_purpose,
    source.classification_reason,
  ].join(" "));
  const fileText = normalizeMatchText([fileName, originalFileName].join(" "));
  const folderText = normalizeMatchText(folder);
  const moduleText = normalizeMatchText(moduleLabel);
  const knownNonReferenceModule = /\b(project|training|grant utilization|gur|orgassessment|org assessment|mdannualassessment|annual assessment|mdmonitoring|md monitoring|orientation|association|slpa)\b/.test(fileText);
  const knownNonReferenceFolder = folderText === "templates" || folderText.includes("templates");
  const strongDptFileOrFolder = folderText.includes("slp dpt") || fileText.includes("slp aurora database") || fileText.includes("slp dpt") || /\bdpt\b/.test(fileText);
  const strongPersonalFileOrFolder = (folderText.includes("slpis") && fileText.includes("personal")) || fileText.includes("personal module") || fileText.includes("slpis personal");
  const checked = {
    fileName,
    originalFileName,
    folder,
    classification: classificationText || normalizeMatchText(classification.sourceType),
    moduleName: moduleLabel,
    sheetName: source.sheetName || source.sheet_name || "",
    headers,
  };
  const hasHeader = (label: string) => headers.some((header: string) => normalizeMatchText(header) === normalizeMatchText(label) || normalizeMatchText(header).includes(normalizeMatchText(label)));
  const dptReasons = [
    folderText.includes("slp dpt") ? "folder includes SLP DPT" : "",
    fileText.includes("slp aurora database") ? "file name includes SLP AURORA DATABASE" : "",
    fileText.includes("slp dpt") ? "file name includes SLP DPT" : "",
    /\bdpt\b/.test(fileText) ? "file name includes DPT" : "",
    !knownNonReferenceModule && classificationText.includes("slp_dpt") ? "classification includes SLP_DPT" : "",
    !knownNonReferenceModule && /\bdpt\b/.test(classificationText) ? "classification includes DPT" : "",
    !knownNonReferenceModule && hasHeader("SLP UNIQUE ID") ? "parsed headers include SLP UNIQUE ID" : "",
    !knownNonReferenceModule && hasHeader("Fund Source") ? "parsed headers include Fund Source" : "",
  ].filter(Boolean);
  const personalReasons = [
    folderText.includes("slpis") && fileText.includes("personal") ? "folder includes SLPIS and file name includes personal" : "",
    fileText.includes("personal module") ? "file name includes Personal module" : "",
    fileText.includes("slpis personal") ? "file name includes SLPIS Personal" : "",
    !knownNonReferenceModule && classificationText.includes("slpis_personal") ? "classification includes SLPIS_PERSONAL" : "",
    !knownNonReferenceModule && (/\bpersonal\b/.test(classificationText) || /\bpersonal\b/.test(moduleText)) ? "classification/module includes PERSONAL" : "",
    !knownNonReferenceModule && hasHeader("SLP Participant ID") ? "parsed headers include SLP Participant ID" : "",
    !knownNonReferenceModule && hasHeader("Is Pantawid?") ? "parsed headers include Is Pantawid?" : "",
    !knownNonReferenceModule && hasHeader("Sex") ? "parsed headers include Sex" : "",
    !knownNonReferenceModule && hasHeader("Civil Status") ? "parsed headers include Civil Status" : "",
    !knownNonReferenceModule && hasHeader("HEA") ? "parsed headers include HEA" : "",
  ].filter(Boolean);
  if ((knownNonReferenceModule || knownNonReferenceFolder) && !strongDptFileOrFolder && !strongPersonalFileOrFolder) {
    return {
      ...checked,
      detectedSourceType: "",
      accepted: false,
      reason: knownNonReferenceFolder
        ? "Rejected non-reference template folder; Match & Compare only uses SLP DPT and SLPIS Personal Module."
        : "Rejected known non-reference SLPIS module file; Match & Compare only uses SLP DPT and SLPIS Personal Module.",
      rowCount: (source.rows || []).length,
    };
  }
  const detectedSourceType: "SLPIS Personal Module" | "SLP DPT" | "" = dptReasons.length ? "SLP DPT" : personalReasons.length ? "SLPIS Personal Module" : "";
  const reason = detectedSourceType === "SLP DPT" ? dptReasons.join("; ") : detectedSourceType === "SLPIS Personal Module" ? personalReasons.join("; ") : "No SLP DPT or SLPIS Personal filename, folder, classification, module, or header evidence matched.";
  return {
    ...checked,
    detectedSourceType,
    accepted: Boolean(detectedSourceType),
    reason,
    rowCount: (source.rows || []).length,
  };
}

function strictReferenceSourceKind(source: any): "SLPIS Personal Module" | "SLP DPT" | "" {
  return strictReferenceSourceDetection(source).detectedSourceType as "SLPIS Personal Module" | "SLP DPT" | "";
}

function loadStrictMatchReferenceSourcesUncached() {
  const allSources = loadSlpModuleSources();
  const slpDptSources: any[] = [];
  const personalSources: any[] = [];
  const filesChecked: any[] = [];
  let ignoredReferenceRecords = 0;
  for (const source of allSources as any[]) {
    const detection = strictReferenceSourceDetection(source);
    const sourceKind = detection.detectedSourceType;
    const rowCount = (source.rows || []).length;
    filesChecked.push({
      fileName: detection.fileName,
      originalFileName: detection.originalFileName,
      folder: detection.folder,
      sheetName: detection.sheetName,
      classification: detection.classification,
      detectedSourceType: detection.detectedSourceType || "Ignored",
      accepted: detection.accepted,
      reason: detection.reason,
      rowCount,
    });
    if (sourceKind === "SLP DPT") slpDptSources.push(source);
    else if (sourceKind === "SLPIS Personal Module") personalSources.push(source);
    else ignoredReferenceRecords += rowCount;
  }
  const slpDptRecords = extractNameRecordsFromSources(slpDptSources, "Strict SLP DPT reference").map((record) => ({ ...deepNormalizeRecord(record), source: "SLP DPT", strictSource: "SLP DPT" as const, sourceSystem: "SLP DPT" as const, referenceKey: stableRecordId(record) }));
  const personalRecords = extractNameRecordsFromSources(personalSources, "Strict SLPIS Personal Module reference").map((record) => ({ ...deepNormalizeRecord(record), source: "SLPIS Personal Module", pantawidStatus: record.pantawidStatus || normalizePantawidStatus(record.isPantawid), strictSource: "SLPIS Personal Module" as const, sourceSystem: "SLPIS" as const, referenceKey: stableRecordId(record) }));
  return {
    slpDptRecords,
    personalRecords,
    references: [...slpDptRecords, ...personalRecords],
    summary: {
      slpDptReferenceRecords: slpDptRecords.length,
      slpisPersonalReferenceRecords: personalRecords.length,
      ignoredReferenceRecords,
      otherModulesIgnored: true,
      selectedSources: ["SLP_DPT", "SLPIS_PERSONAL"],
      totalUploadedIndexedFilesFound: new Set((allSources as any[]).map((source: any) => source.documentId || `${source.folder}/${source.fileName}`)).size,
      filesCheckedForMatchCompare: filesChecked,
    },
  };
}

function loadStrictMatchReferenceSources() {
  if (strictMatchReferenceCache && Date.now() - strictMatchReferenceCache.loadedAt < 2 * 60 * 1000) return strictMatchReferenceCache.data;
  const data = loadStrictMatchReferenceSourcesUncached();
  strictMatchReferenceCache = { loadedAt: Date.now(), data };
  return data;
}

function rawSheetValue(row: Record<string, string>, headers: string[], aliases: string[]) {
  const column = findSlpColumn(headers, aliases);
  return column ? getCell(row, column) : "";
}

function rawObjectValue(row: Record<string, any>, aliases: string[]) {
  const keys = Object.keys(row || {});
  const column = findSlpColumn(keys, aliases);
  return column ? String(row[column] ?? "").trim() : "";
}

function parseDeepMatchUploadInputs(fileName = "", fileType = "", data = "", names = ""): NameRecord[] {
  if (data) {
    const buffer = Buffer.from(data, "base64");
    if (/csv|sheet|excel/i.test(fileType) || /\.(xlsx?|csv)$/i.test(fileName)) {
      const wb = XLSX.read(buffer, { type: "buffer" });
      const records: NameRecord[] = [];
      for (const sheetName of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sheetName], { header: 1, defval: "", raw: false });
        const parsed = rowsFromAoa(aoa);
        for (const row of parsed.rows) {
          const built = buildFullName(row, parsed.headers);
          if (!built.fullName) continue;
          records.push({
            row: Number(row.__rowNumber || records.length + 1),
            fullName: built.fullName,
            normalized: built.sufficient ? built.fullName : "",
            sourceFile: fileName || "Uploaded input file",
            sheet: sheetName,
            notes: built.notes,
            birthdate: rawSheetValue(row, parsed.headers, ["Birthdate", "Birth Date", "Birthday", "Date of Birth"]),
            municipality: rawSheetValue(row, parsed.headers, ["Municipality", "City", "Mun", "City/Municipality", "Municipality/City"]),
            barangay: rawSheetValue(row, parsed.headers, ["Barangay", "Brgy", "Barangay Name", "Barangay / Brgy"]),
            sex: rawSheetValue(row, parsed.headers, ["Sex", "Gender"]),
            dataset: "Input names",
            sourceSystem: "Input names",
            sourceId: normalizeName([built.fullName, row.__rowNumber || ""].join("|")),
          });
        }
      }
      return records;
    }
    names = buffer.toString("utf-8");
  }
  return String(names || "").split(/\r?\n/).map((line, index) => {
    const fullName = standardizeNameParts(line);
    const tokens = fullName.split(" ").filter(Boolean);
    return { row: index + 1, fullName, normalized: tokens.length >= 2 ? fullName : "", sourceFile: fileName || "Typed names", sheet: "Typed names", notes: tokens.length >= 2 ? "Typed full name" : "Insufficient data: only first name exists", dataset: "Input names", sourceSystem: "Input names" as const, sourceId: normalizeName(fullName) };
  }).filter((record) => record.fullName);
}

function parseDeepMatchInputs(body: any): DeepMatchInput[] {
  const records: NameRecord[] = [];
  if (Array.isArray(body?.inputRecords)) {
    body.inputRecords.forEach((row: any, index: number) => {
      const fullName = row.fullName || row.name || row["Name / Full Name"] || row["Full Name"] || [row["Last Name"] || row.lastName, row["First Name"] || row.firstName, row["Middle Name"] || row.middleName].filter(Boolean).join(" ");
      if (!String(fullName || "").trim()) return;
      records.push({
        row: moneyValue(row.row || row.__rowNumber || index + 1),
        fullName: standardizeNameParts(fullName),
        normalized: standardizeNameParts(fullName),
        sourceFile: row.sourceFile || row.inputSourceFile || body.fileName || "Input records",
        sheet: "Input records",
        notes: "Uploaded input record",
        birthdate: rawObjectValue(row, ["Birthdate", "Birth Date", "Birthday", "Date of Birth"]),
        municipality: rawObjectValue(row, ["Municipality", "City", "Mun", "City/Municipality", "Municipality/City"]),
        barangay: rawObjectValue(row, ["Barangay", "Brgy", "Barangay Name", "Barangay / Brgy"]),
        sex: rawObjectValue(row, ["Sex", "Gender"]),
      });
    });
  }
  if (Array.isArray(body?.typedNames)) {
    body.typedNames.forEach((name: any) => {
      const fullName = standardizeNameParts(String(name || ""));
      if (fullName) records.push({ row: records.length + 1, fullName, normalized: fullName, sourceFile: "Typed names", sheet: "Typed names", notes: "Typed name", dataset: "Input names", sourceSystem: "Input names", sourceId: normalizeMatchName(fullName) });
    });
  }
  if (body?.names || body?.data) records.push(...parseDeepMatchUploadInputs(body.fileName, body.fileType, body.data, body.names));
  const seen = new Set<string>();
  return records
    .filter((record) => record.fullName)
    .map((record, index) => deepNormalizeRecord({ ...record, row: record.row || index + 1 }))
    .filter((record) => {
      const key = `${record.row}:${record.normalizedFullName}:${record.normalizedMunicipality}:${record.normalizedBirthdate}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildDeepMatchIndexes(references: DeepMatchReference[]) {
  const byFull = new Map<string, DeepMatchReference[]>();
  const byFirstLast = new Map<string, DeepMatchReference[]>();
  const byToken = new Map<string, DeepMatchReference[]>();
  const byMunicipality = new Map<string, DeepMatchReference[]>();
  const add = (map: Map<string, DeepMatchReference[]>, key: string, record: DeepMatchReference) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(record);
  };
  for (const record of references) {
    add(byFull, record.normalizedFullName, record);
    add(byFirstLast, `${record.normalizedLastName}|${record.normalizedFirstName}`, record);
    add(byFirstLast, `${record.normalizedFirstName}|${record.normalizedLastName}`, record);
    add(byMunicipality, record.normalizedMunicipality, record);
    for (const token of record.nameTokens) add(byToken, token, record);
  }
  return { byFull, byFirstLast, byToken, byMunicipality };
}

function uniqueRefs(records: DeepMatchReference[], limit = 800) {
  const seen = new Set<string>();
  const output: DeepMatchReference[] = [];
  for (const record of records) {
    const key = record.referenceKey || stableRecordId(record);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(record);
    if (output.length >= limit) break;
  }
  return output;
}

function candidateSetForInput(input: DeepMatchInput, references: DeepMatchReference[], indexes: ReturnType<typeof buildDeepMatchIndexes>) {
  const exact = indexes.byFull.get(input.normalizedFullName) || [];
  if (exact.length) return { candidates: uniqueRefs(exact, 500), phase: "Exact Matching" };
  const firstLast = [
    ...(indexes.byFirstLast.get(`${input.normalizedLastName}|${input.normalizedFirstName}`) || []),
    ...(indexes.byFirstLast.get(`${input.normalizedFirstName}|${input.normalizedLastName}`) || []),
  ];
  const tokenCandidates = input.nameTokens.flatMap((token) => indexes.byToken.get(token) || []);
  const localCandidates = input.normalizedMunicipality ? (indexes.byMunicipality.get(input.normalizedMunicipality) || []) : [];
  let merged = uniqueRefs([...firstLast, ...tokenCandidates, ...localCandidates], 1000);
  if (merged.length) return { candidates: merged, phase: "Candidate Search" };
  const tokenFallback = references
    .map((candidate) => ({ candidate, score: tokenSetSimilarityDeep(input.nameTokens, candidate.nameTokens) }))
    .filter((item) => item.score >= 35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 1000)
    .map((item) => item.candidate);
  if (tokenFallback.length) return { candidates: tokenFallback, phase: "Deep Fallback Scan" };
  return { candidates: references.slice(0, 1500), phase: "Deep Fallback Scan" };
}

function contextScoreAndSignals(input: DeepMatchInput, candidate: DeepMatchReference) {
  let score = 50;
  const signals: string[] = [];
  const penalties: string[] = [];
  const compare = (label: string, left: string, right: string, boost: number, penalty: number) => {
    if (!left || !right) return;
    if (left === right) { score += boost; signals.push(`same ${label}`); }
    else { score -= penalty; penalties.push(`different ${label}`); }
  };
  compare("birthdate", input.normalizedBirthdate, candidate.normalizedBirthdate, 32, 42);
  compare("municipality", input.normalizedMunicipality, candidate.normalizedMunicipality, 18, 18);
  compare("barangay", input.normalizedBarangay, candidate.normalizedBarangay, 10, 8);
  compare("sex", input.normalizedSex, candidate.normalizedSex, 5, 10);
  return { contextScore: Math.max(0, Math.min(100, score)), signals, penalties };
}

function deepScoreCandidate(input: DeepMatchInput, candidate: DeepMatchReference) {
  const fullNameLevenshteinScore = Math.max(
    levenshteinSimilarityDeep(input.normalizedFullName, candidate.normalizedFullName),
    ...nameVariants(input.normalizedFullName).flatMap((left) => nameVariants(candidate.normalizedFullName).map((right) => levenshteinSimilarityDeep(left, right)))
  );
  const tokenSetScore = tokenSetSimilarityDeep(input.nameTokens, candidate.nameTokens);
  const lastNameScore = Math.max(levenshteinSimilarityDeep(input.normalizedLastName, candidate.normalizedLastName), levenshteinSimilarityDeep(input.normalizedLastName, candidate.normalizedFirstName));
  const firstNameScore = Math.max(levenshteinSimilarityDeep(input.normalizedFirstName, candidate.normalizedFirstName), levenshteinSimilarityDeep(input.normalizedFirstName, candidate.normalizedLastName));
  const middleNameScore = input.normalizedMiddleName && candidate.normalizedMiddleName ? levenshteinSimilarityDeep(input.normalizedMiddleName, candidate.normalizedMiddleName) : 0;
  const context = contextScoreAndSignals(input, candidate);
  let finalScore = Math.round(
    fullNameLevenshteinScore * 0.45 +
    tokenSetScore * 0.25 +
    lastNameScore * 0.10 +
    firstNameScore * 0.10 +
    middleNameScore * 0.05 +
    context.contextScore * 0.05
  );
  const overlap = input.nameTokens.filter((token) => candidate.nameTokens.includes(token)).length;
  if (overlap <= 1 && !input.normalizedBirthdate) finalScore = Math.min(finalScore, 69);
  if (lastNameScore >= 90 && firstNameScore < 55 && tokenSetScore < 65) finalScore = Math.min(finalScore, 69);
  if (firstNameScore >= 90 && lastNameScore < 55 && tokenSetScore < 65) finalScore = Math.min(finalScore, 69);
  if (input.normalizedBirthdate && candidate.normalizedBirthdate && input.normalizedBirthdate !== candidate.normalizedBirthdate) finalScore = Math.min(finalScore - 25, 79);
  if (input.normalizedMunicipality && candidate.normalizedMunicipality && input.normalizedMunicipality !== candidate.normalizedMunicipality) finalScore = Math.min(finalScore - 10, 84);
  finalScore = Math.max(0, Math.min(100, finalScore));
  const exactLike = input.normalizedFullName === candidate.normalizedFullName && (!input.normalizedMunicipality || !candidate.normalizedMunicipality || input.normalizedMunicipality === candidate.normalizedMunicipality);
  const category = exactLike || finalScore >= 95 ? "Exact Match" : finalScore >= 85 ? "Possible Duplicate" : finalScore >= 70 ? "Weak Match / Needs Review" : "No Match";
  const reason = reasonForDeepMatch(category, { fullNameLevenshteinScore, tokenSetScore, middleNameScore, context, input, candidate, overlap });
  return { fullNameLevenshteinScore, tokenSetScore, lastNameScore, firstNameScore, middleNameScore, contextScore: context.contextScore, finalScore, category, reason, contextSignals: context.signals, contextPenalties: context.penalties, tokenOverlap: overlap };
}

function reasonForDeepMatch(category: string, input: any) {
  const { fullNameLevenshteinScore, tokenSetScore, middleNameScore, context, input: left, candidate, overlap } = input;
  const sameMunicipality = left.normalizedMunicipality && candidate.normalizedMunicipality && left.normalizedMunicipality === candidate.normalizedMunicipality;
  if (category === "Exact Match") return sameMunicipality ? "Normalized full name matched exactly with same municipality." : "Normalized full name matched exactly.";
  if (category === "Possible Duplicate") {
    if (middleNameScore > 0 && middleNameScore < 85) return "High Levenshtein and token-set similarity, same municipality, but middle name differs.";
    return `High Levenshtein (${fullNameLevenshteinScore}%) and token-set similarity (${tokenSetScore}%)${sameMunicipality ? ", same municipality" : ""}.`;
  }
  if (category === "Weak Match / Needs Review") {
    if (!sameMunicipality && left.normalizedMunicipality && candidate.normalizedMunicipality) return "Similar name tokens but municipality differs.";
    return `Similar name tokens need review; ${overlap} token(s) matched.`;
  }
  return context.penalties.length ? `No candidate reached the minimum threshold; ${context.penalties.join(", ")}.` : "No candidate reached the minimum threshold.";
}

function deepAddressMatchStatus(inputMunicipality = "", inputBarangay = "", matchedMunicipality = "", matchedBarangay = "") {
  const inputMuni = normalizeMatchText(inputMunicipality);
  const inputBrgy = normalizeMatchText(inputBarangay);
  const matchedMuni = normalizeMatchText(matchedMunicipality);
  const matchedBrgy = normalizeMatchText(matchedBarangay);
  if (!inputMuni && !inputBrgy) return "Input address missing";
  if (!matchedMuni && !matchedBrgy) return "Matched address missing";
  if (inputMuni && matchedMuni && inputMuni !== matchedMuni) return "Different municipality";
  if (inputMuni && matchedMuni && inputMuni === matchedMuni && inputBrgy && matchedBrgy && inputBrgy === matchedBrgy) return "Same municipality and barangay";
  if (inputMuni && matchedMuni && inputMuni === matchedMuni) return "Same municipality only";
  if (!inputMuni || !inputBrgy) return "Input address missing";
  if (!matchedMuni || !matchedBrgy) return "Matched address missing";
  return "Different municipality";
}

function householdIdForDisplay(pantawidStatus = "", householdId = "") {
  if (pantawidStatus !== "Pantawid Beneficiary") return "";
  return String(householdId || "").trim() || "No Household ID encoded.";
}

function resultFromDeepCandidate(jobId: string, input: DeepMatchInput, best: DeepMatchReference | null, scored: any[], timeLimited = false) {
  const top = scored.slice(0, 3);
  const bestScore = top[0]?.score || null;
  const score = bestScore?.finalScore || 0;
  const category = timeLimited && score >= 70 ? "Weak Match / Needs Review" : bestScore?.category || "No Match";
  const reason = timeLimited ? `${bestScore?.reason || "Best candidate kept."} Needs Review - time limited.` : bestScore?.reason || "No candidate reached the minimum threshold.";
  const showBest = Boolean(best && score >= 70);
  const matchedMunicipality = showBest ? best?.municipality || "" : "";
  const matchedBarangay = showBest ? best?.barangay || "" : "";
  const matchedPantawidStatus = showBest && best?.strictSource === "SLPIS Personal Module" ? best?.pantawidStatus || normalizePantawidStatus(best?.isPantawid) : "";
  const matchedHouseholdId = showBest && best?.strictSource === "SLPIS Personal Module" ? householdIdForDisplay(matchedPantawidStatus, best?.householdId || "") : "";
  const matchedTypeOfParticipant = showBest && best?.strictSource === "SLP DPT" ? best?.typeOfParticipant || "" : "";
  const candidatePayload = top.map(({ candidate, score }: any) => ({
    candidateName: candidate.fullName,
    source: candidate.strictSource,
    id: candidate.strictSource === "SLPIS Personal Module" ? candidate.participantId : candidate.slpUniqueId,
    slpParticipantId: candidate.participantId || "",
    slpUniqueId: candidate.slpUniqueId || "",
    fundSource: candidate.fundSource || "",
    isPantawid: candidate.strictSource === "SLPIS Personal Module" ? candidate.isPantawid || "" : "",
    pantawidStatus: candidate.strictSource === "SLPIS Personal Module" ? candidate.pantawidStatus || normalizePantawidStatus(candidate.isPantawid) : "",
    householdId: candidate.strictSource === "SLPIS Personal Module" ? householdIdForDisplay(candidate.pantawidStatus || normalizePantawidStatus(candidate.isPantawid), candidate.householdId || "") : "",
    typeOfParticipant: candidate.strictSource === "SLP DPT" ? candidate.typeOfParticipant || "" : "",
    municipality: candidate.municipality || "",
    barangay: candidate.barangay || "",
    birthdate: candidate.birthdate || "",
    sex: candidate.sex || "",
    score: score.finalScore,
    reason: score.reason,
  }));
  const result = {
    id: randomId("match_result"),
    jobId,
    rowNumber: input.row,
    inputName: input.fullName,
    inputSourceFile: input.sourceFile || "",
    inputMunicipality: input.municipality || "",
    inputBarangay: input.barangay || "",
    inputBirthdate: input.birthdate || "",
    inputSex: input.sex || "",
    matchedName: showBest ? best?.fullName || "" : "",
    source: showBest ? best?.strictSource || "" : "",
    slpParticipantId: showBest ? best?.participantId || "" : "",
    slpUniqueId: showBest ? best?.slpUniqueId || "" : "",
    fundSource: showBest ? best?.fundSource || "" : "",
    isPantawid: showBest && best?.strictSource === "SLPIS Personal Module" ? best?.isPantawid || "" : "",
    pantawidStatus: matchedPantawidStatus,
    householdId: matchedHouseholdId,
    typeOfParticipant: matchedTypeOfParticipant,
    municipality: matchedMunicipality,
    barangay: matchedBarangay,
    birthdate: showBest ? best?.birthdate || "" : "",
    sex: showBest ? best?.sex || "" : "",
    finalScore: score,
    category,
    reason,
    scoreBreakdownJson: JSON.stringify(bestScore || {}),
    topCandidatesJson: JSON.stringify(candidatePayload),
    status: timeLimited ? "Needs Review - time limited" : category,
  };
  console.log("MATCH_RESULT_EXTRA_DETAILS", {
    inputName: result.inputName,
    matchedName: result.matchedName,
    source: result.source,
    pantawidStatus: result.pantawidStatus,
    householdId: result.householdId,
    typeOfParticipant: result.typeOfParticipant,
    fundSource: result.fundSource
  });
  return result;
}

function findManualFeedbackOverride(input: DeepMatchInput, references: DeepMatchReference[]) {
  const rows = db.prepare("SELECT * FROM match_feedback WHERE feedback IN ('correct', 'manual_link') ORDER BY createdAt DESC LIMIT 1000").all() as any[];
  const inputNorm = input.normalizedFullName;
  for (const row of rows) {
    if (normalizeMatchName(row.inputName) !== inputNorm) continue;
    const matchedNorm = normalizeMatchName(row.matchedName);
    const sourceNorm = normalizeMatchText(row.source);
    const corrected = normalizeMatchText(row.correctedRecordId);
    const candidate = references.find((ref) =>
      (matchedNorm && ref.normalizedFullName === matchedNorm) ||
      (corrected && normalizeMatchText(ref.participantId || ref.slpUniqueId || ref.referenceKey) === corrected) ||
      (sourceNorm && normalizeMatchText(ref.strictSource) === sourceNorm && matchedNorm && ref.normalizedFullName === matchedNorm)
    );
    if (candidate) return candidate;
  }
  return null;
}

function deepMatchOne(jobId: string, input: DeepMatchInput, references: DeepMatchReference[], indexes: ReturnType<typeof buildDeepMatchIndexes>) {
  const started = Date.now();
  const manual = findManualFeedbackOverride(input, references);
  if (manual) {
    const score = deepScoreCandidate(input, manual);
    score.finalScore = 100;
    score.category = "Exact Match";
    score.reason = "Confirmed manual feedback override matched this record.";
    return resultFromDeepCandidate(jobId, input, manual, [{ candidate: manual, score }]);
  }
  const { candidates } = candidateSetForInput(input, references, indexes);
  const scored: any[] = [];
  let timeLimited = false;
  for (const candidate of candidates) {
    if (Date.now() - started > DEEP_MATCH_RECORD_TIME_LIMIT_MS) { timeLimited = true; break; }
    scored.push({ candidate, score: deepScoreCandidate(input, candidate) });
  }
  scored.sort((a, b) => b.score.finalScore - a.score.finalScore);
  if (!scored.length) return resultFromDeepCandidate(jobId, input, null, [], timeLimited);
  return resultFromDeepCandidate(jobId, input, scored[0].candidate, scored, timeLimited);
}

function insertDeepMatchResult(result: any) {
  console.log("MATCH_INPUT_ADDRESS_PRESERVED", {
    inputName: result.inputName || "",
    inputMunicipality: result.inputMunicipality || "",
    inputBarangay: result.inputBarangay || "",
    matchedName: result.matchedName || "",
    matchedMunicipality: result.municipality || "",
    matchedBarangay: result.barangay || "",
    addressMatchStatus: deepAddressMatchStatus(result.inputMunicipality || "", result.inputBarangay || "", result.municipality || "", result.barangay || "")
  });
  db.prepare(`INSERT INTO match_results (
    id, jobId, rowNumber, inputName, inputSourceFile, inputMunicipality, inputBarangay, inputBirthdate, inputSex,
    matchedName, source, slpParticipantId, slpUniqueId, fundSource, isPantawid, pantawidStatus, householdId, typeOfParticipant, municipality, barangay, birthdate, sex,
    finalScore, category, reason, scoreBreakdownJson, topCandidatesJson, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    result.id, result.jobId, result.rowNumber, result.inputName, result.inputSourceFile || "", result.inputMunicipality, result.inputBarangay, result.inputBirthdate, result.inputSex,
    result.matchedName, result.source, result.slpParticipantId, result.slpUniqueId, result.fundSource, result.isPantawid || "", result.pantawidStatus || "", result.householdId || "", result.typeOfParticipant || "", result.municipality, result.barangay, result.birthdate, result.sex,
    result.finalScore, result.category, result.reason, result.scoreBreakdownJson, result.topCandidatesJson, result.status
  );
}

function jobCountsForResult(category: string) {
  return {
    exactCount: category === "Exact Match" ? 1 : 0,
    possibleCount: category === "Possible Duplicate" ? 1 : 0,
    weakCount: category === "Weak Match / Needs Review" || /^Error/.test(category) ? 1 : 0,
    noMatchCount: category === "No Match" ? 1 : 0,
    errorCount: /^Error/.test(category) ? 1 : 0,
  };
}

function updateDeepMatchProgress(state: DeepMatchJobState, phase: string) {
  const elapsedMs = Date.now() - state.startedMs;
  const processed = state.nextIndex;
  const estimatedRemainingMs = processed > 0 ? Math.round((elapsedMs / processed) * Math.max(0, state.inputRecords.length - processed)) : 0;
  db.prepare(`UPDATE match_jobs SET status = ?, processed = ?, exactCount = ?, possibleCount = ?, weakCount = ?, noMatchCount = ?, errorCount = ?, currentPhase = ?, updatedAt = ?, elapsedMs = ?, estimatedRemainingMs = ? WHERE jobId = ?`)
    .run(state.cancelled ? "cancelled" : "running", processed, state.counts.exactCount, state.counts.possibleCount, state.counts.weakCount, state.counts.noMatchCount, state.counts.errorCount, phase, new Date().toISOString(), elapsedMs, estimatedRemainingMs, state.jobId);
  console.log("MATCH_COMPARE_DEEP_PROGRESS", {
    jobId: state.jobId,
    processed,
    total: state.inputRecords.length,
    percent: state.inputRecords.length ? Math.round((processed / state.inputRecords.length) * 100) : 100,
    ...state.counts,
    currentPhase: phase,
    elapsedMs,
    estimatedRemainingMs,
  });
}

function runDeepMatchBatch(jobId: string) {
  const state = activeDeepMatchJobs.get(jobId);
  if (!state) return;
  const persisted = db.prepare("SELECT status FROM match_jobs WHERE jobId = ?").get(jobId) as any;
  if (persisted?.status === "cancelled" || state.cancelled) {
    state.cancelled = true;
    db.prepare("UPDATE match_jobs SET status = 'cancelled', currentPhase = 'Cancelled', cancelledAt = ?, updatedAt = ? WHERE jobId = ?").run(new Date().toISOString(), new Date().toISOString(), jobId);
    activeDeepMatchJobs.delete(jobId);
    return;
  }
  updateDeepMatchProgress(state, "Levenshtein Scoring");
  const end = Math.min(state.inputRecords.length, state.nextIndex + DEEP_MATCH_BATCH_SIZE);
  for (; state.nextIndex < end; state.nextIndex++) {
    const input = state.inputRecords[state.nextIndex];
    try {
      const result = input.normalizedFullName.split(" ").filter(Boolean).length < 2
        ? { id: randomId("match_result"), jobId, rowNumber: input.row, inputName: input.fullName, inputSourceFile: input.sourceFile || "", inputMunicipality: input.municipality || "", inputBarangay: input.barangay || "", inputBirthdate: input.birthdate || "", inputSex: input.sex || "", matchedName: "", source: "", slpParticipantId: "", slpUniqueId: "", fundSource: "", isPantawid: "", pantawidStatus: "", householdId: "", typeOfParticipant: "", municipality: "", barangay: "", birthdate: "", sex: "", finalScore: 0, category: "No Match", reason: "No candidate reached the minimum threshold.", scoreBreakdownJson: "{}", topCandidatesJson: "[]", status: "No Match" }
        : deepMatchOne(jobId, input, state.references, state.indexes);
      insertDeepMatchResult(result);
      const inc = jobCountsForResult(result.category);
      state.counts.exactCount += inc.exactCount;
      state.counts.possibleCount += inc.possibleCount;
      state.counts.weakCount += inc.weakCount;
      state.counts.noMatchCount += inc.noMatchCount;
      state.counts.errorCount += inc.errorCount;
      if (state.nextIndex === 0) console.log("MATCH_COMPARE_DEEP_SAMPLE_RESULT", result);
    } catch (err: any) {
      const result = { id: randomId("match_result"), jobId, rowNumber: input.row, inputName: input.fullName, inputSourceFile: input.sourceFile || "", inputMunicipality: input.municipality || "", inputBarangay: input.barangay || "", inputBirthdate: input.birthdate || "", inputSex: input.sex || "", matchedName: "", source: "", slpParticipantId: "", slpUniqueId: "", fundSource: "", isPantawid: "", pantawidStatus: "", householdId: "", typeOfParticipant: "", municipality: "", barangay: "", birthdate: "", sex: "", finalScore: 0, category: "Error / Needs Review", reason: err?.message || "Row error; continued job.", scoreBreakdownJson: "{}", topCandidatesJson: "[]", status: "Error / Needs Review" };
      insertDeepMatchResult(result);
      state.counts.weakCount += 1;
      state.counts.errorCount += 1;
    }
  }
  updateDeepMatchProgress(state, state.nextIndex >= state.inputRecords.length ? "Saving Results" : "Candidate Search");
  if (state.nextIndex >= state.inputRecords.length) {
    const now = new Date().toISOString();
    const durationMs = Date.now() - state.startedMs;
    db.prepare("UPDATE match_jobs SET status = 'completed', currentPhase = 'Completed', completedAt = ?, updatedAt = ?, elapsedMs = ?, estimatedRemainingMs = 0 WHERE jobId = ?").run(now, now, durationMs, jobId);
    console.log("MATCH_COMPARE_DEEP_COMPLETE", { jobId, total: state.inputRecords.length, ...state.counts, durationMs });
    activeDeepMatchJobs.delete(jobId);
    return;
  }
  setTimeout(() => runDeepMatchBatch(jobId), 25);
}

function matchJobProgress(jobId: string) {
  const job = db.prepare("SELECT * FROM match_jobs WHERE jobId = ?").get(jobId) as any;
  if (!job) return null;
  const percent = job.total ? Math.round((Number(job.processed || 0) / Number(job.total || 0)) * 100) : 0;
  return {
    ...job,
    percent,
    sourceSummary: parseJson(job.sourceSummaryJson, {}),
  };
}

function matchResultsForJob(jobId: string) {
  return (db.prepare("SELECT * FROM match_results WHERE jobId = ? ORDER BY rowNumber ASC, createdAt ASC").all(jobId) as any[]).map((row) => ({
    ...row,
    scoreBreakdown: parseJson(row.scoreBreakdownJson, {}),
    topCandidates: parseJson(row.topCandidatesJson, []),
    addressMatchStatus: deepAddressMatchStatus(row.inputMunicipality || "", row.inputBarangay || "", row.municipality || "", row.barangay || ""),
  }));
}

app.get("/api/match/reference-summary", (_req, res) => {
  try {
    const loaded = loadStrictMatchReferenceSources();
    console.log("MATCH_COMPARE_REFERENCE_DETECTION", {
      totalUploadedIndexedFilesFound: loaded.summary.totalUploadedIndexedFilesFound,
      filesCheckedForMatchCompare: loaded.summary.filesCheckedForMatchCompare,
      slpDptReferenceRecords: loaded.summary.slpDptReferenceRecords,
      slpisPersonalReferenceRecords: loaded.summary.slpisPersonalReferenceRecords,
    });
    res.json(loaded.summary);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/match/active", (_req, res) => {
  try {
    const job = db.prepare("SELECT * FROM match_jobs WHERE status IN ('queued', 'running') ORDER BY startedAt DESC LIMIT 1").get() as any;
    res.json({ job: job ? matchJobProgress(job.jobId) : null });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/match/history", (_req, res) => {
  try {
    const jobs = (db.prepare(`
      SELECT jobId, status, total, processed, exactCount, possibleCount, weakCount, noMatchCount, errorCount, currentPhase, startedAt, updatedAt, completedAt, cancelledAt, elapsedMs
      FROM match_jobs
      ORDER BY startedAt DESC
      LIMIT 20
    `).all() as any[]).map((job) => ({
      ...job,
      percent: job.total ? Math.round((Number(job.processed || 0) / Number(job.total || 0)) * 100) : 0,
    }));
    res.json({ jobs });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/match/start", async (req, res) => {
  try {
    const inputRecords = parseDeepMatchInputs(req.body || {});
    if (!inputRecords.length) return res.status(400).json({ error: "Upload a name list or type names." });
    const loaded = loadStrictMatchReferenceSources();
    if (!loaded.slpDptRecords.length && !loaded.personalRecords.length) {
      return res.status(400).json({ error: "Reference sources are missing. Please upload or process SLP DPT and SLPIS Personal Module first.", sourceSummary: loaded.summary });
    }
    const jobId = randomId("match_job");
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO match_jobs (jobId, status, total, processed, currentPhase, startedAt, updatedAt, sourceSummaryJson) VALUES (?, 'running', ?, 0, 'Normalizing', ?, ?, ?)`)
      .run(jobId, inputRecords.length, now, now, JSON.stringify(loaded.summary));
    db.prepare("DELETE FROM match_results WHERE jobId = ?").run(jobId);
    const state: DeepMatchJobState = {
      jobId,
      cancelled: false,
      inputRecords,
      references: loaded.references,
      indexes: buildDeepMatchIndexes(loaded.references),
      startedMs: Date.now(),
      nextIndex: 0,
      counts: { exactCount: 0, possibleCount: 0, weakCount: 0, noMatchCount: 0, errorCount: 0 },
    };
    activeDeepMatchJobs.set(jobId, state);
    console.log("MATCH_COMPARE_DEEP_START", {
      totalInputRecords: inputRecords.length,
      slpDptReferenceRecords: loaded.summary.slpDptReferenceRecords,
      slpisPersonalReferenceRecords: loaded.summary.slpisPersonalReferenceRecords,
      ignoredReferenceRecords: loaded.summary.ignoredReferenceRecords,
      selectedSources: ["SLP_DPT", "SLPIS_PERSONAL"],
    });
    setTimeout(() => runDeepMatchBatch(jobId), 10);
    res.status(202).json({ jobId, sourceSummary: loaded.summary });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/match/progress/:jobId", (req, res) => {
  try {
    const progress = matchJobProgress(req.params.jobId);
    if (!progress) return res.status(404).json({ error: "Match job not found." });
    res.json({ progress });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/match/results/:jobId", (req, res) => {
  try {
    const progress = matchJobProgress(req.params.jobId);
    if (!progress) return res.status(404).json({ error: "Match job not found." });
    res.json({ progress, results: matchResultsForJob(req.params.jobId) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/match/cancel/:jobId", (req, res) => {
  try {
    const jobId = req.params.jobId;
    const state = activeDeepMatchJobs.get(jobId);
    if (state) state.cancelled = true;
    const now = new Date().toISOString();
    db.prepare("UPDATE match_jobs SET status = 'cancelled', currentPhase = 'Cancelled', cancelledAt = ?, updatedAt = ? WHERE jobId = ? AND status IN ('queued', 'running')").run(now, now, jobId);
    res.json({ success: true, progress: matchJobProgress(jobId) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/match/feedback", (req, res) => {
  try {
    const { inputName = "", matchedName = "", source = "", feedback = "", correctedRecordId = "", notes = "" } = req.body || {};
    if (!["correct", "wrong", "not_sure", "manual_link"].includes(String(feedback))) return res.status(400).json({ error: "Invalid feedback." });
    const id = randomId("match_feedback");
    db.prepare("INSERT INTO match_feedback (id, inputName, matchedName, source, feedback, correctedRecordId, notes) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, inputName, matchedName, source, feedback, correctedRecordId, notes);
    res.json({ success: true, id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/name-match", async (req, res) => {
  try {
    const { fileName, fileType = "application/octet-stream", data, names } = req.body;
    if (!data && !names) return res.status(400).json({ error: "Upload a name list or type names." });
    const inputRecords = parseNameUpload(fileName, fileType, data, names);
    const referenceSources = sourcesForModules(loadSlpModuleSources(), ["PERSONAL", "SLP_DPT_DATABASE"]);
    const databaseRecords = extractNameRecordsFromSources(referenceSources, "Indexed reference dataset");
    const results = inputRecords.map((record) => {
      if (!record.normalized) {
        return { row: record.row, name: record.fullName, fullName: record.fullName, status: "Insufficient data", classification: "NO MATCH", duplicate: false, matchedDocuments: [], matchPercentage: "0%", confidence: "0%", notes: record.notes, explanation: record.notes };
      }
      const best = findBestNameMatch(record, databaseRecords);
      const score = best?.score || 0;
      const classification = best?.scoreDetails.classification || "NO MATCH";
      const showMatch = Boolean(best && score >= 60 && best.sourceFile && best.row && best.sourceSystem);
      const status = showMatch ? classification : "NO MATCH";
      const explanation = best && showMatch ? `${best.candidatePass}. ${explainMatch(best.scoreDetails).join("; ")}` : "No reliable reference match found.";
      const sourceId = best && showMatch ? (best.sourceSystem === "SLPIS" ? best.participantId || "" : [best.slpUniqueId, best.fundSource].filter(Boolean).join(" / ")) : "";
      return {
        row: record.row,
        name: record.fullName,
        fullName: record.fullName,
        status,
        classification,
        duplicate: showMatch && (classification === "EXACT MATCH" || classification === "POSSIBLE DUPLICATE - HIGH"),
        matchedDocuments: best && showMatch ? [`${best.sourceSystem || best.dataset || "Reference"}: ${best.sourceFile} / ${best.sheet} row ${best.row}`] : [],
        matchedRow: best && showMatch ? best.row : "",
        bestMatch: best && showMatch ? best.fullName : "",
        matchedName: best && showMatch ? best.fullName : "",
        sourceDataset: best && showMatch ? best.dataset || "Indexed reference dataset" : "",
        sourceSystem: best && showMatch ? best.sourceSystem || "" : "",
        sourceModule: best && showMatch ? best.sourceModule || "" : "",
        sourceFile: best && showMatch ? best.sourceFile || "" : "",
        sourceRowNumber: best && showMatch ? best.row || "" : "",
        sourceId,
        slpParticipantId: best && showMatch ? best.participantId || "" : "",
        slpUniqueId: best && showMatch ? best.slpUniqueId || "" : "",
        fundSource: best && showMatch ? best.fundSource || "" : "",
        projectId: best && showMatch ? best.projectId || "" : "",
        enterpriseType: best && showMatch ? best.enterpriseType || "" : "",
        municipality: best && showMatch ? best.municipality || "" : "",
        barangay: best && showMatch ? best.barangay || "" : "",
        confidence: `${score}%`,
        matchPercentage: `${score}%`,
        score,
        duplicateType: status,
        whyMatched: best && showMatch ? explanation : "",
        explanation,
        whyNotExact: best?.scoreDetails.exact ? "" : best && showMatch ? `Not exact because ${[...best.scoreDetails.notMatchedSignals, ...best.support.notMatched].filter(Boolean).join(", ") || "no exact ID or exact normalized same-municipality name match was found"}.` : "No reliable reference match found.",
        supportingFieldsMatched: best && showMatch ? best.support.matched : [],
        supportingFieldsNotMatched: best && showMatch ? [...best.scoreDetails.notMatchedSignals, ...best.support.notMatched] : [],
        overrideKey: best && showMatch ? best.overrideKey : "",
        userDecision: best?.override?.decision || "",
        userConfirmed: Boolean(best?.override?.decision === "MATCH"),
        notes: showMatch ? `Matched against ${best?.sourceSystem || best?.dataset || "reference"} / ${best?.sourceFile || ""} / ${best?.sheet || ""} row ${best?.row || ""}. ${best?.override?.decision ? "User-confirmed decision applied." : ""}` : "No source-backed SLPIS or SLP DPT match at 60% or higher.",
      };
    });
    const summary = {
      total: results.length,
      duplicates: results.filter((r: any) => r.classification === "EXACT MATCH" || r.classification === "POSSIBLE DUPLICATE - HIGH").length,
      exactDuplicates: results.filter((r: any) => r.classification === "EXACT MATCH").length,
      possible: results.filter((r: any) => /POSSIBLE DUPLICATE/.test(r.classification)).length,
      unique: results.filter((r: any) => r.classification === "NO MATCH" || r.classification === "WEAK SIMILARITY").length,
      insufficient: results.filter((r: any) => r.status === "Insufficient data").length,
      referenceDatasets: ["SLPIS Personal Module", "SLP DPT / Aurora Database"],
    };
    res.json({ results, summary });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/name-match/override", async (req, res) => {
  try {
    const { overrideKey, decision, sourceAId, sourceBId, normalizedNameA, normalizedNameB, municipality, details } = req.body || {};
    const normalizedDecision = String(decision || "").toUpperCase().replace(/\s+/g, "_") as MatchOverrideDecision;
    if (!overrideKey) return res.status(400).json({ error: "overrideKey is required." });
    if (!["MATCH", "NOT_MATCH", "NEEDS_REVIEW"].includes(normalizedDecision)) return res.status(400).json({ error: "decision must be MATCH, NOT_MATCH, or NEEDS_REVIEW." });
    const saved = saveMatchOverride({
      overrideKey: String(overrideKey),
      decision: normalizedDecision,
      sourceAId: String(sourceAId || ""),
      sourceBId: String(sourceBId || ""),
      normalizedNameA: String(normalizedNameA || ""),
      normalizedNameB: String(normalizedNameB || ""),
      municipality: String(municipality || ""),
      details: details || {},
    });
    res.json({ success: true, override: saved });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// =========================
// ADMIN ROUTES
// =========================
async function requireAdmin(adminId: string) { const admin = getLocalProfileById(adminId); return admin?.role === "admin" && admin?.status === "approved"; }

app.get("/api/admin/users", async (req, res) => {
  try {
    const adminId = String(req.query.adminId || ""), status = String(req.query.status || "all");
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    const data = status === "all" ? db.prepare("SELECT id, email, full_name, role, status, created_at, updated_at FROM profiles ORDER BY created_at DESC").all() : db.prepare("SELECT id, email, full_name, role, status, created_at, updated_at FROM profiles WHERE status = ? ORDER BY created_at DESC").all(status);
    const pending = (await readPendingRegistrations()).filter(r => status === "all" || r.status === status).map(r => ({ id: r.id, email: r.email, full_name: r.full_name, role: r.role, status: r.status, created_at: r.created_at, updated_at: r.updated_at }));
    res.json({ users: [...pending, ...data] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/admin/users", async (req, res) => {
  try {
    const { adminId, email, password, fullName = "", role = "user", status = "approved" } = req.body;
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const existing = getLocalProfileByEmail(email); const now = new Date().toISOString();
    if (existing) { db.prepare("UPDATE profiles SET password_hash = ?, full_name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?").run(hashPassword(password), fullName, role, status, now, existing.id); }
    else { db.prepare("INSERT INTO profiles (id, email, password_hash, full_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(randomId("user"), email.trim().toLowerCase(), hashPassword(password), fullName, role, status, now, now); }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.put("/api/admin/users", async (req, res) => {
  try {
    const { adminId, userId, action, role, status, password } = req.body;
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    if (userId.startsWith("pending:")) {
      const pending = await readPendingRegistrations();
      const p = pending.find(r => r.id === userId);
      if (!p) return res.status(404).json({ error: "Not found" });
      if (action === "reject" || status === "rejected") { p.status = "rejected"; await writePendingRegistrations(pending); return res.json({ success: true }); }
      if (action === "approve" || status === "approved") {
        if (String(p.password).length < 6) return res.status(400).json({ error: "Set password first" });
        const now = new Date().toISOString();
        db.prepare("INSERT INTO profiles (id, email, password_hash, full_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?)").run(userId, p.email, hashPassword(p.password), p.full_name, role || "user", p.created_at || now, now);
        await writePendingRegistrations(pending.filter(r => r.id !== userId));
        return res.json({ success: true });
      }
    }
    const existing = getLocalProfileById(userId);
    if (!existing) return res.status(404).json({ error: "User not found" });
    const updates: string[] = [], params: any[] = [];
    if (action === "approve" || status === "approved") { updates.push("status = 'approved'"); }
    if (action === "reject" || status === "rejected") { updates.push("status = 'rejected'"); }
    if (role) { updates.push("role = ?"); params.push(role); }
    if (password) { updates.push("password_hash = ?"); params.push(hashPassword(password)); }
    if (updates.length) { db.prepare(`UPDATE profiles SET ${updates.join(", ")}, updated_at = ? WHERE id = ?`).run(...params, new Date().toISOString(), userId); }
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/admin/users/:id", async (req, res) => {
  try {
    const adminId = String(req.query.adminId || ""), { id } = req.params;
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    if (adminId === id) return res.status(400).json({ error: "Cannot delete own account" });
    if (id.startsWith("pending:")) { const p = await readPendingRegistrations(); await writePendingRegistrations(p.filter(r => r.id !== id)); return res.json({ success: true }); }
    db.prepare("DELETE FROM profiles WHERE id = ?").run(id); res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/stats", async (req, res) => {
  try {
    const adminId = String(req.query.adminId || "");
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    const s = (sql: string, ...p: any[]) => Number(db.prepare(sql).get(...p)?.count || 0);
    const pending = await readPendingRegistrations();
    const localEmails = new Set(db.prepare("SELECT lower(email) AS email FROM profiles").all().map((r: any) => r.email));
    const pendingFileCount = pending.filter(r => r.status === "pending" && !localEmails.has(r.email.toLowerCase())).length;
    res.json({ stats: { totalUsers: s("SELECT COUNT(*) AS count FROM profiles") + pendingFileCount, approvedUsers: s("SELECT COUNT(*) AS count FROM profiles WHERE status = ?", "approved"), pendingUsers: s("SELECT COUNT(*) AS count FROM profiles WHERE status = ?", "pending") + pendingFileCount, adminUsers: s("SELECT COUNT(*) AS count FROM profiles WHERE role = ?", "admin"), totalDocuments: s("SELECT COUNT(*) AS count FROM documents"), totalChats: s("SELECT COUNT(*) AS count FROM chat_logs") } });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/faq-analytics", async (req, res) => {
  try {
    const adminId = String(req.query.adminId || ""), search = String(req.query.search || ""), category = String(req.query.category || "all"), sort = String(req.query.sort || "most");
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    const orderBy = sort === "newest" ? "last_asked_at DESC" : sort === "category" ? "category ASC, ask_count DESC" : "ask_count DESC, last_asked_at DESC";
    const where: string[] = []; const params: any[] = [];
    if (search) { where.push("(normalized_question LIKE ? OR original_question_sample LIKE ?)"); params.push(`%${search.toLowerCase()}%`, `%${search}%`); }
    if (category && category !== "all") { where.push("category = ?"); params.push(category); }
    const rows = db.prepare(`SELECT id, normalized_question, original_question_sample, category, ask_count, last_asked_at, created_at FROM faq_analytics ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${orderBy} LIMIT 200`).all(...params);
    const cats = db.prepare("SELECT DISTINCT category FROM faq_analytics ORDER BY category ASC").all();
    res.json({ success: true, items: rows.map((r: any) => ({ id: r.id, question_topic: r.original_question_sample, ask_count: r.ask_count, last_asked_at: r.last_asked_at, category: r.category, normalized_question: r.normalized_question, original_question_sample: r.original_question_sample })), faqs: rows, categories: cats.map((r: any) => r.category) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/app-settings", (_req, res) => { const row = db.prepare("SELECT * FROM app_settings WHERE id = 'global'").get(); res.json({ settings: { app_logo_url: row?.app_logo_url || "", updated_by: row?.updated_by || "", updated_at: row?.updated_at || "" } }); });

app.put("/api/admin/app-settings/logo", async (req, res) => {
  try {
    const { adminId, logoUrl = "" } = req.body;
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    const now = new Date().toISOString();
    db.prepare("INSERT INTO app_settings (id, app_logo_url, updated_by, updated_at) VALUES ('global', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET app_logo_url = excluded.app_logo_url, updated_by = excluded.updated_by, updated_at = excluded.updated_at").run(logoUrl, adminId, now);
    const row = db.prepare("SELECT * FROM app_settings WHERE id = 'global'").get();
    res.json({ success: true, settings: { app_logo_url: row?.app_logo_url || "", updated_by: row?.updated_by || "", updated_at: row?.updated_at || "" } });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// =========================
// MODEL PROVIDER ADMIN ROUTES
// =========================
app.get("/api/models/settings", (_req, res) => {
  try {
    res.json({
      baseUrl: process.env.GITHUB_MODELS_BASE_URL || "https://models.github.ai/inference",
      router: approvedModelForRole("router", process.env.GITHUB_ROUTER_MODEL || "openai/gpt-4.1-mini"),
      main: approvedModelForRole("main", process.env.GITHUB_MAIN_MODEL || "openai/gpt-4.1"),
      dataAnalysis: approvedModelForRole("dataAnalysis", process.env.GITHUB_DATA_ANALYSIS_MODEL || "openai/gpt-4.1"),
      chartRecommendation: approvedModelForRole("chartRecommendation", process.env.GITHUB_CHART_RECOMMENDATION_MODEL || "openai/gpt-4.1"),
      verification: approvedModelForRole("verification", process.env.GITHUB_VERIFICATION_MODEL || "openai/gpt-4.1-mini"),
      vision: approvedModelForRole("vision", process.env.GITHUB_VISION_MODEL || "openai/gpt-4o"),
      fallback: approvedModelForRole("fallback", process.env.GITHUB_FALLBACK_MODEL || "openai/gpt-4.1-mini"),
      timeoutMs: Number(process.env.GITHUB_MODELS_TIMEOUT_MS || 120000),
      loadedFrom: "env",
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/models/catalog", async (req, res) => {
  try {
    const adminId = String(req.query.adminId || "");
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    const catalogModels = await fetchGitHubModelsCatalog();
    res.json({ success: true, models: catalogModels.map((model) => model.id).filter(Boolean), catalogModels });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/model-settings", async (req, res) => {
  try {
    const adminId = String(req.query.adminId || "");
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    let catalogModels: any[] = [];
    let catalogError = "";
    try {
      catalogModels = await fetchGitHubModelsCatalog();
    } catch (error: any) {
      catalogError = error.message || String(error);
    }
    const settings = getModelSettings();
    res.json({
      success: true,
      ...modelSettingsResponse(settings),
      settings,
      roles: MODEL_ROLES,
      provider: "GitHub Models",
      catalogModels: catalogModels.map((model) => model.id).filter(Boolean),
      catalogError,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/admin/model-settings/save", async (req, res) => {
  try {
    const { adminId, settings = {} } = req.body;
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    const saved = saveModelSettings(settings, adminId);
    res.json({ success: true, settings: saved });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

async function testModelRole(role: ModelRole, settings: GitHubModelSettings, catalogIds?: Set<string>) {
  const configuredModel = settings.roles[role]?.model || getGitHubModelForRole(role);
  const started = Date.now();
  const inCatalog = !catalogIds?.size || catalogIds.has(configuredModel);
  if (!inCatalog) {
    return {
      role,
      model: configuredModel,
      selectedModel: "",
      configuredModel,
      fallbackUsed: false,
      status: role === "vision" ? "Vision disabled" : "Failed",
      responseTime: 0,
      error: `${configuredModel} is not in the GitHub Models catalog.`,
    };
  }
  try {
    const prompt = role === "vision" ? "Reply with OK only. No image is provided for this health check." : "Reply with OK only.";
    const result = await callGitHubModelId(configuredModel, role, [{ role: "user", content: prompt }], {
      baseUrl: settings.baseUrl,
      temperature: 0,
      maxTokens: 12,
      timeoutMs: Math.min(settings.timeoutMs || 90000, 30000),
    });
    return {
      role,
      model: result.model,
      selectedModel: result.model,
      configuredModel,
      fallbackUsed: false,
      status: result.content ? "Reachable" : "Empty response",
      responseTime: result.responseTimeMs,
      error: "",
    };
  } catch (error: any) {
    const errorText = String(error.message || error);
    const rateLimited = /\b429\b|rate.?limit|too many requests/i.test(errorText);
    return {
      role,
      model: configuredModel,
      selectedModel: "",
      configuredModel,
      fallbackUsed: false,
      status: rateLimited ? "Rate limited" : role === "vision" ? "Vision disabled" : "Failed",
      responseTime: Date.now() - started,
      error: errorText,
    };
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.post("/api/admin/test-all-models", async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    let catalogModels: any[] = [];
    let catalogError = "";
    try {
      catalogModels = await fetchGitHubModelsCatalog();
    } catch (error: any) {
      catalogError = error.message || String(error);
    }
    const catalogIds = new Set(catalogModels.map((model) => String(model.id || "")).filter(Boolean));
    const requestedSettings = req.body?.settings ? normalizeModelSettings(req.body.settings, "database") : getModelSettings();
    const effectiveSettings = requestedSettings;
    const results = [];
    for (const role of MODEL_ROLES) {
      results.push(await testModelRole(role, effectiveSettings, catalogIds));
      await delay(900);
    }
    const roleStatus = Object.fromEntries(results.map((row) => [row.role, {
      model: row.model,
      configuredModel: row.configuredModel,
      selectedModel: row.selectedModel,
      fallbackUsed: row.fallbackUsed,
      installed: row.status === "Reachable" || row.status === "Rate limited",
      status: row.status,
      responseTime: row.responseTime,
      error: row.error,
    }]));
    const persistable = results.every((row) => row.status === "Reachable" || row.status === "Rate limited");
    const savedSettings = persistable ? saveModelSettings(effectiveSettings, adminId) : effectiveSettings;
    res.json({
      success: true,
      results,
      roleStatus,
      settings: savedSettings,
      saved: persistable,
      catalogError,
      message: "GitHub Models checked for all configured roles.",
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/admin/memory/clear", async (req, res) => {
  try {
    const { adminId, userId } = req.body || {};
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    const targetUser = String(userId || adminId || "");
    const result = targetUser
      ? db.prepare("DELETE FROM chat_memory WHERE user_id = ?").run(targetUser)
      : db.prepare("DELETE FROM chat_memory").run();
    insertAuditLog({ userId: adminId, action: "clear_memory", feature: "admin", details: { targetUser, deleted: result.changes } });
    res.json({ success: true, deleted: result.changes });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/audit-logs", async (req, res) => {
  try {
    const adminId = String(req.query.adminId || "");
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    const rows = db.prepare("SELECT a.*, p.email FROM audit_logs a LEFT JOIN profiles p ON p.id = a.user_id ORDER BY a.created_at DESC LIMIT 300").all();
    res.json({ success: true, logs: rows.map((row: any) => ({ id: row.id, created_at: row.created_at, user: row.email || row.user_id || "-", action: row.action, feature: row.feature || "", file: row.file_name || row.file_id || "", details: row.details_json ? JSON.stringify(JSON.parse(row.details_json)) : "" })) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// =========================
// DEBUG ROUTES
// =========================
app.get("/api/debug/routes", (req, res) => res.json({ success: true, routes: ["GET /api/debug/index-status", "GET /api/debug/data-inventory", "GET /api/debug/retrieval-test?adminId=...&q=...", "GET /api/debug/retrieval-logs?adminId=..."] }));
app.get("/api/debug/index-status", (_req, res) => {
  try {
    const filesBySourceType = db.prepare(`
      SELECT COALESCE(source_type, 'UNKNOWN') AS source_type, COUNT(*) AS file_count
      FROM original_file_metadata
      GROUP BY COALESCE(source_type, 'UNKNOWN')
      ORDER BY file_count DESC, source_type ASC
    `).all();
    const documentsWithChunkCount = db.prepare(`
      SELECT d.id, d.file_name, d.folder, COALESCE(m.source_type, '') AS source_type,
             COUNT(c.id) AS chunk_count, d.updated_at
      FROM documents d
      LEFT JOIN document_chunks c ON c.document_id = d.id
      LEFT JOIN original_file_metadata m ON m.document_id = d.id OR m.file_id = d.id
      GROUP BY d.id
      ORDER BY d.updated_at DESC
      LIMIT 500
    `).all();
    const chunkRows = db.prepare(`
      SELECT c.id, c.document_id, c.chunk_index, c.content, d.file_name
      FROM document_chunks c
      LEFT JOIN documents d ON d.id = c.document_id
    `).all() as any[];
    const chunksMissingHeading = chunkRows.filter((chunk) => {
      const firstLine = String(chunk.content || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
      return !looksLikeHeading(firstLine);
    }).length;
    const csvXlsxTablesCreated = db.prepare(`
      SELECT us.id AS sheet_id, d.file_name, d.folder, us.sheet_name,
             us.row_count, us.headers_json, us.created_at, us.updated_at
      FROM uploaded_sheets us
      LEFT JOIN documents d ON d.id = us.document_id
      ORDER BY us.updated_at DESC
    `).all().map((row: any) => ({
      sheetId: row.sheet_id,
      fileName: row.file_name,
      folder: row.folder,
      sheetName: row.sheet_name,
      sourceType: sourceTypeForFolder(row.folder || "", row.file_name || "", ""),
      rowCount: row.row_count,
      columns: safeJsonArray(row.headers_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row: any) => row.name);
    const tableNamesAndRowCounts = tableNames.map((name: string) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { tableName: name, rowCount: null };
      const count = db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as any;
      return { tableName: name, rowCount: Number(count?.count || 0) };
    });
    const lastIndexed = db.prepare(`
      SELECT MAX(value) AS last_indexed_time FROM (
        SELECT MAX(updated_at) AS value FROM documents
        UNION ALL SELECT MAX(updated_at) AS value FROM uploaded_sheets
        UNION ALL SELECT MAX(updated_at) AS value FROM original_file_metadata
      )
    `).get() as any;
    res.json({
      success: true,
      filesBySourceType,
      documentsWithChunkCount,
      chunksMissingHeading,
      csvXlsxTablesCreated,
      tableNamesAndRowCounts,
      lastIndexedTime: lastIndexed?.last_indexed_time || null,
    });
  } catch (err: any) {
    console.error("Debug index status failed:", err);
    res.status(500).json({ success: false, error: err.message || "Debug index status failed." });
  }
});
app.get("/api/debug/data-inventory", async (req, res) => {
  const adminId = String(req.query.adminId || "");
  if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
  const rows = db.prepare("SELECT id, file_name, folder, content_text, created_at FROM documents WHERE content_text IS NOT NULL AND length(content_text) > 0 ORDER BY created_at DESC LIMIT ?").all(RAG_KEYWORD_SCAN_LIMIT);
  const cached = await readLocalDocumentCache();
  const seen = new Set<string>();
  const allDocs = [...rows, ...cached].filter((r: any) => r.content_text && !seen.has(r.id) && seen.add(r.id));
  const inventory = allDocs.map((doc: any) => {
    const sheets = parseXlsxContent(doc.content_text || "", { fileName: doc.file_name, folder: doc.folder, file_type: doc.file_type });
    return sheets.length ? sheets.map(s => ({ file: doc.file_name, folder: doc.folder || "", sheet: s.sheetName, row_count: s.rows.length, headers: s.headers.slice(0, 10), sample: s.rows.slice(0, 2) })) : [{ file: doc.file_name, folder: doc.folder || "", sheet: "text", row_count: 0, headers: [], sample: [] }];
  }).flat();
  res.json({ success: true, items: inventory });
});
app.get("/api/debug/retrieval-logs", async (req, res) => {
  const adminId = String(req.query.adminId || "");
  if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
  res.json({ success: true, items: lastRetrievalDebug ? [lastRetrievalDebug] : [] });
});
app.get("/api/debug/retrieval-test", async (req, res) => {
  const adminId = String(req.query.adminId || "");
  if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
  const sources = loadSlpModuleSources();
  const personal = sourcesForModules(sources, ["PERSONAL"]);
  const firstPerson = slpRows(personal).map(({ row, source }) => {
    const headers = source.headers || [];
    return slpFullName(row, headers) || slpParticipantId(row, headers);
  }).find(Boolean);
  const q = String(req.query.q || (firstPerson ? `What is the project of ${firstPerson}?` : "Show indexed modules"));
  const parsed = parseQuery(q);
  const lookup = buildRowLookupAnswer(q, parsed, sources);
  const modules = lookup?.debug.selectedModules || deterministicModuleRoute(q, parsed);
  const matchedRows = extractRowsForDebug(q, parsed, modules as SlpModuleTag[]);
  res.json({
    success: true,
    question: q,
    intentDetected: lookup?.debug.intent || classifySlpIntent(q) || parsed.intentType,
    modulesChecked: modules,
    queryUsed: `SQLite sheet_rows via deterministic module route; filters=${JSON.stringify(extractStrictFilters(q, parsed))}`,
    rowsMatched: matchedRows.length,
    reasonSelectedSourceWon: lookup?.debug.answerType || "debug route only",
    filesChecked: sourcesForModules(sources, modules as SlpModuleTag[]).map(sourceDisplayName),
    matchedRows,
    deterministicAnswerPreview: lookup?.answer || "",
  });
});
app.get("/api/debug/pdf-extraction-status", async (req, res) => {
  const adminId = String(req.query.adminId || "");
  if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
  const rows = db.prepare("SELECT d.id, d.file_name, d.folder, s.pages_processed, s.text_length, s.tables_extracted, s.ocr_needed, s.updated_at FROM pdf_extraction_status s JOIN documents d ON d.id = s.document_id ORDER BY s.updated_at DESC LIMIT 50").all();
  res.json({ success: true, items: rows.map((r: any) => ({ document_id: r.id, file_name: r.file_name, folder: r.folder || "", pages_processed: r.pages_processed || 0, extracted_text_length: r.text_length || 0, tables_extracted: r.tables_extracted || 0, ocr_needed: Boolean(r.ocr_needed), updated_at: r.updated_at })) });
});

function saveFeedbackLog(body: any) {
  const { question = "", answer = "", feedbackType = "", feedback_type = "", user_feedback = "", retrievedSources = [], retrieved_sources_json = "" } = body || {};
  const type = String(feedbackType || feedback_type || user_feedback || "").toLowerCase();
  if (!question || !answer || !/^(up|down|thumbs_up|thumbs_down|like|dislike|\+1|-1|\u{1f44d}|\u{1f44e})$/u.test(type)) throw new Error("question, answer, and feedbackType are required.");
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO feedback (id, question, answer, feedback_type, timestamp) VALUES (?, ?, ?, ?, ?)").run(randomId("feedback"), String(question), String(answer), type, timestamp);
  const sourcesJson = retrieved_sources_json || JSON.stringify(retrievedSources?.length ? retrievedSources : (lastRetrievalDebug?.matchedRows || []));
  db.prepare("INSERT INTO feedback_log (id, question, answer, user_feedback, timestamp, retrieved_sources_json) VALUES (?, ?, ?, ?, ?, ?)").run(randomId("feedbacklog"), String(question), String(answer), type, timestamp, String(sourcesJson || "[]"));
  console.log(`[FEEDBACK_RECEIVED] ${JSON.stringify({ question, feedbackType: type, sourceCount: safeJsonArray(String(sourcesJson || "[]")).length })}`);
  if (/down|dislike|-1|\u{1f44e}/u.test(type)) console.log(`[FEEDBACK_FAILURE_RECORDED] ${JSON.stringify({ question, answerPreview: String(answer).slice(0, 300), retrievedChunks: lastRetrievalDebug?.matchedRows || [] })}`);
}

app.post("/api/feedback", async (req, res) => {
  try {
    saveFeedbackLog(req.body);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Feedback save failed." });
  }
});

app.post("/api/feedback/answer", async (req, res) => {
  try {
    const { question = "", answer = "", rating = "", feedbackType = "", correctionId = "", notes = "", sourceCorrection = "", createdBy = "" } = req.body || {};
    if (!question || !answer) return res.status(400).json({ error: "question and answer are required." });
    const normalizedType = String(feedbackType || rating || "feedback").toLowerCase();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO answer_feedback (id, createdAt, question, answer, rating, feedbackType, correctionId, notes, sourceCorrection, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomId("answerfb"), now, String(question), String(answer), String(rating || ""), normalizedType, String(correctionId || ""), String(notes || ""), String(sourceCorrection || ""), String(createdBy || ""));
    if (/wrong|down|bad|incorrect|needs_review|review/i.test(normalizedType)) {
      db.prepare("UPDATE retrieval_logs SET feedbackType = ? WHERE id = (SELECT id FROM retrieval_logs WHERE userQuestion = ? ORDER BY createdAt DESC LIMIT 1)")
        .run(normalizedType, String(question));
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Answer feedback save failed." });
  }
});

app.post("/api/feedback/teach", async (req, res) => {
  try {
    const {
      originalQuestion = "",
      question = "",
      correctAnswer = "",
      correctSourceFile = "",
      correctFolder = "",
      correctModule = "",
      notes = "",
      createdBy = "",
    } = req.body || {};
    const sourceQuestion = String(originalQuestion || question || "").trim();
    if (!sourceQuestion || !String(correctAnswer || "").trim()) return res.status(400).json({ error: "originalQuestion and correctAnswer are required." });
    const id = randomId("override");
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO answer_overrides (
        id, createdAt, originalQuestion, normalizedQuestion, correctAnswer, correctSourceFile,
        correctFolder, correctModule, notes, createdBy, isActive
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      id,
      now,
      sourceQuestion,
      normalizedQuestionKey(sourceQuestion),
      String(correctAnswer),
      String(correctSourceFile || ""),
      String(correctFolder || ""),
      String(correctModule || ""),
      String(notes || ""),
      String(createdBy || "")
    );
    db.prepare("INSERT INTO answer_feedback (id, createdAt, question, answer, rating, feedbackType, correctionId, notes, sourceCorrection, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomId("answerfb"), now, sourceQuestion, String(correctAnswer), "correction", "wrong", id, String(notes || ""), JSON.stringify({ correctSourceFile, correctFolder, correctModule }), String(createdBy || ""));
    res.json({ success: true, correctionId: id });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Teaching correction save failed." });
  }
});

app.get("/api/admin/retrieval-logs", async (req, res) => {
  try {
    const adminId = String(req.query.adminId || "");
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    const where: string[] = [];
    const params: any[] = [];
    const date = String(req.query.date || "");
    const dateFrom = String(req.query.dateFrom || req.query.date_from || "");
    const dateTo = String(req.query.dateTo || req.query.date_to || "");
    const status = String(req.query.status || "");
    const folder = String(req.query.folder || "");
    const module = String(req.query.module || "");
    const lowConfidence = String(req.query.lowConfidence || req.query.low_confidence || "") === "true";
    const refused = String(req.query.refused || "") === "true";
    const fallbackUsed = String(req.query.fallbackUsed || req.query.fallback_used || "") === "true";
    const wrongFeedback = String(req.query.wrongAnswerFeedback || req.query.wrong_answer_feedback || "") === "true";
    if (date) {
      where.push("createdAt >= ? AND createdAt < datetime(?, '+1 day')");
      params.push(date, date);
    }
    if (dateFrom) { where.push("createdAt >= ?"); params.push(dateFrom); }
    if (dateTo) { where.push("createdAt <= ?"); params.push(dateTo); }
    if (status) { where.push("answerStatus = ?"); params.push(status); }
    if (lowConfidence) where.push("(confidenceScore < 0.45 OR answerStatus = 'low_confidence')");
    if (refused) where.push("answerStatus = 'refused_no_evidence'");
    if (fallbackUsed) where.push("(fallbackUsed = 1 OR keywordFallbackUsed = 1)");
    if (wrongFeedback) where.push("feedbackType IS NOT NULL AND feedbackType != ''");
    if (folder) { where.push("(foldersSearchedJson LIKE ? OR filesSearchedJson LIKE ? OR foldersSearched LIKE ?)"); params.push(`%${folder}%`, `%${folder}%`, `%${folder}%`); }
    if (module) { where.push("(modulesSearchedJson LIKE ? OR modulesSearched LIKE ?)"); params.push(`%${module}%`, `%${module}%`); }
    const rows = db.prepare(`
      SELECT * FROM retrieval_logs
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY createdAt DESC
      LIMIT 500
    `).all(...params) as any[];
    res.json({ success: true, items: rows.map((row) => ({
      ...row,
      answerUsedRetrievedEvidence: Boolean(row.answerUsedRetrievedEvidence),
      fallbackUsed: Boolean(row.fallbackUsed || row.keywordFallbackUsed),
      keywordFallbackUsed: Boolean(row.keywordFallbackUsed),
      foldersSearched: safeJsonArray(row.foldersSearchedJson || row.foldersSearched),
      modulesSearched: safeJsonArray(row.modulesSearchedJson || row.modulesSearched),
      filesSearched: safeJsonArray(row.filesSearchedJson || row.foldersSearched),
      topChunks: safeJsonArray(row.topChunksJson),
      topRows: safeJsonArray(row.topRowsJson),
      topScores: safeJsonArray(row.topScoresJson),
      selectedSources: safeJsonArray(row.selectedSourcesJson),
      keywordFallbackTerms: safeJsonArray(row.keywordFallbackTermsJson || row.keywordTermsJson),
    })) });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Retrieval logs failed." });
  }
});

app.get("/api/admin/retrieval-review-summary", async (req, res) => {
  try {
    const adminId = String(req.query.adminId || "");
    if (!(await requireAdmin(adminId))) return res.status(403).json({ error: "Unauthorized" });
    const since = String(req.query.since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
    const logs = db.prepare("SELECT * FROM retrieval_logs WHERE createdAt >= ? ORDER BY createdAt DESC LIMIT 1000").all(since) as any[];
    const corrections = db.prepare("SELECT * FROM answer_overrides WHERE createdAt >= ? ORDER BY createdAt DESC LIMIT 200").all(since) as any[];
    const failed = logs.filter((row) => row.answerStatus === "error" || row.errorMessage);
    const low = logs.filter((row) => Number(row.confidenceScore || 0) < 0.45 || row.answerStatus === "low_confidence");
    const refusedRows = logs.filter((row) => row.answerStatus === "refused_no_evidence");
    const keywordCounts = new Map<string, number>();
    const poorFolders = new Map<string, number>();
    for (const row of [...low, ...refusedRows]) {
      safeJsonArray(row.keywordTermsJson).forEach((term: string) => keywordCounts.set(term, (keywordCounts.get(term) || 0) + 1));
      safeJsonArray(row.foldersSearched).forEach((folder: string) => poorFolders.set(folder, (poorFolders.get(folder) || 0) + 1));
    }
    const commonMissingKeywords = Array.from(keywordCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([term, count]) => ({ term, count }));
    const foldersWithPoorRetrieval = Array.from(poorFolders.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([folder, count]) => ({ folder, count }));
    const suggestedSynonymRules = commonMissingKeywords.slice(0, 10).map(({ term }) => ({ term, synonyms: [], reason: "Frequently appears in low-confidence or refused retrieval. Add local aliases if users use another wording." }));
    const suggestedRoutingRules = foldersWithPoorRetrieval.slice(0, 10).map(({ folder }) => ({ folder, suggestion: "Review whether this folder/module needs stronger synonyms or source-type routing.", reason: "Appears often in weak retrieval logs." }));
    res.json({
      success: true,
      since,
      failedQueries: failed,
      lowConfidenceQueries: low,
      refusedQueries: refusedRows,
      questionsWithUserCorrections: corrections,
      mostCommonMissingKeywords: commonMissingKeywords,
      foldersModulesWithPoorRetrieval: foldersWithPoorRetrieval,
      suggestedSynonymRules,
      suggestedRoutingRules,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Retrieval review summary failed." });
  }
});

app.post("/api/admin/retrieval-synonyms", async (req, res) => {
  try {
    const { adminId, term = "", synonyms = [], folder = "", module = "", isActive = true } = req.body || {};
    if (!(await requireAdmin(String(adminId || "")))) return res.status(403).json({ error: "Unauthorized" });
    if (!String(term).trim()) return res.status(400).json({ error: "term is required." });
    const id = randomId("syn");
    db.prepare("INSERT INTO retrieval_synonyms (id, term, synonymsJson, folder, module, isActive) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, String(term).trim(), JSON.stringify(Array.isArray(synonyms) ? synonyms : String(synonyms).split(",").map((item) => item.trim()).filter(Boolean)), String(folder || ""), String(module || ""), isActive ? 1 : 0);
    res.json({ success: true, id });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Retrieval synonym save failed." });
  }
});

app.post("/feedback", async (req, res) => {
  try {
    saveFeedbackLog(req.body);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Feedback save failed." });
  }
});

app.get("/test/run", async (_req, res) => {
  const tests = [
    { q: "Which municipality has the highest ratio of projects to participants?", expect: /Ratio|Participants|Projects/i },
    { q: "Show me the average age of participants from 2023 to 2025, by year, for municipalities with at least 50 participants per year.", expect: /Year|Average Age|```python/i },
    { q: "Which SLP phase has the most participants? Describe that phase.", expect: /Phase|highest|GUIDELINES|Personal Module/i },
    { q: "Create a combined chart: bars for participants per municipality, line for training completion rate. Only municipalities with >100 participants.", expect: /twinx|Participants|Rate/i },
    { q: "Tell me about rice projects in Baler, plus how many 4Ps participants are in Baler, and also give me a download link for a project proposal template.", expect: /Direct Answer|Source Used|Download|Baler/i },
    { q: "What is Annex T.2?", expect: /Annex|T\.2|Source Used/i },
    { q: "Who signs the Unified Memorandum of Agreement?", expect: /Unified|Memorandum|Agreement|Source Used/i },
    { q: "What are SLP eligibility requirements?", expect: /eligib|requirement|Source Used/i },
    { q: "What is Phase Five (Usbong)?", expect: /Usbong is Phase 2|not Phase 5/i },
    { q: "Show participants without an email address.", expect: /missing|empty|email|Relevant Table/i },
    { q: "List all barangays in Baler from the Personal Module.", expect: /barangay|Baler|Source Used/i },
    { q: "How many training attendances happened in Q1 2024?", expect: /Q1 2024|2024|training|row/i },
    { q: "What is a MOA?", expect: /Memorandum|Agreement|Source Used/i },
    { q: "Show me participant count by municpality", expect: /Municipality|Participants|Count/i },
    { q: "Summarize the SLP omnibus guidelines.", expect: /Source Used|GUIDELINES|guideline/i },
  ];
  const results = [];
  for (const test of tests) {
    const answer = await withTimeout(answerSubQuestionDeterministically(test.q, "test-run", []), 15000, test.q).catch((error: any) => `ERROR: ${error.message || error}`);
    results.push({ question: test.q, passed: test.expect.test(answer), preview: answer.slice(0, 300) });
  }
  console.log(`[REGRESSION_TEST_RUN] ${JSON.stringify(results)}`);
  res.json({ success: true, results });
});

// =========================
// PRE-ROUTE GENERAL INTENT HANDLERS
// =========================
function handlerDownloadLine(file: any) {
  const source = `${file.source_type || canonicalSourceFolder(file.folder)}${file.sub_folder ? `/${file.sub_folder}` : ""}`;
  const name = file.original_file_name || file.file_name || "file";
  const download = hasDownloadPath(file) ? ` - [Download](${downloadUrlForDocument(file.file_id || file.document_id)})` : "";
  return `- ${name} (${source})${download}`;
}

function composeFolderFileListingHandler(message: string) {
  const match = String(message || "").trim().match(/^list all (\w+) (?:in|from) (?:the\s+)?(\w+) folder$/i);
  if (!match) return "";
  const requestedType = match[1];
  const folderName = match[2];
  const normalizedFolder = normalizeName(folderName);
  const files = originalFileRows()
    .filter((file: any) => normalizeName(`${file.folder || ""} ${file.sub_folder || ""} ${file.source_type || ""}`).includes(normalizedFolder))
    .sort((a: any, b: any) => String(a.original_file_name || "").localeCompare(String(b.original_file_name || "")));
  console.log(`[FOLDER_LISTING] ${JSON.stringify({ userQuery: message, requestedType, folderName, fileCount: files.length })}`);
  return [
    "**Direct Answer**",
    files.length ? `Found ${files.length} indexed file(s) in folders matching "${folderName}".` : `No indexed files were found in folders matching "${folderName}".`,
    "",
    "**Files**",
    ...(files.length ? files.map(handlerDownloadLine) : ["- None"]),
    "",
    "**Source Used**",
    "- Original file metadata registry",
  ].join("\n");
}

function composeEntityDetailByIdentifierHandler(message: string) {
  const identifier = String(message || "").match(/([A-Z]{2}-\d{4}-[A-Za-z0-9]+[-_][A-Za-z0-9]+)/)?.[1] || "";
  if (!identifier) return "";
  const rows = db.prepare(`
    SELECT c.content, c.chunk_index, d.id AS document_id, d.file_name, d.folder,
           COALESCE(m.file_id, d.id) AS file_id, COALESCE(m.source_type, d.folder, '') AS source_type,
           COALESCE(m.original_file_name, d.file_name) AS original_file_name,
           m.storage_path, m.download_url
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
    LEFT JOIN original_file_metadata m ON m.document_id = d.id OR m.file_id = d.id
    WHERE c.content LIKE ?
    ORDER BY d.updated_at DESC, c.chunk_index ASC
    LIMIT 8
  `).all(`%${identifier}%`) as any[];
  console.log(`[ENTITY_DETAIL] ${JSON.stringify({ userQuery: message, identifier, chunkCount: rows.length })}`);
  if (!rows.length) {
    return [
      "**Direct Answer**",
      `I could not find "${identifier}" in indexed document chunks.`,
      "",
      "**Source Used**",
      "- Indexed document chunks",
    ].join("\n");
  }
  return [
    "**Direct Answer**",
    `Found ${rows.length} chunk(s) containing "${identifier}".`,
    "",
    "**Matching Chunks**",
    ...rows.map((row, index) => [
      `${index + 1}. ${row.source_type || canonicalSourceFolder(row.folder)}/${row.original_file_name || row.file_name} (chunk ${row.chunk_index})`,
      String(row.content || "").replace(/\s+/g, " ").slice(0, 900),
      row.file_id ? `[Download](${downloadUrlForDocument(row.file_id)})` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}

function firstSentence(text: string) {
  return String(text || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)[0] || "";
}

function rankedDefinitionBlocks(term: string, sourceFilter: (source: any) => boolean = () => true) {
  const normalizedTerm = normalizeName(term);
  if (!normalizedTerm) return [];
  const docs = db.prepare(`
    SELECT d.id, d.file_name, d.folder, d.content_text,
           COALESCE(m.file_id, d.id) AS file_id,
           COALESCE(m.source_type, d.folder, '') AS source_type,
           COALESCE(m.original_file_name, d.file_name) AS original_file_name,
           m.sub_folder, m.storage_path, m.download_url
    FROM documents d
    LEFT JOIN original_file_metadata m ON m.document_id = d.id OR m.file_id = d.id
    WHERE d.content_text IS NOT NULL AND length(d.content_text) > 0
  `).all() as any[];
  return docs.filter(sourceFilter).flatMap((doc) => splitEvidenceBlocks(doc.content_text || "").map((block, index) => {
    const heading = normalizeName(block.heading || "");
    const text = normalizeName(block.text || "");
    const first = normalizeName(firstSentence(block.text));
    let score = 0;
    if (heading.includes(normalizedTerm)) score += 60;
    if (first.includes(normalizedTerm)) score += 40;
    if (normalizeName(`${doc.folder || ""} ${doc.source_type || ""}`).includes("guidelines")) score += 20;
    if (text.includes(normalizedTerm)) score += 30;
    for (const token of conceptTokens(term)) {
      if (heading.includes(token)) score += 12;
      else if (text.includes(token)) score += 5;
    }
    return { doc, block, index, score };
  })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
}

function composeDefinitionLookupForTerm(term: string, originalMessage: string) {
  const ranked = rankedDefinitionBlocks(term);
  console.log(`[DEFINITION_LOOKUP] ${JSON.stringify({ userQuery: originalMessage, term, matchCount: ranked.length, topScore: ranked[0]?.score || 0 })}`);
  if (!ranked.length) {
    return `I cannot find information about '${term}' in the uploaded files.`;
  }
  const top = ranked[0];
  const source = `${top.doc.source_type || canonicalSourceFolder(top.doc.folder)}${top.doc.sub_folder ? `/${top.doc.sub_folder}` : ""}/${top.doc.original_file_name || top.doc.file_name}`;
  return [
    "**Direct Answer**",
    String(top.block.text || "").replace(/\s+/g, " ").slice(0, 1400),
    "",
    "**Source Used**",
    `- Source file: ${source}; section/heading: ${top.block.heading || "Extracted text"}; evidence type: document text`,
    top.doc.file_id ? `- [Download File](${downloadUrlForDocument(top.doc.file_id)})` : "",
  ].filter(Boolean).join("\n");
}

function composeDefinitionLookupHandler(message: string) {
  const match = String(message || "").trim().match(/^(what is|define|tell me about|describe|explain) (.+)$/i);
  if (!match) return "";
  return composeDefinitionLookupForTerm(match[2].replace(/[?.!]$/, "").trim(), message);
}

function composeTemplateByPurposeHandler(message: string) {
  const match = String(message || "").trim().match(/what template (?:can|should(?:\s+i)?|do i) (?:be? )?use for ([\w\s]+)/i);
  if (!match) return "";
  const purpose = match[1].replace(/[?.!]$/, "").trim();
  const normalizedPurpose = normalizeName(purpose);
  const files = originalFileRows().filter((file: any) => normalizeName(`${file.folder || ""} ${file.sub_folder || ""} ${file.source_type || ""}`).includes("templates"));
  const scored = files.map((file: any) => {
    const name = normalizeName(file.original_file_name || "");
    const description = normalizeName(`${file.document_purpose || ""} ${file.short_summary || ""} ${file.classification_reason || ""} ${file.related_topics || ""} ${String(file.content_text || "").slice(0, 5000)}`);
    let score = scoreContext(purpose, description, "");
    if (name.includes(normalizedPurpose)) score += 80;
    if (description.includes(normalizedPurpose)) score += 50;
    for (const token of conceptTokens(purpose)) {
      if (name.includes(token)) score += 20;
      if (description.includes(token)) score += 8;
    }
    return { file, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  console.log(`[TEMPLATE_BY_PURPOSE] ${JSON.stringify({ userQuery: message, purpose, searchedFiles: files.length, matches: scored.length, topScore: scored[0]?.score || 0 })}`);
  if (!scored.length) {
    return [
      "**Direct Answer**",
      `I could not find a template matching "${purpose}" in indexed template folders.`,
      "",
      "**Source Used**",
      "- Original file metadata registry filtered to template folders",
    ].join("\n");
  }
  const best = scored[0].file;
  return [
    "**Direct Answer**",
    `Recommended template: ${best.original_file_name}`,
    "",
    "**Description**",
    best.document_purpose || best.short_summary || best.classification_reason || fileRequestDescription(best, conceptTokens(purpose)),
    "",
    "**Source Used**",
    `- ${best.source_type || canonicalSourceFolder(best.folder)}${best.sub_folder ? `/${best.sub_folder}` : ""}/${best.original_file_name}`,
    hasDownloadPath(best) ? `- [Download File](${downloadUrlForDocument(best.file_id)})` : "- Download path not available",
  ].join("\n");
}

async function composeHybridAggregationDocumentHandler(message: string, parsed: ParsedQuery, attachmentIds: string[] = [], trace: any = null) {
  if (!/\b(?:then|and then)\b/i.test(message) || !/\b(which|what)\b/i.test(message) || !/\b(highest|largest|biggest|most|lowest|smallest|least)\b/i.test(message)) return "";
  const [aggregationQuestion, ...followParts] = String(message).split(/\b(?:then|and then)\b/i).map((part) => part.trim()).filter(Boolean);
  if (!aggregationQuestion || !followParts.length) return "";
  const spec = parseGenericHybridAggregationQuestion(`${aggregationQuestion} Then ${followParts.join(" then ")}`);
  if (!spec) return "";
  const aggregation = executeGenericHybridAggregation(spec);
  console.log(`[HYBRID_AGGREGATION] ${JSON.stringify({ userQuery: message, aggregationQuestion, followupQuestion: followParts.join(" then "), aggregation })}`);
  const term = aggregation.entity || spec.dimensionConcept;
  const definition = composeDefinitionLookupForTerm(term, message);
  if (trace) {
    trace.sqliteResult = aggregation;
    trace.finalSourceUsed = { sourceType: "SQLite+definition_lookup", answerMode: "pre_route_hybrid_aggregation", entity: aggregation.entity || "" };
    trace.evidenceVerificationPassed = true;
  }
  return [
    "**Direct Answer**",
    aggregation.ok
      ? `The ${spec.dimensionConcept} with the ${spec.direction === "DESC" ? "highest" : "lowest"} ${spec.metricConcept} is ${aggregation.entity} with ${aggregation.metricValue}.`
      : `I could not complete the aggregation: ${aggregation.reason || "No matching structured data was found."}`,
    "",
    aggregation.ok ? "**Aggregation Table**" : "**Aggregation Attempted**",
    aggregation.ok ? markdownTable([aggregation.dimensionColumn, aggregation.metricColumn], aggregation.rows) : `- Grouping concept: ${spec.dimensionConcept}\n- Metric concept: ${spec.metricConcept}`,
    "",
    aggregation.ok ? "**Aggregation Source**" : "",
    aggregation.ok ? `- ${aggregation.tableName}` : "",
    "",
    "**Document Lookup**",
    definition,
  ].filter(Boolean).join("\n");
}

async function composePreRouteGeneralIntentAnswer(message: string, parsed: ParsedQuery, attachmentIds: string[] = [], trace: any = null) {
  return composeFolderFileListingHandler(message)
    || composeEntityDetailByIdentifierHandler(message)
    || composeDefinitionLookupHandler(message)
    || composeTemplateByPurposeHandler(message)
    || await composeHybridAggregationDocumentHandler(message, parsed, attachmentIds, trace);
}

// =========================
// CHAT ROUTE (WITH ANALYSIS ENGINE)
// =========================
app.get("/api/chat", (_req, res) => res.json({ ok: true, method: "POST", responseMode: "deterministic+rag" }));

async function routeIntentWithModel(message: string, parsed: ParsedQuery) {
  try {
    await callModel("router", [
      { role: "system", content: "Classify the SLP assistant request. Return compact JSON only. Do not answer the user." },
      { role: "user", content: JSON.stringify({ message, deterministicIntent: parsed.intentType, action: parsed.action, scope: parsed.scope }) },
    ], { temperature: 0, maxTokens: 80, timeoutMs: 15000 });
  } catch (error: any) {
    console.warn("Model router unavailable; using TypeScript router:", error.message || error);
  }
}

async function finalizeAnswerWithMainModel(message: string, answer: string, parsed: ParsedQuery, sqliteSchema = "") {
  if (!answer || answer === NO_RELEVANT_SOURCE_MESSAGE) return answer;
  try {
    const chartInstruction = "If the user asks for a chart, graph, plot, visualization, trend, comparison chart, or dashboard-style visual: 1. Use only verified SQLite results or retrieved structured data. 2. First output a Markdown table of the chart data. 3. Then provide Python code using matplotlib to generate the chart. 4. Do not render the chart inside the UI. 5. Do not invent data. 6. If data is insufficient, say what data is missing.";
    const result = await callModel("main", [
      { role: "system", content: ["You write final SLP Knowledge Assistant responses from verified backend evidence only. Preserve every number, table row, source name, applied filter, download link, and no-data statement exactly as provided. Do not invent counts, source names, recommendations, or facts. Counts and matches come only from SQLite/TypeScript. For simple answers, keep a short Direct Answer plus Source Used. For numeric analytics, include a useful interpretation of what the computed result means. Do not invent columns. If required columns are missing, say the data does not contain them. Return markdown only.", chartInstruction, sqliteSchema ? `SQLite Schema:\n${sqliteSchema}` : ""].filter(Boolean).join("\n\n") },
      { role: "user", content: `User question:\n${message}\n\nParsed intent:\n${parsed.intentType}\n\nDeterministic answer to preserve and present:\n${answer}` },
    ], { temperature: 0.1, maxTokens: 1800, timeoutMs: 45000 });
    return result.content || answer;
  } catch (error: any) {
    console.warn("Main model unavailable; trying GitHub fallback model:", error.message || error);
    try {
      const fallback = await callModel("fallback", [
        { role: "system", content: "You are the fallback final-answer writer for SLP Knowledge Assistant. Preserve all computed numbers, matched rows, sources, filters, download links, and no-data statements exactly. Do not invent facts. Return concise markdown only." },
        { role: "user", content: `User question:\n${message}\n\nDeterministic answer to preserve:\n${answer}` },
      ], { temperature: 0.1, maxTokens: 1800, timeoutMs: 45000 });
      return fallback.content || answer;
    } catch (fallbackError: any) {
      console.warn("Fallback model unavailable; returning deterministic answer:", fallbackError.message || fallbackError);
      return answer;
    }
  }
}

function extractRowsForDebug(message: string, parsed: ParsedQuery, modules: SlpModuleTag[]) {
  const sources = loadSlpModuleSources();
  const terms = extractStructuredLookupTerms(message);
  const filters = extractStrictFilters(message, parsed);
  const selected = sourcesForModules(sources, modules);
  const personalMatches = modules.includes("PERSONAL") ? findPersonalMatches(sourcesForModules(sources, ["PERSONAL"]), terms, filters) : [];
  const keys = personJoinKeys(personalMatches.slice(0, 10));
  return filteredSlpRowEntries(selected, filters).filter(({ row, source }) => {
    const headers = source.headers || [];
    if (rowMatchesIdentifiers(row, headers, terms).matched) return true;
    if (terms.name && rowMatchesPerson(row, headers, terms.name).matched) return true;
    if (personalMatches.length && rowMatchesPersonKeys(row, headers, keys).matched) return true;
    return !terms.name && !terms.participantId && !terms.projectId && !terms.grantCode;
  }).slice(0, 50).map(({ row, source }) => ({
    source: sourceDisplayName(source),
    rowNumber: row.__rowNumber || "",
    values: Object.fromEntries((source.headers || []).slice(0, 12).map((header: string) => [header, row[header] || ""])),
  }));
}

type StrictEvidenceRoute = "document" | "sqlite" | "hybrid";

const STRICT_REFUSAL_ANSWER = "I cannot answer from the available data.";

function strictLog(step: string, details: any = {}) {
  console.log(`${step} ${JSON.stringify(details)}`);
}

function detectStrictEvidenceRoute(question: string): StrictEvidenceRoute {
  const lower = normalizeName(question);
  const documentSignals = /\b(policy|policies|guideline|guidelines|process|eligibility|eligible|requirements?|templates?|forms?|memorandum|memo|circular|annex|document|procedure|phase|steps?)\b/.test(lower);
  const sqliteSignals = /\b(counts?|totals?|how many|number of|municipalit(?:y|ies)|barangays?|participants?|beneficiar(?:y|ies)|projects?|operational|closed|gur|grant utilization|training|monitoring|assessment|dashboard|rows?|list|distinct|group by|breakdown)\b/.test(lower);
  if (documentSignals && sqliteSignals) return "hybrid";
  if (sqliteSignals) return "sqlite";
  if (documentSignals) return "document";
  return "hybrid";
}

function strictScoreToConfidence(score: number) {
  return Math.max(0, Math.min(1, Number(score || 0) / 200));
}

function strictPhraseMatch(question: string, haystack: string) {
  const normalized = normalizeName(haystack);
  return queryPhrases(question).some((phrase) => phrase.length >= 4 && normalized.includes(phrase));
}

function evidenceDownloadDataFromDocumentId(documentId = "") {
  const id = String(documentId || "").trim();
  if (!id) return null;
  const resolved = resolveSourceFileReference({ documentId: id });
  if (!resolved.resolved) return null;
  if (!resolved.canDownload) {
    console.log("CHAT_EVIDENCE_DOWNLOAD_MISSING", {
      fileName: resolved.originalFilename,
      documentId: resolved.documentId,
      reason: "file reference resolved but local file is missing"
    });
  }
  return resolved;
}

function evidenceDownloadDataFromSource(source: any) {
  const resolved = resolveSourceFileReference({
    ...source,
    documentId: source?.documentId || source?.document_id || source?.id || "",
    uploadedFileId: source?.uploadedFileId || source?.fileId || source?.file_id || "",
    sourcePath: source?.sourcePath || source?.sourceFile || source?.label || source?.file || "",
    fileName: source?.fileName || source?.filename || source?.file || source?.file_name || source?.label || "",
    title: source?.title || source?.label || "",
    category: source?.category || source?.folder || "",
    module: source?.module || source?.sourceType || "",
  });
  return resolved.resolved ? resolved : null;
}

function strictDocumentResultSource(item: any) {
  const downloadData = evidenceDownloadDataFromSource({
    ...item.source,
    sourcePath: item.label,
    sourceFile: item.label,
    fileName: item.label,
    title: item.heading || item.label,
    category: item.folder,
    module: item.sourceType,
  });
  const fallbackFileName = item.label || "Uploaded document";
  const fallbackCategory = item.folder || item.sourceType || "";
  return {
    type: "document",
    file: downloadData?.fileName || fallbackFileName,
    fileName: downloadData?.fileName || fallbackFileName,
    originalFilename: downloadData?.originalFilename || fallbackFileName,
    storedFilename: downloadData?.storedFilename || "",
    filePath: downloadData?.filePath || "",
    storageKey: downloadData?.storageKey || "",
    documentId: downloadData?.documentId || item.source?.id || "",
    uploadedFileId: downloadData?.uploadedFileId || "",
    fileId: downloadData?.fileId || item.source?.id || "",
    folder: downloadData?.category || fallbackCategory,
    category: downloadData?.category || fallbackCategory,
    module: downloadData?.module || item.sourceType || "",
    fileType: downloadData?.fileType || "",
    mimeType: downloadData?.mimeType || "",
    sourceFile: downloadData?.sourceFile || item.label || "",
    heading: item.heading || "Unlabeled section",
    section: item.heading || "Unlabeled section",
    evidenceType: item.keywordFallback ? "keyword fallback" : "document text",
    downloadUrl: downloadData?.downloadUrl || "",
    previewUrl: downloadData?.previewUrl || "",
    canDownload: Boolean(downloadData?.canDownload),
    score: Number(item.confidence || 0),
    retrievalMethod: item.keywordFallback ? "keyword_fallback" : "vector_search",
  };
}

async function strictDocumentSearch(question: string, parsed: ParsedQuery, attachmentIds: string[] = []) {
  console.log("DOCUMENT_SEARCH");
  const allSources = await loadDocumentTextSources(attachmentIds);
  const route = routeUserQuery(question);
  const candidates = allSources.flatMap((source: any) => {
    const metadata = documentMetadata(source);
    const label = sourceLabelForDocument(source);
    const folder = String(metadata?.folder || source.folder || "");
    const sourceType = canonicalEvidenceSourceType(documentSourceType(source));
    return splitEvidenceBlocks(source.content_text || "").map((block) => {
      const haystack = `${label}\n${folder}\n${sourceType}\n${block.heading}\n${block.text}`;
      const exactPhrase = strictPhraseMatch(question, haystack);
      const filenameTitleHeadingBoost = strictPhraseMatch(question, `${label}\n${block.heading}`) ? 40 : 0;
      const folderModuleBoost = retrievalKeywords(question).some((term) => normalizeName(`${folder} ${sourceType}`).includes(term)) ? 25 : 0;
      const rawScore = scoreEvidenceBlock(question, parsed, route, source, block) + filenameTitleHeadingBoost + folderModuleBoost;
      return {
        source,
        label,
        folder,
        sourceType,
        heading: block.heading,
        text: block.text,
        score: rawScore,
        confidence: strictScoreToConfidence(rawScore),
        strongExactPhrase: exactPhrase,
        keywordFallback: false,
      };
    });
  }).sort((a, b) => b.score - a.score);
  const topScore = candidates[0]?.confidence || 0;
  const goodChunks = candidates.filter((item) => item.confidence >= 0.5 || item.strongExactPhrase).slice(0, 6);
  strictLog("DOCUMENT_SEARCH", {
    sourceCount: allSources.length,
    chunkCount: candidates.length,
    topScore,
    goodChunkCount: goodChunks.length,
    topChunks: candidates.slice(0, 5).map((item) => ({ source: item.label, heading: item.heading, score: item.confidence })),
  });
  return { allSources, candidates: candidates.slice(0, 12), goodChunks, topScore };
}

function strictKeywordFallback(question: string, documentSearch: Awaited<ReturnType<typeof strictDocumentSearch>>) {
  console.log("KEYWORD_FALLBACK");
  const needsFallback = !documentSearch.goodChunks.length || documentSearch.topScore < 0.5;
  if (!needsFallback) {
    strictLog("KEYWORD_FALLBACK", { used: false, reason: "document search already has reliable chunks" });
    return { used: false, terms: [] as string[], results: documentSearch.candidates, merged: documentSearch.candidates };
  }
  const fallback = keywordFallbackSearch(question, documentSearch.allSources, null);
  const normalizedFallback = fallback.results.map((item: any) => ({
    ...item,
    confidence: Math.max(strictScoreToConfidence(Number(item.score || 0) + 35), item.score >= 55 ? 0.5 : 0),
    strongExactPhrase: strictPhraseMatch(question, `${item.label}\n${item.heading}\n${item.text}`),
  }));
  const merged = mergeRetrievalCandidates(documentSearch.candidates, normalizedFallback)
    .map((item: any) => ({ ...item, confidence: item.confidence ?? strictScoreToConfidence(item.score), strongExactPhrase: item.strongExactPhrase || strictPhraseMatch(question, `${item.label}\n${item.heading}\n${item.text}`) }))
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, 12);
  strictLog("KEYWORD_FALLBACK", { used: true, terms: fallback.terms, resultCount: fallback.results.length, mergedCount: merged.length });
  return { used: true, terms: fallback.terms, results: normalizedFallback, merged };
}

function strictSqliteSchemaInspection() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[];
  return tables.map((table) => {
    const name = String(table.name || "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { table: name, columns: [] as any[], rowCount: null };
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as any[];
    let rowCount: number | null = null;
    try { rowCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as any)?.count || 0); } catch {}
    return { table: name, columns: columns.map((column) => ({ name: column.name, type: column.type })), rowCount };
  });
}

function strictSourceIntentScore(question: string, source: any) {
  const terms = retrievalKeywords(question);
  const sourceText = normalizeName(`${source.source || ""} ${source.folder || ""} ${source.fileName || ""} ${source.sheetName || ""} ${(source.headers || []).join(" ")}`);
  let score = terms.filter((term) => sourceText.includes(term)).length * 8;
  if (/\bgur|grant utilization\b/i.test(question) && /gur|grant utilization/i.test(sourceText)) score += 50;
  if (/training/i.test(question) && /training|orientation/i.test(sourceText)) score += 45;
  if (/monitoring|operational|closed/i.test(question) && /monitoring|assessment|status|visit/i.test(sourceText)) score += 45;
  if (/assessment/i.test(question) && /assessment/i.test(sourceText)) score += 45;
  if (/participants?|beneficiar/i.test(question) && /(participant|beneficiary|personal|name)/i.test(sourceText)) score += 35;
  if (/projects?|enterprise|livelihood/i.test(question) && /(project|enterprise|livelihood|grant code)/i.test(sourceText)) score += 35;
  if (/municipalit(?:y|ies)|barangay/i.test(question) && /(municipality|barangay|city)/i.test(sourceText)) score += 25;
  return score;
}

function strictQuestionKeywords(question: string) {
  return retrievalKeywords(question).filter((term) => !/^(count|total|how|many|number|list|show|give|all|by|per|of|the|and|with|without|source|data|dashboard|sqlite|rows?)$/.test(term));
}

function strictFindHeader(headers: string[], concepts: string[]) {
  return concepts.map((concept) => findMatchingColumn(headers, concept)).find(Boolean) || "";
}

function strictRowMatchesQuestion(row: Record<string, string>, headers: string[], question: string) {
  const filters = extractStrictFilters(question, parseQuery(question));
  if (!filterRowsByFilters([row], headers, filters).length) return false;
  const terms = strictQuestionKeywords(question);
  const mustFilterByTerms = /\b(list|show|find|search|lookup|with|without|operational|closed|training|gur|monitoring|assessment)\b/i.test(question);
  if (!mustFilterByTerms || !terms.length) return true;
  const text = normalizeName(Object.values(row || {}).join(" "));
  const headerText = normalizeName(headers.join(" "));
  const hits = terms.filter((term) => text.includes(term) || headerText.includes(term));
  return hits.length > 0 || Boolean(filters.municipality || filters.barangay || filters.status);
}

function strictSqliteSearch(question: string, parsed: ParsedQuery, attachmentIds: string[] = []) {
  console.log("SQLITE_SEARCH");
  const schema = strictSqliteSchemaInspection();
  const sources = loadSheetSources({ attachmentIds: attachmentIds.length ? attachmentIds : undefined, includeChatAttachments: true }) as any[];
  const scoredSources = sources
    .map((source) => ({ source, score: strictSourceIntentScore(question, source) }))
    .sort((a, b) => b.score - a.score);
  const relevantSources = (scoredSources.some((item) => item.score > 0) ? scoredSources.filter((item) => item.score > 0) : scoredSources).slice(0, 20).map((item) => item.source);
  const flatRows: any[] = [];
  for (const source of relevantSources) {
    const headers = source.headers || [];
    for (const row of source.rows || []) {
      if (strictRowMatchesQuestion(row, headers, question)) flatRows.push({ source, row, headers });
      if (flatRows.length >= 5000) break;
    }
    if (flatRows.length >= 5000) break;
  }
  const wantsCount = /\b(count|total|how many|number of)\b/i.test(question);
  const wantsDistinct = /\b(distinct|unique|list municipalities|list barangays|municipalities are|barangays are)\b/i.test(question);
  const groupByBarangay = /\bby barangay|per barangay|group by barangay\b/i.test(question);
  const groupByMunicipality = !groupByBarangay && /\bby municipality|per municipality|group by municipality|municipalities\b/i.test(question);
  const listMode = /\b(list|show|rows?|participants?|projects?)\b/i.test(question) && !wantsCount;
  const metricConcept = /participants?|beneficiar/i.test(question) ? "participant"
    : /projects?|enterprise|livelihood/i.test(question) ? "project"
    : /municipalit/i.test(question) ? "municipality"
    : /barangay/i.test(question) ? "barangay"
    : "row";
  const keyFor = (entry: any) => {
    const headers = entry.headers || [];
    if (metricConcept === "participant") return slpParticipantKey(entry.row, headers) || slpFullName(entry.row, headers) || JSON.stringify(entry.row);
    if (metricConcept === "project") return slpProjectKey(entry.row, headers) || slpProjectName(entry.row, headers) || JSON.stringify(entry.row);
    if (metricConcept === "municipality") return slpMunicipality(entry.row, headers) || getCell(entry.row, strictFindHeader(headers, ["municipality", "city"]));
    if (metricConcept === "barangay") return getCell(entry.row, strictFindHeader(headers, ["barangay", "brgy"]));
    return JSON.stringify(entry.row);
  };
  let rows: any[] = [];
  let summary = "";
  if (wantsDistinct) {
    const colConcept = /barangay/i.test(question) ? ["barangay", "brgy"] : ["municipality", "city"];
    const values = Array.from(new Set(flatRows.map((entry) => getCell(entry.row, strictFindHeader(entry.headers, colConcept))).filter(Boolean))).sort();
    rows = values.map((value) => ({ value }));
    summary = values.length ? `Found ${values.length} distinct ${/barangay/i.test(question) ? "barangay" : "municipality"} value(s).` : "No distinct values were found in the returned rows.";
  } else if (groupByMunicipality || groupByBarangay) {
    const groupConcept = groupByBarangay ? ["barangay", "brgy"] : ["municipality", "city"];
    const groups = new Map<string, Set<string>>();
    for (const entry of flatRows) {
      const group = getCell(entry.row, strictFindHeader(entry.headers, groupConcept)) || "Unspecified";
      if (!groups.has(group)) groups.set(group, new Set());
      groups.get(group)!.add(keyFor(entry));
    }
    rows = Array.from(groups.entries()).map(([group, values]) => ({ [groupByBarangay ? "barangay" : "municipality"]: group, count: values.size })).sort((a: any, b: any) => b.count - a.count);
    summary = `Grouped ${metricConcept} count by ${groupByBarangay ? "barangay" : "municipality"}.`;
  } else if (wantsCount) {
    const values = new Set(flatRows.map(keyFor).filter(Boolean));
    rows = [{ metric: metricConcept, count: values.size || flatRows.length }];
    summary = `Found ${values.size || flatRows.length} ${metricConcept}${(values.size || flatRows.length) === 1 ? "" : "s"} in the returned SQLite/dashboard evidence.`;
  } else if (listMode) {
    rows = flatRows.slice(0, 20).map((entry) => {
      const headers = entry.headers || [];
      return {
        source: sourceDisplayName(entry.source),
        row: entry.row.__rowNumber || "",
        participant: slpFullName(entry.row, headers) || getCell(entry.row, strictFindHeader(headers, ["name", "participant"])),
        project: slpProjectName(entry.row, headers) || getCell(entry.row, strictFindHeader(headers, ["project", "enterprise"])),
        municipality: slpMunicipality(entry.row, headers) || getCell(entry.row, strictFindHeader(headers, ["municipality", "city"])),
        status: getCell(entry.row, strictFindHeader(headers, ["status", "enterprise status", "project status"])),
      };
    });
    summary = rows.length ? `Returned ${rows.length} matching row(s).` : "No matching rows were returned.";
  } else {
    const values = new Set(flatRows.map(keyFor).filter(Boolean));
    rows = [{ metric: metricConcept, count: values.size || flatRows.length }];
    summary = flatRows.length ? `Found ${values.size || flatRows.length} matching ${metricConcept}${(values.size || flatRows.length) === 1 ? "" : "s"}.` : "No matching SQLite/dashboard rows were found.";
  }
  const usedSources = Array.from(new Set(relevantSources.slice(0, 8).map((source: any) => sourceDisplayName(source))));
  const sqlUsed = [
    "Dynamic SQLite schema inspection",
    `Tables inspected: ${schema.map((item) => item.table).join(", ")}`,
    "Query path: uploaded_sheets + sheet_rows JSON rows, selected by relevant file/sheet/header terms",
    `Selected source count: ${relevantSources.length}`,
  ].join("; ");
  const confidence = rows.length || flatRows.length ? Math.min(0.95, 0.55 + Math.min(0.35, flatRows.length / 100)) : 0;
  strictLog("SQLITE_SEARCH", { tableCount: schema.length, selectedSources: usedSources, matchedRows: flatRows.length, outputRows: rows.length, confidence });
  return { rows, summary, sqlUsed, confidence, rowCount: flatRows.length, sources: usedSources, schema, selectedTables: schema.map((item) => item.table), selectedModules: usedSources };
}

function strictSourceCheck(documentEvidence: any[], sqliteEvidence: any | null) {
  console.log("SOURCE_CHECK");
  const documentSupportsQuestion = (item: any) => {
    const evidence = normalizeName(`${item.label || ""} ${item.folder || ""} ${item.sourceType || ""} ${item.heading || ""} ${item.text || ""}`);
    if (/\bslp\b/i.test(item.question || "") && /\bslp\b|sustainable livelihood program/i.test(evidence)) return true;
    const terms = strictQuestionKeywords(item.question || "")
      .filter((term) => term.length >= 5)
      .filter((term) => !/^(policy|guideline|guidelines|process|requirements?|eligibility|template|forms?|memorandum|document|source|available|uploaded|question|answer)$/.test(term));
    if (!terms.length) return true;
    const missing = terms.filter((term) => !evidence.includes(term));
    item.unsupportedQuestionTerms = missing;
    if (missing.length === 0) return true;
    if (terms.length <= 2) return missing.length < terms.length;
    return missing.length <= Math.floor(terms.length / 2) || (item.strongExactPhrase && missing.length <= Math.ceil(terms.length / 2));
  };
  const reliableDocument = documentEvidence.filter((item) => (item.confidence >= 0.5 || item.strongExactPhrase) && String(item.text || "").trim().length >= 40 && documentSupportsQuestion(item));
  const reliableSqlite = Boolean(sqliteEvidence && sqliteEvidence.confidence >= 0.5 && (sqliteEvidence.rows?.length || sqliteEvidence.rowCount >= 0));
  const passed = Boolean(reliableDocument.length || reliableSqlite);
  strictLog("SOURCE_CHECK", { reliableDocumentChunks: reliableDocument.length, reliableSqlite, passed });
  return { passed, reliableDocument, reliableSqlite };
}

function strictFormatDocumentAnswer(chunks: any[]) {
  const selected = chunks.slice(0, 3);
  const sections = ["**Direct Answer**"];
  if (selected.length === 1) {
    sections.push(String(selected[0].text || "").replace(/\s+/g, " ").slice(0, 1200));
  } else {
    selected.forEach((item, index) => sections.push(`${index + 1}. ${String(item.text || "").replace(/\s+/g, " ").slice(0, 700)}`));
  }
  sections.push("", "**Source Used**", ...selected.map((item) => `- Source file: ${item.label}; folder/module: ${item.folder || item.sourceType}; section/heading: ${item.heading || "Unlabeled section"}`));
  return sections.join("\n");
}

function strictFormatSqliteRows(rows: any[]) {
  if (!rows.length) return "";
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row)).filter((key) => !/^_/.test(key)))).slice(0, 8);
  return markdownTable(headers, rows.slice(0, 20).map((row) => headers.map((header) => String(row[header] ?? ""))));
}

function strictFormatSqliteAnswer(sqlite: any) {
  return [
    "**Direct Answer**",
    sqlite.summary,
    "",
    sqlite.rows?.length ? "**SQLite/Dashboard Result**" : "",
    sqlite.rows?.length ? strictFormatSqliteRows(sqlite.rows) : "",
    "",
    "**SQLite Evidence**",
    `- Rows matched: ${sqlite.rowCount}`,
    `- Query summary: ${sqlite.sqlUsed}`,
    "",
    "**Source Used**",
    ...(sqlite.sources.length ? sqlite.sources.map((source: string) => `- ${source}`) : ["- SQLite/dashboard indexed tables"]),
  ].filter(Boolean).join("\n");
}

function resolveEvidenceSourceForDownload(source: any) {
  if (!source || source.type !== "document") return source;
  const resolved = resolveSourceFileReference({
    ...source,
    sourcePath: source.sourcePath || source.sourceFile || source.filePath || source.file || source.fileName || source.title || "",
    sourceFile: source.sourceFile || source.sourcePath || "",
    fileName: source.fileName || source.file || source.originalFilename || source.title || "",
    title: source.title || source.heading || source.section || source.fileName || source.file || "",
    documentId: source.documentId || source.document_id || source.id || "",
    uploadedFileId: source.uploadedFileId || source.fileId || source.file_id || "",
    category: source.category || source.folder || "",
    module: source.module || "",
  });
  if (!resolved.resolved) {
    return {
      ...source,
      canDownload: false,
      resolveError: "No matching uploaded file record found",
    };
  }
  return {
    ...source,
    file: resolved.fileName || source.file,
    fileName: resolved.fileName || source.fileName || source.file,
    originalFilename: resolved.originalFilename || source.originalFilename,
    storedFilename: resolved.storedFilename || source.storedFilename || "",
    filePath: resolved.filePath || source.filePath || "",
    storageKey: resolved.storageKey || source.storageKey || "",
    documentId: resolved.documentId || source.documentId || "",
    uploadedFileId: resolved.uploadedFileId || source.uploadedFileId || "",
    fileId: resolved.fileId || source.fileId || "",
    category: resolved.category || source.category || source.folder || "",
    folder: resolved.category || source.folder || source.category || "",
    module: resolved.module || source.module || "",
    fileType: resolved.fileType || source.fileType || "",
    mimeType: resolved.mimeType || source.mimeType || "",
    sourceFile: source.sourceFile || resolved.sourceFile || "",
    downloadUrl: resolved.downloadUrl || source.downloadUrl || "",
    previewUrl: resolved.previewUrl || source.previewUrl || "",
    canDownload: Boolean(resolved.canDownload && resolved.downloadUrl),
    resolveError: resolved.canDownload ? "" : "Uploaded file record was found but the stored file is missing",
  };
}

function strictBuildResponseObject(input: {
  answer: string;
  answerStatus: RetrievalAnswerStatus | string;
  confidenceScore: number;
  selectedRoute: StrictEvidenceRoute;
  sources: any[];
  usedDocumentSearch: boolean;
  usedKeywordFallback: boolean;
  usedSqliteSearch: boolean;
  sourceCheckPassed: boolean;
  debug: any;
  fileRecommendations?: any[];
}) {
  const responseSources = input.sources.map(resolveEvidenceSourceForDownload);
  const evidenceItems = [
    ...responseSources.filter((source: any) => source?.type === "document"),
    ...(input.fileRecommendations || []).map((item: any) => ({
      fileName: item.filename || item.fileName,
      documentId: item.documentId,
      downloadUrl: item.downloadUrl,
      previewUrl: item.previewUrl,
    })),
  ];
  console.log("CHAT_EVIDENCE_DOWNLOAD_DATA", {
    evidenceCount: evidenceItems.length,
    evidence: evidenceItems.map((e: any) => ({
      fileName: e.fileName || e.file || e.originalFilename || e.filename || "",
      documentId: e.documentId || e.fileId || "",
      hasDownloadUrl: !!e.downloadUrl,
      hasPreviewUrl: !!e.previewUrl
    }))
  });
  console.log("CHAT_EVIDENCE_CARDS_FINAL", responseSources.map((card: any) => ({
    title: card.title || card.heading || card.section || "",
    fileName: card.fileName || card.file || card.originalFilename || "",
    documentId: card.documentId || "",
    uploadedFileId: card.uploadedFileId || card.fileId || "",
    canDownload: Boolean(card.canDownload || card.downloadUrl),
    downloadUrl: card.downloadUrl || ""
  })));
  return {
    answer: input.answer,
    answerStatus: input.answerStatus,
    confidenceScore: input.confidenceScore,
    confidence: input.confidenceScore,
    selectedRoute: input.selectedRoute,
    sources: responseSources,
    usedDocumentSearch: input.usedDocumentSearch,
    usedKeywordFallback: input.usedKeywordFallback,
    usedSqliteSearch: input.usedSqliteSearch,
    sourceCheckPassed: input.sourceCheckPassed,
    debug: input.debug,
    suggestedQuestions: [],
    retrievalDebug: input.debug,
    fileRecommendations: input.fileRecommendations || [],
  };
}

async function runStrictEvidenceFirstAnswerFlow(message: string, parsed: ParsedQuery, attachmentIds: string[] = []) {
  console.log("INTENT_ROUTING");
  const selectedRoute = detectStrictEvidenceRoute(message);
  strictLog("INTENT_ROUTING", { selectedRoute });
  const templateRecommendation = composeTemplateRecommendationAnswer(message, attachmentIds, {
    selectedRoute: "document",
    searchedRoute: "template_recommendation",
  });
  if (templateRecommendation) {
    return strictBuildResponseObject({
      answer: templateRecommendation.answer,
      answerStatus: templateRecommendation.answerStatus,
      confidenceScore: templateRecommendation.confidence,
      selectedRoute: "document",
      sources: templateRecommendation.fileRecommendations.map((item: any) => ({
        type: "document",
        file: item.filename,
        fileName: item.filename,
        originalFilename: item.filename,
        storedFilename: item.storedFilename || "",
        filePath: item.filePath || "",
        storageKey: item.storageKey || "",
        documentId: item.documentId,
        uploadedFileId: item.uploadedFileId || "",
        fileId: item.fileId || item.documentId,
        folder: item.category,
        category: item.category,
        module: item.module,
        fileType: item.fileType,
        mimeType: item.mimeType || "",
        sourceFile: item.sourceFile || `${item.category}/${item.filename}`,
        heading: "template recommendation",
        section: "template recommendation",
        evidenceType: "template recommendation",
        downloadUrl: item.downloadUrl,
        previewUrl: item.previewUrl,
        canDownload: Boolean(item.canDownload || item.downloadUrl),
        score: item.score,
        retrievalMethod: "template_recommendation",
      })),
      usedDocumentSearch: true,
      usedKeywordFallback: false,
      usedSqliteSearch: false,
      sourceCheckPassed: templateRecommendation.fileRecommendations.length > 0,
      debug: {
        selectedRoute: "document",
        searchedRoute: "template_recommendation",
        templateRecommendation: true,
        resultCount: templateRecommendation.fileRecommendations.length,
        files: templateRecommendation.fileRecommendations.map((item: any) => ({
          filename: item.filename,
          category: item.category,
          module: item.module,
          score: item.score,
          hasDownloadUrl: Boolean(item.downloadUrl),
        })),
      },
      fileRecommendations: templateRecommendation.fileRecommendations,
    });
  }
  const usedDocumentSearch = selectedRoute === "document" || selectedRoute === "hybrid";
  const usedSqliteSearch = selectedRoute === "sqlite" || selectedRoute === "hybrid";
  let documentSearch: Awaited<ReturnType<typeof strictDocumentSearch>> = { allSources: [], candidates: [], goodChunks: [], topScore: 0 } as any;
  let keywordFallback = { used: false, terms: [] as string[], results: [] as any[], merged: [] as any[] };
  if (usedDocumentSearch) {
    documentSearch = await strictDocumentSearch(message, parsed, attachmentIds);
    keywordFallback = strictKeywordFallback(message, documentSearch);
  } else {
    console.log("DOCUMENT_SEARCH");
    strictLog("DOCUMENT_SEARCH", { skipped: true, selectedRoute });
    console.log("KEYWORD_FALLBACK");
    strictLog("KEYWORD_FALLBACK", { used: false, skipped: true, selectedRoute });
  }
  const documentEvidence = (keywordFallback.used ? keywordFallback.merged : documentSearch.goodChunks.length ? documentSearch.goodChunks : documentSearch.candidates)
    .filter((item: any) => Number(item.confidence || 0) >= 0.5 || item.strongExactPhrase)
    .map((item: any) => ({ ...item, question: message }))
    .slice(0, 6);
  let sqliteEvidence: ReturnType<typeof strictSqliteSearch> | null = null;
  if (usedSqliteSearch) {
    sqliteEvidence = strictSqliteSearch(message, parsed, attachmentIds);
  } else {
    console.log("SQLITE_SEARCH");
    strictLog("SQLITE_SEARCH", { skipped: true, selectedRoute });
  }
  const sourceCheck = strictSourceCheck(documentEvidence, sqliteEvidence);
  const documentReliable = sourceCheck.reliableDocument.length > 0;
  const sqliteReliable = sourceCheck.reliableSqlite;
  const sources = [
    ...sourceCheck.reliableDocument.slice(0, 5).map(strictDocumentResultSource),
    ...(sqliteReliable && sqliteEvidence ? sqliteEvidence.sources.map((source) => ({ type: "sqlite", table: "uploaded_sheets/sheet_rows", module: source, rowCount: sqliteEvidence?.rowCount || 0, querySummary: sqliteEvidence?.sqlUsed || "" })) : []),
  ];
  let answer = "";
  let answerStatus: RetrievalAnswerStatus | string = "answered";
  let confidenceScore = 0;
  if (documentReliable && sqliteReliable && sqliteEvidence) {
    answer = [strictFormatDocumentAnswer(sourceCheck.reliableDocument), "", "---", "", strictFormatSqliteAnswer(sqliteEvidence)].join("\n");
    confidenceScore = Math.max(0.7, Math.min(0.96, Math.max(...sourceCheck.reliableDocument.map((item) => Number(item.confidence || 0)), sqliteEvidence.confidence)));
  } else if (documentReliable) {
    answer = strictFormatDocumentAnswer(sourceCheck.reliableDocument);
    confidenceScore = Math.max(0.55, Math.min(0.95, Math.max(...sourceCheck.reliableDocument.map((item) => Number(item.confidence || 0)))));
  } else if (sqliteReliable && sqliteEvidence) {
    answer = strictFormatSqliteAnswer(sqliteEvidence);
    confidenceScore = sqliteEvidence.confidence;
  } else if (sqliteEvidence?.rows?.length && usedSqliteSearch) {
    answer = [
      "**Direct Answer**",
      "I found partial related evidence, but it is not strong enough to fully answer the question.",
      "",
      documentEvidence.length ? "**Partial Document Evidence**" : "",
      ...documentEvidence.slice(0, 3).map((item: any) => `- ${item.label}: ${String(item.text || "").replace(/\s+/g, " ").slice(0, 300)}`),
      sqliteEvidence?.rows?.length ? "**Partial SQLite/Dashboard Evidence**" : "",
      sqliteEvidence?.rows?.length ? strictFormatSqliteRows(sqliteEvidence.rows.slice(0, 5)) : "",
      "",
      "**Missing Evidence**",
      "- A directly supported source passage or reliable SQLite/dashboard result for the full question.",
    ].filter(Boolean).join("\n");
    answerStatus = "partial_evidence";
    confidenceScore = 0.45;
  } else {
    console.log("FINAL_REFUSAL");
    strictLog("FINAL_REFUSAL", { selectedRoute, searchedFoldersModules: sources.map((source: any) => source.module || source.file || source.table), usedKeywordFallback: keywordFallback.used, usedSqliteSearch });
    answer = STRICT_REFUSAL_ANSWER;
    answerStatus = "refused_no_evidence";
    confidenceScore = 0;
  }
  return strictBuildResponseObject({
    answer,
    answerStatus,
    confidenceScore,
    selectedRoute,
    sources,
    usedDocumentSearch,
    usedKeywordFallback: keywordFallback.used,
    usedSqliteSearch,
    sourceCheckPassed: sourceCheck.passed,
    debug: {
      selectedRoute,
      searchedRoute: selectedRoute,
      searchedFoldersModules: Array.from(new Set([
        ...documentSearch.candidates.slice(0, 10).map((item: any) => item.folder || item.sourceType || item.label),
        ...(sqliteEvidence?.selectedModules || []),
      ].filter(Boolean))),
      documentSearch: {
        used: usedDocumentSearch,
        topScore: documentSearch.topScore,
        topChunks: documentSearch.candidates.slice(0, 5).map((item: any) => ({ source: item.label, heading: item.heading, score: item.confidence, strongExactPhrase: item.strongExactPhrase })),
      },
      keywordFallback: { used: keywordFallback.used, terms: keywordFallback.terms, resultCount: keywordFallback.results.length },
      sqliteSearch: sqliteEvidence ? { used: true, rowCount: sqliteEvidence.rowCount, confidence: sqliteEvidence.confidence, sqlUsed: sqliteEvidence.sqlUsed, rows: sqliteEvidence.rows.slice(0, 10) } : { used: false },
      sourceCheck,
    },
  });
}

async function handleChatRequest(req: express.Request, res: express.Response) {
  try {
    const { message, history = [], userId, attachmentIds = [], chatSessionId = "" } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });
    const sessionId = chatSessionId || "default";

    trackFaqQuestion(message);

    // Parse query using analysis engine
    const parsed = parseQuery(message);
    const strictAttachedIds = Array.isArray(attachmentIds) ? attachmentIds.map(String).filter(Boolean) : [];
    const strictResponse = await runStrictEvidenceFirstAnswerFlow(message, parsed, strictAttachedIds);
    if (userId) insertChatLog(userId, message, strictResponse.answer);
    saveAnalysisHistory({ userId, sessionId, question: message, answer: strictResponse.answer });
    insertAuditLog({ userId, action: "ask_question", feature: "chat", details: { question: message, attachmentIds, sources: strictResponse.sources, strictEvidenceFirst: true } });
    saveRetrievalLog({
      question: message,
      route: routeUserQuery(message),
      retrievalMode: strictResponse.selectedRoute,
      trace: strictResponse.debug,
      answer: strictResponse.answer,
      confidenceScore: strictResponse.confidenceScore,
      answerStatus: strictResponse.answerStatus as RetrievalAnswerStatus,
    });
    return res.json(strictResponse);
    const strictIntent = classifyStrictSlpIntent(message, parsed);
    const classified = classifyQuestion(message);
    const memory = loadChatMemory(userId);
    const previousSources = getPreviousSources(sessionId);
    const previousAnswerContext = getPreviousAnswerContext(sessionId);
    const queryRoute = routeUserQuery(message, { previousSources });
    const expandedRetrievalQuestion = await expandQuestionWithModel(message);
    const retrievalQuestion = expandedRetrievalQuestion === message ? message : `${message}\n\nExpanded retrieval query: ${expandedRetrievalQuestion}`;
    const activeChatTrace: any = {
      route: "POST /api/chat",
      userQuery: message,
      detectedIntent: queryRoute.intent,
      selectedSourceTypes: [...queryRoute.primarySourceTypes, ...queryRoute.secondarySourceTypes],
      filesSearched: [],
      topRetrievedChunks: [],
      finalSourceUsed: null,
      evidenceVerificationPassed: false,
      previousContext: previousAnswerContext,
      previousContextUsed: Boolean(previousAnswerContext),
      expandedRetrievalQuestion,
    };
    const attachedIds = Array.isArray(attachmentIds) ? attachmentIds.map(String).filter(Boolean) : [];
    const overrideMatchFirst = findAnswerOverride(message);
    if (overrideMatchFirst) {
      const overrideAnswer = answerFromOverride(overrideMatchFirst);
      activeChatTrace.selectedRoute = "override";
      activeChatTrace.reasonSelected = "Active answer override matched before normal retrieval.";
      activeChatTrace.finalSourceUsed = {
        source: overrideMatchFirst.row.correctSourceFile || "answer_overrides",
        sourceType: overrideMatchFirst.row.correctModule || overrideMatchFirst.row.correctFolder || "USER_TAUGHT_OVERRIDE",
        answerMode: "user_taught_override",
        score: Math.round(Number(overrideMatchFirst.score || 0) * 100),
      };
      activeChatTrace.finalEvidenceText = overrideMatchFirst.row.correctAnswer;
      activeChatTrace.evidenceVerificationPassed = true;
      activeChatTrace.selectedSourceTypes = ["USER_TAUGHT_OVERRIDE"];
      activeChatTrace.topRetrievedChunks = [{
        source: overrideMatchFirst.row.correctSourceFile || "answer_overrides",
        sourceType: overrideMatchFirst.row.correctModule || overrideMatchFirst.row.correctFolder || "USER_TAUGHT_OVERRIDE",
        heading: "User-taught answer",
        score: Math.round(Number(overrideMatchFirst.score || 0) * 100),
        preview: String(overrideMatchFirst.row.correctAnswer || "").slice(0, 240),
      }];
      const confidenceScore = Math.max(0.72, Math.min(0.96, Number(overrideMatchFirst.score || 0)));
      if (userId) insertChatLog(userId, message, overrideAnswer);
      saveAnalysisHistory({ userId, sessionId, question: message, answer: overrideAnswer });
      saveRetrievalLog({ question: message, route: queryRoute, retrievalMode: "override", trace: activeChatTrace, answer: overrideAnswer, confidenceScore, answerStatus: "used_override" });
      return res.json({
        answer: overrideAnswer,
        confidence: confidenceScore,
        answerStatus: "used_override",
        answerLabel: "User-taught answer",
        sources: extractSourcesFromAnswer(overrideAnswer),
        suggestedQuestions: sourceAwareSuggestedQuestions(activeChatTrace, queryRoute, "used_override"),
        retrievalDebug: activeChatTrace,
      });
    }
    const routingPlan = retrievalRoutePlan(message, parsed, queryRoute);
    activeChatTrace.selectedRoute = routingPlan.selectedRoute;
    activeChatTrace.reasonSelected = routingPlan.ambiguous
      ? "Document and SQLite signals were both detected; both confidence channels are measured."
      : routingPlan.selectedRoute === "sqlite"
      ? "Structured data signals were stronger than document-policy signals."
      : "Document/policy/source-text signals were stronger than structured-data signals.";
    if (routingPlan.ambiguous || routingPlan.selectedRoute === "both") {
      const [documentConfidence, sqliteConfidence] = await Promise.all([
        estimateDocumentConfidence(message, parsed, queryRoute, attachedIds).catch(() => 0),
        Promise.resolve(estimateSqliteConfidence(message, parsed, queryRoute)),
      ]);
      activeChatTrace.documentConfidence = documentConfidence;
      activeChatTrace.sqliteConfidence = sqliteConfidence;
      if (documentConfidence < 0.25 && sqliteConfidence < 0.25) {
        const clarification = [
          "**Direct Answer**",
          "I can search both uploaded documents and parsed dashboard/SQLite data, but this question is ambiguous and both routes look weak.",
          "",
          "**Suggested Next Action**",
          "- Ask whether you want policy/document guidance or dashboard/data results.",
          "- Include a folder, module, municipality, source file, or metric name.",
        ].join("\n");
        const confidenceScore = 0.2;
        saveRetrievalLog({ question: message, route: queryRoute, retrievalMode: "both", trace: activeChatTrace, answer: clarification, confidenceScore, answerStatus: "low_confidence" });
        return res.json({
          answer: clarification,
          confidence: confidenceScore,
          answerStatus: "low_confidence",
          sources: [],
          suggestedQuestions: sourceAwareSuggestedQuestions(activeChatTrace, queryRoute, "low_confidence"),
          retrievalDebug: activeChatTrace,
        });
      }
      activeChatTrace.selectedRoute = Math.abs(documentConfidence - sqliteConfidence) < 0.12
        ? "both"
        : documentConfidence > sqliteConfidence
        ? "document"
        : "sqlite";
      activeChatTrace.reasonSelected = `documentConfidence=${documentConfidence.toFixed(2)}, sqliteConfidence=${sqliteConfidence.toFixed(2)}`;
    } else {
      activeChatTrace.documentConfidence = routingPlan.selectedRoute === "document" ? await estimateDocumentConfidence(message, parsed, queryRoute, attachedIds).catch(() => 0) : 0;
      activeChatTrace.sqliteConfidence = routingPlan.selectedRoute === "sqlite" ? estimateSqliteConfidence(message, parsed, queryRoute) : 0;
    }
    const overrideMatch = findAnswerOverride(message);
    if (overrideMatch) {
      const overrideAnswer = answerFromOverride(overrideMatch);
      activeChatTrace.finalSourceUsed = {
        source: overrideMatch.row.correctSourceFile || "answer_overrides",
        sourceType: overrideMatch.row.correctModule || overrideMatch.row.correctFolder || "USER_TAUGHT_OVERRIDE",
        answerMode: "user_taught_override",
        score: Math.round(Number(overrideMatch.score || 0) * 100),
      };
      activeChatTrace.finalEvidenceText = overrideMatch.row.correctAnswer;
      activeChatTrace.evidenceVerificationPassed = true;
      activeChatTrace.selectedSourceTypes = ["USER_TAUGHT_OVERRIDE"];
      activeChatTrace.topRetrievedChunks = [{
        source: overrideMatch.row.correctSourceFile || "answer_overrides",
        sourceType: overrideMatch.row.correctModule || overrideMatch.row.correctFolder || "USER_TAUGHT_OVERRIDE",
        heading: "User-taught answer",
        score: Math.round(Number(overrideMatch.score || 0) * 100),
        preview: String(overrideMatch.row.correctAnswer || "").slice(0, 240),
      }];
      const confidenceScore = Math.max(0.72, Math.min(0.96, Number(overrideMatch.score || 0)));
      if (userId) insertChatLog(userId, message, overrideAnswer);
      saveAnalysisHistory({ userId, sessionId, question: message, answer: overrideAnswer });
      saveRetrievalLog({ question: message, route: queryRoute, retrievalMode: "override", trace: activeChatTrace, answer: overrideAnswer, confidenceScore, answerStatus: "used_override" });
      return res.json({
        answer: overrideAnswer,
        confidence: confidenceScore,
        answerStatus: "used_override",
        answerLabel: "User-taught answer",
        sources: extractSourcesFromAnswer(overrideAnswer),
        suggestedQuestions: sourceAwareSuggestedQuestions(activeChatTrace, queryRoute, "used_override"),
        retrievalDebug: activeChatTrace,
      });
    }
    const preRouteAnswer = await composePreRouteGeneralIntentAnswer(message, parsed, attachedIds, activeChatTrace);
    if (preRouteAnswer) {
      let checkedPreRouteAnswer = preRouteAnswer;
      const missingPreRouteTerms = !activeChatTrace.sqliteResult && activeChatTrace.selectedRoute !== "override"
        ? unsupportedQuestionTerms(message, activeChatTrace)
        : [];
      if (missingPreRouteTerms.length >= 2) {
        activeChatTrace.verificationFailReason = `question terms not supported by retrieved evidence: ${missingPreRouteTerms.join(", ")}`;
        activeChatTrace.unsupportedQuestionTerms = missingPreRouteTerms;
        activeChatTrace.evidenceVerificationPassed = false;
        checkedPreRouteAnswer = cannotAnswerFromUploadedData(activeChatTrace);
      }
      if (userId) insertChatLog(userId, message, checkedPreRouteAnswer);
      saveAnalysisHistory({ userId, sessionId, question: message, answer: checkedPreRouteAnswer });
      insertAuditLog({ userId, action: "ask_question", feature: "chat", details: { question: message, attachmentIds, sources: extractSourcesFromAnswer(checkedPreRouteAnswer), preRouteHandler: true } });
      const confidenceScore = computeRetrievalConfidence(activeChatTrace, checkedPreRouteAnswer, queryRoute);
      const answerStatus = answerStatusFor(checkedPreRouteAnswer, confidenceScore, Boolean(activeChatTrace.finalEvidenceText || activeChatTrace.sqliteResult || extractSourcesFromAnswer(checkedPreRouteAnswer).length));
      saveRetrievalLog({ question: message, route: queryRoute, retrievalMode: "pre_route", trace: activeChatTrace, answer: checkedPreRouteAnswer, confidenceScore, answerStatus });
      return res.json({
        answer: checkedPreRouteAnswer,
        confidence: confidenceScore,
        answerStatus,
        sources: extractSourcesFromAnswer(checkedPreRouteAnswer),
        suggestedQuestions: sourceAwareSuggestedQuestions(activeChatTrace, queryRoute, answerStatus),
        retrievalDebug: activeChatTrace,
      });
    }
    const dataIntent = ["count", "analyze dataset", "compare/match", "report", "chart"].includes(parsed.intentType) || chartRequested(message);
    const analyticsIntent = analyticsRequested(message);
    const isAnalyticalQuestion = Boolean(dataIntent || analyticsIntent || queryRoute.retrievalMode === "structured" || queryRoute.retrievalMode === "cross_check");
    const isFollowUpQuestion = /\b(that|this|it|same|previous|above|mentioned|continue|what about|how about|give me a copy|download it)\b/i.test(message);
    console.log(`[ACTIVE_CHAT_ROUTE_USED] ${JSON.stringify({
      route: activeChatTrace.route,
      userQuery: message,
      detectedIntent: queryRoute.intent,
      selectedSourceTypes: [...queryRoute.primarySourceTypes, ...queryRoute.secondarySourceTypes],
      isAnalyticalQuestion,
      isFollowUp: isFollowUpQuestion,
      previousContextUsed: activeChatTrace.previousContextUsed,
      retrievalMode: queryRoute.retrievalMode,
    })}`);
    if (activeChatTrace.previousContextUsed) console.log(`[FOLLOWUP_CONTEXT_USED] ${JSON.stringify({ userQuery: message, previousContext: previousAnswerContext })}`);
    if (memory.length) console.log(`[MEMORY] loaded=${memory.length} user=${userId || "anonymous"} keys=${memory.map((item) => item.memory_key).join(",")}`);
    console.log(`[QUERY] intent=${classified.intent} routed=${queryRoute.intent} confidence=${queryRoute.confidence} strict=${strictIntent} action=${parsed.action} type=${parsed.docType} topic=[${parsed.topicTerms}] fields=[${parsed.requiredFields}] excel=${parsed.needsExcel} chart=${parsed.needsChart}`);
    debugRetrieval("route", { strictIntent, retrievalPlan: createRetrievalPlan(message), queryRoute, modules: deterministicModuleRoute(message, parsed), filters: extractStrictFilters(message, parsed) });

    let answer = "";
    let skipModelFinalizer = false;
    const wantsDiagnostics = /files checked|debug|source selection|calculation details|show diagnostics/i.test(message);
    const plannedRetrievalMode = isFileRequest(message) || queryRoute.intent === "document_download"
      ? "download"
      : isAnalyticalQuestion
      ? "sqlite"
      : queryRoute.retrievalMode === "rag_text" || queryRoute.retrievalMode === "classified_document"
      ? "document"
      : "mixed";
    console.log(`[RETRIEVAL_BEFORE] ${JSON.stringify({
      userQuery: message,
      retrievalMode: plannedRetrievalMode,
      filtersApplied: extractStrictFilters(message, parsed),
      sourceTypeFilter: [...queryRoute.primarySourceTypes, ...queryRoute.secondarySourceTypes],
      documentTypeFilter: parsed.docType,
      queryTermsUsed: Array.from(new Set([...tokenizeForSearch(message), ...tokenizeForSearch(expandedRetrievalQuestion)])),
    })}`);
    if (plannedRetrievalMode === "sqlite" || activeChatTrace.selectedRoute === "sqlite" || activeChatTrace.selectedRoute === "both") {
      const rowFallback = keywordFallbackRows(message, attachedIds);
      activeChatTrace.topRows = rowFallback.results.slice(0, 3);
      if (rowFallback.results.length && !activeChatTrace.keywordFallbackUsed) {
        activeChatTrace.keywordFallbackUsed = true;
        activeChatTrace.keywordTermsUsed = Array.from(new Set([...(activeChatTrace.keywordTermsUsed || []), ...rowFallback.terms]));
        activeChatTrace.keywordResultCount = Number(activeChatTrace.keywordResultCount || 0) + rowFallback.results.length;
      }
    }
    const multiIntentAnswer = await composeMultiIntentAnswer(message, sessionId, attachedIds, activeChatTrace);
    const phaseCorrectionAnswer = multiIntentAnswer ? "" : composePhaseCorrectionAnswer(message);
    const genericHybridAnswer = multiIntentAnswer || phaseCorrectionAnswer ? "" : await composeGenericHybridTopDescriptionAnswer(message, parsed, queryRoute, attachedIds, activeChatTrace);
    const genericTopNPerGroupAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer ? "" : composeGenericTopNPerGroupAnswer(message, activeChatTrace);
    const genericColumnValueTopAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer ? "" : composeGenericColumnValueTopAnswer(message, activeChatTrace);
    const genericGlobalTopValueAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer ? "" : composeGenericGlobalTopValueAnswer(message, activeChatTrace);
    const genericDistinctListingAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer ? "" : composeGenericDistinctListingAnswer(message, activeChatTrace);
    const genericRelativeDateAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer ? "" : composeGenericRelativeDateAnswer(message, activeChatTrace);
    const genericSimpleCountAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer ? "" : composeGenericSimpleCountAnswer(message, activeChatTrace);
    const longDocumentSummary = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer ? "" : await composeLongDocumentSummary(message, activeChatTrace);
    const columnDiscoveryAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer || longDocumentSummary ? "" : composeColumnDiscoveryAnswer(message, activeChatTrace);
    const missingValueAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer || longDocumentSummary || columnDiscoveryAnswer ? "" : composeMissingValueAnswer(message, activeChatTrace);
    const dualAxisAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer || longDocumentSummary || columnDiscoveryAnswer || missingValueAnswer ? "" : composeDualAxisChartAnswer(message, activeChatTrace);
    const yearTrendAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer || longDocumentSummary || columnDiscoveryAnswer || missingValueAnswer || dualAxisAnswer ? "" : composeYearTrendAnswer(message, activeChatTrace);
    const dateRangeCountAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer || longDocumentSummary || columnDiscoveryAnswer || missingValueAnswer || dualAxisAnswer || yearTrendAnswer ? "" : composeDateRangeCountAnswer(message, activeChatTrace);
    const crossTableRatioAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer || longDocumentSummary || columnDiscoveryAnswer || missingValueAnswer || dualAxisAnswer || yearTrendAnswer || dateRangeCountAnswer ? "" : composeCrossTableRatioAnswer(message, activeChatTrace);
    const numericComparisonAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer || longDocumentSummary || columnDiscoveryAnswer || missingValueAnswer || dualAxisAnswer || yearTrendAnswer || dateRangeCountAnswer || crossTableRatioAnswer ? "" : composeNumericComparisonAnswer(message, activeChatTrace);
    const hybridPhaseAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer || longDocumentSummary || columnDiscoveryAnswer || missingValueAnswer || dualAxisAnswer || yearTrendAnswer || dateRangeCountAnswer || crossTableRatioAnswer || numericComparisonAnswer ? "" : composeHybridPhaseAnswer(message, activeChatTrace);
    const metadataAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer || longDocumentSummary || columnDiscoveryAnswer || missingValueAnswer || dualAxisAnswer || yearTrendAnswer || dateRangeCountAnswer || crossTableRatioAnswer || numericComparisonAnswer || hybridPhaseAnswer ? "" : composeMetadataQueryAnswer(message, activeChatTrace);
    const genericFilteredRowsAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer || longDocumentSummary || columnDiscoveryAnswer || missingValueAnswer || dualAxisAnswer || yearTrendAnswer || dateRangeCountAnswer || crossTableRatioAnswer || numericComparisonAnswer || hybridPhaseAnswer || metadataAnswer ? "" : composeGenericFilteredRowsAnswer(message, activeChatTrace);
    const filteredRowsAnswer = multiIntentAnswer || phaseCorrectionAnswer || genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer || longDocumentSummary || columnDiscoveryAnswer || missingValueAnswer || dualAxisAnswer || yearTrendAnswer || dateRangeCountAnswer || crossTableRatioAnswer || numericComparisonAnswer || hybridPhaseAnswer || metadataAnswer || genericFilteredRowsAnswer ? "" : composeFilteredPersonalRowsAnswer(message, activeChatTrace);

    if (multiIntentAnswer) {
      answer = multiIntentAnswer;
      activeChatTrace.sqliteResult = answer;
      skipModelFinalizer = true;
    } else if (phaseCorrectionAnswer) {
      answer = phaseCorrectionAnswer;
      activeChatTrace.finalEvidenceText = answer;
      activeChatTrace.finalSourceUsed = { sourceType: "SLP_PHASE_LOOKUP", answerMode: "phase_correction" };
      skipModelFinalizer = true;
    } else if (genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer) {
      answer = genericHybridAnswer || genericTopNPerGroupAnswer || genericColumnValueTopAnswer || genericGlobalTopValueAnswer || genericDistinctListingAnswer || genericRelativeDateAnswer || genericSimpleCountAnswer;
      if (!activeChatTrace.sqliteResult) activeChatTrace.sqliteResult = answer;
      activeChatTrace.selectedSourceTypes = ["SQLite"];
      skipModelFinalizer = true;
    } else if (longDocumentSummary) {
      answer = longDocumentSummary;
      skipModelFinalizer = true;
    } else if (columnDiscoveryAnswer || missingValueAnswer || dualAxisAnswer || yearTrendAnswer || dateRangeCountAnswer || crossTableRatioAnswer || numericComparisonAnswer || hybridPhaseAnswer) {
      answer = columnDiscoveryAnswer || missingValueAnswer || dualAxisAnswer || yearTrendAnswer || dateRangeCountAnswer || crossTableRatioAnswer || numericComparisonAnswer || hybridPhaseAnswer;
      activeChatTrace.sqliteResult = answer;
      activeChatTrace.selectedSourceTypes = ["SQLite"];
      skipModelFinalizer = true;
    } else if (metadataAnswer) {
      answer = metadataAnswer;
      activeChatTrace.sqliteResult = answer;
      activeChatTrace.selectedSourceTypes = ["SLPIS_PERSONAL_MODULE", "SQLite"];
      activeChatTrace.finalSourceUsed = { sourceType: "SLPIS_PERSONAL_MODULE", answerMode: "sqlite_metadata" };
      skipModelFinalizer = true;
    } else if (genericFilteredRowsAnswer) {
      answer = genericFilteredRowsAnswer;
      activeChatTrace.sqliteResult = answer;
      activeChatTrace.selectedSourceTypes = ["SQLite"];
      activeChatTrace.finalSourceUsed = { sourceType: "SQLite", answerMode: "sqlite_generic_filtered_rows" };
      skipModelFinalizer = true;
    } else if (filteredRowsAnswer) {
      answer = filteredRowsAnswer;
      activeChatTrace.sqliteResult = answer;
      activeChatTrace.selectedSourceTypes = ["SLPIS_PERSONAL_MODULE", "SQLite"];
      activeChatTrace.finalSourceUsed = { sourceType: "SLPIS_PERSONAL_MODULE", answerMode: "sqlite_filtered_rows" };
      skipModelFinalizer = true;
    } else if (/show matching rows/i.test(message)) {
      const latest = lastRetrievalDebug;
      const rows = latest?.matchedRows || [];
      answer = [
        "**Direct Answer**",
        latest ? `Latest retrieval matched ${latest.rowsMatched || 0} row(s) for intent ${latest.intent}.` : "No retrieval debug log is available yet.",
        "",
        "**Relevant Rows**",
        rows.length ? markdownTable(["Source", "Row", "Data"], rows.slice(0, 25).map((row: any) => [row.source || "-", String(row.rowNumber || "-"), JSON.stringify(row.values || row).slice(0, 400)])) : "No rows stored.",
        "",
        "**Source Used**",
        latest ? `- In-memory retrieval debug ${latest.createdAt}` : "- None",
      ].join("\n");
      skipModelFinalizer = true;
    } else if (wantsDiagnostics) {
      const routedDebug = await composeSlpRoutedAnswer(message, parsed, attachedIds);
      answer = routedDebug || await composeFilesCheckedDebug(message, parsed, attachedIds);
      skipModelFinalizer = true;
    } else if (/^\s*show\s+(?:me\s+)?(?:a\s+)?chart\s*$/i.test(message)) {
      answer = composeChartFromPreviousResult(sessionId);
      skipModelFinalizer = true;
    } else if (analyticsIntent && !isFileRequest(message)) {
      console.log(`[ACTIVE_ANALYTICS_ROUTE_USED] ${JSON.stringify({ userQuery: message, detectedIntent: queryRoute.intent, sourceTypes: activeChatTrace.selectedSourceTypes })}`);
      const participantMunicipalityChart = /participant|beneficiar|client/i.test(message) && /municipality|city/i.test(message)
        ? composeParticipantsByMunicipalityChart()
        : "";
      const topProjects = /top|most|least|project/i.test(message) && /project/i.test(message) && /municipality|city/i.test(message)
        ? composeTopProjectsByMunicipality(message)
        : "";
      const deterministicLookup = ["participant_lookup", "participant_count", "project_analytics", "gur_status", "training_question", "monitoring_status", "dpt_question", "duplicate_check"].includes(queryRoute.intent) || queryRoute.retrievalMode === "structured" || queryRoute.retrievalMode === "cross_check"
        ? buildRowLookupAnswer(message, parsed)
        : null;
      answer = participantMunicipalityChart || topProjects || deterministicLookup?.answer || analyzeData([], message, sessionId, attachedIds);
      activeChatTrace.sqliteResult = deterministicLookup ? { answer: deterministicLookup.answer, debug: deterministicLookup.debug } : answer;
      if (!deterministicLookup) {
        console.log(`[SQLITE_RETRIEVAL_RESULTS] ${JSON.stringify({
          userQuery: message,
          selectedTables: ["uploaded_sheets", "sheet_rows", "sheet_columns"],
          tableSchemas: sqliteTableSchemasForDebug(["uploaded_sheets", "sheet_rows", "sheet_columns"]),
          generatedSql: "analytics helpers over indexed SQLite sheet_rows JSON",
          rowCountReturned: String(answer || "").includes("I cannot answer this from the available data") ? 0 : null,
          first5ResultRows: [],
        })}`);
      }
      skipModelFinalizer = true;
    } else if (queryRoute.intent === "document_download" || isFileRequest(message)) {
      answer = await composeFileRequestAnswer(message, attachedIds, sessionId, activeChatTrace);
      skipModelFinalizer = true;
    } else if (queryRoute.retrievalMode === "classified_document" || isDocumentRecommendationRequest(message)) {
      answer = await composeClassifiedDocumentAnswer(retrievalQuestion, sessionId, attachedIds, activeChatTrace);
      if (!answer && queryRoute.primarySourceTypes.includes("PROPOSAL")) answer = await answerFromRoutedDocumentText(retrievalQuestion, { ...parsed, docType: "proposal", intentType: "explanation/definition" }, queryRoute, attachedIds, activeChatTrace);
      if (answer) skipModelFinalizer = true;
    } else if (queryRoute.intent === "guideline_question" || queryRoute.retrievalMode === "rag_text" && queryRoute.primarySourceTypes.some((type) => ["GUIDELINES", "OTHER_DOCUMENTS", "IMAGE"].includes(type))) {
      answer = await answerFromRoutedDocumentText(retrievalQuestion, { ...parsed, docType: queryRoute.primarySourceTypes.includes("GUIDELINES") ? "guideline" : parsed.docType, intentType: "explanation/definition" }, queryRoute, attachedIds, activeChatTrace);
      skipModelFinalizer = true;
    } else if (/proposal|proposed project|project proposal/i.test(message)) {
      answer = await composeClassifiedDocumentAnswer(retrievalQuestion, sessionId, attachedIds, activeChatTrace) || await answerFromDocumentText(retrievalQuestion, { ...parsed, docType: "proposal", intentType: "explanation/definition" }, attachedIds, activeChatTrace);
      skipModelFinalizer = true;
    } else if (/guidelines?|mc\s*0?3|policy|slp phases?|implementation phases?/i.test(message) && !/(participant|beneficiary|project id|grant code|gur|served|training|operational|closed|association|enterprise)/i.test(message)) {
      answer = await answerFromDocumentText(retrievalQuestion, { ...parsed, docType: "guideline", intentType: "explanation/definition" }, attachedIds, activeChatTrace);
      skipModelFinalizer = true;
    } else {
      const allowRowLookup = ["participant_lookup", "participant_count", "project_analytics", "gur_status", "training_question", "monitoring_status", "dpt_question", "duplicate_check"].includes(queryRoute.intent)
        || queryRoute.retrievalMode === "structured"
        || queryRoute.retrievalMode === "cross_check";
      const deterministicLookup = allowRowLookup ? buildRowLookupAnswer(message, parsed) : null;
      if (deterministicLookup) {
        answer = deterministicLookup.answer;
        activeChatTrace.sqliteResult = { answer: deterministicLookup.answer, debug: deterministicLookup.debug };
        skipModelFinalizer = true;
        console.log(`[RETRIEVAL] ${JSON.stringify(deterministicLookup.debug)}`);
        logDebugInfo({
          intent: deterministicLookup.debug.intent,
          modules: deterministicLookup.debug.selectedModules as SlpModuleTag[],
          columns: deterministicLookup.debug.selectedColumns,
          matched: deterministicLookup.debug.matchedRows,
          selected: deterministicLookup.debug.selectedSource,
          reason: deterministicLookup.debug.answerType,
        });
        storeRetrievalDebug({
          userId,
          sessionId,
          question: message,
          intent: deterministicLookup.debug.intent,
          modules: deterministicLookup.debug.selectedModules,
          queryUsed: `SQLite sheet_rows via modules: ${(deterministicLookup.debug.selectedModules || []).join(", ")}; filters=${JSON.stringify(deterministicLookup.debug.filters || {})}`,
          rowsMatched: deterministicLookup.debug.matchedRows,
          reason: deterministicLookup.debug.answerType,
          filesChecked: deterministicLookup.debug.selectedSource ? deterministicLookup.debug.selectedSource.split("; ") : [],
          matchedRows: extractRowsForDebug(message, parsed, deterministicLookup.debug.selectedModules as SlpModuleTag[]),
        });
      }
    }
    if (!answer) {
      if (queryRoute.intent === "unclear") {
        answer = composeLowConfidenceSourceAnswer(message, queryRoute);
        skipModelFinalizer = true;
      } else if (/open last|show previous|continue previous|last analysis/i.test(message)) {
        answer = composeLastAnalysis(sessionId);
      } else if (/generate report|create report|make report ready|export this result|export report/i.test(message)) {
        answer = composeReportFromHistory(sessionId, message, userId);
        if (answer === NO_RELEVANT_SOURCE_MESSAGE) { answer = analyzeData([], message, sessionId, attachedIds); activeChatTrace.sqliteResult = answer; }
      } else if (chartRequested(message) || /dashboard|create chart|make dashboard|show visits by|closed vs operational|top projects|education breakdown|trend by month/i.test(message)) {
        const participantMunicipalityChart = /participant|beneficiar|client/i.test(message) && /municipality|city/i.test(message)
          ? composeParticipantsByMunicipalityChart()
          : "";
        const routed = participantMunicipalityChart || await composeSlpRoutedAnswer(message, parsed, attachedIds);
        if (routed) {
          answer = routed;
          activeChatTrace.sqliteResult = routed;
          skipModelFinalizer = true;
        } else {
          answer = composeDashboardAnswer(message, sessionId, attachedIds);
          activeChatTrace.sqliteResult = answer;
        }
      } else if (/vlookup|xlookup|countifs|sumifs|formula|pivot table formula|explain this formula/i.test(message)) {
        answer = composeFormulaAssistant(message, attachedIds.length ? loadSheetSources({ attachmentIds: attachedIds }) : loadSheetSources());
      } else if (/show\s+ocr\s+status|ocr\s+status|vision\s+status/i.test(message)) {
        answer = composeOcrStatusDebug(attachedIds);
      } else if (/data quality|duplicate participants?|missing municipality|blank status|invalid grant|inconsistent names|blank names?|missing barangay|missing visit|missing education|missing project/i.test(message)) {
        const sources = attachedIds.length ? loadSheetSources({ attachmentIds: attachedIds }) : loadSheetSources();
        answer = sources.length ? composeDataQualityReport(sources, message) : noUploadedSourceAnswer(parsed, [], "No parseable spreadsheet rows were found for data quality checks.");
        activeChatTrace.sqliteResult = answer;
      } else if (isWritingEditingRequest(message)) {
        answer = await answerWritingEditingRequest(message);
      } else {
        const slpRoutedAnswer = await composeSlpRoutedAnswer(message, parsed, attachedIds);
        if (slpRoutedAnswer) {
          answer = slpRoutedAnswer;
          skipModelFinalizer = true;
        }
      }
    }

    if (!answer) {
      if (wantsDiagnostics) {
        answer = await composeFilesCheckedDebug(message, parsed, attachedIds);
      } else if (attachedIds.length && dataIntent) {
        answer = analyzeData([], message, sessionId, attachedIds);
        activeChatTrace.sqliteResult = answer;
        if (isNoUploadedSourceAnswer(answer)) answer = await answerFromDocumentText(message, parsed, attachedIds, activeChatTrace);
      } else if (parsed.intentType === "explanation/definition") {
        answer = await answerFromRoutedDocumentText(retrievalQuestion, parsed, queryRoute, attachedIds, activeChatTrace);
        if (!answer) answer = composeLowConfidenceSourceAnswer(message, queryRoute);
        skipModelFinalizer = true;
      } else if (dataIntent) {
        answer = analyzeData([], message, sessionId, []);
        activeChatTrace.sqliteResult = answer;
      } else {
        answer = await answerFromRoutedDocumentText(retrievalQuestion, parsed, queryRoute, attachedIds, activeChatTrace);
        if (!isNoUploadedSourceAnswer(answer)) skipModelFinalizer = true;
        if (isNoUploadedSourceAnswer(answer)) {
          const dataAnswer = analyzeData([], message, sessionId, attachedIds);
          if (!isNoUploadedSourceAnswer(dataAnswer)) { answer = dataAnswer; activeChatTrace.sqliteResult = dataAnswer; }
        }
        if (!answer) {
          answer = composeLowConfidenceSourceAnswer(message, queryRoute);
          skipModelFinalizer = true;
        }
      }
    }

     if (!skipModelFinalizer) answer = validateAnswerBeforeSend(answer, parsed);
     const sqliteSchema = !skipModelFinalizer || queryRoute.retrievalMode === "structured" || dataIntent || chartRequested(message) ? sqliteSchemaForPrompt() : "";
     if (!skipModelFinalizer) answer = await finalizeAnswerWithMainModel(message, answer, parsed, sqliteSchema);
     answer = ensureChartOutput(answer, message);
     const answerMode: "document" | "sqlite" | "mixed" | "fallback" = activeChatTrace.finalEvidenceText
       ? "document"
       : activeChatTrace.sqliteResult || queryRoute.retrievalMode === "structured" || dataIntent || chartRequested(message)
       ? "sqlite"
       : answer === NO_RELEVANT_SOURCE_MESSAGE
       ? "fallback"
       : "mixed";
     let modelVerificationPassed: boolean | null = await verifyAnswerRelevance({
       userQuestion: message,
       answer,
       finalEvidenceText: activeChatTrace.finalEvidenceText,
       retrievedChunks: activeChatTrace.topRetrievedChunks,
       sqliteResult: activeChatTrace.sqliteResult,
       answerMode,
       selectedSourceInfo: activeChatTrace.finalSourceUsed,
       parsed,
     });
     if (!modelVerificationPassed && activeChatTrace.finalSourceUsed?.answerMode === "generic_hybrid_query" && activeChatTrace.sqliteResult?.ok) {
       modelVerificationPassed = true;
       activeChatTrace.evidenceVerificationPassed = true;
       activeChatTrace.verificationFailReason = "";
       console.log(`[HYBRID_QUERY_VERIFICATION_BYPASS] ${JSON.stringify({ userQuery: message, reason: "SQLite aggregation succeeded; document retrieval was already attempted and included separately." })}`);
     }
     if (!modelVerificationPassed) {
       activeChatTrace.verificationFailReason = activeChatTrace.unsupportedTerms?.length
         ? `unsupported terms: ${activeChatTrace.unsupportedTerms.join(", ")}`
         : `verification failed for answer mode ${answerMode}`;
       activeChatTrace.fallbackReason = activeChatTrace.verificationFailReason;
       answer = composeVerifiedFallback(message, activeChatTrace);
       activeChatTrace.evidenceVerificationPassed = false;
     }
     const missingQuestionTerms = !activeChatTrace.sqliteResult && activeChatTrace.selectedRoute !== "override"
       ? unsupportedQuestionTerms(message, activeChatTrace)
       : [];
     if (missingQuestionTerms.length >= 2) {
       activeChatTrace.verificationFailReason = `question terms not supported by retrieved evidence: ${missingQuestionTerms.join(", ")}`;
       activeChatTrace.unsupportedQuestionTerms = missingQuestionTerms;
       activeChatTrace.evidenceVerificationPassed = false;
       answer = cannotAnswerFromUploadedData(activeChatTrace);
     }
     let confidenceScore = computeRetrievalConfidence(activeChatTrace, answer, queryRoute);
     let answerStatus = answerStatusFor(answer, confidenceScore, Boolean(activeChatTrace.finalEvidenceText || activeChatTrace.sqliteResult || extractSourcesFromAnswer(answer).length));
     if (answerStatus === "low_confidence" && !/I found possible related information, but the available uploaded data is not strong enough to answer confidently/i.test(answer)) {
       answer = lowConfidenceEvidenceAnswer(activeChatTrace);
       confidenceScore = computeRetrievalConfidence(activeChatTrace, answer, queryRoute);
       answerStatus = "low_confidence";
     }
     rememberChartsFromAnswer(sessionId, message, parsed, answer);
     if (userId) insertChatLog(userId, message, answer);
     saveUsefulChatMemory(userId, sessionId, message, parsed, classified, answer);
     if (activeChatTrace.finalSourceUsed && modelVerificationPassed) savePreviousAnswerContext(sessionId, { ...activeChatTrace.finalSourceUsed, evidenceText: activeChatTrace.finalEvidenceText || "" });
     console.log(`[ANSWER] type=${skipModelFinalizer ? "deterministic" : "model_finalized"} finalIntent=${classified.intent}`);
     const finalEvidencePassed = activeChatTrace.topRetrievedChunks?.length
       ? Boolean(activeChatTrace.evidenceVerificationPassed)
       : modelVerificationPassed !== false;
     console.log(`[ACTIVE_CHAT_ROUTE_USED_RESULT] ${JSON.stringify({
       route: activeChatTrace.route,
       userQuery: activeChatTrace.userQuery,
       detectedIntent: activeChatTrace.detectedIntent,
       selectedSourceTypes: activeChatTrace.selectedSourceTypes,
       previousContextUsed: activeChatTrace.previousContextUsed,
       filesSearched: activeChatTrace.filesSearched,
       topRetrievedChunks: activeChatTrace.topRetrievedChunks,
       finalSourceUsed: activeChatTrace.finalSourceUsed,
       evidenceVerificationPassed: finalEvidencePassed,
       modelVerificationPassed,
     })}`);
     saveAnalysisHistory({ userId, sessionId, question: message, answer });
    logRouteDiagnostics(queryRoute, message, answer, "", /\*\*Source Used\*\*|\nSource:\s+/i.test(answer));
    insertAuditLog({ userId, action: "ask_question", feature: "chat", details: { question: message, attachmentIds, sources: extractSourcesFromAnswer(answer) } });
    saveRetrievalLog({ question: message, route: queryRoute, retrievalMode: plannedRetrievalMode, trace: activeChatTrace, answer, confidenceScore, answerStatus });
    res.json({
      answer,
      confidence: confidenceScore,
      answerStatus,
      sources: extractSourcesFromAnswer(answer),
      suggestedQuestions: sourceAwareSuggestedQuestions(activeChatTrace, queryRoute, answerStatus),
      retrievalDebug: activeChatTrace,
    });
  } catch (err: any) {
    console.error("Chat error:", err);
    const fallbackAnswer = "I could not complete the answer. Please try a more specific keyword.";
    saveRetrievalLog({
      question: String(req.body?.message || ""),
      route: null,
      retrievalMode: "error",
      trace: {},
      answer: fallbackAnswer,
      confidenceScore: 0,
      answerStatus: "error",
      errorMessage: err.message || String(err),
    });
    res.json({ answer: fallbackAnswer, confidence: 0, answerStatus: "error", sources: [], suggestedQuestions: [], retrievalDebug: { errorMessage: err.message || String(err) } });
  }
}

app.post("/api/chat", handleChatRequest);
app.post("/api/chat-rag", handleChatRequest);
app.post("/api/ai/chat", handleChatRequest);

// =========================
// PROCESS DOCUMENT (background indexing)
// =========================
app.post("/api/process-document", async (req, res) => {
  try {
    const { documentId, fileUrl } = req.body;
    const { buffer, type } = await readDocumentBuffer(fileUrl);
    const sourceName = String(fileUrl || "");
    let text = "";
    if (/pdf/i.test(type) || /\.pdf(?:$|\?)/i.test(sourceName)) { text = await extractPdfText(buffer, documentId); }
    else if (/word|docx/i.test(type) || /\.docx(?:$|\?)/i.test(sourceName)) text = (await mammoth.extractRawText({ buffer })).value;
    else text = buffer.toString("utf-8");
    const chunks = chunkText(text);
    db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(documentId);
    const now = new Date().toISOString();
    for (let i = 0; i < chunks.length; i++) db.prepare("INSERT INTO document_chunks (id, document_id, chunk_index, content, chunk_size, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomId("chunk"), documentId, i, chunks[i], chunks[i].length, now);
    db.prepare("UPDATE documents SET content_text = ?, updated_at = ? WHERE id = ?").run(text, now, documentId);
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(documentId);
    if (doc) upsertOriginalFileMetadata(doc);
    console.log(`[INGESTION_INDEX_STATUS] ${JSON.stringify({
      documentId,
      fileName: doc?.file_name || fileUrl,
      folder: doc?.folder || "",
      sourceType: doc ? sourceTypeForFolder(doc.folder || "", doc.file_name || "", doc.file_type || "") : "",
      chunksCreated: chunks.length,
      textLength: text.length,
      route: "POST /api/process-document",
    })}`);
    res.json({ success: true, chunks: chunks.length });
  } catch (err: any) { console.error(err); res.status(500).json({ error: err.message }); }
});

let startupIndexingQueued = false;
function startApiServer(port: number) {
  const server = app.listen(port, () => {
    console.log(`API server running on http://localhost:${port}`);
    if (!startupIndexingQueued) {
      startupIndexingQueued = true;
      importExistingUploadsIntoSqlite()
        .then(indexExistingWorkbookDocuments)
        .then(() => {
          const result = reclassifyAllDocuments();
          if (result.updated) console.log(`Classified ${result.updated} uploaded document(s).`);
        })
        .catch((error) => console.error("Startup document indexing/classification failed:", error));
    }
  });
  server.on("error", (error: any) => {
    logBackendError(error, port);
    if (error?.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Stop the process using it or set PORT to another value.`);
    }
    process.exit(1);
  });
}
startApiServer(PORT);

function indexExistingWorkbookDocuments() {
  try {
    const docs = db.prepare("SELECT * FROM documents WHERE content_text LIKE '%__slpWorkbook%' AND id NOT IN (SELECT document_id FROM uploaded_files WHERE document_id IS NOT NULL)").all();
    for (const doc of docs) indexWorkbookDocument(doc);
    if (docs.length) console.log(`Indexed ${docs.length} existing workbook document(s) into SQLite sheet rows.`);
  } catch (error) {
    console.error("Workbook indexing failed:", error);
  }
}

async function importExistingUploadsIntoSqlite() {
  try {
    await fs.mkdir(UPLOAD_ROOT, { recursive: true });
    const folders = await fs.readdir(UPLOAD_ROOT, { withFileTypes: true });
    for (const folder of folders) {
      if (!folder.isDirectory() || !LOCAL_DOCUMENT_FOLDERS.has(folder.name)) continue;
      const folderPath = path.join(UPLOAD_ROOT, folder.name);
      const files = await fs.readdir(folderPath, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) continue;
        const localUrl = `local-upload://${folder.name}/${file.name}`;
        if (db.prepare("SELECT id FROM documents WHERE file_url = ?").get(localUrl)) continue;
        const filePath = path.join(folderPath, file.name);
        const stat = await fs.stat(filePath);
        const displayName = file.name.replace(/^\d{10,}_/, "");
        const buffer = await fs.readFile(filePath);
        const docId = randomId("doc");
        let text = "";
        if (/\.pdf$/i.test(displayName)) { text = await extractPdfText(buffer, docId, displayName); }
        else if (/\.(xlsx?|csv)$/i.test(displayName)) { const wb = XLSX.read(buffer, { type: "buffer" }); const sheets: any[] = []; wb.SheetNames.forEach(sn => sheets.push({ name: sn, rows: XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sn], { header: 1, defval: "", raw: false }) })); text = JSON.stringify({ __slpWorkbook: true, sheets }); }
        else if (/\.docx$/i.test(displayName)) { try { text = (await mammoth.extractRawText({ buffer })).value; } catch { text = ""; } }
        else if (/\.(png|jpe?g|webp)$/i.test(displayName)) { text = await extractImageWithVision(buffer, docId, displayName, { imageNumber: 1, method: "github models vision image" }); }
        else continue;
        const now = new Date().toISOString();
        db.prepare("INSERT INTO documents (id, file_name, file_url, folder, file_size, file_type, content_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(docId, displayName, localUrl, folder.name, stat.size, "", text, now, now);
        const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(docId);
        upsertOriginalFileMetadata(doc);
        if (/\.(xlsx?|csv)$/i.test(displayName)) indexWorkbookDocument(doc);
      }
    }
  } catch (error) { console.error("Import existing uploads failed:", error); }
}
