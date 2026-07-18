import { config } from "../../package.json";
import type { LibrarySnapshot } from "../domain/types";
import {
  destroyCitationMapView,
  renderCitationMapView,
} from "./graphViewService";
import { loadWholeLibrary } from "./zoteroLibraryService";

const TAB_TYPE = "citationmap";
const TAB_STATE_FILTER_MARKER = "__citationMapStateFilterInstalled";
const WINDOW_MOUNT_ID = "citation-map-window-mount";
const NETWORK_ICON_TYPE = "citation-map-network";

function getDefaultMainWindow(): _ZoteroTypes.MainWindow {
  const mainWindow = Zotero.getMainWindows().find(
    (candidate: any) => candidate?.ZoteroPane,
  );

  if (!mainWindow) {
    throw new Error("No Zotero main window is available.");
  }

  return mainWindow;
}

function getTabs(mainWindow: _ZoteroTypes.MainWindow): any {
  const tabs = (mainWindow as any).Zotero_Tabs;

  if (!tabs) {
    throw new Error("Zotero tabs are unavailable.");
  }

  return tabs;
}

function installTabStateFilter(tabs: any): void {
  if (tabs[TAB_STATE_FILTER_MARKER]) {
    return;
  }

  const originalGetState = tabs.getState.bind(tabs);

  tabs.getState = (): any[] =>
    originalGetState().filter((tab: any) => tab.type !== TAB_TYPE);

  tabs[TAB_STATE_FILTER_MARKER] = true;
}

function focusGraphTab(mainWindow: _ZoteroTypes.MainWindow, tab: any): void {
  try {
    const container = getTabs(mainWindow).getTabContent(tab.id);
    const focusTarget = container?.querySelector(
      ".cm-search-input",
    ) as HTMLElement | null;

    focusTarget?.focus();
  } catch (error) {
    Zotero.debug(`Citation Map: could not focus graph tab: ${error}`);
  }
}

function installTabHooks(mainWindow: _ZoteroTypes.MainWindow): void {
  const tabs = getTabs(mainWindow);
  installTabStateFilter(tabs);

  tabs.tabHooks.restoreState ??= {};
  tabs.tabHooks.getTitle ??= {};
  tabs.tabHooks.focusFirst ??= {};
  tabs.tabHooks.refocus ??= {};
  tabs.tabHooks.moveToNewWindow ??= {};

  tabs.tabHooks.restoreState[TAB_TYPE] = async () => ({
    itemID: null,
  });

  tabs.tabHooks.getTitle[TAB_TYPE] = async () => "Citation Map";

  tabs.tabHooks.focusFirst[TAB_TYPE] = async (tab: any) => {
    focusGraphTab(mainWindow, tab);
  };

  tabs.tabHooks.refocus[TAB_TYPE] = async (tab: any) => {
    focusGraphTab(mainWindow, tab);
  };

  // This hook enables Zotero's native tab context-menu command:
  // "Move to New Window".
  tabs.tabHooks.moveToNewWindow[TAB_TYPE] = async (tab: any) => {
    await detachCitationMapTab(tab.id, mainWindow);
  };
}

async function selectPaperInZotero(
  mainWindow: _ZoteroTypes.MainWindow,
  itemID: number,
): Promise<void> {
  getTabs(mainWindow).select("zotero-pane");
  await mainWindow.ZoteroPane.selectItem(itemID);
  mainWindow.focus();
}

function prepareTabContainer(container: any): void {
  container.setAttribute("flex", "1");
  container.style.width = "100%";
  container.style.height = "100%";
  container.style.overflow = "hidden";
}

function renderTab(
  mainWindow: _ZoteroTypes.MainWindow,
  container: any,
  snapshot: LibrarySnapshot,
): void {
  prepareTabContainer(container);

  renderCitationMapView(mainWindow.document, container, snapshot, {
    mode: "tab",
    onSelectPaper: (itemID) => selectPaperInZotero(mainWindow, itemID),
  });
}

