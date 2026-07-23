import type {
  CitationMetricRecord,
  CitationProviderPreference,
  CitationUpdateBatchResult,
  ProviderLookupFailure,
} from "../domain/citationTypes";
import { getProviderPlan, lookupCitationMetrics } from "../providers/registry";
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
import { storeExternalRelationshipSnapshot } from "./externalDiscoveryService";
import { refreshCitationColumns } from "./itemTreeColumnService";
import {
  getStoredRelationshipWorks,
  mergeRelatedWorkLists,
} from "./relationshipStoreService";
import { createMetricNodeForItem } from "./itemMetricContext";
import { refreshCitationItemPanes } from "./itemPaneService";
import { ensureSourceMetricsForNodes } from "./sourceMetricsService";
import { refreshOpenCitationMapViews } from "./windowService";
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
   * Retained for API compatibility. General field-update actions never hydrate
   * complete cited-by/reference lists; relationship views provide their own
   * explicit refresh controls.
   */
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
    title: "Updating fields",
    message:
      `Preparing ${total} paper${total === 1 ? "" : "s"} with ` +
      getProviderLabel(provider),
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
    `Updating ${completed}/${total} complete${
      active ? ` · ${active} active` : ""
    }: ${title}`,
  );
}

function finishProgress(
  progress: UpdateProgressHandle | null,
  result: CitationUpdateBatchResult,
): void {
  if (!progress || shuttingDown) return;
  progress.finish(
    `${result.updated} updated · ${result.cached} current · ` +
      `${result.failed} failed · ${result.skipped} skipped`,
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

async function updateOneItem(
  item: Zotero.Item,
  preference: CitationProviderPreference,
  force: boolean,
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
  // Every explicit or automatic field update attempts the full scalar-field
  // enrichment path. This remains bounded because complete relationship lists
  // are refreshed separately by the relationship views.
  const result = await lookupCitationMetrics(
    preference,
    identifiers,
    getExactTitleFallbackEnabled(),
    true,
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
  const cachedRelationshipNode = createMetricNodeForItem(item);
  const mergedReferences = mergeRelatedWorkLists(
    previous?.references ?? [],
    getStoredRelationshipWorks(cachedRelationshipNode, "references"),
    result.references,
  );
  const citationCount = result.citationCount ?? previous?.citationCount ?? null;
  const referenceCount =
    result.referenceCount ?? previous?.referenceCount ?? null;

  const record: CitationMetricRecord = {
    libraryID,
    itemKey,
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
    citationCount,
    citationCountProvider:
      result.citationCount !== null
        ? result.citationCountProvider
        : (previous?.citationCountProvider ?? result.citationCountProvider),
    referenceCount,
    referenceCountProvider:
      result.referenceCount !== null
        ? result.referenceCountProvider
        : (previous?.referenceCountProvider ?? result.referenceCountProvider),
    resolvedReferenceCount: Math.max(
      previous?.resolvedReferenceCount ?? 0,
      result.resolvedReferenceCount,
      mergedReferences.length,
    ),
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
  await saveCitationMetricRecord(record);

  // Persist the provider's embedded reference snapshot, but do not paginate
  // cited-by/reference endpoints here. The relationship tabs own those actions.
  try {
    const updatedNode = createMetricNodeForItem(item);
    await storeExternalRelationshipSnapshot(
      updatedNode,
      "references",
      record.references,
    );
    if (getProviderPlan("source-metrics", preference).providers.length) {
      await ensureSourceMetricsForNodes([updatedNode]);
    }
  } catch (error) {
    Zotero.debug(
      "Citation Map: post-update enrichment failed for " +
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
  // Read the legacy option so development builds passing it remain compatible.
  void options.includeRelationships;
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
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      let outcome: UpdateOutcome;
      try {
        const deadline =
          pending.length === 1
            ? SINGLE_ITEM_DEADLINE_MS
            : BATCH_ITEM_DEADLINE_MS;
        outcome = await withDeadline(
          updateOneItem(item, provider, force),
          deadline,
          `Field update for ${String(item.getField("title") ?? item.key)}`,
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
