const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const APP_ROOT = app.isPackaged
  ? path.resolve(process.resourcesPath, "..", "..")
  : path.resolve(__dirname, "..");
const DASHBOARD_HOST = "127.0.0.1";
const DEFAULT_DASHBOARD_PORT = 18000;
const GATEWAY_IDENTITY = "morphly-desktop-gateway";
const LOG_ROOT = path.join(APP_ROOT, "runtime-logs");
const SUPERVISOR_LOG = path.join(LOG_ROOT, "desktop-supervisor.log");
const APP_ICON = path.join(APP_ROOT, "Morphly-Voice-Dashboard", "public", "morphly-icon-512.png");
let mainWindow = null;
let supervisorProcess = null;
let ownsSupervisor = false;
let dashboardPort = DEFAULT_DASHBOARD_PORT;

function dashboardOrigin() {
  return `http://${DASHBOARD_HOST}:${dashboardPort}`;
}

function dashboardUrl(pathname = "/") {
  return new URL(pathname, `${dashboardOrigin()}/`).toString();
}

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
    const response = await fetch(dashboardUrl("/api/morphly/desktop-ready"), {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return false;
    const status = await response.json();
    return status?.ok === true
      && status?.service === GATEWAY_IDENTITY
      && status?.dashboardReady === true;
  } catch {
    return false;
  }
}

function canListenOn(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ host: DASHBOARD_HOST, port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen({ host: DASHBOARD_HOST, port: 0, exclusive: true }, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("Could not reserve a local dashboard port."));
      });
    });
  });
}

async function selectDashboardPort() {
  if (await canListenOn(DEFAULT_DASHBOARD_PORT)) {
    dashboardPort = DEFAULT_DASHBOARD_PORT;
    return;
  }
  dashboardPort = await findOpenPort();
}

function startSupervisor() {
  const runtime = pythonRuntime();
  fs.mkdirSync(LOG_ROOT, { recursive: true });
  const log = fs.openSync(SUPERVISOR_LOG, "a");
  const env = { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" };
  if (runtime.portable) env.PYTHONHOME = path.dirname(runtime.executable);

  supervisorProcess = spawn(runtime.executable, [
    path.join(APP_ROOT, "morphly_supervisor.py"),
    "--public-host", DASHBOARD_HOST,
    "--public-port", String(dashboardPort),
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
    try {
      if (new URL(url).origin === dashboardOrigin()) return;
    } catch {
      // Invalid navigation targets are blocked below.
    }
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
  if (!(await dashboardReady())) {
    await selectDashboardPort();
    startSupervisor();
  }
  await waitForDashboard();
  await mainWindow.loadURL(dashboardUrl());
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