function findExistingGraphTab(tabs: any): any | null {
  if (addon.data.graphTabID) {
    try {
      const tabInfo = tabs.getTabInfo(addon.data.graphTabID);

      if (tabInfo) {
        return tabInfo;
      }
    } catch {
      addon.data.graphTabID = null;
    }
  }

  const existingTab = tabs._tabs?.find((tab: any) => tab.type === TAB_TYPE);

  if (existingTab) {
    addon.data.graphTabID = existingTab.id;
    return existingTab;
  }

  return null;
}

function getWindowMount(document: Document): Element {
  const mount = document.getElementById(WINDOW_MOUNT_ID);

  if (!mount) {
    throw new Error(
      `Detached Citation Map mount #${WINDOW_MOUNT_ID} was not found.`,
    );
  }

  return mount;
}

function renderDetachedWindow(
  graphWindow: Window,
  mainWindow: _ZoteroTypes.MainWindow,
  snapshot: LibrarySnapshot,
): void {
  renderCitationMapView(
    graphWindow.document,
    getWindowMount(graphWindow.document),
    snapshot,
    {
      mode: "window",
      onSelectPaper: (itemID) => selectPaperInZotero(mainWindow, itemID),
    },
  );
}

async function openDetachedCitationMapWindow(
  mainWindow: _ZoteroTypes.MainWindow,
  snapshot?: LibrarySnapshot,
): Promise<void> {
  const activeSnapshot =
    snapshot ?? (await loadWholeLibrary(Zotero.Libraries.userLibraryID));

  if (addon.data.graphWindow && !addon.data.graphWindow.closed) {
    renderDetachedWindow(addon.data.graphWindow, mainWindow, activeSnapshot);
    addon.data.graphWindow.focus();
    return;
  }

  const graphWindow = mainWindow.openDialog(
    `chrome://${config.addonRef}/content/graph.xhtml`,
    "citation-map-window",
    "chrome,dialog=no,resizable,centerscreen,width=1300,height=850",
  );

  if (!graphWindow) {
    throw new Error("Zotero failed to open the detached Citation Map window.");
  }

  addon.data.graphWindow = graphWindow;

  const renderWhenReady = (): void => {
    try {
      renderDetachedWindow(graphWindow, mainWindow, activeSnapshot);
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };

  if (graphWindow.document.readyState === "complete") {
    renderWhenReady();
  } else {
    graphWindow.addEventListener("load", renderWhenReady, { once: true });
  }

  graphWindow.addEventListener(
    "unload",
    () => {
      try {
        destroyCitationMapView(getWindowMount(graphWindow.document));
      } catch {
        // The window document may already be tearing down.
      }
      if (addon.data.graphWindow === graphWindow) {
        addon.data.graphWindow = null;
      }
    },
    { once: true },
  );
}

/** Open Citation Map inside Zotero's main tab bar. */
export async function openCitationMapWindow(
  hostWindow?: _ZoteroTypes.MainWindow,
): Promise<void> {
  const mainWindow = hostWindow ?? getDefaultMainWindow();
  installTabHooks(mainWindow);

  const snapshot = await loadWholeLibrary(Zotero.Libraries.userLibraryID);

  const tabs = getTabs(mainWindow);
  const existingTab = findExistingGraphTab(tabs);

  if (existingTab) {
    const container = tabs.getTabContent(existingTab.id);
    renderTab(mainWindow, container, snapshot);
    tabs.select(existingTab.id);
    return;
  }

  // Zotero's current tab-list UI assumes that every non-library tab has an
  // itemID. A real regular item is used only to satisfy that UI assumption.
  const representativeItemID = snapshot.papers[0]?.itemID;

  if (!representativeItemID) {
    await openDetachedCitationMapWindow(mainWindow, snapshot);
    return;
  }

  const tabResult = tabs.add({
    type: TAB_TYPE,
    title: "Citation Map",
    data: {
      itemID: representativeItemID,
      libraryID: snapshot.libraryID,
      citationMap: true,
      icon: NETWORK_ICON_TYPE,
    },
    select: true,
    onClose: () => {
      destroyCitationMapView(tabResult.container);
      if (addon.data.graphTabID === tabResult.id) {
        addon.data.graphTabID = null;
      }
    },
  });

  addon.data.graphTabID = tabResult.id;
  renderTab(mainWindow, tabResult.container, snapshot);
}

export async function detachCitationMapTab(
  requestedTabID?: string,
  hostWindow?: _ZoteroTypes.MainWindow,
): Promise<void> {
  const mainWindow = hostWindow ?? getDefaultMainWindow();
  const tabID = requestedTabID ?? addon.data.graphTabID;

  const snapshot = await loadWholeLibrary(Zotero.Libraries.userLibraryID);

  await openDetachedCitationMapWindow(mainWindow, snapshot);

  if (!tabID) {
    closeEnumeratedPluginWindows();
    return;
  }

  try {
    getTabs(mainWindow).close(tabID);
  } catch (error) {
    Zotero.debug(`Citation Map: failed to close tab after detaching: ${error}`);
  }

  if (addon.data.graphTabID === tabID) {
    addon.data.graphTabID = null;
  }
}

export async function refreshOpenCitationMapViews(): Promise<void> {
  const hasTab = Boolean(addon.data.graphTabID);
  const hasWindow = Boolean(
    addon.data.graphWindow && !addon.data.graphWindow.closed,
  );

  if (!hasTab && !hasWindow) {
    return;
  }

  const snapshot = await loadWholeLibrary(Zotero.Libraries.userLibraryID);

  if (hasTab && addon.data.graphTabID) {
    for (const mainWindow of Zotero.getMainWindows()) {
      try {
        const tabs = getTabs(mainWindow);
        const tabInfo = tabs.getTabInfo(addon.data.graphTabID);
        if (!tabInfo) {
          continue;
        }
        const container = tabs.getTabContent(addon.data.graphTabID);
        renderTab(mainWindow, container, snapshot);
        break;
      } catch {
        // Try the next Zotero main window.
      }
    }
  }

  if (hasWindow && addon.data.graphWindow) {
    const mainWindow = getDefaultMainWindow();
    renderDetachedWindow(addon.data.graphWindow, mainWindow, snapshot);
  }
}

function closeEnumeratedPluginWindows(): void {
  try {
    const services = (globalThis as any).Services;
    const enumerator = services?.wm?.getEnumerator?.(null);
    if (!enumerator) {
      return;
    }

    const windows: Window[] = [];
    while (enumerator.hasMoreElements()) {
      windows.push(enumerator.getNext() as Window);
    }

    for (const candidate of windows) {
      try {
        if (!candidate || candidate.closed) {
          continue;
        }
        const document = candidate.document;
        const root = document?.documentElement;
        const windowType = root?.getAttribute?.("windowtype") ?? "";
        const title = String(
          document?.title ?? root?.getAttribute?.("title") ?? "",
        ).trim();
        const isCitationMapWindow =
          windowType === "citationmap:window" ||
          Boolean(document?.getElementById?.(WINDOW_MOUNT_ID));
        const isCitationMapProgressWindow = title === config.addonName;

        if (isCitationMapWindow || isCitationMapProgressWindow) {
          candidate.close();
        }
      } catch {
        // A window may already be in the middle of native teardown.
      }
    }
  } catch (error) {
    Zotero.debug(`Citation Map: top-level window sweep failed: ${error}`);
  }
}

export function closeCitationMapWindow(): void {
  if (addon.data.graphWindow && !addon.data.graphWindow.closed) {
    addon.data.graphWindow.close();
  }

  addon.data.graphWindow = null;
  closeEnumeratedPluginWindows();

  const tabID = addon.data.graphTabID;

  if (!tabID) {
    closeEnumeratedPluginWindows();
    return;
  }

  for (const mainWindow of Zotero.getMainWindows()) {
    try {
      const tabs = getTabs(mainWindow);
      const tabInfo = tabs.getTabInfo(tabID);

      if (tabInfo) {
        tabs.close(tabID);
      }
    } catch {
      // The tab may already have been closed.
    }
  }

  addon.data.graphTabID = null;
  closeEnumeratedPluginWindows();
}

export function getDefaultHostWindow(): _ZoteroTypes.MainWindow {
  return getDefaultMainWindow();
}
