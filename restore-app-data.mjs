import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Get backup directory from command line argument
const backupDirArg = process.argv[2];

if (!backupDirArg) {
  console.error(chalk.red('❌ Please provide backup directory as argument'));
  console.error(chalk.yellow('Usage: node restore-app-data.mjs <backup-directory>'));
  console.error(chalk.yellow('Example: node restore-app-data.mjs backup-2024-05-14T10-30-45-123Z/'));
  process.exit(1);
}

// Resolve backup path
const backupDir = path.isAbsolute(backupDirArg) 
  ? backupDirArg 
  : path.join(__dirname, 'backups', backupDirArg);

const DB_EXPORT_PATH = path.join(backupDir, 'database-export.json');
const UPLOADS_BACKUP_DIR = path.join(backupDir, 'uploads');
const TARGET_DB_PATH = path.join(__dirname, 'data', 'slp-local.db');
const TARGET_UPLOADS_DIR = path.join(__dirname, 'uploads');

console.log(chalk.blue('🔄 Starting Data Restoration...'));
console.log(chalk.gray(`Backup directory: ${backupDir}`));

// Validate backup directory
if (!fs.existsSync(backupDir)) {
  console.error(chalk.red(`❌ Backup directory not found: ${backupDir}`));
  process.exit(1);
}

if (!fs.existsSync(DB_EXPORT_PATH)) {
  console.error(chalk.red(`❌ Database export file not found: ${DB_EXPORT_PATH}`));
  process.exit(1);
}

try {
  // ============================================
  // 1. Backup existing database
  // ============================================
  console.log(chalk.yellow('\n💾 Backing up existing database...'));
  
  if (fs.existsSync(TARGET_DB_PATH)) {
    const existingBackup = path.join(__dirname, `data/slp-local.db.backup-${Date.now()}`);
    fs.copyFileSync(TARGET_DB_PATH, existingBackup);
    console.log(chalk.green(`✓ Existing database backed up to: ${path.relative(__dirname, existingBackup)}`));
  }

  // ============================================
  // 2. Restore database
  // ============================================
  console.log(chalk.yellow('\n📊 Restoring database...'));
  
  const backupData = JSON.parse(fs.readFileSync(DB_EXPORT_PATH, 'utf8'));
  
  // Ensure data directory exists
  fs.ensureDirSync(path.dirname(TARGET_DB_PATH));
  
  // Create new database
  const db = new BetterSqlite3(TARGET_DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create tables and insert data
  let totalRecords = 0;
  for (const [tableName, tableData] of Object.entries(backupData.tables)) {
    try {
      const records = tableData.data;
      
      if (records.length === 0) {
        console.log(chalk.gray(`  ℹ ${tableName}: skipped (no data)`));
        continue;
      }

      // Get column names from first record
      const columns = Object.keys(records[0]);
      const columnList = columns.join(', ');
      const placeholders = columns.map(() => '?').join(', ');

      // Create INSERT statement
      const insertStmt = db.prepare(`INSERT INTO ${tableName} (${columnList}) VALUES (${placeholders})`);
      
      // Insert records
      const transaction = db.transaction((recs) => {
        for (const record of recs) {
          insertStmt.run(...columns.map(col => record[col]));
        }
      });

      transaction(records);
      totalRecords += records.length;
      console.log(chalk.green(`  ✓ ${tableName}: ${records.length} records restored`));
    } catch (error) {
      console.log(chalk.yellow(`  ⚠ ${tableName}: ${error.message}`));
    }
  }

  db.close();
  console.log(chalk.cyan(`✓ Total records restored: ${totalRecords}`));

  // ============================================
  // 3. Restore uploads
  // ============================================
  console.log(chalk.yellow('\n📁 Restoring uploads...'));
  
  if (fs.existsSync(UPLOADS_BACKUP_DIR)) {
    // Backup existing uploads
    if (fs.existsSync(TARGET_UPLOADS_DIR)) {
      const uploadsBackup = path.join(__dirname, `uploads.backup-${Date.now()}`);
      fs.copySync(TARGET_UPLOADS_DIR, uploadsBackup);
      console.log(chalk.green(`✓ Existing uploads backed up to: ${path.relative(__dirname, uploadsBackup)}`));
    }

    // Restore uploads
    fs.copySync(UPLOADS_BACKUP_DIR, TARGET_UPLOADS_DIR);
    
    let fileCount = 0;
    function countFiles(dir) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const itemPath = path.join(dir, item);
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          countFiles(itemPath);
        } else {
          fileCount++;
        }
      }
    }
    countFiles(TARGET_UPLOADS_DIR);
    
    console.log(chalk.green(`✓ Uploads restored: ${fileCount} files`));
  } else {
    console.log(chalk.yellow('⚠ No uploads backup found'));
  }

  // ============================================
  // 4. Summary
  // ============================================
  console.log(chalk.blue('\n' + '='.repeat(50)));
  console.log(chalk.green('✓ DATA RESTORATION COMPLETED!'));
  console.log(chalk.blue('='.repeat(50)));
  console.log(chalk.cyan(`\nDatabase restored to: ${path.relative(__dirname, TARGET_DB_PATH)}`));
  console.log(chalk.cyan(`Records restored: ${totalRecords}`));
  console.log(chalk.cyan(`\n📌 Please restart your application to apply the changes.`));

} catch (error) {
  console.error(chalk.red('\n✗ RESTORATION FAILED!'));
  console.error(chalk.red(error.message));
  console.error(chalk.red(error.stack));
  process.exit(1);
}
