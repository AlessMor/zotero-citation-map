import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import {
  registerAutomaticCitationUpdates,
  unregisterAutomaticCitationUpdates,
  waitForCitationUpdates,
} from "./services/citationUpdateService";
import {
  closeCitationMetricsStore,
  initCitationMetricsStore,
} from "./services/citationMetricsStore";
import {
  registerCitationColumns,
  unregisterCitationColumns,
} from "./services/itemTreeColumnService";
import { registerMenus, unregisterMenus } from "./services/menuService";
import {
  registerCitationMapPreferencePane,
  unregisterCitationMapPreferenceObservers,
} from "./services/preferencePaneService";
import { closeCitationMapWindow } from "./services/windowService";

const MAIN_WINDOW_STYLESHEET_ID = `${config.addonRef}-main-window-stylesheet`;
const MAIN_WINDOW_TEARDOWN_MARKER = `__${config.addonRef}RuntimeTeardownListener`;

let runtimeTeardownStarted = false;

function beginRuntimeTeardown(): void {
  if (runtimeTeardownStarted) {
    return;
  }
  runtimeTeardownStarted = true;
  addon.data.alive = false;

  try {
    unregisterAutomaticCitationUpdates();
  } catch (error) {
    Zotero.debug(`Citation Map: update shutdown cleanup failed: ${error}`);
  }
  try {
    unregisterCitationMapPreferenceObservers();
  } catch (error) {
    Zotero.debug(`Citation Map: preference cleanup failed: ${error}`);
  }
  try {
    closeCitationMapWindow();
  } catch (error) {
    Zotero.debug(`Citation Map: window cleanup failed: ${error}`);
  }
  try {
    unregisterMenus();
  } catch (error) {
    Zotero.debug(`Citation Map: menu cleanup failed: ${error}`);
  }
  try {
    unregisterCitationColumns();
  } catch (error) {
    Zotero.debug(`Citation Map: column cleanup failed: ${error}`);
  }
}

function handleMainWindowClosing(win: _ZoteroTypes.MainWindow): void {
  const otherOpenMainWindows = Zotero.getMainWindows().filter(
    (candidate: _ZoteroTypes.MainWindow) =>
      candidate !== win && !(candidate as any).closed,
  );

  if (otherOpenMainWindows.length === 0) {
    Zotero.debug("Citation Map: last main window closing; beginning teardown");
    beginRuntimeTeardown();
  } else {
    closeCitationMapWindow();
  }
}

function installMainWindowStylesheet(win: _ZoteroTypes.MainWindow): void {
  if (win.document.getElementById(MAIN_WINDOW_STYLESHEET_ID)) {
    return;
  }

  const link = win.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "link",
  );
  link.id = MAIN_WINDOW_STYLESHEET_ID;
  link.setAttribute("rel", "stylesheet");
  link.setAttribute(
    "href",
    `chrome://${config.addonRef}/content/zoteroPane.css`,
  );
  win.document.documentElement.appendChild(link);
}

async function onStartup(): Promise<void> {
  runtimeTeardownStarted = false;
  addon.data.alive = true;

  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  await Promise.all(
    Zotero.getMainWindows().map((win: _ZoteroTypes.MainWindow) =>
      onMainWindowLoad(win),
    ),
  );

  await initCitationMetricsStore();
  await registerCitationColumns();
  await registerCitationMapPreferencePane();
  registerMenus();
  registerAutomaticCitationUpdates();

  Zotero.debug("Citation Map: startup completed");

  // Used by zotero-plugin-scaffold to detect successful initialization.
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
  installMainWindowStylesheet(win);

  const runtimeWindow = win as any;
  if (!runtimeWindow[MAIN_WINDOW_TEARDOWN_MARKER]) {
    runtimeWindow[MAIN_WINDOW_TEARDOWN_MARKER] = true;
    // The direct listeners run before a dependent progress window can become
    // Zotero's final top-level window. The scaffold hook below remains as a
    // second, idempotent cleanup path.
    win.addEventListener("close", () => handleMainWindowClosing(win), {
      once: true,
    });
    win.addEventListener("unload", () => handleMainWindowClosing(win), {
      once: true,
    });
  }
}

async function onMainWindowUnload(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Idempotent fallback for hosts where the direct close listener is skipped.
  handleMainWindowClosing(win);
  win.document.getElementById(MAIN_WINDOW_STYLESHEET_ID)?.remove();
}

async function onShutdown(): Promise<void> {
  Zotero.debug("Citation Map: shutdown started");
  beginRuntimeTeardown();

  await waitForCitationUpdates();
  await closeCitationMetricsStore().catch((error: unknown) => {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  });

  delete (Zotero as any)[addon.data.config.addonInstance];
  Zotero.debug("Citation Map: shutdown completed");
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
