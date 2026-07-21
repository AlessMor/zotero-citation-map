import type { RelatedWorkMetadata } from "../domain/citationTypes";
import type {
  CitationGraphModel,
  CitationGraphNode,
} from "../domain/graphTypes";
import {
  getCachedExternalCitedBy,
  getCachedExternalReferences,
  type ExternalWork,
} from "./externalDiscoveryService";
import { getCitationMetricRecord } from "./citationMetricsStore";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";

export type RelationshipViewDirection = "references" | "cited-by";
export const RELATIONSHIP_VIEW_LIMIT = 2500;

export type RelationshipSortKey =
  | "newest"
  | "oldest"
  | "date-saved"
  | "date-updated"
  | "title"
  | "most-cited"
  | "most-references";

export const relationshipSortOptions: ReadonlyArray<{
  value: RelationshipSortKey;
  label: string;
}> = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "date-saved", label: "Date saved" },
  { value: "date-updated", label: "Date updated" },
  { value: "title", label: "Title" },
  { value: "most-cited", label: "Most cited" },
  { value: "most-references", label: "Most references" },
];

export interface RelationshipMutationEvent {
  origin: "item-pane" | "graph";
  libraryID: number;
  subjectItemKey: string;
  direction: RelationshipViewDirection;
  work: ExternalWork;
  ignored: boolean;
}

type RelationshipMutationListener = (event: RelationshipMutationEvent) => void;

const relationshipMutationListeners = new Set<RelationshipMutationListener>();

export function subscribeRelationshipMutations(
  listener: RelationshipMutationListener,
): () => void {
  relationshipMutationListeners.add(listener);
  return () => relationshipMutationListeners.delete(listener);
}

