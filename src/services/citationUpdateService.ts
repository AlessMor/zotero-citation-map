import { config } from "../../package.json";
import type {
  CitationMetricRecord,
  CitationProviderPreference,
  CitationUpdateBatchResult,
  ProviderLookupFailure,
} from "../domain/citationTypes";
import { lookupCitationMetrics } from "../providers/registry";
import { extractWorkIdentifiers } from "./citationIdentifiers";
import {
  getCitationMetricRecord,
  saveCitationMetricFailure,
  saveCitationMetricRecord,
  shouldRefreshCitationMetrics,
} from "./citationMetricsStore";
import {
  getAutomaticUpdatesEnabled,
  getCacheDays,
  getProviderLabel,
  getProviderPreference,
} from "./citationPreferences";
import { refreshCitationColumns } from "./itemTreeColumnService";

interface UpdateOptions {
  force?: boolean;
  silent?: boolean;
  provider?: CitationProviderPreference;
}

let operationTail: Promise<void> = Promise.resolve();
let notifierID: string | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
const pendingItemIDs = new Set<number>();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const previous = operationTail.catch(() => undefined);

  let release = (): void => undefined;
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });

  operationTail = previous.then(() => ticket);
  await previous;

  try {
    return await task();
  } finally {
    release();
  }
}

function getRegularItems(items: Zotero.Item[]): Zotero.Item[] {
  return items.filter(
    (item) => Boolean(item) && item.isRegularItem?.() && !item.deleted,
  );
}

async function getWholeLibraryItems(): Promise<Zotero.Item[]> {
  const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID);
  return getRegularItems(items as Zotero.Item[]);
}

function createProgressWindow(
  total: number,
  provider: CitationProviderPreference,
): any | null {
  try {
    const progressWindow = new ztoolkit.ProgressWindow(config.addonName);

    progressWindow.createLine({
      text: `Updating citation data with ${getProviderLabel(provider)} (0/${total})`,
      type: "default",
      progress: 0,
    });
    progressWindow.show();
    return progressWindow;
  } catch (error) {
    Zotero.debug(`Citation Map: could not open progress window: ${error}`);
    return null;
  }
}

function updateProgress(
  progressWindow: any | null,
  current: number,
  total: number,
  title: string,
): void {
  if (!progressWindow) {
    return;
  }

  progressWindow.changeLine?.({
    text: `Updating ${current}/${total}: ${title}`,
    type: "default",
    progress: Math.round((current / Math.max(total, 1)) * 100),
  });
  progressWindow.show?.();
}

function finishProgress(
  progressWindow: any | null,
  result: CitationUpdateBatchResult,
): void {
  if (!progressWindow) {
    return;
  }

  const text = [
    `${result.updated} updated`,
    `${result.cached} already current`,
    `${result.failed} failed`,
    `${result.skipped} skipped`,
  ].join(" · ");

  progressWindow.changeLine?.({
    text,
    type: result.failed > 0 ? "default" : "success",
    progress: 100,
  });
  progressWindow.show?.();
  progressWindow.startCloseTimer?.(5000);
}

function addDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function getNextRetryAt(
  failure: ProviderLookupFailure,
  previousFailureCount: number,
): string | null {
  const now = new Date();

  switch (failure.status) {
    case "no-identifier":
      return addDays(now, 30);

    case "not-found": {
      const delays = [7, 30, 90, 180];
      return addDays(
        now,
        delays[Math.min(previousFailureCount, delays.length - 1)],
      );
    }

    case "rate-limited":
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    case "network-error":
      return new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString();

    case "provider-error":
      return addDays(now, 1);
  }
}

