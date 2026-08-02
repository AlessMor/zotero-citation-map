import type {
  CitationMetricRecord,
  CitationProviderPreference,
  LibraryUpdateState,
  RelationshipUpdateStatus,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { extractWorkIdentifiers } from "./citationIdentifiers";
import {
  getCitationMetricRecord,
  shouldRefreshCitationMetrics,
} from "./citationMetricsStore";
import { getCacheDays, isProviderEnabled } from "./citationPreferences";
import {
  getStoredRelationshipSummary,
  type RelationshipStoreSubject,
  type StoredRelationshipDirection,
} from "./relationshipStoreService";

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

interface RelationshipStateValues {
  updatedAt: string | null | undefined;
  complete: boolean;
  loadedCount: number | undefined;
  reportedCount: number | null | undefined;
  status: RelationshipUpdateStatus | undefined;
  nextRetryAt: string | null | undefined;
}

function relationshipStateValues(
  state: LibraryUpdateState,
  direction: StoredRelationshipDirection,
): RelationshipStateValues {
  return direction === "references"
    ? {
        updatedAt: state.referencesUpdatedAt,
        complete: Boolean(state.referencesComplete),
        loadedCount: state.referencesLoadedCount,
        reportedCount: state.referencesReportedCount,
        status: state.referencesStatus,
        nextRetryAt: state.referencesNextRetryAt,
      }
    : {
        updatedAt: state.citedByUpdatedAt,
        complete: Boolean(state.citedByComplete),
        loadedCount: state.citedByLoadedCount,
        reportedCount: state.citedByReportedCount,
        status: state.citedByStatus,
        nextRetryAt: state.citedByNextRetryAt,
      };
}

function retryIsDeferred(value: string | null | undefined): boolean {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function relationshipFirstHopIsCurrent(
  subject: RelationshipStoreSubject,
  state: LibraryUpdateState,
  direction: StoredRelationshipDirection,
  maxAgeMs: number,
): boolean {
  const values = relationshipStateValues(state, direction);

  // Absence of relationship state is not a migration trigger. Existing citation
  // records remain current and relationship summaries are populated the next
  // time their core record is genuinely refreshed or the user opens the list.
  if (
    values.status === undefined &&
    values.updatedAt == null &&
    values.nextRetryAt == null
  ) {
    return true;
  }

  if (values.status === "unavailable") {
    return retryIsDeferred(values.nextRetryAt);
  }

  const summary = getStoredRelationshipSummary(subject, direction);
  const timestamp = Date.parse(values.updatedAt ?? summary?.fetchedAt ?? "");
  if (!Number.isFinite(timestamp) || Date.now() - timestamp >= maxAgeMs) {
    return false;
  }

  if (values.status === "empty") return true;
  if (values.status === "complete" || values.complete) return Boolean(summary);
  if (values.status === "first-hop-ready") return Boolean(summary);

  // Lazily migrate the first one-hop format. A confirmed empty result remains
  // current, but non-empty legacy state is current only when the selected
  // relationship row actually exists. The next completion refresh persists
  // the explicit status fields and removes this compatibility path naturally.
  if (values.reportedCount === 0 && (values.loadedCount ?? 0) === 0)
    return true;
  return Boolean(summary);
}

function hasCurrentLibraryUpdate(
  item: Zotero.Item,
  record: CitationMetricRecord | null,
): boolean {
  if (!record || record.status !== "success") return false;

  const state = record.sourceMetrics?.libraryUpdateState;
  if (!state) return true;

  const subject: RelationshipStoreSubject = {
    itemID: Number(item.id),
    itemKey: String(item.key),
    doi: record.doi,
    provider: record.provider,
    providerWorkID: record.providerWorkID,
    title: record.title ?? String(item.getField?.("title") ?? ""),
    year: record.year,
  };
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
    const storedCountProviderDisabled = Boolean(
      (previous?.citationCountProvider &&
        !isProviderEnabled(previous.citationCountProvider)) ||
      (previous?.referenceCountProvider &&
        !isProviderEnabled(previous.referenceCountProvider)),
    );
    const needsCoreRefresh =
      force ||
      storedCountProviderDisabled ||
      shouldRefreshCitationMetrics(
        libraryID,
        itemKey,
        provider,
        getCacheDays(),
      );
    const needsCompletionRefresh = !hasCurrentLibraryUpdate(item, previous);
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
