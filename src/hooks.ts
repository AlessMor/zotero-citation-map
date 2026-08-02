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
  startProviderResponseCache,
  stopProviderResponseCache,
  waitForProviderResponseCache,
} from "./services/providerResponseCacheService";
import { subscribeToCitationUpdates } from "./services/citationUpdateEvents";
import {
  startExternalDiscoveryRuntime,
  stopExternalDiscoveryRuntime,
} from "./services/externalDiscoveryService";
import {
  registerAutomaticCitationUpdates,
  unregisterAutomaticCitationUpdates,
  waitForCitationUpdates,
} from "./services/automaticUpdateCoordinator";
import {
  installCitationColumnTooltips,
  refreshCitationColumns,
  registerCitationColumns,
  uninstallCitationColumnTooltips,
  unregisterCitationColumns,
} from "./services/itemTreeColumnService";
import {
  refreshCitationItemPanes,
  registerCitationItemPane,
  unregisterCitationItemPane,
} from "./services/itemPaneService";
import { getShowMetricTooltipsEnabled } from "./services/citationPreferences";
import { registerMenus, unregisterMenus } from "./services/menuService";
import {
  registerCitationMapPreferencePane,
  unregisterCitationMapPreferenceObservers,
} from "./services/preferencePaneService";
import { clearCitationGraphSnapshots } from "./services/graphSnapshotStore";
import { clearFocusGraphCaches } from "./services/focusGraphCacheService";
import {
  clearWholeLibrarySnapshotCache,
  invalidateWholeLibrarySnapshot,
  markWholeLibraryMetricsDirty,
} from "./services/zoteroLibraryService";
import {
  clearLocalCitationExtractionCache,
  invalidateLocalCitationExtractionCache,
} from "./services/citationGraphService";
import { yieldToUI } from "./services/backgroundTaskService";
import {
  cancelPendingCitationMapRefreshes,
  closeCitationMapForWindow,
  closeCitationMapWindow,
  installCitationMapTabHooks,
  refreshOpenCitationMapViews,
} from "./services/windowService";

const MAIN_STYLESHEET_ID = `${config.addonRef}-main-stylesheet`;
const TAB_ICON_STYLESHEET_ID = `${config.addonRef}-tab-icon-stylesheet`;
const TEARDOWN_MARKER = `__${config.addonRef}RuntimeTeardownListener`;
let teardownStarted = false;
let unsubscribeUpdateListener: (() => void) | null = null;
let librarySnapshotNotifierID: string | null = null;
const VIEW_REFRESH_DEADLINE_MS = 5000;

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

function syncMetricTooltipVisibility(win: _ZoteroTypes.MainWindow): void {
  const document = win.document;
  document.documentElement.dataset.citationMapTooltips =
    getShowMetricTooltipsEnabled() ? "enabled" : "disabled";
  const styleID = `${config.addonRef}-tooltip-visibility-style`;
  if (!document.getElementById(styleID)) {
    const style = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "style",
    );
    style.id = styleID;
    style.textContent =
      '[data-citation-map-tooltips="disabled"] #citation-map-central-tooltip { display: none !important; }';
    document.documentElement.appendChild(style);
  }
}

function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${milliseconds} ms`));
    }, milliseconds);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function registerLibrarySnapshotInvalidation(): void {
  if (librarySnapshotNotifierID) return;
  const observer = {
    notify(
      _event: string,
      type: string,
      ids: Array<number | string>,
      extraData?: Record<string, { libraryID?: number }>,
    ): void {
      if (type !== "item") return;
      const libraryIDs = new Set<number>();
      for (const id of ids) {
        const itemID = Number(id);
        const detail = extraData?.[String(id)] ?? extraData?.[itemID];
        const libraryID = Number(
          detail?.libraryID ??
            (Number.isFinite(itemID)
              ? (Zotero.Items.get(itemID) as Zotero.Item | null)?.libraryID
              : 0),
        );
        if (Number.isFinite(libraryID) && libraryID > 0) {
          libraryIDs.add(libraryID);
        }
      }
      if (!libraryIDs.size) {
        invalidateWholeLibrarySnapshot();
        invalidateLocalCitationExtractionCache();
        clearCitationGraphSnapshots();
        clearFocusGraphCaches();
        return;
      }
      for (const libraryID of libraryIDs) {
        invalidateWholeLibrarySnapshot(libraryID);
        invalidateLocalCitationExtractionCache(libraryID);
      }
      clearCitationGraphSnapshots();
      clearFocusGraphCaches();
    },
  };
  librarySnapshotNotifierID = Zotero.Notifier.registerObserver(
    observer,
    ["item"],
    "citation-map-library-snapshot-cache",
  );
}

function unregisterLibrarySnapshotInvalidation(): void {
  if (!librarySnapshotNotifierID) return;
  Zotero.Notifier.unregisterObserver(librarySnapshotNotifierID);
  librarySnapshotNotifierID = null;
}

function installUpdateRefreshListener(): void {
  if (unsubscribeUpdateListener) return;
  unsubscribeUpdateListener = subscribeToCitationUpdates(async (event) => {
    markWholeLibraryMetricsDirty();
    // Presentation refreshes all read the same completed store snapshot, but
    // must not execute as one uninterrupted main-thread burst. Give Zotero an
    // input/paint opportunity between the item tree, item pane, and graph.
    if (event.refreshColumns) {
      refreshCitationColumns();
      await yieldToUI(16);
    }
    if (event.refreshItemPanes) {
      refreshCitationItemPanes();
      await yieldToUI(16);
    }
    if (event.refreshGraph) {
      await withDeadline(
        refreshOpenCitationMapViews(),
        VIEW_REFRESH_DEADLINE_MS,
        "Graph view refresh",
        cancelPendingCitationMapRefreshes,
      );
    }
  });
}

function beginTeardown(closeGraphTab = true): void {
  if (teardownStarted) return;
  teardownStarted = true;
  addon.data.alive = false;
  unsubscribeUpdateListener?.();
  unsubscribeUpdateListener = null;
  stopProviderResponseCache();
  stopExternalDiscoveryRuntime();
  clearCitationGraphSnapshots();
  clearFocusGraphCaches();
  clearWholeLibrarySnapshotCache();
  clearLocalCitationExtractionCache();
  unregisterLibrarySnapshotInvalidation();
  cancelPendingCitationMapRefreshes();
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
  startExternalDiscoveryRuntime();
  startProviderResponseCache();
  installUpdateRefreshListener();
  registerLibrarySnapshotInvalidation();
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
  syncMetricTooltipVisibility(win);
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
        else closeCitationMapForWindow(win);
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
  else closeCitationMapForWindow(win);
  uninstallCitationColumnTooltips(win);
  win.document.getElementById(MAIN_STYLESHEET_ID)?.remove();
  win.document.getElementById(TAB_ICON_STYLESHEET_ID)?.remove();
}

async function onShutdown(): Promise<void> {
  beginTeardown();
  await waitForCitationUpdates();
  await waitForProviderResponseCache();
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
