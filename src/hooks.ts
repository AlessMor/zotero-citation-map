import { config } from "../package.json";
import {
  closeCitationMetricsStore,
  initCitationMetricsStore,
} from "./services/citationMetricsStore";
import {
  closeExternalWorkCache,
  initExternalWorkCache,
} from "./services/externalWorkCacheService";
import {
  registerAutomaticCitationUpdates,
  unregisterAutomaticCitationUpdates,
  waitForCitationUpdates,
} from "./services/citationUpdateService";
import {
  installCitationColumnTooltips,
  registerCitationColumns,
  uninstallCitationColumnTooltips,
  unregisterCitationColumns,
} from "./services/itemTreeColumnService";
import {
  registerCitationItemPane,
  unregisterCitationItemPane,
} from "./services/itemPaneService";
import { registerMenus, unregisterMenus } from "./services/menuService";
import {
  registerCitationMapPreferencePane,
  unregisterCitationMapPreferenceObservers,
} from "./services/preferencePaneService";
import {
  closeCitationMapWindow,
  installCitationMapTabHooks,
} from "./services/windowService";

const MAIN_STYLESHEET_ID = `${config.addonRef}-main-stylesheet`;
const TAB_ICON_STYLESHEET_ID = `${config.addonRef}-tab-icon-stylesheet`;
const TEARDOWN_MARKER = `__${config.addonRef}RuntimeTeardownListener`;
let teardownStarted = false;

function installStyles(win: _ZoteroTypes.MainWindow): void {
  const stylesheets: Array<[string, string]> = [
    [MAIN_STYLESHEET_ID, `chrome://${config.addonRef}/content/zoteroPane.css`],
    [TAB_ICON_STYLESHEET_ID, `chrome://${config.addonRef}/content/tabIcon.css`],
  ];
  for (const [id, href] of stylesheets) {
    if (win.document.getElementById(id)) continue;
    const link = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "link",
    );
    link.id = id;
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", href);
    win.document.documentElement.appendChild(link);
  }
}

function beginTeardown(closeGraphTab = true): void {
  if (teardownStarted) return;
  teardownStarted = true;
  addon.data.alive = false;
  for (const action of [
    unregisterAutomaticCitationUpdates,
    unregisterCitationMapPreferenceObservers,
    unregisterCitationItemPane,
    unregisterMenus,
    unregisterCitationColumns,
  ]) {
    try {
      action();
    } catch (error) {
      Zotero.debug(`Citation Map: shutdown cleanup failed: ${String(error)}`);
    }
  }
  try {
    closeCitationMapWindow(closeGraphTab);
  } catch (error) {
    Zotero.debug(`Citation Map: graph cleanup failed: ${String(error)}`);
  }
}

async function onStartup(): Promise<void> {
  teardownStarted = false;
  addon.data.alive = true;
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise]);
  // Restored Citation Map tabs can render during UI restoration. Initialize
  // both persistent stores before waiting for uiReady so no restored tab can
  // read from, or write to, an uninitialized external-work cache.
  await Promise.all([initCitationMetricsStore(), initExternalWorkCache()]);
  await Zotero.uiReadyPromise;
  for (const win of Zotero.getMainWindows()) await onMainWindowLoad(win);
  await registerCitationColumns();
  registerCitationItemPane();
  await registerCitationMapPreferencePane();
  registerMenus();
  registerAutomaticCitationUpdates();
  addon.data.initialized = true;
  Zotero.debug("Citation Map: startup completed");
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // This hook can race startup during session restoration. The initializers
  // are idempotent and ensure the graph never observes an empty cache mirror.
  await Promise.all([initCitationMetricsStore(), initExternalWorkCache()]);
  // Install the custom tab hook immediately. Zotero may restore saved tabs
  // before the user has ever opened Citation Map in this session.
  try {
    installCitationMapTabHooks(win);
  } catch (error) {
    Zotero.debug(
      `Citation Map: tab-hook installation deferred: ${String(error)}`,
    );
  }
  win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-mainWindow.ftl`);
  installStyles(win);
  installCitationColumnTooltips(win);
  const runtime = win as any;
  if (!runtime[TEARDOWN_MARKER]) {
    runtime[TEARDOWN_MARKER] = true;
    win.addEventListener(
      "close",
      () => {
        const others = Zotero.getMainWindows().filter(
          (candidate: _ZoteroTypes.MainWindow) =>
            candidate !== win && !(candidate as any).closed,
        );
        if (!others.length) beginTeardown(false);
        else closeCitationMapWindow();
      },
      { once: true },
    );
  }
}

async function onMainWindowUnload(win: _ZoteroTypes.MainWindow): Promise<void> {
  const others = Zotero.getMainWindows().filter(
    (candidate: _ZoteroTypes.MainWindow) =>
      candidate !== win && !(candidate as any).closed,
  );
  if (!others.length) beginTeardown(false);
  else closeCitationMapWindow();
  uninstallCitationColumnTooltips(win);
  win.document.getElementById(MAIN_STYLESHEET_ID)?.remove();
  win.document.getElementById(TAB_ICON_STYLESHEET_ID)?.remove();
}

async function onShutdown(): Promise<void> {
  beginTeardown();
  await waitForCitationUpdates();
  await closeExternalWorkCache().catch((error: unknown) =>
    Zotero.logError(error instanceof Error ? error : new Error(String(error))),
  );
  await closeCitationMetricsStore().catch((error: unknown) =>
    Zotero.logError(error instanceof Error ? error : new Error(String(error))),
  );
  delete (Zotero as any)[config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
