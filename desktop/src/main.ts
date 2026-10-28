// Voxa desktop: a window around the Voxa site, plus what a browser can't do —
// a screen picker, tray icon, start with Windows, taskbar badge, game detection,
// voxa:// links and auto-updates.
//
// The UI is not bundled: the window loads the deployed site, so one deploy
// updates web and desktop alike. Because that content is remote, the window
// gets no Node access and can't navigate away from the Voxa origin.

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import path from "node:path";
import { startGameDetection } from "./activity.ts";
import { IPC, type DesktopSettings } from "./channels.ts";
import { APP_URL, PROTOCOL, deepLinkToPath, isAppUrl } from "./config.ts";
import { registerPicker } from "./picker.ts";
import { registerReplayIpc } from "./replay.ts";
import { getSettings, isFirstRun, updateSettings } from "./settings.ts";
import { announcePendingUpdate, initUpdater, installUpdate } from "./updater.ts";

const START_PATH = "/channels/@me";
const ICON = path.join(__dirname, "icon.png");
const RETRY_MS = 5000;

// A call must keep full speed while the window is hidden, minimized or covered by a game:
// by default Chromium throttles background renderers, which drops voice and screen-share quality.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let trayHintShown = false;
let unreadCount = 0;
let pendingPath: string | null = null;
let games: ReturnType<typeof startGameDetection> | null = null;
let currentGame: string | null = null;

// --- single instance & voxa:// links ---------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    const target = link ? deepLinkToPath(link) : null;
    if (target) openPath(target);
    showWindow();
  });
}

// macOS delivers links through this event instead of argv.
app.on("open-url", (e, link) => {
  e.preventDefault();
  const target = deepLinkToPath(link);
  if (target) openPath(target);
});

