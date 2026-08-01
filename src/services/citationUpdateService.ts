import type {
  CitationMetricRecord,
  CitationProviderPreference,
  CitationUpdateBatchResult,
  ProviderLookupFailure,
  ProviderLookupResult,
  ProviderLookupSuccess,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import {
  CANONICAL_RELATED_WORK_MERGE,
  mergeRelatedWorkRecords,
  relatedWorkFromProviderLookup,
} from "../domain/relatedWorkMetadata";
import {
  matchRelatedWorks,
  matchWorkIdentifiers,
} from "../domain/workIdentity";
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
  getDebugLoggingEnabled,
  getExactTitleFallbackEnabled,
  getProviderLabel,
  isProviderEnabled,
} from "./citationPreferences";
import { storeExternalRelationshipSnapshot } from "./externalDiscoveryService";
import {
  authoritativeReferenceCountAttribution,
  maximumKnownCount,
  richestCountAttribution,
} from "./citationCountPolicy";
import { mergeRelatedWorkLists } from "./relationshipStoreService";
import {
  beginCitationUpdatePublicationBatch,
  endCitationUpdatePublicationBatch,
} from "./citationUpdateEvents";
import { createMetricNodeForItem } from "./itemMetricContext";
import {
  resolveLibraryCoreLookups,
  type ProviderIdentityHints,
} from "./libraryCoreBatchService";
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
import { createCooperativeCheckpoint } from "./backgroundTaskService";
import {
  cancellationRequested,
  createCancellationScope,
  type CancellationScope,
} from "./cancellationScope";
import {
  beginRelationshipPublicationBatch,
  endRelationshipPublicationBatch,
} from "./relationshipEvents";

interface UpdateOptions {
  /** Update every item in the scope even when its cache is still current. */
  force?: boolean;
  silent?: boolean;
  provider?: CitationProviderPreference;
  /** Document in which the modeless progress window should be shown. */
  progressDocument?: Document;
  requestScope?: CancellationScope;
}

type UpdateOutcome = "updated" | "cached" | "failed" | "skipped";

interface CoreUpdateResult {
  outcome: UpdateOutcome;
  record: CitationMetricRecord | null;
}

const SHUTDOWN_WAIT_TIMEOUT_MS = 5000;

let operationTail: Promise<void> = Promise.resolve();
let operationBusy = false;
let shuttingDown = false;
let activeUpdateScope: CancellationScope | null = null;

