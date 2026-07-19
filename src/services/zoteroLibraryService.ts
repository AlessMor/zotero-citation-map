import type {
  LibraryCollectionFilter,
  LibrarySnapshot,
  LibraryStatistics,
  ZoteroPaper,
} from "../domain/types";
import { normalizeDOI } from "./citationIdentifiers";
import { getItemCitationMetrics } from "./citationMetricsStore";

function extractYear(value: unknown): number | null {
  const match = String(value ?? "").match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[0]) : null;
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

export async function loadWholeLibrary(
  libraryID: number = Zotero.Libraries.userLibraryID,
): Promise<LibrarySnapshot> {
  const items = await Zotero.Items.getAll(libraryID);
  const papers = (items as Zotero.Item[])
    .filter((item: any) => item?.isRegularItem?.() && !item.deleted)
    .map(toPaper)
    .sort((a, b) => a.title.localeCompare(b.title));
  return {
    libraryID,
    libraryName:
      Zotero.Libraries.getName?.(libraryID) || `Library ${libraryID}`,
    generatedAt: new Date().toISOString(),
    papers,
    collections: collectionFilters(libraryID, papers),
    tags: [...new Set(papers.flatMap((paper) => paper.tags))].sort((a, b) =>
      a.localeCompare(b),
    ),
    statistics: statistics(papers),
  };
}
