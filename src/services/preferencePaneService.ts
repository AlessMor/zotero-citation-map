import { config } from "../../package.json";
import {
  clearCitationMetrics,
  getCitationCacheStatus,
} from "./citationMetricsStore";
import { getAutomaticUpdatesEnabled } from "./citationPreferences";
import { clearExternalWorkCache } from "./externalWorkCacheService";
import { refreshCitationColumns } from "./itemTreeColumnService";
import { refreshCitationItemPanes } from "./itemPaneService";
import { updateWholeLibraryCitationData } from "./citationUpdateService";
import { refreshOpenCitationMapViews } from "./windowService";

let registered = false;
const observerIDs: Array<string | symbol> = [];

function preferenceError(context: string, error: unknown): Error {
  if (error instanceof Error) return error;
  const detail = error === undefined ? "undefined rejection" : String(error);
  return new Error(`Citation Map: ${context} failed (${detail})`);
}

async function runPreferenceAction(
  context: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    Zotero.logError(preferenceError(context, error));
  }
}

function exposePreferenceActions(): void {
  Object.assign(addon.api, {
    refreshAll: (): void => {
      void runPreferenceAction("refreshing stale items", async () => {
        await updateWholeLibraryCitationData({
          force: false,
          silent: false,
        });
      });
    },
    clearCache: (): void => {
      void runPreferenceAction("clearing the citation cache", async () => {
        await Promise.all([clearCitationMetrics(), clearExternalWorkCache()]);
        refreshCitationColumns();
        refreshCitationItemPanes();
        await refreshOpenCitationMapViews();
      });
    },
    cacheStatus: (): ReturnType<typeof getCitationCacheStatus> =>
      getCitationCacheStatus(),
  });
}

export async function registerCitationMapPreferencePane(): Promise<void> {
  if (registered) return;
  exposePreferenceActions();
  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: "Citation Map",
    image: `chrome://${config.addonRef}/content/icons/network.svg`,
  });
  observerIDs.push(
    Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.automaticUpdates`,
      () => {
        if (getAutomaticUpdatesEnabled()) {
          void runPreferenceAction(
            "refresh after enabling automatic updates",
            async () => {
              await updateWholeLibraryCitationData({ silent: true });
            },
          );
        }
      },
      true,
    ),
  );
  registered = true;
}

export function unregisterCitationMapPreferenceObservers(): void {
  for (const id of observerIDs.splice(0)) {
    try {
      Zotero.Prefs.unregisterObserver(id as any);
    } catch {
      // Observer may already be removed during shutdown.
    }
  }
  registered = false;
}
