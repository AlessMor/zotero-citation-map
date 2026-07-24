import { config } from "../../package.json";
import {
  updateCitationDataForItems,
  updateWholeLibraryCitationData,
} from "./citationUpdateService";
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

function selectedRegularItems(context: any): Zotero.Item[] {
  const contextual = Array.isArray(context?.items) ? context.items : [];
  const selected = Zotero.getActiveZoteroPane?.()?.getSelectedItems?.() ?? [];
  return (contextual.length ? contextual : selected).filter(
    (item: Zotero.Item) => item?.isRegularItem?.() && !item.deleted,
  );
}

function report(error: unknown): void {
  Zotero.logError(error instanceof Error ? error : new Error(String(error)));
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
            icon: ICON,
            onCommand: () =>
              void updateWholeLibraryCitationData({
                force: true,
                silent: false,
                includeRelationships: false,
              }).catch(report),
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
