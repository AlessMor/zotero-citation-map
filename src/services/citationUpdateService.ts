import type {
  CitationMetricRecord,
  CitationProviderPreference,
  CitationUpdateBatchResult,
  ProviderLookupFailure,
  ProviderLookupResult,
  ProviderLookupSuccess,
  WorkIdentifiers,
} from "../domain/citationTypes";
import {
  cancelPendingCitationRequests,
  isCitationRequestCancellationRequested,
  resetCitationRequestCancellation,
} from "../providers/http";
import { enrichCitationMetricRecords } from "./batchEnrichmentService";
import { completeLibraryItemUpdates } from "./libraryItemCompletionService";
import {
  saveCitationMetricFailure,
  saveCitationMetricRecord,
} from "./citationMetricsStore";
import {
  getAutomaticUpdatesEnabled,
  getCheckStaleOnStartupEnabled,
  getDebugLoggingEnabled,
  getExactTitleFallbackEnabled,
  getProviderLabel,
  getProviderPreference,
  getUpdateModifiedItemsEnabled,
  getUpdateNewItemsEnabled,
} from "./citationPreferences";
import { storeExternalRelationshipSnapshot } from "./externalDiscoveryService";
import {
  maximumKnownCount,
  richestCountAttribution,
} from "./citationCountPolicy";
import { refreshCitationColumns } from "./itemTreeColumnService";
import { mergeRelatedWorkLists } from "./relationshipStoreService";
import { createMetricNodeForItem } from "./itemMetricContext";
import {
  resolveLibraryCoreLookups,
  type ProviderIdentityHints,
} from "./libraryCoreBatchService";
import { refreshCitationItemPanes } from "./itemPaneService";
import { refreshOpenCitationMapViews } from "./windowService";
import {
  createCitationUpdatePlan,
  regularCitationItems,
  type PlannedCitationItem,
} from "./updatePlanner";
import {
  closeAllUpdateProgress,
  createUpdateProgress,
  type UpdateProgressHandle,
} from "./updateProgressService";

interface UpdateOptions {
  /** Update every item in the scope even when its cache is still current. */
  force?: boolean;
  silent?: boolean;
  provider?: CitationProviderPreference;
  /**
   * Retained for API compatibility. Every successful Zotero-item update now
   * completes both relationship directions and their compact paper summaries.
   */
  includeRelationships?: boolean;
  /** Document in which the modeless progress window should be shown. */
  progressDocument?: Document;
}

type UpdateOutcome = "updated" | "cached" | "failed" | "skipped";

interface CoreUpdateResult {
  outcome: UpdateOutcome;
  record: CitationMetricRecord | null;
}

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
  return regularCitationItems(items);
}

async function wholeLibraryItems(): Promise<Zotero.Item[]> {
  return regularItems(
    (await Zotero.Items.getAll(
      Zotero.Libraries.userLibraryID,
    )) as Zotero.Item[],
  );
}

function createProgress(
  total: number,
  provider: CitationProviderPreference,
  document?: Document,
): UpdateProgressHandle {
  return createUpdateProgress({
    document,
    title: "Updating fields",
    message:
      `Preparing ${total} paper${total === 1 ? "" : "s"} with ` +
      getProviderLabel(provider),
    total: Math.max(1, total),
  });
}

function updateCoreProgress(
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
    Math.max(1, total),
    `Resolving core data · ${completed}/${total} complete${
      active ? ` · ${active} active` : ""
    }: ${title}`,
  );
}

