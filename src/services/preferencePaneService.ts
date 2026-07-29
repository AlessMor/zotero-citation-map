import { config } from "../../package.json";
import {
  cancelPendingCitationRequests,
  isCitationRequestCancellationRequested,
  resetCitationRequestCancellation,
} from "../providers/http";
import { clearOpenAlexProviderCache } from "../providers/openAlexProvider";
import { resetCitationProviderSessionState } from "../providers/registry";
import {
  clearCitationMetrics,
  getCitationCacheStatus,
} from "./citationMetricsStore";
import {
  getEnabledProviders,
  getShowMetricTooltipsEnabled,
  getUpdateLibraryIDs,
  setUpdateLibraryIDs,
} from "./citationPreferences";
import { getAvailableCitationLibraries } from "./citationLibraryService";
import { clearExternalWorkCache } from "./externalWorkCacheService";
import {
  installCitationColumnTooltips,
  refreshCitationColumns,
} from "./itemTreeColumnService";
import { refreshCitationItemPanes } from "./itemPaneService";
import {
  updateCitationDataForItems,
  waitForCitationUpdates,
} from "./citationUpdateService";
import { refreshOpenCitationMapViews } from "./windowService";

let registered = false;
const observerIDs: Array<string | symbol> = [];
let refreshAllRequestedGeneration = 0;
let refreshAllHandledGeneration = 0;
let refreshAllLoop: Promise<void> | null = null;

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function selectedUpdateLibraryIDs(): number[] {
  const available = new Set(
    getAvailableCitationLibraries().map((library) => library.libraryID),
  );
  return getUpdateLibraryIDs().filter((libraryID) => available.has(libraryID));
}

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

    resetCitationRequestCancellation();
    refreshAllHandledGeneration = requestedGeneration;
    for (const libraryID of selectedUpdateLibraryIDs()) {
      if (
        requestedGeneration !== refreshAllRequestedGeneration ||
        isCitationRequestCancellationRequested()
      ) {
        break;
      }
      const items = await regularItemsInLibrary(libraryID);
      if (!items.length) continue;
      await updateCitationDataForItems(items, {
        force: true,
        silent: false,
        includeRelationships: false,
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
  cancelPendingCitationRequests();
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
  return [
    ...new Set(
      value
        .map(positiveInteger)
        .filter((libraryID): libraryID is number => libraryID !== null),
    ),
  ];
}

function exposePreferenceActions(): void {
  Object.assign(addon.api, {
    refreshAll: restartWholeLibraryUpdate,
    clearAllCachedData: (): void => {
      void runPreferenceAction("clearing all cached data", clearAllCachedData);
    },
    // Retain the old API name for compatibility with an already-open
    // preferences pane during a development reload.
    clearCache: (): void => {
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
    // Compatibility aliases for a preference pane left open during reload.
    startupLibraries: (): ReturnType<typeof getAvailableCitationLibraries> =>
      getAvailableCitationLibraries(),
    startupLibraryIDs: (): number[] => getUpdateLibraryIDs(),
    setStartupLibraryIDs: (libraryIDs: unknown): void => {
      setUpdateLibraryIDs(normalizedLibraryIDs(libraryIDs));
    },
  });
}

export async function registerCitationMapPreferencePane(): Promise<void> {
  if (registered) return;
  exposePreferenceActions();
  getEnabledProviders();
  getUpdateLibraryIDs();
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
