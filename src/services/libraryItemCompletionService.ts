import type {
  CitationMetricRecord,
  RelationshipUpdateStatus,
  SourceMetrics,
} from "../domain/citationTypes";
import type { CitationGraphNode } from "../domain/graphTypes";
import { isCitationRequestCancellationRequested } from "../providers/http";
import {
  getCitationMetricRecord,
  saveCitationMetricRecord,
} from "./citationMetricsStore";
import {
  refreshExternalRelationships,
  type RelationshipRefreshResolution,
} from "./externalDiscoveryService";
import { createMetricNodeForItem } from "./itemMetricContext";
import { getCacheDays } from "./citationPreferences";
import type { ProviderIdentityHints } from "./libraryCoreBatchService";
import {
  CITATION_RECORD_WRITE_CHUNK_SIZE,
  RELATIONSHIP_BULK_EAGER_LIMIT,
  RELATIONSHIP_ITEM_PARALLELISM,
} from "./providerExecutionPolicy";
import { getStoredRelationshipEntry } from "./relationshipStoreService";
import {
  enrichLibrarySourceMetrics,
  type LibrarySourceMetricResult,
} from "./librarySourceMetricsService";
import { mapBounded, yieldToUI } from "./backgroundTaskService";
import {
  cancellationRequested,
  type CancellationSignal,
} from "./cancellationScope";

export type LibraryCompletionPhase =
  "source-metrics" | "relationships" | "finalizing";

export type LibraryRelationshipLoadMode = "first-page" | "complete";

type RelationshipDirection = "references" | "cited-by";

export interface LibraryCompletionProgress {
  phase: LibraryCompletionPhase;
  completed: number;
  total: number;
  message: string;
}

export interface LibraryCompletionResult {
  records: CitationMetricRecord[];
  sourceMetricsUpdated: number;
  sourceMetricsUnresolved: number;
  relationshipListsUpdated: number;
  relationshipFailures: number;
  sourceRequestFailures: number;
}

interface RelationshipTask {
  node: CitationGraphNode;
  direction: RelationshipDirection;
  providerWorkIDs: ProviderIdentityHints;
  maximum: number;
}

interface StoredRelationshipResolution extends RelationshipRefreshResolution {
  updatedAt: string;
  status: RelationshipUpdateStatus;
  nextRetryAt: string | null;
}

const RELATIONSHIP_ERROR_RETRY_MS = 24 * 60 * 60 * 1000;
const RELATIONSHIP_UNAVAILABLE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

function latestRecords(
  records: CitationMetricRecord[],
): CitationMetricRecord[] {
  return records.map(
    (record) =>
      getCitationMetricRecord(record.libraryID, record.itemKey) ?? record,
  );
}

function relationshipMaximum(
  node: CitationGraphNode,
  direction: RelationshipDirection,
  mode: LibraryRelationshipLoadMode,
): number {
  const reported =
    direction === "references" ? node.referenceCount : node.citationCount;
  if (mode === "first-page") {
    return Math.min(
      RELATIONSHIP_BULK_EAGER_LIMIT,
      reported == null ? RELATIONSHIP_BULK_EAGER_LIMIT : Math.max(0, reported),
    );
  }
  // Explicit single-paper completion remains endpoint-driven when the provider
  // does not report a total.
  return reported == null ? Number.POSITIVE_INFINITY : Math.max(0, reported);
}

function relationshipStateKey(
  direction: RelationshipDirection,
): "referencesUpdatedAt" | "citedByUpdatedAt" {
  return direction === "references"
    ? "referencesUpdatedAt"
    : "citedByUpdatedAt";
}

function relationshipCompleteKey(
  direction: RelationshipDirection,
): "referencesComplete" | "citedByComplete" {
  return direction === "references" ? "referencesComplete" : "citedByComplete";
}

function relationshipLoadedCountKey(
  direction: RelationshipDirection,
): "referencesLoadedCount" | "citedByLoadedCount" {
  return direction === "references"
    ? "referencesLoadedCount"
    : "citedByLoadedCount";
}

function relationshipStatusKey(
  direction: RelationshipDirection,
): "referencesStatus" | "citedByStatus" {
  return direction === "references" ? "referencesStatus" : "citedByStatus";
}

function relationshipNextRetryKey(
  direction: RelationshipDirection,
): "referencesNextRetryAt" | "citedByNextRetryAt" {
  return direction === "references"
    ? "referencesNextRetryAt"
    : "citedByNextRetryAt";
}

