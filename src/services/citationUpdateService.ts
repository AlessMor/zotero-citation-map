import type {
  CitationMetricRecord,
  CitationProviderPreference,
  CitationUpdateBatchResult,
  ProviderLookupFailure,
} from "../domain/citationTypes";
import { lookupCitationMetrics } from "../providers/registry";
import {
  cancelPendingCitationRequests,
  isCitationRequestCancellationRequested,
  resetCitationRequestCancellation,
} from "../providers/http";
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
  getExactTitleFallbackEnabled,
  getProviderLabel,
  getProviderPreference,
  getUpdateNewItemsEnabled,
} from "./citationPreferences";
import {
  refreshExternalRelationships,
  storeExternalRelationshipSnapshot,
} from "./externalDiscoveryService";
import { refreshCitationColumns } from "./itemTreeColumnService";
import { mergeRelatedWorkLists } from "./relationshipStoreService";
import { createMetricNodeForItem } from "./itemMetricContext";
import { refreshCitationItemPanes } from "./itemPaneService";
import { refreshOpenCitationMapViews } from "./windowService";
import {
  closeAllUpdateProgress,
  createUpdateProgress,
  type UpdateProgressHandle,
} from "./updateProgressService";

interface UpdateOptions {
  force?: boolean;
  silent?: boolean;
  provider?: CitationProviderPreference;
  /** Fetch complete cited-by/reference lists. Defaults to true for a single
   * item and false for multi-item batches. */
  includeRelationships?: boolean;
  /** Document in which the modeless progress window should be shown. */
  progressDocument?: Document;
}

type UpdateOutcome = "updated" | "cached" | "failed" | "skipped";

const ITEM_UPDATE_CONCURRENCY = 2;
const BATCH_ITEM_DEADLINE_MS = 45000;
const SINGLE_ITEM_DEADLINE_MS = 120000;
const VIEW_REFRESH_DEADLINE_MS = 5000;
const SHUTDOWN_WAIT_TIMEOUT_MS = 5000;

let operationTail: Promise<void> = Promise.resolve();
let operationBusy = false;
let notifierID: string | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
const pendingItemIDs = new Set<number>();

function backgroundError(context: string, error: unknown): Error {
  if (error instanceof Error) return error;
  const detail = error === undefined ? "undefined rejection" : String(error);
  return new Error(`Citation Map: ${context} failed (${detail})`);
}

function runBackgroundUpdate(
  context: string,
  operation: Promise<unknown>,
): void {
  void operation.catch((error: unknown) => {
    Zotero.logError(backgroundError(context, error));
  });
}

function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const previous = operationTail.catch(() => undefined);
  let release = (): void => undefined;
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });
  operationTail = previous.then(() => ticket);
  return previous
    .then(async () => {
      operationBusy = true;
      return task();
    })
    .finally(() => {
      operationBusy = false;
      release();
    });
}

function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `${label} timed out after ${Math.round(milliseconds / 1000)} seconds`,
        ),
      );
    }, milliseconds);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function refreshViewsAfterUpdate(refreshGraph: boolean): void {
  try {
    refreshCitationColumns();
  } catch (error) {
    Zotero.debug(`Citation Map: column refresh failed: ${String(error)}`);
  }
  try {
    refreshCitationItemPanes();
  } catch (error) {
    Zotero.debug(`Citation Map: item-pane refresh failed: ${String(error)}`);
  }
  if (!refreshGraph) return;
  void withDeadline(
    refreshOpenCitationMapViews(),
    VIEW_REFRESH_DEADLINE_MS,
    "Graph view refresh",
  ).catch((error: unknown) => {
    Zotero.debug(`Citation Map: graph view refresh deferred: ${String(error)}`);
  });
}

function regularItems(items: Zotero.Item[]): Zotero.Item[] {
  return items.filter(
    (item) => Boolean(item) && item.isRegularItem?.() && !item.deleted,
  );
}

async function wholeLibraryItems(): Promise<Zotero.Item[]> {
  return regularItems(
    (await Zotero.Items.getAll(
      Zotero.Libraries.userLibraryID,
    )) as Zotero.Item[],
  );
}

function itemNeedsRefresh(
  item: Zotero.Item,
  provider: CitationProviderPreference,
): boolean {
  return shouldRefreshCitationMetrics(
    Number(item.libraryID),
    String(item.key),
    provider,
    getCacheDays(),
  );
}

