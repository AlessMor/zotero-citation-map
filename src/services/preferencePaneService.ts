import { config } from "../../package.json";
import { uniquePositiveIntegers } from "../domain/valueNormalization";
import { clearOpenAlexProviderCache } from "../providers/openAlexProvider";
import { resetCitationProviderSessionState } from "../providers/registry";
import {
  clearCitationMetrics,
  getCitationCacheStatus,
} from "./citationMetricsStore";
import {
  getShowMetricTooltipsEnabled,
  getUpdateLibraryIDs,
  normalizeCitationPreferences,
  setUpdateLibraryIDs,
} from "./citationPreferences";
import {
  getAvailableCitationLibraries,
  getSelectedCitationUpdateLibraryIDs,
} from "./citationLibraryService";
import { clearExternalWorkCache } from "./externalWorkCacheService";
import {
  installCitationColumnTooltips,
  refreshCitationColumns,
} from "./itemTreeColumnService";
import { refreshCitationItemPanes } from "./itemPaneService";
import {
  cancelActiveCitationUpdate,
  updateCitationDataForItems,
  waitForCitationUpdates,
} from "./citationUpdateService";
import { refreshOpenCitationMapViews } from "./windowService";

let registered = false;
const observerIDs: Array<string | symbol> = [];
let refreshAllRequestedGeneration = 0;
let refreshAllHandledGeneration = 0;
let refreshAllLoop: Promise<void> | null = null;

async function regularItemsInLibrary(
  libraryID: number,
): Promise<Zotero.Item[]> {
  const items = (await Zotero.Items.getAll(libraryID)) as Zotero.Item[];
  return items.filter((item) => item?.isRegularItem?.() && !item.deleted);
}

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

async function clearAllCachedData(): Promise<void> {
  await Promise.all([clearCitationMetrics(), clearExternalWorkCache()]);
  clearOpenAlexProviderCache();
  resetCitationProviderSessionState();
  refreshCitationColumns();
  refreshCitationItemPanes();
  await refreshOpenCitationMapViews();
}

async function runRefreshAllLoop(): Promise<void> {
  while (refreshAllHandledGeneration < refreshAllRequestedGeneration) {
    const requestedGeneration = refreshAllRequestedGeneration;
    const drained = await waitForCitationUpdates(5000);
    if (!drained || requestedGeneration !== refreshAllRequestedGeneration) {
      continue;
    }

    refreshAllHandledGeneration = requestedGeneration;
    for (const libraryID of getSelectedCitationUpdateLibraryIDs()) {
      if (requestedGeneration !== refreshAllRequestedGeneration) {
        break;
      }
      const items = await regularItemsInLibrary(libraryID);
      if (!items.length) continue;
      await updateCitationDataForItems(items, {
        force: true,
        silent: false,
      });
    }
  }
}

function ensureRefreshAllLoop(): void {
  if (refreshAllLoop) return;
  const running = runPreferenceAction(
    "updating fields for selected libraries",
    runRefreshAllLoop,
  );
  refreshAllLoop = running.finally(() => {
    refreshAllLoop = null;
    if (refreshAllHandledGeneration < refreshAllRequestedGeneration) {
      ensureRefreshAllLoop();
    }
  });
}

function restartWholeLibraryUpdate(): void {
  refreshAllRequestedGeneration += 1;
  // A repeated click replaces the active request rather than adding another
  // serialized whole-library job behind it.
  cancelActiveCitationUpdate();
  ensureRefreshAllLoop();
}

function refreshProviderConfiguration(): void {
  clearOpenAlexProviderCache();
  resetCitationProviderSessionState();
  refreshCitationColumns();
  refreshCitationItemPanes();
  void refreshOpenCitationMapViews().catch((error: unknown) => {
    Zotero.logError(
      preferenceError("refresh after provider configuration change", error),
    );
  });
}

function syncMetricTooltipPreference(): void {
  const enabled = getShowMetricTooltipsEnabled();
  for (const win of Zotero.getMainWindows()) {
    installCitationColumnTooltips(win);
    win.document.documentElement.dataset.citationMapTooltips = enabled
      ? "enabled"
      : "disabled";
  }
  refreshCitationColumns();
}

function normalizedLibraryIDs(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return uniquePositiveIntegers(value);
}

function exposePreferenceActions(): void {
  addon.setAPI({
    refreshAll: restartWholeLibraryUpdate,
    clearAllCachedData: (): void => {
      void runPreferenceAction("clearing all cached data", clearAllCachedData);
    },
    providerSelectionChanged: (): void => refreshProviderConfiguration(),
    openOpenAlexAccount: (): void => Zotero.launchURL("https://openalex.org/"),
    cacheStatus: (): ReturnType<typeof getCitationCacheStatus> =>
      getCitationCacheStatus(),
    updateLibraries: (): ReturnType<typeof getAvailableCitationLibraries> =>
      getAvailableCitationLibraries(),
    updateLibraryIDs: (): number[] => getUpdateLibraryIDs(),
    setUpdateLibraryIDs: (libraryIDs: unknown): void => {
      setUpdateLibraryIDs(normalizedLibraryIDs(libraryIDs));
    },
  });
}

export async function registerCitationMapPreferencePane(): Promise<void> {
  if (registered) return;
  exposePreferenceActions();
  normalizeCitationPreferences();
  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    id: `${config.addonRef}-preferences`,
    src: rootURI + "content/preferences.xhtml",
    scripts: [rootURI + "content/preferences.js"],
    label: "Citation Map",
    image: `chrome://${config.addonRef}/content/icons/network.svg`,
  } as any);
  observerIDs.push(
    Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.showMetricTooltips`,
      syncMetricTooltipPreference,
      true,
    ),
    Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.provider`,
      refreshProviderConfiguration,
      true,
    ),
    Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.openAlexAPIKey`,
      refreshProviderConfiguration,
      true,
    ),
    Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.semanticScholarAPIKey`,
      refreshProviderConfiguration,
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
