import type {
  LibraryCollectionFilter,
  LibrarySnapshot,
  LibraryStatistics,
  ZoteroPaper,
} from "../domain/types";
import { getItemCitationMetrics } from "./citationMetricsStore";

/** Extract a four-digit publication year from a Zotero date field. */
function extractYear(value: unknown): number | null {
  const text = String(value ?? "").trim();

  if (!text) {
    return null;
  }

  const match = text.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[0]) : null;
}

/** Normalize common DOI representations to a lowercase bare DOI. */
function normalizeDOI(value: unknown): string | null {
  const text = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();

  if (!text) {
    return null;
  }

  const match = text.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? match[0].toLowerCase() : null;
}

function getTitle(item: any): string {
  return (
    item.getDisplayTitle?.() ||
    item.getField?.("title") ||
    item.getField?.("shortTitle") ||
    `Untitled item ${item.id}`
  );
}

function getAuthors(item: any): string[] {
  const creators = item.getCreators?.() ?? [];

  return creators
    .map((creator: any) => {
      if (creator.name) {
        return String(creator.name).trim();
      }

      const firstName = String(creator.firstName ?? "").trim();
      const lastName = String(creator.lastName ?? "").trim();

      return [firstName, lastName].filter(Boolean).join(" ");
    })
    .filter(Boolean);
}

function getTags(item: any): string[] {
  const tags = item.getTags?.() ?? [];

  return tags
    .map((entry: any) => {
      if (typeof entry === "string") {
        return entry.trim();
      }

      return String(entry?.tag ?? "").trim();
    })
    .filter(Boolean)
    .sort((left: string, right: string) => left.localeCompare(right));
}

function getCollectionIDs(item: any): number[] {
  const collectionIDs = item.getCollections?.() ?? [];

  return collectionIDs
    .map((collectionID: unknown) => Number(collectionID))
    .filter(Number.isFinite);
}

function convertItemToPaper(item: any): ZoteroPaper {
  const itemID = Number(item.id);
  const libraryID = Number(item.libraryID);
  const itemKey = String(item.key);
  const metrics = getItemCitationMetrics(libraryID, itemKey);

  return {
    libraryID,
    itemID,
    itemKey,

    title: getTitle(item),
    authors: getAuthors(item),

    year: extractYear(item.getField?.("date")),
    doi: normalizeDOI(item.getField?.("DOI")),

    tags: getTags(item),
    collectionIDs: getCollectionIDs(item),

    dateModified: String(item.dateModified ?? ""),

    citationCount: metrics.citationCount,
    referenceCount: metrics.referenceCount,
    metricsUpdatedAt: metrics.updatedAt,
  };
}

function calculateStatistics(papers: ZoteroPaper[]): LibraryStatistics {
  return {
    totalPapers: papers.length,

    withYear: papers.filter((paper) => paper.year !== null).length,
    withoutYear: papers.filter((paper) => paper.year === null).length,

    withDOI: papers.filter((paper) => paper.doi !== null).length,
    withoutDOI: papers.filter((paper) => paper.doi === null).length,

    withCitationData: papers.filter((paper) => paper.citationCount !== null)
      .length,
    withoutCitationData: papers.filter((paper) => paper.citationCount === null)
      .length,

    withReferenceData: papers.filter((paper) => paper.referenceCount !== null)
      .length,
    withoutReferenceData: papers.filter(
      (paper) => paper.referenceCount === null,
    ).length,
  };
}

interface CollectionInfo {
  collectionID: number;
  name: string;
  parentID: number | null;
}

function getCollectionInfo(collectionID: number): CollectionInfo | null {
  try {
    const collection = Zotero.Collections.get(collectionID);
    if (!collection) {
      return null;
    }

    const parentID = Number(
      Reflect.get(collection as object, "parentID") ??
        Reflect.get(collection as object, "parentCollectionID") ??
        0,
    );

    return {
      collectionID,
      name: String(collection.name ?? `Collection ${collectionID}`),
      parentID: Number.isFinite(parentID) && parentID > 0 ? parentID : null,
    };
  } catch {
    return null;
  }
}

function buildCollectionFilters(
  papers: ZoteroPaper[],
): LibraryCollectionFilter[] {
  const collectionInfo = new Map<number, CollectionInfo>();
  const pending = new Set<number>(
    papers.flatMap((paper) => paper.collectionIDs),
  );

  while (pending.size > 0) {
    const [collectionID] = pending;
    pending.delete(collectionID);

    if (collectionInfo.has(collectionID)) {
      continue;
    }

    const info = getCollectionInfo(collectionID);
    if (!info) {
      continue;
    }

    collectionInfo.set(collectionID, info);
    if (info.parentID && !collectionInfo.has(info.parentID)) {
      pending.add(info.parentID);
    }
  }

  const children = new Map<number, number[]>();
  for (const info of collectionInfo.values()) {
    if (!info.parentID) {
      continue;
    }
    const childIDs = children.get(info.parentID) ?? [];
    childIDs.push(info.collectionID);
    children.set(info.parentID, childIDs);
  }

  const getDescendants = (collectionID: number): number[] => {
    const result: number[] = [collectionID];
    const queue = [...(children.get(collectionID) ?? [])];
    const seen = new Set<number>(result);

    while (queue.length > 0) {
      const childID = queue.shift();
      if (!childID || seen.has(childID)) {
        continue;
      }
      seen.add(childID);
      result.push(childID);
      queue.push(...(children.get(childID) ?? []));
    }

    return result;
  };

  const getPath = (collectionID: number): string => {
    const parts: string[] = [];
    const seen = new Set<number>();
    let currentID: number | null = collectionID;

    while (currentID && !seen.has(currentID)) {
      seen.add(currentID);
      const info = collectionInfo.get(currentID);
      if (!info) {
        break;
      }
      parts.unshift(info.name);
      currentID = info.parentID;
    }

    return parts.join(" / ");
  };

  return [...collectionInfo.values()]
    .map((info) => ({
      collectionID: info.collectionID,
      name: info.name,
      path: getPath(info.collectionID),
      includedCollectionIDs: getDescendants(info.collectionID),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function buildTags(papers: ZoteroPaper[]): string[] {
  return [...new Set(papers.flatMap((paper) => paper.tags))].sort(
    (left, right) => left.localeCompare(right),
  );
}

/** Load every regular bibliographic item in one Zotero library. */
export async function loadWholeLibrary(
  libraryID: number = Zotero.Libraries.userLibraryID,
): Promise<LibrarySnapshot> {
  const items = await Zotero.Items.getAll(libraryID);

  const papers = items
    .filter((item: any) => {
      return item && item.isRegularItem?.() && !item.deleted;
    })
    .map(convertItemToPaper)
    .sort((left: ZoteroPaper, right: ZoteroPaper) =>
      left.title.localeCompare(right.title),
    );

  const libraryName =
    Zotero.Libraries.getName?.(libraryID) || `Library ${libraryID}`;

  return {
    libraryID,
    libraryName,
    generatedAt: new Date().toISOString(),
    papers,
    collections: buildCollectionFilters(papers),
    tags: buildTags(papers),
    statistics: calculateStatistics(papers),
  };
}
