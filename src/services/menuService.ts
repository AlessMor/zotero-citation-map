import { config } from "../../package.json";
import { positiveInteger } from "../domain/valueNormalization";
import { updateCitationDataForItems } from "./citationUpdateService";
import {
  getDefaultHostWindow,
  getOpenCitationMapViews,
  type OpenCitationMapViewInfo,
  openCitationMapAndSelectItemsInNewTab,
  openCitationMapAndSelectItemsInView,
  openCitationMapFocusItemsInNewTab,
  openCitationMapFocusItemsInView,
  openCitationMapInView,
  openNewCitationMapFocusWindow,
  openNewCitationMapWindow,
  renameCitationMapView,
} from "./windowService";
import { loadWholeLibrary } from "./zoteroLibraryService";

const registeredMenuIDs: string[] = [];
const ICON = `chrome://${config.addonRef}/content/icons/network.svg`;
const OPEN_IN_DYNAMIC_ATTR = "data-citation-map-open-view";

type MainWindow = _ZoteroTypes.MainWindow;
type MenuData = Record<string, unknown>;

interface MenuCommandContext {
  itemIDs: number[];
  collectionID: number | null;
  libraryID: number;
}

type MenuContextResolver = (
  context: any,
) => Promise<MenuCommandContext> | MenuCommandContext;

function register(definition: Record<string, unknown>): void {
  const manager = (Zotero as any).MenuManager;
  if (!manager?.registerMenu) {
    throw new Error("Zotero.MenuManager is unavailable. Zotero 9 is required.");
  }
  const id = manager.registerMenu(definition);
  if (id) registeredMenuIDs.push(id);
}

function safeContextValue(context: any, key: string): any {
  try {
    return context?.[key];
  } catch {
    return null;
  }
}

function contextWindow(context?: any): MainWindow {
  const menuElem = safeContextValue(context, "menuElem") as
    HTMLElement | undefined;
  const candidate =
    (menuElem as any)?.ownerGlobal ?? menuElem?.ownerDocument?.defaultView;
  if (candidate?.ZoteroPane && !candidate.closed)
    return candidate as MainWindow;
  return getDefaultHostWindow();
}

function paneForContext(context?: any): any {
  return (contextWindow(context) as any).ZoteroPane;
}

function activeLibraryID(context?: any): number {
  const pane = paneForContext(context);
  const direct = positiveInteger(pane?.getSelectedLibraryID?.());
  if (direct) return direct;

  const row = pane?.getCollectionTreeRow?.() as any;
  const fromRow = positiveInteger(row?.libraryID ?? row?.ref?.libraryID);
  if (fromRow) return fromRow;

  const selected = pane?.getSelectedItems?.() ?? [];
  const fromItem = positiveInteger(selected[0]?.libraryID);
  return fromItem ?? Zotero.Libraries.userLibraryID;
}

function selectedRegularItems(context: any): Zotero.Item[] {
  const contextual = Array.isArray(context?.items) ? context.items : [];
  const selected = paneForContext(context)?.getSelectedItems?.() ?? [];
  return (contextual.length ? contextual : selected).filter(
    (item: Zotero.Item) => item?.isRegularItem?.() && !item.deleted,
  );
}

