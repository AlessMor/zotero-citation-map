import { config } from "../../package.json";
import { resetCitationRequestCancellation } from "../providers/http";
import { updateCitationDataForItems } from "./citationUpdateService";
import {
  openCitationMapAndSelectItem,
  openCitationMapWindow,
} from "./windowService";

const registeredMenuIDs: string[] = [];
const ICON = `chrome://${config.addonRef}/content/icons/network.svg`;

function register(definition: Record<string, unknown>): void {
  const manager = (Zotero as any).MenuManager;
  if (!manager?.registerMenu) {
    throw new Error("Zotero.MenuManager is unavailable. Zotero 9 is required.");
  }
  const id = manager.registerMenu(definition);
  if (id) registeredMenuIDs.push(id);
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function activeLibraryID(): number {
  const pane = Zotero.getActiveZoteroPane?.() as any;
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
  const selected = Zotero.getActiveZoteroPane?.()?.getSelectedItems?.() ?? [];
  return (contextual.length ? contextual : selected).filter(
    (item: Zotero.Item) => item?.isRegularItem?.() && !item.deleted,
  );
}

async function activeLibraryRegularItems(): Promise<Zotero.Item[]> {
  const items = (await Zotero.Items.getAll(activeLibraryID())) as Zotero.Item[];
  return items.filter((item) => item?.isRegularItem?.() && !item.deleted);
}

function report(error: unknown): void {
  Zotero.logError(error instanceof Error ? error : new Error(String(error)));
}

function beginManualUpdate(): void {
  resetCitationRequestCancellation();
}

function activeUpdateProgressRoot(): HTMLElement | null {
  for (const win of Zotero.getMainWindows()) {
    const root = win.document.querySelector(
      ".citation-map-progress-window",
    ) as HTMLElement | null;
    const progress = root?.querySelector(
      "progress",
    ) as HTMLProgressElement | null;
    if (!root || !progress) continue;
    if (!progress.hasAttribute("value") || progress.value < progress.max) {
      return root;
    }
  }
  return null;
}

function showUpdateProgress(): void {
  const root = activeUpdateProgressRoot();
  if (!root) return;
  const buttons = root.querySelectorAll("button");
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons.item(index) as HTMLButtonElement | null;
    if (button?.textContent?.trim() !== "▲") continue;
    button.click();
    break;
  }
  root.ownerDocument.defaultView?.focus();
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

export function registerMenus(): void {
  if (registeredMenuIDs.length) return;
  register({
    menuID: "citation-map-tools-menu",
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "submenu",
        l10nID: `${config.addonRef}-tools-submenu`,
        icon: ICON,
        menus: [
          {
            menuType: "menuitem",
            l10nID: `${config.addonRef}-open-command`,
            icon: ICON,
            onCommand: () => void openCitationMapWindow().catch(report),
          },
          {
            menuType: "menuitem",
            l10nID: `${config.addonRef}-update-library-command`,
            onCommand: () => {
              beginManualUpdate();
              void activeLibraryRegularItems()
                .then((items) =>
                  updateCitationDataForItems(items, {
                    force: true,
                    silent: false,
                    includeRelationships: false,
                  }),
                )
                .catch(report);
            },
          },
          {
            menuType: "menuitem",
            l10nID: `${config.addonRef}-show-update-progress-command`,
            onShowing: (_event: Event, context: any) => {
              const active = activeUpdateProgressRoot() !== null;
              context.setVisible(active);
              context.setEnabled(active);
            },
            onCommand: showUpdateProgress,
          },
          {
            menuType: "menuitem",
            l10nID: `${config.addonRef}-settings-command`,
            onCommand: () => {
              try {
                openCitationMapSettings();
              } catch (error) {
                report(error);
              }
            },
          },
        ],
      },
    ],
  });
  register({
    menuID: "citation-map-item-context-menu",
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-update-items-command`,
        icon: ICON,
        onShowing: (_event: Event, context: any) => {
          const items = selectedRegularItems(context);
          context.setVisible(items.length > 0);
          context.setEnabled(items.length > 0);
        },
        onCommand: (_event: Event, context: any) => {
          const items = selectedRegularItems(context);
          if (items.length) {
            beginManualUpdate();
            void updateCitationDataForItems(items, {
              force: true,
              silent: false,
              includeRelationships: items.length === 1,
            }).catch(report);
          }
        },
      },
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-show-items-command`,
        icon: ICON,
        onShowing: (_event: Event, context: any) => {
          const items = selectedRegularItems(context);
          context.setVisible(items.length === 1);
          context.setEnabled(items.length === 1);
        },
        onCommand: (_event: Event, context: any) => {
          const items = selectedRegularItems(context);
          if (items.length === 1) {
            void openCitationMapAndSelectItem(Number(items[0].id)).catch(
              report,
            );
          }
        },
      },
    ],
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
