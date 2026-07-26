import type { CitationMetricRecord } from "../domain/citationTypes";
import type { CitationGraphNode } from "../domain/graphTypes";
import { isCitationRequestCancellationRequested } from "../providers/http";
import {
  getCitationMetricRecord,
  saveCitationMetricRecord,
} from "./citationMetricsStore";
import { refreshExternalRelationships } from "./externalDiscoveryService";
import { createMetricNodeForItem } from "./itemMetricContext";
import { getCacheDays } from "./citationPreferences";
import type { ProviderIdentityHints } from "./libraryCoreBatchService";
import {
  CITATION_RECORD_WRITE_CHUNK_SIZE,
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
  direction: "references" | "cited-by";
  providerWorkIDs: ProviderIdentityHints;
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
  direction: "references" | "cited-by",
): number {
  const reported =
    direction === "references" ? node.referenceCount : node.citationCount;
  // Unknown totals are endpoint-driven: pagination continues until the provider
  // returns a terminal page instead of assuming an arbitrary 2,500-paper cap.
  return reported == null ? Number.POSITIVE_INFINITY : Math.max(0, reported);
}

function relationshipStateKey(
  direction: "references" | "cited-by",
): "referencesUpdatedAt" | "citedByUpdatedAt" {
  return direction === "references"
    ? "referencesUpdatedAt"
    : "citedByUpdatedAt";
}

function relationshipCompleteKey(
  direction: "references" | "cited-by",
): "referencesComplete" | "citedByComplete" {
  return direction === "references" ? "referencesComplete" : "citedByComplete";
}

function relationshipNeedsRefresh(
  node: CitationGraphNode,
  direction: "references" | "cited-by",
  record: CitationMetricRecord,
  force: boolean,
): boolean {
  if (force || !getStoredRelationshipEntry(node, direction)) return true;
  const state = record.sourceMetrics?.libraryUpdateState;
  if (!state?.[relationshipCompleteKey(direction)]) return true;
  const timestamp = Date.parse(state[relationshipStateKey(direction)] ?? "");
  return (
    !Number.isFinite(timestamp) ||
    Date.now() - timestamp >= getCacheDays() * 86400000
  );
}

/**
 * Finish a Zotero-item update so every library node is graph-ready before the
 * update job completes. External neighbours receive only compact summaries;
 * their advanced fields remain persistently hydrated on demand.
 */
export async function completeLibraryItemUpdates(
  items: Zotero.Item[],
  records: CitationMetricRecord[],
  onProgress?: (progress: LibraryCompletionProgress) => void,
  options: {
    force?: boolean;
    providerIdentitiesByItemKey?: Map<string, ProviderIdentityHints>;
  } = {},
): Promise<LibraryCompletionResult> {
  const itemByKey = new Map(items.map((item) => [String(item.key), item]));
  const relevantItems = records
    .map((record) => itemByKey.get(record.itemKey))
    .filter((item): item is Zotero.Item => Boolean(item));

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
      if (
        relationshipNeedsRefresh(
          node,
          direction,
          record,
          Boolean(options.force),
        )
      ) {
        relationshipTasks.push({ node, direction, providerWorkIDs });
      }
    }
  }
  let relationshipListsUpdated = 0;
  let relationshipFailures = 0;
  let completedRelationships = 0;
  const completedDirections = new Map<string, Set<"references" | "cited-by">>();

  const relationshipConcurrency = RELATIONSHIP_ITEM_PARALLELISM;
  await runBounded(
    relationshipTasks,
    relationshipConcurrency,
    async ({ node, direction, providerWorkIDs }) => {
      if (isCitationRequestCancellationRequested()) return;
      const label = direction === "references" ? "references" : "citing papers";
      onProgress?.({
        phase: "relationships",
        completed: completedRelationships,
        total: relationshipTasks.length,
        message:
          `Retrieving ${label} and paper summaries · ` +
          `${completedRelationships}/${relationshipTasks.length}`,
      });
      try {
        let membershipComplete = false;
        await refreshExternalRelationships(node, nodes, direction, {
          maximum: relationshipMaximum(node, direction),
          refreshMembership: true,
          silent: true,
          summaryLookupLimit: 0,
          queueBackgroundHydration: true,
          providerWorkIDs,
          onMembershipResolved: (resolution) => {
            membershipComplete = resolution.complete;
          },
        });
        relationshipListsUpdated += 1;
        if (membershipComplete) {
          const completedForItem =
            completedDirections.get(node.itemKey) ??
            new Set<"references" | "cited-by">();
          completedForItem.add(direction);
          completedDirections.set(node.itemKey, completedForItem);
        } else {
          relationshipFailures += 1;
          Zotero.debug(
            `Citation Map: ${direction} membership remained incomplete for ${node.itemKey}`,
          );
        }
      } catch (error) {
        relationshipFailures += 1;
        Zotero.debug(
          `Citation Map: full ${direction} update failed for ${node.itemKey}: ${String(error)}`,
        );
      } finally {
        completedRelationships += 1;
        onProgress?.({
          phase: "relationships",
          completed: completedRelationships,
          total: relationshipTasks.length,
          message:
            `Retrieving relationships and paper summaries · ` +
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
    const directions = completedDirections.get(record.itemKey);
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
            referencesUpdatedAt: directions?.has("references")
              ? finalizedAt
              : (previousState.referencesUpdatedAt ?? null),
            citedByUpdatedAt: directions?.has("cited-by")
              ? finalizedAt
              : (previousState.citedByUpdatedAt ?? null),
            referencesComplete: directions?.has("references")
              ? true
              : (previousState.referencesComplete ?? false),
            citedByComplete: directions?.has("cited-by")
              ? true
              : (previousState.citedByComplete ?? false),
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
  }

  onProgress?.({
    phase: "finalizing",
    completed: records.length,
    total: records.length,
    message: "Finalizing complete library-item metrics",
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
