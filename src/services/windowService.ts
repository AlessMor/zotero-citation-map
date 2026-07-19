import type { LibrarySnapshot } from "../domain/types";
import {
  destroyCitationMapView,
  renderCitationMapView,
} from "./graphViewService";
import { loadWholeLibrary } from "./zoteroLibraryService";

const TAB_TYPE = "citationmap";
const TAB_STATE_FILTER_MARKER = "__citationMapStateFilterInstalled";
const NETWORK_ICON_TYPE = "citation-map-network";
const CONTEXT_HANDLER_MARKER = "__citationMapContextHandlerInstalled";
let pendingSelectionItemID: number | null = null;

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

function installTabHooks(win: _ZoteroTypes.MainWindow): void {
  const manager = tabs(win);
  if (!manager[TAB_STATE_FILTER_MARKER]) {
    const originalGetState = manager.getState.bind(manager);
    manager.getState = (): any[] =>
      originalGetState().filter((tab: any) => tab.type !== TAB_TYPE);
    manager[TAB_STATE_FILTER_MARKER] = true;
  }
  manager.tabHooks.restoreState ??= {};
  manager.tabHooks.getTitle ??= {};
  manager.tabHooks.focusFirst ??= {};
  manager.tabHooks.refocus ??= {};
  manager.tabHooks.restoreState[TAB_TYPE] = async () => ({ itemID: null });
  manager.tabHooks.getTitle[TAB_TYPE] = async () => "Citation Map";
  const focus = async (tab: any): Promise<void> => {
    const container = manager.getTabContent(tab.id);
    (container?.querySelector(".cm-search") as HTMLElement | null)?.focus();
  };
  manager.tabHooks.focusFirst[TAB_TYPE] = focus;
  manager.tabHooks.refocus[TAB_TYPE] = focus;
}

async function selectPaper(
  win: _ZoteroTypes.MainWindow,
  itemID: number,
): Promise<void> {
  tabs(win).select("zotero-pane");
  await win.ZoteroPane.selectItem(itemID);
  win.focus();
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
      onSelectPaper: (itemID) => selectPaper(win, itemID),
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
  const existing = manager._tabs?.find((tab: any) => tab.type === TAB_TYPE);
  if (existing) addon.data.graphTabID = existing.id;
  return existing ?? null;
}

export async function openCitationMapWindow(
  hostWindow?: _ZoteroTypes.MainWindow,
): Promise<void> {
  const win = hostWindow ?? defaultMainWindow();
  installTabHooks(win);
  const snapshot = await loadWholeLibrary(Zotero.Libraries.userLibraryID);
  if (!snapshot.papers.length) {
    throw new Error("Citation Map requires at least one regular Zotero item.");
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
  const tabID = addon.data.graphTabID;
  if (!tabID) return;
  const snapshot = await loadWholeLibrary(Zotero.Libraries.userLibraryID);
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
