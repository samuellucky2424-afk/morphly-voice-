const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const APP_ROOT = app.isPackaged
  ? path.resolve(process.resourcesPath, "..", "..")
  : path.resolve(__dirname, "..");
const DASHBOARD_URL = "http://127.0.0.1:18000/";
const LOG_ROOT = path.join(APP_ROOT, "runtime-logs");
const SUPERVISOR_LOG = path.join(LOG_ROOT, "desktop-supervisor.log");
const APP_ICON = path.join(APP_ROOT, "Morphly-Voice-Dashboard", "public", "morphly-icon-512.png");
let mainWindow = null;
let supervisorProcess = null;
let ownsSupervisor = false;

app.setName("Morphly Voice");
app.setAppUserModelId("com.morphly.voice");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function pythonRuntime() {
  const portable = path.join(APP_ROOT, "runtime", "python", "python.exe");
  const development = path.join(APP_ROOT, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(portable)) return { executable: portable, portable: true };
  if (fs.existsSync(development)) return { executable: development, portable: false };
  throw new Error("The Morphly Python runtime is missing.");
}

async function dashboardReady() {
  try {
    const response = await fetch(DASHBOARD_URL, { signal: AbortSignal.timeout(750) });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

function startSupervisor() {
  const runtime = pythonRuntime();
  fs.mkdirSync(LOG_ROOT, { recursive: true });
  const log = fs.openSync(SUPERVISOR_LOG, "a");
  const env = { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" };
  if (runtime.portable) env.PYTHONHOME = path.dirname(runtime.executable);

  supervisorProcess = spawn(runtime.executable, [
    path.join(APP_ROOT, "morphly_supervisor.py"),
    "--public-host", "127.0.0.1",
    "--public-port", "18000",
    "--engine-host", "127.0.0.1",
    "--engine-port", "18001",
    "--startup-timeout", "120",
    "--dashboard-root", path.join(APP_ROOT, "Morphly-Voice-Dashboard", "dist-static"),
    "--default-mode", "rvc",
    "--firebase-project-id", "vdc-c3a79",
  ], {
    cwd: APP_ROOT,
    env,
    windowsHide: true,
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  ownsSupervisor = true;
  supervisorProcess.once("exit", () => { supervisorProcess = null; });
}

async function waitForDashboard(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dashboardReady()) return;
    if (ownsSupervisor && supervisorProcess === null) {
      throw new Error("The Morphly background service stopped during startup.");
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("The Morphly dashboard did not become ready in time.");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "Morphly Voice",
    width: 1440,
    height: 920,
    minWidth: 1050,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    icon: APP_ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(DASHBOARD_URL)) return;
    event.preventDefault();
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  return mainWindow.loadFile(path.join(__dirname, "loading.html"));
}

function showStartupError(error) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const message = String(error?.message || error).replace(/[&<>"']/g, "");
    void mainWindow.webContents.executeJavaScript(`
      document.getElementById('status').classList.add('error');
      document.getElementById('message').textContent = ${JSON.stringify(message + " Check runtime-logs/desktop-supervisor.log for details.")};
    `);
  } else {
    dialog.showErrorBox("Morphly Voice", String(error?.message || error));
  }
}

async function launch() {
  await createWindow();
  if (!(await dashboardReady())) startSupervisor();
  await waitForDashboard();
  await mainWindow.loadURL(DASHBOARD_URL);
}

app.whenReady().then(launch).catch(showStartupError);

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (!ownsSupervisor || !supervisorProcess?.pid) return;
  spawnSync("taskkill.exe", ["/PID", String(supervisorProcess.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  supervisorProcess = null;
});
