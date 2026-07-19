import { config } from "../../package.json";
import {
  clearCitationMetrics,
  getCitationCacheStatus,
} from "./citationMetricsStore";
import { getAutomaticUpdatesEnabled } from "./citationPreferences";
import { refreshCitationColumns } from "./itemTreeColumnService";
import { refreshCitationItemPanes } from "./itemPaneService";
import { updateWholeLibraryCitationData } from "./citationUpdateService";
import { refreshOpenCitationMapViews } from "./windowService";

let registered = false;
const observerIDs: Array<string | symbol> = [];

function exposePreferenceActions(): void {
  Object.assign(addon.api, {
    refreshAll: async (): Promise<void> => {
      await updateWholeLibraryCitationData({ force: true, silent: false });
    },
    clearCache: async (): Promise<void> => {
      await clearCitationMetrics();
      refreshCitationColumns();
      refreshCitationItemPanes();
      await refreshOpenCitationMapViews();
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
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/network.svg`,
  });
  for (const name of ["automaticUpdates", "provider", "cacheDays"]) {
    observerIDs.push(
      Zotero.Prefs.registerObserver(
        `${config.prefsPrefix}.${name}`,
        () => {
          if (getAutomaticUpdatesEnabled()) {
            // The normal serialized update path and cache checks prevent an
            // observer change from starting competing requests.
            void updateWholeLibraryCitationData({ silent: true });
          }
        },
        true,
      ),
    );
  }
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