function registerProtocol() {
  if (process.defaultApp && process.argv.length >= 2) {
    // Development (`electron .`): the OS must relaunch electron with our app path.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

function openPath(p: string) {
  if (mainWindow) mainWindow.loadURL(APP_URL + p);
  else pendingPath = p;
}

// --- window -------------------------------------------------------------------------

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(startHidden: boolean) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    title: "Voxa",
    icon: ICON,
    backgroundColor: "#23242c",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });
  mainWindow = win;

  win.once("ready-to-show", () => {
    if (!startHidden) win.show();
  });

  // Only the Voxa site may load in this window; anything else opens in the real browser.
  win.webContents.on("will-navigate", (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  // A reload or navigation ends any replay recording, so its global shortcut is freed too.
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) replay?.release();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) win.loadURL(url);
    else openExternal(url);
    return { action: "deny" };
  });

  // Offline or server down: show a friendly page and keep retrying.
  let retryTimer: NodeJS.Timeout | null = null;
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted by a newer navigation */ || !isAppUrl(url)) return;
    win.loadFile(path.join(__dirname, "offline.html"));
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => win.loadURL(url), RETRY_MS);
  });
  win.webContents.on("did-finish-load", () => {
    if (isAppUrl(win.webContents.getURL())) {
      announcePendingUpdate(win);
      win.webContents.send(IPC.activity, currentGame);
    }
  });

  // Reload / devtools shortcuts, since the default menu is hidden.
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    if ((ctrl && input.key.toLowerCase() === "r") || input.key === "F5") {
      win.webContents.reload();
      e.preventDefault();
    } else if (ctrl && input.shift && input.key.toLowerCase() === "i") {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });

  win.on("focus", () => win.flashFrame(false));

  win.on("close", (e) => {
    if (quitting || !getSettings().closeToTray || !tray) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && process.platform === "win32") {
      trayHintShown = true;
      tray.displayBalloon({
        title: "O Voxa continua aberto",
        content: "Ele fica aqui na bandeja para você continuar recebendo mensagens e chamadas.",
        iconType: "info",
      });
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.loadURL(APP_URL + (pendingPath ?? START_PATH));
  pendingPath = null;
  return win;
}

function openExternal(url: string) {
  // Only web links: never hand file:// or custom schemes to the OS from remote content.
  if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
}

// --- permissions ---------------------------------------------------------------------

function configurePermissions() {
  const allowed = new Set(["media", "display-capture", "notifications", "clipboard-sanitized-write", "fullscreen", "speaker-selection"]);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allowed.has(permission) && isAppUrl(wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && isAppUrl(origin));
}

// --- tray, startup, badge ------------------------------------------------------------

function trayTooltip() {
  return unreadCount > 0 ? `Voxa — ${unreadCount} ${unreadCount === 1 ? "conversa não lida" : "conversas não lidas"}` : "Voxa";
}

function buildTrayMenu() {
  if (!tray) return;
  const s = getSettings();
  const items: MenuItemConstructorOptions[] = [
    { label: "Abrir o Voxa", click: showWindow },
    { type: "separator" },
  ];
  if (process.platform === "win32" || process.platform === "darwin") {
    items.push({
      label: "Iniciar com o sistema",
      type: "checkbox",
      checked: s.startWithWindows,
      click: (item) => applySettings({ startWithWindows: item.checked }),
    });
  }
  items.push(
    {
      label: "Detectar jogos",
      type: "checkbox",
      checked: s.detectGames,
      click: (item) => applySettings({ detectGames: item.checked }),
    },
    {
      label: "Fechar para a bandeja",
      type: "checkbox",
      checked: s.closeToTray,
      click: (item) => applySettings({ closeToTray: item.checked }),
    },
    { type: "separator" },
    {
      label: "Sair do Voxa",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(trayTooltip());
}

function createTray() {
  const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.on("click", showWindow);
  buildTrayMenu();
}

function applyStartup(enabled: boolean) {
  // Registering a dev build (electron.exe + a path) at login would be a broken entry; only packaged builds do it.
  if (!app.isPackaged || (process.platform !== "win32" && process.platform !== "darwin")) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
}

function applySettings(patch: Partial<DesktopSettings>): DesktopSettings {
  const before = getSettings();
  const s = updateSettings(patch);
  if (s.startWithWindows !== before.startWithWindows) applyStartup(s.startWithWindows);
  if (s.detectGames !== before.detectGames) {
    if (s.detectGames) startGames();
    else {
      games?.stop();
      games = null;
    }
  }
  buildTrayMenu();
  return s;
}

function setBadge(count: number, dataUrl: string | null) {
  unreadCount = count;
  if (process.platform === "win32") {
    const image = dataUrl ? nativeImage.createFromDataURL(dataUrl) : null;
    mainWindow?.setOverlayIcon(image, count ? trayTooltip() : "");
  } else {
    app.setBadgeCount(count);
  }
  tray?.setToolTip(trayTooltip());
}

function startGames() {
  games?.stop();
  games = startGameDetection((game) => {
    currentGame = game;
    mainWindow?.webContents.send(IPC.activity, game);
  });
}

// --- IPC -----------------------------------------------------------------------------------

/** IPC may only come from our own site loaded in the main window. */
function fromApp(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  return e.sender === mainWindow?.webContents && isAppUrl(e.senderFrame?.url ?? "");
}

function registerIpc() {
  ipcMain.on(IPC.setBadge, (e, count: unknown, dataUrl: unknown) => {
    if (!fromApp(e)) return;
    const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    const url = typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,") ? dataUrl : null;
    setBadge(n, url);
  });
  ipcMain.on(IPC.flash, (e) => {
    if (fromApp(e) && mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  });
  ipcMain.handle(IPC.activityGet, (e) => (fromApp(e) ? currentGame : null));
  ipcMain.handle(IPC.settingsGet, (e) => (fromApp(e) ? getSettings() : null));
  ipcMain.handle(IPC.settingsSet, (e, patch: unknown) =>
    fromApp(e) && patch && typeof patch === "object" ? applySettings(patch as Partial<DesktopSettings>) : null,
  );
  ipcMain.on(IPC.updateInstall, (e) => {
    if (!fromApp(e)) return;
    quitting = true;
    installUpdate();
  });
  replay = registerReplayIpc(() => mainWindow, fromApp);
}

let replay: ReturnType<typeof registerReplayIpc> | null = null;

// --- startup ----------------------------------------------------------------------------------

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow) showWindow();
  else if (app.isReady()) createWindow(false);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerProtocol();
  configurePermissions();
  registerIpc();

  if (isFirstRun()) {
    updateSettings({});
    applyStartup(getSettings().startWithWindows);
  }

  const link = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  const linkPath = link ? deepLinkToPath(link) : null;
  if (linkPath) pendingPath = linkPath;

  createTray();
  const win = createWindow(process.argv.includes("--hidden") && !linkPath);
  registerPicker(() => mainWindow);
  if (getSettings().detectGames) startGames();
  initUpdater(() => mainWindow);
  return win;
});