function selectedCollection(context?: any): any | null {
  const pane = paneForContext(context);
  const candidates = [
    safeContextValue(context, "collection"),
    safeContextValue(context, "collectionTreeRow"),
    safeContextValue(context, "row"),
    pane?.getCollectionTreeRow?.(),
    pane?.getSelectedCollection?.(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (
      typeof candidate.isCollection === "function" &&
      !candidate.isCollection()
    ) {
      continue;
    }
    const ref = candidate.ref ?? candidate.collection ?? candidate;
    const collectionID = positiveInteger(
      ref.collectionID ?? ref.id ?? candidate.collectionID ?? candidate.id,
    );
    if (!collectionID) continue;
    const collection = Zotero.Collections.get(collectionID) as any;
    if (collection) return collection;
  }
  return null;
}

async function activeLibraryRegularItems(
  context?: any,
): Promise<Zotero.Item[]> {
  const items = (await Zotero.Items.getAll(
    activeLibraryID(context),
  )) as Zotero.Item[];
  return items.filter((item) => item?.isRegularItem?.() && !item.deleted);
}

async function collectionRegularItems(collection: any): Promise<Zotero.Item[]> {
  const collectionID = positiveInteger(
    collection?.id ?? collection?.collectionID,
  );
  const libraryID = positiveInteger(collection?.libraryID);
  if (!collectionID || !libraryID) return [];
  const snapshot = await loadWholeLibrary(libraryID);
  const descriptor = snapshot.collections.find(
    (entry) => entry.collectionID === collectionID,
  );
  const included = new Set(
    descriptor?.includedCollectionIDs?.length
      ? descriptor.includedCollectionIDs
      : [collectionID],
  );
  return snapshot.papers
    .filter((paper) =>
      paper.collectionIDs.some((candidate) => included.has(candidate)),
    )
    .map((paper) => Zotero.Items.get(paper.itemID) as Zotero.Item | null)
    .filter((item): item is Zotero.Item =>
      Boolean(item?.isRegularItem?.() && !item.deleted),
    );
}

function itemIDs(items: readonly Zotero.Item[]): number[] {
  return items
    .map((item) => positiveInteger(item.id))
    .filter((id): id is number => id !== null);
}

function report(error: unknown): void {
  Zotero.logError(error instanceof Error ? error : new Error(String(error)));
}

function openCitationMapSettings(): void {
  const internalUtilities = Zotero.Utilities.Internal as any;
  if (typeof internalUtilities?.openPreferences !== "function") {
    throw new Error("Zotero preferences could not be opened.");
  }
  const preferenceWindow = internalUtilities.openPreferences(
    `${config.addonRef}-preferences`,
  );
  preferenceWindow?.focus?.();
}

function refreshItems(items: readonly Zotero.Item[]): void {
  if (!items.length) return;
  void updateCitationDataForItems([...items], {
    force: false,
    silent: false,
  }).catch(report);
}

async function focusItemIDs(command: MenuCommandContext): Promise<number[]> {
  if (command.itemIDs.length) return command.itemIDs;
  if (!command.collectionID) return [];
  const collection = Zotero.Collections.get(command.collectionID) as any;
  return collection ? itemIDs(await collectionRegularItems(collection)) : [];
}

async function openInNewMap(
  command: MenuCommandContext,
  hostWindow: MainWindow,
): Promise<void> {
  if (command.itemIDs.length) {
    await openCitationMapAndSelectItemsInNewTab(command.itemIDs, hostWindow);
    return;
  }
  if (command.collectionID) {
    const ids = await focusItemIDs(command);
    if (ids.length) {
      await openCitationMapAndSelectItemsInNewTab(ids, hostWindow);
      return;
    }
  }
  await openNewCitationMapWindow(hostWindow, command.libraryID);
}

async function openInNewFocusView(
  command: MenuCommandContext,
  hostWindow: MainWindow,
): Promise<void> {
  const ids = await focusItemIDs(command);
  if (!ids.length) return;
  await openCitationMapFocusItemsInNewTab(ids, hostWindow);
}

async function openInExistingView(
  view: OpenCitationMapViewInfo,
  command: MenuCommandContext,
  hostWindow: MainWindow,
): Promise<void> {
  if (view.kind === "focus") {
    const ids = await focusItemIDs(command);
    if (!ids.length) return;
    await openCitationMapFocusItemsInView(view.instanceID, ids, hostWindow);
    return;
  }
  if (command.itemIDs.length) {
    await openCitationMapAndSelectItemsInView(
      view.instanceID,
      command.itemIDs,
      hostWindow,
    );
    return;
  }
  if (command.collectionID) {
    const ids = await focusItemIDs(command);
    if (ids.length) {
      await openCitationMapAndSelectItemsInView(
        view.instanceID,
        ids,
        hostWindow,
      );
      return;
    }
  }
  await openCitationMapInView(view.instanceID, hostWindow, command.libraryID);
}

function commandItem(
  l10nID: string,
  run: (context: any) => Promise<void> | void,
  l10nArgs?: Record<string, unknown>,
): MenuData {
  return {
    menuType: "menuitem",
    l10nID,
    ...(l10nArgs ? { l10nArgs: JSON.stringify(l10nArgs) } : {}),
    onCommand: (_event: Event, context: any) => {
      void Promise.resolve(run(context)).catch(report);
    },
  };
}

function openInSubmenu(resolve: MenuContextResolver): MenuData {
  const newMap = commandItem(
    `${config.addonRef}-new-citation-map-view-command`,
    async (commandContext) => {
      await openInNewMap(
        await Promise.resolve(resolve(commandContext)),
        contextWindow(commandContext),
      );
    },
  );
  const newFocus = commandItem(
    `${config.addonRef}-new-focus-view-command`,
    async (commandContext) => {
      await openInNewFocusView(
        await Promise.resolve(resolve(commandContext)),
        contextWindow(commandContext),
      );
    },
  );
  const submenu: MenuData = {
    menuType: "submenu",
    l10nID: `${config.addonRef}-open-in-submenu`,
    menus: [newMap, newFocus],
  };
  submenu.onShowing = (_event: Event, context: any) => {
    const menuElem = safeContextValue(context, "menuElem") as
      HTMLElement | undefined;
    const popup = menuElem?.querySelector(
      ":scope > menupopup",
    ) as HTMLElement | null;
    if (!popup) return;
    const rebuild = (event: Event): void => {
      if (event.target !== popup) return;
      popup
        .querySelectorAll(`[${OPEN_IN_DYNAMIC_ATTR}]`)
        .forEach((node) => node.remove());
      const hostWindow = contextWindow(context);
      const openViews = getOpenCitationMapViews(hostWindow);
      if (!openViews.length) return;

      const document = popup.ownerDocument as any;
      const separator = document.createXULElement("menuseparator");
      separator.setAttribute(OPEN_IN_DYNAMIC_ATTR, "true");
      popup.appendChild(separator);
      for (const view of openViews) {
        const item = document.createXULElement("menuitem");
        item.setAttribute(OPEN_IN_DYNAMIC_ATTR, "true");
        item.setAttribute(
          "label",
          view.active ? `✓ ${view.title}` : view.title,
        );
        item.addEventListener(
          "command",
          () => {
            void Promise.resolve(resolve(context))
              .then((command) => openInExistingView(view, command, hostWindow))
              .catch(report);
          },
          { once: true },
        );
        popup.appendChild(item);
      }
    };
    popup.addEventListener("popupshowing", rebuild);
    const parentPopup = menuElem?.parentElement;
    parentPopup?.addEventListener(
      "popuphidden",
      () => popup.removeEventListener("popupshowing", rebuild),
      { once: true },
    );
  };
  return submenu;
}

function itemResolver(context: any): MenuCommandContext {
  const items = selectedRegularItems(context);
  return {
    itemIDs: itemIDs(items),
    collectionID: null,
    libraryID: positiveInteger(items[0]?.libraryID) ?? activeLibraryID(context),
  };
}

function collectionResolver(context: any): MenuCommandContext {
  const collection = selectedCollection(context);
  return {
    itemIDs: [],
    collectionID: positiveInteger(collection?.id ?? collection?.collectionID),
    libraryID:
      positiveInteger(collection?.libraryID) ?? activeLibraryID(context),
  };
}

function itemSubmenu(): MenuData {
  return {
    menuType: "submenu",
    l10nID: `${config.addonRef}-tools-submenu`,
    icon: ICON,
    onShowing: (_event: Event, context: any) => {
      const items = selectedRegularItems(context);
      context.setVisible(items.length > 0);
      context.setEnabled(items.length > 0);
    },
    menus: [
      openInSubmenu(itemResolver),
      commandItem(`${config.addonRef}-refresh-command`, (context) => {
        refreshItems(selectedRegularItems(context));
      }),
    ],
  };
}

function collectionSubmenu(): MenuData {
  return {
    menuType: "submenu",
    l10nID: `${config.addonRef}-tools-submenu`,
    icon: ICON,
    onShowing: (_event: Event, context: any) => {
      const collection = selectedCollection(context);
      context.setVisible(Boolean(collection));
      context.setEnabled(Boolean(collection));
    },
    menus: [
      openInSubmenu(collectionResolver),
      commandItem(`${config.addonRef}-refresh-command`, async (context) => {
        const collection = selectedCollection(context);
        if (collection) refreshItems(await collectionRegularItems(collection));
      }),
    ],
  };
}

function toolsSubmenu(): MenuData {
  return {
    menuType: "submenu",
    l10nID: `${config.addonRef}-tools-submenu`,
    icon: ICON,
    menus: [
      commandItem(
        `${config.addonRef}-new-citation-map-view-command`,
        (context) =>
          openNewCitationMapWindow(
            contextWindow(context),
            activeLibraryID(context),
          ),
      ),
      commandItem(`${config.addonRef}-new-focus-view-command`, (context) =>
        openNewCitationMapFocusWindow(
          contextWindow(context),
          activeLibraryID(context),
        ),
      ),
      commandItem(
        `${config.addonRef}-refresh-library-command`,
        async (context) => {
          refreshItems(await activeLibraryRegularItems(context));
        },
      ),
      { menuType: "separator" },
      commandItem(`${config.addonRef}-settings-command`, () => {
        openCitationMapSettings();
      }),
    ],
  };
}

function tabRenameItem(): MenuData {
  return {
    menuType: "menuitem",
    l10nID: `${config.addonRef}-rename-view-command`,
    onShowing: (_event: Event, context: any) => {
      const tabType = String(
        safeContextValue(context, "tabType") ?? "",
      ).replace(/-unloaded$/, "");
      context.setVisible(tabType === "citationmap");
      context.setEnabled(tabType === "citationmap");
    },
    onCommand: (_event: Event, context: any) => {
      const tabID = String(safeContextValue(context, "tabID") ?? "");
      if (!tabID || tabID === "zotero-pane") return;
      const hostWindow = contextWindow(context);
      const current = getOpenCitationMapViews(hostWindow).find(
        (view) => view.tabID === tabID,
      );
      if (!current) return;
      const next = (hostWindow as any).prompt?.(
        "Rename Citation Map view",
        current.title,
      );
      if (next === null || next === undefined) return;
      const normalized = String(next).trim();
      if (!normalized) return;
      try {
        renameCitationMapView(tabID, normalized, hostWindow);
      } catch (error) {
        report(error);
      }
    },
  };
}

export function registerMenus(): void {
  if (registeredMenuIDs.length) return;
  register({
    menuID: "citation-map-tools-menu",
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [toolsSubmenu()],
  });
  register({
    menuID: "citation-map-item-context-menu",
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [itemSubmenu()],
  });
  register({
    menuID: "citation-map-collection-context-menu",
    pluginID: config.addonID,
    target: "main/library/collection",
    menus: [collectionSubmenu()],
  });
  register({
    menuID: "citation-map-tab-context-menu",
    pluginID: config.addonID,
    target: "main/tab",
    menus: [tabRenameItem()],
  });
}

export function unregisterMenus(): void {
  const manager = (Zotero as any).MenuManager;
  for (const id of registeredMenuIDs.splice(0)) {
    try {
      manager?.unregisterMenu?.(id);
    } catch (error) {
      Zotero.debug(
        `Citation Map: failed to unregister menu ${id}: ${String(error)}`,
      );
    }
  }
}