function createProgress(
  total: number,
  provider: CitationProviderPreference,
  document?: Document,
): UpdateProgressHandle {
  return createUpdateProgress({
    document,
    title: "Updating citation data",
    message: `Preparing ${total} paper${total === 1 ? "" : "s"} with ${getProviderLabel(provider)}`,
    total,
  });
}

function updateProgress(
  progress: UpdateProgressHandle | null,
  completed: number,
  started: number,
  total: number,
  title: string,
): void {
  if (!progress || shuttingDown) return;
  const active = Math.max(0, started - completed);
  progress.setProgress(
    completed,
    total,
    `Updating ${completed}/${total} complete${active ? ` · ${active} active` : ""}: ${title}`,
  );
}

function finishProgress(
  progress: UpdateProgressHandle | null,
  result: CitationUpdateBatchResult,
): void {
  if (!progress || shuttingDown) return;
  progress.finish(
    `${result.updated} updated · ${result.cached} current · ${result.failed} failed · ${result.skipped} skipped`,
  );
}

function nextRetryAt(
  failure: ProviderLookupFailure,
  previousFailureCount: number,
): string | null {
  const now = Date.now();
  const day = 86400000;
  switch (failure.status) {
    case "no-identifier":
      return new Date(now + 30 * day).toISOString();
    case "ambiguous-match":
      return null;
    case "not-found": {
      const delays = [7, 30, 90, 180];
      return new Date(
        now + delays[Math.min(previousFailureCount, delays.length - 1)] * day,
      ).toISOString();
    }
    case "rate-limited":
      return new Date(now + 60 * 60 * 1000).toISOString();
    case "network-error":
      return new Date(now + 6 * 60 * 60 * 1000).toISOString();
    case "provider-error":
      return new Date(now + day).toISOString();
  }
}

