import { config } from "../../package.json";
import type { LibrarySnapshot } from "../domain/types";
import { positiveInteger } from "../domain/valueNormalization";
import {
  destroyCitationMapView,
  getCitationMapViewController,
  renderCitationMapView,
} from "./graphViewService";
import { loadWholeLibrary } from "./zoteroLibraryService";
import { selectedLibraryIDsFromPane } from "./zoteroSelectionService";
import {
  installDataSourceHoverTooltips,
  uninstallDataSourceHoverTooltips,
} from "./dataSourceTooltipService";
import {
  type CitationMapViewKind,
  citationMapInstanceShouldRender,
  isCitationMapTabDescriptor,
  nextCitationMapViewTitle,
  selectReusableCitationMapInstance,
} from "./citationMapInstancePolicy";
import { getAvailableCitationLibraries } from "./citationLibraryService";

const TAB_TYPE = "citationmap";
const TAB_STATE_FILTER_MARKER = "__citationMapStateFilterInstalled";
const TAB_HOOK_MARKER = "__citationMapTabHooksInstalled";
const NETWORK_ICON_TYPE = "citation-map-network";
const CONTEXT_HANDLER_MARKER = "__citationMapContextHandlerInstalled";
const LIBRARY_FILTER_MARKER = "citationMapLibraryFilterInstalled";
const DETACHED_WINDOW_URL = `chrome://${config.addonRef}/content/citationMapWindow.xhtml`;
interface GraphInstanceState {
  instanceID: string;
  title: string;
  kind: CitationMapViewKind;
  customTitle: boolean;
  tabID: string | null;
  libraryID: number | null;
  pendingSelectionItemIDs: number[];
  pendingSelectionMode: "replace" | "add";
  pendingFocusItemIDs: number[];
  pendingCollectionID: number | null;
  mapScopeItemIDs: number[] | null;
  mapPinnedItemIDs: number[];
  detachedWindow: Window | null;
  detachedMount: HTMLElement | null;
  lastActivatedAt: number;
  dirty: boolean;
  renderGeneration: number;
}

interface GraphWindowState {
  instances: Map<string, GraphInstanceState>;
}

let graphInstanceSequence = 0;
let openViewRefreshGeneration = 0;
const graphStateByWindow = new Map<_ZoteroTypes.MainWindow, GraphWindowState>();

function graphState(win: _ZoteroTypes.MainWindow): GraphWindowState {
  const existing = graphStateByWindow.get(win);
  if (existing) return existing;
  const created: GraphWindowState = {
    instances: new Map(),
  };
  graphStateByWindow.set(win, created);
  return created;
}

function createGraphInstance(
  win: _ZoteroTypes.MainWindow,
  libraryID: number | null = null,
  kind: CitationMapViewKind = "map",
): GraphInstanceState {
  graphInstanceSequence += 1;
  const instanceID = `citation-map-${Date.now().toString(36)}-${graphInstanceSequence.toString(36)}`;
  const state = graphState(win);
  const created: GraphInstanceState = {
    instanceID,
    title: nextCitationMapViewTitle(
      kind,
      [...state.instances.values()].map((instance) => instance.title),
    ),
    kind,
    customTitle: false,
    tabID: null,
    libraryID,
    pendingSelectionItemIDs: [],
    pendingSelectionMode: "replace",
    pendingFocusItemIDs: [],
    pendingCollectionID: null,
    mapScopeItemIDs: null,
    mapPinnedItemIDs: [],
    detachedWindow: null,
    detachedMount: null,
    lastActivatedAt: Date.now(),
    dirty: false,
    renderGeneration: 0,
  };
  state.instances.set(instanceID, created);
  return created;
}

interface PendingGraphRequest {
  selectionItemIDs: number[];
  selectionMode: "replace" | "add";
  focusItemIDs: number[];
  collectionID: number | null;
}

function consumePendingRequest(state: GraphInstanceState): PendingGraphRequest {
  const request = {
    selectionItemIDs: [...state.pendingSelectionItemIDs],
    selectionMode: state.pendingSelectionMode,
    focusItemIDs: [...state.pendingFocusItemIDs],
    collectionID: state.pendingCollectionID,
  };
  state.pendingSelectionItemIDs = [];
  state.pendingSelectionMode = "replace";
  state.pendingFocusItemIDs = [];
  state.pendingCollectionID = null;
  return request;
}

