import { config } from "../../package.json";
import type { LibrarySnapshot } from "../domain/types";
import {
  destroyCitationMapView,
  renderCitationMapView,
} from "./graphViewService";
import { loadWholeLibrary } from "./zoteroLibraryService";
import {
  installDataSourceHoverTooltips,
  uninstallDataSourceHoverTooltips,
} from "./dataSourceTooltipService";

const TAB_TYPE = "citationmap";
const TAB_STATE_FILTER_MARKER = "__citationMapStateFilterInstalled";
const TAB_HOOK_MARKER = "__citationMapTabHooksInstalled";
const NETWORK_ICON_TYPE = "citation-map-network";
const CONTEXT_HANDLER_MARKER = "__citationMapContextHandlerInstalled";
const DETACHED_WINDOW_URL = `chrome://${config.addonRef}/content/citationMapWindow.xhtml`;
let pendingSelectionItemID: number | null = null;
let detachedWindow: Window | null = null;
let detachedMount: HTMLElement | null = null;
let detachedHostWindow: _ZoteroTypes.MainWindow | null = null;

function defaultMainWindow(): _ZoteroTypes.MainWindow {
  const win = Zotero.getMainWindows().find(
    (candidate: any) => candidate?.ZoteroPane,
  );
  if (!win) throw new Error("No Zotero main window is available.");
  return win;
}

function tabs(win: _ZoteroTypes.MainWindow): any {
  const value = (win as any).Zotero_Tabs;
  if (!value) throw new Error("Zotero tabs are unavailable.");
  return value;
}

function liveHostWindow(
  preferred?: _ZoteroTypes.MainWindow | null,
): _ZoteroTypes.MainWindow {
  if (preferred && !(preferred as any).closed) return preferred;
  return defaultMainWindow();
}

function reportAsyncError(context: string, error: unknown): void {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : error === undefined
        ? "Promise rejected with undefined."
        : String(error);
  const wrapped = new Error(`${context}: ${detail}`);
  if (error instanceof Error && error.stack) {
    wrapped.stack = `${wrapped.stack}\nCaused by: ${error.stack}`;
  }
  Zotero.logError(wrapped);
}

async function waitForWindowLoad(win: Window): Promise<void> {
  if (win.document.readyState === "complete") return;
  await new Promise<void>((resolve) => {
    win.addEventListener("load", () => resolve(), { once: true });
  });
}

async function selectPaper(
  win: _ZoteroTypes.MainWindow,
  itemID: number,
): Promise<void> {
  const host = liveHostWindow(win);
  tabs(host).select("zotero-pane");
  await host.ZoteroPane.selectItem(itemID);
  host.focus();
}

function renderDetachedWindow(
  snapshot: LibrarySnapshot,
  initialItemID: number | null = null,
): void {
  if (!detachedWindow || detachedWindow.closed || !detachedMount) return;
  const host = liveHostWindow(detachedHostWindow);
  renderCitationMapView(detachedWindow.document, detachedMount, snapshot, {
    mode: "window",
    onSelectPaper: (itemID) => {
      void selectPaper(host, itemID).catch((error) =>
        reportAsyncError("Citation Map: paper selection failed", error),
      );
    },
    initialItemID,
  });
}

async function openDetachedCitationMapWindow(
  hostWindow: _ZoteroTypes.MainWindow,
  snapshot: LibrarySnapshot,
  initialItemID: number | null = null,
): Promise<void> {
  detachedHostWindow = hostWindow;
  if (detachedWindow && !detachedWindow.closed && detachedMount) {
    renderDetachedWindow(snapshot, initialItemID);
    detachedWindow.focus();
    return;
  }

  const popup = (hostWindow as any).openDialog?.(
    DETACHED_WINDOW_URL,
    "citation-map-window",
    "chrome,dialog=no,resizable,centerscreen,width=1200,height=820",
  ) as Window | null;
  if (!popup) throw new Error("Unable to open the Citation Map window.");

  await waitForWindowLoad(popup);
  const mount = popup.document.getElementById(
    "citation-map-window-root",
  ) as HTMLElement | null;
  if (!mount) {
    popup.close();
    throw new Error("Citation Map window mount point is unavailable.");
  }

  detachedWindow = popup;
  detachedMount = mount;
  installDataSourceHoverTooltips(popup.document);
  popup.addEventListener(
    "unload",
    () => {
      if (detachedWindow !== popup) return;
      destroyCitationMapView(mount);
      uninstallDataSourceHoverTooltips(popup.document);
      detachedWindow = null;
      detachedMount = null;
      detachedHostWindow = null;
    },
    { once: true },
  );
  renderDetachedWindow(snapshot, initialItemID);
  popup.focus();
}