async function updateOneItem(
  item: Zotero.Item,
  preference: CitationProviderPreference,
  force: boolean,
  includeRelationships: boolean,
  includeOptionalEnrichment: boolean,
): Promise<UpdateOutcome> {
  if (shuttingDown || isCitationRequestCancellationRequested()) {
    return "skipped";
  }
  const libraryID = Number(item.libraryID);
  const itemKey = String(item.key);
  if (!force && !itemNeedsRefresh(item, preference)) return "cached";

  const previous = getCitationMetricRecord(libraryID, itemKey);
  const extracted = extractWorkIdentifiers(item);
  // A user-confirmed fallback match may supply a DOI that is intentionally
  // kept in Citation Map's private cache rather than written into the Zotero
  // item. Reuse it for future refreshes.
  const identifiers = {
    ...extracted,
    doi: extracted.doi ?? (previous?.matchConfirmed ? previous.doi : null),
  };
  const result = await lookupCitationMetrics(
    preference,
    identifiers,
    getExactTitleFallbackEnabled(),
    includeOptionalEnrichment,
  );
  if (shuttingDown || isCitationRequestCancellationRequested()) {
    return "skipped";
  }
  if (result.status !== "success") {
    await saveCitationMetricFailure(
      libraryID,
      itemKey,
      result.provider,
      result.status,
      result.message,
      nextRetryAt(result, previous?.failureCount ?? 0),
      result.candidates ?? [],
    );
    return "failed";
  }
  const now = new Date().toISOString();
  // DOI and unique non-contradictory exact-title matches are accepted
  // automatically. Exact fallback identifiers remain visible as provisional
  // until the user confirms them in the item pane.
  const sameConfirmedIdentity = Boolean(
    previous?.matchConfirmed &&
    ((previous.providerWorkID &&
      previous.providerWorkID === result.providerWorkID) ||
      (previous.doi && previous.doi === result.doi)),
  );
  const matchConfirmed =
    result.matchedBy === "doi" ||
    result.matchedBy === "title" ||
    sameConfirmedIdentity;
  const mergedReferences = mergeRelatedWorkLists(
    previous?.references ?? [],
    result.references,
  );
  const record: CitationMetricRecord = {
    libraryID,
    itemKey,
    provider: result.provider,
    providerWorkID: result.providerWorkID,
    matchedBy: result.matchedBy,
    matchConfidence: result.matchConfidence,
    matchConfirmed,
    doi: result.doi ?? identifiers.doi,
    title: result.title ?? identifiers.title,
    normalizedTitle: identifiers.normalizedTitle,
    year: result.year ?? identifiers.year,
    authors: result.authors.length ? result.authors : identifiers.authors,
    sourceTitle: result.sourceTitle ?? identifiers.sourceTitle,
    abstract: result.abstract,
    citationCount: result.citationCount,
    citationCountProvider: result.citationCountProvider,
    referenceCount: result.referenceCount,
    referenceCountProvider: result.referenceCountProvider,
    resolvedReferenceCount: Math.max(
      previous?.resolvedReferenceCount ?? 0,
      result.resolvedReferenceCount,
      mergedReferences.length,
    ),
    references: mergedReferences,
    matchCandidates: [],
    fwci: result.fwci ?? null,
    citationPercentile: result.citationPercentile ?? null,
    isTop1Percent: result.isTop1Percent ?? null,
    isTop10Percent: result.isTop10Percent ?? null,
    citationCountsByYear: result.citationCountsByYear ?? [],
    citationsLastYear: result.citationsLastYear ?? null,
    citationVelocity: result.citationVelocity ?? null,
    citationAcceleration: result.citationAcceleration ?? null,
    influentialCitationCount: result.influentialCitationCount ?? null,
    isRetracted: result.isRetracted ?? null,
    openAccessStatus: result.openAccessStatus ?? null,
    isOpenAccess: result.isOpenAccess ?? null,
    publicationType: result.publicationType ?? null,
    sourceMetrics: result.sourceMetrics ?? null,
    status: "success",
    fetchedAt: now,
    lastAttemptAt: now,
    errorMessage: null,
    failureCount: 0,
    nextRetryAt: null,
  };
  await saveCitationMetricRecord(record);

  // The references embedded in the metric response are cheap to persist and
  // are merged immediately. Complete paginated relationship hydration is
  // optional so a multi-item count update cannot remain at 0/N while waiting
  // for hundreds of relationship requests.
  try {
    const node = createMetricNodeForItem(item);
    await storeExternalRelationshipSnapshot(
      node,
      "references",
      record.references,
    );
    if (includeRelationships) {
      await refreshExternalRelationships(node, [node], "references");
      if ((record.citationCount ?? 0) > 0) {
        await refreshExternalRelationships(node, [node], "cited-by");
      } else {
        await storeExternalRelationshipSnapshot(node, "cited-by", []);
      }
    }
  } catch (error) {
    Zotero.debug(
      "Citation Map: relationship refresh failed for " +
        `${itemKey}: ${String(error)}`,
    );
  }
  return "updated";
}

async function runUpdate(
  items: Zotero.Item[],
  options: UpdateOptions = {},
): Promise<CitationUpdateBatchResult> {
  const selected = regularItems(items);
  const provider = options.provider ?? getProviderPreference();
  const force = Boolean(options.force);
  const includeRelationships =
    options.includeRelationships ?? selected.length === 1;
  // Optional provider enrichment is valuable for direct single-paper refreshes
  // but makes Ctrl+A batches substantially slower and less predictable.
  const includeOptionalEnrichment = force && selected.length <= 3;
  const result: CitationUpdateBatchResult = {
    total: selected.length,
    updated: 0,
    cached: 0,
    failed: 0,
    skipped: 0,
  };

  if (shuttingDown || isCitationRequestCancellationRequested()) {
    result.skipped = selected.length;
    return result;
  }

  const pending = force
    ? selected
    : selected.filter((item) => itemNeedsRefresh(item, provider));
  result.cached = selected.length - pending.length;
  const progress = options.silent
    ? null
    : createProgress(pending.length, provider, options.progressDocument);

  let nextIndex = 0;
  let started = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (!shuttingDown && !isCitationRequestCancellationRequested()) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= pending.length) return;
      const item = pending[index];
      started += 1;
      updateProgress(
        progress,
        completed,
        started,
        pending.length,
        String(item.getField("title") ?? "Untitled"),
      );
      // Let Zotero paint the modeless progress window before provider work starts.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      let outcome: UpdateOutcome;
      try {
        const deadline =
          pending.length === 1
            ? SINGLE_ITEM_DEADLINE_MS
            : BATCH_ITEM_DEADLINE_MS;
        outcome = await withDeadline(
          updateOneItem(
            item,
            provider,
            force,
            includeRelationships,
            includeOptionalEnrichment,
          ),
          deadline,
          `Citation update for ${String(item.getField("title") ?? item.key)}`,
        );
      } catch (error) {
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
        outcome = shuttingDown ? "skipped" : "failed";
      }
      result[outcome] += 1;
      completed += 1;
      updateProgress(
        progress,
        completed,
        started,
        pending.length,
        String(item.getField("title") ?? "Untitled"),
      );
    }
  };

  try {
    await Promise.all(
      Array.from(
        { length: Math.min(ITEM_UPDATE_CONCURRENCY, pending.length) },
        () => worker(),
      ),
    );
  } finally {
    const accounted =
      result.updated + result.cached + result.failed + result.skipped;
    if (accounted < selected.length) {
      result.skipped += selected.length - accounted;
    }

    if (!shuttingDown && !isCitationRequestCancellationRequested()) {
      // Finish the user-visible operation before refreshing secondary views. A
      // graph-tab lifecycle problem must never leave citation progress stuck.
      finishProgress(progress, result);
      refreshViewsAfterUpdate(selected.length <= 3);
    } else {
      progress?.dismiss();
    }
  }
  return result;
}

