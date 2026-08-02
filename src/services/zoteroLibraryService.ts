import type {
  LibraryCollectionFilter,
  LibrarySnapshot,
  LibraryStatistics,
  ZoteroPaper,
} from "../domain/types";
import { normalizeDOI } from "../domain/workIdentity";
import { getItemCitationMetrics } from "./citationMetricsStore";
import { createCooperativeCheckpoint } from "./backgroundTaskService";

const pendingLibraryLoads = new Map<number, Promise<LibrarySnapshot>>();
const cachedLibrarySnapshots = new Map<number, LibrarySnapshot>();
const cachedLibraryAccessOrder: number[] = [];
const dirtyLibraryMetrics = new Set<number>();
const librarySnapshotGeneration = new Map<number, number>();
const MAX_CACHED_LIBRARY_SNAPSHOTS = 2;
const LIBRARY_LOAD_FORCE_YIELD_INTERVAL = 20;
const LIBRARY_METRIC_FORCE_YIELD_INTERVAL = 100;

function touchCachedLibrary(libraryID: number): void {
  const existing = cachedLibraryAccessOrder.indexOf(libraryID);
  if (existing >= 0) cachedLibraryAccessOrder.splice(existing, 1);
  cachedLibraryAccessOrder.push(libraryID);
  while (cachedLibraryAccessOrder.length > MAX_CACHED_LIBRARY_SNAPSHOTS) {
    const evicted = cachedLibraryAccessOrder.shift();
    if (evicted === undefined) continue;
    cachedLibrarySnapshots.delete(evicted);
    dirtyLibraryMetrics.delete(evicted);
  }
}

export function invalidateWholeLibrarySnapshot(libraryID?: number): void {
  if (typeof libraryID === "number" && Number.isFinite(libraryID)) {
    librarySnapshotGeneration.set(
      libraryID,
      (librarySnapshotGeneration.get(libraryID) ?? 0) + 1,
    );
    cachedLibrarySnapshots.delete(libraryID);
    pendingLibraryLoads.delete(libraryID);
    dirtyLibraryMetrics.delete(libraryID);
    const index = cachedLibraryAccessOrder.indexOf(libraryID);
    if (index >= 0) cachedLibraryAccessOrder.splice(index, 1);
    return;
  }
  for (const cachedLibraryID of new Set([
    ...cachedLibrarySnapshots.keys(),
    ...pendingLibraryLoads.keys(),
  ])) {
    librarySnapshotGeneration.set(
      cachedLibraryID,
      (librarySnapshotGeneration.get(cachedLibraryID) ?? 0) + 1,
    );
  }
  cachedLibrarySnapshots.clear();
  pendingLibraryLoads.clear();
  cachedLibraryAccessOrder.splice(0);
  dirtyLibraryMetrics.clear();
}

export function markWholeLibraryMetricsDirty(libraryID?: number): void {
  if (typeof libraryID === "number" && Number.isFinite(libraryID)) {
    if (cachedLibrarySnapshots.has(libraryID))
      dirtyLibraryMetrics.add(libraryID);
    return;
  }
  for (const cachedLibraryID of cachedLibrarySnapshots.keys()) {
    dirtyLibraryMetrics.add(cachedLibraryID);
  }
}

export function clearWholeLibrarySnapshotCache(): void {
  invalidateWholeLibrarySnapshot();
}

function yieldToZoteroUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function extractYear(value: unknown): number | null {
  const match = String(value ?? "").match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[0]) : null;
}

function publicationDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function title(item: any): string {
  return (
    item.getDisplayTitle?.() ||
    item.getField?.("title") ||
    item.getField?.("shortTitle") ||
    `Untitled item ${item.id}`
  );
}

function authors(item: any): string[] {
  return (item.getCreators?.() ?? [])
    .map((creator: any) =>
      String(
        creator.name ??
          [creator.firstName, creator.lastName].filter(Boolean).join(" "),
      ).trim(),
    )
    .filter(Boolean);
}

function tags(item: any): string[] {
  return (item.getTags?.() ?? [])
    .map((entry: any) =>
      String(typeof entry === "string" ? entry : (entry?.tag ?? "")).trim(),
    )
    .filter(Boolean)
    .sort((a: string, b: string) => a.localeCompare(b));
}

function collectionIDs(item: any): number[] {
  return (item.getCollections?.() ?? [])
    .map((value: unknown) => Number(value))
    .filter(Number.isFinite);
}

