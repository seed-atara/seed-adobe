/**
 * SEED — the companion.
 *
 * This application exists for one reason: After Effects needs a panel in
 * Adobe's extensions folder and a Node service running behind it, and neither
 * of those should require an artist to open a terminal.
 *
 * It is deliberately not a second product. It installs the panel, sets the CEP
 * flag with the person's consent, keeps the service alive, and shows a light
 * saying whether it is up. Everything the artist actually does — including
 * entering their API keys — happens in the panel inside After Effects.
 *
 * The whole design rests on one measured fact: Electron 42 carries Node
 * 24.18.1, and `node:sqlite` with it. So the service runs on the binary that
 * is already here, with no vendored runtime and no native module anywhere in
 * the shell.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, Tray, nativeImage } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import { installPanel, panelTargetDir, removePanel } from "./cep.js";
import { enableDebugMode, readDebugMode, type DebugModeState } from "./debugMode.js";
import { ServiceSupervisor, type ServiceState } from "./service.js";
import { ensureToken, provisionPanel } from "./token.js";

/**
 * Pin the name before anything asks for a path.
 *
 * Electron derives its data directory from the app name, and resolves that
 * name differently depending on how it launched: from package.json when run
 * from source (`@seed-ae/installer`), but from the bundle's own metadata when
 * packaged (`SEED`). Left alone, a packaged build reads a *different*
 * catalogue from every dev run — which presents as every asset and generation
 * having vanished. harness-workbench hit exactly this and had to write a
 * migration to adopt the old folder; pinning it now costs nothing.
 */
app.setName("SEED");

/** Only one instance may own the port and the database. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const PORT = 47831;

interface Paths {
  /** The panel bundle that travelled inside this app. */
  panelSource: string;
  /** The bundled service entry point. */
  serviceEntry: string;
}

function resolvePaths(): Paths {
  const base = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), "resources");
  return {
    panelSource: path.join(base, "extension"),
    serviceEntry: path.join(base, "service", "index.js"),
  };
}

interface Status {
  service: ServiceState;
  detail: string;
  debugMode: DebugModeState;
  panelTarget: string;
  panelInstalled: boolean;
  version: string;
  baseUrl: string;
  log: string[];
}

let tray: Tray | undefined;
let window: BrowserWindow | undefined;
let supervisor: ServiceSupervisor | undefined;
let debugMode: DebugModeState = "unsupported";
let panelInstalled = false;
let lastError = "";

function status(): Status {
  return {
    service: supervisor?.currentState ?? "stopped",
    detail: lastError || (supervisor?.lastDetail ?? ""),
    debugMode,
    panelTarget: panelTargetDir(),
    panelInstalled,
    version: app.getVersion(),
    baseUrl: supervisor?.baseUrl ?? `http://127.0.0.1:${PORT}`,
    log: supervisor?.recentLog().slice(-40) ?? [],
  };
}

function broadcast(): void {
  window?.webContents.send("seed:status", status());
  refreshTray();
}

function refreshTray(): void {
  if (!tray) return;
  const state = supervisor?.currentState ?? "stopped";
  const label =
    state === "running"
      ? "SEED is running"
      : state === "starting"
        ? "SEED is starting…"
        : state === "failed"
          ? "SEED has stopped — click for details"
          : "SEED is not running";
  tray.setToolTip(label);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: "separator" },
      { label: "Open SEED", click: () => showWindow() },
      {
        label: "Restart the service",
        click: () => void supervisor?.restart(),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          void shutdown();
        },
      },
    ]),
  );
}

function showWindow(): void {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }

  window = new BrowserWindow({
    width: 560,
    height: 620,
    show: false,
    title: "SEED",
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "index.js"),
      // The window renders local HTML and talks to the main process over a
      // narrow, typed bridge. There is no reason for it to have Node.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void window.loadFile(path.join(app.getAppPath(), "dist", "window", "index.html"));
  window.once("ready-to-show", () => {
    window?.show();
    broadcast();
  });
  window.on("closed", () => {
    window = undefined;
  });
}

