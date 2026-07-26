import type { CitationMetricRecord } from "../domain/citationTypes";
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
import { LIBRARY_UPDATE_COMPLETION_VERSION } from "./libraryUpdatePolicy";
import {
  enrichLibrarySourceMetrics,
  type LibrarySourceMetricResult,
} from "./librarySourceMetricsService";

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
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function runBounded<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index]);
      // Relationship processing performs synchronous merging and serialization
      // after each network response. Yield between roots so Zotero can repaint.
      await yieldToEventLoop();
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => worker(),
    ),
  );
}

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

function relationshipNeedsRefresh(
  node: CitationGraphNode,
  direction: RelationshipDirection,
  record: CitationMetricRecord,
  force: boolean,
  mode: LibraryRelationshipLoadMode,
  maximum: number,
): boolean {
  const entry = getStoredRelationshipEntry(node, direction);
  if (force || !entry) return true;

  const state = record.sourceMetrics?.libraryUpdateState;
  const timestamp = Date.parse(state?.[relationshipStateKey(direction)] ?? "");
  const stale =
    !Number.isFinite(timestamp) ||
    Date.now() - timestamp >= getCacheDays() * 86400000;
  if (stale) return true;
  if (state?.[relationshipCompleteKey(direction)]) return false;

  // A direct single-paper update may explicitly finish an existing partial
  // cache. Bulk updates only guarantee one display-ready first hop.
  if (mode === "complete") return true;
  const loaded =
    state?.[relationshipLoadedCountKey(direction)] ?? entry.works.length;
  return loaded < maximum;
}

function rememberRelationshipResolution(
  resolutions: Map<
    string,
    Map<RelationshipDirection, StoredRelationshipResolution>
  >,
  itemKey: string,
  direction: RelationshipDirection,
  resolution: RelationshipRefreshResolution,
): void {
  const byDirection = resolutions.get(itemKey) ?? new Map();
  byDirection.set(direction, {
    ...resolution,
    updatedAt: new Date().toISOString(),
  });
  resolutions.set(itemKey, byDirection);
}

function isExpectedBoundedResult(
  mode: LibraryRelationshipLoadMode,
  maximum: number,
  resolution: RelationshipRefreshResolution,
): boolean {
  if (resolution.complete) return true;
  if (mode !== "first-page") return false;
  const expected = Math.min(
    maximum,
    resolution.reportedCount == null
      ? maximum
      : Math.max(0, resolution.reportedCount),
  );
  return resolution.identifiedCount >= expected;
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
  } = {},
): Promise<LibraryCompletionResult> {
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
  if (!isCitationRequestCancellationRequested()) {
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

  await runBounded(
    relationshipTasks,
    RELATIONSHIP_ITEM_PARALLELISM,
    async ({ node, direction, providerWorkIDs, maximum }) => {
      if (isCitationRequestCancellationRequested()) return;
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
          summaryLookupLimit: 0,
          queueBackgroundHydration: true,
          providerWorkIDs,
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
        rememberRelationshipResolution(
          relationshipResolutions,
          node.itemKey,
          direction,
          finalResolution,
        );

        if (
          !isExpectedBoundedResult(relationshipMode, maximum, finalResolution)
        ) {
          relationshipFailures += 1;
          Zotero.debug(
            `Citation Map: ${direction} membership remained incomplete for ${node.itemKey} ` +
              `(${finalResolution.identifiedCount}/${finalResolution.reportedCount ?? "unknown"})`,
          );
        }
      } catch (error) {
        relationshipFailures += 1;
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
    const sourceMetrics = current.sourceMetrics
      ? {
          ...current.sourceMetrics,
          libraryUpdateVersion: LIBRARY_UPDATE_COMPLETION_VERSION,
          libraryUpdateState: {
            ...previousState,
            coreUpdatedAt: current.fetchedAt ?? finalizedAt,
            sourceMetricsUpdatedAt:
              current.sourceMetrics.updatedAt ?? finalizedAt,
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
            providerWorkIDs: {
              ...(previousState.providerWorkIDs ?? {}),
              ...(options.providerIdentitiesByItemKey?.get(record.itemKey) ??
                {}),
            },
          },
        }
      : null;
    if (sourceMetrics) finalRecords.push({ ...current, sourceMetrics });
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
    await yieldToEventLoop();
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
