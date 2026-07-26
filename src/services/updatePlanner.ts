import type {
  CitationMetricRecord,
  CitationProviderPreference,
  LibraryUpdateState,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { extractWorkIdentifiers } from "./citationIdentifiers";
import {
  getCitationMetricRecord,
  shouldRefreshCitationMetrics,
} from "./citationMetricsStore";
import { getCacheDays } from "./citationPreferences";
import {
  getStoredRelationshipEntry,
  type RelationshipStoreSubject,
  type StoredRelationshipDirection,
} from "./relationshipStoreService";
import { LIBRARY_UPDATE_COMPLETION_VERSION } from "./libraryUpdatePolicy";
import { RELATIONSHIP_BULK_EAGER_LIMIT } from "./providerExecutionPolicy";

export interface PlannedCitationItem {
  item: Zotero.Item;
  libraryID: number;
  itemKey: string;
  previous: CitationMetricRecord | null;
  identifiers: WorkIdentifiers;
  /** Core provider metrics need a network refresh; false means only later phases are stale. */
  needsCoreRefresh: boolean;
}

export interface CitationUpdatePlan {
  items: Zotero.Item[];
  pending: PlannedCitationItem[];
  cached: number;
}

function relationshipStateValues(
  state: LibraryUpdateState,
  direction: StoredRelationshipDirection,
): {
  updatedAt: string | null | undefined;
  complete: boolean;
  loadedCount: number | undefined;
  reportedCount: number | null | undefined;
} {
  return direction === "references"
    ? {
        updatedAt: state.referencesUpdatedAt,
        complete: Boolean(state.referencesComplete),
        loadedCount: state.referencesLoadedCount,
        reportedCount: state.referencesReportedCount,
      }
    : {
        updatedAt: state.citedByUpdatedAt,
        complete: Boolean(state.citedByComplete),
        loadedCount: state.citedByLoadedCount,
        reportedCount: state.citedByReportedCount,
      };
}

function relationshipFirstHopIsCurrent(
  subject: RelationshipStoreSubject,
  state: LibraryUpdateState,
  direction: StoredRelationshipDirection,
  maxAgeMs: number,
): boolean {
  const entry = getStoredRelationshipEntry(subject, direction);
  if (!entry) return false;
  const values = relationshipStateValues(state, direction);
  const timestamp = Date.parse(values.updatedAt ?? "");
  if (!Number.isFinite(timestamp) || Date.now() - timestamp >= maxAgeMs) {
    return false;
  }
  if (values.complete) return true;

  const loadedCount = values.loadedCount ?? entry.works.length;
  const target = Math.min(
    RELATIONSHIP_BULK_EAGER_LIMIT,
    values.reportedCount == null
      ? RELATIONSHIP_BULK_EAGER_LIMIT
      : Math.max(0, values.reportedCount),
  );
  return loadedCount >= target;
}

function hasCompleteLibraryUpdate(
  item: Zotero.Item,
  record: CitationMetricRecord | null,
): boolean {
  if (
    !record ||
    record.status !== "success" ||
    record.sourceMetrics?.libraryUpdateVersion !==
      LIBRARY_UPDATE_COMPLETION_VERSION
  ) {
    return false;
  }
  const subject: RelationshipStoreSubject = {
    itemID: Number(item.id),
    itemKey: String(item.key),
    doi: record.doi,
    provider: record.provider,
    providerWorkID: record.providerWorkID,
    title: record.title ?? String(item.getField?.("title") ?? ""),
    year: record.year,
  };
  const state = record.sourceMetrics.libraryUpdateState;
  if (!state) return false;
  const maxAgeMs = getCacheDays() * 86400000;
  return (
    relationshipFirstHopIsCurrent(subject, state, "references", maxAgeMs) &&
    relationshipFirstHopIsCurrent(subject, state, "cited-by", maxAgeMs)
  );
}

export function regularCitationItems(items: Zotero.Item[]): Zotero.Item[] {
  const unique = new Map<string, Zotero.Item>();
  for (const item of items) {
    if (!item || !item.isRegularItem?.() || item.deleted) continue;
    unique.set(`${Number(item.libraryID)}:${String(item.key)}`, item);
  }
  return [...unique.values()];
}

/**
 * Prepare all local work before any provider request starts. Identifiers and
 * previous records are loaded once, and current items are removed from the
 * network plan immediately.
 */
export function createCitationUpdatePlan(
  input: Zotero.Item[],
  provider: CitationProviderPreference,
  force: boolean,
): CitationUpdatePlan {
  const items = regularCitationItems(input);
  const pending: PlannedCitationItem[] = [];
  let cached = 0;

  for (const item of items) {
    const libraryID = Number(item.libraryID);
    const itemKey = String(item.key);
    const previous = getCitationMetricRecord(libraryID, itemKey);
    const needsCoreRefresh =
      force ||
      shouldRefreshCitationMetrics(
        libraryID,
        itemKey,
        provider,
        getCacheDays(),
      );
    const needsCompletionRefresh = !hasCompleteLibraryUpdate(item, previous);
    if (!needsCoreRefresh && !needsCompletionRefresh) {
      cached += 1;
      continue;
    }

    const extracted = extractWorkIdentifiers(item);
    pending.push({
      item,
      libraryID,
      itemKey,
      previous,
      identifiers: {
        ...extracted,
        doi: extracted.doi ?? (previous?.matchConfirmed ? previous.doi : null),
      },
      needsCoreRefresh,
    });
  }

  return { items, pending, cached };
}
