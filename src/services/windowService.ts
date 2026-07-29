import { config } from "../../package.json";
import type { LibrarySnapshot } from "../domain/types";
import {
  destroyCitationMapView,
  getCitationMapViewController,
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
const LIBRARY_FILTER_MARKER = "citationMapLibraryFilterInstalled";
const DETACHED_WINDOW_URL = `chrome://${config.addonRef}/content/citationMapWindow.xhtml`;
interface GraphWindowState {
  tabID: string | null;
  libraryID: number | null;
  pendingSelectionItemID: number | null;
  detachedWindow: Window | null;
  detachedMount: HTMLElement | null;
}

const graphStateByWindow = new Map<_ZoteroTypes.MainWindow, GraphWindowState>();
function graphState(win: _ZoteroTypes.MainWindow): GraphWindowState {
  const existing = graphStateByWindow.get(win);
  if (existing) return existing;
  const created: GraphWindowState = {
    tabID: null,
    libraryID: null,
    pendingSelectionItemID: null,
    detachedWindow: null,
    detachedMount: null,
  };
  graphStateByWindow.set(win, created);
  return created;
}

function refreshLegacyGraphTabID(): void {
  addon.data.graphTabID =
    [...graphStateByWindow.values()].find((state) => Boolean(state.tabID))
      ?.tabID ?? null;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function defaultMainWindow(): _ZoteroTypes.MainWindow {
  const windows = Zotero.getMainWindows().filter(
    (candidate: any) => candidate?.ZoteroPane && !candidate.closed,
  );
  const activePane = Zotero.getActiveZoteroPane?.();
  const activeWindow = activePane
    ? windows.find((candidate: any) => candidate.ZoteroPane === activePane)
    : null;
  const win = activeWindow ?? windows[0];
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

function selectedLibraryID(win: _ZoteroTypes.MainWindow): number {
  const panes = [Zotero.getActiveZoteroPane?.(), win.ZoteroPane].filter(
    (pane, index, values) => pane && values.indexOf(pane) === index,
  );
  for (const pane of panes as any[]) {
    const direct = positiveInteger(pane.getSelectedLibraryID?.());
    if (direct) return direct;
    const selectedItems = pane.getSelectedItems?.() ?? [];
    const fromItem = positiveInteger(selectedItems[0]?.libraryID);
    if (fromItem) return fromItem;
  }
  return Zotero.Libraries.userLibraryID;
}

function requestedLibraryID(
  win: _ZoteroTypes.MainWindow,
  libraryID?: number | null,
): number {
  return positiveInteger(libraryID) ?? selectedLibraryID(win);
}

interface GraphLibraryOption {
  libraryID: number;
  name: string;
}

function availableGraphLibraries(
  selectedLibrary: number,
): GraphLibraryOption[] {
  const libraries = new Map<number, GraphLibraryOption>();
  const add = (value: unknown): void => {
    const candidate = value as any;
    const libraryID = positiveInteger(
      typeof value === "number"
        ? value
        : (candidate?.libraryID ?? candidate?.id),
    );
    if (!libraryID) return;
    const libraryType = String(
      candidate?.libraryType ?? candidate?.type ?? "",
    ).toLocaleLowerCase();
    if (libraryType === "feed" || libraryType === "publications") return;
    const name =
      String(
        candidate?.name ??
          candidate?.libraryName ??
          Zotero.Libraries.getName?.(libraryID) ??
          "",
      ).trim() || `Library ${libraryID}`;
    libraries.set(libraryID, { libraryID, name });
  };

  add(Zotero.Libraries.userLibraryID);
  try {
    for (const library of (Zotero.Libraries as any).getAll?.() ?? []) {
      add(library);
    }
  } catch {
    // Fall back to the user library and groups below.
  }
  try {
    for (const group of (Zotero.Groups as any)?.getAll?.() ?? []) {
      add({
        libraryID: group?.libraryID,
        name: group?.name,
        libraryType: "group",
      });
    }
  } catch {
    // Group enumeration is optional in some Zotero contexts.
  }
  add({
    libraryID: selectedLibrary,
    name: Zotero.Libraries.getName?.(selectedLibrary),
  });

  const userLibraryID = Zotero.Libraries.userLibraryID;
  return [...libraries.values()].sort((left, right) => {
    if (left.libraryID === userLibraryID) return -1;
    if (right.libraryID === userLibraryID) return 1;
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
  });
}

function graphFilterMenu(document: Document): HTMLElement | null {
  const menus = document.querySelectorAll('div[role="menu"]');
  for (let menuIndex = 0; menuIndex < menus.length; menuIndex += 1) {
    const menu = menus.item(menuIndex) as HTMLElement | null;
    if (!menu || menu.style.display === "none") continue;
    const options = menu.querySelectorAll("option");
    let hasCollectionFilter = false;
    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      const option = options.item(optionIndex) as HTMLOptionElement | null;
      if (option?.textContent === "Whole library") {
        hasCollectionFilter = true;
        break;
      }
    }
    if (hasCollectionFilter) return menu;
  }
  return null;
}

function injectGraphLibraryFilter(
  document: Document,
  currentLibraryID: number,
  onSelectLibrary: (libraryID: number) => Promise<void>,
): void {
  const menu = graphFilterMenu(document);
  if (
    !menu ||
    menu.querySelector('[data-citation-map-library-filter="true"]')
  ) {
    return;
  }

  const wrapper = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "label",
  );
  wrapper.dataset.citationMapLibraryFilter = "true";
  Object.assign(wrapper.style, {
    display: "grid",
    gridTemplateColumns: "105px minmax(0, 1fr)",
    gap: "8px",
    alignItems: "center",
    padding: "3px 3px 7px",
    marginBottom: "2px",
    borderBottom: "1px solid color-mix(in srgb, CanvasText 14%, transparent)",
  });

  const label = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "span",
  );
  label.textContent = "Library";
  label.style.fontSize = "11px";

  const select = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "select",
  ) as HTMLSelectElement;
  select.dataset.citationMapFilterSelect = "true";
  select.setAttribute("aria-label", "Graph library");
  for (const library of availableGraphLibraries(currentLibraryID)) {
    const option = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "option",
    ) as HTMLOptionElement;
    option.value = String(library.libraryID);
    option.textContent = library.name;
    select.appendChild(option);
  }
  select.value = String(currentLibraryID);
  select.addEventListener("change", () => {
    const libraryID = positiveInteger(select.value);
    if (!libraryID || libraryID === currentLibraryID) return;
    select.disabled = true;
    void onSelectLibrary(libraryID).catch((error) => {
      select.disabled = false;
      select.value = String(currentLibraryID);
      reportAsyncError("Citation Map: library selection failed", error);
    });
  });

  wrapper.append(label, select);
  menu.prepend(wrapper);
}