function retryIsDeferred(value: string | null | undefined): boolean {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function relationshipNeedsRefresh(
  node: CitationGraphNode,
  direction: RelationshipDirection,
  record: CitationMetricRecord,
  force: boolean,
  mode: LibraryRelationshipLoadMode,
  maximum: number,
): boolean {
  if (force) return true;

  const state = record.sourceMetrics?.libraryUpdateState;
  const status = state?.[relationshipStatusKey(direction)];
  if (
    status === "unavailable" &&
    retryIsDeferred(state?.[relationshipNextRetryKey(direction)])
  ) {
    return false;
  }

  const entry = getStoredRelationshipEntry(node, direction);
  if (!entry) return true;

  const timestamp = Date.parse(
    state?.[relationshipStateKey(direction)] ?? entry.fetchedAt,
  );
  const stale =
    !Number.isFinite(timestamp) ||
    Date.now() - timestamp >= getCacheDays() * 86400000;
  if (stale) return true;

  if (status === "empty" || state?.[relationshipCompleteKey(direction)]) {
    return false;
  }

  // A direct single-paper update may explicitly finish an existing partial
  // cache. Bulk updates only guarantee a display-ready first hop.
  if (mode === "complete") return true;
  if (status === "first-hop-ready") return false;

  const loaded =
    state?.[relationshipLoadedCountKey(direction)] ?? entry.works.length;
  return loaded <= 0 && maximum > 0;
}

function statusForResolution(
  resolution: RelationshipRefreshResolution,
): RelationshipUpdateStatus {
  if (resolution.reportedCount === 0 && resolution.identifiedCount === 0) {
    return "empty";
  }
  if (resolution.complete) return "complete";
  if (resolution.identifiedCount > 0) return "first-hop-ready";
  return "unavailable";
}

function rememberRelationshipResolution(
  resolutions: Map<
    string,
    Map<RelationshipDirection, StoredRelationshipResolution>
  >,
  itemKey: string,
  direction: RelationshipDirection,
  resolution: RelationshipRefreshResolution,
): StoredRelationshipResolution {
  const now = Date.now();
  const status = statusForResolution(resolution);
  const stored: StoredRelationshipResolution = {
    ...resolution,
    updatedAt: new Date(now).toISOString(),
    status,
    nextRetryAt:
      status === "unavailable"
        ? new Date(now + RELATIONSHIP_UNAVAILABLE_RETRY_MS).toISOString()
        : null,
  };
  const byDirection = resolutions.get(itemKey) ?? new Map();
  byDirection.set(direction, stored);
  resolutions.set(itemKey, byDirection);
  return stored;
}

function rememberRelationshipFailure(
  resolutions: Map<
    string,
    Map<RelationshipDirection, StoredRelationshipResolution>
  >,
  node: CitationGraphNode,
  direction: RelationshipDirection,
): void {
  const now = Date.now();
  const existing = getStoredRelationshipEntry(node, direction);
  const reportedCount =
    direction === "references" ? node.referenceCount : node.citationCount;
  const byDirection = resolutions.get(node.itemKey) ?? new Map();
  byDirection.set(direction, {
    complete: false,
    provider: null,
    reportedCount,
    identifiedCount: existing?.works.length ?? 0,
    updatedAt: new Date(now).toISOString(),
    status: "unavailable",
    nextRetryAt: new Date(now + RELATIONSHIP_ERROR_RETRY_MS).toISOString(),
  });
  resolutions.set(node.itemKey, byDirection);
}

function isExpectedBoundedResult(
  mode: LibraryRelationshipLoadMode,
  resolution: StoredRelationshipResolution,
): boolean {
  if (resolution.status === "complete" || resolution.status === "empty") {
    return true;
  }
  return mode === "first-page" && resolution.status === "first-hop-ready";
}

/**
 * Finish a Zotero-item update so every library root is graph-ready. Bulk jobs
 * retrieve a bounded first hop with compact summaries; returned neighbours are
 * never recursively expanded. A direct single-paper update may complete the
 * entire membership for both directions.
 */
export async function completeLibraryItemUpdates(
  items: Zotero.Item[],
  records: CitationMetricRecord[],
  onProgress?: (progress: LibraryCompletionProgress) => void,
  options: {
    force?: boolean;
    providerIdentitiesByItemKey?: Map<string, ProviderIdentityHints>;
    relationshipMode?: LibraryRelationshipLoadMode;
    signal?: CancellationSignal;
  } = {},
): Promise<LibraryCompletionResult> {
  const cancelled = (): boolean =>
    isCitationRequestCancellationRequested() ||
    cancellationRequested(options.signal);
  const itemByKey = new Map(items.map((item) => [String(item.key), item]));
  const relevantItems = records
    .map((record) => itemByKey.get(record.itemKey))
    .filter((item): item is Zotero.Item => Boolean(item));
  const relationshipMode = options.relationshipMode ?? "first-page";

  let sourceResult: LibrarySourceMetricResult = {
    records,
    updated: 0,
    unresolved: 0,
    failedRequests: 0,
  };
  if (!cancelled()) {
    sourceResult = await enrichLibrarySourceMetrics(
      relevantItems,
      records,
      ({ completed, total, message }) =>
        onProgress?.({
          phase: "source-metrics",
          completed,
          total,
          message,
        }),
      { force: options.force },
    );
  }

  const nodes: CitationGraphNode[] = relevantItems.map((item) =>
    createMetricNodeForItem(item),
  );
  const latestByItemKey = new Map(
    latestRecords(sourceResult.records).map((record) => [
      record.itemKey,
      record,
    ]),
  );
  const relationshipTasks: RelationshipTask[] = [];
  for (const node of nodes) {
    const record = latestByItemKey.get(node.itemKey);
    if (!record) continue;
    const providerWorkIDs = {
      ...(record.sourceMetrics?.libraryUpdateState?.providerWorkIDs ?? {}),
      ...(options.providerIdentitiesByItemKey?.get(node.itemKey) ?? {}),
    };
    for (const direction of ["references", "cited-by"] as const) {
      const maximum = relationshipMaximum(node, direction, relationshipMode);
      if (
        relationshipNeedsRefresh(
          node,
          direction,
          record,
          Boolean(options.force),
          relationshipMode,
          maximum,
        )
      ) {
        relationshipTasks.push({
          node,
          direction,
          providerWorkIDs,
          maximum,
        });
      }
    }
  }

  let relationshipListsUpdated = 0;
  let relationshipFailures = 0;
  let completedRelationships = 0;
  const relationshipResolutions = new Map<
    string,
    Map<RelationshipDirection, StoredRelationshipResolution>
  >();

  await mapBounded(
    relationshipTasks,
    RELATIONSHIP_ITEM_PARALLELISM,
    async ({ node, direction, providerWorkIDs, maximum }) => {
      if (cancelled()) return;
      const label = direction === "references" ? "references" : "citing papers";
      const action =
        relationshipMode === "first-page" ? "Caching first-hop" : "Retrieving";
      onProgress?.({
        phase: "relationships",
        completed: completedRelationships,
        total: relationshipTasks.length,
        message:
          `${action} ${label} and paper summaries · ` +
          `${completedRelationships}/${relationshipTasks.length}`,
      });

      try {
        let resolution: RelationshipRefreshResolution | null = null;
        await refreshExternalRelationships(node, nodes, direction, {
          maximum,
          refreshMembership: true,
          silent: true,
          // Bounded first-hop completion is background maintenance. It still
          // uses every provider enabled in Settings, but limits membership and
          // optional metadata so the update remains cooperative.
          mode: relationshipMode === "first-page" ? "automatic" : "manual",
          summaryLookupLimit: 0,
          queueBackgroundHydration: true,
          providerWorkIDs,
          signal: options.signal,
          onMembershipResolved: (value) => {
            resolution = value;
          },
        });

        const finalResolution =
          resolution as RelationshipRefreshResolution | null;
        if (!finalResolution) {
          throw new Error(
            "Relationship provider returned no resolution state.",
          );
        }
        relationshipListsUpdated += 1;
        const storedResolution = rememberRelationshipResolution(
          relationshipResolutions,
          node.itemKey,
          direction,
          finalResolution,
        );

        if (!isExpectedBoundedResult(relationshipMode, storedResolution)) {
          relationshipFailures += 1;
          Zotero.debug(
            `Citation Map: ${direction} membership remained incomplete for ${node.itemKey} ` +
              `(${finalResolution.identifiedCount}/${finalResolution.reportedCount ?? "unknown"})`,
          );
        }
      } catch (error) {
        relationshipFailures += 1;
        rememberRelationshipFailure(relationshipResolutions, node, direction);
        Zotero.debug(
          `Citation Map: ${relationshipMode} ${direction} update failed for ${node.itemKey}: ${String(error)}`,
        );
      } finally {
        completedRelationships += 1;
        onProgress?.({
          phase: "relationships",
          completed: completedRelationships,
          total: relationshipTasks.length,
          message:
            `Caching relationships and paper summaries · ` +
            `${completedRelationships}/${relationshipTasks.length}`,
        });
      }
    },
    {
      // Relationship processing performs synchronous merging and
      // serialization after each network response. Yield between roots so
      // Zotero can repaint.
      yieldAfterEach: true,
    },
  );

  const finalizedAt = new Date().toISOString();
  const finalRecords: CitationMetricRecord[] = [];
  for (const record of latestRecords(sourceResult.records)) {
    const current =
      getCitationMetricRecord(record.libraryID, record.itemKey) ?? record;
    const resolutions = relationshipResolutions.get(record.itemKey);
    const referencesResolution = resolutions?.get("references");
    const citedByResolution = resolutions?.get("cited-by");
    const previousState = current.sourceMetrics?.libraryUpdateState ?? {};
    const baseSourceMetrics: SourceMetrics = current.sourceMetrics ?? {
      sourceID: null,
      sourceTitle: current.sourceTitle,
      twoYearMeanCitedness: null,
      hIndex: null,
      i10Index: null,
      updatedAt: finalizedAt,
    };
    const sourceMetrics: SourceMetrics = {
      ...baseSourceMetrics,
      libraryUpdateState: {
        ...previousState,
        coreUpdatedAt: current.fetchedAt ?? finalizedAt,
        sourceMetricsUpdatedAt: baseSourceMetrics.updatedAt ?? finalizedAt,
        referencesUpdatedAt:
          referencesResolution?.updatedAt ??
          previousState.referencesUpdatedAt ??
          null,
        citedByUpdatedAt:
          citedByResolution?.updatedAt ??
          previousState.citedByUpdatedAt ??
          null,
        referencesComplete: referencesResolution
          ? referencesResolution.complete
          : (previousState.referencesComplete ?? false),
        citedByComplete: citedByResolution
          ? citedByResolution.complete
          : (previousState.citedByComplete ?? false),
        referencesLoadedCount: referencesResolution
          ? referencesResolution.identifiedCount
          : (previousState.referencesLoadedCount ?? 0),
        citedByLoadedCount: citedByResolution
          ? citedByResolution.identifiedCount
          : (previousState.citedByLoadedCount ?? 0),
        referencesReportedCount: referencesResolution
          ? referencesResolution.reportedCount
          : (previousState.referencesReportedCount ?? null),
        citedByReportedCount: citedByResolution
          ? citedByResolution.reportedCount
          : (previousState.citedByReportedCount ?? null),
        referencesStatus:
          referencesResolution?.status ?? previousState.referencesStatus,
        citedByStatus: citedByResolution?.status ?? previousState.citedByStatus,
        referencesNextRetryAt: referencesResolution
          ? referencesResolution.nextRetryAt
          : (previousState.referencesNextRetryAt ?? null),
        citedByNextRetryAt: citedByResolution
          ? citedByResolution.nextRetryAt
          : (previousState.citedByNextRetryAt ?? null),
        providerWorkIDs: {
          ...(previousState.providerWorkIDs ?? {}),
          ...(options.providerIdentitiesByItemKey?.get(record.itemKey) ?? {}),
        },
      },
    };
    finalRecords.push({ ...current, sourceMetrics });
  }

  for (
    let start = 0;
    start < finalRecords.length;
    start += CITATION_RECORD_WRITE_CHUNK_SIZE
  ) {
    await Promise.all(
      finalRecords
        .slice(start, start + CITATION_RECORD_WRITE_CHUNK_SIZE)
        .map((record) => saveCitationMetricRecord(record)),
    );
    await yieldToUI();
  }

  onProgress?.({
    phase: "finalizing",
    completed: records.length,
    total: records.length,
    message:
      relationshipMode === "first-page"
        ? "Finalizing bounded first-hop library metrics"
        : "Finalizing complete library-item metrics",
  });

  return {
    records: latestRecords(sourceResult.records),
    sourceMetricsUpdated: sourceResult.updated,
    sourceMetricsUnresolved: sourceResult.unresolved,
    relationshipListsUpdated,
    relationshipFailures,
    sourceRequestFailures: sourceResult.failedRequests,
  };
}
