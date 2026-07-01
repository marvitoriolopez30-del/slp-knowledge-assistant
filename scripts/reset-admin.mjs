import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3");

const email = (process.env.LOCAL_ADMIN_EMAIL || "mvltorio@dswd.gov.ph").trim().toLowerCase();
const password = process.env.LOCAL_ADMIN_PASSWORD || "admin123";
const appDataRoot = path.resolve(process.env.SLP_DATA_DIR || process.cwd());
const dbPath = path.resolve(appDataRoot, process.env.LOCAL_SQLITE_PATH || "slp-local.sqlite");

function randomId(prefix) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function hashPassword(value) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(value, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new BetterSqlite3(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const now = new Date().toISOString();
const existing = db.prepare("SELECT id FROM profiles WHERE lower(email) = lower(?)").get(email);

if (existing) {
  db.prepare("UPDATE profiles SET password_hash = ?, full_name = coalesce(nullif(full_name, ''), ?), role = 'admin', status = 'approved', updated_at = ? WHERE id = ?")
    .run(hashPassword(password), email, now, existing.id);
  console.log(`Reset admin account ${email} in ${dbPath}`);
} else {
  db.prepare("INSERT INTO profiles (id, email, password_hash, full_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'admin', 'approved', ?, ?)")
    .run(randomId("user"), email, hashPassword(password), email, now, now);
  console.log(`Created admin account ${email} in ${dbPath}`);
}

console.log("Default admin password:", password);