function installGraphLibraryFilter(
  document: Document,
  mount: Element,
  currentLibraryID: number,
  onSelectLibrary: (libraryID: number) => Promise<void>,
): void {
  const buttons = mount.querySelectorAll(".cm-header-toolbar button");
  let button: HTMLButtonElement | null = null;
  for (let index = 0; index < buttons.length; index += 1) {
    const candidate = buttons.item(index) as HTMLButtonElement | null;
    if (!candidate) continue;
    const label = String(
      candidate.getAttribute("aria-label") ?? candidate.title,
    );
    if (label.startsWith("Filter papers")) {
      button = candidate;
      break;
    }
  }
  if (!button || button.dataset[LIBRARY_FILTER_MARKER] === "true") return;
  button.dataset[LIBRARY_FILTER_MARKER] = "true";
  const inject = (): void =>
    injectGraphLibraryFilter(document, currentLibraryID, onSelectLibrary);
  button.addEventListener("click", inject);
  if (button.getAttribute("aria-expanded") === "true") inject();
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
  hostWindow: _ZoteroTypes.MainWindow,
  snapshot: LibrarySnapshot,
  initialItemID: number | null = null,
): void {
  const state = graphState(hostWindow);
  const popup = state.detachedWindow;
  const mount = state.detachedMount;
  if (!popup || popup.closed || !mount) return;
  state.libraryID = snapshot.libraryID;
  const host = liveHostWindow(hostWindow);
  renderCitationMapView(popup.document, mount, snapshot, {
    mode: "window",
    onSelectPaper: (itemID) => {
      void selectPaper(host, itemID).catch((error) =>
        reportAsyncError("Citation Map: paper selection failed", error),
      );
    },
    initialItemID,
  });
  installGraphLibraryFilter(
    popup.document,
    mount,
    snapshot.libraryID,
    (libraryID) => openCitationMapWindow(host, libraryID),
  );
}

