import { config } from "../../package.json";
import {
  updateCitationMetricsForItems,
  updateCitationMetricsForLibrary,
} from "./citationUpdateService";
import { openCitationMapWindow } from "./windowService";

const registeredMenuIDs: string[] = [];
const NETWORK_ICON = `chrome://${config.addonRef}/content/icons/network.svg`;

function getLocalizationID(key: string): string {
  return `${config.addonRef}-${key}`;
}

function getRegularItems(context: any): Zotero.Item[] {
  const contextItems = Array.isArray(context?.items) ? context.items : [];
  const selectedItems =
    Zotero.getActiveZoteroPane?.()?.getSelectedItems?.() ?? [];
  const items = contextItems.length > 0 ? contextItems : selectedItems;

  return items.filter((item: Zotero.Item) => item?.isRegularItem?.());
}

function registerMenu(definition: Record<string, unknown>): void {
  const menuManager = (Zotero as any).MenuManager;

  if (!menuManager?.registerMenu) {
    throw new Error("Zotero.MenuManager is unavailable. Zotero 9 is required.");
  }

  const registeredID = menuManager.registerMenu(definition);

  if (registeredID) {
    registeredMenuIDs.push(registeredID);
  }
}

function logCommandError(error: unknown): void {
  Zotero.logError(error instanceof Error ? error : new Error(String(error)));
}

export function registerMenus(): void {
  if (registeredMenuIDs.length > 0) {
    return;
  }

  registerMenu({
    menuID: "citation-map-tools-menu",
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "submenu",
        l10nID: getLocalizationID("tools-submenu"),
        icon: NETWORK_ICON,
        menus: [
          {
            menuType: "menuitem",
            l10nID: getLocalizationID("open-command"),
            icon: NETWORK_ICON,
            onCommand: () => {
              void openCitationMapWindow().catch(logCommandError);
            },
          },
          {
            menuType: "menuitem",
            l10nID: getLocalizationID("update-library-command"),
            icon: NETWORK_ICON,
            onCommand: () => {
              void updateCitationMetricsForLibrary({
                force: true,
                silent: false,
              }).catch(logCommandError);
            },
          },
        ],
      },
    ],
  });

  registerMenu({
    menuID: "citation-map-item-context-menu",
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocalizationID("update-items-command"),
        icon: NETWORK_ICON,
        onShowing: (_event: Event, context: any) => {
          const items = getRegularItems(context);
          context.setVisible(items.length > 0);
          context.setEnabled(items.length > 0);
        },
        onCommand: (_event: Event, context: any) => {
          const items = getRegularItems(context);

          if (items.length > 0) {
            void updateCitationMetricsForItems(items, {
              force: true,
              silent: false,
            }).catch(logCommandError);
          }
        },
      },
    ],
  });
}

export function unregisterMenus(): void {
  const menuManager = (Zotero as any).MenuManager;

  if (!menuManager?.unregisterMenu) {
    registeredMenuIDs.length = 0;
    return;
  }

  for (const registeredID of registeredMenuIDs) {
    try {
      menuManager.unregisterMenu(registeredID);
    } catch (error) {
      Zotero.debug(
        `Citation Map: failed to unregister menu ${registeredID}: ${error}`,
      );
    }
  }

  registeredMenuIDs.length = 0;
}