/**
 * The first-run conversation about PlayerDebugMode.
 *
 * Asked rather than done silently: this is a machine-wide "load unsigned
 * extensions" flag, and an application that flips one without saying so has
 * taken a decision that was not its to take. The wording avoids the word
 * "debug", which means nothing to the person reading it.
 */
async function ensureDebugMode(): Promise<void> {
  debugMode = await readDebugMode();
  if (debugMode !== "off") return;

  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Allow", "Not now"],
    defaultId: 0,
    cancelId: 1,
    title: "One permission needed",
    message: "Allow After Effects to load the SEED panel?",
    detail:
      "The SEED panel is not signed with an Adobe certificate yet, so After Effects " +
      "will not load it until this is switched on.\n\n" +
      "This changes a setting for your user account only. You can undo it at any " +
      "time from SEED's window.\n\n" +
      "Without it the panel will not appear in the Window > Extensions menu.",
  });

  if (response !== 0) {
    lastError = "The panel will not appear until this permission is allowed.";
    return;
  }

  const { written, failed } = await enableDebugMode();
  debugMode = await readDebugMode();
  if (debugMode !== "on") {
    lastError = `Could not change the setting (tried ${written.length + failed.length} entries). ` +
      "SEED can still run, but the panel will not appear in After Effects.";
  } else {
    lastError = "";
  }
}

async function setUp(): Promise<void> {
  const paths = resolvePaths();
  const stateDir = app.getPath("userData");
  const token = ensureToken(stateDir);

  // The panel first, so a token can be written into it.
  try {
    if (!existsSync(paths.panelSource)) {
      throw new Error(`the bundled panel is missing at ${paths.panelSource}`);
    }
    const target = installPanel(paths.panelSource, app.getVersion());
    provisionPanel(target.target, token);
    panelInstalled = true;
  } catch (cause) {
    panelInstalled = false;
    lastError = cause instanceof Error ? cause.message : String(cause);
  }

  await ensureDebugMode();

  supervisor = new ServiceSupervisor({
    entry: paths.serviceEntry,
    // Beside the catalogue rather than in the user's Documents: this folder is
    // the app's, and an artist should never have to know it exists.
    workspace: path.join(stateDir, "workspace"),
    credentialsPath: path.join(app.getPath("home"), ".seed-ae", "credentials.json"),
    token,
    port: PORT,
  });
  supervisor.on("state", () => broadcast());
  supervisor.on("log", () => broadcast());
  supervisor.start();
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await supervisor?.stop();
  app.exit(0);
}

app.on("second-instance", () => showWindow());

// Closing the window leaves SEED running in the tray. Quitting is explicit,
// because a closed window that silently killed the service would present in
// After Effects as the panel losing its connection for no visible reason.
app.on("window-all-closed", () => {
  /* deliberately empty */
});

void app.whenReady().then(async () => {
  const icon = nativeImage.createFromPath(
    path.join(app.getAppPath(), "build", "trayTemplate.png"),
  );
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.on("click", () => showWindow());
  refreshTray();

  ipcMain.handle("seed:status", () => status());
  ipcMain.handle("seed:restart", async () => {
    lastError = "";
    await supervisor?.restart();
    return status();
  });
  ipcMain.handle("seed:reinstall-panel", async () => {
    const paths = resolvePaths();
    const token = ensureToken(app.getPath("userData"));
    try {
      // Force a copy even when the version matches, which is what makes this
      // useful: it is the button for "the panel is behaving oddly".
      removePanel();
      const target = installPanel(paths.panelSource, app.getVersion());
      provisionPanel(target.target, token);
      panelInstalled = true;
      lastError = "";
    } catch (cause) {
      panelInstalled = false;
      lastError = cause instanceof Error ? cause.message : String(cause);
    }
    await ensureDebugMode();
    broadcast();
    return status();
  });
  ipcMain.handle("seed:reveal-panel", () => shell.showItemInFolder(panelTargetDir()));
  ipcMain.handle("seed:quit", () => void shutdown());

  await setUp();
  showWindow();
});

app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  void shutdown();
});
