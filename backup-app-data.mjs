import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const BACKUP_ROOT = path.join(__dirname, 'backups');
const DB_PATH = path.join(__dirname, 'data', 'slp-local.db');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const LEGACY_DB_PATH = path.join(__dirname, 'slp-local.sqlite');

// Use legacy DB if it exists, otherwise use the new one
const DATABASE_PATH = fs.existsSync(LEGACY_DB_PATH) ? LEGACY_DB_PATH : DB_PATH;

// Ensure backup directory exists
fs.ensureDirSync(BACKUP_ROOT);

console.log(chalk.blue('🔄 Starting SLP Knowledge Assistant Data Backup...'));
console.log(chalk.gray(`Database: ${DATABASE_PATH}`));
console.log(chalk.gray(`Uploads: ${UPLOADS_DIR}`));

// Create timestamped backup folder
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(BACKUP_ROOT, `backup-${timestamp}`);
fs.ensureDirSync(backupDir);

try {
  // ============================================
  // 1. Export Database
  // ============================================
  console.log(chalk.yellow('\n📊 Exporting database...'));
  
  const db = new BetterSqlite3(DATABASE_PATH);
  db.pragma('journal_mode = WAL');

  const tables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();

  const backupData = {
    exportedAt: new Date().toISOString(),
    databasePath: DATABASE_PATH,
    tables: {}
  };

  let totalRecords = 0;

  for (const table of tables) {
    const tableName = table.name;
    try {
      const records = db.prepare(`SELECT * FROM ${tableName}`).all();
      backupData.tables[tableName] = {
        count: records.length,
        data: records
      };
      totalRecords += records.length;
      console.log(chalk.green(`  ✓ ${tableName}: ${records.length} records`));
    } catch (error) {
      console.log(chalk.red(`  ✗ Error exporting ${tableName}: ${error.message}`));
    }
  }

  db.close();

  // Save database export
  const dbExportPath = path.join(backupDir, 'database-export.json');
  fs.writeFileSync(dbExportPath, JSON.stringify(backupData, null, 2));
  console.log(chalk.green(`✓ Database exported: ${dbExportPath}`));
  console.log(chalk.cyan(`  Total records: ${totalRecords}`));

  // ============================================
  // 2. Copy Uploads Directory
  // ============================================
  console.log(chalk.yellow('\n📁 Copying uploads...'));
  
  if (fs.existsSync(UPLOADS_DIR)) {
    const uploadsBackupDir = path.join(backupDir, 'uploads');
    fs.copySync(UPLOADS_DIR, uploadsBackupDir);
    
    // Count files recursively
    let fileCount = 0;
    let folderCount = 0;
    function countFiles(dir) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const itemPath = path.join(dir, item);
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          folderCount++;
          countFiles(itemPath);
        } else {
          fileCount++;
        }
      }
    }
    countFiles(uploadsBackupDir);
    
    console.log(chalk.green(`✓ Uploads copied to: ${uploadsBackupDir}`));
    console.log(chalk.cyan(`  Files: ${fileCount}, Folders: ${folderCount}`));
  } else {
    console.log(chalk.yellow('⚠ Uploads directory not found'));
  }

  // ============================================
  // 3. Copy Configuration Files
  // ============================================
  console.log(chalk.yellow('\n⚙️  Copying configuration files...'));
  
  const configFiles = [
    { src: path.join(__dirname, 'package.json'), dest: 'package.json' },
    { src: path.join(__dirname, 'tsconfig.json'), dest: 'tsconfig.json' },
    { src: path.join(__dirname, '.env'), dest: '.env' }
  ];

  for (const file of configFiles) {
    if (fs.existsSync(file.src)) {
      fs.copyFileSync(file.src, path.join(backupDir, file.dest));
      console.log(chalk.green(`✓ ${file.dest}`));
    }
  }

  // ============================================
  // 4. Create Backup Manifest
  // ============================================
  console.log(chalk.yellow('\n📋 Creating backup manifest...'));
  
  const manifest = {
    backupDate: new Date().toISOString(),
    backupPath: backupDir,
    backupVersion: '1.0',
    contents: {
      database: {
        path: 'database-export.json',
        tables: Object.keys(backupData.tables).length,
        totalRecords: totalRecords
      },
      uploads: {
        path: 'uploads/',
        status: fs.existsSync(UPLOADS_DIR) ? 'backed up' : 'not found'
      },
      configFiles: ['package.json', 'tsconfig.json', '.env']
    }
  };

  const manifestPath = path.join(backupDir, 'BACKUP-MANIFEST.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(chalk.green(`✓ Manifest created: ${manifestPath}`));

  // ============================================
  // 5. Create README for restoration
  // ============================================
  const readmeContent = `# SLP Knowledge Assistant Data Backup

## Backup Information
- **Created**: ${new Date().toISOString()}
- **Database Records**: ${totalRecords}
- **Backup Path**: ${backupDir}

## Contents

### database-export.json
Complete export of the SQLite database in JSON format. Contains all tables and data.

### uploads/
All uploaded documents organized by category:
- GUIDELINES/
- PROPOSALS/
- TEMPLATES/
- SLPIS/
- IMAGE/
- OTHER_DOCUMENTS/
- Chat_Attachments/

### Configuration Files
- package.json - Project dependencies
- tsconfig.json - TypeScript configuration
- .env - Environment variables

## Restoration Instructions

### To restore the database:
1. Close the application if running
2. Delete the existing database: \`data/slp-local.db\`
3. Run: \`node restore-app-data.mjs backup-${timestamp}/\`
4. Restart the application

### To restore uploads:
1. Copy the contents of \`uploads/\` folder to the app's \`uploads/\` directory

## Database Tables Backed Up:
${Object.keys(backupData.tables).map(t => `- ${t} (${backupData.tables[t].count} records)`).join('\n')}

## Size Information
- Total database size: ${(fs.statSync(dbExportPath).size / 1024 / 1024).toFixed(2)} MB
- Backup size: ${getDirectorySize(backupDir)} MB

---
Generated by SLP Knowledge Assistant Backup System
`;

  fs.writeFileSync(path.join(backupDir, 'README.md'), readmeContent);
  console.log(chalk.green(`✓ README created`));

  // ============================================
  // 6. Summary
  // ============================================
  console.log(chalk.blue('\n' + '='.repeat(50)));
  console.log(chalk.green('✓ BACKUP COMPLETED SUCCESSFULLY!'));
  console.log(chalk.blue('='.repeat(50)));
  console.log(chalk.cyan(`\nBackup Location: ${backupDir}`));
  console.log(chalk.cyan(`Database Records: ${totalRecords}`));
  console.log(chalk.cyan(`Backup Size: ${getDirectorySize(backupDir)} MB`));
  console.log(chalk.cyan(`\nYour data is now safely backed up on your local PC!`));
  console.log(chalk.green(`\n📌 Backup folder: ${path.relative(__dirname, backupDir)}`));

} catch (error) {
  console.error(chalk.red('\n✗ BACKUP FAILED!'));
  console.error(chalk.red(error.message));
  process.exit(1);
}

// Helper function to get directory size
function getDirectorySize(dir) {
  let size = 0;
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      size += getDirectorySize(filePath);
    } else {
      size += stat.size;
    }
  }

  return (size / 1024 / 1024).toFixed(2);
}