/**
 * Register custom-tab hooks as soon as the Zotero main window is available.
 * Zotero restores saved tabs during window startup, so delaying this until the
 * user first opens Citation Map can leave a stale citationmap tab without a
 * restoreState hook.
 */
export function installCitationMapTabHooks(win: _ZoteroTypes.MainWindow): void {
  const manager = tabs(win);
  if (!manager[TAB_STATE_FILTER_MARKER]) {
    const originalGetState = manager.getState.bind(manager);
    manager.getState = (): any[] =>
      originalGetState().filter((tab: any) => {
        const type = String(tab?.type ?? "").replace(/-unloaded$/, "");
        return type !== TAB_TYPE;
      });
    manager[TAB_STATE_FILTER_MARKER] = true;
  }
  if (manager[TAB_HOOK_MARKER]) return;
  manager.tabHooks ??= {};
  manager.tabHooks.restoreState ??= {};
  manager.tabHooks.getTitle ??= {};
  manager.tabHooks.focusFirst ??= {};
  manager.tabHooks.refocus ??= {};
  manager.tabHooks.moveToNewWindow ??= {};
  manager.tabHooks.restoreState[TAB_TYPE] = async () => ({ itemID: null });
  manager.tabHooks.getTitle[TAB_TYPE] = async () => "Citation Map";
  const focus = (tab: any): void => {
    const container = manager.getTabContent(tab.id);
    (container?.querySelector(".cm-search") as HTMLElement | null)?.focus();
  };
  manager.tabHooks.focusFirst[TAB_TYPE] = focus;
  manager.tabHooks.refocus[TAB_TYPE] = focus;
  manager.tabHooks.moveToNewWindow[TAB_TYPE] = async (tab: any) => {
    try {
      const snapshot = await loadWholeLibrary(Zotero.Libraries.userLibraryID);
      await openDetachedCitationMapWindow(
        win,
        snapshot,
        Number(tab?.data?.itemID) || null,
      );
      manager.close(tab.id);
    } catch (error) {
      reportAsyncError(
        "Citation Map: moving the tab to a new window failed",
        error,
      );
    }
  };
  manager[TAB_HOOK_MARKER] = true;
}

function hideGlobalContextPane(
  win: _ZoteroTypes.MainWindow,
  container: HTMLElement,
): void {
  const controller = (win as any).ZoteroContextPane;
  const contextPane = win.document.getElementById("zotero-context-pane");
  controller?.splitter?.setAttribute?.("hidden", "true");
  contextPane?.setAttribute("collapsed", "true");
  if (controller?.sidenav) controller.sidenav.hidden = true;

  const tabContent = container as HTMLElement & {
    setBottomPlaceholderHeight?: (height: number) => void;
    setContextPaneOpen?: (open: boolean) => void;
  };
  tabContent.setBottomPlaceholderHeight?.(0);
  tabContent.setContextPaneOpen?.(false);
}

function prepareContainer(
  win: _ZoteroTypes.MainWindow,
  container: HTMLElement,
): void {
  container.setAttribute("flex", "1");
  Object.assign(container.style, {
    display: "flex",
    flex: "1 1 0",
    flexDirection: "column",
    alignItems: "stretch",
    width: "100%",
    minWidth: "0",
    minHeight: "0",
    overflow: "hidden",
  });

  const marked = container as HTMLElement & Record<string, unknown>;
  if (!marked[CONTEXT_HANDLER_MARKER]) {
    container.addEventListener("tab-selection-change", (event: Event) => {
      const selected = Boolean(
        (event as CustomEvent<{ selected?: boolean }>).detail?.selected,
      );
      if (selected) hideGlobalContextPane(win, container);
    });
    marked[CONTEXT_HANDLER_MARKER] = true;
  }

  if (tabs(win).selectedID === container.id) {
    hideGlobalContextPane(win, container);
  }
}