async function updateOneItem(
  item: Zotero.Item,
  preference: CitationProviderPreference,
  force: boolean,
): Promise<"updated" | "cached" | "failed" | "skipped"> {
  const libraryID = Number(item.libraryID);
  const itemKey = String(item.key);

  if (
    !force &&
    !shouldRefreshCitationMetrics(
      libraryID,
      itemKey,
      preference,
      getCacheDays(),
    )
  ) {
    return "cached";
  }

  const identifiers = extractWorkIdentifiers(item);
  const result = await lookupCitationMetrics(preference, identifiers);

  if (result.status !== "success") {
    const existing = getCitationMetricRecord(libraryID, itemKey);

    await saveCitationMetricFailure(
      libraryID,
      itemKey,
      result.provider,
      result.status,
      result.message,
      getNextRetryAt(result, existing?.failureCount ?? 0),
    );

    Zotero.debug(
      `Citation Map: ${itemKey} failed via ${result.provider}: ${result.status} (${result.message})`,
    );
    return "failed";
  }

  const now = new Date().toISOString();
  const record: CitationMetricRecord = {
    libraryID,
    itemKey,
    provider: result.provider,
    providerWorkID: result.providerWorkID,
    matchedBy: result.matchedBy,
    doi: result.doi ?? identifiers.doi,
    title: result.title ?? identifiers.title,
    year: result.year ?? identifiers.year,
    authors: result.authors.length > 0 ? result.authors : identifiers.authors,
    citationCount: result.citationCount,
    citationCountProvider: result.citationCountProvider,
    referenceCount: result.referenceCount,
    referenceCountProvider: result.referenceCountProvider,
    resolvedReferenceCount: result.resolvedReferenceCount,
    references: result.references,
    status: "success",
    fetchedAt: now,
    lastAttemptAt: now,
    errorMessage: null,
    failureCount: 0,
    nextRetryAt: null,
  };

  await saveCitationMetricRecord(record);
  return "updated";
}

export function updateCitationMetricsForItems(
  items: Zotero.Item[],
  options: UpdateOptions = {},
): Promise<CitationUpdateBatchResult> {
  return runSerialized(async () => {
    const regularItems = getRegularItems(items);
    const preference = options.provider ?? getProviderPreference();
    const result: CitationUpdateBatchResult = {
      total: regularItems.length,
      updated: 0,
      cached: 0,
      failed: 0,
      skipped: items.length - regularItems.length,
    };

    if (regularItems.length === 0) {
      return result;
    }

    const progressWindow = options.silent
      ? null
      : createProgressWindow(regularItems.length, preference);

    for (let index = 0; index < regularItems.length; index += 1) {
      const item = regularItems[index];
      const title = String(
        item.getDisplayTitle?.() ?? item.getField("title") ?? item.key,
      );

      updateProgress(progressWindow, index + 1, regularItems.length, title);

      try {
        const status = await updateOneItem(
          item,
          preference,
          Boolean(options.force),
        );
        result[status] += 1;
      } catch (error) {
        result.failed += 1;
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }

      if ((index + 1) % 20 === 0) {
        refreshCitationColumns();
        await delay(0);
      }
    }

    refreshCitationColumns();
    finishProgress(progressWindow, result);
    return result;
  });
}

export async function updateCitationMetricsForLibrary(
  options: UpdateOptions = {},
): Promise<CitationUpdateBatchResult> {
  const items = await getWholeLibraryItems();
  return updateCitationMetricsForItems(items, options);
}

async function flushPendingItemUpdates(): Promise<void> {
  pendingTimer = null;

  if (!getAutomaticUpdatesEnabled() || pendingItemIDs.size === 0) {
    pendingItemIDs.clear();
    return;
  }

  const ids = [...pendingItemIDs];
  pendingItemIDs.clear();

  const items = ids
    .map((id) => Zotero.Items.get(id))
    .filter((item): item is Zotero.Item => Boolean(item));

  await updateCitationMetricsForItems(items, {
    force: true,
    silent: true,
  });
}

function queueChangedItems(ids: Array<number | string>): void {
  for (const id of ids) {
    const itemID = Number(id);
    if (Number.isFinite(itemID)) {
      pendingItemIDs.add(itemID);
    }
  }

  if (pendingTimer) {
    clearTimeout(pendingTimer);
  }

  pendingTimer = setTimeout(() => {
    void flushPendingItemUpdates();
  }, 2500);
}

export function scheduleAutomaticLibraryUpdate(delayMilliseconds = 500): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
  }

  startupTimer = setTimeout(() => {
    startupTimer = null;

    if (!getAutomaticUpdatesEnabled()) {
      return;
    }

    void updateCitationMetricsForLibrary({
      force: false,
      silent: true,
    }).catch((error: unknown) => {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }, delayMilliseconds);
}

export function registerAutomaticCitationUpdates(): void {
  if (notifierID) {
    return;
  }

  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: (event: string, type: string, ids: Array<number | string>) => {
        if (
          type === "item" &&
          (event === "add" || event === "modify") &&
          getAutomaticUpdatesEnabled()
        ) {
          queueChangedItems(ids);
        }
      },
    },
    ["item"],
    "citation-map-metrics",
  );

  scheduleAutomaticLibraryUpdate(8000);
}

export async function waitForCitationUpdates(): Promise<void> {
  await operationTail.catch(() => undefined);
}

export function unregisterAutomaticCitationUpdates(): void {
  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = null;
  }

  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }

  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  pendingItemIDs.clear();
}