export function notifyRelationshipMutation(
  event: RelationshipMutationEvent,
): void {
  for (const listener of [...relationshipMutationListeners]) {
    try {
      listener(event);
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}

export interface RelationshipViewSnapshot {
  direction: RelationshipViewDirection;
  works: ExternalWork[];
  reportedCount: number | null;
  relationshipLabel: "reference" | "citation";
  providerLabel: "references" | "citations";
}

function itemByKey(libraryID: number, itemKey: string): Zotero.Item | null {
  try {
    return (
      (Zotero.Items as any).getByLibraryAndKey?.(libraryID, itemKey) ?? null
    );
  } catch {
    return null;
  }
}

function graphNodeAsExternalWork(node: CitationGraphNode): ExternalWork {
  return {
    provider: "zotero",
    providerWorkID: node.itemKey,
    doi: node.doi,
    title: node.title,
    year: node.year,
    authors: node.authors,
    sourceTitle: node.sourceTitle,
    abstract: node.abstract,
    citationCount: node.citationCount,
    referenceCount: node.referenceCount,
    isOpenAccess: node.isOpenAccess,
    openAccessStatus: node.openAccessStatus,
    isRetracted: node.isRetracted,
    zoteroItemKey: node.itemKey,
    inLibraryItemKey: node.itemKey,
  };
}

function nodeIndex(graph: CitationGraphModel): Map<string, CitationGraphNode> {
  const byKey = new Map<string, CitationGraphNode>();
  for (const node of graph.nodes) {
    byKey.set(node.key, node);
    byKey.set(node.itemKey, node);
  }
  return byKey;
}

function graphRelationshipWorks(
  graph: CitationGraphModel,
  node: CitationGraphNode,
  direction: RelationshipViewDirection,
): ExternalWork[] {
  const subjectKeys = new Set([node.key, node.itemKey]);
  const relatedKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (direction === "references" && subjectKeys.has(edge.source)) {
      relatedKeys.add(edge.target);
    } else if (direction === "cited-by" && subjectKeys.has(edge.target)) {
      relatedKeys.add(edge.source);
    }
  }
  const byKey = nodeIndex(graph);
  return [...relatedKeys]
    .map((key) => byKey.get(key))
    .filter((candidate): candidate is CitationGraphNode => Boolean(candidate))
    .map(graphNodeAsExternalWork);
}

export function relationshipWorkKey(work: ExternalWork): string {
  const localKey = work.inLibraryItemKey ?? work.zoteroItemKey;
  if (localKey) return `zotero:${localKey}`;
  const doi = normalizeDOI(work.doi);
  if (doi) return `doi:${doi}`;
  if (work.providerWorkID) {
    return `${work.provider}:${String(work.providerWorkID).toLocaleLowerCase()}`;
  }
  const title = normalizeExactTitle(work.title);
  return title ? `title:${title}` : `${work.provider}:unknown`;
}

export function mergeRelationshipWorks(
  ...groups: ExternalWork[][]
): ExternalWork[] {
  const merged = new Map<string, ExternalWork>();
  for (const group of groups) {
    for (const work of group) {
      const key = relationshipWorkKey(work);
      const previous = merged.get(key);
      if (!previous) {
        merged.set(key, work);
        continue;
      }
      merged.set(key, {
        ...previous,
        ...work,
        provider:
          previous.provider === "manual" || previous.provider !== "zotero"
            ? previous.provider
            : work.provider,
        providerWorkID: previous.providerWorkID ?? work.providerWorkID,
        doi: previous.doi ?? work.doi,
        title: previous.title?.trim() ? previous.title : work.title,
        year: previous.year ?? work.year,
        authors: previous.authors.length ? previous.authors : work.authors,
        sourceTitle: previous.sourceTitle ?? work.sourceTitle,
        abstract: previous.abstract ?? work.abstract,
        citationCount: previous.citationCount ?? work.citationCount,
        referenceCount: previous.referenceCount ?? work.referenceCount,
        zoteroItemKey: previous.zoteroItemKey ?? work.zoteroItemKey,
        inLibraryItemKey:
          previous.inLibraryItemKey ?? work.inLibraryItemKey ?? null,
      });
    }
  }
  return [...merged.values()];
}

export function getRelationshipReportedCounts(
  libraryID: number,
  node: CitationGraphNode,
): { citationCount: number | null; referenceCount: number | null } {
  const record = getCitationMetricRecord(libraryID, node.itemKey);
  return {
    citationCount: record?.citationCount ?? node.citationCount,
    referenceCount: record?.referenceCount ?? node.referenceCount,
  };
}

export function getRelationshipViewSnapshot(
  graph: CitationGraphModel,
  node: CitationGraphNode,
  direction: RelationshipViewDirection,
  libraryID: number,
  maximum = RELATIONSHIP_VIEW_LIMIT,
): RelationshipViewSnapshot {
  const record = getCitationMetricRecord(libraryID, node.itemKey);
  const graphWorks = graphRelationshipWorks(graph, node, direction);
  const stored =
    direction === "references"
      ? getCachedExternalReferences(node, graph.nodes, maximum, 0)
      : getCachedExternalCitedBy(node, graph.nodes, maximum, 0);
  const works = mergeRelationshipWorks(stored, graphWorks).slice(0, maximum);
  const reportedCount =
    direction === "references"
      ? (record?.referenceCount ?? node.referenceCount)
      : (record?.citationCount ?? node.citationCount);
  return {
    direction,
    works,
    reportedCount,
    relationshipLabel: direction === "references" ? "reference" : "citation",
    providerLabel: direction === "references" ? "references" : "citations",
  };
}

function referenceMatchesExternalWork(
  reference: RelatedWorkMetadata,
  work: ExternalWork,
): boolean {
  if (
    reference.zoteroItemKey &&
    (reference.zoteroItemKey === work.inLibraryItemKey ||
      reference.zoteroItemKey === work.zoteroItemKey)
  ) {
    return true;
  }
  const referenceDOI = normalizeDOI(reference.doi);
  const workDOI = normalizeDOI(work.doi);
  if (referenceDOI && workDOI && referenceDOI === workDOI) return true;
  if (
    reference.provider === work.provider &&
    reference.providerWorkID &&
    work.providerWorkID &&
    String(reference.providerWorkID).toLocaleLowerCase() ===
      String(work.providerWorkID).toLocaleLowerCase()
  ) {
    return true;
  }
  const referenceTitle = normalizeExactTitle(reference.title);
  const workTitle = normalizeExactTitle(work.title);
  if (!referenceTitle || !workTitle || referenceTitle !== workTitle)
    return false;
  return (
    reference.year === null ||
    work.year === null ||
    Math.abs(reference.year - work.year) <= 1
  );
}

export function relationshipPreviewSourceKeys(
  graph: CitationGraphModel,
  subject: CitationGraphNode,
  work: ExternalWork,
  visibleKeys: Set<string>,
): string[] {
  const connected = new Set<string>();
  if (visibleKeys.has(subject.key)) connected.add(subject.key);
  if (visibleKeys.has(subject.itemKey)) connected.add(subject.itemKey);

  for (const key of work.citingNodeKeys ?? []) {
    if (visibleKeys.has(key)) connected.add(key);
  }

  const localKey = work.inLibraryItemKey ?? work.zoteroItemKey;
  if (localKey) {
    for (const edge of graph.edges) {
      if (edge.source === localKey && visibleKeys.has(edge.target)) {
        connected.add(edge.target);
      }
      if (edge.target === localKey && visibleKeys.has(edge.source)) {
        connected.add(edge.source);
      }
    }
  }

  for (const candidate of graph.nodes) {
    if (!visibleKeys.has(candidate.key)) continue;
    if (
      candidate.references.some((reference) =>
        referenceMatchesExternalWork(reference, work),
      )
    ) {
      connected.add(candidate.key);
    }
  }
  return [...connected];
}

function workItemTimestamp(
  work: ExternalWork,
  libraryID: number,
  field: "dateAdded" | "dateModified",
): number | null {
  const itemKey = work.inLibraryItemKey ?? work.zoteroItemKey;
  if (!itemKey) return null;
  const item = itemByKey(libraryID, itemKey);
  if (!item) return null;
  const raw = String(
    (item as any)[field] ?? (item as any).getField?.(field) ?? "",
  ).trim();
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareNullableNumbers(
  left: number | null | undefined,
  right: number | null | undefined,
  direction: "ascending" | "descending",
): number {
  const a = typeof left === "number" && Number.isFinite(left) ? left : null;
  const b = typeof right === "number" && Number.isFinite(right) ? right : null;
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === "ascending" ? a - b : b - a;
}

export function sortRelationshipEntries<
  T extends { work: ExternalWork; providerOrder: number },
>(entries: T[], key: RelationshipSortKey, libraryID: number): T[] {
  return [...entries].sort((left, right) => {
    let comparison = 0;
    if (key === "newest") {
      comparison = compareNullableNumbers(
        left.work.year,
        right.work.year,
        "descending",
      );
    } else if (key === "oldest") {
      comparison = compareNullableNumbers(
        left.work.year,
        right.work.year,
        "ascending",
      );
    } else if (key === "date-saved") {
      comparison = compareNullableNumbers(
        workItemTimestamp(left.work, libraryID, "dateAdded"),
        workItemTimestamp(right.work, libraryID, "dateAdded"),
        "descending",
      );
    } else if (key === "date-updated") {
      comparison = compareNullableNumbers(
        workItemTimestamp(left.work, libraryID, "dateModified"),
        workItemTimestamp(right.work, libraryID, "dateModified"),
        "descending",
      );
    } else if (key === "title") {
      comparison = String(left.work.title ?? "").localeCompare(
        String(right.work.title ?? ""),
        undefined,
        { sensitivity: "base" },
      );
    } else if (key === "most-cited") {
      comparison = compareNullableNumbers(
        left.work.citationCount,
        right.work.citationCount,
        "descending",
      );
    } else if (key === "most-references") {
      comparison = compareNullableNumbers(
        left.work.referenceCount,
        right.work.referenceCount,
        "descending",
      );
    }
    return comparison || left.providerOrder - right.providerOrder;
  });
}

export function relationshipUpdateText(
  direction: RelationshipViewDirection,
): string {
  return direction === "references"
    ? "Updating reference papers…"
    : "Updating citing papers…";
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { useGrouping: false }).format(value);
}

export function relationshipStatusText(
  snapshot: RelationshipViewSnapshot,
  shownCount = snapshot.works.length,
  filtered = false,
  searching = false,
): string {
  const total = snapshot.works.length;
  const suffix = total === 1 ? "" : "s";
  const local = filtered
    ? `${formatCount(shownCount)} shown of ${formatCount(total)} ` +
      `${snapshot.relationshipLabel} relationship${suffix}`
    : `${formatCount(total)} ${snapshot.relationshipLabel} ` +
      `relationship${suffix}`;
  const provider =
    snapshot.reportedCount === null
      ? ""
      : ` · provider reports ${formatCount(snapshot.reportedCount)} ` +
        snapshot.providerLabel;
  return searching
    ? `${local}${provider} · ${relationshipUpdateText(snapshot.direction)}`
    : `${local}${provider}`;
}