async function openDetachedCitationMapWindow(
  hostWindow: _ZoteroTypes.MainWindow,
  snapshot: LibrarySnapshot,
  initialItemID: number | null = null,
): Promise<void> {
  const state = graphState(hostWindow);
  if (
    state.detachedWindow &&
    !state.detachedWindow.closed &&
    state.detachedMount
  ) {
    renderDetachedWindow(hostWindow, snapshot, initialItemID);
    state.detachedWindow.focus();
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

  state.detachedWindow = popup;
  state.detachedMount = mount;
  state.libraryID = snapshot.libraryID;
  installDataSourceHoverTooltips(popup.document);
  popup.addEventListener(
    "unload",
    () => {
      if (state.detachedWindow !== popup) return;
      destroyCitationMapView(mount);
      uninstallDataSourceHoverTooltips(popup.document);
      state.detachedWindow = null;
      state.detachedMount = null;
      if (!state.tabID) state.libraryID = null;
    },
    { once: true },
  );
  renderDetachedWindow(hostWindow, snapshot, initialItemID);
  popup.focus();
}

function tabLibraryID(tab: any, win: _ZoteroTypes.MainWindow): number {
  return (
    graphState(win).libraryID ??
    positiveInteger(tab?.data?.libraryID) ??
    selectedLibraryID(win)
  );
}

function updateTabData(
  tab: any,
  snapshot: LibrarySnapshot,
  itemID: number | null,
): void {
  if (!tab || typeof tab !== "object") return;
  tab.data ??= {};
  tab.data.libraryID = snapshot.libraryID;
  tab.data.itemID = itemID ?? snapshot.papers[0]?.itemID ?? null;
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
      const libraryID = tabLibraryID(tab, win);
      const snapshot = await loadWholeLibrary(libraryID);
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
  const state = graphState(win);
  state.libraryID = snapshot.libraryID;
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
    const initialItemID = state.pendingSelectionItemID;
    state.pendingSelectionItemID = null;
    renderCitationMapView(win.document, container, snapshot, {
      mode: "tab",
      onSelectPaper: (itemID) => {
        void selectPaper(win, itemID).catch((error) =>
          reportAsyncError("Citation Map: paper selection failed", error),
        );
      },
      initialItemID,
    });
    installGraphLibraryFilter(
      win.document,
      container,
      snapshot.libraryID,
      (libraryID) => openCitationMapWindow(win, libraryID),
    );
  };
  win.requestAnimationFrame(render);
}

function existingGraphTab(
  manager: any,
  win: _ZoteroTypes.MainWindow,
): any | null {
  const state = graphState(win);
  if (state.tabID) {
    try {
      const info = manager.getTabInfo(state.tabID);
      if (info) return info;
    } catch {
      state.tabID = null;
      refreshLegacyGraphTabID();
    }
  }
  const existing = manager._tabs?.find(
    (tab: any) => String(tab.type).replace(/-unloaded$/, "") === TAB_TYPE,
  );
  if (existing) {
    state.tabID = existing.id;
    state.libraryID = positiveInteger(existing?.data?.libraryID);
    refreshLegacyGraphTabID();
  }
  return existing ?? null;
}

function focusExistingCitationMapItem(
  win: _ZoteroTypes.MainWindow,
  itemID: number,
  libraryID: number,
): boolean {
  const state = graphState(win);
  const manager = tabs(win);
  const existing = existingGraphTab(manager, win);
  if (state.libraryID !== libraryID) return false;

  if (
    state.detachedWindow &&
    !state.detachedWindow.closed &&
    state.detachedMount
  ) {
    const result = getCitationMapViewController(state.detachedMount)?.focusItem(
      itemID,
    );
    if (result && result !== "not-found") {
      state.detachedWindow.focus();
      return true;
    }
  }

  if (!existing) return false;
  const mount = manager.getTabContent(existing.id) as HTMLElement | null;
  if (!mount) return false;
  const result = getCitationMapViewController(mount)?.focusItem(itemID);
  if (!result || result === "not-found") return false;
  manager.select(existing.id);
  win.focus();
  return true;
}

