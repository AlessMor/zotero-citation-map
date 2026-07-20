import { config, version } from "../package.json";
import {
  closeCitationMetricsStore,
  initCitationMetricsStore,
} from "./services/citationMetricsStore";
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
  closeExternalWorkCache,
  initExternalWorkCache,
} from "./services/externalWorkCacheService";
import { closeCitationMapWindow } from "./services/windowService";

const MAIN_STYLESHEET_ID = `${config.addonRef}-main-stylesheet`;
const TEARDOWN_MARKER = `__${config.addonRef}RuntimeTeardownListener`;
let teardownStarted = false;

function lifecycleError(context: string, error: unknown): Error {
  const detail =
    error instanceof Error
      ? error.message
      : error === undefined
        ? "undefined rejection"
        : String(error);
  const normalized = new Error(`Citation Map: ${context} failed (${detail})`);
  if (error instanceof Error && error.stack) {
    normalized.stack = `${normalized.stack}\nCaused by: ${error.stack}`;
  }
  return normalized;
}

function logLifecycleError(context: string, error: unknown): Error {
  const normalized = lifecycleError(context, error);
  Zotero.logError(normalized);
  return normalized;
}

function installStyles(win: _ZoteroTypes.MainWindow): void {
  if (win.document.getElementById(MAIN_STYLESHEET_ID)) return;
  const link = win.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "link",
  );
  link.id = MAIN_STYLESHEET_ID;
  link.setAttribute("rel", "stylesheet");
  link.setAttribute(
    "href",
    `chrome://${config.addonRef}/content/zoteroPane.css`,
  );
  win.document.documentElement.appendChild(link);
}

function beginTeardown(closeGraphTab = true): void {
  if (!teardownStarted) {
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
  let stage = "waiting for Zotero initialization";

  try {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);

    stage = "loading main windows";
    for (const win of Zotero.getMainWindows()) {
      await onMainWindowLoad(win);
    }

    stage = "initializing the citation cache";
    await initCitationMetricsStore();

    stage = "initializing the external-work cache";
    await initExternalWorkCache();

    stage = "registering item-tree columns";
    await registerCitationColumns();

    stage = "registering the item pane";
    registerCitationItemPane();

    stage = "registering preferences";
    await registerCitationMapPreferencePane();

    stage = "registering menus";
    registerMenus();

    stage = "registering automatic updates";
    registerAutomaticCitationUpdates();

    addon.data.initialized = true;
    Zotero.debug(`Citation Map ${version}: startup completed`);
  } catch (error) {
    const normalized = logLifecycleError(`startup during ${stage}`, error);
    beginTeardown();
    throw normalized;
  }
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  try {
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
  } catch (error) {
    throw logLifecycleError("main-window loading", error);
  }
}

async function onMainWindowUnload(win: _ZoteroTypes.MainWindow): Promise<void> {
  try {
    uninstallCitationColumnTooltips(win);
    win.document.getElementById(MAIN_STYLESHEET_ID)?.remove();
    const others = Zotero.getMainWindows().filter(
      (candidate: _ZoteroTypes.MainWindow) =>
        candidate !== win && !(candidate as any).closed,
    );
    if (!others.length) beginTeardown(false);
    else closeCitationMapWindow();
  } catch (error) {
    logLifecycleError("main-window unloading", error);
  }
}

async function onShutdown(): Promise<void> {
  beginTeardown();
  try {
    const updatesStopped = await waitForCitationUpdates();
    if (!updatesStopped) {
      Zotero.debug(
        "Citation Map: citation updates did not settle before the shutdown timeout",
      );
    }
  } catch (error) {
    logLifecycleError("waiting for citation updates during shutdown", error);
  }

  try {
    await closeExternalWorkCache();
  } catch (error) {
    logLifecycleError("closing the external-work cache during shutdown", error);
  }

  try {
    await closeCitationMetricsStore();
  } catch (error) {
    logLifecycleError("closing the citation cache during shutdown", error);
  } finally {
    delete (Zotero as any)[config.addonInstance];
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