export function updateCitationDataForItems(
  items: Zotero.Item[],
  options: UpdateOptions = {},
): Promise<CitationUpdateBatchResult> {
  const waitingProgress =
    !options.silent && operationBusy
      ? createUpdateProgress({
          document: options.progressDocument,
          title: "Updating citation data",
          message: "Waiting for the current citation update to finish…",
          total: Math.max(1, regularItems(items).length),
        })
      : null;
  return runSerialized(async () => {
    waitingProgress?.dismiss();
    return runUpdate(items, options);
  });
}

export async function updateWholeLibraryCitationData(
  options: UpdateOptions = {},
): Promise<CitationUpdateBatchResult> {
  if (shuttingDown) {
    return {
      total: 0,
      updated: 0,
      cached: 0,
      failed: 0,
      skipped: 0,
    };
  }
  return updateCitationDataForItems(await wholeLibraryItems(), options);
}

function schedulePendingItems(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const ids = [...pendingItemIDs];
    pendingItemIDs.clear();
    const items = ids
      .map((id) => Zotero.Items.get(id))
      .filter((item): item is Zotero.Item => Boolean(item));
    if (items.length) {
      runBackgroundUpdate(
        "automatic update for modified items",
        updateCitationDataForItems(items, { silent: true }),
      );
    }
  }, 1200);
}

export function registerAutomaticCitationUpdates(): void {
  shuttingDown = false;
  resetCitationRequestCancellation();
  if (notifierID) return;
  const observer = {
    notify: async (
      event: string,
      type: string,
      ids: Array<number | string>,
    ): Promise<void> => {
      if (
        type !== "item" ||
        !getAutomaticUpdatesEnabled() ||
        (event === "add" && !getUpdateNewItemsEnabled())
      ) {
        return;
      }
      if (event !== "add" && event !== "modify") return;
      for (const id of ids) pendingItemIDs.add(Number(id));
      schedulePendingItems();
    },
  };
  notifierID = Zotero.Notifier.registerObserver(
    observer,
    ["item"],
    "citation-map-updates",
  );
  if (getAutomaticUpdatesEnabled()) {
    startupTimer = setTimeout(() => {
      startupTimer = null;
      runBackgroundUpdate(
        "startup stale-item refresh",
        updateWholeLibraryCitationData({ silent: true }),
      );
    }, 30000);
  }
}

export function unloadCitationUpdateUI(): void {
  closeAllUpdateProgress();
}

export function unregisterAutomaticCitationUpdates(): void {
  shuttingDown = true;
  cancelPendingCitationRequests();
  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = null;
  }
  if (startupTimer) clearTimeout(startupTimer);
  if (pendingTimer) clearTimeout(pendingTimer);
  startupTimer = null;
  pendingTimer = null;
  pendingItemIDs.clear();
  unloadCitationUpdateUI();
}

export async function waitForCitationUpdates(
  timeoutMs = SHUTDOWN_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const completed = operationTail.then(
    () => true as const,
    () => true as const,
  );
  const result = await Promise.race([completed, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}