export async function openCitationMapWindow(
  hostWindow?: _ZoteroTypes.MainWindow,
  libraryID?: number | null,
): Promise<void> {
  const win = hostWindow ?? defaultMainWindow();
  const state = graphState(win);
  installCitationMapTabHooks(win);
  const targetLibraryID = requestedLibraryID(win, libraryID);
  const snapshot = await loadWholeLibrary(targetLibraryID);
  if (!snapshot.papers.length) {
    throw new Error(
      `${snapshot.libraryName} contains no regular Zotero items for Citation Map.`,
    );
  }
  if (state.detachedWindow && !state.detachedWindow.closed) {
    const initialItemID = state.pendingSelectionItemID;
    state.pendingSelectionItemID = null;
    await openDetachedCitationMapWindow(win, snapshot, initialItemID);
    return;
  }
  const manager = tabs(win);
  const existing = existingGraphTab(manager, win);
  if (existing) {
    updateTabData(existing, snapshot, state.pendingSelectionItemID);
    renderTab(win, manager.getTabContent(existing.id), snapshot);
    manager.select(existing.id);
    return;
  }
  const result = manager.add({
    type: TAB_TYPE,
    title: "Citation Map",
    data: {
      itemID: state.pendingSelectionItemID ?? snapshot.papers[0].itemID,
      libraryID: snapshot.libraryID,
      citationMap: true,
      icon: NETWORK_ICON_TYPE,
    },
    select: true,
    onClose: () => {
      destroyCitationMapView(result.container);
      if (state.tabID === result.id) state.tabID = null;
      if (!state.detachedWindow || state.detachedWindow.closed) {
        state.libraryID = null;
      }
      state.pendingSelectionItemID = null;
      refreshLegacyGraphTabID();
    },
  });
  state.tabID = result.id;
  state.libraryID = snapshot.libraryID;
  refreshLegacyGraphTabID();
  renderTab(win, result.container, snapshot);
}

export async function openCitationMapAndSelectItem(
  itemID: number,
  hostWindow?: _ZoteroTypes.MainWindow,
): Promise<void> {
  const win = hostWindow ?? defaultMainWindow();
  const item = Zotero.Items.get(itemID) as Zotero.Item | null;
  const libraryID = positiveInteger(item?.libraryID) ?? selectedLibraryID(win);
  if (focusExistingCitationMapItem(win, itemID, libraryID)) return;
  graphState(win).pendingSelectionItemID = itemID;
  await openCitationMapWindow(win, libraryID);
}

export async function refreshOpenCitationMapViews(): Promise<void> {
  for (const [win, state] of [...graphStateByWindow.entries()]) {
    if ((win as any).closed) {
      graphStateByWindow.delete(win);
      continue;
    }
    const hasDetached = Boolean(
      state.detachedWindow &&
      !state.detachedWindow.closed &&
      state.detachedMount,
    );
    const tabID = state.tabID;
    if (!hasDetached && !tabID) continue;

    try {
      let tabInfo: any | null = null;
      if (tabID) {
        const manager = tabs(win);
        tabInfo = manager.getTabInfo(tabID);
        if (!tabInfo) {
          state.tabID = null;
        }
      }
      const libraryID =
        state.libraryID ??
        positiveInteger(tabInfo?.data?.libraryID) ??
        selectedLibraryID(win);
      const snapshot = await loadWholeLibrary(libraryID);
      if (hasDetached) renderDetachedWindow(win, snapshot);
      if (state.tabID && tabInfo) {
        const manager = tabs(win);
        updateTabData(tabInfo, snapshot, null);
        renderTab(win, manager.getTabContent(state.tabID), snapshot);
      }
    } catch (error) {
      reportAsyncError("Citation Map: graph refresh failed", error);
    }
  }
  refreshLegacyGraphTabID();
}

export function closeCitationMapForWindow(
  win: _ZoteroTypes.MainWindow,
  closeTab = true,
): void {
  const state = graphStateByWindow.get(win);
  if (!state) return;

  if (state.detachedWindow && !state.detachedWindow.closed) {
    if (state.detachedMount) destroyCitationMapView(state.detachedMount);
    state.detachedWindow.close();
  }
  state.detachedWindow = null;
  state.detachedMount = null;

  const tabID = state.tabID;
  if (tabID) {
    try {
      const manager = tabs(win);
      if (!closeTab) {
        const container = manager.getTabContent(tabID);
        if (container) destroyCitationMapView(container);
      } else if (manager.getTabInfo(tabID)) {
        manager.close(tabID);
      }
    } catch {
      // Window or tab may already be closed.
    }
  }
  state.tabID = null;
  state.libraryID = null;
  state.pendingSelectionItemID = null;
  graphStateByWindow.delete(win);
  refreshLegacyGraphTabID();
}

export function closeCitationMapWindow(closeTab = true): void {
  for (const win of [...graphStateByWindow.keys()]) {
    closeCitationMapForWindow(win, closeTab);
  }
}

export function getDefaultHostWindow(): _ZoteroTypes.MainWindow {
  return defaultMainWindow();
}