export function calculateItemMetadataCompleteness(item: any): number {
  const checks = [
    String(item.getField?.("title") ?? "").trim().length > 0,
    (item.getCreators?.() ?? []).length > 0,
    extractYear(item.getField?.("date")) !== null,
    String(
      item.getField?.("publicationTitle") ??
        item.getField?.("conferenceName") ??
        item.getField?.("publisher") ??
        "",
    ).trim().length > 0,
    String(item.getField?.("abstractNote") ?? "").trim().length > 0,
    [
      item.getField?.("DOI"),
      item.getField?.("ISBN"),
      item.getField?.("ISSN"),
      item.getField?.("url"),
      item.getField?.("extra"),
    ].some((value) => String(value ?? "").trim().length > 0),
  ];
  return checks.filter(Boolean).length / checks.length;
}

function toPaper(item: any): ZoteroPaper {
  const libraryID = Number(item.libraryID);
  const itemKey = String(item.key);
  return {
    itemID: Number(item.id),
    itemKey,
    libraryID,
    title: title(item),
    authors: authors(item),
    year: extractYear(item.getField?.("date")),
    publicationDate: publicationDate(item.getField?.("date")),
    doi: normalizeDOI(item.getField?.("DOI")),
    abstract: String(item.getField?.("abstractNote") ?? "").trim() || null,
    sourceTitle:
      String(
        item.getField?.("publicationTitle") ??
          item.getField?.("conferenceName") ??
          item.getField?.("publisher") ??
          "",
      ).trim() || null,
    tags: tags(item),
    collectionIDs: collectionIDs(item),
    metadataCompleteness: calculateItemMetadataCompleteness(item),
    metrics: getItemCitationMetrics(libraryID, itemKey),
  };
}

function statistics(papers: ZoteroPaper[]): LibraryStatistics {
  return {
    totalPapers: papers.length,
    withoutYear: papers.filter((paper) => paper.year === null).length,
    withoutDOI: papers.filter((paper) => paper.doi === null).length,
    withoutCitationData: papers.filter(
      (paper) => paper.metrics.citationCount === null,
    ).length,
    withoutReferenceData: papers.filter(
      (paper) => paper.metrics.referenceCount === null,
    ).length,
  };
}

interface CollectionInfo {
  collectionID: number;
  key: string;
  name: string;
  parentID: number | null;
  orderIndex: number;
}

function allCollectionInfo(
  libraryID: number,
  papers: ZoteroPaper[],
): Map<number, CollectionInfo> {
  const info = new Map<number, CollectionInfo>();
  try {
    const collections =
      (Zotero.Collections as any).getByLibrary?.(libraryID, true) ?? [];
    collections.forEach((collection: any, index: number) => {
      const id = Number(collection.id ?? collection.collectionID);
      if (!Number.isFinite(id)) return;
      const parent = Number(
        collection.parentID ?? collection.parentCollectionID ?? 0,
      );
      info.set(id, {
        collectionID: id,
        key: String(collection.key ?? id),
        name: String(collection.name ?? `Collection ${id}`),
        parentID: Number.isFinite(parent) && parent > 0 ? parent : null,
        orderIndex: index,
      });
    });
  } catch {
    // Collection enumeration may be unavailable for some library contexts.
  }
  const pending = new Set(papers.flatMap((paper) => paper.collectionIDs));
  while (pending.size) {
    const id = pending.values().next().value as number;
    pending.delete(id);
    if (info.has(id)) continue;
    try {
      const collection = Zotero.Collections.get(id) as any;
      if (!collection) continue;
      const parent = Number(
        collection.parentID ?? collection.parentCollectionID ?? 0,
      );
      info.set(id, {
        collectionID: id,
        key: String(collection.key ?? id),
        name: String(collection.name ?? `Collection ${id}`),
        parentID: Number.isFinite(parent) && parent > 0 ? parent : null,
        orderIndex: info.size,
      });
      if (parent > 0 && !info.has(parent)) pending.add(parent);
    } catch {
      // Ignore inaccessible or deleted collection records.
    }
  }
  return info;
}

function collectionFilters(
  libraryID: number,
  papers: ZoteroPaper[],
): LibraryCollectionFilter[] {
  const info = allCollectionInfo(libraryID, papers);
  const children = new Map<number, number[]>();
  for (const collection of info.values()) {
    if (!collection.parentID) continue;
    const list = children.get(collection.parentID) ?? [];
    list.push(collection.collectionID);
    children.set(collection.parentID, list);
  }
  for (const list of children.values()) {
    list.sort(
      (a, b) => (info.get(a)?.orderIndex ?? 0) - (info.get(b)?.orderIndex ?? 0),
    );
  }
  const descendants = (id: number): number[] => {
    const output = [id];
    const queue = [...(children.get(id) ?? [])];
    const seen = new Set(output);
    while (queue.length) {
      const child = queue.shift()!;
      if (seen.has(child)) continue;
      seen.add(child);
      output.push(child);
      queue.push(...(children.get(child) ?? []));
    }
    return output;
  };
  const pathAndDepth = (id: number): { path: string; depth: number } => {
    const parts: string[] = [];
    const seen = new Set<number>();
    let current: number | null = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const entry = info.get(current);
      if (!entry) break;
      parts.unshift(entry.name);
      current = entry.parentID;
    }
    return { path: parts.join(" / "), depth: Math.max(0, parts.length - 1) };
  };
  return [...info.values()]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((entry) => {
      const located = pathAndDepth(entry.collectionID);
      return {
        collectionID: entry.collectionID,
        parentCollectionID: entry.parentID,
        key: entry.key,
        name: entry.name,
        path: located.path,
        depth: located.depth,
        orderIndex: entry.orderIndex,
        includedCollectionIDs: descendants(entry.collectionID),
      };
    });
}