function finishProgress(
  progress: UpdateProgressHandle | null,
  result: CitationUpdateBatchResult,
  enrichmentText = "",
): void {
  if (!progress || shuttingDown) return;
  progress.finish(
    `${result.updated} updated · ${result.cached} current · ` +
      `${result.failed} failed · ${result.skipped} skipped${enrichmentText}`,
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

function nonEmptyYearCounts<T>(
  current: T[] | null | undefined,
  previous: T[] | null | undefined,
): T[] {
  return current?.length ? current : (previous ?? []);
}

function buildMetricRecord(
  item: Zotero.Item,
  previous: CitationMetricRecord | null,
  identifiers: WorkIdentifiers,
  result: ProviderLookupSuccess,
): CitationMetricRecord {
  const now = new Date().toISOString();
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
  const citationCount = richestCountAttribution([
    {
      count: previous?.citationCount ?? null,
      provider: previous?.citationCountProvider ?? null,
    },
    {
      count: result.citationCount,
      provider: result.citationCountProvider,
    },
  ]);
  const referenceCount = richestCountAttribution([
    {
      count: previous?.referenceCount ?? null,
      provider: previous?.referenceCountProvider ?? null,
    },
    {
      count: result.referenceCount,
      provider: result.referenceCountProvider,
    },
    {
      count: mergedReferences.length,
      provider:
        result.referenceCountProvider ??
        previous?.referenceCountProvider ??
        null,
    },
  ]);

  return {
    libraryID: Number(item.libraryID),
    itemKey: String(item.key),
    provider: result.provider,
    providerWorkID: result.providerWorkID ?? previous?.providerWorkID ?? null,
    matchedBy: result.matchedBy ?? previous?.matchedBy ?? null,
    matchConfidence:
      result.matchConfidence ?? previous?.matchConfidence ?? null,
    matchConfirmed,
    doi: result.doi ?? identifiers.doi ?? previous?.doi ?? null,
    title: result.title ?? identifiers.title ?? previous?.title ?? null,
    normalizedTitle:
      identifiers.normalizedTitle ?? previous?.normalizedTitle ?? null,
    year: result.year ?? identifiers.year ?? previous?.year ?? null,
    authors: result.authors.length
      ? result.authors
      : identifiers.authors.length
        ? identifiers.authors
        : (previous?.authors ?? []),
    sourceTitle:
      result.sourceTitle ??
      identifiers.sourceTitle ??
      previous?.sourceTitle ??
      null,
    abstract: result.abstract ?? previous?.abstract ?? null,
    citationCount: citationCount.count,
    citationCountProvider: citationCount.provider,
    referenceCount: referenceCount.count,
    referenceCountProvider: referenceCount.provider,
    resolvedReferenceCount:
      maximumKnownCount([
        previous?.resolvedReferenceCount,
        result.resolvedReferenceCount,
        mergedReferences.length,
      ]) ?? 0,
    references: mergedReferences,
    matchCandidates: [],
    fwci: result.fwci ?? previous?.fwci ?? null,
    citationPercentile:
      result.citationPercentile ?? previous?.citationPercentile ?? null,
    isTop1Percent: result.isTop1Percent ?? previous?.isTop1Percent ?? null,
    isTop10Percent: result.isTop10Percent ?? previous?.isTop10Percent ?? null,
    citationCountsByYear: nonEmptyYearCounts(
      result.citationCountsByYear,
      previous?.citationCountsByYear,
    ),
    citationsLastYear:
      result.citationsLastYear ?? previous?.citationsLastYear ?? null,
    citationVelocity:
      result.citationVelocity ?? previous?.citationVelocity ?? null,
    citationAcceleration:
      result.citationAcceleration ?? previous?.citationAcceleration ?? null,
    influentialCitationCount:
      result.influentialCitationCount ??
      previous?.influentialCitationCount ??
      null,
    isRetracted: result.isRetracted ?? previous?.isRetracted ?? null,
    openAccessStatus:
      result.openAccessStatus ?? previous?.openAccessStatus ?? null,
    isOpenAccess: result.isOpenAccess ?? previous?.isOpenAccess ?? null,
    publicationType:
      result.publicationType ?? previous?.publicationType ?? null,
    sourceMetrics: result.sourceMetrics ?? previous?.sourceMetrics ?? null,
    status: "success",
    fetchedAt: now,
    lastAttemptAt: now,
    errorMessage: null,
    failureCount: 0,
    nextRetryAt: null,
  };
}

async function persistOneItemCore(
  planned: PlannedCitationItem,
  lookup: ProviderLookupResult,
): Promise<CoreUpdateResult> {
  const { item, libraryID, itemKey, previous, identifiers } = planned;
  if (!planned.needsCoreRefresh && previous?.status === "success") {
    return { outcome: "updated", record: previous };
  }
  if (shuttingDown || isCitationRequestCancellationRequested()) {
    return { outcome: "skipped", record: null };
  }
  if (lookup.status !== "success") {
    await saveCitationMetricFailure(
      libraryID,
      itemKey,
      lookup.provider,
      lookup.status,
      lookup.message,
      nextRetryAt(lookup, previous?.failureCount ?? 0),
      lookup.candidates ?? [],
    );
    return { outcome: "failed", record: null };
  }

  const record = buildMetricRecord(item, previous, identifiers, lookup);
  await saveCitationMetricRecord(record);

  try {
    const node = createMetricNodeForItem(item);
    await storeExternalRelationshipSnapshot(
      node,
      "references",
      record.references,
      {
        provider: lookup.provider,
        reportedCount: lookup.referenceCount,
      },
    );
  } catch (error) {
    Zotero.debug(
      `Citation Map: post-core update processing failed for ${itemKey}: ${String(error)}`,
    );
  }

  return { outcome: "updated", record };
}

async function runUpdate(
  items: Zotero.Item[],
  options: UpdateOptions = {},
): Promise<CitationUpdateBatchResult> {
  const operationStartedAt = Date.now();
  const provider = options.provider ?? getProviderPreference();
  const force = Boolean(options.force);
  const plan = createCitationUpdatePlan(items, provider, force);
  const { items: selected, pending } = plan;
  const result: CitationUpdateBatchResult = {
    total: selected.length,
    updated: 0,
    cached: plan.cached,
    failed: 0,
    skipped: 0,
  };

  if (shuttingDown || isCitationRequestCancellationRequested()) {
    result.skipped = selected.length;
    result.cached = 0;
    return result;
  }

  if (!pending.length) return result;

  const progress = options.silent
    ? null
    : createProgress(pending.length, provider, options.progressDocument);

  const updatedRecords: CitationMetricRecord[] = [];
  const providerIdentitiesByItemKey = new Map<string, ProviderIdentityHints>();
  let completed = 0;

  let enrichmentText = "";
  let enrichmentDurationMs = 0;
  let enrichedCount = 0;
  let failedBatches = 0;
  let sourceMetricsUpdated = 0;
  let sourceMetricsUnresolved = 0;
  let relationshipListsUpdated = 0;
  let relationshipFailures = 0;
  let completionDurationMs = 0;
  let coreCompletedAt = operationStartedAt;
  try {
    const coreBatch = await resolveLibraryCoreLookups(
      pending,
      provider,
      getExactTitleFallbackEnabled(),
      ({ completed: resolved, total, message }) => {
        progress?.setProgress(resolved, Math.max(1, total), message);
      },
    );
    for (const [index, planned] of pending.entries()) {
      if (shuttingDown || isCitationRequestCancellationRequested()) break;
      const title = String(planned.item.getField("title") ?? "Untitled");
      updateCoreProgress(
        progress,
        completed,
        completed + 1,
        pending.length,
        title,
      );
      let core: CoreUpdateResult;
      try {
        core = await persistOneItemCore(planned, coreBatch.lookups[index]);
      } catch (error) {
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
        core = {
          outcome: shuttingDown ? "skipped" : "failed",
          record: null,
        };
      }
      result[core.outcome] += 1;
      if (core.record) updatedRecords.push(core.record);
      const hints = coreBatch.providerIdentitiesByItemKey.get(planned.itemKey);
      if (hints) providerIdentitiesByItemKey.set(planned.itemKey, hints);
      completed += 1;
      updateCoreProgress(progress, completed, completed, pending.length, title);
      if (completed % 25 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    coreCompletedAt = Date.now();

    if (
      updatedRecords.length &&
      !shuttingDown &&
      !isCitationRequestCancellationRequested()
    ) {
      // Publish core values while the complete library-item update continues, so
      // columns and item panes remain responsive during a large update.
      refreshViewsAfterUpdate(false);
      const enrichmentStartedAt = Date.now();
      const enrichment = await enrichCitationMetricRecords(
        updatedRecords,
        ({ completed: enriched, total, activeBatches, message }) => {
          progress?.setProgress(
            enriched,
            Math.max(1, total),
            `${message}${activeBatches ? ` · ${activeBatches} provider batch${activeBatches === 1 ? "" : "es"} active` : ""}`,
          );
        },
      );
      enrichmentDurationMs = Date.now() - enrichmentStartedAt;
      enrichedCount = enrichment.enriched;
      failedBatches = enrichment.failedBatches;
      for (const [itemKey, hints] of enrichment.providerIdentitiesByItemKey) {
        providerIdentitiesByItemKey.set(itemKey, {
          ...(providerIdentitiesByItemKey.get(itemKey) ?? {}),
          ...hints,
        });
      }

      const completionStartedAt = Date.now();
      const completion = await completeLibraryItemUpdates(
        pending.map((entry) => entry.item),
        enrichment.records,
        ({ completed: phaseCompleted, total, message }) => {
          progress?.setProgress(phaseCompleted, Math.max(1, total), message);
        },
        {
          force,
          providerIdentitiesByItemKey,
        },
      );
      completionDurationMs = Date.now() - completionStartedAt;
      sourceMetricsUpdated = completion.sourceMetricsUpdated;
      sourceMetricsUnresolved = completion.sourceMetricsUnresolved;
      relationshipListsUpdated = completion.relationshipListsUpdated;
      relationshipFailures = completion.relationshipFailures;
      enrichmentText =
        ` · ${enrichment.enriched} metric record${enrichment.enriched === 1 ? "" : "s"} completed` +
        ` · ${completion.relationshipListsUpdated} relationship list${completion.relationshipListsUpdated === 1 ? "" : "s"} updated` +
        (completion.sourceMetricsUnresolved
          ? ` · ${completion.sourceMetricsUnresolved} journal metric${completion.sourceMetricsUnresolved === 1 ? "" : "s"} unavailable`
          : "") +
        (enrichment.failedBatches || completion.relationshipFailures
          ? ` · ${enrichment.failedBatches + completion.relationshipFailures} warning${enrichment.failedBatches + completion.relationshipFailures === 1 ? "" : "s"}`
          : "");
    }
  } finally {
    const accounted =
      result.updated + result.cached + result.failed + result.skipped;
    if (accounted < selected.length) {
      result.skipped += selected.length - accounted;
    }

    if (!shuttingDown && !isCitationRequestCancellationRequested()) {
      finishProgress(progress, result, enrichmentText);
      refreshViewsAfterUpdate(selected.length <= 3);
      if (getDebugLoggingEnabled()) {
        Zotero.debug(
          "Citation Map: batched update completed " +
            JSON.stringify({
              items: selected.length,
              pending: pending.length,
              updated: result.updated,
              cached: result.cached,
              failed: result.failed,
              executionPolicy: "provider-specific",
              coreMs: coreCompletedAt - operationStartedAt,
              enrichmentMs: enrichmentDurationMs,
              completionMs: completionDurationMs,
              enriched: enrichedCount,
              sourceMetricsUpdated,
              sourceMetricsUnresolved,
              relationshipListsUpdated,
              relationshipFailures,
              failedBatches,
              totalMs: Date.now() - operationStartedAt,
            }),
        );
      }
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
          title: "Updating fields",
          message: "Waiting for the current field update to finish…",
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
        updateCitationDataForItems(items, { silent: false }),
      );
    }
  }, 1200);
}

/** Compatibility registration path. Normal startup uses the visible wrapper. */
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
      if (type !== "item" || !getAutomaticUpdatesEnabled()) return;
      if (event === "add" && !getUpdateNewItemsEnabled()) return;
      if (event === "modify" && !getUpdateModifiedItemsEnabled()) return;
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
  if (getAutomaticUpdatesEnabled() && getCheckStaleOnStartupEnabled()) {
    startupTimer = setTimeout(() => {
      startupTimer = null;
      runBackgroundUpdate(
        "startup stale-item refresh",
        updateWholeLibraryCitationData({ silent: false }),
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