function renderTab(
  win: _ZoteroTypes.MainWindow,
  container: HTMLElement,
  snapshot: LibrarySnapshot,
): void {
  prepareContainer(win, container);
  installDataSourceHoverTooltips(win.document);
  let attempts = 10;
  const render = (): void => {
    if (win.closed) return;
    if (!container.isConnected && attempts > 0) {
      attempts -= 1;
      win.setTimeout(() => win.requestAnimationFrame(render), 50);
      return;
    }
    const initialItemID = pendingSelectionItemID;
    pendingSelectionItemID = null;
    renderCitationMapView(win.document, container, snapshot, {
      mode: "tab",
      onSelectPaper: (itemID) => {
        void selectPaper(win, itemID).catch((error) =>
          reportAsyncError("Citation Map: paper selection failed", error),
        );
      },
      initialItemID,
    });
  };
  win.requestAnimationFrame(render);
}

function existingGraphTab(manager: any): any | null {
  if (addon.data.graphTabID) {
    try {
      const info = manager.getTabInfo(addon.data.graphTabID);
      if (info) return info;
    } catch {
      addon.data.graphTabID = null;
    }
  }
  const existing = manager._tabs?.find(
    (tab: any) => String(tab.type).replace(/-unloaded$/, "") === TAB_TYPE,
  );
  if (existing) addon.data.graphTabID = existing.id;
  return existing ?? null;
}

export async function openCitationMapWindow(
  hostWindow?: _ZoteroTypes.MainWindow,
): Promise<void> {
  const win = hostWindow ?? defaultMainWindow();
  installCitationMapTabHooks(win);
  const snapshot = await loadWholeLibrary(Zotero.Libraries.userLibraryID);
  if (!snapshot.papers.length) {
    throw new Error("Citation Map requires at least one regular Zotero item.");
  }
  if (detachedWindow && !detachedWindow.closed) {
    const initialItemID = pendingSelectionItemID;
    pendingSelectionItemID = null;
    await openDetachedCitationMapWindow(win, snapshot, initialItemID);
    return;
  }
  const manager = tabs(win);
  const existing = existingGraphTab(manager);
  if (existing) {
    renderTab(win, manager.getTabContent(existing.id), snapshot);
    manager.select(existing.id);
    return;
  }
  const result = manager.add({
    type: TAB_TYPE,
    title: "Citation Map",
    data: {
      itemID: snapshot.papers[0].itemID,
      libraryID: snapshot.libraryID,
      citationMap: true,
      icon: NETWORK_ICON_TYPE,
    },
    select: true,
    onClose: () => {
      destroyCitationMapView(result.container);
      if (addon.data.graphTabID === result.id) addon.data.graphTabID = null;
    },
  });
  addon.data.graphTabID = result.id;
  renderTab(win, result.container, snapshot);
}

export async function openCitationMapAndSelectItem(
  itemID: number,
): Promise<void> {
  pendingSelectionItemID = itemID;
  await openCitationMapWindow();
}

export async function refreshOpenCitationMapViews(): Promise<void> {
  const snapshot = await loadWholeLibrary(Zotero.Libraries.userLibraryID);
  if (detachedWindow && !detachedWindow.closed && detachedMount) {
    renderDetachedWindow(snapshot);
  }

  const tabID = addon.data.graphTabID;
  if (!tabID) return;
  for (const win of Zotero.getMainWindows()) {
    try {
      const manager = tabs(win);
      if (!manager.getTabInfo(tabID)) continue;
      renderTab(win, manager.getTabContent(tabID), snapshot);
      return;
    } catch {
      // Try the next window.
    }
  }
}

export function closeCitationMapWindow(closeTab = true): void {
  if (detachedWindow && !detachedWindow.closed) {
    if (detachedMount) destroyCitationMapView(detachedMount);
    detachedWindow.close();
  }
  detachedWindow = null;
  detachedMount = null;
  detachedHostWindow = null;

  const tabID = addon.data.graphTabID;
  if (!tabID) return;
  if (!closeTab) {
    for (const win of Zotero.getMainWindows()) {
      try {
        const container = tabs(win).getTabContent(tabID);
        if (container) destroyCitationMapView(container);
      } catch {
        // Window may be unloading.
      }
    }
    addon.data.graphTabID = null;
    return;
  }
  for (const win of Zotero.getMainWindows()) {
    try {
      const manager = tabs(win);
      if (manager.getTabInfo(tabID)) manager.close(tabID);
    } catch {
      // Tab may already be closed.
    }
  }
  addon.data.graphTabID = null;
}

export function getDefaultHostWindow(): _ZoteroTypes.MainWindow {
  return defaultMainWindow();
}