async function buildWholeLibrarySnapshot(
  libraryID: number = Zotero.Libraries.userLibraryID,
): Promise<LibrarySnapshot> {
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  const items = await Zotero.Items.getAll(libraryID);
  const papers: ZoteroPaper[] = [];
  const libraryItems = items as Zotero.Item[];
  const checkpoint = createCooperativeCheckpoint(7);
  for (let index = 0; index < libraryItems.length; index += 1) {
    const item = libraryItems[index] as any;
    if (item?.isRegularItem?.() && !item.deleted) papers.push(toPaper(item));
    await checkpoint((index + 1) % LIBRARY_LOAD_FORCE_YIELD_INTERVAL === 0);
  }
  const titleCollator = new Intl.Collator(undefined, {
    sensitivity: "base",
    numeric: true,
  });
  papers.sort((a, b) => titleCollator.compare(a.title, b.title));
  await yieldToZoteroUI();
  const collections = collectionFilters(libraryID, papers);
  await yieldToZoteroUI();
  const libraryTags = [...new Set(papers.flatMap((paper) => paper.tags))].sort(
    (a, b) => titleCollator.compare(a, b),
  );
  const snapshot: LibrarySnapshot = {
    libraryID,
    libraryName:
      Zotero.Libraries.getName?.(libraryID) || `Library ${libraryID}`,
    generatedAt: new Date().toISOString(),
    papers,
    collections,
    tags: libraryTags,
    statistics: statistics(papers),
  };
  const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
  if (elapsed >= 500) {
    Zotero.debug(
      `Citation Map: prepared ${papers.length} library papers in ${Math.round(elapsed)} ms`,
    );
  }
  return snapshot;
}

async function refreshCachedSnapshotMetrics(
  snapshot: LibrarySnapshot,
): Promise<LibrarySnapshot> {
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  const checkpoint = createCooperativeCheckpoint(7);
  for (let index = 0; index < snapshot.papers.length; index += 1) {
    const paper = snapshot.papers[index];
    paper.metrics = getItemCitationMetrics(snapshot.libraryID, paper.itemKey);
    await checkpoint((index + 1) % LIBRARY_METRIC_FORCE_YIELD_INTERVAL === 0);
  }
  snapshot.generatedAt = new Date().toISOString();
  snapshot.statistics = statistics(snapshot.papers);
  dirtyLibraryMetrics.delete(snapshot.libraryID);
  touchCachedLibrary(snapshot.libraryID);
  const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
  if (elapsed >= 500) {
    Zotero.debug(
      `Citation Map: refreshed ${snapshot.papers.length} cached paper metrics in ${Math.round(elapsed)} ms`,
    );
  }
  return snapshot;
}

export function loadWholeLibrary(
  libraryID: number = Zotero.Libraries.userLibraryID,
): Promise<LibrarySnapshot> {
  const existing = pendingLibraryLoads.get(libraryID);
  if (existing) return existing;

  const cached = cachedLibrarySnapshots.get(libraryID);
  if (cached && !dirtyLibraryMetrics.has(libraryID)) {
    touchCachedLibrary(libraryID);
    return Promise.resolve(cached);
  }

  const generation = librarySnapshotGeneration.get(libraryID) ?? 0;
  const operation = cached
    ? refreshCachedSnapshotMetrics(cached)
    : buildWholeLibrarySnapshot(libraryID).then((snapshot) => {
        if ((librarySnapshotGeneration.get(libraryID) ?? 0) === generation) {
          cachedLibrarySnapshots.set(libraryID, snapshot);
          dirtyLibraryMetrics.delete(libraryID);
          touchCachedLibrary(libraryID);
        }
        return snapshot;
      });
  const pending = operation.finally(() => {
    if (pendingLibraryLoads.get(libraryID) === pending) {
      pendingLibraryLoads.delete(libraryID);
    }
  });
  pendingLibraryLoads.set(libraryID, pending);
  return pending;
}