function firstRequestedItemID(request: PendingGraphRequest): number | null {
  return request.selectionItemIDs[0] ?? request.focusItemIDs[0] ?? null;
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
  for (const pane of panes) {
    const libraryID = selectedLibraryIDsFromPane(pane)[0];
    if (libraryID) return libraryID;
  }
  return Zotero.Libraries.userLibraryID;
}

function requestedLibraryID(
  win: _ZoteroTypes.MainWindow,
  libraryID?: number | null,
): number {
  return positiveInteger(libraryID) ?? selectedLibraryID(win);
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
  for (const library of getAvailableCitationLibraries(currentLibraryID)) {
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
  instance: GraphInstanceState,
  snapshot: LibrarySnapshot,
  request: PendingGraphRequest = {
    selectionItemIDs: [],
    selectionMode: "replace",
    focusItemIDs: [],
    collectionID: null,
  },
): void {
  const popup = instance.detachedWindow;
  const mount = instance.detachedMount;
  if (!popup || popup.closed || !mount) return;
  instance.libraryID = snapshot.libraryID;
  instance.lastActivatedAt = Date.now();
  instance.dirty = false;
  const host = liveHostWindow(hostWindow);
  renderCitationMapView(popup.document, mount, snapshot, {
    mode: "window",
    initialViewKind: instance.kind,
    onViewKindChange: (kind) => setInstanceKind(host, instance, kind),
    onSelectPaper: (itemID) => {
      void selectPaper(host, itemID).catch((error) =>
        reportAsyncError("Citation Map: paper selection failed", error),
      );
    },
    initialItemIDs: request.selectionItemIDs,
    initialItemMode: request.selectionMode,
    initialMapScopeItemIDs: instance.mapScopeItemIDs,
    initialMapPinnedItemIDs: instance.mapPinnedItemIDs,
    onMapScopeChange: (scopeItemIDs, pinnedItemIDs) => {
      instance.mapScopeItemIDs = scopeItemIDs ? [...scopeItemIDs] : null;
      instance.mapPinnedItemIDs = [...pinnedItemIDs];
    },
    initialFocusItemIDs: request.focusItemIDs,
    initialCollectionID: request.collectionID,
  });
  installGraphLibraryFilter(
    popup.document,
    mount,
    snapshot.libraryID,
    (libraryID) =>
      openCitationMapWindow(host, libraryID, {
        targetInstanceID: instance.instanceID,
      }),
  );
}

async function openDetachedCitationMapWindow(
  hostWindow: _ZoteroTypes.MainWindow,
  instance: GraphInstanceState,
  snapshot: LibrarySnapshot,
  request: PendingGraphRequest = {
    selectionItemIDs: [],
    selectionMode: "replace",
    focusItemIDs: [],
    collectionID: null,
  },
): Promise<void> {
  if (
    instance.detachedWindow &&
    !instance.detachedWindow.closed &&
    instance.detachedMount
  ) {
    renderDetachedWindow(hostWindow, instance, snapshot, request);
    instance.detachedWindow.focus();
    instance.lastActivatedAt = Date.now();
    return;
  }

  const popup = (hostWindow as any).openDialog?.(
    DETACHED_WINDOW_URL,
    instance.instanceID,
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

  instance.detachedWindow = popup;
  instance.detachedMount = mount;
  instance.libraryID = snapshot.libraryID;
  instance.lastActivatedAt = Date.now();
  installDataSourceHoverTooltips(popup.document);
  popup.document.title = instance.title;
  popup.addEventListener("focus", () => {
    instance.lastActivatedAt = Date.now();
  });
  popup.addEventListener(
    "unload",
    () => {
      if (instance.detachedWindow !== popup) return;
      destroyCitationMapView(mount);
      uninstallDataSourceHoverTooltips(popup.document);
      instance.detachedWindow = null;
      instance.detachedMount = null;
      if (!instance.tabID) {
        graphStateByWindow
          .get(hostWindow)
          ?.instances.delete(instance.instanceID);
      }
    },
    { once: true },
  );
  renderDetachedWindow(hostWindow, instance, snapshot, request);
  popup.focus();
}

function tabLibraryID(
  tab: any,
  win: _ZoteroTypes.MainWindow,
  instance?: GraphInstanceState | null,
): number {
  return (
    instance?.libraryID ??
    positiveInteger(tab?.data?.libraryID) ??
    selectedLibraryID(win)
  );
}

function updateTabData(
  tab: any,
  instance: GraphInstanceState,
  snapshot: LibrarySnapshot,
  itemID: number | null,
): void {
  if (!tab || typeof tab !== "object") return;
  tab.data ??= {};
  tab.data.citationMapInstanceID = instance.instanceID;
  tab.data.citationMapTitle = instance.title;
  tab.data.citationMapKind = instance.kind;
  tab.data.libraryID = snapshot.libraryID;
  tab.data.itemID = itemID ?? snapshot.papers[0]?.itemID ?? null;
}

function syncInstanceTitle(
  win: _ZoteroTypes.MainWindow,
  instance: GraphInstanceState,
): void {
  if (instance.tabID) {
    const manager = tabs(win);
    const tab = manager.getTabInfo(instance.tabID);
    if (tab) {
      tab.data ??= {};
      tab.data.citationMapTitle = instance.title;
      tab.data.citationMapKind = instance.kind;
      void manager.rename(instance.tabID, instance.title);
    }
  }
  if (instance.detachedWindow && !instance.detachedWindow.closed) {
    instance.detachedWindow.document.title = instance.title;
  }
}

function setInstanceKind(
  win: _ZoteroTypes.MainWindow,
  instance: GraphInstanceState,
  kind: CitationMapViewKind,
): void {
  if (instance.kind === kind) return;
  instance.kind = kind;
  if (!instance.customTitle) {
    instance.title = nextCitationMapViewTitle(
      kind,
      [...graphState(win).instances.values()]
        .filter((candidate) => candidate.instanceID !== instance.instanceID)
        .map((candidate) => candidate.title),
    );
  }
  syncInstanceTitle(win, instance);
}

function instanceForTab(
  win: _ZoteroTypes.MainWindow,
  tab: any,
): GraphInstanceState | null {
  if (!isCitationMapTabDescriptor(tab)) return null;
  const state = graphState(win);
  const instanceID = String(tab?.data?.citationMapInstanceID ?? "").trim();
  if (instanceID) {
    const existing = state.instances.get(instanceID);
    if (existing) {
      existing.tabID = tab.id;
      existing.libraryID =
        positiveInteger(tab?.data?.libraryID) ?? existing.libraryID;
      return existing;
    }
  }
  if (!tab?.id) return null;
  const created = createGraphInstance(
    win,
    positiveInteger(tab?.data?.libraryID),
    tab?.data?.citationMapKind === "focus" ? "focus" : "map",
  );
  const restoredTitle = String(tab?.data?.citationMapTitle ?? "").trim();
  if (restoredTitle) {
    created.title = restoredTitle;
    created.customTitle = true;
  }
  created.tabID = tab.id;
  tab.data ??= {};
  tab.data.citationMapInstanceID = created.instanceID;
  return created;
}

function instanceForTabID(
  win: _ZoteroTypes.MainWindow,
  tabID: string | null | undefined,
): GraphInstanceState | null {
  if (!tabID) return null;
  const state = graphState(win);
  for (const instance of state.instances.values()) {
    if (instance.tabID === tabID) return instance;
  }
  try {
    const tab = tabs(win).getTabInfo(tabID);
    return isCitationMapTabDescriptor(tab) ? instanceForTab(win, tab) : null;
  } catch {
    return null;
  }
}

function liveInstances(win: _ZoteroTypes.MainWindow): GraphInstanceState[] {
  const state = graphState(win);
  const manager = tabs(win);
  for (const tab of manager._tabs ?? []) {
    if (isCitationMapTabDescriptor(tab)) instanceForTab(win, tab);
  }
  for (const [instanceID, instance] of [...state.instances.entries()]) {
    if (instance.tabID) {
      try {
        if (!manager.getTabInfo(instance.tabID)) instance.tabID = null;
      } catch {
        instance.tabID = null;
      }
    }
    if (
      !instance.tabID &&
      (!instance.detachedWindow || instance.detachedWindow.closed)
    ) {
      state.instances.delete(instanceID);
    }
  }
  return [...state.instances.values()];
}

function activeOrRecentInstance(
  win: _ZoteroTypes.MainWindow,
  libraryID?: number | null,
): GraphInstanceState | null {
  const manager = tabs(win);
  instanceForTabID(win, manager.selectedID);
  return selectReusableCitationMapInstance(
    liveInstances(win).filter(
      (instance) => !libraryID || instance.libraryID === libraryID,
    ),
    manager.selectedID,
  );
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
  manager.tabHooks.getTitle[TAB_TYPE] = async (tab: any) =>
    String(tab?.data?.citationMapTitle ?? "Citation Map");
  const focus = (tab: any): void => {
    const container = manager.getTabContent(tab.id);
    (container?.querySelector(".cm-search") as HTMLElement | null)?.focus();
  };
  manager.tabHooks.focusFirst[TAB_TYPE] = focus;
  manager.tabHooks.refocus[TAB_TYPE] = focus;
  manager.tabHooks.moveToNewWindow[TAB_TYPE] = async (tab: any) => {
    try {
      const instance = instanceForTab(win, tab);
      if (!instance) throw new Error("Citation Map instance is unavailable.");
      const libraryID = tabLibraryID(tab, win, instance);
      const snapshot = await loadWholeLibrary(libraryID);
      const request = consumePendingRequest(instance);
      await openDetachedCitationMapWindow(win, instance, snapshot, request);
      instance.tabID = null;
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
  instance: GraphInstanceState,
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
      getCitationMapViewController(container)?.setActive(selected);
      if (selected) {
        instance.lastActivatedAt = Date.now();
        hideGlobalContextPane(win, container);
        if (instance.dirty) {
          instance.dirty = false;
          void refreshGraphInstance(win, instance).catch((error) =>
            reportAsyncError(
              "Citation Map: deferred graph refresh failed",
              error,
            ),
          );
        }
      }
    });
    marked[CONTEXT_HANDLER_MARKER] = true;
  }

  if (tabs(win).selectedID === container.id) {
    hideGlobalContextPane(win, container);
  }
}

function renderTab(
  win: _ZoteroTypes.MainWindow,
  instance: GraphInstanceState,
  container: HTMLElement,
  snapshot: LibrarySnapshot,
): void {
  instance.libraryID = snapshot.libraryID;
  instance.dirty = false;
  instance.renderGeneration += 1;
  const generation = instance.renderGeneration;
  prepareContainer(win, instance, container);
  installDataSourceHoverTooltips(win.document);
  let attempts = 10;
  const render = (): void => {
    if (win.closed || generation !== instance.renderGeneration) return;
    if (!container.isConnected && attempts > 0) {
      attempts -= 1;
      win.setTimeout(() => win.requestAnimationFrame(render), 50);
      return;
    }
    const request = consumePendingRequest(instance);
    renderCitationMapView(win.document, container, snapshot, {
      mode: "tab",
      initialViewKind: instance.kind,
      onViewKindChange: (kind) => setInstanceKind(win, instance, kind),
      onSelectPaper: (itemID) => {
        void selectPaper(win, itemID).catch((error) =>
          reportAsyncError("Citation Map: paper selection failed", error),
        );
      },
      initialItemIDs: request.selectionItemIDs,
      initialItemMode: request.selectionMode,
      initialMapScopeItemIDs: instance.mapScopeItemIDs,
      initialMapPinnedItemIDs: instance.mapPinnedItemIDs,
      onMapScopeChange: (scopeItemIDs, pinnedItemIDs) => {
        instance.mapScopeItemIDs = scopeItemIDs ? [...scopeItemIDs] : null;
        instance.mapPinnedItemIDs = [...pinnedItemIDs];
      },
      initialFocusItemIDs: request.focusItemIDs,
      initialCollectionID: request.collectionID,
    });
    getCitationMapViewController(container)?.setActive(
      tabs(win).selectedID === instance.tabID,
    );
    installGraphLibraryFilter(
      win.document,
      container,
      snapshot.libraryID,
      (libraryID) =>
        openCitationMapWindow(win, libraryID, {
          targetInstanceID: instance.instanceID,
        }),
    );
  };
  win.requestAnimationFrame(render);
}

function instanceMount(
  win: _ZoteroTypes.MainWindow,
  instance: GraphInstanceState,
): HTMLElement | null {
  if (
    instance.detachedWindow &&
    !instance.detachedWindow.closed &&
    instance.detachedMount
  ) {
    return instance.detachedMount;
  }
  if (!instance.tabID) return null;
  try {
    return tabs(win).getTabContent(instance.tabID) as HTMLElement | null;
  } catch {
    return null;
  }
}

function activateInstance(
  win: _ZoteroTypes.MainWindow,
  instance: GraphInstanceState,
): void {
  instance.lastActivatedAt = Date.now();
  if (instance.detachedWindow && !instance.detachedWindow.closed) {
    instance.detachedWindow.focus();
  } else if (instance.tabID) {
    tabs(win).select(instance.tabID);
    win.focus();
  }
}

function activateCitationMapItems(
  win: _ZoteroTypes.MainWindow,
  instance: GraphInstanceState,
  itemIDs: readonly number[],
  action: "add-map" | "add-focus",
): boolean {
  const mount = instanceMount(win, instance);
  if (!mount) return false;
  const controller = getCitationMapViewController(mount);
  controller?.setActive(true);
  const result =
    action === "add-focus"
      ? controller?.addFocusItems(itemIDs)
      : controller?.addMapItems(itemIDs);
  if (!result || result === "not-found") return false;
  activateInstance(win, instance);
  return true;
}

function activateCitationMapCollection(
  win: _ZoteroTypes.MainWindow,
  instance: GraphInstanceState,
  collectionID: number,
): boolean {
  const mount = instanceMount(win, instance);
  if (!mount) return false;
  const controller = getCitationMapViewController(mount);
  controller?.setActive(true);
  const result = controller?.openCollection(collectionID);
  if (!result || result === "not-found") return false;
  activateInstance(win, instance);
  return true;
}

interface OpenCitationMapOptions {
  newInstance?: boolean;
  targetInstanceID?: string | null;
  initialKind?: CitationMapViewKind;
  request?: PendingGraphRequest;
}

function requestViewKind(
  request: PendingGraphRequest | undefined,
): CitationMapViewKind | null {
  if (!request) return null;
  return request.focusItemIDs.length ? "focus" : "map";
}

function requestedInstance(
  win: _ZoteroTypes.MainWindow,
  options: OpenCitationMapOptions,
): GraphInstanceState | null {
  if (options.newInstance) return null;
  if (options.targetInstanceID) {
    const target = graphState(win).instances.get(options.targetInstanceID);
    if (target) return target;
  }
  return activeOrRecentInstance(win);
}

function setPendingRequest(
  instance: GraphInstanceState,
  request: PendingGraphRequest,
): void {
  instance.pendingSelectionItemIDs = [...request.selectionItemIDs];
  instance.pendingSelectionMode = request.selectionMode;
  instance.pendingFocusItemIDs = [...request.focusItemIDs];
  instance.pendingCollectionID = request.collectionID;
}

function emptyRequest(): PendingGraphRequest {
  return {
    selectionItemIDs: [],
    selectionMode: "replace",
    focusItemIDs: [],
    collectionID: null,
  };
}

async function refreshGraphInstance(
  win: _ZoteroTypes.MainWindow,
  instance: GraphInstanceState,
): Promise<void> {
  const libraryID = instance.libraryID ?? selectedLibraryID(win);
  const snapshot = await loadWholeLibrary(libraryID);
  if (instance.detachedWindow && !instance.detachedWindow.closed) {
    renderDetachedWindow(win, instance, snapshot);
    return;
  }
  if (!instance.tabID) return;
  const manager = tabs(win);
  const tab = manager.getTabInfo(instance.tabID);
  const container = manager.getTabContent(instance.tabID) as HTMLElement | null;
  if (!tab || !container) return;
  updateTabData(tab, instance, snapshot, null);
  renderTab(win, instance, container, snapshot);
}

export async function openCitationMapWindow(
  hostWindow?: _ZoteroTypes.MainWindow,
  libraryID?: number | null,
  options: OpenCitationMapOptions = {},
): Promise<void> {
  const win = hostWindow ?? defaultMainWindow();
  installCitationMapTabHooks(win);
  liveInstances(win);
  const targetLibraryID = requestedLibraryID(win, libraryID);
  const snapshot = await loadWholeLibrary(targetLibraryID);
  if (!snapshot.papers.length) {
    throw new Error(
      `${snapshot.libraryName} contains no regular Zotero items for Citation Map.`,
    );
  }

  let instance = requestedInstance(win, options);
  const requestedKind = options.initialKind ?? requestViewKind(options.request);
  if (!instance) {
    instance = createGraphInstance(
      win,
      targetLibraryID,
      requestedKind ?? "map",
    );
  } else if (requestedKind) {
    setInstanceKind(win, instance, requestedKind);
  }
  const previousLibraryID = instance.libraryID;
  if (previousLibraryID !== null && previousLibraryID !== targetLibraryID) {
    instance.mapScopeItemIDs = null;
    instance.mapPinnedItemIDs = [];
  }
  if (options.request) setPendingRequest(instance, options.request);
  instance.libraryID = targetLibraryID;
  instance.lastActivatedAt = Date.now();

  if (instance.detachedWindow && !instance.detachedWindow.closed) {
    await openDetachedCitationMapWindow(
      win,
      instance,
      snapshot,
      consumePendingRequest(instance),
    );
    return;
  }

  const manager = tabs(win);
  if (instance.tabID) {
    const tab = manager.getTabInfo(instance.tabID);
    const container = manager.getTabContent(
      instance.tabID,
    ) as HTMLElement | null;
    if (tab && container) {
      const requestItemID =
        instance.pendingSelectionItemIDs[0] ??
        instance.pendingFocusItemIDs[0] ??
        null;
      updateTabData(tab, instance, snapshot, requestItemID);
      if (options.request || previousLibraryID !== snapshot.libraryID) {
        renderTab(win, instance, container, snapshot);
      }
      activateInstance(win, instance);
      return;
    }
    instance.tabID = null;
  }

  const request = {
    selectionItemIDs: [...instance.pendingSelectionItemIDs],
    selectionMode: instance.pendingSelectionMode,
    focusItemIDs: [...instance.pendingFocusItemIDs],
    collectionID: instance.pendingCollectionID,
  };
  const result: any = manager.add({
    id: instance.instanceID,
    type: TAB_TYPE,
    title: instance.title,
    data: {
      itemID: firstRequestedItemID(request) ?? snapshot.papers[0].itemID,
      libraryID: snapshot.libraryID,
      citationMap: true,
      citationMapInstanceID: instance.instanceID,
      citationMapTitle: instance.title,
      citationMapKind: instance.kind,
      icon: NETWORK_ICON_TYPE,
    },
    select: true,
    onClose: () => {
      destroyCitationMapView(result.container);
      if (instance.tabID === result.id) instance.tabID = null;
      instance.pendingSelectionItemIDs = [];
      instance.pendingSelectionMode = "replace";
      instance.pendingFocusItemIDs = [];
      instance.pendingCollectionID = null;
      instance.mapScopeItemIDs = null;
      instance.mapPinnedItemIDs = [];
      if (!instance.detachedWindow || instance.detachedWindow.closed) {
        graphStateByWindow.get(win)?.instances.delete(instance.instanceID);
      }
    },
  });
  if (result.id === "zotero-pane" || result.container?.id === "zotero-pane") {
    throw new Error(
      "Citation Map refused to mount into Zotero's reserved library tab.",
    );
  }
  instance.tabID = result.id;
  instance.libraryID = snapshot.libraryID;
  instance.lastActivatedAt = Date.now();
  renderTab(win, instance, result.container, snapshot);
}

export async function openNewCitationMapWindow(
  hostWindow?: _ZoteroTypes.MainWindow,
  libraryID?: number | null,
): Promise<void> {
  await openCitationMapWindow(hostWindow, libraryID, { newInstance: true });
}

export async function openNewCitationMapFocusWindow(
  hostWindow?: _ZoteroTypes.MainWindow,
  libraryID?: number | null,
): Promise<void> {
  await openCitationMapWindow(hostWindow, libraryID, {
    newInstance: true,
    initialKind: "focus",
  });
}

export interface OpenCitationMapViewInfo {
  instanceID: string;
  title: string;
  kind: CitationMapViewKind;
  tabID: string | null;
  active: boolean;
  detached: boolean;
}

export function getOpenCitationMapViews(
  hostWindow?: _ZoteroTypes.MainWindow,
): OpenCitationMapViewInfo[] {
  const win = hostWindow ?? defaultMainWindow();
  const selectedTabID = tabs(win).selectedID;
  return liveInstances(win)
    .sort((left, right) => right.lastActivatedAt - left.lastActivatedAt)
    .map((instance) => ({
      instanceID: instance.instanceID,
      title: instance.title,
      kind: instance.kind,
      tabID: instance.tabID,
      active:
        instance.tabID === selectedTabID ||
        Boolean(
          instance.detachedWindow &&
          !instance.detachedWindow.closed &&
          instance.detachedWindow.document.hasFocus?.(),
        ),
      detached: Boolean(
        instance.detachedWindow && !instance.detachedWindow.closed,
      ),
    }));
}

export function renameCitationMapView(
  tabID: string,
  title: string,
  hostWindow?: _ZoteroTypes.MainWindow,
): void {
  const win = hostWindow ?? defaultMainWindow();
  const instance = instanceForTabID(win, tabID);
  if (!instance) {
    throw new Error("The selected tab is not a Citation Map view.");
  }
  const normalized = title.trim();
  if (!normalized) throw new Error("Citation Map view names cannot be empty.");
  instance.title = normalized;
  instance.customTitle = true;
  syncInstanceTitle(win, instance);
}

export async function openCitationMapInView(
  instanceID: string,
  hostWindow?: _ZoteroTypes.MainWindow,
  libraryID?: number | null,
): Promise<void> {
  await openCitationMapWindow(hostWindow, libraryID, {
    targetInstanceID: instanceID,
  });
}

interface OpenItemViewOptions {
  newInstance?: boolean;
  targetInstanceID?: string | null;
}

function itemCommandInstance(
  win: _ZoteroTypes.MainWindow,
  options: OpenItemViewOptions,
): GraphInstanceState | null {
  if (options.newInstance) return null;
  if (options.targetInstanceID) {
    return graphState(win).instances.get(options.targetInstanceID) ?? null;
  }
  return activeOrRecentInstance(win);
}

function regularItemsByID(itemIDs: readonly number[]): Zotero.Item[] {
  return [...new Set(itemIDs)]
    .map((itemID) => Zotero.Items.get(itemID) as Zotero.Item | null)
    .filter((item): item is Zotero.Item =>
      Boolean(item?.isRegularItem?.() && !item.deleted),
    );
}

export async function openCitationMapAndSelectItems(
  itemIDs: readonly number[],
  hostWindow?: _ZoteroTypes.MainWindow,
  options: OpenItemViewOptions = {},
): Promise<void> {
  const win = hostWindow ?? defaultMainWindow();
  const items = regularItemsByID(itemIDs);
  if (!items.length) throw new Error("No regular Zotero items were selected.");
  const libraryID =
    positiveInteger(items[0].libraryID) ?? selectedLibraryID(win);
  const ids = items
    .filter((item) => Number(item.libraryID) === libraryID)
    .map((item) => Number(item.id));
  const instance = itemCommandInstance(win, options);
  const canExtendExistingScope = instance?.libraryID === libraryID;
  if (
    canExtendExistingScope &&
    activateCitationMapItems(win, instance, ids, "add-map")
  ) {
    return;
  }
  await openCitationMapWindow(win, libraryID, {
    newInstance: options.newInstance,
    targetInstanceID: options.targetInstanceID ?? instance?.instanceID,
    request: {
      ...emptyRequest(),
      selectionItemIDs: ids,
      selectionMode: canExtendExistingScope ? "add" : "replace",
    },
  });
}

export async function openCitationMapAndSelectItemsInNewTab(
  itemIDs: readonly number[],
  hostWindow?: _ZoteroTypes.MainWindow,
): Promise<void> {
  await openCitationMapAndSelectItems(itemIDs, hostWindow, {
    newInstance: true,
  });
}

export async function openCitationMapAndSelectItemsInView(
  instanceID: string,
  itemIDs: readonly number[],
  hostWindow?: _ZoteroTypes.MainWindow,
): Promise<void> {
  await openCitationMapAndSelectItems(itemIDs, hostWindow, {
    targetInstanceID: instanceID,
  });
}

export async function openCitationMapFocusItem(
  itemID: number,
  hostWindow?: _ZoteroTypes.MainWindow,
): Promise<void> {
  await openCitationMapFocusItems([itemID], hostWindow);
}

export async function openCitationMapFocusItems(
  itemIDs: readonly number[],
  hostWindow?: _ZoteroTypes.MainWindow,
  options: OpenItemViewOptions = {},
): Promise<void> {
  const win = hostWindow ?? defaultMainWindow();
  const items = regularItemsByID(itemIDs);
  if (!items.length) throw new Error("No regular Zotero items were selected.");
  const libraryID =
    positiveInteger(items[0].libraryID) ?? selectedLibraryID(win);
  const ids = items
    .filter((item) => Number(item.libraryID) === libraryID)
    .map((item) => Number(item.id));
  const instance = itemCommandInstance(win, options);
  if (
    instance?.libraryID === libraryID &&
    activateCitationMapItems(win, instance, ids, "add-focus")
  ) {
    return;
  }
  await openCitationMapWindow(win, libraryID, {
    newInstance: options.newInstance,
    targetInstanceID: options.targetInstanceID ?? instance?.instanceID,
    request: {
      ...emptyRequest(),
      focusItemIDs: ids,
    },
  });
}

export async function openCitationMapFocusItemsInNewTab(
  itemIDs: readonly number[],
  hostWindow?: _ZoteroTypes.MainWindow,
): Promise<void> {
  await openCitationMapFocusItems(itemIDs, hostWindow, {
    newInstance: true,
  });
}

export async function openCitationMapFocusItemsInView(
  instanceID: string,
  itemIDs: readonly number[],
  hostWindow?: _ZoteroTypes.MainWindow,
): Promise<void> {
  await openCitationMapFocusItems(itemIDs, hostWindow, {
    targetInstanceID: instanceID,
  });
}

export async function openCitationMapCollection(
  collectionID: number,
  hostWindow?: _ZoteroTypes.MainWindow,
  options: OpenItemViewOptions = {},
): Promise<void> {
  const win = hostWindow ?? defaultMainWindow();
  const collection = Zotero.Collections.get(collectionID) as any;
  if (!collection) {
    throw new Error("The selected Zotero collection is unavailable.");
  }
  const libraryID =
    positiveInteger(collection.libraryID) ?? selectedLibraryID(win);
  const instance = itemCommandInstance(win, options);
  if (
    instance?.libraryID === libraryID &&
    activateCitationMapCollection(win, instance, collectionID)
  ) {
    return;
  }
  await openCitationMapWindow(win, libraryID, {
    newInstance: options.newInstance,
    targetInstanceID: options.targetInstanceID ?? instance?.instanceID,
    request: {
      ...emptyRequest(),
      collectionID,
    },
  });
}

export async function refreshOpenCitationMapViews(): Promise<void> {
  const generation = ++openViewRefreshGeneration;
  const snapshotByLibrary = new Map<number, Promise<LibrarySnapshot>>();
  const getSnapshot = (libraryID: number): Promise<LibrarySnapshot> => {
    let pending = snapshotByLibrary.get(libraryID);
    if (!pending) {
      pending = loadWholeLibrary(libraryID);
      snapshotByLibrary.set(libraryID, pending);
    }
    return pending;
  };

  for (const [win] of [...graphStateByWindow.entries()]) {
    if (generation !== openViewRefreshGeneration) return;
    if ((win as any).closed) {
      graphStateByWindow.delete(win);
      continue;
    }
    const manager = tabs(win);
    for (const instance of liveInstances(win)) {
      if (generation !== openViewRefreshGeneration) return;
      const hasDetached = Boolean(
        instance.detachedWindow &&
        !instance.detachedWindow.closed &&
        instance.detachedMount,
      );
      const isSelectedTab = Boolean(
        instance.tabID && manager.selectedID === instance.tabID,
      );
      if (!citationMapInstanceShouldRender(hasDetached, isSelectedTab)) {
        instance.dirty = true;
        continue;
      }
      try {
        const libraryID = instance.libraryID ?? selectedLibraryID(win);
        const snapshot = await getSnapshot(libraryID);
        if (generation !== openViewRefreshGeneration) return;
        if (hasDetached) {
          renderDetachedWindow(win, instance, snapshot);
        } else if (instance.tabID) {
          const tab = manager.getTabInfo(instance.tabID);
          const container = manager.getTabContent(
            instance.tabID,
          ) as HTMLElement | null;
          if (!tab || !container) continue;
          updateTabData(tab, instance, snapshot, null);
          renderTab(win, instance, container, snapshot);
        }
      } catch (error) {
        reportAsyncError("Citation Map: graph refresh failed", error);
      }
    }
  }
}

export function cancelPendingCitationMapRefreshes(): void {
  openViewRefreshGeneration += 1;
}

export function closeCitationMapForWindow(
  win: _ZoteroTypes.MainWindow,
  closeTab = true,
): void {
  const state = graphStateByWindow.get(win);
  if (!state) return;
  const manager = tabs(win);
  for (const instance of [...state.instances.values()]) {
    if (instance.detachedWindow && !instance.detachedWindow.closed) {
      if (instance.detachedMount) {
        destroyCitationMapView(instance.detachedMount);
      }
      instance.detachedWindow.close();
    }
    instance.detachedWindow = null;
    instance.detachedMount = null;

    const tabID = instance.tabID;
    if (!tabID) continue;
    try {
      if (!closeTab) {
        const container = manager.getTabContent(tabID);
        if (container) destroyCitationMapView(container);
      } else if (manager.getTabInfo(tabID)) {
        manager.close(tabID);
      }
    } catch {
      // Window or tab may already be closed.
    }
    instance.tabID = null;
  }
  state.instances.clear();
  graphStateByWindow.delete(win);
}

export function closeCitationMapWindow(closeTab = true): void {
  for (const win of [...graphStateByWindow.keys()]) {
    closeCitationMapForWindow(win, closeTab);
  }
}

export function getDefaultHostWindow(): _ZoteroTypes.MainWindow {
  return defaultMainWindow();
}
