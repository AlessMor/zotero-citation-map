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
}

async function onMainWindowUnload(
  _win: _ZoteroTypes.MainWindow,
): Promise<void> {
  // Window-owned injected elements are removed when the window closes.
}

async function onShutdown(): Promise<void> {
  unregisterAutomaticCitationUpdates();
  unregisterCitationMapPreferenceObservers();
  closeCitationMapWindow();
  unregisterMenus();
  unregisterCitationColumns();
  await waitForCitationUpdates();
  await closeCitationMetricsStore();

  addon.data.alive = false;

  delete (Zotero as any)[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
