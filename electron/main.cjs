const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const APP_NAME = "SLP Knowledge Assistant";
const PORT = 3001;
const PRODUCTION_APP_URL = `http://localhost:${PORT}`;
let serverProcess = null;
let logFilePath = "";

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (!logFilePath) return;
  try {
    fs.appendFileSync(logFilePath, `${line}\n`);
  } catch {
    // Logging must never prevent the desktop shell from starting.
  }
}

function appStartUrl() {
  const configured = String(process.env.ELECTRON_START_URL || "").trim();
  const allowDevUrl = process.env.ELECTRON_ALLOW_DEV_URL === "1";
  if (allowDevUrl && configured) return configured;
  return PRODUCTION_APP_URL;
}

function copyMissing(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  fs.cpSync(source, target, { recursive: true });
}

function prepareLocalData() {
  const dataDir = app.getPath("userData");
  logFilePath = path.join(dataDir, "electron-main.log");
  logLine(`Preparing local data in ${dataDir}`);
  const appRoot = app.getAppPath();
  const packagedSeedDir = path.join(process.resourcesPath, "seed");
  const seedDir = fs.existsSync(packagedSeedDir) ? packagedSeedDir : appRoot;

  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "templates"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "server", "generated-proposals"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "data"), { recursive: true });

  copyMissing(path.join(seedDir, "templates"), path.join(dataDir, "templates"));
  copyMissing(path.join(seedDir, "uploads"), path.join(dataDir, "uploads"));
  copyMissing(path.join(seedDir, "server", "generated-proposals"), path.join(dataDir, "server", "generated-proposals"));
  copyMissing(path.join(seedDir, "slp-local.sqlite"), path.join(dataDir, "slp-local.sqlite"));

  return dataDir;
}

function localIpAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

function waitForServer(url, timeoutMs = 45000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Server did not start within ${Math.round(timeoutMs / 1000)} seconds.`));
          return;
        }
        setTimeout(check, 500);
      });
      request.setTimeout(2500, () => request.destroy());
    };
    check();
  });
}

function startServer(dataDir) {
  const appRoot = app.getAppPath();
  const serverPath = path.join(appRoot, "dist-server", "server.cjs");
  const staticDir = path.join(appRoot, "dist");
  const useElectronNode = app.isPackaged;
  const serverRuntime = useElectronNode ? process.execPath : process.env.SLP_NODE_PATH || "node";
  const serverEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(PORT),
    SLP_DATA_DIR: dataDir,
    SLP_STATIC_DIR: staticDir,
  };

  if (useElectronNode) {
    serverEnv.ELECTRON_RUN_AS_NODE = "1";
  } else {
    delete serverEnv.ELECTRON_RUN_AS_NODE;
  }

  logLine(`Starting server runtime=${serverRuntime}`);
  logLine(`Server path=${serverPath} exists=${fs.existsSync(serverPath)}`);
  logLine(`Static dir=${staticDir} exists=${fs.existsSync(staticDir)}`);
  logLine(`Server data dir=${dataDir}`);

  serverProcess = spawn(serverRuntime, [serverPath], {
    env: serverEnv,
    stdio: "pipe",
    windowsHide: true,
  });

  serverProcess.stdout.on("data", (chunk) => logLine(`[server] ${chunk}`));
  serverProcess.stderr.on("data", (chunk) => logLine(`[server:error] ${chunk}`));
  serverProcess.on("error", (error) => logLine(`Server process error: ${error.message}`));
  serverProcess.on("exit", (code) => {
    logLine(`Server exited with code ${code}`);
  });
}

async function createWindow() {
  const dataDir = prepareLocalData();
  startServer(dataDir);

  try {
    await waitForServer(`http://localhost:${PORT}/api/health`);
    logLine(`Server ready at http://localhost:${PORT}/api/health`);
  } catch (error) {
    logLine(`Server readiness failed: ${error.message}`);
    dialog.showErrorBox(APP_NAME, `${error.message}\n\nPlease restart the app. If this keeps happening, check whether port ${PORT} is already in use.`);
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    title: APP_NAME,
    backgroundColor: "#ECFDF5",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(appStartUrl());
  logLine(`Window loading ${appStartUrl()}`);

  const lanUrls = localIpAddresses().map((ip) => `http://${ip}:${PORT}`).join(", ");
  logLine(lanUrls ? `LAN access: ${lanUrls}` : `LAN access: http://PC_IP_ADDRESS:${PORT}`);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