function updateWasCancelled(scope: CancellationScope): boolean {
  return (
    shuttingDown ||
    isCitationRequestCancellationRequested() ||
    cancellationRequested(scope.signal)
  );
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

function regularItems(items: Zotero.Item[]): Zotero.Item[] {
  return regularCitationItems(items);
}

function createProgress(
  total: number,
  provider: CitationProviderPreference,
  document?: Document,
  onCancel?: () => void,
): UpdateProgressHandle {
  return createUpdateProgress({
    document,
    title: "Updating fields",
    message:
      `Preparing ${total} paper${total === 1 ? "" : "s"} with ` +
      getProviderLabel(provider),
    total: Math.max(1, total),
    onCancel,
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
    case "identity-conflict":
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

function zoteroWork(
  item: Zotero.Item,
  identifiers: WorkIdentifiers,
): RelatedWorkMetadata {
  return {
    provider: "zotero",
    providerWorkID: null,
    doi: identifiers.doi,
    pmid: identifiers.pmid,
    arxiv: identifiers.arxiv,
    isbn: identifiers.isbn,
    title: identifiers.title || null,
    year: identifiers.year,
    authors: [...identifiers.authors],
    sourceTitle: identifiers.sourceTitle,
    zoteroItemKey: String(item.key),
    zoteroLibraryID: Number(item.libraryID),
    dataSources: [],
  };
}

function metricRecordWork(record: CitationMetricRecord): RelatedWorkMetadata {
  return {
    provider: record.provider,
    providerWorkID: record.providerWorkID,
    doi: record.doi,
    title: record.title,
    year: record.year,
    authors: [...record.authors],
    sourceTitle: record.sourceTitle,
    abstract: record.abstract,
    citationCount: record.citationCount,
    referenceCount: record.referenceCount,
    resolvedReferenceCount: record.resolvedReferenceCount,
    references: record.references,
    fwci: record.fwci,
    citationPercentile: record.citationPercentile,
    isTop1Percent: record.isTop1Percent,
    isTop10Percent: record.isTop10Percent,
    citationCountsByYear: record.citationCountsByYear,
    citationsLastYear: record.citationsLastYear,
    citationVelocity: record.citationVelocity,
    citationAcceleration: record.citationAcceleration,
    influentialCitationCount: record.influentialCitationCount,
    isRetracted: record.isRetracted,
    openAccessStatus: record.openAccessStatus,
    isOpenAccess: record.isOpenAccess,
    publicationType: record.publicationType,
    sourceMetrics: record.sourceMetrics,
    propertySources: record.propertySources,
    propertyConflicts: record.propertyConflicts,
    identityStatus: record.identityConflict ? "conflict" : "resolved",
    dataSources: [record.provider],
  };
}

function buildMetricRecord(
  item: Zotero.Item,
  previous: CitationMetricRecord | null,
  identifiers: WorkIdentifiers,
  result: ProviderLookupSuccess,
): CitationMetricRecord {
  const now = new Date().toISOString();
  const local = zoteroWork(item, identifiers);
  const prior = previous ? metricRecordWork(previous) : null;
  const base =
    prior && matchRelatedWorks(local, prior).decision === "same-work"
      ? mergeRelatedWorkRecords(local, prior, CANONICAL_RELATED_WORK_MERGE)
      : local;
  const hydrated = mergeRelatedWorkRecords(
    base,
    relatedWorkFromProviderLookup(result),
    CANONICAL_RELATED_WORK_MERGE,
  );
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
  const previousCitationCount =
    previous?.citationCountProvider &&
    !isProviderEnabled(previous.citationCountProvider)
      ? null
      : (previous?.citationCount ?? null);
  const previousReferenceCount =
    previous?.referenceCountProvider &&
    !isProviderEnabled(previous.referenceCountProvider)
      ? null
      : (previous?.referenceCount ?? null);
  const previousReferenceCountProvider =
    previous?.referenceCountProvider &&
    isProviderEnabled(previous.referenceCountProvider)
      ? previous.referenceCountProvider
      : null;
  const citationCount = richestCountAttribution([
    {
      count: previousCitationCount,
      provider: previous?.citationCountProvider ?? null,
    },
    {
      count: result.citationCount,
      provider: result.citationCountProvider,
    },
  ]);
  const reportedReferenceCount = authoritativeReferenceCountAttribution([
    {
      count: previousReferenceCount,
      provider: previous?.referenceCountProvider ?? null,
    },
    {
      count: result.referenceCount,
      provider: result.referenceCountProvider,
    },
  ]);
  const referenceCount =
    reportedReferenceCount.count !== null
      ? reportedReferenceCount
      : {
          count: mergedReferences.length ? mergedReferences.length : null,
          provider:
            result.referenceCountProvider ??
            previousReferenceCountProvider ??
            null,
        };

  return {
    libraryID: Number(item.libraryID),
    itemKey: String(item.key),
    provider: result.provider,
    providerWorkID: result.providerWorkID ?? previous?.providerWorkID ?? null,
    matchedBy: result.matchedBy ?? previous?.matchedBy ?? null,
    matchConfidence:
      result.matchConfidence ?? previous?.matchConfidence ?? null,
    matchConfirmed,
    identityConflict: hydrated.identityStatus === "conflict",
    doi: hydrated.doi ?? previous?.doi ?? null,
    title: hydrated.title ?? previous?.title ?? null,
    normalizedTitle:
      identifiers.normalizedTitle ?? previous?.normalizedTitle ?? null,
    year: hydrated.year ?? previous?.year ?? null,
    authors: hydrated.authors.length
      ? hydrated.authors
      : (previous?.authors ?? []),
    sourceTitle: hydrated.sourceTitle ?? previous?.sourceTitle ?? null,
    abstract: hydrated.abstract ?? previous?.abstract ?? null,
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
    propertySources: hydrated.propertySources ?? {},
    propertyConflicts: hydrated.propertyConflicts ?? [],
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
  scope: CancellationScope,
): Promise<CoreUpdateResult> {
  const { item, libraryID, itemKey, previous, identifiers } = planned;
  if (!planned.needsCoreRefresh && previous?.status === "success") {
    return { outcome: "updated", record: previous };
  }
  if (updateWasCancelled(scope)) {
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
      zoteroWork(item, identifiers),
      lookup.candidates ?? [],
    );
    return { outcome: "failed", record: null };
  }

  const candidate = relatedWorkFromProviderLookup(lookup);
  const identity = matchWorkIdentifiers(identifiers, candidate);
  if (identity.decision !== "same-work") {
    const status = identity.identityConflict
      ? "identity-conflict"
      : "ambiguous-match";
    await saveCitationMetricFailure(
      libraryID,
      itemKey,
      lookup.provider,
      status,
      identity.reason,
      null,
      zoteroWork(item, identifiers),
      [candidate],
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
  const scope =
    options.requestScope ?? createCancellationScope("citation update");
  const operationStartedAt = Date.now();
  const provider = options.provider ?? "auto";
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

  if (updateWasCancelled(scope)) {
    result.skipped = selected.length;
    result.cached = 0;
    return result;
  }

  if (!pending.length) return result;

  const progress = options.silent
    ? null
    : createProgress(
        pending.length,
        provider,
        options.progressDocument,
        scope.cancel,
      );

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
  // Keep every presentation surface on the previous coherent snapshot while
  // core data, enrichment, and relationship totals are still being merged.
  // The final release below publishes one refresh for columns, panes, and any
  // small graph view after all persisted values are known.
  beginCitationUpdatePublicationBatch();
  beginRelationshipPublicationBatch();
  try {
    const checkpoint = createCooperativeCheckpoint();
    const coreBatch = await resolveLibraryCoreLookups(
      pending,
      provider,
      getExactTitleFallbackEnabled(),
      ({ completed: resolved, total, message }) => {
        progress?.setProgress(resolved, Math.max(1, total), message);
      },
      { signal: scope.signal },
    );
    for (const [index, planned] of pending.entries()) {
      if (updateWasCancelled(scope)) break;
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
        core = await persistOneItemCore(
          planned,
          coreBatch.lookups[index],
          scope,
        );
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
      await checkpoint(completed % 10 === 0);
    }
    coreCompletedAt = Date.now();

    if (updatedRecords.length && !updateWasCancelled(scope)) {
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
        { signal: scope.signal },
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
          signal: scope.signal,
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

    if (!updateWasCancelled(scope)) {
      finishProgress(progress, result, enrichmentText);
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
    // Relationship listeners are released first while the presentation event
    // remains held. Their final graph mutations therefore complete before the
    // single pane/column refresh is dispatched.
    endRelationshipPublicationBatch();
    endCitationUpdatePublicationBatch({
      refreshGraph: selected.length <= 3,
      refreshColumns: true,
      refreshItemPanes: true,
    });
  }
  return result;
}

export function updateCitationDataForItems(
  items: Zotero.Item[],
  options: UpdateOptions = {},
): Promise<CitationUpdateBatchResult> {
  const requestScope =
    options.requestScope ?? createCancellationScope("citation update");
  const waitingProgress =
    !options.silent && operationBusy
      ? createUpdateProgress({
          document: options.progressDocument,
          title: "Updating fields",
          message: "Waiting for the current field update to finish…",
          total: Math.max(1, regularItems(items).length),
          onCancel: requestScope.cancel,
        })
      : null;
  return runSerialized(async () => {
    waitingProgress?.dismiss();
    if (cancellationRequested(requestScope.signal)) {
      return {
        total: regularItems(items).length,
        updated: 0,
        cached: 0,
        failed: 0,
        skipped: regularItems(items).length,
      };
    }
    activeUpdateScope = requestScope;
    try {
      return await runUpdate(items, { ...options, requestScope });
    } finally {
      if (activeUpdateScope === requestScope) activeUpdateScope = null;
    }
  });
}

export function cancelActiveCitationUpdate(): void {
  activeUpdateScope?.cancel();
}

export function unloadCitationUpdateUI(): void {
  closeAllUpdateProgress();
}

export function startCitationUpdateRuntime(): void {
  shuttingDown = false;
  resetCitationRequestCancellation();
}

export function stopCitationUpdateRuntime(): void {
  shuttingDown = true;
  activeUpdateScope?.cancel();
  cancelPendingCitationRequests();
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
