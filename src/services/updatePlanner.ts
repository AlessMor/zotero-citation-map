import type {
  CitationMetricRecord,
  CitationProviderPreference,
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
} from "./relationshipStoreService";
import { LIBRARY_UPDATE_COMPLETION_VERSION } from "./libraryUpdatePolicy";

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
  const maxAgeMs = getCacheDays() * 86400000;
  const fresh = (value: string | null | undefined): boolean => {
    const timestamp = Date.parse(value ?? "");
    return Number.isFinite(timestamp) && Date.now() - timestamp < maxAgeMs;
  };
  return Boolean(
    state?.referencesComplete &&
    state.citedByComplete &&
    fresh(state.referencesUpdatedAt) &&
    fresh(state.citedByUpdatedAt) &&
    getStoredRelationshipEntry(subject, "references") &&
    getStoredRelationshipEntry(subject, "cited-by"),
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
